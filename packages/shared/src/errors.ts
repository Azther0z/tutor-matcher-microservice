export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  readonly retryable: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    fields?: Record<string, string>,
    retryable = false,
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.retryable = retryable;
  }
}

export interface HttpErrorResponse {
  status: number;
  body: {
    code: string;
    message: string;
    requestId: string;
    retryable: boolean;
    fields: Array<{ path: string; code: string; message: string }>;
  };
}

export function toHttpError(error: unknown, requestId: string): HttpErrorResponse {
  const poolTimeout = error instanceof Error && /connection timeout|timeout exceeded when trying to connect/i.test(error.message);
  const appError = error instanceof AppError
    ? error
    : poolTimeout
      ? new AppError(503, "DEPENDENCY_UNAVAILABLE", "The service is busy. Try again shortly.", undefined, true)
      : new AppError(500, "INTERNAL_ERROR", "An unexpected error occurred.");
  const fields = appError.fields
    ? Object.entries(appError.fields).map(([path, message]) => ({
      path,
      code: "INVALID_FIELD",
      message,
    }))
    : undefined;
  return {
    status: appError.status,
    body: {
      code: appError.code,
      message: appError.message,
      requestId,
      retryable: appError.retryable,
      fields: fields ?? [],
    },
  };
}
