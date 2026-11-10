import { Type, Field } from "protobufjs";
import { AppError } from "./errors.js";

export interface ErrorField {
  path: string;
  code: string;
  message: string;
}

export interface ErrorDetail {
  code: string;
  message: string;
  requestId: string;
  retryable: boolean;
  fields: ErrorField[];
  operationId?: string;
}

export interface ProtoNormalizationRules {
  nullableFields?: readonly string[];
  repeatedFields?: readonly string[];
  enumFields?: Readonly<Record<string, readonly string[]>>;
  children?: Readonly<Record<string, ProtoNormalizationRules>>;
}

export const PROTO_LOADER_OPTIONS = Object.freeze({
  keepCase: false,
  defaults: false,
  enums: String,
  longs: String,
  oneofs: true,
});

const errorFieldsType = new Type("ErrorFields")
  .add(new Field("path", 1, "string", "optional"))
  .add(new Field("code", 2, "string", "optional"))
  .add(new Field("message", 3, "string", "optional"));
const errorDetailType = new Type("ErrorDetail")
  .add(new Field("code", 1, "string", "optional"))
  .add(new Field("message", 2, "string", "optional"))
  .add(new Field("request_id", 3, "string", "optional"))
  .add(new Field("retryable", 4, "bool", "optional"))
  .add(new Field("fields", 5, "ErrorFields", "repeated"))
  .add(new Field("operation_id", 6, "string", "optional"));
errorDetailType.add(errorFieldsType);

export function makeErrorDetail(input: ErrorDetail): ErrorDetail {
  return {
    code: input.code,
    message: input.message,
    requestId: input.requestId,
    retryable: input.retryable,
    fields: input.fields.map((field) => ({ ...field })),
    ...(input.operationId ? { operationId: input.operationId } : {}),
  };
}

export function encodeErrorDetail(input: ErrorDetail): Buffer {
  const value = {
    code: input.code,
    message: input.message,
    request_id: input.requestId,
    retryable: input.retryable,
    fields: input.fields,
    ...(input.operationId ? { operation_id: input.operationId } : {}),
  };
  return Buffer.from(errorDetailType.encode(errorDetailType.fromObject(value)).finish());
}

export function normalizeProtoMessage(value: unknown, rules: ProtoNormalizationRules = {}): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeProtoMessage(item, rules));
  if (value === null || typeof value !== "object" || Buffer.isBuffer(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const camelKey = key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    const allowedEnums = rules.enumFields?.[camelKey];
    if (allowedEnums && (typeof child !== "string" || child.endsWith("_UNSPECIFIED") || !allowedEnums.includes(child))) {
      throw new AppError(422, "VALIDATION_FAILED", `Invalid protobuf enum field: ${camelKey}`);
    }
    normalized[camelKey] = normalizeProtoMessage(child, rules.children?.[camelKey] ?? {});
  }
  for (const field of rules.repeatedFields ?? []) {
    if (!(field in normalized)) normalized[field] = [];
  }
  for (const field of rules.nullableFields ?? []) {
    if (!(field in normalized)) normalized[field] = null;
  }
  return normalized;
}

export function mapGrpcError(error: unknown, _requestId: string): AppError {
  const grpcError = error as { code?: number; details?: string; metadata?: { get?: (key: string) => unknown[] } };
  const binary = grpcError.metadata?.get?.("tutor-error-bin")?.[0];
  if (Buffer.isBuffer(binary)) {
    try {
      const detail = errorDetailType.toObject(errorDetailType.decode(binary), { defaults: false }) as Record<string, unknown>;
      const code = String(detail.code ?? "DEPENDENCY_ERROR");
      const status = code === "REVISION_MISMATCH" ? 412 : grpcStatusToHttp(grpcError.code);
      const nestedFields = Array.isArray(detail.fields) ? detail.fields as Array<Record<string, unknown>> : [];
      const fields = Object.fromEntries(nestedFields.flatMap((field) => {
        const path = String(field.path ?? "");
        return path ? [[path, String(field.message ?? "Invalid value")]] : [];
      }));
      return new AppError(status, code, String(detail.message ?? "Request failed."), fields, detail.retryable === true);
    } catch { /* Fallback to the transport status when trailer is malformed. */ }
  }
  return new AppError(
    grpcStatusToHttp(grpcError.code),
    grpcStatusCode(grpcError.code),
    sanitizeGrpcMessage(grpcError.details),
    undefined,
    grpcError.code === 10 || grpcError.code === 14 || grpcError.code === 4,
  );
}

export function grpcErrorTrailer(detail: ErrorDetail): { "tutor-error-bin": Buffer } {
  return { "tutor-error-bin": encodeErrorDetail(detail) };
}

function grpcStatusToHttp(code: number | undefined): number {
  switch (code) {
    case 3: return 422;
    case 16: return 401;
    case 7: return 403;
    case 5: return 404;
    case 6: return 409;
    case 9: return 409;
    case 8: return 429;
    case 10: return 503;
    case 14: return 503;
    case 4: case 1: return 503;
    default: return 502;
  }
}

function grpcStatusCode(code: number | undefined): string {
  const names: Record<number, string> = {
    1: "CANCELLED", 3: "INVALID_ARGUMENT", 4: "DEADLINE_EXCEEDED", 5: "NOT_FOUND",
    6: "ALREADY_EXISTS", 7: "PERMISSION_DENIED", 8: "RESOURCE_EXHAUSTED", 9: "FAILED_PRECONDITION",
    10: "ABORTED", 14: "UNAVAILABLE", 16: "UNAUTHENTICATED",
  };
  return code === undefined ? "DEPENDENCY_ERROR" : names[code] ?? "DEPENDENCY_ERROR";
}

function sanitizeGrpcMessage(_message: string | undefined): string {
  return "A dependency request failed.";
}
