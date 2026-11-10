import fs from 'node:fs';
import path from 'node:path';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { validation, type FieldError } from './errors';

/**
 * Validators are compiled from the shared contract schemas, so REST bodies are checked
 * against the same definitions the OpenAPI documents reference (contracts/schemas/v1.json).
 */
export class Contracts {
  private readonly ajv: Ajv2020;
  private readonly cache = new Map<string, ValidateFunction>();

  constructor(contractsDir: string) {
    this.ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(this.ajv);
    const read = (file: string) => JSON.parse(fs.readFileSync(path.join(contractsDir, file), 'utf8'));
    // Keys mirror the repository layout so the relative $refs between the files resolve.
    this.ajv.addSchema(read('schemas/v1.json'), 'schemas/v1.json');
    this.ajv.addSchema(read('schemas/events.v1.json'), 'schemas/events.v1.json');
    this.ajv.addSchema(read('grpc/messages.v1.json'), 'grpc/messages.v1.json');
  }

  private compile(ref: string): ValidateFunction {
    let validate = this.cache.get(ref);
    if (!validate) {
      validate = this.ajv.getSchema(ref) ?? undefined;
      if (!validate) throw new Error(`Unknown contract schema ${ref}`);
      this.cache.set(ref, validate);
    }
    return validate;
  }

  /** Throws 422 with JSON-Pointer field errors when `value` does not satisfy `$defs/<name>`. */
  assertDef<T = unknown>(name: string, value: unknown, base = ''): T {
    const validate = this.compile(`schemas/v1.json#/$defs/${name}`);
    if (!validate(value)) throw validation(toFields(validate.errors ?? [], base));
    return value as T;
  }

  /** Validates a decoded gRPC request/response view from grpc/messages.v1.json. */
  assertView<T = unknown>(name: string, value: unknown): T {
    const validate = this.compile(`grpc/messages.v1.json#/$defs/${name}`);
    if (!validate(value)) throw validation(toFields(validate.errors ?? [], ''));
    return value as T;
  }

  isDef(name: string, value: unknown): boolean {
    return this.compile(`schemas/v1.json#/$defs/${name}`)(value) === true;
  }

  /** Validates a whole event envelope (the 21-variant oneOf). */
  validateEvent(value: unknown): { ok: true } | { ok: false; errors: string[] } {
    const validate = this.compile('schemas/events.v1.json');
    if (validate(value)) return { ok: true };
    return { ok: false, errors: (validate.errors ?? []).slice(0, 10).map((e) => `${e.instancePath || '/'} ${e.message}`) };
  }
}

function toFields(errors: ErrorObject[], base: string): FieldError[] {
  const seen = new Set<string>();
  const out: FieldError[] = [];
  for (const error of errors) {
    let pointer = error.instancePath;
    if (error.keyword === 'required') pointer += `/${(error.params as { missingProperty: string }).missingProperty}`;
    if (error.keyword === 'additionalProperties') pointer += `/${(error.params as { additionalProperty: string }).additionalProperty}`;
    const pathValue = `${base}${pointer}` || '/';
    const code = error.keyword === 'required' ? 'REQUIRED' : error.keyword === 'additionalProperties' ? 'UNKNOWN_FIELD' : 'INVALID';
    const key = `${pathValue}:${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: pathValue, code, message: (error.message ?? 'Invalid value').slice(0, 500) });
    if (out.length >= 100) break;
  }
  return out.length ? out : [{ path: base || '/', code: 'INVALID', message: 'Invalid value' }];
}
