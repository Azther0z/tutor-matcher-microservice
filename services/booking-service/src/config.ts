import 'dotenv/config';
import path from 'node:path';
import { credentialsFrom, loadSecretFiles } from './secrets';

const SECRETS = [
  'DATABASE_URL', 'RABBITMQ_URL', 'ACTOR_ASSERTION_PUBLIC_KEY',
  'GATEWAY_WORKLOAD_CREDENTIAL', 'TUTOR_WORKLOAD_CREDENTIAL', 'REVIEW_WORKLOAD_CREDENTIAL',
  'WALLET_WORKLOAD_CREDENTIAL', 'NOTIFICATION_WORKLOAD_CREDENTIAL', 'BOOKING_WORKLOAD_CREDENTIAL',
] as const;
/** Callers allowed to present a credential to Booking's REST and gRPC surfaces. */
const INBOUND_CALLERS = ['gateway', 'tutor', 'review', 'wallet', 'notification'] as const;

export interface Config {
  port: number;
  grpcPort: number;
  databaseUrl: string;
  rabbitmqUrl: string;
  rabbitmqUser: string;
  demoMode: boolean;
  /** RS256 public key that verifies the actor assertion signed by Auth. */
  actorPublicKey?: string;
  /** caller name → opaque bearer credential. */
  workloadCredentials: Record<string, string>;
  /** This service's own credential, presented to Tutor, Wallet and Auth. */
  outboundCredential?: string;
  tutorGrpcUrl: string;
  walletGrpcUrl: string;
  authGrpcUrl: string;
  contractsDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  loadSecretFiles(SECRETS, env);
  const rabbitmqUrl = env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1:5672';
  return {
    // PORT is the convention of the other owners; HTTP_PORT is accepted for the older Compose files.
    port: Number(env.PORT || env.HTTP_PORT || 4004),
    grpcPort: Number(env.GRPC_PORT || 50052),
    databaseUrl: env.DATABASE_URL || '',
    rabbitmqUrl,
    rabbitmqUser: env.RABBITMQ_USER || decodeURIComponent(new URL(rabbitmqUrl).username || 'guest'),
    demoMode: env.DEMO_MODE === 'true',
    actorPublicKey: env.ACTOR_ASSERTION_PUBLIC_KEY?.replace(/\\n/g, '\n'),
    workloadCredentials: credentialsFrom(env, INBOUND_CALLERS),
    outboundCredential: env.BOOKING_WORKLOAD_CREDENTIAL,
    tutorGrpcUrl: env.TUTOR_GRPC_URL || 'tutor-service:50053',
    walletGrpcUrl: env.WALLET_GRPC_URL || 'wallet-service:50054',
    authGrpcUrl: env.AUTH_GRPC_URL || 'auth-service:50051',
    contractsDir: env.CONTRACTS_DIR || path.resolve(__dirname, '../../../contracts'),
  };
}

/** Fail fast on configuration that would silently weaken a security rule. */
export function assertRunnable(config: Config): void {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  if (!config.actorPublicKey) throw new Error('ACTOR_ASSERTION_PUBLIC_KEY is required to verify actor assertions');
  if (!config.outboundCredential) throw new Error('BOOKING_WORKLOAD_CREDENTIAL is required to call Tutor, Wallet and Auth');
  for (const caller of INBOUND_CALLERS) {
    if (!config.workloadCredentials[caller]) throw new Error(`${caller.toUpperCase()}_WORKLOAD_CREDENTIAL is required`);
  }
}
