export type Pagination = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};
export type Page<T> = { items: T[]; pagination: Pagination };
export type Submission = {
  id: string;
  userId: string;
  kind: "APPLICATION" | "REVISION";
  state: "DRAFT" | "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  activation: "NOT_REQUIRED" | "PENDING" | "ACTIVE";
  bio: string;
  headline: string;
  identificationDocumentUrl: string | null;
  introVideoUrl: string | null;
  avatarUrl: string | null;
  rejectionReason: string | null;
  revision: string;
  submittedAt: string | null;
  reviewedAt: string | null;
};
export type Workspace = {
  tutorId: string | null;
  published: boolean;
  activation: "NONE" | "PENDING" | "ACTIVE";
  currentSubmissionId: string | null;
  approvedSubmissionId?: string | null;
  drafts: Submission[];
  submissions: Submission[];
  revision: string;
};
export type Subject = {
  id: string;
  tutorId: string;
  tutorUserId: string;
  name: string;
  description: string;
  hourlyRate: string;
  format: "ONLINE";
  learningAreas: string[];
  revision: string;
};
export type Rating = {
  subjectId: string;
  average: number | null;
  reviewCount: number;
  distribution: Record<"1" | "2" | "3" | "4" | "5", number>;
};
export type SearchItem = {
  subject: Subject;
  tutorDisplayName: string;
  rating: Rating;
  nextAvailableAt: string | null;
  classesTaught: number;
};
export type PublicTutor = {
  id: string;
  userId: string;
  displayName: string;
  headline: string;
  bio: string;
  avatarUrl: string | null;
  introVideoUrl: string | null;
  verified: true;
  subjects: Subject[];
  recentReviews: import("../review/types").Review[];
};
export type Slot = {
  id: string;
  tutorId: string;
  subjectIds: string[];
  startsAt: string;
  endsAt: string;
  revision: string;
};
export type SubjectPageData = {
  tutor: PublicTutor;
  subject: Subject;
  rating: Rating;
  selectedDate: string;
  slots: Slot[];
  reviews: import("../review/types").Review[];
};
export type LearningAreas = { items: { id: string; label: string }[] };
export type Operation = {
  id: string;
  owner: string;
  status: "PENDING" | "SUCCEEDED" | "REJECTED";
  statusUrl: string;
  resource: { type: string; id: string; url: string } | null;
};
