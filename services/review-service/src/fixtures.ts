import { randomUUID } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import {
  AppError,
  validateGrpcRequest,
  validateGrpcResponse,
  verifyWorkload,
} from "@tutor-matcher/shared";
import { loadProto, grpcOptions, stripPresence } from "./peers";
import type { PeerClients, ReviewEligibility, Account } from "./types";
export const syntheticIds = {
  student: "11111111-1111-4111-8111-111111111111",
  tutorUser: "22222222-2222-4222-8222-222222222222",
  tutor: "33333333-3333-4333-8333-333333333333",
  subject: "44444444-4444-4444-8444-444444444444",
  admin: "55555555-5555-4555-8555-555555555555",
  reporter: "66666666-6666-4666-8666-666666666666",
};
export function syntheticEligibility(
  bookingId = randomUUID(),
): ReviewEligibility {
  return {
    bookingId,
    studentUserId: syntheticIds.student,
    tutorId: syntheticIds.tutor,
    tutorUserId: syntheticIds.tutorUser,
    subjectId: syntheticIds.subject,
    completedAt: "2026-11-01T03:00:00.000Z",
    bookingRevision: "4",
    eligible: true,
  };
}
export class PeerFixture implements PeerClients {
  bookings = new Map<string, ReviewEligibility>();
  records = new Map<string, Account>(
    Object.values(syntheticIds).map((id) => [
      id,
      {
        id,
        displayName: `Synthetic ${id.slice(0, 8)}`,
        email: `fixture-${id}@example.test`,
        status: "ACTIVE",
        capabilities: ["STUDENT"],
      },
    ]),
  );
  unavailable = false;
  async reviewEligibility(bookingId: string): Promise<ReviewEligibility> {
    if (this.unavailable)
      throw new AppError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "Fixture unavailable.",
        undefined,
        true,
      );
    const found = this.bookings.get(bookingId);
    if (!found) throw new AppError(404, "NOT_FOUND", "Booking is unavailable.");
    return structuredClone(found);
  }
  async accounts(ids: string[]) {
    if (this.unavailable)
      throw new AppError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "Fixture unavailable.",
        undefined,
        true,
      );
    return ids.flatMap((id) => {
      const row = this.records.get(id);
      return row ? [structuredClone(row)] : [];
    });
  }
}
export async function startPeerFixture(
  fixture: PeerFixture,
  credential: string,
) {
  const auth = loadProto("auth/v1/collaboration.proto"),
    booking = loadProto("booking/v1/collaboration.proto");
  const servers = [new grpc.Server(grpcOptions), new grpc.Server(grpcOptions)];
  const guarded =
    (operation: string, work: (request: any) => Promise<unknown>) =>
    (
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>,
    ) => {
      void (async () => {
        try {
          const authorization = call.metadata.get("authorization")[0];
          verifyWorkload(
            typeof authorization === "string" ? authorization : undefined,
            credential,
            "review",
            operation,
            { review: [operation] },
          );
          const request = stripPresence(call.request);
          validateGrpcRequest(operation, request);
          const result = await work(request);
          validateGrpcResponse(operation, result);
          callback(null, result);
        } catch (error) {
          const app = error as AppError;
          callback({
            code:
              app.status === 401
                ? grpc.status.UNAUTHENTICATED
                : app.status === 404
                  ? grpc.status.NOT_FOUND
                  : grpc.status.UNAVAILABLE,
            details: "Fixture rejected request.",
          });
        }
      })();
    };
  servers[0].addService(
    auth.tutor_matcher.auth.v1.AuthCollaborationService.service,
    {
      lookupAccounts: guarded("lookupAccounts", async (req) => ({
        items: await fixture.accounts(req.userIds),
      })),
    },
  );
  servers[1].addService(
    booking.tutor_matcher.booking.v1.BookingEvidenceService.service,
    {
      getReviewEligibility: guarded("getReviewEligibility", (req) =>
        fixture.reviewEligibility(req.bookingId),
      ),
    },
  );
  const ports = await Promise.all(
    servers.map(
      (server) =>
        new Promise<number>((resolve, reject) =>
          server.bindAsync(
            "127.0.0.1:0",
            grpc.ServerCredentials.createInsecure(),
            (error, port) => (error ? reject(error) : resolve(port)),
          ),
        ),
    ),
  );
  return {
    authUrl: `127.0.0.1:${ports[0]}`,
    bookingUrl: `127.0.0.1:${ports[1]}`,
    close: () => servers.forEach((server) => server.forceShutdown()),
  };
}
