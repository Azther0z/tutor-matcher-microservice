import 'dotenv/config';
import path from 'node:path';
import { credentialsFrom, loadSecretFiles } from './secrets';

const SECRETS = [
  'MONGO_URI', 'RABBITMQ_URL', 'ACTOR_ASSERTION_PUBLIC_KEY',
  'GATEWAY_WORKLOAD_CREDENTIAL', 'NOTIFICATION_WORKLOAD_CREDENTIAL',
] as const;
/** Callers allowed to present a credential to Notification's REST surface. */
const INBOUND_CALLERS = ['gateway'] as const;

export interface Config {
  port: number;
  mongoUri: string;
  mongoDb: string;
  rabbitmqUrl: string;
  /** RS256 public key that verifies the actor assertion signed by Auth. */
  actorPublicKey?: string;
  workloadCredentials: Record<string, string>;
  outboundCredential?: string;
  authGrpcUrl: string;
  bookingGrpcUrl: string;
  /** RabbitMQ username (verified AMQP user_id) → the producer name it may publish as. */
  publisherIdentities: Record<string, string>;
  contractsDir: string;
}

const PRODUCERS = ['auth', 'tutor', 'booking', 'wallet', 'review', 'messaging'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  loadSecretFiles(SECRETS, env);
  // Default: each producer connects to the broker as a user named after itself.
  const identities = env.PUBLISHER_IDENTITIES ? JSON.parse(env.PUBLISHER_IDENTITIES) as Record<string, string> : Object.fromEntries(PRODUCERS.map((p) => [p, p]));
  return {
    port: Number(env.PORT || 4007),
    mongoUri: env.MONGO_URI?.trim() || '',
    mongoDb: env.MONGO_DB || 'notification_db',
    rabbitmqUrl: env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1:5672',
    actorPublicKey: env.ACTOR_ASSERTION_PUBLIC_KEY?.replace(/\\n/g, '\n'),
    workloadCredentials: credentialsFrom(env, INBOUND_CALLERS),
    outboundCredential: env.NOTIFICATION_WORKLOAD_CREDENTIAL,
    authGrpcUrl: env.AUTH_GRPC_URL || 'auth-service:50051',
    bookingGrpcUrl: env.BOOKING_GRPC_URL || 'booking-service:50052',
    publisherIdentities: identities,
    contractsDir: env.CONTRACTS_DIR || path.resolve(__dirname, '../../../contracts'),
  };
}

export function assertRunnable(config: Config): void {
  if (!config.mongoUri) throw new Error('MONGO_URI is required');
  if (!config.actorPublicKey) throw new Error('ACTOR_ASSERTION_PUBLIC_KEY is required to verify actor assertions');
  for (const caller of INBOUND_CALLERS) {
    if (!config.workloadCredentials[caller]) throw new Error(`${caller.toUpperCase()}_WORKLOAD_CREDENTIAL is required`);
  }
}
