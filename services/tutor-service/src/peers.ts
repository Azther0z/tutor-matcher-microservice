import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import {
  AppError,
  PROTO_LOADER_OPTIONS,
  normalizeProtoMessage,
  validateGrpcRequest,
  validateGrpcResponse,
  validateRequest,
} from "@tutor-matcher/shared";
import type {
  AccountLookup,
  AvailabilityQuery,
  AvailabilitySummary,
  GrantWork,
  Peers,
  PublicSlot,
  RatingSummary,
} from "./types";
const MAX_MESSAGE = 32 * 1024 * 1024;
const clientOptions = {
  "grpc.max_send_message_length": MAX_MESSAGE,
  "grpc.max_receive_message_length": MAX_MESSAGE,
};
type RpcClient = grpc.Client & Record<string, unknown>;
function client(
  file: string,
  namespace: string,
  service: string,
  url: string,
): RpcClient {
  const root =
    process.env.CONTRACTS_GRPC_DIR ??
    path.resolve(__dirname, "../../../contracts/grpc");
  const definition = loader.loadSync(path.join(root, file), {
    ...PROTO_LOADER_OPTIONS,
    includeDirs: [root],
  });
  let loaded: unknown = grpc.loadPackageDefinition(definition);
  for (const segment of namespace.split("."))
    loaded = (loaded as Record<string, unknown>)[segment];
  const Constructor = (loaded as Record<string, unknown>)[
    service
  ] as grpc.ServiceClientConstructor;
  return new Constructor(
    url,
    grpc.credentials.createInsecure(),
    clientOptions,
  ) as RpcClient;
}
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== "object" || Buffer.isBuffer(value))
    return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith("_"))
      .map(([k, v]) => [k, clean(v)]),
  );
}
function normalizeResponse(operation: string, response: unknown): unknown {
  const decoded = clean(response);
  if (operation === "getRatingSummaries") {
    const data = normalizeProtoMessage(decoded, {
      repeatedFields: ["items"],
      children: { items: { nullableFields: ["average"] } },
    }) as { items: RatingSummary[] };
    for (const item of data.items) {
      item.reviewCount = safeCounter(item.reviewCount);
      item.distribution = Object.fromEntries(
        Object.entries(item.distribution ?? {}).map(([k, v]) => [
          k,
          safeCounter(v),
        ]),
      );
    }
    return data;
  }
  if (operation === "lookupAccounts")
    return normalizeProtoMessage(decoded, {
      repeatedFields: ["items"],
      children: { items: { repeatedFields: ["capabilities"] } },
    });
  if (operation === "getAvailability")
    return normalizeProtoMessage(decoded, {
      repeatedFields: ["slots"],
      children: { slots: { repeatedFields: ["subjectIds"] } },
    });
  if (operation === "batchGetAvailability")
    return normalizeProtoMessage(decoded, { repeatedFields: ["results"] });
  return normalizeProtoMessage(decoded);
}
function safeCounter(value: unknown): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0)
    throw new AppError(
      503,
      "INVALID_DEPENDENCY_RESPONSE",
      "Invalid dependency counter.",
    );
  return count;
}
export class GrpcPeers implements Peers {
  private auth = client(
    "auth/v1/collaboration.proto",
    "tutor_matcher.auth.v1",
    "AuthCollaborationService",
    process.env.AUTH_GRPC_URL ?? "auth-service:50051",
  );
  private booking = client(
    "booking/v1/availability.proto",
    "tutor_matcher.booking.v1",
    "AvailabilityService",
    process.env.BOOKING_GRPC_URL ?? "booking-service:50052",
  );
  private review = client(
    "review/v1/ratings.proto",
    "tutor_matcher.review.v1",
    "ReviewRatingService",
    process.env.REVIEW_GRPC_URL ?? "review-service:50055",
  );
  close() {
    this.auth.close();
    this.booking.close();
    this.review.close();
  }
  private async call<T>(
    target: RpcClient,
    operation: string,
    request: unknown,
  ): Promise<T> {
    validateGrpcRequest(operation, request);
    const credential = process.env.TUTOR_WORKLOAD_CREDENTIAL;
    if (!credential)
      throw new AppError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "Tutor workload identity is unavailable.",
        undefined,
        true,
      );
    const metadata = new grpc.Metadata();
    metadata.set("authorization", `Bearer ${credential}`);
    metadata.set("x-request-id", crypto.randomUUID());
    return new Promise<T>((resolve, reject) => {
      const method = target[operation] as (
        request: unknown,
        metadata: grpc.Metadata,
        options: grpc.CallOptions,
        cb: (error: grpc.ServiceError | null, response: unknown) => void,
      ) => void;
      method.call(
        target,
        request,
        metadata,
        {
          deadline:
            Date.now() + (operation === "grantTutorCapability" ? 3000 : 2000),
        },
        (error, response) => {
          if (error)
            return reject(
              new AppError(
                503,
                "DEPENDENCY_UNAVAILABLE",
                "A required collaborator is unavailable.",
                undefined,
                true,
              ),
            );
          try {
            const value = normalizeResponse(operation, response);
            validateGrpcResponse(operation, value);
            resolve(value as T);
          } catch {
            reject(
              new AppError(
                503,
                "INVALID_DEPENDENCY_RESPONSE",
                "A required collaborator returned invalid data.",
                undefined,
                true,
              ),
            );
          }
        },
      );
    });
  }
  async accounts(userIds: string[]): Promise<AccountLookup[]> {
    return (
      await this.call<{ items: AccountLookup[] }>(this.auth, "lookupAccounts", {
        userIds,
      })
    ).items;
  }
  async grant(work: GrantWork) {
    const request = {
      operationId: work.operationId,
      command: {
        userId: work.userId,
        submissionId: work.submissionId,
        approvalRevision: work.approvalRevision,
        admission: work.admission,
      },
    };
    return this.call<{
      operationId: string;
      userId: string;
      capability: string;
      status: string;
      appliedAt: string;
    }>(this.auth, "grantTutorCapability", request);
  }
  async ratings(subjectIds: string[]): Promise<RatingSummary[]> {
    const items = (
      await this.call<{ items: RatingSummary[] }>(
        this.review,
        "getRatingSummaries",
        { subjectIds },
      )
    ).items;
    return items.map((item) => ({
      ...item,
      reviewCount: Number(item.reviewCount),
      distribution: Object.fromEntries(
        Object.entries(item.distribution).map(([k, v]) => [k, Number(v)]),
      ),
    }));
  }
  async batchAvailability(
    queries: AvailabilityQuery[],
  ): Promise<AvailabilitySummary[]> {
    return (
      await this.call<{ results: AvailabilitySummary[] }>(
        this.booking,
        "batchGetAvailability",
        { queries },
      )
    ).results;
  }
  async availability(query: AvailabilityQuery): Promise<PublicSlot[]> {
    return (
      await this.call<{ slots: PublicSlot[] }>(
        this.booking,
        "getAvailability",
        { query },
      )
    ).slots;
  }
  async publicReviews(query: {
    tutorId: string;
    subjectId?: string;
  }): Promise<unknown[]> {
    try {
      const url = new URL(
        "/reviews",
        process.env.REVIEW_HTTP_URL ?? "http://review-service:4005",
      );
      url.searchParams.set("tutorId", query.tutorId);
      if (query.subjectId) url.searchParams.set("subjectId", query.subjectId);
      url.searchParams.set("pageSize", "10");
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error("Reviews unavailable");
      const body = await response.json();
      validateRequest("ReviewPage", body);
      return (body as { items: unknown[] }).items;
    } catch {
      throw new AppError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "Public reviews are unavailable.",
        undefined,
        true,
      );
    }
  }
}
