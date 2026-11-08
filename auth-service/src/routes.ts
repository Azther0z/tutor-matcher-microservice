import express, { type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'node:crypto';
import { inTransaction, pool } from './db';
import {
  AppError, decryptResetMaterial, emailKey, encryptResetMaterial, fingerprint, isUuid,
  authenticateWorkload, currentActor, hashPassword, loadCurrentAuth, now, requireCapability, requireIdempotency,
  resetTokenDigest, safeEqual, validateObject, validateRequest,
  verifyPassword,
} from './security';

const router = express.Router();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sessionLifetimeMs = 2 * 60 * 60 * 1000;

function requireRevision(req: Request): string {
  const value = req.get('if-match');
  if (!value) throw new AppError(428, 'PRECONDITION_REQUIRED', 'If-Match is required.');
  const revision = value.replace(/^"|"$/g, '');
  if (!/^(0|[1-9][0-9]*)$/.test(revision)) throw new AppError(400, 'VALIDATION_FAILED', 'If-Match must contain a quoted revision.');
  return revision;
}

function account(row: Record<string, any>) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    capabilities: row.capabilities,
    status: row.status,
    revision: String(row.revision),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

async function idempotentResult<T>(client: import('pg').PoolClient, method: string, key: string, actor: string, input: unknown): Promise<T | null> {
  const actorFp = fingerprint(actor);
  const inputFp = fingerprint(canonical(input));
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${method}:${key}:${actorFp}`]);
  const existing = await client.query('SELECT request_fingerprint,result FROM idempotency_records WHERE method=$1 AND key=$2 AND actor_fingerprint=$3 FOR UPDATE', [method, key, actorFp]);
  if (existing.rowCount) {
    if (existing.rows[0].request_fingerprint !== inputFp) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with different input.');
    return existing.rows[0].result as T;
  }
  return null;
}

async function saveIdempotent(client: import('pg').PoolClient, method: string, key: string, actor: string, input: unknown, result: unknown): Promise<void> {
  await client.query('INSERT INTO idempotency_records(method,key,actor_fingerprint,request_fingerprint,result) VALUES($1,$2,$3,$4,$5)', [method, key, fingerprint(actor), fingerprint(canonical(input)), JSON.stringify(result)]);
}

async function rateLimit(client: import('pg').PoolClient, bucket: string, subject: string, maximum: number, windowMs: number): Promise<void> {
  const subjectFp = fingerprint(subject);
  const limitAt = new Date(now().getTime() - windowMs);
  const { rows } = await client.query(`INSERT INTO auth_rate_limits(bucket,subject_digest,window_started_at,request_count)
    VALUES($1,$2,now(),1) ON CONFLICT(bucket,subject_digest) DO UPDATE
    SET window_started_at=CASE WHEN auth_rate_limits.window_started_at < $3 THEN now() ELSE auth_rate_limits.window_started_at END,
        request_count=CASE WHEN auth_rate_limits.window_started_at < $3 THEN 1 ELSE auth_rate_limits.request_count+1 END
    RETURNING request_count,window_started_at`, [bucket, subjectFp, limitAt]);
  if (rows[0].request_count > maximum) {
    const error = new AppError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.', undefined, true) as AppError & { retryAfterSeconds?: number };
    error.retryAfterSeconds = Math.max(1,Math.ceil((new Date(rows[0].window_started_at).getTime()+windowMs-Date.now())/1000));
    throw error;
  }
}

function tokenFor(userId: string, sessionId: string, email: string, capabilities: string[], revision: string, issuedAt: Date): { token: string; expiresAt: Date } {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
  const iat = Math.floor(issuedAt.getTime() / 1000);
  const exp = Math.floor((issuedAt.getTime() + sessionLifetimeMs) / 1000);
  const token = jwt.sign({ sub: userId, sid: sessionId, email, capabilities, revision, iat, exp }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  return { token, expiresAt: new Date(exp * 1000) };
}

async function newSession(client: import('pg').PoolClient, row: Record<string, any>, issuedAt = now(), sessionId = randomUUID()) {
  const expiresAt = new Date(issuedAt.getTime() + sessionLifetimeMs);
  await client.query('INSERT INTO sessions(id,user_id,issued_at,expires_at) VALUES($1,$2,$3,$4)', [sessionId, row.id, issuedAt, expiresAt]);
  const token = tokenFor(row.id, sessionId, row.email, row.capabilities, String(row.revision), issuedAt);
  return { user: account(row), token: token.token, expiresAt: token.expiresAt.toISOString() };
}

function validateEmail(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 254 || !emailPattern.test(value)) throw new AppError(422, 'VALIDATION_FAILED', 'Email address is invalid.', { '/email': 'Enter a valid email address.' });
}
function validateText(value: unknown, path: string, max: number): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new AppError(422, 'VALIDATION_FAILED', 'Request contains invalid fields.', { [path]: 'Enter a non-empty value within the allowed length.' });
}
function checkPasswordPair(password: unknown, confirm: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < 8 || password.length > 100) throw new AppError(422, 'VALIDATION_FAILED', 'Request contains invalid fields.', { '/password': 'Password must be 8 to 100 characters.' });
  if (password !== confirm) throw new AppError(422, 'PASSWORD_MISMATCH', 'Passwords do not match.', { '/passwordConfirmation': 'Must match password.' });
}

function markNoStore(_req: Request, res: Response, next: NextFunction) { res.setHeader('Cache-Control', 'no-store'); next(); }
router.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); }
  catch { throw new AppError(503,'DEPENDENCY_UNAVAILABLE','Auth storage is unavailable.',undefined,true); }
});

// The public namespace is only reachable through Gateway, including anonymous credential flows.
router.use((req,_res,next)=>{
  if(req.path.startsWith('/internal/v1/auth/'))return next();
  try{authenticateWorkload(req,['gateway']);next();}catch(error){next(error);}
});

router.post('/auth/signup', markNoStore, async (req, res) => {
  validateRequest('Signup', req.body);
  const body = validateObject(req.body, ['firstName','lastName','email','password','passwordConfirmation','termsAccepted','privacyAccepted'], ['firstName','lastName','email','password','passwordConfirmation','termsAccepted','privacyAccepted','adminSignupKey']);
  validateText(body.firstName, '/firstName', 100); validateText(body.lastName, '/lastName', 100); validateEmail(body.email);
  const normalizedEmail=emailKey(String(body.email));
  checkPasswordPair(body.password, body.passwordConfirmation);
  if (body.termsAccepted !== true || body.privacyAccepted !== true) throw new AppError(422, 'CONSENT_REQUIRED', 'Both Terms and Privacy must be accepted.', { '/termsAccepted': 'Must be true.', '/privacyAccepted': 'Must be true.' });
  if (body.adminSignupKey !== undefined && (typeof body.adminSignupKey !== 'string' || body.adminSignupKey.length > 256)) throw new AppError(422, 'VALIDATION_FAILED', 'Request contains invalid fields.', { '/adminSignupKey': 'Must be a string of at most 256 characters.' });
  const key = requireIdempotency(req);
  const input = { ...body, adminSignupKey: typeof body.adminSignupKey === 'string' ? fingerprint(body.adminSignupKey) : undefined };
  const actor = `signup:${normalizedEmail}`;
  const passwordHash = await hashPassword(body.password);
  const result = await inTransaction(async client => {
    const replay = await idempotentResult<Record<string, any>>(client, 'POST /auth/signup', key, actor, input);
    if (replay) {
      const { rows } = await client.query(`SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id
        WHERE u.id=$1 AND s.id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='ACTIVE'`, [replay.userId, replay.sessionId]);
      if (!rows[0]) throw new AppError(409, 'SESSION_EXPIRED_LOGIN_REQUIRED', 'The original signup session expired. Please log in.');
      const issuedAt = new Date(replay.issuedAt);
      const token = tokenFor(rows[0].id, replay.sessionId, rows[0].email, rows[0].capabilities, String(rows[0].revision), issuedAt);
      return { response: { user: account(rows[0]), token: token.token, expiresAt: token.expiresAt.toISOString() }, replay: true };
    }
    const configuredKey = process.env.ADMIN_SIGNUP_KEY;
    const requestedKey = typeof body.adminSignupKey === 'string' ? body.adminSignupKey : '';
    // Existing monolith behavior: absent, disabled or incorrect admin key falls through to Student signup.
    const capabilities = configuredKey && requestedKey && safeEqual(configuredKey, requestedKey) ? ['STUDENT','ADMIN'] : ['STUDENT'];
    const syntheticEmails = new Set((process.env.AUTH_SYNTHETIC_EMAILS ?? '').split(',').map(emailKey).filter(Boolean));
    const synthetic = process.env.DEMO_MODE === 'true' && syntheticEmails.has(normalizedEmail);
    const { rows } = await client.query(`INSERT INTO users(email,password_hash,display_name,first_name,last_name,capabilities,status,revision)
      VALUES($1,$2,$3,$4,$5,$6,'ACTIVE',0) RETURNING *`, [normalizedEmail, passwordHash, `${String(body.firstName).trim()} ${String(body.lastName).trim()}`, String(body.firstName).trim(), String(body.lastName).trim(), capabilities]);
    await client.query("UPDATE users SET password_scheme='BCRYPT_SHA256_V1',synthetic=$2 WHERE id=$1", [rows[0].id,synthetic]);
    rows[0].password_scheme = 'BCRYPT_SHA256_V1';
    await client.query('INSERT INTO student_profiles(user_id) VALUES($1)', [rows[0].id]);
    const issuedAt = now();
    const sessionId = randomUUID();
    const response = await newSession(client, rows[0], issuedAt, sessionId);
    await saveIdempotent(client, 'POST /auth/signup', key, actor, input, { userId: rows[0].id, sessionId, issuedAt: issuedAt.toISOString() });
    await client.query(`INSERT INTO auth_operations(id,actor_user_id,kind,status,resource,created_at,updated_at) VALUES($1,$2,'signup','SUCCEEDED',$3,now(),now())`, [key, rows[0].id, JSON.stringify({type:'account',id:rows[0].id,url:'/api/auth/me'})]);
    return { response, replay: false };
  });
  if (result.replay) res.setHeader('Idempotency-Replayed', 'true');
  res.status(201).json(result.response);
});

router.post('/auth/login', markNoStore, async (req, res) => {
  validateRequest('Login', req.body);
  const body = validateObject(req.body, ['email','password'], ['email','password']);
  validateEmail(body.email);
  if (typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 100) throw new AppError(422, 'VALIDATION_FAILED', 'Request contains invalid fields.', { '/password': 'Password is required.' });
  const normalizedEmail=emailKey(String(body.email)); const password=body.password;
  const ip = req.ip ?? 'unknown';
  await inTransaction(async client => {
    await rateLimit(client, 'login-ip', ip, 40, 15 * 60 * 1000);
    await rateLimit(client, 'login-email', normalizedEmail, 12, 15 * 60 * 1000);
  });
  const lookup = await pool.query('SELECT * FROM users WHERE lower(email)=$1', [normalizedEmail]);
  const candidate = lookup.rows[0];
  if (!candidate || !(await verifyPassword(password, candidate.password_hash, candidate.password_scheme ?? 'BCRYPT_LEGACY'))) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  if (candidate.status !== 'ACTIVE') throw new AppError(403, 'ACCOUNT_RESTRICTED', 'This account is restricted.');
  const login = await inTransaction(async client => {
    const { rows } = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [candidate.id]);
    const user = rows[0];
    if (!user || user.status !== 'ACTIVE') throw new AppError(403, 'ACCOUNT_RESTRICTED', 'This account is restricted.');
    if (user.password_scheme !== 'BCRYPT_SHA256_V1') {
      const upgraded = await hashPassword(password);
      await client.query("UPDATE users SET password_hash=$2,password_scheme='BCRYPT_SHA256_V1' WHERE id=$1", [user.id, upgraded]);
      user.password_hash = upgraded; user.password_scheme = 'BCRYPT_SHA256_V1';
    }
    return newSession(client,user);
  });
  res.json(login);
});

router.post('/auth/logout', loadCurrentAuth, requireCapability('STUDENT'), markNoStore, async (req, res) => {
  const key = requireIdempotency(req); const actor = req.auth!.userId;
  await inTransaction(async client => {
    const previous = await idempotentResult(client, 'POST /auth/logout', key, actor, { sessionId: req.auth!.sessionId });
    if (previous) return;
    await client.query('UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason=COALESCE(revoke_reason,\'LOGOUT\') WHERE user_id=$1 AND id=$2', [actor, req.auth!.sessionId]);
    await saveIdempotent(client, 'POST /auth/logout', key, actor, { sessionId: req.auth!.sessionId }, { done: true });
    await client.query(`INSERT INTO auth_operations(id,actor_user_id,kind,status,resource,created_at,updated_at)
      VALUES($1,$2,'logout','SUCCEEDED',NULL,now(),now()) ON CONFLICT(id) DO NOTHING`, [key,actor]);
  });
  res.status(204).end();
});

router.get('/auth/me', loadCurrentAuth, requireCapability('STUDENT'), markNoStore, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.auth!.userId]);
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Account was not found.');
  res.setHeader('ETag',`"${rows[0].revision}"`);
  res.json(account(rows[0]));
});

router.post('/auth/password-reset/request', markNoStore, async (req, res) => {
  validateRequest('ResetRequest', req.body);
  const body = validateObject(req.body, ['email'], ['email']); validateEmail(body.email); const normalizedEmail=emailKey(String(body.email));
  const response = await inTransaction(async client => {
    await rateLimit(client, 'reset-ip', req.ip ?? 'unknown', 20, 60 * 60 * 1000);
    await rateLimit(client, 'reset-email', normalizedEmail, 5, 60 * 60 * 1000);
    const { rows } = await client.query("SELECT * FROM users WHERE lower(email)=$1 AND status='ACTIVE' FOR UPDATE", [normalizedEmail]);
    if (!rows[0]) return { message: 'If an account exists for that email, password reset instructions will be sent.' };
    const user = rows[0];
    const at = now(); const expiresAt = new Date(at.getTime() + 30 * 60 * 1000);
    const token = randomBytes(32).toString('base64url'); const digest = resetTokenDigest(token);
    await client.query(`UPDATE reset_contents SET consumed_at=COALESCE(consumed_at,$2),ciphertext=decode('','hex'),auth_tag=decode('','hex')
      WHERE reset_token_id IN (SELECT id FROM reset_tokens WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL)`, [user.id,at]);
    await client.query('UPDATE reset_tokens SET revoked_at=COALESCE(revoked_at,$2) WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL', [user.id, at]);
    const tokenRow = await client.query('INSERT INTO reset_tokens(user_id,token_digest,created_at,expires_at) VALUES($1,$2,$3,$4) RETURNING id', [user.id,digest,at,expiresAt]);
    const contentRef = randomUUID();
    const base = (process.env.RESET_BASE_URL ?? process.env.RESET_PUBLIC_BASE_URL ?? 'http://127.0.0.1:8080/password-reset').replace(/\/$/, '');
    const link = `${base}#token=${encodeURIComponent(token)}`;
    if (!process.env.RESET_CONTENT_KEY) throw new Error('RESET_CONTENT_KEY is required for reset delivery');
    const encrypted = encryptResetMaterial(`Reset your Tutor Matcher password using this link: ${link}`);
    await client.query(`INSERT INTO reset_contents(content_ref,user_id,reset_token_id,nonce,ciphertext,auth_tag,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [contentRef,user.id,tokenRow.rows[0].id,encrypted.nonce,encrypted.ciphertext,encrypted.authTag,expiresAt]);
    const event = {
      eventId: randomUUID(), type: 'auth.password-reset-requested', schemaVersion: 1, occurredAt: at.toISOString(), producer: 'auth',
      aggregate: { type: 'user', id: user.id, version: String((await client.query('UPDATE users SET aggregate_version=aggregate_version+1 WHERE id=$1 RETURNING aggregate_version',[user.id])).rows[0].aggregate_version) }, correlationId: req.requestId,
      targets: { kind: 'USERS', userIds: [user.id] }, notificationGroup: 'SYSTEM', data: { contentRef, expiresAt: expiresAt.toISOString() },
    };
    await client.query('INSERT INTO events_outbox(event_id,event_type,routing_key,payload,created_at) VALUES($1,$2,$3,$4,$5)', [event.eventId,event.type,`v1.${event.type}`,JSON.stringify(event),at]);
    return { message: 'If an account exists for that email, password reset instructions will be sent.' };
  });
  res.status(202).json(response);
});

router.post('/auth/password-reset/validate', markNoStore, async (req, res) => {
  validateRequest('ResetToken', req.body);
  const body = validateObject(req.body, ['token'], ['token']);
  if (typeof body.token !== 'string' || !body.token) throw new AppError(422, 'VALIDATION_FAILED', 'Reset token is required.', { '/token': 'Required.' });
  const { rows } = await pool.query(`SELECT expires_at FROM reset_tokens WHERE token_digest=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>$2
    AND NOT EXISTS (SELECT 1 FROM reset_tokens newer WHERE newer.user_id=reset_tokens.user_id AND newer.created_at>reset_tokens.created_at)`, [resetTokenDigest(body.token),now()]);
  if (!rows[0]) throw new AppError(400, 'RESET_TOKEN_INVALID', 'This password reset link is invalid or expired.');
  res.json({ valid: true, expiresAt: new Date(rows[0].expires_at).toISOString() });
});

router.post('/auth/password-reset/confirm', markNoStore, async (req, res) => {
  validateRequest('ResetConfirm', req.body);
  const body = validateObject(req.body, ['token','password','passwordConfirmation'], ['token','password','passwordConfirmation']);
  if (typeof body.token !== 'string' || body.token.length > 512) throw new AppError(422, 'VALIDATION_FAILED', 'Reset token is invalid.', { '/token': 'Required.' });
  const resetToken=body.token;
  checkPasswordPair(body.password, body.passwordConfirmation);
  const key = requireIdempotency(req); const tokenFp = fingerprint(resetToken); const input = { tokenFingerprint: tokenFp, passwordFingerprint: fingerprint(String(body.password)) };
  const passwordHash = await hashPassword(body.password);
  await inTransaction(async client => {
    const replay = await idempotentResult(client, 'POST /auth/password-reset/confirm', key, `reset:${tokenFp}`, input);
    if (replay) return;
    const digest = resetTokenDigest(resetToken);
    const { rows } = await client.query(`SELECT rt.id,rt.user_id,u.revision FROM reset_tokens rt JOIN users u ON u.id=rt.user_id
      WHERE rt.token_digest=$1 AND rt.consumed_at IS NULL AND rt.revoked_at IS NULL AND rt.expires_at>$2 AND u.status='ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM reset_tokens newer WHERE newer.user_id=rt.user_id AND newer.created_at>rt.created_at)
      FOR UPDATE OF rt,u`, [digest,now()]);
    if (!rows[0]) throw new AppError(400, 'RESET_TOKEN_INVALID', 'This password reset link is invalid or expired.');
    const userId = rows[0].user_id;
    await client.query("UPDATE users SET password_hash=$2,password_scheme='BCRYPT_SHA256_V1',revision=revision+1,updated_at=now() WHERE id=$1", [userId,passwordHash]);
    await client.query("UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason=COALESCE(revoke_reason,'PASSWORD_RESET') WHERE user_id=$1", [userId]);
    await client.query('UPDATE reset_tokens SET consumed_at=now() WHERE id=$1', [rows[0].id]);
    await client.query("UPDATE reset_contents SET consumed_at=now(),ciphertext=decode('','hex'),auth_tag=decode('','hex') WHERE reset_token_id=$1", [rows[0].id]);
    await saveIdempotent(client, 'POST /auth/password-reset/confirm', key, `reset:${tokenFp}`, input, { done: true });
    await client.query(`INSERT INTO auth_operations(id,actor_user_id,kind,status,resource,created_at,updated_at) VALUES($1,$2,'password-reset','SUCCEEDED',$3,now(),now()) ON CONFLICT(id) DO NOTHING`, [key,userId,JSON.stringify({type:'account',id:userId,url:'/api/auth/me'})]);
  });
  res.status(204).end();
});

router.get('/profiles/me/account', loadCurrentAuth, requireCapability('STUDENT'), markNoStore, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.auth!.userId]);
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Account was not found.');
  res.setHeader('ETag',`"${rows[0].revision}"`);
  res.json(account(rows[0]));
});

router.put('/profiles/me/account', loadCurrentAuth, requireCapability('STUDENT'), markNoStore, async (req, res) => {
  validateRequest('AccountUpdate', req.body);
  const body = validateObject(req.body, [], ['firstName','lastName','email','currentPassword','newPassword','deactivate']);
  if (Object.keys(body).length === 0) throw new AppError(422, 'VALIDATION_FAILED', 'At least one field is required.');
  if (body.firstName !== undefined) validateText(body.firstName, '/firstName', 100);
  if (body.lastName !== undefined) validateText(body.lastName, '/lastName', 100);
  if (body.email !== undefined) validateEmail(body.email);
  if (body.currentPassword !== undefined && (typeof body.currentPassword !== 'string' || body.currentPassword.length < 1 || body.currentPassword.length > 100)) throw new AppError(422, 'VALIDATION_FAILED', 'Current password is invalid.', { '/currentPassword': 'Required when changing sensitive settings.' });
  if (body.newPassword !== undefined && (typeof body.newPassword !== 'string' || body.newPassword.length < 8 || body.newPassword.length > 100)) throw new AppError(422, 'VALIDATION_FAILED', 'New password is invalid.', { '/newPassword': 'Must be 8 to 100 characters.' });
  if (body.deactivate !== undefined && body.deactivate !== true) throw new AppError(422, 'VALIDATION_FAILED', 'deactivate must be true when provided.', { '/deactivate': 'Must be true.' });
  const sensitiveChange = body.email !== undefined || body.newPassword !== undefined || body.deactivate === true;
  if (sensitiveChange && typeof body.currentPassword !== 'string') throw new AppError(422, 'CURRENT_PASSWORD_REQUIRED', 'Current password is required for this change.', { '/currentPassword': 'Required.' });
  const key = requireIdempotency(req); const actor = req.auth!.userId;
  const input = { ...body, currentPassword: body.currentPassword ? fingerprint(body.currentPassword) : undefined, newPassword: body.newPassword ? fingerprint(body.newPassword) : undefined };
  const newPasswordHash = typeof body.newPassword === 'string' ? await hashPassword(body.newPassword) : null;
  const saved = await inTransaction(async client => {
    const replay = await idempotentResult<Record<string, any>>(client, 'PUT /profiles/me/account', key, actor, input);
    if (replay) return replay;
    const revision=requireRevision(req);
    const { rows } = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [actor]);
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Account was not found.');
    const current = rows[0];
    if (String(current.revision) !== revision) throw new AppError(412, 'REVISION_MISMATCH', 'Account changed. Refresh and try again.');
    if (sensitiveChange && !(await verifyPassword(String(body.currentPassword), current.password_hash, current.password_scheme ?? 'BCRYPT_LEGACY'))) throw new AppError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect.');
    if (current.status !== 'ACTIVE') throw new AppError(409, 'INVALID_ACCOUNT_STATE', 'Only an active account can be changed.');
    const status = body.deactivate === true ? 'DEACTIVATED' : current.status;
    const firstName = typeof body.firstName === 'string' ? body.firstName.trim() : current.first_name;
    const lastName = typeof body.lastName === 'string' ? body.lastName.trim() : current.last_name;
    const email = typeof body.email === 'string' ? emailKey(body.email) : current.email;
    const passwordHash = newPasswordHash ?? current.password_hash;
    const { rows: updated } = await client.query(`UPDATE users SET first_name=$2,last_name=$3,display_name=$4,email=$5,password_hash=$6,password_scheme=CASE WHEN $8::boolean THEN 'BCRYPT_SHA256_V1' ELSE password_scheme END,status=$7,revision=revision+1,updated_at=now()
      WHERE id=$1 RETURNING *`, [actor,firstName,lastName,`${firstName} ${lastName}`,email,passwordHash,status,Boolean(newPasswordHash)]);
    if (newPasswordHash || body.deactivate === true) {
      await client.query("UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason=COALESCE(revoke_reason,$2) WHERE user_id=$1", [actor,newPasswordHash ? 'PASSWORD_CHANGE' : 'DEACTIVATED']);
      await client.query(`UPDATE reset_contents SET consumed_at=COALESCE(consumed_at,now()),ciphertext=decode('','hex'),auth_tag=decode('','hex')
        WHERE reset_token_id IN (SELECT id FROM reset_tokens WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL)`,[actor]);
      await client.query("UPDATE reset_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL",[actor]);
    }
    const result = account(updated[0]);
    await saveIdempotent(client, 'PUT /profiles/me/account', key, actor, input, result);
    await client.query(`INSERT INTO auth_operations(id,actor_user_id,kind,status,resource,created_at,updated_at) VALUES($1,$2,$3,'SUCCEEDED',$4,now(),now()) ON CONFLICT(id) DO NOTHING`, [key,actor,newPasswordHash ? 'password-change' : body.deactivate === true ? 'deactivation' : 'account-update',JSON.stringify({type:'account',id:result.id,url:'/api/profiles/me/account'})]);
    return result;
  });
  res.setHeader('ETag', `"${saved.revision}"`);
  res.json(saved);
});

router.get('/profiles/me/student', loadCurrentAuth, requireCapability('STUDENT'), markNoStore, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM student_profiles WHERE user_id=$1', [req.auth!.userId]);
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Student profile was not found.');
  res.setHeader('ETag',`"${rows[0].revision}"`);
  res.json({ userId: rows[0].user_id, learningAreas: rows[0].learning_areas, level: rows[0].level, goals: rows[0].goals, preferredPeriods: rows[0].preferred_periods, revision: String(rows[0].revision) });
});

router.put('/profiles/me/student', loadCurrentAuth, requireCapability('STUDENT'), markNoStore, async (req, res) => {
  validateRequest('StudentProfileWrite', req.body);
  const body = validateObject(req.body, ['learningAreas','level','goals','preferredPeriods'], ['learningAreas','level','goals','preferredPeriods']);
  if (!Array.isArray(body.learningAreas) || body.learningAreas.length > 30 || !Array.isArray(body.preferredPeriods) || body.preferredPeriods.some(p => !['MORNING','AFTERNOON','EVENING'].includes(String(p))) || body.preferredPeriods.length > 3 || typeof body.level !== 'string' || body.level.length > 100 || typeof body.goals !== 'string' || body.goals.length > 2000) throw new AppError(422, 'VALIDATION_FAILED', 'Student profile fields are invalid.');
  const key = requireIdempotency(req); const actor = req.auth!.userId;
  const result = await inTransaction(async client => {
    const input = body;
    const replay = await idempotentResult<Record<string, any>>(client, 'PUT /profiles/me/student', key, actor, input);
    if (replay) return replay;
    const revision=requireRevision(req);
    const { rows } = await client.query('SELECT * FROM student_profiles WHERE user_id=$1 FOR UPDATE', [actor]);
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Student profile was not found.');
    if (String(rows[0].revision) !== revision) throw new AppError(412, 'REVISION_MISMATCH', 'Student profile changed. Refresh and try again.');
    const { rows: updated } = await client.query(`UPDATE student_profiles SET learning_areas=$2,level=$3,goals=$4,preferred_periods=$5,revision=revision+1,updated_at=now()
      WHERE user_id=$1 RETURNING *`, [actor,JSON.stringify(body.learningAreas),body.level,body.goals,body.preferredPeriods]);
    const dto = { userId: updated[0].user_id, learningAreas: updated[0].learning_areas, level: updated[0].level, goals: updated[0].goals, preferredPeriods: updated[0].preferred_periods, revision: String(updated[0].revision) };
    await saveIdempotent(client, 'PUT /profiles/me/student', key, actor, input, dto);
    await client.query(`INSERT INTO auth_operations(id,actor_user_id,kind,status,resource,created_at,updated_at)
      VALUES($1,$2,'student-profile-update','SUCCEEDED',$3,now(),now()) ON CONFLICT(id) DO NOTHING`,
      [key,actor,JSON.stringify({type:'student-profile',id:actor,url:'/api/profiles/me/student'})]);
    return dto;
  });
  res.setHeader('ETag', `"${result.revision}"`); res.json(result);
});

router.get('/admin/users', loadCurrentAuth, requireCapability('ADMIN'), markNoStore, async (req, res) => {
  const page = Math.max(1, Number(req.query.page ?? 1)); const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)));
  if (!Number.isInteger(page) || !Number.isInteger(pageSize)) throw new AppError(422, 'VALIDATION_FAILED', 'Page values must be integers.');
  const q = typeof req.query.q === 'string' ? `%${req.query.q.trim()}%` : null;
  const capability = typeof req.query.capability === 'string' ? req.query.capability : null;
  if (capability && !['STUDENT','TUTOR','ADMIN'].includes(capability)) throw new AppError(422, 'VALIDATION_FAILED', 'Capability filter is invalid.');
  const count = await pool.query(`SELECT count(*)::int AS total FROM users WHERE ($1::text IS NULL OR email ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1) AND ($2::text IS NULL OR $2=ANY(capabilities))`, [q,capability]);
  const { rows } = await pool.query(`SELECT * FROM users WHERE ($1::text IS NULL OR email ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1) AND ($2::text IS NULL OR $2=ANY(capabilities)) ORDER BY id LIMIT $3 OFFSET $4`, [q,capability,pageSize,(page-1)*pageSize]);
  const totalItems = count.rows[0].total; res.json({ items: rows.map(account), pagination: { page, pageSize, totalItems, totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems/pageSize) } });
});

router.get('/admin/users/:userId', loadCurrentAuth, requireCapability('ADMIN'), markNoStore, async (req, res) => {
  if (!isUuid(req.params.userId)) throw new AppError(404, 'NOT_FOUND', 'Account was not found.');
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.userId]);
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Account was not found.');
  const { rows: audits } = await pool.query('SELECT id,actor_user_id,action,reason,occurred_at FROM restriction_audit WHERE user_id=$1 ORDER BY occurred_at DESC,id DESC', [req.params.userId]);
  res.setHeader('ETag',`"${rows[0].revision}"`);
  res.json({ user: account(rows[0]), audit: audits.map(r => ({ id:r.id, actorUserId:r.actor_user_id, action:r.action, reason:r.reason, occurredAt:r.occurred_at.toISOString() })), revision: String(rows[0].revision) });
});

router.post('/admin/users/:userId/restrictions', loadCurrentAuth, requireCapability('ADMIN'), markNoStore, async (req, res) => {
  validateRequest('RestrictionWrite', req.body);
  if (!isUuid(req.params.userId)) throw new AppError(404, 'NOT_FOUND', 'Account was not found.');
  const body = validateObject(req.body, ['action','reason'], ['action','reason']);
  if (!['SUSPEND','BAN','RESTORE'].includes(String(body.action))) throw new AppError(422, 'VALIDATION_FAILED', 'Restriction action is invalid.', { '/action': 'Choose SUSPEND, BAN or RESTORE.' });
  validateText(body.reason, '/reason', 500);
  const key = requireIdempotency(req); const actor = req.auth!.userId; const targetId = req.params.userId;
  const result = await inTransaction(async client => {
    const previous = await idempotentResult<Record<string, any>>(client,'POST /admin/users/:userId/restrictions',key,actor,{targetId,...body});
    if (previous) return previous;
    const revision=requireRevision(req);
    const { rows } = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [targetId]);
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Account was not found.');
    const user = rows[0];
    if (String(user.revision) !== revision) throw new AppError(412, 'REVISION_MISMATCH', 'Account changed. Refresh and try again.');
    const nextStatus: Record<string,string> = { 'ACTIVE:SUSPEND':'SUSPENDED','ACTIVE:BAN':'BANNED','SUSPENDED:BAN':'BANNED','SUSPENDED:RESTORE':'ACTIVE','DEACTIVATED:BAN':'BANNED','DEACTIVATED:RESTORE':'ACTIVE' };
    if (user.status === 'BANNED' && body.action === 'BAN') throw new AppError(409, 'ALREADY_BANNED', 'Banned accounts cannot be changed.');
    const status = nextStatus[`${user.status}:${body.action}`];
    if (!status) throw new AppError(409, 'INVALID_RESTRICTION_TRANSITION', 'This restriction action is not allowed for the account status.');
    const { rows: changed } = await client.query('UPDATE users SET status=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *', [targetId,status]);
    if (status !== 'ACTIVE') {
      await client.query("UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason=COALESCE(revoke_reason,$2) WHERE user_id=$1", [targetId,body.action]);
      await client.query(`UPDATE reset_contents SET consumed_at=COALESCE(consumed_at,now()),ciphertext=decode('','hex'),auth_tag=decode('','hex')
        WHERE reset_token_id IN (SELECT id FROM reset_tokens WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL)`,[targetId]);
      await client.query("UPDATE reset_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL",[targetId]);
    }
    await client.query('INSERT INTO restriction_audit(user_id,actor_user_id,action,reason) VALUES($1,$2,$3,$4)', [targetId,actor,body.action,body.reason]);
    const aggregateVersion = (await client.query('UPDATE users SET aggregate_version=aggregate_version+1 WHERE id=$1 RETURNING aggregate_version',[targetId])).rows[0].aggregate_version;
    const event = { eventId: randomUUID(),type:'auth.account-restricted',schemaVersion:1,occurredAt:now().toISOString(),producer:'auth',aggregate:{type:'user',id:targetId,version:String(aggregateVersion)},correlationId:req.requestId,targets:{kind:'USERS',userIds:[targetId]},notificationGroup:'SYSTEM',data:{action:body.action,reason:body.reason} };
    await client.query('INSERT INTO events_outbox(event_id,event_type,routing_key,payload,created_at) VALUES($1,$2,$3,$4,now())', [event.eventId,event.type,`v1.${event.type}`,JSON.stringify(event)]);
    const { rows: audits } = await client.query('SELECT id,actor_user_id,action,reason,occurred_at FROM restriction_audit WHERE user_id=$1 ORDER BY occurred_at DESC,id DESC', [targetId]);
    const dto = { user:account(changed[0]),audit:audits.map(r=>({id:r.id,actorUserId:r.actor_user_id,action:r.action,reason:r.reason,occurredAt:r.occurred_at.toISOString()})),revision:String(changed[0].revision) };
    await saveIdempotent(client,'POST /admin/users/:userId/restrictions',key,actor,{targetId,...body},dto);
    await client.query(`INSERT INTO auth_operations(id,actor_user_id,kind,status,resource,created_at,updated_at) VALUES($1,$2,'restriction','SUCCEEDED',$3,now(),now()) ON CONFLICT(id) DO NOTHING`, [key,actor,JSON.stringify({type:'account',id:targetId,url:`/api/admin/users/${targetId}`})]);
    return dto;
  });
  res.setHeader('ETag', `"${result.revision}"`); res.json(result);
});

router.get('/demo/password-resets/:contentRef', loadCurrentAuth, requireCapability('ADMIN'), markNoStore, async (req, res) => {
  if (process.env.DEMO_MODE !== 'true') throw new AppError(403, 'DEMO_DISABLED', 'Demo reset content is disabled.');
  if (!isUuid(req.params.contentRef)) throw new AppError(404, 'NOT_FOUND', 'Reset content was not found.');
  const { rows } = await pool.query(`SELECT rc.*,u.synthetic,rt.consumed_at AS token_consumed,rt.revoked_at AS token_revoked
    FROM reset_contents rc JOIN users u ON u.id=rc.user_id JOIN reset_tokens rt ON rt.id=rc.reset_token_id
    WHERE rc.content_ref=$1 AND rc.expires_at>$2 AND rc.consumed_at IS NULL AND rt.expires_at>$2 AND rt.consumed_at IS NULL AND rt.revoked_at IS NULL`, [req.params.contentRef,now()]);
  if (!rows[0]) throw new AppError(404,'RESET_TOKEN_INVALID','Reset content has expired or is no longer valid.');
  if (!rows[0].synthetic) throw new AppError(404,'RESOURCE_NOT_SYNTHETIC','Reset content is unavailable.');
  const text = decryptResetMaterial(rows[0].nonce,rows[0].ciphertext,rows[0].auth_tag);
  res.json({ contentRef:rows[0].content_ref,recipientUserId:rows[0].user_id,subject:'Tutor Matcher password reset',text,sensitive:true,expiresAt:rows[0].expires_at.toISOString() });
});

router.post('/internal/v1/auth/introspections', markNoStore, async (req, res) => {
  const caller = authenticateWorkload(req,['gateway']); if (caller !== 'gateway') throw new AppError(403,'FORBIDDEN','Only Gateway may introspect browser sessions.');
  validateRequest('IntrospectWrite', req.body);
  const body = validateObject(req.body,['token'],['token']);
  const result = await inspectToken(String(body.token));
  res.json({ active:true,userId:result.userId,sessionId:result.sessionId,capabilities:result.capabilities,accountRevision:result.accountRevision });
});

router.get('/internal/v1/auth/operations/:operationId', markNoStore, async (req,res) => {
  const caller = authenticateWorkload(req,['gateway']); if (caller !== 'gateway') throw new AppError(403,'FORBIDDEN','Only Gateway may poll Auth operations.');
  if (!isUuid(req.params.operationId)) throw new AppError(404,'NOT_FOUND','Operation was not found.');
  const auth = await internalActor(req);
  const { rows } = await pool.query('SELECT * FROM auth_operations WHERE id=$1',[req.params.operationId]);
  if (!rows[0]) throw new AppError(404,'NOT_FOUND','Operation was not found.');
  if (rows[0].actor_user_id !== auth.userId && !auth.capabilities.includes('ADMIN')) throw new AppError(404,'NOT_FOUND','Operation was not found.');
  res.json({ id:rows[0].id,owner:'auth',status:rows[0].status,kind:rows[0].kind,resource:rows[0].resource,error:rows[0].error,createdAt:rows[0].created_at.toISOString(),updatedAt:rows[0].updated_at.toISOString() });
});

async function inspectToken(token: string) {
  let claims: jwt.JwtPayload;
  try { claims = jwt.verify(token,process.env.JWT_SECRET!,{algorithms:['HS256']}) as jwt.JwtPayload; }
  catch { throw new AppError(401,'TOKEN_INVALID','The session token is invalid or expired.'); }
  if (typeof claims.sub !== 'string' || !isUuid(claims.sub) || typeof claims.sid !== 'string' || !isUuid(claims.sid)) throw new AppError(401,'TOKEN_INVALID','The session token is invalid or expired.');
  const { rows } = await pool.query(`SELECT u.id,u.capabilities,u.status,u.revision,s.id AS session_id,s.expires_at,s.revoked_at
    FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.id=$2`,[claims.sub,claims.sid]);
  const row=rows[0]; if(!row||row.revoked_at||new Date(row.expires_at)<=now()) throw new AppError(401,'TOKEN_INVALID','The session token is invalid or expired.');
  if(row.status!=='ACTIVE') throw new AppError(403,'ACCOUNT_RESTRICTED','This account is restricted.');
  return {userId:row.id,sessionId:row.session_id,capabilities:row.capabilities,accountRevision:String(row.revision)};
}
async function internalActor(req: Request) {
  const claims = currentActor(req);
  return { userId: claims.userId, capabilities: claims.capabilities };
}

export const publicRouter = router;
export { inspectToken, account };
