import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError, signActorAssertion, verifyWorkload } from '@tutor-matcher/shared';
import { inspectToken } from './routes';
import { isUuid, now } from './security';

type Parameter = { name: string; in: string; required?: boolean; schema?: Record<string, unknown> };
type Operation = {
  operationId: string;
  security?: unknown[];
  parameters?: Parameter[];
  'x-owner'?: string;
  'x-required-capabilities'?: string[];
};
type PublicSpec = { paths: Record<string, Record<string, Operation>>; components?: { schemas?: Record<string, Record<string, unknown>> } };

const specPath = path.resolve(__dirname, '../../../contracts/public.openapi.json');
const spec = JSON.parse(readFileSync(specPath, 'utf8')) as PublicSpec;
const publicPaths = Object.entries(spec.paths).sort(([left], [right]) => pathSpecificity(right) - pathSpecificity(left));

function pathSpecificity(template: string): number {
  const segments = template.split('/').filter(Boolean);
  const staticSegments = segments.filter((segment) => !/^\{[^}]+\}$/.test(segment)).length;
  const staticCharacters = segments.filter((segment) => !/^\{[^}]+\}$/.test(segment)).join('').length;
  return staticSegments * 1000 + staticCharacters;
}

function resolveSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const ref = schema?.$ref;
  if (typeof ref !== 'string') return schema ?? {};
  const name = ref.split('/').at(-1) ?? '';
  return spec.components?.schemas?.[name] ?? {};
}

function validateScalar(value: string, schemaInput: Record<string, unknown> | undefined, fieldPath: string): void {
  const schema = resolveSchema(schemaInput);
  let valid = true;
  if (schema.format === 'uuid' || (typeof schema.$ref === 'string' && schema.$ref.endsWith('/Id'))) valid = isUuid(value);
  else if (schema.type === 'integer') valid = /^-?(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));
  else if (schema.type === 'number') valid = value.trim() !== '' && Number.isFinite(Number(value));
  if (valid && typeof schema.pattern === 'string') valid = new RegExp(schema.pattern).test(value);
  if (valid && Array.isArray(schema.enum)) valid = schema.enum.includes(value);
  if (valid && typeof schema.minLength === 'number') valid = value.length >= schema.minLength;
  if (valid && typeof schema.maxLength === 'number') valid = value.length <= schema.maxLength;
  if (valid && typeof schema.minimum === 'number') valid = Number(value) >= schema.minimum;
  if (valid && typeof schema.maximum === 'number') valid = Number(value) <= schema.maximum;
  if (!valid) throw new AppError(400, 'VALIDATION_FAILED', 'Request parameters are invalid.', { [fieldPath]: 'Value does not match the public API contract.' });
}

function pathMatch(template: string, actual: string): Record<string, string> | undefined {
  const names: string[] = [];
  const pattern = template.split(/(\{[^}]+\})/g).map((part) => {
    const parameter = /^\{([^}]+)\}$/.exec(part);
    if (parameter) { names.push(parameter[1]); return '([^/]+)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  const found = new RegExp(`^${pattern}$`).exec(actual);
  if (!found) return undefined;
  const params: Record<string, string> = {};
  names.forEach((name, index) => {
    try { params[name] = decodeURIComponent(found[index + 1]); }
    catch { throw new AppError(400, 'VALIDATION_FAILED', 'Request path parameters are invalid.'); }
  });
  return params;
}

function matchOperation(method: string, rawUri: string): { operation: Operation; pathParams: Record<string, string>; query: URLSearchParams } {
  let uri: URL;
  try { uri = new URL(rawUri, 'http://traefik.invalid'); }
  catch { throw new AppError(400, 'VALIDATION_FAILED', 'Forwarded request URI is invalid.'); }
  if (!rawUri.startsWith('/') || rawUri.startsWith('//') || uri.origin !== 'http://traefik.invalid') throw new AppError(400, 'VALIDATION_FAILED', 'Forwarded request URI is invalid.');
  let pathname = uri.pathname;
  if (pathname === '/api') pathname = '/';
  else if (pathname.startsWith('/api/')) pathname = pathname.slice(4);
  const verb = (method === 'HEAD' ? 'GET' : method).toLowerCase();
  for (const [template, methods] of publicPaths) {
    const operation = methods[verb];
    if (!operation || typeof operation['x-owner'] !== 'string') continue;
    const pathParams = pathMatch(template, pathname);
    if (pathParams) return { operation, pathParams, query: uri.searchParams };
  }
  throw new AppError(404, 'ROUTE_NOT_FOUND', 'Public operation is not registered.');
}

function validateOperationRequest(req: Request, operation: Operation, pathParams: Record<string, string>, query: URLSearchParams): void {
  const parameters = operation.parameters ?? [];
  const knownQuery = new Set(parameters.filter((parameter) => parameter.in === 'query').map((parameter) => parameter.name));
  for (const key of new Set(query.keys())) {
    if (!knownQuery.has(key)) throw new AppError(400, 'VALIDATION_FAILED', 'Request contains an unknown query parameter.', { [`/query/${key}`]: 'Unknown query parameter.' });
  }
  for (const key of knownQuery) {
    if (query.getAll(key).length > 1) throw new AppError(400, 'VALIDATION_FAILED', 'Request contains a duplicate query parameter.', { [`/query/${key}`]: 'Duplicate query parameter.' });
  }
  for (const parameter of parameters) {
    let value: string | undefined;
    if (parameter.in === 'path') value = pathParams[parameter.name];
    else if (parameter.in === 'query') value = query.get(parameter.name) ?? undefined;
    else if (parameter.in === 'header') value = parameter.name.toLowerCase() === 'x-request-id' ? req.requestId : req.get(parameter.name);
    if (parameter.required && value === undefined) {
      const conditional = parameter.in === 'header' && ['if-match', 'idempotency-key'].includes(parameter.name.toLowerCase());
      throw new AppError(conditional ? 428 : 400, conditional ? 'PRECONDITION_REQUIRED' : 'VALIDATION_FAILED', 'A required request parameter is missing.', { [`/${parameter.in}/${parameter.name}`]: 'This parameter is required.' });
    }
    if (value !== undefined) validateScalar(value, parameter.schema, `/${parameter.in}/${parameter.name}`);
  }
}

export async function authorizeGateway(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const credential = process.env.GATEWAY_WORKLOAD_CREDENTIAL;
    if (!credential) throw new AppError(503, 'DEPENDENCY_UNAVAILABLE', 'Gateway admission is unavailable.', undefined, true);
    verifyWorkload(req.get('x-workload-authorization'), credential, 'gateway', 'GET /internal/gateway/authorize', {
      gateway: ['GET /internal/gateway/authorize'],
    });

    const method = req.get('x-forwarded-method')?.toUpperCase();
    const forwardedUri = req.get('x-forwarded-uri');
    if (!method || !/^[A-Z]+$/.test(method) || !forwardedUri) throw new AppError(400, 'VALIDATION_FAILED', 'Forwarded operation metadata is missing.');
    const matched = matchOperation(method, forwardedUri);
    validateOperationRequest(req, matched.operation, matched.pathParams, matched.query);

    const requiredCapabilities = matched.operation['x-required-capabilities'] ?? [];
    if (!matched.operation.security?.length) throw new AppError(403, 'FORBIDDEN', 'This public operation does not use protected admission.');
    const browserToken = req.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!browserToken) throw new AppError(401, 'TOKEN_INVALID', 'A valid session is required.');
    let jwtClaims: jwt.JwtPayload;
    try { jwtClaims = jwt.verify(browserToken, process.env.JWT_SECRET!, { algorithms: ['HS256'] }) as jwt.JwtPayload; }
    catch { throw new AppError(401, 'TOKEN_INVALID', 'The session token is invalid or expired.'); }
    if (typeof jwtClaims.sub !== 'string' || !isUuid(jwtClaims.sub) || typeof jwtClaims.sid !== 'string' || !isUuid(jwtClaims.sid)) {
      throw new AppError(401, 'TOKEN_INVALID', 'The session token is invalid or expired.');
    }
    const current = await inspectToken(browserToken);
    if (!requiredCapabilities.every((capability) => current.capabilities.includes(capability))) throw new AppError(403, 'FORBIDDEN', 'The current account lacks a required capability.');

    const token = signActorAssertion({
      userId: current.userId,
      sessionId: current.sessionId,
      admissionId: randomUUID(),
      admittedAt: now().toISOString(),
      requestId: req.requestId,
      publicOperation: matched.operation.operationId,
      capabilities: current.capabilities,
      accountRevision: current.accountRevision,
      purpose: 'USER_ACTION',
    }, process.env.ACTOR_ASSERTION_PRIVATE_KEY!);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Actor-Context', token);
    res.setHeader('X-Request-Id', req.requestId);
    res.status(204).end();
  } catch (error) { next(error); }
}
