import { MongoClient } from 'mongodb';
import { AmqpBroker } from './amqp';
import { ActorVerifier, WorkloadAuthenticator } from './auth';
import { assertRunnable, loadConfig } from './config';
import { Contracts } from './contracts';
import { MessagingService } from './domain';
import { GrpcAuthClient, GrpcTutorClient } from './grpc/clients';
import { createApp } from './http/app';
import { OutboxPublisher } from './outbox';
import { systemClock } from './time';

async function main(): Promise<void> {
  const config = loadConfig();
  assertRunnable(config);

  const client = await new MongoClient(config.mongoUri).connect();
  const db = client.db();
  const contracts = new Contracts(config.contractsDir);
  const peers = {
    auth: new GrpcAuthClient(config.contractsDir, config.authGrpcUrl, config.outboundCredential),
    tutor: new GrpcTutorClient(config.contractsDir, config.tutorGrpcUrl, config.outboundCredential, contracts),
  };
  const service = new MessagingService({ client, db, clock: systemClock, peers, contracts });
  await service.migrate();
  console.log(`[Messaging] MongoDB ready: ${db.databaseName}`);

  const app = createApp({
    service,
    workload: new WorkloadAuthenticator(config.workloadCredentials),
    actors: new ActorVerifier(config.actorPublicKey!),
    // Ready means "can accept messages": the database answers. A broker outage never makes Messaging unready.
    ready: async () => { await db.command({ ping: 1 }); return true; },
  });
  const http = app.listen(config.port, () => console.log(`[Messaging] REST listening on :${config.port}`));

  const broker = new AmqpBroker(config.rabbitmqUrl, config.rabbitmqUser);
  const publisher = new OutboxPublisher(db, broker, systemClock, contracts);
  publisher.start(1000);
  const topology = setInterval(() => broker.verifyTopology().catch((e) => console.warn(`[Messaging] broker topology not ready: ${(e as Error).message}`)), 30_000);
  topology.unref();

  const shutdown = async () => {
    console.log('[Messaging] shutting down');
    publisher.stop();
    clearInterval(topology);
    http.close();
    await broker.close();
    await client.close();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('[Messaging] startup failed', error);
  process.exit(1);
});
