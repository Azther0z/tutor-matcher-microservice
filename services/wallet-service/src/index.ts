import { ActorVerifier, WorkloadAuthenticator } from './auth';
import { assertRunnable, loadConfig } from './config';
import { Contracts } from './contracts';
import { createPool, migrate } from './db';
import { clearDueEarnings } from './domain/clearing';
import { FinancialService } from './domain/financial';
import { GrpcAuthClient, GrpcBookingClient } from './grpc/clients';
import { startGrpcServer } from './grpc/server';
import { createApp } from './http/app';
import { AmqpBroker } from './outbox/amqp';
import { OutboxPublisher } from './outbox/publisher';
import { systemClock } from './time';

async function main(): Promise<void> {
  const config = loadConfig();
  assertRunnable(config);

  const pool = createPool(config.databaseUrl);
  const applied = await migrate(pool);
  console.log(`[Wallet] PostgreSQL ready: wallet_db (${applied.length} migration(s) applied)`);

  const contracts = new Contracts(config.contractsDir);
  const workload = new WorkloadAuthenticator(config.workloadCredentials);
  const finance = new FinancialService(pool, systemClock);
  const peers = {
    booking: new GrpcBookingClient(config.contractsDir, config.bookingGrpcUrl, config.outboundCredential, contracts),
    auth: new GrpcAuthClient(config.contractsDir, config.authGrpcUrl, config.outboundCredential),
  };

  const app = createApp({
    pool, clock: systemClock, config, contracts, workload, peers,
    actors: new ActorVerifier(config.actorPublicKey!),
    // Ready means "can take money decisions": the database answers. A broker outage never makes Wallet unready,
    // because committed outbox work simply waits for the publisher.
    ready: async () => { await pool.query('SELECT 1'); return true; },
  });
  const http = app.listen(config.port, () => console.log(`[Wallet] REST listening on :${config.port}`));
  const grpcServer = await startGrpcServer({ contractsDir: config.contractsDir, contracts, workload, finance }, config.grpcPort, '0.0.0.0', async () => { await pool.query('SELECT 1'); return true; });
  grpcServer.health.setServing(true);
  console.log(`[Wallet] gRPC WalletFinanceService listening on :${grpcServer.port}`);

  const broker = new AmqpBroker(config.rabbitmqUrl, config.rabbitmqUser);
  const publisher = new OutboxPublisher(pool, broker, systemClock, contracts);
  publisher.start(1000);
  const topology = setInterval(() => broker.verifyTopology().catch((e) => console.warn(`[Wallet] broker topology not ready: ${(e as Error).message}`)), 30_000);
  topology.unref();

  // Reconcile due earnings on boot and then periodically; due work always comes from the database, never a timer.
  const sweep = async () => {
    try {
      const result = await clearDueEarnings(pool, systemClock);
      if (result.cleared) console.log(`[Wallet] cleared ${result.cleared} pending earning(s)`);
    } catch (error) { console.error('[Wallet] clearing sweep failed', (error as Error).message); }
  };
  void sweep();
  const clearing = setInterval(sweep, 30_000);
  clearing.unref();


  const shutdown = async () => {
    console.log('[Wallet] shutting down');
    grpcServer.health.shutdown();
    publisher.stop();
    clearInterval(clearing);
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
  console.error('[Wallet] startup failed', error);
  process.exit(1);
});
