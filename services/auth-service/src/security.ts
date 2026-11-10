import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Request, Response, NextFunction } from 'express';
import { pool } from './db';
import { AppError, validateRequest, verifyActorAssertion, verifyWorkload } from '@tutor-matcher/shared';

export { AppError };

export type AuthContext = { userId: string; sessionId: string; capabilities: string[]; assertedCapabilities: string[]; accountRevision: string; status: string };
declare global { namespace Express { interface Request { requestId: string; auth?: AuthContext; } } }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
let clock: () => Date = () => new Date();
export const now = (): Date => clock();
export function setAuthClock(next: () => Date): () => void {
  const previous=clock; clock=next; return ()=>{clock=previous;};
}
export const emailKey = (email: string): string => email.trim().toLowerCase();
export const sha256 = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();
export const fingerprint = (value: string): string => createHmac('sha256', process.env.AUTH_FINGERPRINT_KEY ?? process.env.IDEMPOTENCY_SECRET ?? process.env.JWT_SECRET ?? 'local-unsafe-key').update(value).digest('hex');

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.get('x-request-id');
  if (supplied && !isUuid(supplied)) {
    req.requestId=randomUUID(); res.setHeader('X-Request-Id',req.requestId);
    next(new AppError(400, 'INVALID_REQUEST_ID', 'X-Request-Id must be a UUID.')); return;
  }
  req.requestId = supplied ?? randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

export function requireIdempotency(req: Request): string {
  const key = req.get('idempotency-key');
  if (!key) throw new AppError(428, 'PRECONDITION_REQUIRED', 'Idempotency-Key is required.');
  if (!isUuid(key)) throw new AppError(400, 'VALIDATION_FAILED', 'Idempotency-Key must be a UUID.', { '/headers/Idempotency-Key': 'Must be a UUID.' });
  return key.toLowerCase();
}

export function validateObject(body: unknown, required: string[], allowed: string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(422, 'VALIDATION_FAILED', 'Request body must be a JSON object.', { '/': 'Expected an object.' });
  const value = body as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const key of required) if (!(key in value)) fields[`/${key}`] = 'This field is required.';
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fields[`/${key}`] = 'Unknown field.';
  if (Object.keys(fields).length) throw new AppError(422, 'VALIDATION_FAILED', 'Request contains invalid fields.', fields);
  return value;
}

export async function loadCurrentAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    authenticateWorkload(req, ['gateway']);
    const claims = currentActor(req);
    const userId = claims.userId;
    const sessionId = claims.sessionId;
    const { rows } = await pool.query(`SELECT u.id, u.capabilities, u.status, u.revision,
      s.id AS session_id, s.expires_at, s.revoked_at
      FROM users u JOIN sessions s ON s.user_id=u.id
      WHERE u.id=$1 AND s.id=$2`, [userId, sessionId]);
    const row = rows[0];
    if (!row || row.revoked_at || new Date(row.expires_at) <= now()) throw new AppError(401, 'TOKEN_INVALID', 'This session is no longer active.');
    if (row.status !== 'ACTIVE') throw new AppError(403, 'ACCOUNT_RESTRICTED', 'This account is restricted.');
    req.auth = { userId, sessionId, capabilities: row.capabilities, assertedCapabilities: claims.capabilities, accountRevision: String(row.revision), status: row.status };
    next();
  } catch (error) { next(error); }
}

export function requireCapability(capability: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth?.capabilities.includes(capability) || !req.auth.assertedCapabilities.includes(capability)) return next(new AppError(403, 'FORBIDDEN', `The ${capability} capability is required.`));
    next();
  };
}

export function authenticateWorkload(req: Request, allowed: string[]): string {
  const authorization = req.get('authorization');
  const caller = allowed.find(name => process.env[`${name.toUpperCase()}_WORKLOAD_CREDENTIAL`]);
  if (!caller) throw new AppError(500, 'CONFIGURATION_ERROR', 'Workload credentials are not configured.');
  const operation = `${req.method.toUpperCase()} ${req.path}`;
  verifyWorkload(authorization, process.env[`${caller.toUpperCase()}_WORKLOAD_CREDENTIAL`]!, caller.toLowerCase(), operation, { [caller.toLowerCase()]: allowed.map(() => operation) });
  return caller.toLowerCase();
}

export function safeEqual(left: string, right: string): boolean {
  return timingSafeEqual(sha256(left),sha256(right));
}

export function resetTokenDigest(token: string): Buffer {
  return createHmac('sha256', process.env.RESET_TOKEN_PEPPER ?? process.env.JWT_SECRET!).update(token).digest();
}

export function passwordPrehash(password: string): string {
  return `TM1:${createHash('sha256').update(password, 'utf8').digest('base64url')}`;
}

// bcryptjs runs on the event loop. Many hashes at once starve every other task,
// including the database driver, whose connect timer then fires and the request
// fails. Letting only a few hashes run together keeps the loop responsive and
// makes the rest wait in line.
const MAX_CONCURRENT_HASHES = Number(process.env.AUTH_MAX_CONCURRENT_HASHES ?? 2);
let activeHashes = 0;
const hashQueue: Array<() => void> = [];

async function withHashSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeHashes >= MAX_CONCURRENT_HASHES) await new Promise<void>((resolve) => hashQueue.push(resolve));
  else activeHashes += 1;
  try {
    return await work();
  } finally {
    const next = hashQueue.shift();
    if (next) next();
    else activeHashes -= 1;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return withHashSlot(() => bcrypt.hash(passwordPrehash(password), 12));
}

export async function verifyPassword(password: string, hash: string, scheme: string): Promise<boolean> {
  if (scheme === 'BCRYPT_SHA256_V1') return withHashSlot(() => bcrypt.compare(passwordPrehash(password), hash));
  // Upgrade compatibility with rows created by the former bcrypt implementation.
  return withHashSlot(() => bcrypt.compare(password, hash));
}

export function encryptResetMaterial(plaintext: string): { nonce: Buffer; ciphertext: Buffer; authTag: Buffer } {
  const key = sha256(process.env.RESET_CONTENT_KEY ?? '');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { nonce, ciphertext, authTag: cipher.getAuthTag() };
}

export function decryptResetMaterial(nonce: Buffer, ciphertext: Buffer, authTag: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', sha256(process.env.RESET_CONTENT_KEY ?? ''), nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function currentActor(req: Request) {
  const token = req.get('x-actor-context');
  if (!token || !process.env.ACTOR_ASSERTION_PUBLIC_KEY) throw new AppError(401, 'INVALID_ACTOR_ASSERTION', 'A signed actor assertion is required.');
  const claims = verifyActorAssertion(token, process.env.ACTOR_ASSERTION_PUBLIC_KEY);
  if (!isUuid(claims.userId) || !isUuid(claims.sessionId)) throw new AppError(401, 'INVALID_ACTOR_ASSERTION', 'Actor assertion identity is invalid.');
  if (claims.requestId !== req.requestId) throw new AppError(401, 'INVALID_ACTOR_ASSERTION', 'Actor assertion request binding is invalid.');
  const routePath=String(req.route?.path??req.path);
  const operation=authOperationByRoute[`${req.method.toUpperCase()} ${routePath}`];
  if(!operation||claims.publicOperation!==operation)throw new AppError(401,'INVALID_ACTOR_ASSERTION','Actor assertion operation binding is invalid.');
  return claims;
}

export { validateRequest };

const authOperationByRoute:Record<string,string>={
  'POST /auth/logout':'logout',
  'GET /auth/me':'getCurrentAccount',
  'GET /profiles/me/account':'getAccountSettings',
  'PUT /profiles/me/account':'updateAccountSettings',
  'GET /profiles/me/student':'getStudentProfile',
  'PUT /profiles/me/student':'putStudentProfile',
  'GET /admin/users':'searchAccounts',
  'GET /admin/users/:userId':'getAdminAccount',
  'POST /admin/users/:userId/restrictions':'restrictAccount',
  'GET /demo/password-resets/:contentRef':'getDemoResetContent',
  'GET /internal/v1/auth/operations/:operationId':'getOperation',
};
