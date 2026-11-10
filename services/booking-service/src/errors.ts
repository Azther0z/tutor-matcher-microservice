import { status as grpcStatus } from '@grpc/grpc-js';

export interface FieldError {
  path: string;
  code: string;
  message: string;
}

export interface AppErrorInit {
  code: string;
  http: number;
  grpc: number;
  message: string;
  retryable?: boolean;
  fields?: FieldError[];
  operationId?: string;
  /** A known business rejection that an idempotent replay must reproduce unchanged. */
  durable?: boolean;
}

/** One error type for REST and gRPC: stable machine code plus both transport mappings. */
export class AppError extends Error {
  readonly code: string;
  readonly http: number;
  readonly grpc: number;
  readonly retryable: boolean;
  readonly fields: FieldError[];
  readonly operationId?: string;
  readonly durable: boolean;

  constructor(init: AppErrorInit) {
    super(init.message);
    this.code = init.code;
    this.http = init.http;
    this.grpc = init.grpc;
    this.retryable = init.retryable ?? false;
    this.fields = init.fields ?? [];
    this.operationId = init.operationId;
    this.durable = init.durable ?? false;
  }
}

const make = (http: number, grpc: number, durable = false) =>
  (code: string, message: string, extra: Partial<AppErrorInit> = {}) =>
    new AppError({ code, http, grpc, message, durable, ...extra });

export const validation = (fields: FieldError[], message = 'Request validation failed') =>
  new AppError({ code: 'VALIDATION_FAILED', http: 422, grpc: grpcStatus.INVALID_ARGUMENT, message, fields });
export const malformed = make(400, grpcStatus.INVALID_ARGUMENT);
export const unauthenticated = make(401, grpcStatus.UNAUTHENTICATED);
export const forbidden = make(403, grpcStatus.PERMISSION_DENIED);
export const notFound = make(404, grpcStatus.NOT_FOUND);
export const conflict = make(409, grpcStatus.FAILED_PRECONDITION, true);
export const alreadyExists = make(409, grpcStatus.ALREADY_EXISTS, true);
export const insufficientFunds = make(402, grpcStatus.FAILED_PRECONDITION, true);
/** A known business-rule rejection of otherwise well-formed input (for example SELF_BOOKING). */
export const unprocessable = make(422, grpcStatus.INVALID_ARGUMENT, true);
export const revisionMismatch = make(412, grpcStatus.FAILED_PRECONDITION);
export const preconditionRequired = make(428, grpcStatus.FAILED_PRECONDITION);
export const unavailable = (code: string, message: string) =>
  new AppError({ code, http: 503, grpc: grpcStatus.UNAVAILABLE, message, retryable: true });
export const internal = (message = 'Internal server error') =>
  new AppError({ code: 'INTERNAL', http: 500, grpc: grpcStatus.INTERNAL, message });

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const pg = error as { code?: string; constraint?: string } | undefined;
  // 40001 serialization failure and 40P01 deadlock: nothing committed, safe to repeat the same operation.
  if (pg?.code === '40001' || pg?.code === '40P01') {
    return new AppError({ code: 'CONTENTION', http: 503, grpc: grpcStatus.ABORTED, message: 'Retry the same operation', retryable: true });
  }
  return internal();
}
