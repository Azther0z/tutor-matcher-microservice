import 'dotenv/config';
import { createPool, migrate } from './db';
import { derivedId } from './ids';
import { bangkokInstant, bangkokParts, HOUR_MS, iso, SLOT_MS, systemClock } from './time';

interface SeedTutor {
  userId: string;
  tutorId: string;
  subjectId: string;
}

/**
 * Synthetic demo availability: for each seeded tutor, open 09:00-17:00 (Bangkok) half-hour slots for the next seven
 * days that advertise the seeded subject. Repeating the seed never duplicates or reopens a slot that is already used.
 */
export async function seedAvailability(databaseUrl: string, tutors: SeedTutor[], days = 7): Promise<{ created: number }> {
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
  } finally {
    await pool.end();
  }
  return { created };
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
    seedAvailability(databaseUrl, JSON.parse(raw) as SeedTutor[])
      .then((result) => console.log(`[Booking] synthetic availability: ${result.created} slot(s) created`))
      .catch((error) => { console.error('[Booking] seed failed', (error as Error).message); process.exitCode = 1; });
  }
}
