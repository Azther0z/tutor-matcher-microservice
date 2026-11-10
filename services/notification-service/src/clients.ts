// Peers Notification calls over gRPC. Tests inject typed doubles; production uses grpc/clients.ts.

export interface CallContext { requestId: string }

export interface ResetContentMeta {
  recipientUserId: string;
  expiresAt: string;
}

export interface AuthPeer {
  /** Current active admins. Resolved once per event; the snapshot is saved with the jobs. */
  listActiveAdmins(context: CallContext): Promise<string[]>;
  /**
   * Fetches recipient-bound sensitive reset content. Only the metadata crosses this boundary:
   * the body is never returned to callers, cached, logged or stored.
   * Throws PeerRejected('RESET_TOKEN_INVALID') for an expired or consumed token.
   */
  checkResetContent(contentRef: string, context: CallContext): Promise<ResetContentMeta>;
}

export interface ReminderQuery { bookingId: string; scheduleVersion: string; offsetMinutes: number }

export interface BookingPeer {
  getReminderEligibility(query: ReminderQuery, context: CallContext): Promise<{ eligible: boolean; reason: string | null }>;
}

export interface Peers { auth: AuthPeer; booking: BookingPeer }

/** The peer answered and refused (a business answer, not an outage). */
export class PeerRejected extends Error {
  constructor(readonly code: string, message = code) { super(message); }
}

/** The peer could not be reached or timed out. Work stays pending; this is never a terminal result. */
export class PeerUnavailable extends Error {}
