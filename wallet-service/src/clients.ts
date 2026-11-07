// Interfaces for the peers Wallet calls over gRPC. Tests inject typed doubles; production uses grpc/clients.ts.

export interface BookingEvidence {
  bookingId: string;
  status: 'PAYMENT_DUE' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';
  studentUserId: string;
  tutorUserId: string;
  subjectId: string;
  startsAt: string;
  endsAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  revision: string;
}

export interface AccountSummary {
  id: string;
  displayName: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'DEACTIVATED';
  capabilities: Array<'STUDENT' | 'TUTOR' | 'ADMIN'>;
}

export interface CallContext {
  requestId: string;
}

export interface BookingClient {
  getBookingEvidence(bookingId: string, context: CallContext): Promise<BookingEvidence>;
}

export interface AuthClient {
  lookupAccounts(userIds: string[], context: CallContext): Promise<AccountSummary[]>;
}

export interface Peers {
  booking: BookingClient;
  auth: AuthClient;
}
