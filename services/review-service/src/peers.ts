import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import {
  AppError,
  mapGrpcError,
  normalizeProtoMessage,
  PROTO_LOADER_OPTIONS,
  validateGrpcRequest,
  validateGrpcResponse,
} from "@tutor-matcher/shared";
import { randomUUID } from "node:crypto";
import type { PeerClients, Account, ReviewEligibility } from "./types";

export const grpcOptions = {
  "grpc.max_send_message_length": 32 * 1024 * 1024,
  "grpc.max_receive_message_length": 32 * 1024 * 1024,
};
const root = path.resolve(__dirname, "../../../contracts/grpc");
export function loadProto(file: string): any {
  return grpc.loadPackageDefinition(
    loader.loadSync(path.join(root, file), {
      ...PROTO_LOADER_OPTIONS,
      includeDirs: [root],
    }),
  );
}
export function stripPresence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPresence);
  if (!value || typeof value !== "object" || Buffer.isBuffer(value))
    return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith("_"))
      .map(([key, item]) => [key, stripPresence(item)]),
  );
}
export function makePeerClients(config: {
  authUrl: string;
  bookingUrl: string;
  credential: string;
}): PeerClients {
  const authDefinition = loadProto("auth/v1/collaboration.proto");
  const bookingDefinition = loadProto("booking/v1/collaboration.proto");
  const auth =
    new authDefinition.tutor_matcher.auth.v1.AuthCollaborationService(
      config.authUrl,
      grpc.credentials.createInsecure(),
      grpcOptions,
    );
  const booking =
    new bookingDefinition.tutor_matcher.booking.v1.BookingEvidenceService(
      config.bookingUrl,
      grpc.credentials.createInsecure(),
      grpcOptions,
    );
  async function call<T>(
    client: any,
    method: string,
    operationId: string,
    request: Record<string, unknown>,
    assertion?: string,
  ): Promise<T> {
    validateGrpcRequest(operationId, request);
    const metadata = new grpc.Metadata(),
      requestId = randomUUID();
    metadata.set("authorization", `Bearer ${config.credential}`);
    metadata.set("x-request-id", requestId);
    if (assertion) metadata.set("x-actor-context", assertion);
    return new Promise((resolve, reject) => {
      client[method](
        request,
        metadata,
        { deadline: new Date(Date.now() + 2000) },
        (error: grpc.ServiceError | null, response: unknown) => {
          if (error) {
            reject(mapGrpcError(error, requestId));
            return;
          }
          try {
            const result = normalizeProtoMessage(
              stripPresence(response),
              operationId === "getReviewEligibility"
                ? { nullableFields: ["completedAt"] }
                : { repeatedFields: ["items"] },
            );
            validateGrpcResponse(operationId, result);
            resolve(result as T);
          } catch {
            reject(
              new AppError(
                503,
                "DEPENDENCY_UNAVAILABLE",
                "A collaborator returned an invalid response.",
                undefined,
                true,
              ),
            );
          }
        },
      );
    });
  }
  return {
    reviewEligibility: (bookingId, assertion) =>
      call<ReviewEligibility>(
        booking,
        "getReviewEligibility",
        "getReviewEligibility",
        { bookingId },
        assertion,
      ),
    accounts: async (userIds) =>
      (
        await call<{ items: Account[] }>(
          auth,
          "lookupAccounts",
          "lookupAccounts",
          { userIds },
        )
      ).items,
    close: () => {
      auth.close();
      booking.close();
    },
  };
}
