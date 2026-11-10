import "dotenv/config";
import { ServerCredentials } from "@grpc/grpc-js";
import { connectStore } from "./store";
import { TutorService } from "./service";
import { GrpcPeers } from "./peers";
import { createTutorApp } from "./http";
import { createTutorGrpcServer } from "./grpc";
import { RabbitPublisher, startWorkers } from "./outbox";
async function main() {
  const runtimeEnvPath = "../../shared/runtime-env";
  const runtimeEnv = await import(runtimeEnvPath);
  runtimeEnv.loadRuntimeEnv();
  for (const name of [
    "MONGO_URI",
    "GATEWAY_WORKLOAD_CREDENTIAL",
    "TUTOR_WORKLOAD_CREDENTIAL",
    "ACTOR_ASSERTION_PUBLIC_KEY",
  ])
    if (!process.env[name])
      throw new Error(`Missing runtime configuration: ${name}`);
  const store = await connectStore(process.env.MONGO_URI!);
  const peers = new GrpcPeers();
  const service = new TutorService(store, peers);
  const publisher = new RabbitPublisher();
  const grpc = createTutorGrpcServer(service);
  await new Promise<void>((resolve, reject) =>
    grpc.bindAsync(
      `0.0.0.0:${process.env.GRPC_PORT ?? 50053}`,
      ServerCredentials.createInsecure(),
      (error) => (error ? reject(error) : resolve()),
    ),
  );
  const app = createTutorApp(service, async () => {
    await store.db.command({ ping: 1 });
    return true;
  });
  const http = app.listen(Number(process.env.PORT ?? 4001));
  const stop = startWorkers(service, store, publisher);
  const close = () => {
    stop();
    http.close();
    grpc.forceShutdown();
    peers.close();
    void publisher.close();
    void store.client.close();
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  console.log("Tutor service is ready.");
}
main().catch(() => {
  console.error(
    "Tutor startup failed. Check runtime configuration and owned storage.",
  );
  process.exitCode = 1;
});
