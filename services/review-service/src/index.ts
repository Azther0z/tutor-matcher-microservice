import { loadRuntimeEnv } from "./runtime";
import "dotenv/config";
import { connectStore } from "./store";
import { makePeerClients } from "./peers";
import { ReviewService } from "./service";
import { createReviewApp } from "./routes";
import { createRatingServer, listenRatingServer } from "./grpc";
import { RabbitPublisher, startPublisher } from "./events";
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value.replace(/\\n/g, "\n");
}
async function main() {
  loadRuntimeEnv();
  const store = await connectStore(required("MONGO_URI"));
  const peers = makePeerClients({
    authUrl: process.env.AUTH_GRPC_URL ?? "auth-service:50051",
    bookingUrl: process.env.BOOKING_GRPC_URL ?? "booking-service:50052",
    credential: required("REVIEW_WORKLOAD_CREDENTIAL"),
  });
  const publisher = new RabbitPublisher(required("RABBITMQ_URL"));
  if (!(await publisher.ready()))
    throw new Error("Notification topology is not ready.");
  const service = new ReviewService(store, peers);
  const grpc = createRatingServer(
    service,
    required("TUTOR_WORKLOAD_CREDENTIAL"),
    async () => (await store.ready()) && (await publisher.ready()),
  );
  await listenRatingServer(grpc);
  grpc.health.setServing(true);
  const app = createReviewApp(service, {
    gatewayCredential: required("GATEWAY_WORKLOAD_CREDENTIAL"),
    actorPublicKey: required("ACTOR_ASSERTION_PUBLIC_KEY"),
  });
  const http = app.listen(Number(process.env.PORT ?? 4005), "0.0.0.0");
  const stop = startPublisher(store, publisher);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    grpc.health.shutdown();
    http.close();
    grpc.forceShutdown();
    peers.close?.();
    await stop();
    await store.client.close();
  };
  process.once("SIGTERM", () => {
    void close();
  });
  process.once("SIGINT", () => {
    void close();
  });
}
void main().catch(() => {
  process.stderr.write(
    "Review service failed to start. Check runtime configuration and owned dependencies.\n",
  );
  process.exitCode = 1;
});
