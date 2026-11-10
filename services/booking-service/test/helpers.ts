import path from 'node:path';
import { Pool } from 'pg';
import { migrate } from '../src/db';

const configuredUrl = process.env.BOOKING_TEST_DATABASE_URL;
if (configuredUrl) {
  const url = new URL(configuredUrl);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !url.pathname.toLowerCase().includes('test')) {
    throw new Error('BOOKING_TEST_DATABASE_URL must identify an isolated loopback test database.');
  }
}

export const DATABASE_TESTS_ENABLED = Boolean(configuredUrl);
export const TEST_DATABASE_URL = configuredUrl;

export async function freshPool(): Promise<Pool> {
  if (!TEST_DATABASE_URL) throw new Error('Set BOOKING_TEST_DATABASE_URL to run Booking database tests.');
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 20 });
  await migrate(pool);
  return pool;
}

export async function resetData(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE outbox, idempotency_keys, reminders, completion_handoffs, refund_operations,
    cancellation_quotes, payment_attempts, booking_slots, bookings, booking_operations, slot_subjects,
    availability_slots RESTART IDENTITY CASCADE`);
}

export const contractsDirectory = path.resolve(__dirname, '../../../contracts');

export const T0 = new Date('2026-11-10T03:00:00.000Z');
