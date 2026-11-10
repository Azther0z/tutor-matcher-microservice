import 'dotenv/config';
import path from 'node:path';
import { credentialsFrom, loadSecretFiles } from './secrets';

const SECRETS = [
  'DATABASE_URL', 'RABBITMQ_URL', 'ACTOR_ASSERTION_PUBLIC_KEY', 'PAYOUT_FINGERPRINT_KEY',
  'GATEWAY_WORKLOAD_CREDENTIAL', 'BOOKING_WORKLOAD_CREDENTIAL', 'WALLET_WORKLOAD_CREDENTIAL',
] as const;
/** Callers allowed to present a credential to Wallet's REST and gRPC surfaces. */
const INBOUND_CALLERS = ['gateway', 'booking'] as const;

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
  /** this service's own outbound credential per callee, sent to Booking/Auth/Tutor. */
  outboundCredential?: string;
  bookingGrpcUrl: string;
  authGrpcUrl: string;
  tutorGrpcUrl: string;
  fingerprintKey: string;
  contractsDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  loadSecretFiles(SECRETS, env);
  const rabbitmqUrl = env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1:5672';
  const demoMode = env.DEMO_MODE === 'true';
  const config: Config = {
    port: Number(env.PORT || 4003),
    grpcPort: Number(env.GRPC_PORT || 50054),
    databaseUrl: env.DATABASE_URL || '',
    rabbitmqUrl,
    rabbitmqUser: env.RABBITMQ_USER || decodeURIComponent(new URL(rabbitmqUrl).username || 'guest'),
    demoMode,
    actorPublicKey: env.ACTOR_ASSERTION_PUBLIC_KEY?.replace(/\\n/g, '\n'),
    workloadCredentials: credentialsFrom(env, INBOUND_CALLERS),
    outboundCredential: env.WALLET_WORKLOAD_CREDENTIAL,
    bookingGrpcUrl: env.BOOKING_GRPC_URL || 'booking-service:50052',
    authGrpcUrl: env.AUTH_GRPC_URL || 'auth-service:50051',
    tutorGrpcUrl: env.TUTOR_GRPC_URL || 'tutor-service:50053',
    fingerprintKey: env.PAYOUT_FINGERPRINT_KEY || '',
    contractsDir: env.CONTRACTS_DIR || path.resolve(__dirname, '../../contracts'),
  };
  return config;
}

/** Fail fast on configuration that would silently weaken a security rule. */
export function assertRunnable(config: Config): void {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  if (!config.actorPublicKey) throw new Error('ACTOR_ASSERTION_PUBLIC_KEY is required to verify actor assertions');
  for (const caller of INBOUND_CALLERS) {
    if (!config.workloadCredentials[caller]) throw new Error(`${caller.toUpperCase()}_WORKLOAD_CREDENTIAL is required`);
  }
  if (config.fingerprintKey.length < 32) throw new Error('PAYOUT_FINGERPRINT_KEY must be at least 32 characters');
}
