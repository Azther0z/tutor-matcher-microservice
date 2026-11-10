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
    if (response.status === 401 && auth) {
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

export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || !error.body?.fields) return {};
  return Object.fromEntries(error.body.fields.map((field) => {
    const path = field.path.replace(/^#?\/?(?:body\/)?/, "").split("/").pop() ?? field.path;
    const name = path.replace(/~1/g, "/").replace(/~0/g, "~");
    return [name, field.message];
  }));
}

export function errorMessage(error: unknown, fallback = "Something went wrong. Please try again."): string {
  if (error instanceof ApiError) return error.body?.message ?? fallback;
  return fallback;
}
