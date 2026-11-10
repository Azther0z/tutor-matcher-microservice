import type { ActorClaims } from "@tutor-matcher/shared";
export interface Review {
  id: string;
  bookingId: string;
  studentUserId: string;
  tutorId: string;
  tutorUserId: string;
  subjectId: string;
  rating: number;
  text: string;
  headline: string | null;
  reply: { id: string; text: string; createdAt: string } | null;
  visibility: "PUBLIC" | "HIDDEN" | "REMOVED";
  revision: string;
  createdAt: string;
  studentDisplayName: string;
}
export interface Flag {
  id: string;
  reviewId: string;
  reporterUserId: string;
  reason: string;
  state: "OPEN" | "RESOLVED";
  revision: string;
  createdAt: string;
}
export interface ReviewEligibility {
  bookingId: string;
  studentUserId: string;
  tutorId: string;
  tutorUserId: string;
  subjectId: string;
  completedAt: string | null;
  bookingRevision: string;
  eligible: boolean;
}
export interface Account {
  id: string;
  displayName: string;
  email: string;
  status: string;
  capabilities: string[];
}
export interface PeerClients {
  reviewEligibility(
    bookingId: string,
    actor?: string,
  ): Promise<ReviewEligibility>;
  accounts(userIds: string[]): Promise<Account[]>;
  close?(): void;
}
export interface Admission {
  id: string;
  actorUserId: string;
  sessionId: string;
  admittedAt: string;
  requestId: string;
  publicOperation: string;
}
export interface CommandContext {
  actor: ActorClaims;
  key: string;
  requestId: string;
  expectedRevision?: string;
  assertion?: string;
}
export interface SavedOperation {
  id: string;
  actorUserId: string;
  fingerprint: string;
  kind: string;
  admission: Admission;
  resource: { type: string; id: string; url: string };
  status: "SUCCEEDED";
  response: Review | Flag;
  createdAt: string;
  updatedAt: string;
}
export interface Audit {
  id: string;
  reviewId: string;
  actorUserId: string;
  action: string;
  reason: string;
  occurredAt: string;
}
export interface EventEnvelope {
  eventId: string;
  type: "review.flagged" | "review.moderated";
  schemaVersion: 1;
  occurredAt: string;
  producer: "review";
  aggregate: { type: string; id: string; version: string };
  correlationId: string;
  causationId: string;
  targets: { kind: "ADMINS" } | { kind: "USERS"; userIds: string[] };
  notificationGroup: "SYSTEM";
  data: Record<string, string>;
}
export interface OutboxRow {
  id: string;
  event: EventEnvelope;
  sentAt: string | null;
  leaseUntil: Date;
  fence: number;
  attempts: number;
  nextAttemptAt: Date;
  lastError?: string;
  needsAttentionAt?: string | null;
}
export interface RatingSummary {
  subjectId: string;
  average: number | null;
  reviewCount: number;
  distribution: Record<string, number>;
}
export interface ReviewStore {
  transaction<T>(work: (store: ReviewStore) => Promise<T>): Promise<T>;
  getReview(id: string): Promise<Review | null>;
  getReviewByBooking(id: string): Promise<Review | null>;
  insertReview(review: Review): Promise<void>;
  replaceReview(review: Review, previousRevision: string): Promise<void>;
  reviews(filter: {
    tutorId?: string;
    subjectId?: string;
    subjectIds?: string[];
    visibility?: Review["visibility"];
  }): Promise<Review[]>;
  getOperation(actorUserId: string, id: string): Promise<SavedOperation | null>;
  operation(id: string): Promise<SavedOperation | null>;
  saveOperation(operation: SavedOperation): Promise<void>;
  flags(reviewId?: string): Promise<Flag[]>;
  insertFlag(flag: Flag): Promise<void>;
  resolveFlags(reviewId: string): Promise<void>;
  saveAudit(audit: Audit): Promise<void>;
  addOutbox(row: OutboxRow): Promise<void>;
  claimOutbox(now: Date, leaseMs: number): Promise<OutboxRow | null>;
  completeOutbox(id: string, fence: number, now: Date): Promise<boolean>;
  retryOutbox(
    id: string,
    fence: number,
    now: Date,
    error: string,
  ): Promise<void>;
  ready(): Promise<boolean>;
}
