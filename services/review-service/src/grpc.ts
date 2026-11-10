import * as grpc from "@grpc/grpc-js";
import { randomUUID } from "node:crypto";
import {
  AppError,
  encodeErrorDetail,
  normalizeProtoMessage,
  validateGrpcRequest,
  validateGrpcResponse,
  verifyWorkload,
} from "@tutor-matcher/shared";
import { loadProto, grpcOptions, stripPresence } from "./peers";
import type { ReviewService } from "./service";
export function createRatingServer(
  service: ReviewService,
  tutorCredential: string,
) {
  const definition = loadProto("review/v1/ratings.proto");
  const server = new grpc.Server(grpcOptions);
  server.addService(
    definition.tutor_matcher.review.v1.ReviewRatingService.service,
    {
      getRatingSummaries: (
        call: grpc.ServerUnaryCall<{ subjectIds?: string[] }, unknown>,
        callback: grpc.sendUnaryData<unknown>,
      ) => {
        void (async () => {
          const rawId = call.metadata.get("x-request-id")[0];
          const requestId = typeof rawId === "string" ? rawId : randomUUID();
          try {
            validateRequestId(rawId);
            const auth = call.metadata.get("authorization")[0];
            verifyWorkload(
              typeof auth === "string" ? auth : undefined,
              tutorCredential,
              "tutor",
              "getRatingSummaries",
              { tutor: ["getRatingSummaries"] },
            );
            const request = normalizeProtoMessage(stripPresence(call.request), {
              repeatedFields: ["subjectIds"],
            }) as { subjectIds: string[] };
            validateGrpcRequest("getRatingSummaries", request);
            const response = await service.ratings(request.subjectIds);
            validateGrpcResponse("getRatingSummaries", response);
            const headers = new grpc.Metadata();
            headers.set("x-request-id", requestId);
            call.sendMetadata(headers);
            callback(null, response);
          } catch (error) {
            const app =
              error instanceof AppError
                ? error
                : new AppError(
                    503,
                    "DEPENDENCY_UNAVAILABLE",
                    "Review storage is unavailable.",
                    undefined,
                    true,
                  );
            const codes: Record<number, grpc.status> = {
              400: grpc.status.INVALID_ARGUMENT,
              422: grpc.status.INVALID_ARGUMENT,
              401: grpc.status.UNAUTHENTICATED,
              403: grpc.status.PERMISSION_DENIED,
              503: grpc.status.UNAVAILABLE,
            };
            const trailer = new grpc.Metadata();
            trailer.set(
              "tutor-error-bin",
              encodeErrorDetail({
                code: app.code,
                message: app.message,
                requestId,
                retryable: app.retryable,
                fields: Object.entries(app.fields ?? {}).map(
                  ([path, message]) => ({
                    path,
                    code: "INVALID_FIELD",
                    message,
                  }),
                ),
              }),
            );
            callback({
              code: codes[app.status] ?? grpc.status.INTERNAL,
              details: app.message,
              metadata: trailer,
            });
          }
        })();
      },
    },
  );
  return server;
}
function validateRequestId(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    throw new AppError(
      422,
      "VALIDATION_FAILED",
      "A UUID x-request-id is required.",
    );
}
export async function listenRatingServer(
  server: grpc.Server,
  address = `0.0.0.0:${process.env.GRPC_PORT ?? 50055}`,
) {
  return await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      address,
      grpc.ServerCredentials.createInsecure(),
      (error, port) => (error ? reject(error) : resolve(port)),
    ),
  );
}
