import 'dotenv/config';
import { createPool, migrate } from './db';
import { derivedId } from './ids';
import { bangkokInstant, bangkokParts, HOUR_MS, iso, SLOT_MS, systemClock } from './time';

interface SeedTutor {
  userId: string;
  tutorId: string;
  subjectId: string;
}

/** A finished lesson between the demo student and the first demo tutor, so the student has history to review. */
interface SeedFixture {
  studentUserId: string;
  studentName: string;
  tutorName: string;
  tutor: SeedTutor;
  subject: { name: string; description: string; hourlyRate: string };
}

/**
 * Synthetic demo availability: for each seeded tutor, open 09:00-17:00 (Bangkok) half-hour slots for the next seven
 * days that advertise the seeded subject. Repeating the seed never duplicates or reopens a slot that is already used.
 */
export async function seedAvailability(databaseUrl: string, tutors: SeedTutor[], days = 7, fixture?: SeedFixture): Promise<{ created: number }> {
  const pool = createPool(databaseUrl);
  let created = 0;
  try {
    await migrate(pool);
    const now = systemClock.now();
    const today = bangkokParts(now).date;
    for (const tutor of tutors) {
      for (let offset = 0; offset < days; offset += 1) {
        const date = bangkokParts(new Date(bangkokInstant(today, '00:00').getTime() + offset * 24 * HOUR_MS)).date;
        for (let half = 18; half < 34; half += 1) {
          const time = `${String(Math.floor(half / 2)).padStart(2, '0')}:${half % 2 ? '30' : '00'}`;
          const startsAt = bangkokInstant(date, time);
          if (startsAt.getTime() <= now.getTime()) continue;
          const id = derivedId(`slot:${tutor.tutorId}:${iso(startsAt)}`);
          const inserted = await pool.query(
            `INSERT INTO availability_slots (id, tutor_id, tutor_user_id, starts_at, ends_at, state, revision, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'OPEN', 0, $6, $6) ON CONFLICT (tutor_id, starts_at) DO NOTHING RETURNING id`,
            [id, tutor.tutorId, tutor.userId, startsAt, new Date(startsAt.getTime() + SLOT_MS), now],
          );
          if (inserted.rowCount) {
            created += 1;
            await pool.query('INSERT INTO slot_subjects (slot_id, subject_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, tutor.subjectId]);
          }
        }
      }
    }
    if (fixture) await seedCompletedLesson(pool, fixture);
  } finally {
    await pool.end();
  }
  return { created };
}

async function seedCompletedLesson(pool: ReturnType<typeof createPool>, fixture: SeedFixture): Promise<void> {
  const bookingId = derivedId('fixture:completed-lesson');
  if ((await pool.query('SELECT 1 FROM bookings WHERE id = $1', [bookingId])).rowCount) return;
  const now = systemClock.now();
  // Yesterday 10:00-10:30 Bangkok time: finished, confirmed by the tutor and paid.
  const yesterday = bangkokParts(new Date(now.getTime() - 24 * HOUR_MS)).date;
  const startsAt = bangkokInstant(yesterday, '10:00');
  const endsAt = new Date(startsAt.getTime() + SLOT_MS);
  const slotId = derivedId(`slot:${fixture.tutor.tutorId}:${iso(startsAt)}`);
  const rate = BigInt(fixture.subject.hourlyRate.replace('.', ''));
  await pool.query(
    `INSERT INTO bookings (id, student_user_id, tutor_id, tutor_user_id, student_display_name, tutor_display_name,
       subject_id, subject_name, subject_description, subject_rate_satang, subject_revision, description, starts_at, ends_at,
       slot_count, amount_satang, status, revision, paid_at, completed_at, tutor_confirmed_at, meeting_state, meeting_provider_ref,
       meeting_generated_url, meeting_changed_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'0','Revision session: derivatives and limits',$11,$12,1,$13,'COMPLETED',1,$14,$14,$14,'READY',$15,$16,$14,$14,$14)`,
    [bookingId, fixture.studentUserId, fixture.tutor.tutorId, fixture.tutor.userId, fixture.studentName, fixture.tutorName,
      fixture.tutor.subjectId, fixture.subject.name, fixture.subject.description, rate.toString(), startsAt, endsAt,
      (rate / 2n).toString(), endsAt, derivedId('fixture:meeting'), 'https://meet.example.test/lesson/development-fixture'],
  );
  await pool.query(
    `INSERT INTO availability_slots (id, tutor_id, tutor_user_id, starts_at, ends_at, state, booking_id, revision, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'BOOKED', $7, 0, $6, $6) ON CONFLICT (tutor_id, starts_at) DO NOTHING`,
    [slotId, fixture.tutor.tutorId, fixture.tutor.userId, startsAt, endsAt, now, bookingId],
  );
  await pool.query('INSERT INTO booking_slots (booking_id, slot_id, position) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING', [bookingId, slotId]);
}

if (require.main === module) {
  const databaseUrl = process.env.DATABASE_URL;
  const raw = process.env.BOOKING_SEED_TUTORS;
  if (process.env.DEMO_MODE !== 'true') {
    console.error('[Booking] seed requires DEMO_MODE=true');
    process.exitCode = 1;
  } else if (!databaseUrl || !raw) {
    console.error('[Booking] seed requires DATABASE_URL and BOOKING_SEED_TUTORS');
    process.exitCode = 1;
  } else {
    seedAvailability(databaseUrl, JSON.parse(raw) as SeedTutor[], 7, process.env.BOOKING_SEED_FIXTURE ? (JSON.parse(process.env.BOOKING_SEED_FIXTURE) as SeedFixture) : undefined)
      .then((result) => console.log(`[Booking] synthetic availability: ${result.created} slot(s) created`))
      .catch((error) => { console.error('[Booking] seed failed', (error as Error).message); process.exitCode = 1; });
  }
}
