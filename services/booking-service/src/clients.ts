// Interfaces for the peers Booking calls over gRPC. Tests inject typed doubles; production uses grpc/clients.ts.

export interface CallContext {
  requestId: string;
}

export interface Money {
  currency: 'THB';
  amount: string;
}

export interface Admission {
  id: string;
  actorUserId: string;
  sessionId: string;
  admittedAt: string;
  requestId: string;
  publicOperation: string;
}

export interface SubjectSnapshot {
  id: string;
  tutorId: string;
  tutorUserId: string;
  name: string;
  description: string;
  hourlyRate: string;
  format: 'ONLINE';
  revision: string;
}

export interface BookableSubject {
  subject: SubjectSnapshot;
  published: true;
  eligibilityCheckedAt: string;
}

export interface TutorEligibility {
  userId: string;
  tutorId: string | null;
  approved: boolean;
  activated: boolean;
  published: boolean;
  revision: string;
}

export interface AccountSummary {
  id: string;
  displayName: string;
  email: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'DEACTIVATED';
  capabilities: Array<'STUDENT' | 'TUTOR' | 'ADMIN'>;
}

export interface PaymentCommand {
  bookingId: string;
  sourceOperationId: string;
  studentUserId: string;
  tutorUserId: string;
  subjectId: string;
  amount: Money;
  startsAt: string;
  endsAt: string;
  holdExpiresAt: string;
  admission: Admission;
}

export type CloseReason = 'CANCEL_REQUESTED' | 'HOLD_EXPIRED' | 'ABORT_PAYMENT';

export interface PaymentResult {
  operationId: string;
  bookingId: string;
  status: 'APPLIED' | 'DECLINED' | 'CLOSED';
  transactionId: string | null;
  amount: Money;
  balance: Money;
  reason: string | null;
  decidedAt: string;
}

export interface RefundCommand {
  bookingId: string;
  paymentOperationId: string;
  sourceOperationId: string;
  studentUserId: string;
  tutorUserId: string;
  quoteId: string;
  kind: 'STUDENT_CANCEL' | 'TUTOR_CANCEL';
  amount: Money;
  policyVersion: string;
  admission: Admission;
}

export interface RefundResult {
  operationId: string;
  bookingId: string;
  status: 'APPLIED';
  amount: Money;
  totalRefunded: Money;
  transactionId: string;
  appliedAt: string;
}

export interface CompletionCommand {
  sourceOperationId: string;
  bookingVersion: string;
  tutorConfirmedAt: string;
  admission: Admission;
}

/**
 * A definitive answer from a peer that refused the call (for example PAYMENT_GATE_CLOSED).
 * Anything else, such as a timeout or an outage, leaves the outcome unknown and must be retried with the same identity.
 */
export class PeerRefusal extends Error {
  constructor(readonly code: string, message: string, readonly grpcStatus: number) {
    super(message);
    this.name = 'PeerRefusal';
  }
}

export interface TutorClient {
  getBookableSubject(subjectId: string, context: CallContext): Promise<BookableSubject>;
  getTutorEligibility(userId: string, context: CallContext): Promise<TutorEligibility>;
}

export interface AuthClient {
  lookupAccounts(userIds: string[], context: CallContext): Promise<AccountSummary[]>;
}

export interface WalletClient {
  applyLessonCharge(operationId: string, command: PaymentCommand, context: CallContext): Promise<PaymentResult>;
  getLessonCharge(operationId: string, context: CallContext): Promise<PaymentResult>;
  resolveOrCloseLessonCharge(operationId: string, command: PaymentCommand, reason: CloseReason, context: CallContext): Promise<PaymentResult>;
  applyCancellationRefund(operationId: string, command: RefundCommand, context: CallContext): Promise<RefundResult>;
  getRefundOutcome(operationId: string, context: CallContext): Promise<RefundResult>;
  recordLessonCompletion(bookingId: string, command: CompletionCommand, context: CallContext): Promise<void>;
}

export interface Peers {
  tutor: TutorClient;
  auth: AuthClient;
  wallet: WalletClient;
}
