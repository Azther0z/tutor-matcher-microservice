import "dotenv/config";
import { connectStore } from "./store";
async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  const store = await connectStore(process.env.MONGO_URI);
  await store.client.close();
  console.log("Tutor indexes are ready.");
}
main().catch(() => {
  console.error("Tutor migration failed.");
  process.exitCode = 1;
});
