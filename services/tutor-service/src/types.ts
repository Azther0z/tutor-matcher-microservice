import type { ActorClaims } from "@tutor-matcher/shared";
export interface DraftWrite {
  bio?: string;
  identificationDocumentUrl?: string | null;
  introVideoUrl?: string | null;
  avatarUrl?: string | null;
  headline?: string;
}
export interface Submission {
  id: string;
  userId: string;
  kind: "APPLICATION" | "REVISION";
  state: "DRAFT" | "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  activation: "NOT_REQUIRED" | "PENDING" | "ACTIVE";
  bio: string;
  identificationDocumentUrl: string | null;
  introVideoUrl: string | null;
  avatarUrl: string | null;
  headline: string;
  rejectionReason: string | null;
  revision: string;
  submittedAt: string | null;
  reviewedAt: string | null;
}
export interface SubjectWrite {
  name: string;
  description: string;
  hourlyRate: string;
  format: "ONLINE";
  learningAreas: string[];
}
export interface Subject extends SubjectWrite {
  id: string;
  tutorId: string;
  tutorUserId: string;
  revision: string;
}
export interface TutorState {
  _id: string;
  revision: string;
  tutorId: string | null;
  published: boolean;
  activation: "NONE" | "PENDING" | "ACTIVE";
  currentSubmissionId: string | null;
  approvedSubmissionId: string | null;
  submissions: Submission[];
  subjects: Subject[];
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
  idempotencyKey: string;
  ifMatch?: string;
  route: string;
  method: string;
}
export interface Result {
  status: number;
  body?: unknown;
  revision?: string;
  location?: string;
}
export interface StoredOperation {
  _id: string;
  id: string;
  actorUserId: string;
  ownerUserId: string;
  kind: string;
  inputHash: string;
  status: "PENDING" | "SUCCEEDED" | "REJECTED";
  admission: Admission;
  result: Result;
  resource: { type: string; id: string; url: string } | null;
  createdAt: string;
  updatedAt: string;
}
export interface GrantWork {
  _id: string;
  operationId: string;
  ownerOperationKey: string;
  userId: string;
  submissionId: string;
  approvalRevision: string;
  admission: Admission;
  state: "PENDING" | "DONE" | "NEEDS_ATTENTION";
  availableAt: number;
  lockedUntil: number;
  fence: number;
  attempts: number;
  attemptLimit?: number;
  needsAttentionAt?: number;
  lastError?: string;
}
export interface EventEnvelope {
  eventId: string;
  type: string;
  schemaVersion: 1;
  occurredAt: string;
  producer: "tutor";
  aggregate: { type: string; id: string; version: string };
  correlationId: string;
  notificationGroup: "SYSTEM";
  targets: { kind: "ADMINS" } | { kind: "USERS"; userIds: string[] };
  data: Record<string, unknown>;
}
export interface OutboxWork {
  _id: string;
  event: EventEnvelope;
  state: "PENDING" | "SENT" | "NEEDS_ATTENTION";
  availableAt: number;
  lockedUntil: number;
  fence: number;
  attempts: number;
  attemptLimit?: number;
  needsAttentionAt?: number;
  lastError?: string;
}
export interface AccountLookup {
  id: string;
  displayName: string;
  email: string;
  status: string;
  capabilities: string[];
}
export interface RatingSummary {
  subjectId: string;
  average: number | null;
  reviewCount: number;
  distribution: Record<string, number>;
}
export interface AvailabilityQuery {
  tutorId: string;
  subjectId: string;
  from: string;
  to: string;
}
export interface AvailabilitySummary {
  queryIndex: number;
  hasAvailability: boolean;
  nextAvailableAt: string;
  freeSlotCount: number;
}
export interface PublicSlot {
  id: string;
  tutorId: string;
  subjectIds: string[];
  startsAt: string;
  endsAt: string;
  revision: string;
}
export interface Peers {
  accounts(ids: string[]): Promise<AccountLookup[]>;
  grant(work: GrantWork): Promise<{
    operationId: string;
    userId: string;
    capability: string;
    status: string;
    appliedAt: string;
  }>;
  ratings(ids: string[]): Promise<RatingSummary[]>;
  batchAvailability(
    queries: AvailabilityQuery[],
  ): Promise<AvailabilitySummary[]>;
  availability(query: AvailabilityQuery): Promise<PublicSlot[]>;
  publicReviews(query: {
    tutorId: string;
    subjectId?: string;
  }): Promise<unknown[]>;
}
export interface SearchQuery {
  page?: number;
  pageSize?: number;
  q?: string;
  tutorName?: string;
  learningArea?: string;
  minRate?: string;
  maxRate?: string;
  minRating?: number;
  format?: "ONLINE";
  preferredLearningAreas?: string[];
  sort?: "RECOMMENDED" | "PRICE_ASC" | "PRICE_DESC" | "TOP_RATED";
}
