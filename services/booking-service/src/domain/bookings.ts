import type { Actor } from '../auth';
import { PeerRefusal, type CallContext } from '../clients';
import { conflict, forbidden, unavailable, unprocessable, validation } from '../errors';
import type { IdempotencyScope } from '../http/idempotency';
import { newId } from '../ids';
import { mulDivHalfUp, parseAmount } from '../money';
import { bangkokParts, HOLD_MS, SLOT_MS } from '../time';
import type { Ctx } from './context';
import { BOOKING_SELECT, bookingView, loadBooking, requireParticipant, type BookingRow } from './model';
import { pageMeta, type Page, type Reply } from './reply';

const STATUSES = ['PAYMENT_DUE', 'CONFIRMED', 'COMPLETED', 'CANCELLED'] as const;
export type StatusFilter = (typeof STATUSES)[number];

interface SlotCheckRow {
  id: string;
  tutor_id: string;
  starts_at: Date;
  ends_at: Date;
  state: string;
  advertises: boolean;
}

export interface CreateBookingInput {
  body: unknown;
  scope: IdempotencyScope;
  context: CallContext;
}

/**
 * Holds 1-8 consecutive half-hour slots and creates the PAYMENT_DUE booking in one local transaction.
 * Subject, rate and display names are captured once from Tutor and Auth; Wallet is not involved until payment.
 */
export async function createBooking(ctx: Ctx, actor: Actor, input: CreateBookingInput): Promise<Reply> {
  const body = ctx.contracts.assertDef<{ subjectId: string; availabilityIds: string[]; description?: string }>('BookingCreate', input.body, '/body');
  const replay = await ctx.idem.peek(input.scope);
  if (replay) return replay;

  let subject;
  try {
    subject = (await ctx.peers.tutor.getBookableSubject(body.subjectId, input.context)).subject;
  } catch (error) {
    if (error instanceof PeerRefusal) throw conflict('SUBJECT_NOT_BOOKABLE', 'This subject is not available for booking');
    throw error;
  }
  if (subject.tutorUserId === actor.userId) throw unprocessable('SELF_BOOKING', 'You cannot book your own subject');

  const accounts = await ctx.peers.auth.lookupAccounts([actor.userId, subject.tutorUserId], input.context);
  const student = accounts.find((a) => a.id === actor.userId);
  const tutor = accounts.find((a) => a.id === subject.tutorUserId);
  if (!student || !tutor) throw unavailable('DEPENDENCY_UNAVAILABLE', 'Participant details could not be confirmed');
  if (student.status !== 'ACTIVE') throw forbidden('ACCOUNT_NOT_ACTIVE', 'This account cannot make bookings');

  const rate = parseAmount(subject.hourlyRate);
  const slotIds = body.availabilityIds;
  return ctx.idem.run({ ...input.scope, now: ctx.clock.now() }, async (tx) => {
    const now = ctx.clock.now();
    // Fixed lock order: slots by start time, then the new booking row.
    const found = await tx.query<SlotCheckRow>(
      `SELECT s.id, s.tutor_id, s.starts_at, s.ends_at, s.state,
              EXISTS (SELECT 1 FROM slot_subjects x WHERE x.slot_id = s.id AND x.subject_id = $2) AS advertises
       FROM availability_slots s WHERE s.id = ANY($1::uuid[]) ORDER BY s.starts_at FOR UPDATE`,
      [slotIds, subject.id],
    );
    const slots = found.rows;
    const block = (message: string) => unprocessable('INVALID_SLOT_BLOCK', message);
    if (slots.length !== slotIds.length) throw block('One or more selected times do not exist');
    if (slots.some((s) => s.tutor_id !== subject.tutorId)) throw block('All selected times must belong to this tutor');
    if (slots.some((s) => !s.advertises)) throw block('All selected times must offer this subject');
    for (let i = 1; i < slots.length; i += 1) {
      if (slots[i].starts_at.getTime() !== slots[i - 1].ends_at.getTime()) throw block('Selected times must be consecutive half-hour slots');
    }
    if (bangkokParts(slots[0].starts_at).date !== bangkokParts(new Date(slots[slots.length - 1].ends_at.getTime() - 1)).date) {
      throw block('Selected times must fall on one Bangkok day');
    }
    if (slots.some((s) => s.starts_at.getTime() <= now.getTime())) throw unprocessable('SLOT_IN_PAST', 'Selected times must be in the future');
    if (slots.some((s) => s.state !== 'OPEN')) throw conflict('SLOT_TAKEN', 'One or more selected times were just taken');

    const startsAt = slots[0].starts_at;
    const endsAt = slots[slots.length - 1].ends_at;
    const holdExpiresAt = new Date(Math.min(now.getTime() + HOLD_MS, startsAt.getTime()));
    const amount = mulDivHalfUp(rate, BigInt(slots.length), 2n);
    const bookingId = newId();
    await tx.query(
      `INSERT INTO bookings (
         id, student_user_id, tutor_id, tutor_user_id, student_display_name, tutor_display_name,
         subject_id, subject_name, subject_description, subject_rate_satang, subject_revision,
         description, starts_at, ends_at, slot_count, amount_satang, status, revision, hold_expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'PAYMENT_DUE',0,$17,$18,$18)`,
      [bookingId, actor.userId, subject.tutorId, subject.tutorUserId, student.displayName.slice(0, 201), tutor.displayName.slice(0, 201),
        subject.id, subject.name, subject.description, rate.toString(), subject.revision,
        body.description ?? '', startsAt, endsAt, slots.length, amount.toString(), holdExpiresAt, now],
    );
    await tx.query(
      'INSERT INTO booking_slots (booking_id, slot_id, position) SELECT $1, s.id, s.ord - 1 FROM unnest($2::uuid[]) WITH ORDINALITY AS s(id, ord)',
      [bookingId, slots.map((s) => s.id)],
    );
    const held = await tx.query(
      "UPDATE availability_slots SET state = 'HELD', booking_id = $1, revision = revision + 1, updated_at = $3 WHERE id = ANY($2::uuid[]) AND state = 'OPEN'",
      [bookingId, slots.map((s) => s.id), now],
    );
    if (held.rowCount !== slots.length) throw conflict('SLOT_TAKEN', 'One or more selected times were just taken');

    const row = (await loadBooking(tx, bookingId)) as BookingRow;
    const view = bookingView(row, actor.userId, now);
    return { status: 201, body: view, headers: { Location: `/api/bookings/${bookingId}`, ETag: `"${view.revision}"` } };
  });
}

async function pageOf(ctx: Ctx, actor: Actor, where: string, params: unknown[], order: string, page: Page) {
  const now = ctx.clock.now();
  const total = await ctx.pool.query<{ count: string }>(`SELECT count(*) FROM bookings b WHERE ${where}`, params);
  const { rows } = await ctx.pool.query<BookingRow>(
    `${BOOKING_SELECT} WHERE ${where} ORDER BY ${order} LIMIT ${page.pageSize} OFFSET ${page.offset}`,
    params,
  );
  return { items: rows.map((row) => bookingView(row, actor.userId, now)), pagination: pageMeta(page, Number(total.rows[0].count)) };
}

export interface ListInput {
  page: Page;
  view: 'STUDENT' | 'TUTOR';
  status?: string;
}

/** History list (newest first). The view parameter chooses the context; TUTOR needs the TUTOR capability at the route. */
export function listBookings(ctx: Ctx, actor: Actor, input: ListInput) {
  const params: unknown[] = [actor.userId];
  let where = input.view === 'TUTOR' ? 'b.tutor_user_id = $1' : 'b.student_user_id = $1';
  if (input.status !== undefined) {
    if (!(STATUSES as readonly string[]).includes(input.status)) {
      throw validation([{ path: '/query/status', code: 'INVALID', message: `status must be one of ${STATUSES.join(', ')}` }]);
    }
    params.push(input.status);
    where += ` AND b.status = $${params.length}`;
  }
  return pageOf(ctx, actor, where, params, 'b.created_at DESC, b.id DESC', input.page);
}

/** CONFIRMED lessons that have not started, soonest first. Awaiting-payment holds are not upcoming lessons. */
export function tutorUpcoming(ctx: Ctx, actor: Actor, page: Page) {
  return pageOf(ctx, actor, "b.tutor_user_id = $1 AND b.status = 'CONFIRMED' AND b.starts_at > $2", [actor.userId, ctx.clock.now()], 'b.starts_at, b.id', page);
}

/** Lessons whose scheduled end has passed and that the assigned tutor has not confirmed, oldest first. */
export function tutorNeedsConfirmation(ctx: Ctx, actor: Actor, page: Page) {
  return pageOf(ctx, actor, "b.tutor_user_id = $1 AND b.status = 'CONFIRMED' AND b.ends_at <= $2", [actor.userId, ctx.clock.now()], 'b.ends_at, b.id', page);
}

export async function getBooking(ctx: Ctx, actor: Actor, bookingId: string) {
  const row = requireParticipant(await loadBooking(ctx.pool, bookingId), actor);
  return bookingView(row, actor.userId, ctx.clock.now());
}

export const SLOT_DURATION_MS = SLOT_MS;
