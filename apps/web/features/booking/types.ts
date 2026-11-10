import type { PageMeta } from "@/lib/types";

export type Money = { currency: "THB"; amount: string };
export type Booking = {
  id: string;
  studentUserId: string;
  tutorId: string;
  tutorUserId: string;
  subject: { id: string; name: string; description: string; hourlyRate: string; format: "ONLINE" };
  availabilityIds: string[];
  description: string;
  startsAt: string;
  endsAt: string;
  amount: Money;
  status: "PAYMENT_DUE" | "CONFIRMED" | "COMPLETED" | "CANCELLED";
  revision: string;
  holdExpiresAt: string | null;
  paidAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  pendingOperation: { id: string; status: "PENDING" | "SUCCEEDED" | "REJECTED"; statusUrl: string } | null;
  meeting: { state: "PROVISIONING" | "MISSING" | "READY" | "CLOSED"; effectiveUrl: string | null; customMeetingUrl: string | null; canJoin: boolean; canEdit: boolean };
  canReview: boolean;
  studentDisplayName: string;
  tutorDisplayName: string;
};
export type BookingPage = { items: Booking[]; pagination: PageMeta };
export type CancellationQuote = { quoteId: string; bookingId: string; actor: "STUDENT" | "TUTOR"; refund: Money; fee: Money; late: boolean; requiresWarning: boolean; bookingRevision: string; expiresAt: string };
