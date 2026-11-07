import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import protobuf from 'protobufjs';

export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export const CHANNEL_OPTIONS = {
  'grpc.max_send_message_length': MAX_MESSAGE_BYTES,
  'grpc.max_receive_message_length': MAX_MESSAGE_BYTES,
};

/** Loader options required by the gRPC guide: preserve explicit scalar presence, never invent defaults. */
export function loadProtos(contractsDir: string, files: string[]): grpc.GrpcObject {
  const base = path.join(contractsDir, 'grpc');
  const definition = protoLoader.loadSync(files.map((f) => path.join(base, f)), {
    includeDirs: [base], keepCase: false, defaults: false, enums: String, longs: String, oneofs: true,
  });
  return grpc.loadPackageDefinition(definition);
}

export interface ErrorDetailInput {
  code: string; message: string; requestId: string; retryable: boolean;
  fields: Array<{ path: string; code: string; message: string }>; operationId?: string;
}

let errorType: protobuf.Type | undefined;

function errorDetailType(contractsDir: string): protobuf.Type {
  if (!errorType) {
    const base = path.join(contractsDir, 'grpc');
    const root = new protobuf.Root();
    root.resolvePath = (_origin, target) => path.resolve(base, target);
    root.loadSync('common/v1/types.proto');
    errorType = root.lookupType('tutor_matcher.common.v1.ErrorDetail');
  }
  return errorType;
}

export function encodeErrorDetail(contractsDir: string, detail: ErrorDetailInput): Buffer {
  const type = errorDetailType(contractsDir);
  return Buffer.from(type.encode(type.fromObject(detail)).finish());
}

export function decodeErrorDetail(contractsDir: string, bytes: Buffer): ErrorDetailInput {
  const type = errorDetailType(contractsDir);
  return type.toObject(type.decode(bytes), { defaults: false }) as ErrorDetailInput;
}

/**
 * With the mandated `oneofs: true` loader option, every proto3 `optional` field also decodes with a synthetic
 * `_fieldName: 'fieldName'` discriminator. No contract field starts with an underscore, so drop those markers
 * (recursively) before validating the decoded message against its schema view.
 */
export function decoded<T>(value: unknown): T {
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !k.startsWith('_')).map(([k, x]) => [k, clean(x)]));
    }
    return v;
  };
  return clean(value) as T;
}

/** Protobuf has no null: drop nulls so absent optional fields stay absent on the wire. */
export function toWire<T>(value: T): T {
  if (Array.isArray(value)) return value.map(toWire) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, toWire(v)])) as T;
  }
  return value;
}

/** Decoded gRPC → JSON schema view: absent nullable fields become null (required ones stay missing for validation). */
export function withNulls<T extends Record<string, unknown>>(value: T, nullable: string[]): T {
  const out: Record<string, unknown> = { ...decoded<Record<string, unknown>>(value) };
  for (const key of nullable) if (out[key] === undefined) out[key] = null;
  return out as T;
}
