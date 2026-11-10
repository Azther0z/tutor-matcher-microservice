export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** UTC instant with exactly three fractional digits, as the contracts require. */
export function iso(date: Date): string {
  return date.toISOString();
}

export function parseInstant(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new RangeError(`Invalid instant: ${value}`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid instant: ${value}`);
  return date;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const SLOT_MS = 30 * MINUTE_MS;
export const HOLD_MS = 15 * MINUTE_MS;
export const BANGKOK_OFFSET_MS = 7 * HOUR_MS; // UTC+7, no daylight saving

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(?:[01]\d|2[0-3]):(?:00|30)$/;

/** The Asia/Bangkok calendar date and half-hour clock time of an instant. */
export function bangkokParts(date: Date): { date: string; time: string } {
  const shifted = new Date(date.getTime() + BANGKOK_OFFSET_MS).toISOString();
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16) };
}

export function isBangkokDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isBangkokTime(value: string): boolean {
  return TIME.test(value);
}

/** The UTC instant of a Bangkok wall-clock date and time. */
export function bangkokInstant(date: string, time: string): Date {
  return new Date(`${date}T${time}:00.000+07:00`);
}

/** Inclusive list of Bangkok dates from `from` to `to`. */
export function bangkokDates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let cursor = Date.parse(`${from}T00:00:00.000Z`); cursor <= Date.parse(`${to}T00:00:00.000Z`); cursor += 24 * HOUR_MS) {
    out.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return out;
}
