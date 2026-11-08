import { createHmac, timingSafeEqual } from "node:crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { AppError } from "./errors.js";

export interface ActorClaims extends JwtPayload {
  iss: "api-gateway";
  aud: "tutor-matcher-internal";
  sub: string;
  userId: string;
  sessionId: string;
  admissionId: string;
  admittedAt: string;
  requestId: string;
  publicOperation: string;
  capabilities: string[];
  accountRevision: string;
  view?: "STUDENT" | "TUTOR" | "ADMIN";
  purpose?: "USER_ACTION";
}

export type ActorClaimsInput = Omit<ActorClaims, "iss" | "aud" | "iat" | "exp" | "sub">;

export function signActorAssertion(claims: ActorClaimsInput, privateKey: string): string {
  return jwt.sign(
    { ...claims, sub: claims.userId, iss: "api-gateway", aud: "tutor-matcher-internal" },
    privateKey,
    { algorithm: "RS256", expiresIn: 60, noTimestamp: false },
  );
}

export function verifyActorAssertion(token: string, publicKey: string, nowSeconds?: number): ActorClaims {
  try {
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ["RS256"],
      issuer: "api-gateway",
      audience: "tutor-matcher-internal",
      ...(nowSeconds === undefined ? {} : { clockTimestamp: nowSeconds }),
    });
    if (typeof decoded === "string" || !hasActorClaims(decoded)) {
      throw new Error("invalid actor claims");
    }
    return decoded;
  } catch {
    throw new AppError(401, "INVALID_ACTOR_ASSERTION", "Actor assertion is missing or invalid.");
  }
}

function hasActorClaims(value: JwtPayload): value is ActorClaims {
  return value.iss === "api-gateway"
    && value.aud === "tutor-matcher-internal"
    && typeof value.sub === "string"
    && typeof value.userId === "string"
    && value.sub === value.userId
    && typeof value.sessionId === "string"
    && typeof value.admissionId === "string"
    && typeof value.admittedAt === "string"
    && typeof value.requestId === "string"
    && typeof value.publicOperation === "string"
    && Array.isArray(value.capabilities)
    && value.capabilities.every((item) => typeof item === "string")
    && typeof value.accountRevision === "string"
    && typeof value.exp === "number";
}

export interface WorkloadAllowlist {
  [caller: string]: readonly string[];
}

export function verifyWorkload(
  authorization: string | undefined,
  expectedCredential: string,
  caller: string,
  operation: string,
  allowlist: WorkloadAllowlist,
): void {
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
  const supplied = match?.[1] ?? "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(expectedCredential);
  const validCredential = Boolean(match)
    && supplied.length > 0
    && expectedCredential.length > 0
    && left.length === right.length
    && timingSafeEqual(left, right);
  const validOperation = allowlist[caller]?.includes(operation) ?? false;
  if (!validCredential || !validOperation) {
    throw new AppError(401, "INVALID_WORKLOAD", "Workload authentication failed.");
  }
}

export function signWorkloadToken(caller: string, secret: string): string {
  return createHmac("sha256", secret).update(caller).digest("base64url");
}
