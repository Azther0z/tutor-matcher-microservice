import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Contracts } from '../src/contracts';
import { Dispatcher, SimulatedProvider } from '../src/domain/dispatcher';
import { EventAcceptor } from '../src/domain/events';
import { newId } from '../src/ids';
import type { Store } from '../src/store';
import { contractsDir, envelope, FakeClock, FakePeers, freshStore, inbound, resetStore, startHttp, T0, type Harness } from './helpers';

let store: Store; let clock: FakeClock; let h: Harness;
const contracts = new Contracts(contractsDir);

beforeAll(async () => { store = await freshStore(); clock = new FakeClock(T0); h = await startHttp(store, clock); });
afterAll(async () => { await h.close(); await store.client.close(); });
beforeEach(async () => { await resetStore(store); clock.set(T0); });

const key = () => ({ 'idempotency-key': newId() });
const put = (user: string, body: unknown, headers: Record<string, string>) => h.call('PUT', '/api/notifications/preferences', { token: h.token(user), headers, body });
const allOn = { bookingUpdates: { email: true, push: true }, lessonReminders: { email: true, push: true }, newMessages: { email: true, push: true }, walletPayments: { email: true, push: true }, productNews: { email: true, push: false } };

describe('authentication', () => {
  it('requires a workload credential and a signed actor, and the Student capability', async () => {
    const user = newId();
    expect((await h.call('GET', '/api/notifications', { token: h.token(user), credential: null })).status).toBe(401);
    expect((await h.call('GET', '/api/notifications', { token: h.token(user), credential: 'nope-nope-nope-nope' })).status).toBe(401);
    expect((await h.call('GET', '/api/notifications')).status).toBe(401);
    expect((await h.call('GET', '/api/notifications', { headers: { 'x-user-id': user } })).status).toBe(401);
    expect((await h.call('GET', '/api/notifications', { token: h.token(user, []) })).status).toBe(403);
    expect((await h.call('GET', '/api/notifications', { token: h.token(user), headers: { 'x-request-id': 'bad' } })).status).toBe(400);
  });
});

describe('preferences', () => {
  it('creates defaults lazily at revision 0: four groups on, product news off, no sixth group', async () => {
    const user = newId();
    const res = await h.call('GET', '/api/notifications/preferences', { token: h.token(user) });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"0"');
    expect(res.body).toEqual({
      bookingUpdates: { email: true, push: true }, lessonReminders: { email: true, push: true }, newMessages: { email: true, push: true },
      walletPayments: { email: true, push: true }, productNews: { email: false, push: false }, revision: '0',
    });
    expect(contracts.isDef('Preferences', res.body)).toBe(true);
    expect(await store.preferences.countDocuments()).toBe(1);
    await h.call('GET', '/api/notifications/preferences', { token: h.token(user) });
    expect(await store.preferences.countDocuments()).toBe(1);
  });

  it('saves with the current revision, advances it, and rejects stale, missing and unknown input', async () => {
    const user = newId();
    await h.call('GET', '/api/notifications/preferences', { token: h.token(user) });
    expect((await put(user, allOn, key())).status).toBe(428);
    const saved = await put(user, allOn, { ...key(), 'if-match': '"0"' });
    expect(saved.status).toBe(200);
    expect(saved.body.revision).toBe('1');
    expect(saved.body.productNews).toEqual({ email: true, push: false });
    expect((await put(user, allOn, { ...key(), 'if-match': '"0"' })).status).toBe(412);
    expect((await put(user, { ...allOn, system: { email: false, push: false } }, { ...key(), 'if-match': '"1"' })).status).toBe(422); // SYSTEM is not configurable
    expect((await put(user, { ...allOn, productNews: { email: true } }, { ...key(), 'if-match': '"1"' })).status).toBe(422);
    expect((await put(user, allOn, { 'if-match': '"1"' })).status).toBe(400);
  });

  it('replays a lost success for the same key ahead of the stale precondition, and conflicts on different input', async () => {
    const user = newId(); const headers = { ...key(), 'if-match': '"0"' };
    const first = await put(user, allOn, headers);
    const again = await put(user, allOn, headers); // If-Match "0" is now stale, but the key replays the recorded success
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(again.headers.get('idempotent-replay')).toBe('true');
    expect((await put(user, { ...allOn, newMessages: { email: false, push: false } }, headers)).status).toBe(409);
    expect((await store.preferences.findOne({ _id: user }))!.revision).toBe('1');
  });

  it('lets exactly one of several concurrent first requests with one key take effect', async () => {
    const user = newId(); const headers = { ...key(), 'if-match': '"0"' };
    const results = await Promise.all(Array.from({ length: 5 }, () => put(user, allOn, headers)));
    expect(results.every((r) => r.status === 200 && r.body.revision === '1')).toBe(true);
    expect((await store.preferences.findOne({ _id: user }))!.revision).toBe('1');
  });

  it('keeps one user from reading or changing another user\'s preferences', async () => {
    const [a, b] = [newId(), newId()];
    await put(a, allOn, { ...key(), 'if-match': '"0"' });
    expect((await h.call('GET', '/api/notifications/preferences', { token: h.token(b) })).body.revision).toBe('0');
    expect((await h.call('GET', '/api/notifications/preferences', { token: h.token(b) })).body.productNews.email).toBe(false);
  });
});

describe('receipts', () => {
  it('lists only the caller\'s receipts, newest first, with inspectable status and no private body', async () => {
    const [a, b] = [newId(), newId()];
    const acceptor = new EventAcceptor(store, contracts, clock, { wallet: 'wallet', booking: 'booking' });
    const peers = new FakePeers(); const dispatcher = new Dispatcher(store, clock, peers, new SimulatedProvider());
    await acceptor.accept(inbound(envelope('wallet.topup-resolved', [a])));
    clock.advance(1000);
    await acceptor.accept(inbound(envelope('booking.confirmed', [a, b])));
    await h.call('GET', '/api/notifications/preferences', { token: h.token(a) });
    await store.preferences.updateOne({ _id: a }, { $set: { 'bookingUpdates.push': false } });
    await dispatcher.runOnce();

    const mine = await h.call('GET', '/api/notifications?pageSize=3', { token: h.token(a) });
    expect(mine.status).toBe(200);
    expect(mine.body.pagination).toEqual({ page: 1, pageSize: 3, totalItems: 4, totalPages: 2 });
    expect(mine.body.items.every((r: any) => r.recipientUserId === a && r.demo === true)).toBe(true);
    expect(mine.body.items[0].eventType).toBe('booking.confirmed');
    expect(contracts.isDef('ReceiptPage', mine.body)).toBe(true);
    const skipped = (await h.call('GET', '/api/notifications', { token: h.token(a) })).body.items.find((r: any) => r.status === 'SKIPPED');
    expect(skipped.skipReason).toBe('PREFERENCE_DISABLED');
    expect(skipped.deliveredAt).toBeNull();
    expect((await h.call('GET', '/api/notifications', { token: h.token(b) })).body.pagination.totalItems).toBe(2);
    expect((await h.call('GET', '/api/notifications', { token: h.token(newId()) })).body).toEqual({ items: [], pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } });
    expect((await h.call('GET', '/api/notifications?pageSize=500', { token: h.token(a) })).status).toBe(422);
    expect((await h.call('GET', '/api/notifications?x=1', { token: h.token(a) })).status).toBe(400);
  });

  it('exposes the owner operation only to its initiator or an admin', async () => {
    const user = newId();
    await h.call('GET', '/api/notifications/preferences', { token: h.token(user) });
    await put(user, allOn, { ...key(), 'if-match': '"0"' });
    const op = await store.operations.findOne({ initiatorUserId: user });
    expect((await h.call('GET', `/internal/v1/notification/operations/${op!._id}`, { token: h.token(user) })).body.status).toBe('SUCCEEDED');
    expect((await h.call('GET', `/internal/v1/notification/operations/${op!._id}`, { token: h.token(newId()) })).status).toBe(404);
    expect((await h.call('GET', `/internal/v1/notification/operations/${op!._id}`, { token: h.token(newId(), ['STUDENT', 'ADMIN']) })).status).toBe(200);
  });
});
