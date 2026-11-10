import 'dotenv/config';
import path from 'node:path';
import { credentialsFrom, loadSecretFiles } from './secrets';

const SECRETS = [
  'MONGO_URI', 'RABBITMQ_URL', 'ACTOR_ASSERTION_PUBLIC_KEY', 'GATEWAY_WORKLOAD_CREDENTIAL', 'MESSAGING_WORKLOAD_CREDENTIAL',
] as const;
/** Callers allowed to present a credential to Messaging's REST surface. */
const INBOUND_CALLERS = ['gateway'] as const;

export interface Config {
  port: number;
  mongoUri: string;
  rabbitmqUrl: string;
  rabbitmqUser: string;
  demoMode: boolean;
  actorPublicKey?: string;
  workloadCredentials: Record<string, string>;
  /** This service's own credential, presented to Auth and Tutor. */
  outboundCredential?: string;
  authGrpcUrl: string;
  tutorGrpcUrl: string;
  contractsDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  loadSecretFiles(SECRETS, env);
  const rabbitmqUrl = env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1:5672';
  return {
    port: Number(env.PORT || 4006),
    mongoUri: env.MONGO_URI || '',
    rabbitmqUrl,
    rabbitmqUser: env.RABBITMQ_USER || decodeURIComponent(new URL(rabbitmqUrl).username || 'guest'),
    demoMode: env.DEMO_MODE === 'true',
    actorPublicKey: env.ACTOR_ASSERTION_PUBLIC_KEY?.replace(/\\n/g, '\n'),
    workloadCredentials: credentialsFrom(env, INBOUND_CALLERS),
    outboundCredential: env.MESSAGING_WORKLOAD_CREDENTIAL,
    authGrpcUrl: env.AUTH_GRPC_URL || 'auth-service:50051',
    tutorGrpcUrl: env.TUTOR_GRPC_URL || 'tutor-service:50053',
    contractsDir: env.CONTRACTS_DIR || path.resolve(__dirname, '../../../contracts'),
  };
}

export function assertRunnable(config: Config): void {
  if (!config.mongoUri) throw new Error('MONGO_URI is required');
  if (!config.actorPublicKey) throw new Error('ACTOR_ASSERTION_PUBLIC_KEY is required to verify actor assertions');
  if (!config.outboundCredential) throw new Error('MESSAGING_WORKLOAD_CREDENTIAL is required to call Auth and Tutor');
  for (const caller of INBOUND_CALLERS) {
    if (!config.workloadCredentials[caller]) throw new Error(`${caller.toUpperCase()}_WORKLOAD_CREDENTIAL is required`);
  }
}
