import 'dotenv/config';
import path from 'node:path';

export interface Config {
  port: number;
  grpcPort: number;
  databaseUrl: string;
  rabbitmqUrl: string;
  rabbitmqUser: string;
  consulUrl?: string;
  demoMode: boolean;
  gatewayPublicKey?: string;
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

function parseCredentials(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [caller, secret] of Object.entries(parsed)) {
    if (typeof secret !== 'string' || secret.length < 16) throw new Error(`WORKLOAD_CREDENTIALS.${caller} must be a string of at least 16 characters`);
    out[caller] = secret;
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rabbitmqUrl = env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1:5672';
  const demoMode = env.DEMO_MODE === 'true';
  const config: Config = {
    port: Number(env.PORT || 4003),
    grpcPort: Number(env.GRPC_PORT || 50054),
    databaseUrl: env.DATABASE_URL || '',
    rabbitmqUrl,
    rabbitmqUser: env.RABBITMQ_USER || decodeURIComponent(new URL(rabbitmqUrl).username || 'guest'),
    consulUrl: env.CONSUL_URL,
    demoMode,
    gatewayPublicKey: env.GATEWAY_PUBLIC_KEY?.replace(/\\n/g, '\n'),
    workloadCredentials: parseCredentials(env.WORKLOAD_CREDENTIALS),
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
  if (!config.gatewayPublicKey) throw new Error('GATEWAY_PUBLIC_KEY is required to verify actor assertions');
  if (Object.keys(config.workloadCredentials).length === 0) throw new Error('WORKLOAD_CREDENTIALS is required');
  if (config.fingerprintKey.length < 32) throw new Error('PAYOUT_FINGERPRINT_KEY must be at least 32 characters');
}
