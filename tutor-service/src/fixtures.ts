import type { ActorClaims } from "@tutor-matcher/shared";
import { randomUUID } from "node:crypto";
import type {
  AccountLookup,
  CommandContext,
  Peers,
  RatingSummary,
} from "./types";
export function fixtureActor(
  userId: string = randomUUID(),
  capabilities = ["STUDENT"],
): ActorClaims {
  return {
    iss: "api-gateway",
    aud: "tutor-matcher-internal",
    sub: userId,
    userId,
    sessionId: randomUUID(),
    admissionId: randomUUID(),
    admittedAt: new Date().toISOString(),
    requestId: randomUUID(),
    publicOperation: "fixture",
    capabilities,
    accountRevision: "0",
  };
}
export function fixtureContext(
  actor: ActorClaims,
  operation: string,
  revision?: string,
  key: string = randomUUID(),
): CommandContext {
  return {
    actor: { ...actor, publicOperation: operation },
    idempotencyKey: key,
    ifMatch: revision === undefined ? undefined : `"${revision}"`,
    method: "POST",
    route: operation,
  };
}
export function emptyRating(subjectId: string): RatingSummary {
  return {
    subjectId,
    average: null,
    reviewCount: 0,
    distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
  };
}
export class FixturePeers implements Peers {
  authDown = false;
  bookingDown = false;
  reviewDown = false;
  grantCalls: string[] = [];
  availabilityCalls = 0;
  ratingCalls = 0;
  accountsById = new Map<string, AccountLookup>();
  ratingsById = new Map<string, RatingSummary>();
  async accounts(ids: string[]) {
    if (this.authDown) throw new Error("Auth unavailable");
    return ids.map(
      (id) =>
        this.accountsById.get(id) ?? {
          id,
          displayName: "Synthetic Tutor",
          email: "fixture@example.test",
          status: "ACTIVE",
          capabilities: ["STUDENT", "TUTOR"],
        },
    );
  }
  async grant(work: Parameters<Peers["grant"]>[0]) {
    this.grantCalls.push(work.operationId);
    if (this.authDown) throw new Error("Auth unavailable");
    return {
      operationId: work.operationId,
      userId: work.userId,
      capability: "TUTOR",
      status: "APPLIED",
      appliedAt: new Date().toISOString(),
    };
  }
  async ratings(ids: string[]) {
    this.ratingCalls++;
    if (this.reviewDown) throw new Error("Review unavailable");
    return ids.map((id) => this.ratingsById.get(id) ?? emptyRating(id));
  }
  async batchAvailability(queries: Parameters<Peers["batchAvailability"]>[0]) {
    this.availabilityCalls++;
    if (this.bookingDown) throw new Error("Booking unavailable");
    return queries.map((_query, queryIndex) => ({
      queryIndex,
      hasAvailability: false,
      nextAvailableAt: "",
      freeSlotCount: 0,
    }));
  }
  async availability(_query: Parameters<Peers["availability"]>[0]) {
    this.availabilityCalls++;
    if (this.bookingDown) throw new Error("Booking unavailable");
    return [];
  }
  async publicReviews(_query: Parameters<Peers["publicReviews"]>[0]) {
    if (this.reviewDown) throw new Error("Review unavailable");
    return [];
  }
}
