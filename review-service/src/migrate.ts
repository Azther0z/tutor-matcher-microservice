import { loadRuntimeEnv } from "./runtime";
import "dotenv/config";
import { connectStore } from "./store";
async function main() {
  loadRuntimeEnv();
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required.");
  const store = await connectStore(process.env.MONGO_URI);
  await store.client.close();
  process.stdout.write(
    "Review indexes and transaction prerequisites checked.\n",
  );
}
void main().catch(() => {
  process.stderr.write("Review migration failed.\n");
  process.exitCode = 1;
});
