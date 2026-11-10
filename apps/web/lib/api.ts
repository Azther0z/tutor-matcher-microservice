import type { ApiErrorBody } from "./types";

const TOKEN_KEY = "tm.session.token";

/** Browser-only session storage adapter. Tokens are never persisted beyond this tab. */
export const sessionToken = {
  read(): string | null {
    if (typeof window === "undefined") return null;
    return window.sessionStorage.getItem(TOKEN_KEY);
  },
  write(token: string): void {
    window.sessionStorage.setItem(TOKEN_KEY, token);
  },
  clear(): void {
    if (typeof window !== "undefined") window.sessionStorage.removeItem(TOKEN_KEY);
  },
};

export class ApiError extends Error {
  readonly status: number;
  readonly body?: ApiErrorBody;
  readonly retryAfter?: string | null;

  get requestId(): string | undefined {
    return this.body?.requestId;
  }

  constructor(status: number, body?: ApiErrorBody, retryAfter?: string | null) {
    super(body?.message ?? `Request failed (${status}).`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

export type ApiOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: string;
  auth?: boolean;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export async function apiResponse<T>(path: string, options: ApiOptions = {}): Promise<{ data: T; headers: Headers }> {
  const { body, idempotencyKey, ifMatch, auth = true, headers: extraHeaders, ...rest } = options;
  const headers = new Headers(extraHeaders);
  headers.set("Accept", "application/json");
  headers.set("X-Request-Id", crypto.randomUUID());
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  if (ifMatch) headers.set("If-Match", ifMatch);
  if (auth) {
    const token = sessionToken.read();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`/api${path}`, {
    ...rest,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  if (response.status === 204) return { data: undefined as T, headers: response.headers };
  const raw = await response.text();
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : undefined;
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const bodyError = payload && typeof payload === "object" ? (payload as ApiErrorBody) : undefined;
    // Only a rejected session token means the session is over. Other 401s (for example a wrong current password) are ordinary form errors.
    if (response.status === 401 && auth && bodyError?.code === "TOKEN_INVALID") {
      sessionToken.clear();
      if (typeof window !== "undefined") window.dispatchEvent(new Event("tm:session-expired"));
    }
    throw new ApiError(response.status, bodyError, response.headers.get("Retry-After"));
  }
  return { data: payload as T, headers: response.headers };
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  return (await apiResponse<T>(path, options)).data;
}

export function safeReturnPath(candidate: string | null): string {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) return "/account";
  try {
    const parsed = new URL(candidate, window.location.origin);
    if (parsed.origin !== window.location.origin) return "/account";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/account";
  }
}

/** Turns schema-validator wording from the backend into a sentence a person can act on. */
export function friendlyFieldMessage(message: string): string {
  if (/must match format "email"/i.test(message)) return "Enter a valid email address.";
  const longer = /must NOT have more than (\d+) characters/i.exec(message);
  if (longer) return `Use ${longer[1]} characters or fewer.`;
  const shorter = /must NOT have fewer than (\d+) characters/i.exec(message);
  if (shorter) return `Use at least ${shorter[1]} characters.`;
  return message;
}

export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || !error.body?.fields) return {};
  return Object.fromEntries(error.body.fields.map((field) => {
    const path = field.path.replace(/^#?\/?(?:body\/)?/, "").split("/").pop() ?? field.path;
    const name = path.replace(/~1/g, "/").replace(/~0/g, "~");
    return [name, friendlyFieldMessage(field.message)];
  }));
}

export const PASSWORD_MAX_LENGTH = 100;
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function errorMessage(error: unknown, fallback = "Something went wrong. Please try again."): string {
  if (error instanceof ApiError) {
    if (!error.body?.message) {
      // The gateway answers with plain text when a whole service is not reachable.
      if (error.status === 502 || error.status === 503 || error.status === 504) return "This area is temporarily unavailable. Please try again in a moment.";
      return fallback;
    }
    if (error.body.message === "Request validation failed.") return "Check the highlighted fields and try again.";
    return error.body.message;
  }
  return fallback;
}

/** A load or submit failure with what the UI needs: wording, a reference to quote, and what kind of failure it is. */
export type Failure = { message: string; requestId?: string; status?: number; missing: boolean; outage: boolean };
export function failureOf(error: unknown, fallback?: string): Failure {
  const status = error instanceof ApiError ? error.status : undefined;
  return {
    message: errorMessage(error, fallback),
    requestId: error instanceof ApiError ? error.requestId : undefined,
    status,
    // A malformed or unknown id can never succeed on retry.
    missing: status === 400 || status === 404,
    outage: status === undefined || status >= 500,
  };
}
