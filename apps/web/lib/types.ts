export type Capability = "STUDENT" | "TUTOR" | "ADMIN";
export type AccountStatus = "ACTIVE" | "SUSPENDED" | "BANNED" | "DEACTIVATED";

export type Account = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  capabilities: Capability[];
  status: AccountStatus;
  revision: string;
};

export type AuthSession = { user: Account; token: string; expiresAt: string };
export type PageMeta = { page: number; pageSize: number; totalItems: number; totalPages: number };
export type AccountPage = { items: Account[]; pagination: PageMeta };
export type AuditEntry = {
  id: string;
  actorUserId: string | null;
  action: string;
  reason: string | null;
  occurredAt: string;
};
export type AccountDetail = { user: Account; audit: AuditEntry[]; revision: string };
export type ApiFieldError = { path: string; code: string; message: string };
export type ApiErrorBody = {
  code: string;
  message: string;
  requestId?: string;
  retryable?: boolean;
  fields?: ApiFieldError[];
};
export type NotificationContent = {
  contentRef: string;
  recipientUserId: string;
  subject: string;
  text: string;
  sensitive: true;
  expiresAt: string;
};
export type StudentProfile = {
  userId: string;
  learningAreas: string[];
  level: string;
  goals: string;
  preferredPeriods: Array<"MORNING" | "AFTERNOON" | "EVENING">;
  revision: string;
};
