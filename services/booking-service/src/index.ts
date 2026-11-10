import { ActorVerifier, WorkloadAuthenticator } from './auth';
import { assertRunnable, loadConfig } from './config';
import { Contracts } from './contracts';
import { createPool, migrate } from './db';
import type { Ctx } from './domain/context';
import { BackgroundWorkers } from './domain/workers';
import { GrpcAuthClient, GrpcTutorClient, GrpcWalletClient } from './grpc/clients';
import { startGrpcServer } from './grpc/server';
import { createApp } from './http/app';
import { IdempotencyStore } from './http/idempotency';
import { AmqpBroker } from './outbox/amqp';
import { OutboxPublisher } from './outbox/publisher';
import { systemClock } from './time';

async function main(): Promise<void> {
  const config = loadConfig();
  assertRunnable(config);

  const pool = createPool(config.databaseUrl);
  const applied = await migrate(pool);
  console.log(`[Booking] PostgreSQL ready: booking_db (${applied.length} migration(s) applied)`);

  const contracts = new Contracts(config.contractsDir);
  const workload = new WorkloadAuthenticator(config.workloadCredentials);
  const peers = {
    tutor: new GrpcTutorClient(config.contractsDir, config.tutorGrpcUrl, config.outboundCredential, contracts),
    auth: new GrpcAuthClient(config.contractsDir, config.authGrpcUrl, config.outboundCredential),
    wallet: new GrpcWalletClient(config.contractsDir, config.walletGrpcUrl, config.outboundCredential, contracts),
  };
  const ctx: Ctx = { pool, clock: systemClock, peers, contracts, idem: new IdempotencyStore(pool), config };

  const app = createApp({
    pool, clock: systemClock, config, contracts, workload, peers,
    actors: new ActorVerifier(config.actorPublicKey!),
    // Ready means "can take booking decisions": the database answers. A broker outage never makes Booking unready,
    // because committed outbox work simply waits for the publisher.
    ready: async () => { await pool.query('SELECT 1'); return true; },
  });
  const http = app.listen(config.port, () => console.log(`[Booking] REST listening on :${config.port}`));
  const grpcServer = await startGrpcServer({ contractsDir: config.contractsDir, contracts, workload, ctx }, config.grpcPort);
  grpcServer.health.setServing(true);
  console.log(`[Booking] gRPC Availability and BookingEvidence services listening on :${grpcServer.port}`);

  const broker = new AmqpBroker(config.rabbitmqUrl, config.rabbitmqUser);
  const publisher = new OutboxPublisher(pool, broker, systemClock, contracts);
  publisher.start(1000);
  const topology = setInterval(() => broker.verifyTopology().catch((e) => console.warn(`[Booking] broker topology not ready: ${(e as Error).message}`)), 30_000);
  topology.unref();

  const workers = new BackgroundWorkers(ctx);
  workers.start(2000);

  const shutdown = async () => {
    console.log('[Booking] shutting down');
    grpcServer.health.shutdown();
    workers.stop();
    publisher.stop();
    clearInterval(topology);
    grpcServer.server.tryShutdown(() => undefined);
    http.close();
    await broker.close();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('[Booking] startup failed', error);
  process.exit(1);
});
