// Interfaces for the peers Messaging calls over gRPC. Tests inject typed doubles; production uses grpc/clients.ts.

export interface CallContext {
  requestId: string;
}

export interface AccountSummary {
  id: string;
  displayName: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'DEACTIVATED';
  capabilities: Array<'STUDENT' | 'TUTOR' | 'ADMIN'>;
}

export interface TutorEligibility {
  userId: string;
  tutorId: string | null;
  approved: boolean;
  activated: boolean;
  published: boolean;
}

export interface AuthClient {
  lookupAccounts(userIds: string[], context: CallContext): Promise<AccountSummary[]>;
}

export interface TutorClient {
  getTutorEligibility(userId: string, context: CallContext): Promise<TutorEligibility>;
}

export interface Peers {
  auth: AuthClient;
  tutor: TutorClient;
}
