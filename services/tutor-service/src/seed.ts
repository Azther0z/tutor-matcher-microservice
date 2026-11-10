import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { AppError } from "@tutor-matcher/shared";
import { connectStore } from "./store";
import { GrpcPeers } from "./peers";
import { TutorService } from "./service";
import { fixtureActor, fixtureContext } from "./fixtures";
import type { ActorClaims } from "@tutor-matcher/shared";
import type { Submission, Subject } from "./types";
function stableKey(identity: string): string {
  const buffer = createHash("sha256")
    .update(`tutor-demo-seed:${identity}`)
    .digest()
    .subarray(0, 16);
  buffer[6] = (buffer[6] & 15) | 64;
  buffer[8] = (buffer[8] & 63) | 128;
  const hex = buffer.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function seedApprovedTutor(
  service: TutorService,
  student: ActorClaims,
  admin: ActorClaims,
  namespace: string,
) {
  const command = (actor: ActorClaims, operation: string, revision?: string) =>
    fixtureContext(
      actor,
      operation,
      revision,
      stableKey(`${namespace}:${operation}`),
    );
  const draft = (
    await service.createDraft(command(student, "createTutorDraft"), {
      bio: "Synthetic demonstration tutor. No real identification documents are used.",
      headline: "Demonstration tutor",
      identificationDocumentUrl:
        "https://example.test/synthetic-identification",
      introVideoUrl: "https://example.test/synthetic-introduction",
    })
  ).body as Submission;
  const pending = (
    await service.submit(
      command(student, "submitTutorDraft", draft.revision),
      draft.id,
      { consentAccepted: true },
    )
  ).body as Submission;
  await service.review(
    command(admin, "reviewTutorSubmission", pending.revision),
    pending.id,
    { decision: "APPROVE" },
  );
  for (let i = 0; i < 5; i++) {
    if ((await service.getWorkspace(student.userId)).activation === "ACTIVE")
      break;
    await service.activateNext();
  }
  const current = await service.getWorkspace(student.userId);
  if (current.activation !== "ACTIVE")
    throw new AppError(
      503,
      "ACTIVATION_PENDING",
      "Synthetic tutor activation is still pending. Retry this same seed.",
    );
  student.capabilities = [...new Set([...student.capabilities, "TUTOR"])];
  await service.publication(
    command(student, "setTutorPublication", current.revision),
    { published: true },
  );
  const subject = (
    await service.createSubject(command(student, "createSubject"), {
      name: "Mathematics",
      description: "Synthetic algebra and calculus offering.",
      hourlyRate: "400.00",
      format: "ONLINE",
      learningAreas: ["mathematics"],
    })
  ).body as Subject;
  return {
    userId: student.userId,
    tutorId: current.tutorId,
    subjectId: subject.id,
  };
}
async function main() {
  if (process.env.DEMO_MODE !== "true")
    throw new Error("Seed requires explicit DEMO_MODE");
  if (!process.env.MONGO_URI || !process.env.TUTOR_SEED_USERS)
    throw new Error("MONGO_URI and TUTOR_SEED_USERS are required");
  const requested = JSON.parse(process.env.TUTOR_SEED_USERS) as Array<{
    userId: string;
    adminUserId: string;
  }>;
  if (
    !Array.isArray(requested) ||
    requested.length < 1 ||
    requested.length > 100
  )
    throw new Error("Expected 1 to 100 synthetic fixture account pairs");
  const store = await connectStore(process.env.MONGO_URI),
    peers = new GrpcPeers(),
    service = new TutorService(store, peers);
  const seeded = [];
  try {
    for (const pair of requested) {
      const accounts = await peers.accounts([pair.userId, pair.adminUserId]);
      const student = accounts.find((account) => account.id === pair.userId),
        admin = accounts.find((account) => account.id === pair.adminUserId);
      if (
        !student ||
        !student.email.endsWith(".test") ||
        student.status !== "ACTIVE" ||
        !student.capabilities.includes("STUDENT") ||
        !admin ||
        !admin.email.endsWith(".test") ||
        admin.status !== "ACTIVE" ||
        !admin.capabilities.includes("ADMIN")
      )
        throw new Error(
          "Seed needs existing active synthetic Student and Admin accounts",
        );
      const actor = fixtureActor(student.id, student.capabilities),
        adminActor = fixtureActor(admin.id, admin.capabilities);
      actor.sessionId = randomUUID();
      adminActor.sessionId = randomUUID();
      seeded.push(
        await seedApprovedTutor(service, actor, adminActor, student.id),
      );
    }
    console.log(JSON.stringify({ items: seeded }));
  } finally {
    peers.close();
    await store.client.close();
  }
}
if (require.main === module)
  main().catch(() => {
    console.error(
      "Tutor seed failed. Review synthetic account configuration and pending activation.",
    );
    process.exitCode = 1;
  });
