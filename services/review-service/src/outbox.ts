import { loadRuntimeEnv } from "./runtime";
import "dotenv/config";
import { MongoClient } from "mongodb";
async function main() {
  loadRuntimeEnv();
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required.");
  const client = await new MongoClient(process.env.MONGO_URI).connect();
  try {
    const collection = client.db("review_db").collection("outbox");
    const [action, id] = process.argv.slice(2);
    if (action === "retry" && id && /^[0-9a-f-]{36}$/.test(id)) {
      const result = await collection.updateOne(
        { id, sentAt: null },
        {
          $set: {
            attempts: 0,
            needsAttentionAt: null,
            nextAttemptAt: new Date(0),
            leaseUntil: new Date(0),
          },
          $inc: { fence: 1 },
        },
      );
      process.stdout.write(
        result.matchedCount
          ? "Original event is scheduled for retry.\n"
          : "Pending event was not found.\n",
      );
    } else if (action === "inspect") {
      const rows = await collection
        .find(
          { sentAt: null },
          {
            projection: {
              _id: 0,
              id: 1,
              attempts: 1,
              needsAttentionAt: 1,
              lastError: 1,
              nextAttemptAt: 1,
              fence: 1,
            },
          },
        )
        .toArray();
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    } else throw new Error("Use inspect or retry <eventId>.");
  } finally {
    await client.close();
  }
}
void main().catch(() => {
  process.stderr.write("Review outbox command failed.\n");
  process.exitCode = 1;
});
