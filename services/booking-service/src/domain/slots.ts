import type { Actor } from '../auth';
import { PeerRefusal, type CallContext } from '../clients';
import type { Tx } from '../db';
import { conflict, forbidden, revisionMismatch, unprocessable, validation } from '../errors';
import type { IdempotencyScope } from '../http/idempotency';
import { derivedId } from '../ids';
import { bangkokDates, bangkokInstant, bangkokParts, HOUR_MS, iso, isBangkokDate, isBangkokTime, SLOT_MS } from '../time';
import type { Ctx } from './context';
import type { Reply } from './reply';

export interface SlotRow {
  id: string;
  tutor_id: string;
  tutor_user_id: string;
  starts_at: Date;
  ends_at: Date;
  state: 'OPEN' | 'CLOSED' | 'HELD' | 'BOOKED';
  booking_id: string | null;
  revision: string;
  subject_ids: string[] | null;
}

const SLOT_SELECT = `
  SELECT s.*, (SELECT array_agg(ss.subject_id::text ORDER BY ss.subject_id) FROM slot_subjects ss WHERE ss.slot_id = s.id) AS subject_ids
  FROM availability_slots s`;

export function ownedSlot(row: SlotRow) {
  const parts = bangkokParts(row.starts_at);
  return {
    id: row.id,
    tutorId: row.tutor_id,
    date: parts.date,
    time: parts.time,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    state: row.state,
    subjectIds: row.subject_ids ?? [],
    revision: String(row.revision),
  };
}

const invalid = (path: string, message: string) => validation([{ path, code: 'INVALID', message }]);

function dateRange(from: string, to: string): string[] {
  if (!isBangkokDate(from)) throw invalid('/query/from', 'from must be a YYYY-MM-DD date');
  if (!isBangkokDate(to)) throw invalid('/query/to', 'to must be a YYYY-MM-DD date');
  const dates = bangkokDates(from, to);
  if (dates.length === 0) throw invalid('/query/to', 'to must not be before from');
  if (dates.length > 93) throw invalid('/query/to', 'The range may cover at most 93 dates');
  return dates;
}

/** Per-day open and locked slot counts for the signed-in tutor's own calendar. */
export async function ownCalendar(ctx: Ctx, actor: Actor, from: string, to: string) {
  const dates = dateRange(from, to);
  const start = bangkokInstant(from, '00:00');
  const end = new Date(bangkokInstant(to, '00:00').getTime() + 24 * HOUR_MS);
  const { rows } = await ctx.pool.query<{ day: string; open: string; locked: string }>(
    `SELECT to_char(starts_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS day,
            count(*) FILTER (WHERE state = 'OPEN') AS open,
            count(*) FILTER (WHERE state IN ('HELD', 'BOOKED')) AS locked
     FROM availability_slots
     WHERE tutor_user_id = $1 AND starts_at >= $2 AND starts_at < $3
     GROUP BY 1`,
    [actor.userId, start, end],
  );
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return {
    from, to,
    days: dates.map((date) => ({ date, openSlots: Number(byDay.get(date)?.open ?? 0), lockedSlots: Number(byDay.get(date)?.locked ?? 0) })),
  };
}

export async function ownDay(ctx: Ctx, actor: Actor, date: string) {
  if (!isBangkokDate(date)) throw invalid('/path/date', 'date must be a YYYY-MM-DD date');
  const start = bangkokInstant(date, '00:00');
  const end = new Date(start.getTime() + 24 * HOUR_MS);
  const { rows } = await ctx.pool.query<SlotRow>(
    `${SLOT_SELECT} WHERE s.tutor_user_id = $1 AND s.starts_at >= $2 AND s.starts_at < $3 ORDER BY s.starts_at`,
    [actor.userId, start, end],
  );
  return { date, slots: rows.map(ownedSlot) };
}

export interface PutSlotInput {
  date: string;
  time: string;
  body: unknown;
  /** Revision from If-Match, when editing an existing slot. */
  ifMatch?: string;
  /** True for If-None-Match: * (create only). */
  ifNoneMatchStar: boolean;
  scope: IdempotencyScope;
  context: CallContext;
}

/**
 * Opens or closes one future half-hour slot. Held and booked slots are locked, stale revisions are rejected,
 * and every advertised subject must belong to the caller's own published catalogue (checked through Tutor, never locally).
 */
export async function putSlot(ctx: Ctx, actor: Actor, input: PutSlotInput): Promise<Reply> {
  if (!isBangkokDate(input.date)) throw invalid('/path/date', 'date must be a YYYY-MM-DD date');
  if (!isBangkokTime(input.time)) throw invalid('/path/time', 'time must be on a half-hour boundary, for example 09:30');
  const body = ctx.contracts.assertDef<{ state: 'OPEN' | 'CLOSED'; subjectIds?: string[] }>('SlotWrite', input.body, '/body');
  const startsAt = bangkokInstant(input.date, input.time);
  if (startsAt.getTime() <= ctx.clock.now().getTime()) throw unprocessable('SLOT_IN_PAST', 'Only future slots can be opened or closed');

  const replay = await ctx.idem.peek(input.scope);
  if (replay) return replay;

  // Peer checks happen before the transaction: Tutor owns the catalogue, Booking never holds a lock across a call.
  const eligibility = await ctx.peers.tutor.getTutorEligibility(actor.userId, input.context);
  if (!eligibility.tutorId || !eligibility.approved || !eligibility.activated) {
    throw forbidden('TUTOR_NOT_ACTIVE', 'Only an approved, active tutor can manage availability');
  }
  const tutorId = eligibility.tutorId;
  if (body.state === 'OPEN') {
    await Promise.all((body.subjectIds ?? []).map(async (subjectId) => {
      try {
        const bookable = await ctx.peers.tutor.getBookableSubject(subjectId, input.context);
        if (bookable.subject.tutorId !== tutorId) throw unprocessable('SUBJECT_NOT_OWNED', 'Every subject must be one of your published subjects');
      } catch (error) {
        if (error instanceof PeerRefusal) throw unprocessable('SUBJECT_NOT_OWNED', 'Every subject must be one of your published subjects');
        throw error;
      }
    }));
  }

  return ctx.idem.run({ ...input.scope, now: ctx.clock.now() }, async (tx) => {
    const now = ctx.clock.now();
    const { rows } = await tx.query<SlotRow>(
      'SELECT *, NULL::text[] AS subject_ids FROM availability_slots WHERE tutor_id = $1 AND starts_at = $2 FOR UPDATE',
      [tutorId, startsAt],
    );
    const existing = rows[0];
    let slotId: string;
    if (input.ifNoneMatchStar) {
      if (existing) throw revisionMismatch('REVISION_MISMATCH', 'This slot already exists; reload it and send its current revision');
      slotId = derivedId(`slot:${tutorId}:${iso(startsAt)}`);
      const inserted = await tx.query(
        `INSERT INTO availability_slots (id, tutor_id, tutor_user_id, starts_at, ends_at, state, revision, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $7) ON CONFLICT (tutor_id, starts_at) DO NOTHING RETURNING id`,
        [slotId, tutorId, actor.userId, startsAt, new Date(startsAt.getTime() + SLOT_MS), body.state, now],
      );
      if (!inserted.rowCount) throw revisionMismatch('REVISION_MISMATCH', 'This slot was created by another request');
    } else {
      if (!existing || String(existing.revision) !== input.ifMatch) throw revisionMismatch('REVISION_MISMATCH', 'This slot changed; reload it and try again');
      if (existing.state === 'HELD' || existing.state === 'BOOKED') throw conflict('SLOT_LOCKED', 'A held or booked slot cannot be changed');
      slotId = existing.id;
      await tx.query('UPDATE availability_slots SET state = $2, revision = revision + 1, updated_at = $3 WHERE id = $1', [slotId, body.state, now]);
    }
    await replaceSubjects(tx, slotId, body.state === 'OPEN' ? body.subjectIds ?? [] : []);
    const fresh = await tx.query<SlotRow>(`${SLOT_SELECT} WHERE s.id = $1`, [slotId]);
    const view = ownedSlot(fresh.rows[0]);
    return { status: 200, body: view, headers: { ETag: `"${view.revision}"` } };
  });
}

async function replaceSubjects(tx: Tx, slotId: string, subjectIds: string[]): Promise<void> {
  await tx.query('DELETE FROM slot_subjects WHERE slot_id = $1', [slotId]);
  if (subjectIds.length) {
    await tx.query('INSERT INTO slot_subjects (slot_id, subject_id) SELECT $1, unnest($2::uuid[])', [slotId, subjectIds]);
  }
}

export interface AvailabilityQuery {
  tutorId: string;
  subjectId: string;
  from: string;
  to: string;
}

function checkWindow(query: AvailabilityQuery): { from: Date; to: Date } {
  const from = new Date(query.from);
  const to = new Date(query.to);
  if (!(to.getTime() > from.getTime())) throw invalid('/query/to', 'to must be after from');
  if (to.getTime() - from.getTime() > 93 * 24 * HOUR_MS) throw invalid('/query/to', 'The window may cover at most 93 days');
  return { from, to };
}

/** Open, future, unheld slots that advertise the subject. An advisory snapshot: create-booking checks again. */
export async function getAvailability(ctx: Ctx, query: AvailabilityQuery) {
  const { from, to } = checkWindow(query);
  const now = ctx.clock.now();
  const { rows } = await ctx.pool.query<SlotRow>(
    `${SLOT_SELECT}
     WHERE s.tutor_id = $1 AND s.state = 'OPEN' AND s.starts_at >= $2 AND s.starts_at < $3 AND s.starts_at > $4
       AND EXISTS (SELECT 1 FROM slot_subjects x WHERE x.slot_id = s.id AND x.subject_id = $5)
     ORDER BY s.starts_at, s.id LIMIT 4464`,
    [query.tutorId, from, to, now, query.subjectId],
  );
  return {
    slots: rows.map((row) => ({
      id: row.id, tutorId: row.tutor_id, subjectIds: row.subject_ids ?? [], startsAt: iso(row.starts_at), endsAt: iso(row.ends_at), revision: String(row.revision),
    })),
    checkedAt: iso(now),
  };
}

/** One summary per query, in input order. Any store failure fails the whole call; it is never an empty success. */
export async function batchGetAvailability(ctx: Ctx, queries: AvailabilityQuery[]) {
  const now = ctx.clock.now();
  const windows = queries.map(checkWindow);
  const results = [];
  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index];
    const { rows } = await ctx.pool.query<{ next: Date | null; free: string }>(
      `SELECT min(s.starts_at) AS next, count(*) AS free
       FROM availability_slots s
       WHERE s.tutor_id = $1 AND s.state = 'OPEN' AND s.starts_at >= $2 AND s.starts_at < $3 AND s.starts_at > $4
         AND EXISTS (SELECT 1 FROM slot_subjects x WHERE x.slot_id = s.id AND x.subject_id = $5)`,
      [query.tutorId, windows[index].from, windows[index].to, now, query.subjectId],
    );
    const free = Math.min(Number(rows[0].free), 4464);
    results.push({
      queryIndex: index,
      hasAvailability: free > 0 && rows[0].next !== null,
      nextAvailableAt: free > 0 && rows[0].next ? iso(rows[0].next) : '',
      freeSlotCount: free,
    });
  }
  return { results, checkedAt: iso(now) };
}
