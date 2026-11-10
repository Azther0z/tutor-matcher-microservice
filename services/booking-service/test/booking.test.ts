import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Actor } from '../src/auth';
import type { Peers, SubjectSnapshot } from '../src/clients';
import { Contracts } from '../src/contracts';
import { newId } from '../src/ids';
import { inputHash, IdempotencyStore, type IdempotencyScope } from '../src/http/idempotency';
import { getAvailability, batchGetAvailability } from '../src/domain/slots';
import { createBooking, getBooking } from '../src/domain/bookings';
import type { Ctx } from '../src/domain/context';
import { bangkokInstant } from '../src/time';
import { DATABASE_TESTS_ENABLED, contractsDirectory, freshPool, resetData, T0 } from './helpers';

const describeDatabase = describe.skipIf(!DATABASE_TESTS_ENABLED);
interface BookingView {
  id: string;
  studentUserId: string;
  tutorId: string;
  tutorUserId: string;
  availabilityIds: string[];
  amount: { currency: string; amount: string };
  status: string;
  revision: string;
  description: string;
  holdExpiresAt: string;
}
let pool: Pool;
let contracts: Contracts;
let clock: { now: () => Date };

beforeAll(async () => {
  if (!DATABASE_TESTS_ENABLED) return;
  pool = await freshPool();
  contracts = new Contracts(contractsDirectory);
  clock = { now: () => new Date(T0) };
});
afterAll(async () => { if (pool) await pool.end(); });
beforeEach(async () => { if (pool) await resetData(pool); });

function actor(userId: string): Actor {
  return {
    userId, sessionId: newId(), admissionId: newId(), admittedAt: new Date(T0),
    requestId: newId(), publicOperation: 'booking.create', capabilities: ['STUDENT'], accountRevision: '0',
  };
}

function createContext(subject: SubjectSnapshot, studentId: string, tutorEmail = 'tutor@example.test'): Ctx {
  const peers: Peers = {
    tutor: {
      async getBookableSubject(subjectId) {
        if (subjectId !== subject.id) throw new Error(`Unexpected subject ${subjectId}`);
        return { subject, published: true, eligibilityCheckedAt: T0.toISOString() };
      },
      async getTutorEligibility(userId) {
        return { userId, tutorId: subject.tutorId, approved: true, activated: true, published: true, revision: '1' };
      },
    },
    auth: {
      async lookupAccounts(userIds) {
        return userIds.map((id) => ({
          id,
          displayName: id === studentId ? 'Test Student' : 'Test Tutor',
          email: id === studentId ? 'student@example.test' : tutorEmail,
          status: 'ACTIVE' as const,
          capabilities: id === studentId ? ['STUDENT' as const] : ['TUTOR' as const],
        }));
      },
    },
    wallet: {
      async applyLessonCharge() { throw new Error('Booking creation must not call Wallet'); },
      async getLessonCharge() { throw new Error('Booking creation must not call Wallet'); },
      async resolveOrCloseLessonCharge() { throw new Error('Booking creation must not call Wallet'); },
      async applyCancellationRefund() { throw new Error('Booking creation must not call Wallet'); },
      async getRefundOutcome() { throw new Error('Booking creation must not call Wallet'); },
      async recordLessonCompletion() { throw new Error('Booking creation must not call Wallet'); },
    },
  };
  return {
    pool, clock, peers, contracts, idem: new IdempotencyStore(pool), config: { demoMode: true },
  };
}

function idempotencyScope(userId: string, body: unknown, key = newId()): IdempotencyScope {
  return {
    actorUserId: userId, method: 'POST', route: 'POST /api/bookings', key,
    inputHash: inputHash(body), now: new Date(T0), requestId: newId(),
  };
}

async function seedSlot(input: {
  id?: string; tutorId: string; tutorUserId: string; subjectId: string; date: string; time: string;
  state?: 'OPEN' | 'CLOSED';
}): Promise<string> {
  const id = input.id ?? newId();
  const startsAt = bangkokInstant(input.date, input.time);
  const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
  const now = new Date(T0);
  await pool.query(`INSERT INTO availability_slots (id, tutor_id, tutor_user_id, starts_at, ends_at, state, revision, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $7)`, [id, input.tutorId, input.tutorUserId, startsAt, endsAt, input.state ?? 'OPEN', now]);
  await pool.query('INSERT INTO slot_subjects (slot_id, subject_id) VALUES ($1, $2)', [id, input.subjectId]);
  return id;
}

function subject(tutorId = newId(), tutorUserId = newId(), id = newId()): SubjectSnapshot {
  return { id, tutorId, tutorUserId, name: 'Algebra', description: 'Algebra lessons', hourlyRate: '400.00', format: 'ONLINE', revision: '3' };
}

describeDatabase('Booking service with isolated PostgreSQL', () => {
  it('returns only future open slots advertising the requested subject and preserves batch input order', async () => {
    const tutor = subject();
    const earlier = await seedSlot({ tutorId: tutor.tutorId, tutorUserId: tutor.tutorUserId, subjectId: tutor.id, date: '2026-11-15', time: '09:00' });
    const atNow = await seedSlot({ tutorId: tutor.tutorId, tutorUserId: tutor.tutorUserId, subjectId: tutor.id, date: '2026-11-15', time: '10:00' });
    const future = await seedSlot({ tutorId: tutor.tutorId, tutorUserId: tutor.tutorUserId, subjectId: tutor.id, date: '2026-11-15', time: '10:30' });
    await seedSlot({ tutorId: tutor.tutorId, tutorUserId: tutor.tutorUserId, subjectId: newId(), date: '2026-11-15', time: '11:00' });
    await seedSlot({ tutorId: tutor.tutorId, tutorUserId: tutor.tutorUserId, subjectId: tutor.id, date: '2026-11-15', time: '11:30', state: 'CLOSED' });
    clock = { now: () => new Date('2026-11-15T03:00:00.000Z') };
    const context = createContext(tutor, newId());
    const query = { tutorId: tutor.tutorId, subjectId: tutor.id, from: '2026-11-15T00:00:00.000Z', to: '2026-11-16T00:00:00.000Z' };

    const availability = await getAvailability(context, query);
    expect(availability.slots.map((slot) => slot.id)).toEqual([future]);
    expect(availability.slots[0].startsAt).toBe('2026-11-15T03:30:00.000Z');
    expect(availability.checkedAt).toBe(clock.now().toISOString());
    expect([earlier, atNow]).not.toContain(availability.slots[0].id);

    const batch = await batchGetAvailability(context, [query, { ...query, subjectId: newId() }]);
    expect(batch.results).toEqual([
      { queryIndex: 0, hasAvailability: true, nextAvailableAt: '2026-11-15T03:30:00.000Z', freeSlotCount: 1 },
      { queryIndex: 1, hasAvailability: false, nextAvailableAt: '', freeSlotCount: 0 },
    ]);
  });

  it('creates a held payment-due booking, replays it idempotently, and hides it from nonparticipants', async () => {
    clock = { now: () => new Date(T0) };
    const studentId = newId(); const tutor = subject();
    const firstSlot = await seedSlot({ tutorId: tutor.tutorId, tutorUserId: tutor.tutorUserId, subjectId: tutor.id, date: '2026-11-15', time: '10:00' });
    const secondSlot = await seedSlot({ tutorId: tutor.tutorId, tutorUserId: tutor.tutorUserId, subjectId: tutor.id, date: '2026-11-15', time: '10:30' });
    const context = createContext(tutor, studentId);
    const signedInStudent = actor(studentId);
    const body = { subjectId: tutor.id, availabilityIds: [firstSlot, secondSlot], description: 'Prepare for the exam' };
    const scope = idempotencyScope(studentId, body);
    const create = () => createBooking(context, signedInStudent, { body, scope, context: { requestId: scope.requestId } });

    const created = await create();
    expect(created.status).toBe(201);
    const booking = contracts.assertDef<BookingView>('Booking', created.body);
    expect(booking).toMatchObject({
      studentUserId: studentId, tutorId: tutor.tutorId, tutorUserId: tutor.tutorUserId,
      availabilityIds: [firstSlot, secondSlot], amount: { currency: 'THB', amount: '400.00' },
      status: 'PAYMENT_DUE', revision: '0', description: body.description,
    });
    expect(Date.parse(booking.holdExpiresAt)).toBe(T0.getTime() + 15 * 60_000);
    expect(created.headers).toMatchObject({ Location: `/api/bookings/${booking.id}`, ETag: '"0"' });

    const replay = await create();
    expect(replay).toMatchObject({ status: 201, body: { id: booking.id } });
    expect(replay.headers?.['Idempotent-Replay']).toBe('true');
    await expect(createBooking(context, signedInStudent, {
      body: { ...body, description: 'Changed input' }, scope: { ...scope, inputHash: inputHash({ ...body, description: 'Changed input' }) }, context: { requestId: scope.requestId },
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const slots = (await pool.query('SELECT id, state, booking_id FROM availability_slots WHERE id = ANY($1::uuid[]) ORDER BY starts_at', [[firstSlot, secondSlot]])).rows;
    expect(slots).toEqual([{ id: firstSlot, state: 'HELD', booking_id: booking.id }, { id: secondSlot, state: 'HELD', booking_id: booking.id }]);
    expect(Number((await pool.query('SELECT count(*) FROM bookings WHERE student_user_id = $1', [studentId])).rows[0].count)).toBe(1);
    const outsider = actor(newId());
    await expect(getBooking(context, outsider, booking.id)).rejects.toMatchObject({ code: 'NOT_FOUND', http: 404 });
  });

  it('serializes different students competing for the same slot so only one can hold it', async () => {
    clock = { now: () => new Date(T0) };
    const studentA = newId(); const studentB = newId(); const tutor = subject();
    const slotId = await seedSlot({ tutorId: tutor.tutorId, tutorUserId: tutor.tutorUserId, subjectId: tutor.id, date: '2026-11-15', time: '10:00' });
    const body = { subjectId: tutor.id, availabilityIds: [slotId] };
    const attempt = (userId: string) => {
      const scope = idempotencyScope(userId, body);
      const context = createContext(tutor, userId);
      return createBooking(context, actor(userId), { body, scope, context: { requestId: scope.requestId } });
    };

    const results = await Promise.all([attempt(studentA), attempt(studentB)]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.status === 409)?.body).toMatchObject({ code: 'SLOT_TAKEN' });
    expect(Number((await pool.query('SELECT count(*) FROM bookings')).rows[0].count)).toBe(1);
    expect((await pool.query("SELECT state FROM availability_slots WHERE id = $1", [slotId])).rows[0].state).toBe('HELD');
  });
});
