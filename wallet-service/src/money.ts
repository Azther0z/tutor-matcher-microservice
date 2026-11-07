// Exact THB arithmetic. Every amount is an integral number of satang held in a bigint.
// Amounts cross the wire as fixed two-decimal strings and never pass through floating point.

export type Satang = bigint;

const AMOUNT = /^(?:0|[1-9]\d*)\.\d{2}$/;

export function parseAmount(value: string): Satang {
  if (!AMOUNT.test(value)) throw new RangeError(`Invalid THB amount: ${value}`);
  const [baht, satang] = value.split('.');
  return BigInt(baht) * 100n + BigInt(satang);
}

export function formatAmount(value: Satang): string {
  if (value < 0n) throw new RangeError('Negative amounts are not representable on the wire');
  const baht = value / 100n;
  const satang = value % 100n;
  return `${baht}.${satang.toString().padStart(2, '0')}`;
}

export function money(value: Satang): { currency: 'THB'; amount: string } {
  return { currency: 'THB', amount: formatAmount(value) };
}

/** ROUND_HALF_UP(value × numerator ÷ denominator) for non-negative integers. */
export function mulDivHalfUp(value: Satang, numerator: bigint, denominator: bigint): Satang {
  if (value < 0n || numerator < 0n || denominator <= 0n) throw new RangeError('Rounding needs non-negative inputs');
  return (value * numerator * 2n + denominator) / (denominator * 2n);
}

/** Platform fee: ROUND_HALF_UP(paid × 0.15, 2). */
export function platformFee(paid: Satang): Satang {
  return mulDivHalfUp(paid, 15n, 100n);
}

/** Student cancellation inside the 24-hour boundary: ROUND_HALF_UP(paid × 0.70, 2). */
export function seventyPercent(paid: Satang): Satang {
  return mulDivHalfUp(paid, 70n, 100n);
}

export const MAX_TRANSFER: Satang = 10_000_000n; // THB 100,000.00

export function isTransferAmount(value: Satang): boolean {
  return value > 0n && value <= MAX_TRANSFER;
}
