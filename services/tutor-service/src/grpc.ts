import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import { randomUUID } from "node:crypto";
import {
  AppError,
  PROTO_LOADER_OPTIONS,
  encodeErrorDetail,
  normalizeProtoMessage,
  validateGrpcRequest,
  validateGrpcResponse,
  validateRequest,
  verifyWorkload,
} from "@tutor-matcher/shared";
import type { TutorService } from "./service";
const allowed: Record<string, string[]> = {
  getTutorEligibility: ["auth", "booking", "wallet", "messaging"],
  getBookableSubject: ["booking"],
};
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !k.startsWith("_"))
      .map(([k, v]) => [k, clean(v)]),
  );
}
export function createTutorGrpcServer(service: TutorService): grpc.Server {
  const root =
    process.env.CONTRACTS_GRPC_DIR ??
    path.resolve(__dirname, "../../../contracts/grpc");
  const definition = loader.loadSync(
    path.join(root, "tutor/v1/catalogue.proto"),
    { ...PROTO_LOADER_OPTIONS, includeDirs: [root] },
  );
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    tutor_matcher: {
      tutor: { v1: { TutorCatalogueService: grpc.ServiceClientConstructor } };
    };
  };
  const server = new grpc.Server({
    "grpc.max_send_message_length": 32 * 1024 * 1024,
    "grpc.max_receive_message_length": 32 * 1024 * 1024,
  });
  const guard =
    (
      operation: string,
      work: (input: Record<string, string>) => Promise<unknown>,
    ) =>
    (
      call: grpc.ServerUnaryCall<Record<string, string>, unknown>,
      callback: grpc.sendUnaryData<unknown>,
    ) => {
      void (async () => {
        let requestId: string = randomUUID();
        try {
          const trace = call.metadata.get("x-request-id")[0];
          validateRequest("Id", trace);
          requestId = String(trace);
          const bearer = call.metadata.get("authorization")[0];
          let caller: string | undefined;
          for (const name of [
            "auth",
            "booking",
            "wallet",
            "messaging",
            "review",
            "notification",
          ]) {
            const token =
              process.env[`${name.toUpperCase()}_WORKLOAD_CREDENTIAL`];
            if (!token) continue;
            try {
              verifyWorkload(
                typeof bearer === "string" ? bearer : undefined,
                token,
                name,
                operation,
                { [name]: [operation] },
              );
              caller = name;
              break;
            } catch {
              continue;
            }
          }
          if (!caller)
            throw new AppError(
              401,
              "INVALID_WORKLOAD",
              "Workload authentication failed.",
            );
          if (!allowed[operation].includes(caller))
            throw new AppError(403, "FORBIDDEN", "This caller is not allowed.");
          const input = normalizeProtoMessage(clean(call.request)) as Record<
            string,
            string
          >;
          validateGrpcRequest(operation, input);
          const result = await work(input);
          validateGrpcResponse(operation, result);
          const headers = new grpc.Metadata();
          headers.set("x-request-id", requestId);
          call.sendMetadata(headers);
          callback(null, result);
        } catch (error) {
          const failure =
            error instanceof AppError
              ? error
              : new AppError(
                  503,
                  "DEPENDENCY_UNAVAILABLE",
                  "Tutor is unavailable.",
                  undefined,
                  true,
                );
          const metadata = new grpc.Metadata();
          metadata.set(
            "tutor-error-bin",
            encodeErrorDetail({
              code: failure.code,
              message: failure.message,
              requestId,
              retryable: failure.retryable,
              fields: Object.entries(failure.fields ?? {}).map(
                ([path, message]) => ({ path, code: "INVALID_FIELD", message }),
              ),
            }),
          );
          const status: Record<number, number> = {
            401: grpc.status.UNAUTHENTICATED,
            403: grpc.status.PERMISSION_DENIED,
            404: grpc.status.NOT_FOUND,
            409: grpc.status.FAILED_PRECONDITION,
            422: grpc.status.INVALID_ARGUMENT,
            503: grpc.status.UNAVAILABLE,
          };
          callback({
            code: status[failure.status] ?? grpc.status.INTERNAL,
            details: failure.message,
            metadata,
          });
        }
      })();
    };
  server.addService(
    loaded.tutor_matcher.tutor.v1.TutorCatalogueService.service,
    {
      getTutorEligibility: guard("getTutorEligibility", (input) =>
        service.eligibility(input.userId),
      ),
      getBookableSubject: guard("getBookableSubject", (input) =>
        service.bookable(input.subjectId),
      ),
    },
  );
  return server;
}
