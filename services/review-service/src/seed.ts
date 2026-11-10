import { loadRuntimeEnv } from "./runtime";
import "dotenv/config";
import { connectStore } from "./store";
import { syntheticIds } from "./fixtures";
import type { Review } from "./types";
async function main() {
  loadRuntimeEnv();
  if (process.env.REVIEW_SEED_SYNTHETIC !== "1")
    throw new Error(
      "Set REVIEW_SEED_SYNTHETIC=1 for the synthetic review fixture.",
    );
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required.");
  const store = await connectStore(process.env.MONGO_URI);
  try {
    const review: Review = {
      id: "77777777-7777-4777-8777-777777777777",
      bookingId: "88888888-8888-4888-8888-888888888888",
      studentUserId: syntheticIds.student,
      tutorId: syntheticIds.tutor,
      tutorUserId: syntheticIds.tutorUser,
      subjectId: syntheticIds.subject,
      rating: 5,
      text: "Synthetic historical fixture for the local demo.",
      headline: "Synthetic fixture",
      reply: null,
      visibility: "PUBLIC",
      revision: "0",
      createdAt: "2026-11-01T03:00:00.000Z",
      studentDisplayName: "Synthetic Student",
    };
    await store.transaction(async (tx) => {
      if (!(await tx.getReview(review.id))) await tx.insertReview(review);
    });
    process.stdout.write(
      "Synthetic historical review fixture is available. It is not completion evidence.\n",
    );
  } finally {
    await store.client.close();
  }
}
void main().catch(() => {
  process.stderr.write("Review seed failed.\n");
  process.exitCode = 1;
});
