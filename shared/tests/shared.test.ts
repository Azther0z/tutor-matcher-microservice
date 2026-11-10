import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import protobuf from "protobufjs";
import grpcExamples from "../../contracts/grpc/examples.v1.json";
import {
  AppError,
  encodeErrorDetail,
  grpcErrorTrailer,
  mapGrpcError,
  normalizeProtoMessage,
  PROTO_LOADER_OPTIONS,
  signActorAssertion,
  toHttpError,
  validateRequest,
  validateGrpcRequest,
  validateGrpcResponse,
  verifyActorAssertion,
  verifyWorkload,
} from "../src/index.js";

test("HTTP errors match the shared public error schema shape", () => {
  const response = toHttpError(new AppError(422, "VALIDATION_FAILED", "Invalid input.", { "/email": "Malformed." }), "8eac4f52-9255-44c6-bb5a-8238bc1b8092");
  assert.equal(response.status, 422);
  assert.deepEqual(response.body, {
    code: "VALIDATION_FAILED",
    message: "Invalid input.",
    requestId: "8eac4f52-9255-44c6-bb5a-8238bc1b8092",
    retryable: false,
    fields: [{ path: "/email", code: "INVALID_FIELD", message: "Malformed." }],
  });
});

test("shared schemas validate UUIDs and reject undeclared body keys", () => {
  assert.doesNotThrow(() => validateRequest("Id", "8eac4f52-9255-44c6-bb5a-8238bc1b8092"));
  assert.throws(() => validateRequest("Id", "not-a-uuid"), AppError);
  assert.throws(() => validateRequest("Login", {
    email: "student@example.invalid",
    password: "sample-password",
    userId: "forged",
  }), AppError);
});

test("schema errors retain every missing and additional property path", () => {
  assert.throws(() => validateRequest("Signup", {
    email: "student@example.invalid",
    password: "sample-password",
    passwordConfirmation: "sample-password",
    termsAccepted: true,
    privacyAccepted: true,
    unknownKey: true,
  }), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.deepEqual(Object.keys(error.fields ?? {}).sort(), ["/firstName", "/lastName", "/unknownKey"]);
    return true;
  });
});

test("registry-backed gRPC validators accept all synthetic wire views", () => {
  for (const example of grpcExamples.operations) {
    assert.doesNotThrow(() => validateGrpcRequest(example.operationId, example.request), `${example.operationId} request`);
    assert.doesNotThrow(() => validateGrpcResponse(example.operationId, example.response), `${example.operationId} response`);
  }
});

test("registry-backed gRPC validation rejects missing fields, invalid revisions and unknown enums", () => {
  const grant = structuredClone(grpcExamples.operations.find(({ operationId }) => operationId === "grantTutorCapability")?.request);
  assert.ok(grant && typeof grant === "object");
  const grantRequest = grant as Record<string, unknown>;
  const command = grantRequest.command as Record<string, unknown>;
  assert.throws(() => validateGrpcRequest("grantTutorCapability", {
    ...grantRequest,
    command: { ...command, approvalRevision: "000" },
  }), AppError);
  const grantAdmission = command.admission as Record<string, unknown>;
  const missingSession = { ...grantRequest, command: { ...command, admission: { ...grantAdmission } } };
  delete (missingSession.command as Record<string, unknown>).admission;
  assert.throws(() => validateGrpcRequest("grantTutorCapability", missingSession), AppError);

  const refund = structuredClone(grpcExamples.operations.find(({ operationId }) => operationId === "applyCancellationRefund")?.request);
  assert.ok(refund && typeof refund === "object");
  const refundRequest = refund as Record<string, unknown>;
  const refundCommand = refundRequest.command as Record<string, unknown>;
  assert.throws(() => validateGrpcRequest("applyCancellationRefund", {
    ...refundRequest,
    command: { ...refundCommand, kind: "UNRECOGNIZED_KIND" },
  }), AppError);
});

test("gRPC validation retains explicit false values in response DTOs", () => {
  const example = grpcExamples.operations.find(({ operationId }) => operationId === "getTutorEligibility");
  assert.ok(example);
  const response = structuredClone(example.response) as Record<string, unknown>;
  response.approved = false;
  response.activated = false;
  response.published = false;
  assert.doesNotThrow(() => validateGrpcResponse("getTutorEligibility", response));
  assert.equal(response.approved, false);
  assert.equal(response.activated, false);
  assert.equal(response.published, false);
});

test("RS256 actor assertions are audience-bound and short lived", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const claims = {
    userId: "8eac4f52-9255-44c6-bb5a-8238bc1b8092",
    sessionId: "912325b1-e5de-47bb-9f0b-377202fb8c91",
    admissionId: "92c69395-1899-427b-bbaf-12f987bd3b22",
    admittedAt: "2026-11-08T00:00:00.000Z",
    requestId: "761489cb-01b9-49dd-a44b-66e1096a0643",
    publicOperation: "getCurrentAccount",
    capabilities: ["STUDENT"],
    accountRevision: "1",
  };
  const token = signActorAssertion(claims, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const verified = verifyActorAssertion(token, publicKey.export({ type: "spki", format: "pem" }).toString());
  assert.equal(verified.sub, claims.userId);
  assert.equal(verified.exp! - verified.iat!, 60);
  assert.throws(() => verifyActorAssertion(token, publicKey.export({ type: "spki", format: "pem" }).toString(), verified.exp! + 1), AppError);
});

test("workload verification checks both credential and caller operation", () => {
  const allowlist = { gateway: ["introspectToken", "getAuthOperation"] };
  assert.doesNotThrow(() => verifyWorkload("Bearer synthetic-secret", "synthetic-secret", "gateway", "introspectToken", allowlist));
  assert.throws(() => verifyWorkload("Bearer synthetic-secret", "synthetic-secret", "gateway", "lookupAccounts", allowlist), AppError);
  assert.throws(() => verifyWorkload("Bearer wrong", "synthetic-secret", "gateway", "introspectToken", allowlist), AppError);
  assert.throws(() => verifyWorkload(undefined, "", "gateway", "introspectToken", allowlist), AppError);
  assert.throws(() => verifyWorkload("Bearer supplied", "", "gateway", "introspectToken", allowlist), AppError);
});

test("protobuf adapters normalize snake case and encode the common error trailer", () => {
  assert.deepEqual(normalizeProtoMessage({ user_id: "u1", nested_value: [{ request_id: "r1" }] }), {
    userId: "u1",
    nestedValue: [{ requestId: "r1" }],
  });
  assert.deepEqual(normalizeProtoMessage({ present: false }, {
    nullableFields: ["absentNullable"],
    repeatedFields: ["items"],
  }), { present: false, items: [], absentNullable: null });
  assert.equal(PROTO_LOADER_OPTIONS.defaults, false);
  const detail = {
    code: "INVALID_ARGUMENT",
    message: "bad",
    requestId: "r1",
    retryable: false,
    fields: [{ path: "/email", code: "INVALID_FIELD", message: "Malformed." }],
  };
  const encoded = encodeErrorDetail(detail);
  assert.ok(encoded.length > 0);
  assert.ok(Buffer.isBuffer(grpcErrorTrailer(detail)["tutor-error-bin"]));
  const protoRoot = protobuf.loadSync("../contracts/grpc/common/v1/types.proto");
  const protoType = protoRoot.lookupType("tutor_matcher.common.v1.ErrorDetail");
  const decoded = protoType.toObject(protoType.decode(encoded), { defaults: false, arrays: true });
  assert.equal(decoded.requestId, "r1");
  assert.equal(decoded.fields?.[0]?.path, "/email");
  const mapped = mapGrpcError({ code: 3, details: "invalid" }, "r1");
  assert.equal(mapped.status, 422);
  assert.equal(mapped.code, "INVALID_ARGUMENT");
});
