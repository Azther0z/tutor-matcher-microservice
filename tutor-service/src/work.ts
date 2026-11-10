import "dotenv/config";
import { validateRequest } from "@tutor-matcher/shared";
import { connectStore, retryExhaustedWork } from "./store";
async function main() {
  const [kind, id, action] = process.argv.slice(2);
  if (
    !["grants", "outbox"].includes(kind) ||
    !id ||
    ![undefined, "retry"].includes(action)
  )
    throw new Error("Usage: work <grants|outbox> <uuid> [retry]");
  validateRequest("Id", id);
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  const store = await connectStore(process.env.MONGO_URI);
  try {
    const collection = store.db.collection(kind);
    const found = await collection.findOne({ _id: id as never });
    if (!found) throw new Error("Work was not found");
    if (action === "retry") {
      if (found.state !== "NEEDS_ATTENTION")
        throw new Error("Only exhausted work can be manually retried");
      await retryExhaustedWork(store.db, kind as "grants" | "outbox", id);
    }
    const current = await collection.findOne({ _id: found._id });
    console.log(
      JSON.stringify({
        id,
        kind,
        state: current!.state,
        attempts: current!.attempts,
        attemptLimit: current!.attemptLimit ?? 10,
        lastError: current!.lastError ?? null,
      }),
    );
  } finally {
    await store.client.close();
  }
}
main().catch(() => {
  console.error(
    "Tutor work command failed. Check the work identity and owned database.",
  );
  process.exitCode = 1;
});
