import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import {
  PeerRefusal,
  type AccountSummary, type AuthClient, type BookableSubject, type CallContext, type CloseReason, type CompletionCommand,
  type PaymentCommand, type PaymentResult, type RefundCommand, type RefundResult, type TutorClient, type TutorEligibility, type WalletClient,
} from '../clients';
import type { Contracts } from '../contracts';
import { notFound, unavailable } from '../errors';
import { CHANNEL_OPTIONS, decodeErrorDetail, decoded, loadProtos, withNulls } from './proto';

const READ_DEADLINE_MS = 2000; // read-only internal calls have a 2-second total budget
const WRITE_DEADLINE_MS = 3000; // one remote mutation attempt has a 3-second budget

/** Statuses a peer returns when it understood and refused the call. Everything else leaves the outcome unknown. */
const REFUSALS = new Set<number>([
  grpc.status.INVALID_ARGUMENT, grpc.status.PERMISSION_DENIED, grpc.status.FAILED_PRECONDITION,
  grpc.status.ALREADY_EXISTS, grpc.status.NOT_FOUND, grpc.status.OUT_OF_RANGE,
]);

interface CallOptions {
  deadlineMs: number;
  /** Map a definitive refusal to PeerRefusal (with the peer's machine code) instead of a plain not-found. */
  refusals?: boolean;
}

class Caller {
  constructor(private readonly contractsDir: string, private readonly credential: string | undefined) {}

  unary<T>(client: grpc.Client, method: string, request: unknown, context: CallContext, options: CallOptions): Promise<T> {
    const metadata = new grpc.Metadata();
    if (this.credential) metadata.set('authorization', `Bearer ${this.credential}`);
    metadata.set('x-request-id', context.requestId || randomUUID());
    return new Promise<T>((resolve, reject) => {
      (client as any)[method](request, metadata, { deadline: new Date(Date.now() + options.deadlineMs) }, (error: grpc.ServiceError | null, response: T) => {
        if (!error) return resolve(response);
        if (options.refusals && REFUSALS.has(error.code)) return reject(new PeerRefusal(this.peerCode(error), 'The service refused this request', error.code));
        // Never expose a peer's trailer or stack. A timeout leaves the outcome unknown, so say "unavailable".
        if (error.code === grpc.status.NOT_FOUND) return reject(notFound('NOT_FOUND', 'The requested resource was not found'));
        reject(unavailable('DEPENDENCY_UNAVAILABLE', 'A required service is unavailable'));
      });
    });
  }

  private peerCode(error: grpc.ServiceError): string {
    try {
      const raw = error.metadata?.get('tutor-error-bin')?.[0];
      if (raw instanceof Buffer) return decodeErrorDetail(this.contractsDir, raw).code || 'PEER_REFUSED';
    } catch {
      /* fall through to the generic code */
    }
    return 'PEER_REFUSED';
  }
}

export class GrpcTutorClient implements TutorClient {
  private readonly client: grpc.Client;
  private readonly caller: Caller;
  constructor(private readonly contractsDir: string, target: string, credential: string | undefined, private readonly contracts: Contracts) {
    const proto = loadProtos(contractsDir, ['tutor/v1/catalogue.proto']) as any;
    this.client = new proto.tutor_matcher.tutor.v1.TutorCatalogueService(target, grpc.credentials.createInsecure(), CHANNEL_OPTIONS);
    this.caller = new Caller(contractsDir, credential);
  }

  async getBookableSubject(subjectId: string, context: CallContext): Promise<BookableSubject> {
    const raw = await this.caller.unary<Record<string, unknown>>(this.client, 'GetBookableSubject', { subjectId }, context, { deadlineMs: READ_DEADLINE_MS, refusals: true });
    return this.contracts.assertDef<BookableSubject>('BookableSubject', decoded(raw));
  }

  async getTutorEligibility(userId: string, context: CallContext): Promise<TutorEligibility> {
    const raw = await this.caller.unary<Record<string, unknown>>(this.client, 'GetTutorEligibility', { userId }, context, { deadlineMs: READ_DEADLINE_MS });
    return this.contracts.assertDef<TutorEligibility>('TutorEligibility', withNulls(raw, ['tutorId']));
  }
}

export class GrpcAuthClient implements AuthClient {
  private readonly client: grpc.Client;
  private readonly caller: Caller;
  constructor(contractsDir: string, target: string, credential: string | undefined) {
    const proto = loadProtos(contractsDir, ['auth/v1/collaboration.proto']) as any;
    this.client = new proto.tutor_matcher.auth.v1.AuthCollaborationService(target, grpc.credentials.createInsecure(), CHANNEL_OPTIONS);
    this.caller = new Caller(contractsDir, credential);
  }

  async lookupAccounts(userIds: string[], context: CallContext): Promise<AccountSummary[]> {
    const raw = await this.caller.unary<{ items?: Array<Record<string, unknown>> }>(this.client, 'LookupAccounts', { userIds }, context, { deadlineMs: READ_DEADLINE_MS });
    return (decoded<{ items?: Array<Record<string, unknown>> }>(raw).items ?? []).map((item) => ({
      id: String(item.id),
      displayName: String(item.displayName),
      email: String(item.email ?? ''),
      status: item.status as AccountSummary['status'],
      capabilities: (item.capabilities ?? []) as AccountSummary['capabilities'],
    }));
  }
}

export class GrpcWalletClient implements WalletClient {
  private readonly client: grpc.Client;
  private readonly caller: Caller;
  constructor(contractsDir: string, target: string, credential: string | undefined, private readonly contracts: Contracts) {
    const proto = loadProtos(contractsDir, ['wallet/v1/finance.proto']) as any;
    this.client = new proto.tutor_matcher.wallet.v1.WalletFinanceService(target, grpc.credentials.createInsecure(), CHANNEL_OPTIONS);
    this.caller = new Caller(contractsDir, credential);
  }

  private payment(raw: Record<string, unknown>): PaymentResult {
    return this.contracts.assertDef<PaymentResult>('PaymentResult', withNulls(raw, ['transactionId', 'reason']));
  }

  private refund(raw: Record<string, unknown>): RefundResult {
    return this.contracts.assertDef<RefundResult>('RefundResult', decoded(raw));
  }

  // Mutations are sent once per attempt. There is no automatic retry: a timeout leaves the outcome unknown and the
  // durable recovery worker repeats the *same* operation identity.
  async applyLessonCharge(operationId: string, command: PaymentCommand, context: CallContext): Promise<PaymentResult> {
    return this.payment(await this.caller.unary(this.client, 'ApplyLessonCharge', { operationId, command }, context, { deadlineMs: WRITE_DEADLINE_MS, refusals: true }));
  }

  async getLessonCharge(operationId: string, context: CallContext): Promise<PaymentResult> {
    return this.payment(await this.caller.unary(this.client, 'GetLessonCharge', { operationId }, context, { deadlineMs: READ_DEADLINE_MS }));
  }

  async resolveOrCloseLessonCharge(operationId: string, command: PaymentCommand, reason: CloseReason, context: CallContext): Promise<PaymentResult> {
    return this.payment(await this.caller.unary(this.client, 'ResolveOrCloseLessonCharge', { operationId, command: { command, reason } }, context, { deadlineMs: WRITE_DEADLINE_MS, refusals: true }));
  }

  async applyCancellationRefund(operationId: string, command: RefundCommand, context: CallContext): Promise<RefundResult> {
    return this.refund(await this.caller.unary(this.client, 'ApplyCancellationRefund', { operationId, command }, context, { deadlineMs: WRITE_DEADLINE_MS, refusals: true }));
  }

  async getRefundOutcome(operationId: string, context: CallContext): Promise<RefundResult> {
    return this.refund(await this.caller.unary(this.client, 'GetRefundOutcome', { operationId }, context, { deadlineMs: READ_DEADLINE_MS }));
  }

  async recordLessonCompletion(bookingId: string, command: CompletionCommand, context: CallContext): Promise<void> {
    await this.caller.unary(this.client, 'RecordLessonCompletion', { bookingId, command }, context, { deadlineMs: WRITE_DEADLINE_MS, refusals: true });
  }
}
