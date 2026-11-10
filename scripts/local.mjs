import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

// This creates disposable local-only credentials in process environments. It
// never prints or saves them. For persistent environments supply stable values
// through your approved secret manager; a fresh invocation otherwise rotates
// credentials and requires a fresh, isolated Compose project.
const action = process.argv[2] || "up";
if (!["up", "down", "logs", "ps", "restart", "stop"].includes(action))
  throw new Error("Use up, down, logs, ps, restart or stop");
const env = { ...process.env };
const secrets = [
  "JWT_SECRET",
  "RESET_CONTENT_KEY",
  "IDEMPOTENCY_SECRET",
  "POSTGRES_PASSWORD",
  "AUTH_DB_PASSWORD",
  "BOOKING_DB_PASSWORD",
  "WALLET_DB_PASSWORD",
  "MONGO_INITDB_ROOT_PASSWORD",
  "MONGO_CLUSTER_KEY",
  "TUTOR_DB_PASSWORD",
  "REVIEW_DB_PASSWORD",
  "MESSAGING_DB_PASSWORD",
  "NOTIFICATION_DB_PASSWORD",
  "GATEWAY_WORKLOAD_CREDENTIAL",
  "TUTOR_WORKLOAD_CREDENTIAL",
  "BOOKING_WORKLOAD_CREDENTIAL",
  "WALLET_WORKLOAD_CREDENTIAL",
  "REVIEW_WORKLOAD_CREDENTIAL",
  "MESSAGING_WORKLOAD_CREDENTIAL",
  "NOTIFICATION_WORKLOAD_CREDENTIAL",
];
secrets.push(
  "RABBITMQ_AUTH_PASSWORD",
  "RABBITMQ_TUTOR_PASSWORD",
  "RABBITMQ_REVIEW_PASSWORD",
  "RABBITMQ_BOOKING_PASSWORD",
  "RABBITMQ_MESSAGING_PASSWORD",
  "RABBITMQ_WALLET_PASSWORD",
  "RABBITMQ_NOTIFICATION_PASSWORD",
  "PAYOUT_FINGERPRINT_KEY",
  "AUTH_WORKLOAD_CREDENTIAL",
);
if (action === "up") {
  if (secrets.some((name) => !env[name])) {
    if (!env.COMPOSE_PROJECT_NAME)
      throw new Error(
        "Set a NEW COMPOSE_PROJECT_NAME for disposable credentials, or supply all stable runtime variables. See docs/platform.md.",
      );
    const existing = spawnSync(
      env.CONTAINER_CLI || "docker",
      [
        "volume",
        "ls",
        "--filter",
        `label=com.docker.compose.project=${env.COMPOSE_PROJECT_NAME}`,
        "--format",
        "{{.Name}}",
      ],
      { encoding: "utf8" },
    );
    if (existing.status !== 0)
      throw new Error(
        "Cannot inspect isolated project volumes; no startup attempted.",
      );
    if (existing.stdout.trim())
      throw new Error(
        "Project has existing storage. Supply stable approved runtime values to recreate it, or use restart without rotating credentials.",
      );
    for (const name of secrets) env[name] ||= randomBytes(32).toString("hex");
  }
  if (!env.ACTOR_ASSERTION_PRIVATE_KEY || !env.ACTOR_ASSERTION_PUBLIC_KEY) {
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    env.ACTOR_ASSERTION_PRIVATE_KEY = pair.privateKey;
    env.ACTOR_ASSERTION_PUBLIC_KEY = pair.publicKey;
  }
}
// Compose interpolates even unused services, so use non-secret sentinels for
// read/stop actions. No environment values are written or shown to the user.
if (action !== "up")
  for (const name of [
    ...secrets,
    "ACTOR_ASSERTION_PRIVATE_KEY",
    "ACTOR_ASSERTION_PUBLIC_KEY",
  ])
    env[name] ||= "unused-for-stop-or-inspection";
const executable = env.CONTAINER_CLI || "docker";
const args = ["compose", "-f", "compose.yaml", action];
if (action === "up") args.push("--build");
const child = spawn(executable, args, { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("error", () => {
  console.error(
    "Container CLI unavailable. Install Docker Compose or select CONTAINER_CLI.",
  );
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
