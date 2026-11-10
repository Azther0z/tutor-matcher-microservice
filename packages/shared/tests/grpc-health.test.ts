import assert from "node:assert/strict";
import * as grpc from "@grpc/grpc-js";
import test from "node:test";
import { createGrpcHealth } from "../src/grpc-health.js";

test("gRPC health Check starts NOT_SERVING, reflects readiness, and goes NOT_SERVING on shutdown", async () => {
  let definition: any;
  let implementation: any;
  const server = { addService(service: any, handlers: any) { definition = service; implementation = handlers; } };
  let ready = true;
  const health = createGrpcHealth(server, ["example.v1.ExampleService"], async () => ready);
  const check = (service: string) => new Promise<{ error?: { code: number }; status?: number }>((resolve) => {
    implementation.check({ request: { service } }, (error: { code: number } | null, response: { status: number }) => resolve(error ? { error } : response));
  });

  assert.equal(definition.check.path, "/grpc.health.v1.Health/Check");
  assert.deepEqual(definition.check.responseDeserialize(definition.check.responseSerialize({ status: 1 })), { status: 1 });
  assert.deepEqual(await check(""), { status: 2 });
  health.setServing(true);
  assert.deepEqual(await check(""), { status: 1 });
  assert.deepEqual(await check("example.v1.ExampleService"), { status: 1 });
  ready = false;
  assert.deepEqual(await check(""), { status: 2 });
  ready = true;
  health.shutdown();
  assert.deepEqual(await check(""), { status: 2 });
  assert.equal((await check("unknown.v1.Service")).error?.code, 5);
});

test("gRPC health Check contains readiness failures", async () => {
  let implementation: any;
  createGrpcHealth({ addService(_service: any, handlers: any) { implementation = handlers; } }, [], async () => { throw new Error("private diagnostic"); }).setServing(true);
  const result = await new Promise<{ error?: unknown; status?: number }>((resolve) => {
    implementation.check({ request: { service: "" } }, (error: unknown, response: { status: number }) => resolve(error ? { error } : response));
  });
  assert.deepEqual(result, { status: 2 });
});

test("shutdown wins over an in-flight successful readiness check", async () => {
  let implementation: any;
  let resolveReady!: (value: boolean) => void;
  const health = createGrpcHealth(
    { addService(_service: any, handlers: any) { implementation = handlers; } },
    [],
    () => new Promise<boolean>((resolve) => { resolveReady = resolve; }),
  );
  health.setServing(true);
  const result = new Promise<{ status: number }>((resolve) => {
    implementation.check({ request: { service: "" } }, (_error: unknown, response: { status: number }) => resolve(response));
  });
  await Promise.resolve();
  health.shutdown();
  resolveReady(true);
  assert.deepEqual(await result, { status: 2 });
});

test("grpc-js clients can call the standard Health/Check wire path", async () => {
  let ready = false;
  const server = new grpc.Server();
  const health = createGrpcHealth(server, ["example.v1.ExampleService"], () => ready);
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, bound) => error ? reject(error) : resolve(bound));
  });
  const client = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  // The service descriptor is encoded independently from the request so this asserts
  // that grpc-js registers and serves the canonical method path.
  const response = await new Promise<{ status: number }>((resolve, reject) => {
    client.makeUnaryRequest(
      "/grpc.health.v1.Health/Check",
      (value: unknown) => Buffer.from([0x0a, 0x00]),
      (value: Buffer) => ({ status: value[1] }),
      { service: "" },
      (error: Error | null, value: { status: number }) => error ? reject(error) : resolve(value),
    );
  });
  assert.deepEqual(response, { status: 2 });
  ready = true;
  health.setServing(true);
  client.close();
  await new Promise<void>((resolve) => server.tryShutdown(resolve));
});
