import { timingSafeEqual } from 'node:crypto';
import { AppError as SharedAppError, verifyActorAssertion } from '@tutor-matcher/shared';
import { forbidden, unauthenticated } from './errors';

export type Capability = 'STUDENT' | 'TUTOR' | 'ADMIN';

/** The Gateway-signed admission. The only source of "who is calling" for a user action. */
export interface Actor {
  userId: string;
  sessionId: string;
  admissionId: string;
  admittedAt: Date;
  requestId: string;
  publicOperation: string;
  capabilities: Capability[];
  accountRevision: string;
}

export interface Admission {
  id: string;
  actorUserId: string;
  sessionId: string;
  admittedAt: string;
  requestId: string;
  publicOperation: string;
}

export function actorAdmission(actor: Actor): Admission {
  return {
    id: actor.admissionId,
    actorUserId: actor.userId,
    sessionId: actor.sessionId,
    admittedAt: actor.admittedAt.toISOString(),
    requestId: actor.requestId,
    publicOperation: actor.publicOperation,
  };
}

export class WorkloadAuthenticator {
  private readonly entries: Array<[string, Buffer]>;

  constructor(credentials: Record<string, string>) {
    this.entries = Object.entries(credentials).map(([caller, secret]) => [caller, Buffer.from(secret)]);
  }

  /** Maps an opaque bearer credential to a caller name. A method name or DNS address never establishes identity. */
  callerFor(authorization: string | undefined): string {
    const match = /^Bearer (.+)$/.exec(authorization ?? '');
    if (!match) throw unauthenticated('WORKLOAD_UNAUTHENTICATED', 'Missing workload credential');
    const presented = Buffer.from(match[1]);
    let caller: string | undefined;
    for (const [name, secret] of this.entries) {
      // Compare every entry so timing does not reveal which caller matched.
      const equal = presented.length === secret.length && timingSafeEqual(presented, secret);
      if (equal) caller = name;
    }
    if (!caller) throw unauthenticated('WORKLOAD_UNAUTHENTICATED', 'Unknown workload credential');
    return caller;
  }

  require(authorization: string | undefined, allowed: readonly string[]): string {
    const caller = this.callerFor(authorization);
    if (!allowed.includes(caller)) throw forbidden('CALLER_NOT_ALLOWED', 'This caller may not use this operation');
    return caller;
  }
}

export class ActorVerifier {
  constructor(private readonly publicKey: string, private readonly now: () => Date = () => new Date()) {}

  /** Signature, issuer, audience and claim shape come from the shared verifier so every owner accepts the same assertion. */
  verify(token: string | undefined): Actor {
    if (!token) throw unauthenticated('ACTOR_REQUIRED', 'A gateway-signed actor assertion is required');
    let claims: ReturnType<typeof verifyActorAssertion>;
    try {
      claims = verifyActorAssertion(token, this.publicKey, Math.floor(this.now().getTime() / 1000));
    } catch (error) {
      if (error instanceof SharedAppError) throw unauthenticated('ACTOR_INVALID', 'Actor assertion is invalid or expired');
      throw error;
    }
    const admittedAt = new Date(claims.admittedAt);
    if (Number.isNaN(admittedAt.getTime())) throw unauthenticated('ACTOR_INVALID', 'Actor assertion is missing required claims');
    return {
      userId: claims.userId,
      sessionId: claims.sessionId,
      admissionId: claims.admissionId,
      admittedAt,
      requestId: claims.requestId,
      publicOperation: claims.publicOperation,
      capabilities: claims.capabilities.filter((c): c is Capability => c === 'STUDENT' || c === 'TUTOR' || c === 'ADMIN'),
      accountRevision: claims.accountRevision,
    };
  }
}

export function requireCapability(actor: Actor, capability: Capability): void {
  if (!actor.capabilities.includes(capability)) throw forbidden('FORBIDDEN', `The ${capability} capability is required`);
}
