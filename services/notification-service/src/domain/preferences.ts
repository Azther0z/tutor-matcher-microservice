import { revisionMismatch } from '../errors';
import type { ClientSession } from 'mongodb';
import type { ChannelPrefs, Group, PreferenceDoc, Store } from '../store';

export const PREFERENCE_KEYS = ['bookingUpdates', 'lessonReminders', 'newMessages', 'walletPayments', 'productNews'] as const;
export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

/** Initial values from the interface guide: Email and Push on for four groups, off for product news. */
export function defaults(userId: string, now: Date): PreferenceDoc {
  const on: ChannelPrefs = { email: true, push: true };
  return {
    _id: userId, bookingUpdates: { ...on }, lessonReminders: { ...on }, newMessages: { ...on }, walletPayments: { ...on },
    productNews: { email: false, push: false }, revision: '0', createdAt: now, updatedAt: now,
  };
}

export const GROUP_KEY: Record<Exclude<Group, 'SYSTEM'>, PreferenceKey> = {
  BOOKING_UPDATES: 'bookingUpdates', LESSON_REMINDERS: 'lessonReminders', NEW_MESSAGES: 'newMessages', WALLET_PAYMENTS: 'walletPayments', PRODUCT_NEWS: 'productNews',
};

export function preferenceView(doc: PreferenceDoc) {
  return {
    bookingUpdates: { ...pick(doc.bookingUpdates) }, lessonReminders: { ...pick(doc.lessonReminders) }, newMessages: { ...pick(doc.newMessages) },
    walletPayments: { ...pick(doc.walletPayments) }, productNews: { ...pick(doc.productNews) }, revision: doc.revision,
  };
}
const pick = (p: ChannelPrefs) => ({ email: p.email, push: p.push });

/** Reads preferences, creating the defaults lazily at revision 0 (concurrent creators converge on one document). */
export async function loadPreferences(store: Store, userId: string, now: Date, session?: ClientSession): Promise<PreferenceDoc> {
  const found = await store.preferences.findOne({ _id: userId }, { session });
  if (found) return found;
  await store.preferences.updateOne({ _id: userId }, { $setOnInsert: defaults(userId, now) }, { upsert: true, session });
  return (await store.preferences.findOne({ _id: userId }, { session }))!;
}

export async function replacePreferences(
  store: Store, userId: string, ifMatch: string, next: Record<PreferenceKey, ChannelPrefs>, now: Date, session?: ClientSession,
): Promise<PreferenceDoc> {
  await loadPreferences(store, userId, now, session);
  // Compare-and-set on the revision: two editors cannot both win from the same starting point.
  const current = await store.preferences.findOne({ _id: userId }, { session });
  if (!current || current.revision !== ifMatch) throw revisionMismatch('REVISION_MISMATCH', 'Preferences changed; refresh before saving');
  const revision = (BigInt(current.revision) + 1n).toString();
  const updated = await store.preferences.findOneAndUpdate(
    { _id: userId, revision: current.revision },
    { $set: { ...next, revision, updatedAt: now } },
    { returnDocument: 'after', session },
  );
  if (!updated) throw revisionMismatch('REVISION_MISMATCH', 'Preferences changed; refresh before saving');
  return updated;
}

