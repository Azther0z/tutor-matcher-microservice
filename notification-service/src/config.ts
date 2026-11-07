import 'dotenv/config';
import path from 'node:path';

export interface Config {
  port: number;
  mongoUri: string;
  mongoDb: string;
  rabbitmqUrl: string;
  consulUrl?: string;
  gatewayPublicKey?: string;
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
  const credentials: Record<string, string> = {};
  for (const [caller, secret] of Object.entries(JSON.parse(env.WORKLOAD_CREDENTIALS || '{}') as Record<string, unknown>)) {
    if (typeof secret !== 'string' || secret.length < 16) throw new Error(`WORKLOAD_CREDENTIALS.${caller} must be a string of at least 16 characters`);
    credentials[caller] = secret;
  }
  // Default: each producer connects to the broker as a user named after itself.
  const identities = env.PUBLISHER_IDENTITIES ? JSON.parse(env.PUBLISHER_IDENTITIES) as Record<string, string> : Object.fromEntries(PRODUCERS.map((p) => [p, p]));
  return {
    port: Number(env.PORT || 4007),
    mongoUri: env.MONGO_URI?.trim() || '',
    mongoDb: env.MONGO_DB || 'notification_db',
    rabbitmqUrl: env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1:5672',
    consulUrl: env.CONSUL_URL,
    gatewayPublicKey: env.GATEWAY_PUBLIC_KEY?.replace(/\\n/g, '\n'),
    workloadCredentials: credentials,
    outboundCredential: env.NOTIFICATION_WORKLOAD_CREDENTIAL,
    authGrpcUrl: env.AUTH_GRPC_URL || 'auth-service:50051',
    bookingGrpcUrl: env.BOOKING_GRPC_URL || 'booking-service:50052',
    publisherIdentities: identities,
    contractsDir: env.CONTRACTS_DIR || path.resolve(__dirname, '../../contracts'),
  };
}

export function assertRunnable(config: Config): void {
  if (!config.mongoUri) throw new Error('MONGO_URI is required');
  if (!config.gatewayPublicKey) throw new Error('GATEWAY_PUBLIC_KEY is required to verify actor assertions');
  if (Object.keys(config.workloadCredentials).length === 0) throw new Error('WORKLOAD_CREDENTIALS is required');
}
