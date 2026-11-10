export type Money = { currency: "THB"; amount: string };
export type PageMeta = { page: number; pageSize: number; totalItems: number; totalPages: number };
export type Paged<T> = { items: T[]; pagination: PageMeta };
export type ResourceRef = { type: string; id: string; url: string };
export type OperationRef = { id: string; owner: string; status: "PENDING" | "SUCCEEDED" | "REJECTED"; statusUrl: string; resource: ResourceRef | null };

export type WalletOverview = {
  userId: string;
  postedBalance: Money;
  reservedPayouts: Money;
  availableBalance: Money;
  pendingEarnings: Money;
  earningsThisMonth: Money;
  totalPaidOut: Money;
  paymentDueBookings: ResourceRef[];
};

export const TRANSACTION_TYPES = ["TOP_UP", "LESSON_PAYMENT", "LESSON_EARNING", "REFUND", "PAYOUT"] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];
export type WalletTransaction = {
  id: string;
  type: TransactionType;
  amount: Money;
  direction: "IN" | "OUT";
  balanceAfter: Money;
  operationId: string;
  bookingId: string | null;
  payoutAccountId: string | null;
  createdAt: string;
};

export type ProviderStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
export type Topup = {
  id: string;
  userId: string;
  amount: Money;
  status: ProviderStatus;
  demo: boolean;
  manual?: boolean;
  providerReference: string;
  paymentRepresentation: string;
  slip?: { contentType: string; uploadedAt: string; url?: string } | null;
  decisionReason?: string | null;
  decidedAt?: string | null;
  /** Present on the admin review list. */
  userDisplayName?: string;
  operation: OperationRef;
  createdAt: string;
  confirmedAt: string | null;
};

export type PayoutAccount = { id: string; bankCode: string; accountHolderName: string; maskedAccountNumber: string; isDefault: boolean; revision: string };
export type Bank = { code: string; name: string };
export type Payout = {
  id: string;
  userId: string;
  amount: Money;
  payoutAccount: PayoutAccount;
  status: ProviderStatus;
  operation: OperationRef;
  demo: true;
  providerReference: string;
  createdAt: string;
  resolvedAt: string | null;
};

export type AuditEntry = { id: string; actorUserId: string | null; action: string; reason: string | null; occurredAt: string };
export type DisputeStatus = "OPEN" | "APPROVED" | "REJECTED";
export type Dispute = {
  id: string;
  bookingId: string;
  studentUserId: string;
  status: DisputeStatus;
  reason: string;
  decisionReason: string | null;
  refundedAmount: Money;
  earningsHeld: boolean;
  revision: string;
  createdAt: string;
  resolvedAt: string | null;
  audit: AuditEntry[];
};
export type FinancialRecord = {
  bookingId: string;
  studentUserId: string;
  tutorUserId: string;
  paid: Money;
  refunded: Money;
  pendingEarning: Money;
  fee: Money;
  status: "UNPAID" | "PAID" | "CANCELLED" | "COMPLETED" | "SETTLED" | "REFUNDED";
  paymentGate: "OPEN" | "CLOSED";
  tutorConfirmedAt: string | null;
  clearingDueAt: string | null;
  disputeId: string | null;
  disputeHeld: boolean;
  revision: string;
};
export type BookingEvidence = {
  bookingId: string;
  status: "PAYMENT_DUE" | "CONFIRMED" | "COMPLETED" | "CANCELLED";
  studentUserId: string;
  tutorUserId: string;
  subjectId: string;
  startsAt: string;
  endsAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  revision: string;
};
export type AdminDisputeDetail = {
  dispute: Dispute;
  booking: BookingEvidence;
  financial: FinancialRecord;
  transactions: WalletTransaction[];
  studentDisplayName: string;
  tutorDisplayName: string;
};
