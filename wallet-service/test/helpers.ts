import { Pool } from 'pg';
import { migrate } from '../src/db';
import { newId } from '../src/ids';
import type { Actor, Admission } from '../src/auth';
import type { Clock } from '../src/time';
import type { PaymentCommand } from '../src/domain/financial';
import { money } from '../src/money';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://tutor@127.0.0.1:55433/wallet_test';

export async function freshPool(): Promise<Pool> {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 20 });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  return pool;
}

export async function resetData(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE outbox, idempotency_keys, dispute_audit, disputes, payouts, payout_accounts, topups, wallet_operations,
    refund_operations, payment_operations, financial_records, ledger_entries, wallets RESTART IDENTITY CASCADE`);
}

export class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date { return new Date(this.current); }
  set(date: Date | string): void { this.current = new Date(date); }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
}

export const T0 = new Date('2026-11-10T03:00:00.000Z');
export const HOUR = 3_600_000;

export function actor(userId: string, capabilities: Actor['capabilities'] = ['STUDENT'], admittedAt: Date = T0): Actor {
  return {
    userId, sessionId: newId(), admissionId: newId(), admittedAt, requestId: newId(),
    publicOperation: 'test', capabilities, accountRevision: '0',
  };
}

export function admission(userId: string, admittedAt: Date = T0): Admission {
  return { id: newId(), actorUserId: userId, sessionId: newId(), admittedAt: admittedAt.toISOString(), requestId: newId(), publicOperation: 'test' };
}

export interface Fixture {
  bookingId: string; student: string; tutor: string;
  command(amount: string, overrides?: Partial<PaymentCommand>): PaymentCommand;
}

/** A lesson 3 days after T0 with a hold that expires 15 minutes after T0. */
export function fixture(): Fixture {
  const bookingId = newId(); const student = newId(); const tutor = newId();
  const startsAt = new Date(T0.getTime() + 72 * HOUR);
  return {
    bookingId, student, tutor,
    command: (amount, overrides = {}) => ({
      bookingId, sourceOperationId: newId(), studentUserId: student, tutorUserId: tutor, subjectId: newId(), amount: money(BigInt(Math.round(Number(amount) * 100))),
      startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + HOUR).toISOString(),
      holdExpiresAt: new Date(T0.getTime() + 15 * 60_000).toISOString(), admission: admission(student), ...overrides,
    }),
  };
}

export async function fund(pool: Pool, userId: string, satang: bigint): Promise<void> {
  await pool.query('INSERT INTO wallets (user_id, posted_satang) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET posted_satang = EXCLUDED.posted_satang', [userId, satang]);
}
