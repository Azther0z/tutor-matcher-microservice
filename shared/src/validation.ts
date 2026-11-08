import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import grpcMessages from "../../contracts/grpc/messages.v1.json";
import grpcOperations from "../../contracts/grpc/operations.v1.json";
import schemaDocument from "../../contracts/schemas/v1.json";
import { AppError } from "./errors.js";

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);
ajv.addSchema(schemaDocument, "https://tutor-matcher.local/schemas/v1.json");
ajv.addSchema(grpcMessages, "https://tutor-matcher.local/grpc/messages.v1.json");

interface GrpcOperationSchema {
  operationId: string;
  requestSchema: string;
  responseSchema: string;
}

const grpcOperationById = new Map(
  (grpcOperations.operations as GrpcOperationSchema[]).map((operation) => [operation.operationId, operation]),
);
const grpcValidatorCache = new Map<string, ValidateFunction>();

function fieldErrors(errors: ErrorObject[] | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of errors ?? []) {
    const path = errorPath(issue);
    result[path] = issue.message ?? "Invalid value";
  }
  return result;
}

function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function errorPath(issue: ErrorObject): string {
  const instancePath = issue.instancePath || "";
  if (issue.keyword === "required" && typeof issue.params.missingProperty === "string") {
    return `${instancePath}/${escapeJsonPointerSegment(issue.params.missingProperty)}`;
  }
  if (issue.keyword === "additionalProperties" && typeof issue.params.additionalProperty === "string") {
    return `${instancePath}/${escapeJsonPointerSegment(issue.params.additionalProperty)}`;
  }
  return instancePath || "/";
}

function throwInvalid(errors: ErrorObject[] | null | undefined): never {
  throw new AppError(422, "VALIDATION_FAILED", "Request validation failed.", fieldErrors(errors));
}

export function validateRequest(schemaId: string, value: unknown): void {
  const id = schemaId.startsWith("#") ? schemaId : `https://tutor-matcher.local/schemas/v1.json#/$defs/${schemaId}`;
  const validate = ajv.getSchema(id);
  if (!validate) {
    throw new AppError(500, "SCHEMA_NOT_FOUND", `Unknown validation schema: ${schemaId}`);
  }
  if (!validate(value)) throwInvalid(validate.errors);
}

export function validateSchema(schema: object, value: unknown): void {
  const validator: ValidateFunction = ajv.compile(schema);
  if (!validator(value)) throwInvalid(validator.errors);
}

export function validateGrpcRequest(operationId: string, value: unknown): void {
  validateGrpcMessage(operationId, "requestSchema", value, "Request validation failed.", 422, "VALIDATION_FAILED");
}

export function validateGrpcResponse(operationId: string, value: unknown): void {
  validateGrpcMessage(operationId, "responseSchema", value, "Dependency response validation failed.", 502, "INVALID_DEPENDENCY_RESPONSE");
}

function validateGrpcMessage(
  operationId: string,
  schemaKind: "requestSchema" | "responseSchema",
  value: unknown,
  message: string,
  status: number,
  code: string,
): void {
  const operation = grpcOperationById.get(operationId);
  if (!operation) throw new AppError(500, "GRPC_OPERATION_NOT_FOUND", `Unknown gRPC operation: ${operationId}`);
  const cacheKey = `${operationId}:${schemaKind}`;
  let validate = grpcValidatorCache.get(cacheKey);
  if (!validate) {
    const schemaRef = operation[schemaKind];
    const absoluteSchemaId = new URL(schemaRef, "https://tutor-matcher.local/grpc/operations.v1.json").href;
    validate = ajv.getSchema(absoluteSchemaId);
    if (!validate) throw new AppError(500, "GRPC_SCHEMA_NOT_FOUND", `Schema for ${operationId} is unavailable.`);
    grpcValidatorCache.set(cacheKey, validate);
  }
  if (!validate(value)) throw new AppError(status, code, message, fieldErrors(validate.errors));
}
