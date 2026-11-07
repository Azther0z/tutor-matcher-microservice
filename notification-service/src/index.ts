import { ActorVerifier, WorkloadAuthenticator } from './auth';
import { EventConsumer } from './broker';
import { assertRunnable, loadConfig } from './config';
import { registerWithConsul } from './consul';
import { Contracts } from './contracts';
import { AudienceResolver } from './domain/audience';
import { Dispatcher, SimulatedProvider } from './domain/dispatcher';
import { EventAcceptor } from './domain/events';
import { GrpcAuthPeer, GrpcBookingPeer } from './grpc/clients';
import { createApp } from './http/app';
import { openStore } from './store';
import { systemClock } from './time';

async function main(): Promise<void> {
  const config = loadConfig();
  assertRunnable(config);

  const store = await openStore(config.mongoUri, config.mongoDb);
  console.log(`[Notification] MongoDB connected: ${store.db.databaseName}`);

  const contracts = new Contracts(config.contractsDir);
  const peers = {
    auth: new GrpcAuthPeer(config.contractsDir, config.authGrpcUrl, config.outboundCredential),
    booking: new GrpcBookingPeer(config.contractsDir, config.bookingGrpcUrl, config.outboundCredential),
  };
  const acceptor = new EventAcceptor(store, contracts, systemClock, config.publisherIdentities);
  const consumer = new EventConsumer(config.rabbitmqUrl, acceptor);
  const dispatcher = new Dispatcher(store, systemClock, peers, new SimulatedProvider());
  const audience = new AudienceResolver(store, systemClock, peers);

  // Ready only once the database answers and the versioned topology is installed and consuming.
  const app = createApp({
    store, clock: systemClock, contracts, workload: new WorkloadAuthenticator(config.workloadCredentials),
    actors: new ActorVerifier(config.gatewayPublicKey!),
    ready: async () => { await store.db.command({ ping: 1 }); return consumer.isReady(); },
  });
  const http = app.listen(config.port, () => console.log(`[Notification] REST listening on :${config.port}`));

  void consumer.start();
  dispatcher.start(1000);
  audience.start(1000);
  const deregister = await registerWithConsul({ consulUrl: config.consulUrl, name: 'notification-service', httpPort: config.port });

  const shutdown = async () => {
    console.log('[Notification] shutting down');
    dispatcher.stop();
    audience.stop();
    await deregister?.();
    await consumer.stop();
    http.close();
    await store.client.close();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('[Notification] startup failed', error);
  process.exit(1);
});
