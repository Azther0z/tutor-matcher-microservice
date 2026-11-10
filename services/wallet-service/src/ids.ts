import { createHash, randomUUID } from 'node:crypto';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function newId(): string {
  return randomUUID();
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

const NAMESPACE = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');

/**
 * Deterministic identity (RFC 4122 version 5 layout, forced into the v4-looking
 * range the shared Id schema accepts). Recovery and workers use this so a retry
 * can never invent a second identity for the same financial effect.
 */
export function derivedId(name: string): string {
  const hash = createHash('sha1').update(NAMESPACE).update(`tutor-matcher.wallet:${name}`).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
