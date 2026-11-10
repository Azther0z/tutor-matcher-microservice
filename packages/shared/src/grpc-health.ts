import { Field, Type } from "protobufjs";

type HealthMethodDefinition = {
  path: string;
  requestStream: false;
  responseStream: false;
  requestSerialize(value: unknown): Buffer;
  requestDeserialize(value: Buffer): Record<string, unknown>;
  responseSerialize(value: unknown): Buffer;
  responseDeserialize(value: Buffer): Record<string, unknown>;
};

type HealthServiceDefinition = { check: HealthMethodDefinition };
type HealthServiceImplementation = {
  check(call: { request: Record<string, unknown> }, callback: (error: { code: number; details: string } | null, response?: { status: number }) => void): void;
};

/** Minimal standard grpc.health.v1 Health/Check implementation for grpc-js servers. */
export interface GrpcHealthServer {
  addService(service: HealthServiceDefinition, implementation: HealthServiceImplementation): unknown;
}

export interface GrpcHealthController {
  /** Enables serving status after the server is bound and startup dependencies are ready. */
  setServing(ready: boolean): void;
  /** Publishes NOT_SERVING before the server begins draining. */
  shutdown(): void;
}

const checkRequest = new Type("HealthCheckRequest").add(
  new Field("service", 1, "string", "optional"),
);
const checkResponse = new Type("HealthCheckResponse").add(
  new Field("status", 1, "int32", "optional"),
);

function serialize(type: Type, value: unknown): Buffer {
  return Buffer.from(type.encode(type.fromObject(value as Record<string, unknown>)).finish());
}

function deserialize(type: Type, value: Buffer): Record<string, unknown> {
  return type.toObject(type.decode(value), { defaults: false }) as Record<string, unknown>;
}

/**
 * Adds the standard unary grpc.health.v1.Health/Check method. It reports the
 * empty service name and each supplied service name, without exposing dependency
 * details. A failed readiness check is always NOT_SERVING.
 */
export function createGrpcHealth(
  server: GrpcHealthServer,
  serviceNames: readonly string[],
  isReady: () => boolean | Promise<boolean>,
): GrpcHealthController {
  const names = new Set(["", ...serviceNames]);
  let serving = false;

  server.addService(
    {
      check: {
        path: "/grpc.health.v1.Health/Check",
        requestStream: false,
        responseStream: false,
        requestSerialize: (value: unknown) => serialize(checkRequest, value),
        requestDeserialize: (value: Buffer) => deserialize(checkRequest, value),
        responseSerialize: (value: unknown) => serialize(checkResponse, value),
        responseDeserialize: (value: Buffer) => deserialize(checkResponse, value),
      },
    },
    {
        check: (call: { request: Record<string, unknown> }, callback: (error: { code: number; details: string } | null, response?: { status: number }) => void) => {
        void (async () => {
          const service = typeof call.request.service === "string" ? call.request.service : "";
          if (!names.has(service)) {
            callback({ code: 5, details: "Service not found" });
            return;
          }
          let ready = false;
          if (serving) {
            try {
              ready = (await isReady()) && serving;
            } catch {
              ready = false;
            }
          }
          callback(null, { status: ready ? 1 : 2 }); // SERVING / NOT_SERVING
        })();
      },
    },
  );

  return {
    setServing(ready) { serving = ready; },
    shutdown() { serving = false; },
  };
}
