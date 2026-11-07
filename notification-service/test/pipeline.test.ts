import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Contracts } from '../src/contracts';
import { AudienceResolver } from '../src/domain/audience';
import { Dispatcher, SimulatedProvider } from '../src/domain/dispatcher';
import { EventAcceptor } from '../src/domain/events';
import { loadPreferences } from '../src/domain/preferences';
import { newId } from '../src/ids';
import type { Store } from '../src/store';
import { contractsDir, envelope, FakeClock, FakePeers, freshStore, inbound, resetStore, T0 } from './helpers';

let store: Store; let clock: FakeClock; let peers: FakePeers; let provider: SimulatedProvider;
let acceptor: EventAcceptor; let dispatcher: Dispatcher; let audience: AudienceResolver;
const contracts = new Contracts(contractsDir);
const IDENTITIES = { auth: 'auth', tutor: 'tutor', booking: 'booking', wallet: 'wallet', review: 'review', messaging: 'messaging' };

beforeAll(async () => { store = await freshStore(); });
afterAll(async () => { await store.client.close(); });
beforeEach(async () => {
  await resetStore(store);
  clock = new FakeClock(T0); peers = new FakePeers(); provider = new SimulatedProvider();
  acceptor = new EventAcceptor(store, contracts, clock, IDENTITIES);
  dispatcher = new Dispatcher(store, clock, peers, provider, { random: () => 1 });
  audience = new AudienceResolver(store, clock, peers, 30_000, () => 1);
});

const deliveries = (filter: Record<string, unknown> = {}) => store.deliveries.find(filter).sort({ channel: 1 }).toArray();

describe('durable acceptance', () => {
  it('saves the event and one job per recipient and channel before reporting success', async () => {
    const user = newId();
    const env = envelope('wallet.topup-resolved', [user]);
    expect(await acceptor.accept(inbound(env))).toEqual({ kind: 'ACCEPTED', eventId: env.eventId });
    expect(await store.events.countDocuments()).toBe(1);
    const jobs = await deliveries();
    expect(jobs.map((j) => j.channel)).toEqual(['EMAIL', 'PUSH']);
    expect(jobs.every((j) => j.status === 'PENDING' && j.recipientUserId === user)).toBe(true);
  });

  it('turns a redelivery after a consumer crash into a no-op: still one job per channel', async () => {
    const env = envelope('wallet.topup-resolved');
    await acceptor.accept(inbound(env));
    expect((await acceptor.accept(inbound(env))).kind).toBe('DUPLICATE');
    expect((await acceptor.accept(inbound(env))).kind).toBe('DUPLICATE');
    expect(await store.events.countDocuments()).toBe(1);
    expect(await store.deliveries.countDocuments()).toBe(2);
    await dispatcher.runOnce();
    await acceptor.accept(inbound(env));
    await dispatcher.runOnce();
    expect(provider.sent).toHaveLength(2);
  });

  it('accepts the same event concurrently exactly once', async () => {
    const env = envelope('wallet.topup-resolved');
    const results = await Promise.all(Array.from({ length: 6 }, () => acceptor.accept(inbound(env)).then((o) => o.kind, () => 'ERROR')));
    expect(results.filter((r) => r === 'ACCEPTED')).toHaveLength(1);
    expect(await store.events.countDocuments()).toBe(1);
    expect(await store.deliveries.countDocuments()).toBe(2);
  });

  it('rolls back the event when its jobs cannot be saved, so a broker ack can never precede durability', async () => {
    const user = newId();
    const env = envelope('wallet.topup-resolved', [user]);
    // Plant a conflicting job so the transaction's second write fails.
    const { deliveryFor } = await import('../src/domain/events');
    await store.deliveries.insertOne(deliveryFor({ _id: env.eventId, type: env.type, group: 'WALLET_PAYMENTS', envelope: env } as any, user, 'PUSH', T0));
    await expect(acceptor.accept(inbound(env))).rejects.toThrow();
    expect(await store.events.countDocuments()).toBe(0);
    expect(await store.deliveries.countDocuments()).toBe(1);
  });

  it('quarantines a different payload under an existing event ID and keeps the original', async () => {
    const env = envelope('wallet.topup-resolved');
    await acceptor.accept(inbound(env));
    const forged = { ...env, data: { ...env.data, amount: { currency: 'THB', amount: '9999.00' } } };
    const outcome = await acceptor.accept(inbound(forged));
    expect(outcome).toMatchObject({ kind: 'QUARANTINED', quarantine: 'CONFLICT' });
    expect((await store.events.findOne({ _id: env.eventId }))!.envelope).toEqual(env);
    expect(await store.deliveries.countDocuments()).toBe(2);
    expect(await store.quarantine.countDocuments({ kind: 'CONFLICT', status: 'OPEN' })).toBe(1);
  });

  it('dead-letters invalid payloads and stores no event body', async () => {
    const env = envelope('wallet.topup-resolved');
    const bad = { ...env, data: { ...env.data, status: 'MAYBE' } };
    const outcome = await acceptor.accept(inbound(bad));
    expect(outcome).toMatchObject({ kind: 'QUARANTINED', quarantine: 'INVALID', deadLetter: true });
    const notJson = await acceptor.accept({ body: Buffer.from('not json'), routingKey: 'v1.x', userId: 'wallet', messageId: undefined, type: undefined });
    expect(notJson).toMatchObject({ kind: 'QUARANTINED', deadLetter: true });
    const unknownVersion = await acceptor.accept(inbound({ ...env, schemaVersion: 2 }));
    expect(unknownVersion).toMatchObject({ kind: 'QUARANTINED', quarantine: 'INVALID' });
    expect(await store.events.countDocuments()).toBe(0);
    const stored = JSON.stringify(await store.quarantine.find().toArray());
    expect(stored).not.toContain('MAYBE');
  });

  it('rejects a publisher that is not the envelope producer, has no identity, or uses a foreign prefix', async () => {
    const env = envelope('wallet.topup-resolved');
    expect(await acceptor.accept(inbound(env, { userId: 'booking' }))).toMatchObject({ quarantine: 'IDENTITY' });
    expect(await acceptor.accept(inbound(env, { userId: undefined }))).toMatchObject({ quarantine: 'IDENTITY' });
    expect(await acceptor.accept(inbound(env, { userId: 'guest' }))).toMatchObject({ quarantine: 'IDENTITY' });
    // A wallet-authenticated publisher claiming to be booking.
    const spoof = envelope('booking.confirmed');
    expect(await acceptor.accept(inbound(spoof, { userId: 'wallet' }))).toMatchObject({ quarantine: 'IDENTITY' });
    expect(await store.events.countDocuments()).toBe(0);
  });

  it('requires the routing key to equal v1.<type> and message_id to equal eventId', async () => {
    const env = envelope('wallet.topup-resolved');
    expect(await acceptor.accept(inbound(env, { routingKey: 'v1.wallet.refund-applied' }))).toMatchObject({ quarantine: 'ROUTING' });
    expect(await acceptor.accept(inbound(env, { messageId: newId() }))).toMatchObject({ quarantine: 'ROUTING' });
  });
});

describe('preferences at dispatch', () => {
  it('delivers Email and Push for a group that defaults to on', async () => {
    const user = newId();
    await acceptor.accept(inbound(envelope('wallet.topup-resolved', [user])));
    expect(await dispatcher.runOnce()).toMatchObject({ delivered: 2, skipped: 0 });
    expect((await deliveries()).every((d) => d.status === 'DELIVERED' && d.deliveredAt && d.preferencesRevision === '0')).toBe(true);
  });

  it('reads preferences when sending, not when the event arrived', async () => {
    const user = newId();
    await acceptor.accept(inbound(envelope('wallet.topup-resolved', [user])));
    await loadPreferences(store, user, T0);
    await store.preferences.updateOne({ _id: user }, { $set: { 'walletPayments.push': false, revision: '1' } });
    await dispatcher.runOnce();
    const [email, push] = await deliveries();
    expect([email.status, push.status, push.reason, push.preferencesRevision]).toEqual(['DELIVERED', 'SKIPPED', 'PREFERENCE_DISABLED', '1']);
  });

  it('keeps product news off by default and never reopens a skipped receipt after a later opt-in', async () => {
    const user = newId();
    const env = envelope('wallet.topup-resolved', [user]);
    await loadPreferences(store, user, T0);
    await store.preferences.updateOne({ _id: user }, { $set: { walletPayments: { email: false, push: false } } });
    await acceptor.accept(inbound(env));
    await dispatcher.runOnce();
    expect((await deliveries()).map((d) => d.status)).toEqual(['SKIPPED', 'SKIPPED']);
    await store.preferences.updateOne({ _id: user }, { $set: { walletPayments: { email: true, push: true } } });
    clock.advance(3_600_000);
    expect(await dispatcher.runOnce()).toEqual({ delivered: 0, skipped: 0, failed: 0, deferred: 0 });
    expect(provider.sent).toHaveLength(0);
    expect((await loadPreferences(store, newId(), T0)).productNews).toEqual({ email: false, push: false });
  });

  it('always sends SYSTEM email, once, regardless of every preference toggle', async () => {
    const user = newId();
    await loadPreferences(store, user, T0);
    const off = { email: false, push: false };
    await store.preferences.updateOne({ _id: user }, { $set: { bookingUpdates: off, lessonReminders: off, newMessages: off, walletPayments: off, productNews: off } });
    const env = envelope('auth.password-reset-requested', [user]);
    env.data.contentRef = newId();
    peers.reset.set(env.data.contentRef, { recipientUserId: user, expiresAt: '2026-11-10T04:00:00.000Z' });
    await acceptor.accept(inbound(env));
    const jobs = await deliveries();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].channel).toBe('EMAIL');
    expect(await dispatcher.runOnce()).toMatchObject({ delivered: 1 });
    expect((await deliveries())[0]).toMatchObject({ status: 'DELIVERED', category: 'SYSTEM', preferencesRevision: null });
  });
});

describe('failures, retries and leases', () => {
  it('retains a failed job for retry, rechecks preferences first, and never resends a delivered receipt', async () => {
    const user = newId();
    await acceptor.accept(inbound(envelope('wallet.topup-resolved', [user])));
    provider.failures = 2; // both channels fail once
    expect(await dispatcher.runOnce()).toMatchObject({ failed: 2, delivered: 0 });
    expect((await deliveries()).map((d) => [d.status, d.attempts])).toEqual([['FAILED', 1], ['FAILED', 1]]);
    // The user opts out of Push before the retry.
    await loadPreferences(store, user, T0);
    await store.preferences.updateOne({ _id: user }, { $set: { 'walletPayments.push': false } });
    expect(await dispatcher.runOnce()).toMatchObject({ delivered: 0 }); // not due yet: no hot loop
    clock.advance(2000);
    expect(await dispatcher.runOnce()).toMatchObject({ delivered: 1, skipped: 1 });
    const [email, push] = await deliveries();
    expect([email.status, push.status, push.reason]).toEqual(['DELIVERED', 'SKIPPED', 'PREFERENCE_DISABLED']);
    clock.advance(3_600_000);
    await dispatcher.runOnce();
    expect(provider.sent).toHaveLength(1);
  });

  it('flags NEEDS_ATTENTION after ten failures but keeps it retryable', async () => {
    await acceptor.accept(inbound(envelope('booking.confirmed')));
    provider.failures = 10_000;
    for (let i = 0; i < 10; i += 1) { clock.advance(61_000); await dispatcher.runOnce(); }
    const job = (await deliveries())[0];
    expect(job).toMatchObject({ status: 'FAILED', attempts: 10, needsAttention: true });
    provider.failures = 0; clock.advance(61_000);
    expect((await dispatcher.runOnce()).delivered).toBeGreaterThan(0);
  });

  it('lets a second worker take over an expired lease; the stale worker cannot overwrite the result', async () => {
    const user = newId();
    await acceptor.accept(inbound(envelope('booking.confirmed', [user])));
    await store.deliveries.deleteOne({ channel: 'PUSH' });

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slowProvider = { sent: 0, async send() { this.sent += 1; await gate; } };
    const slow = new Dispatcher(store, clock, peers, slowProvider, { leaseMs: 1000 });
    const slowRun = slow.runOnce();
    await new Promise((r) => setTimeout(r, 100));
    expect((await deliveries())[0].leaseUntil).not.toBeNull();

    // While the lease is live a second worker finds nothing to claim.
    expect(await dispatcher.runOnce()).toEqual({ delivered: 0, skipped: 0, failed: 0, deferred: 0 });
    clock.advance(1500); // the lease expires
    expect(await dispatcher.runOnce()).toMatchObject({ delivered: 1 });
    const winner = (await deliveries())[0];
    release();
    await slowRun;
    const after = await deliveries();
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe('DELIVERED');
    expect(after[0].deliveredAt).toEqual(winner.deliveredAt);
    expect(after[0].fence).toBe(2);
  });
});

describe('reminders and reset content', () => {
  const reminderFor = async (user: string) => { const env = envelope('booking.reminder-due', [user]); await acceptor.accept(inbound(env)); return env; };

  it('checks Booking immediately before sending and suppresses a stale reminder', async () => {
    const user = newId(); await reminderFor(user);
    peers.eligible = false;
    expect(await dispatcher.runOnce()).toMatchObject({ skipped: 2 });
    expect((await deliveries()).every((d) => d.status === 'SKIPPED' && d.reason === 'REMINDER_SUPPRESSED')).toBe(true);
    expect(peers.reminderCalls[0]).toMatchObject({ scheduleVersion: '2', offsetMinutes: 60 });
    expect(provider.sent).toHaveLength(0);
  });

  it('leaves the reminder pending when Booking is down, then sends once it recovers', async () => {
    const user = newId(); await reminderFor(user);
    peers.bookingDown = true;
    expect(await dispatcher.runOnce()).toMatchObject({ deferred: 2, delivered: 0, skipped: 0 });
    expect((await deliveries()).map((d) => d.status)).toEqual(['PENDING', 'PENDING']);
    peers.bookingDown = false; clock.advance(5000);
    expect(await dispatcher.runOnce()).toMatchObject({ delivered: 2 });
  });

  it('keeps a reminder pending, and the sweep alive, when Booking refuses the check', async () => {
    const user = newId(); await reminderFor(user);
    await acceptor.accept(inbound(envelope('booking.confirmed', [user])));
    peers.bookingRefuses = true;
    const sweep = await dispatcher.runOnce();
    expect(sweep).toMatchObject({ deferred: 2, delivered: 2 }); // the unrelated confirmation still went out
    expect((await deliveries({ eventType: 'booking.reminder-due' })).map((d) => d.status)).toEqual(['PENDING', 'PENDING']);
    expect(provider.sent).toHaveLength(2);
  });

  it('skips an expired, consumed or foreign reset token and never stores reset material', async () => {
    const user = newId();
    const env = envelope('auth.password-reset-requested', [user]);
    await acceptor.accept(inbound(env));
    peers.reset.set(env.data.contentRef, 'INVALID');
    expect(await dispatcher.runOnce()).toMatchObject({ skipped: 1 });
    expect((await deliveries())[0]).toMatchObject({ status: 'SKIPPED', reason: 'EXPIRED' });

    const other = envelope('auth.password-reset-requested', [user]);
    await acceptor.accept(inbound(other));
    peers.reset.set(other.data.contentRef, { recipientUserId: newId(), expiresAt: '2026-11-11T00:00:00.000Z' });
    await dispatcher.runOnce();
    expect((await store.deliveries.findOne({ eventId: other.eventId }))!.status).toBe('SKIPPED');

    const good = envelope('auth.password-reset-requested', [user]);
    await acceptor.accept(inbound(good));
    peers.reset.set(good.data.contentRef, { recipientUserId: user, expiresAt: '2026-11-10T04:00:00.000Z' });
    clock.set('2026-11-10T04:00:01.000Z'); // past its expiry
    await dispatcher.runOnce();
    expect((await store.deliveries.findOne({ eventId: good.eventId }))!.status).toBe('SKIPPED');
    const everything = JSON.stringify([await store.deliveries.find().toArray(), await store.events.find().toArray(), await store.quarantine.find().toArray()]);
    expect(everything).not.toMatch(/token|secret|password reset link/i);
  });

  it('keeps a reset job pending while Auth is down', async () => {
    const user = newId();
    const env = envelope('auth.password-reset-requested', [user]);
    await acceptor.accept(inbound(env));
    peers.authDown = true;
    expect(await dispatcher.runOnce()).toMatchObject({ deferred: 1 });
    expect((await deliveries())[0].status).toBe('PENDING');
    peers.authDown = false; peers.reset.set(env.data.contentRef, { recipientUserId: user, expiresAt: '2026-11-10T04:00:00.000Z' });
    clock.advance(5000);
    expect(await dispatcher.runOnce()).toMatchObject({ delivered: 1 });
  });
});

describe('admin audience', () => {
  it('stays pending while Auth is down, then resolves once and keeps the snapshot for retries', async () => {
    const [a1, a2] = [newId(), newId()];
    const env = envelope('tutor.submission-submitted');
    await acceptor.accept(inbound(env));
    expect(await store.deliveries.countDocuments()).toBe(0);
    peers.authDown = true;
    expect(await audience.runOnce()).toEqual({ resolved: 0, deferred: 1 });
    expect((await store.events.findOne({ _id: env.eventId }))!.audienceStatus).toBe('PENDING');

    peers.authDown = false; peers.admins = [a1, a2]; clock.advance(5000);
    expect(await audience.runOnce()).toEqual({ resolved: 1, deferred: 0 });
    expect((await store.events.findOne({ _id: env.eventId }))!.recipients).toEqual([a1, a2]);
    expect((await deliveries()).map((d) => d.recipientUserId).sort()).toEqual([a1, a2].sort());

    // Admin membership changes later; the saved snapshot does not.
    peers.admins = [newId()]; clock.advance(5000);
    expect(await audience.runOnce()).toEqual({ resolved: 0, deferred: 0 });
    provider.failures = 1;
    await dispatcher.runOnce();
    clock.advance(5000); await dispatcher.runOnce();
    expect(await store.deliveries.countDocuments()).toBe(2);
  });

  it('resolves under concurrent resolvers without duplicating jobs', async () => {
    peers.admins = [newId(), newId(), newId()];
    await acceptor.accept(inbound(envelope('wallet.dispute-opened')));
    const other = new AudienceResolver(store, clock, peers);
    await Promise.all([audience.runOnce(), other.runOnce(), audience.runOnce()]);
    expect(await store.deliveries.countDocuments()).toBe(3);
  });
});

