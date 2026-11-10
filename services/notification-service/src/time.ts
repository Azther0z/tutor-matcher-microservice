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

export const HOUR_MS = 3_600_000;
export const CLEARING_MS = 24 * HOUR_MS;
export const DISPUTE_RESIDUAL_MS = 24 * HOUR_MS;

/** Start of the Asia/Bangkok calendar month (UTC+7, no DST) containing the instant. */
export function bangkokMonthStart(date: Date): Date {
  const shifted = new Date(date.getTime() + 7 * HOUR_MS);
  const start = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1);
  return new Date(start - 7 * HOUR_MS);
}
