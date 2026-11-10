import type { Money } from "./types";

/** Amounts are exact decimal strings ("1234.50"); never convert them to floating point. */
export function formatAmount(amount: string): string {
  const [whole, fraction = "00"] = amount.split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

export function formatMoney(money: Money): string {
  return `THB ${formatAmount(money.amount)}`;
}

/** A top-up is a positive THB amount up to 100,000.00 with exactly two decimal places. */
export const TRANSFER_AMOUNT = /^(?:(?:0|[1-9]\d{0,4})\.\d{2}|100000\.00)$/;

/** Accept "250" or "250.5" and return the contract form "250.00", or null when it is not a valid transfer amount. */
export function normalizeAmount(input: string): string | null {
  const trimmed = input.trim();
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const normalized = `${whole.replace(/^0+(?=\d)/, "")}.${fraction.padEnd(2, "0")}`;
  if (!TRANSFER_AMOUNT.test(normalized) || normalized === "0.00") return null;
  return normalized;
}

const BANGKOK = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" });
/** Timestamps are UTC on the wire; people see Asia/Bangkok. */
export function formatTime(timestamp: string | null): string {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "—" : `${BANGKOK.format(date)} (Bangkok)`;
}

export function titleCase(value: string): string {
  return value.toLowerCase().split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

export function publicPath(url: string): string {
  return url.replace(/^\/api(?=\/)/, "");
}
