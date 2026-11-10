export type Review = {
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
};
export type ReviewFlag = {
  id: string;
  reviewId: string;
  reporterUserId: string;
  reason: string;
  state: "OPEN" | "RESOLVED";
  revision: string;
  createdAt: string;
};
export type AdminFlag = {
  flag: ReviewFlag;
  review: Review;
  reporterDisplayName: string;
};
