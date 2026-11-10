// Non-sensitive, human-readable summaries stored with the simulated receipt.
// They are built from the event body only; reset links, tokens and private message text never appear here.

const baht = (m: unknown) => {
  const money = m as { amount?: string } | undefined;
  return money?.amount ? `THB ${money.amount}` : 'an amount';
};

export function summarize(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case 'auth.password-reset-requested': return 'Password reset email (security message; content is not stored)';
    case 'auth.account-restricted': return `Your account was ${data.action === 'RESTORE' ? 'restored' : data.action === 'BAN' ? 'banned' : 'suspended'}`;
    case 'tutor.submission-submitted': return 'A tutor submission is waiting for review';
    case 'tutor.submission-withdrawn': return 'A tutor submission was withdrawn';
    case 'tutor.submission-decided': return data.decision === 'APPROVE' ? 'Your tutor application was approved; activation is pending until you are told it is active' : 'Your tutor application was not approved';
    case 'tutor.activated': return 'Your tutor access is now active';
    case 'booking.confirmed': return 'Your booking is confirmed';
    case 'booking.cancelled': return `A booking was cancelled; refund ${baht(data.refund)}`;
    case 'booking.completed': return 'Your lesson was marked complete';
    case 'booking.meeting-updated': return data.state === 'READY' ? 'Your meeting link is ready' : 'Your meeting link is missing';
    case 'booking.reminder-due': return `Lesson reminder: starts in ${data.offsetMinutes} minutes`;
    case 'wallet.topup-resolved': return data.status === 'SUCCEEDED' ? `Top-up of ${baht(data.amount)} succeeded` : `Top-up of ${baht(data.amount)} failed`;
    case 'wallet.refund-applied': return `A refund of ${baht(data.amount)} was added to your wallet`;
    case 'wallet.earning-cleared': return `An earning of ${baht(data.amount)} is now available`;
    case 'wallet.payout-resolved': return data.status === 'SUCCEEDED' ? `Payout of ${baht(data.amount)} succeeded` : `Payout of ${baht(data.amount)} failed and the funds were released`;
    case 'wallet.dispute-opened': return 'A payment dispute needs review';
    case 'wallet.dispute-held': return 'A payment dispute was opened; related earnings are held';
    case 'wallet.dispute-decided': return data.decision === 'REJECT' ? 'A payment dispute was rejected' : `A payment dispute was approved; refund ${baht(data.refund)}`;
    case 'review.flagged': return 'A review was flagged for moderation';
    case 'review.moderated': return `A review moderation decision was recorded: ${String(data.decision).toLowerCase()}`;
    case 'messaging.message-sent': return 'You have a new message';
    default: return 'Notification';
  }
}
