import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// One-shot local demo: `npm run demo`.
//
// Starts every service that has source in this repository, seeds the synthetic
// demo data and checks the public gateway. Runtime credentials live in its own
// git-ignored `.env.demo` (your `.env` is never read or changed); missing ones
// are generated once and never printed, so the demo can be stopped and started
// again with the same data.
//
//   npm run demo               start (builds images the first time)
//   npm run demo -- status     show containers and live checks
//   npm run demo -- logs       follow logs
//   npm run demo -- down       stop and remove containers (data is kept)
//   npm run demo -- reset --yes  also delete this demo's database volumes

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env.demo");
const project = process.env.COMPOSE_PROJECT_NAME || "tutor-matcher-demo";
const docker = process.env.CONTAINER_CLI || "docker";
const [action = "up", ...flags] = process.argv.slice(2);

const WEB_URL = "http://localhost:3000";
const GATEWAY_URL = "http://127.0.0.1:8080";
const SERVICES = [
  "postgres",
  "rabbitmq",
  "rabbitmq-provision",
  "docker-api",
  "auth-service",
  "api-gateway",
  "web",
  "mongo",
  "mongo-init",
  "tutor-service",
  "review-service",
  "wallet-service",
  "notification-service",
  "booking-service",
  "messaging-service",
];
const SECRETS = [
  "JWT_SECRET",
  "RESET_CONTENT_KEY",
  "IDEMPOTENCY_SECRET",
  "PAYOUT_FINGERPRINT_KEY",
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
  "RABBITMQ_AUTH_PASSWORD",
  "RABBITMQ_TUTOR_PASSWORD",
  "RABBITMQ_REVIEW_PASSWORD",
  "RABBITMQ_BOOKING_PASSWORD",
  "RABBITMQ_MESSAGING_PASSWORD",
  "RABBITMQ_WALLET_PASSWORD",
  "RABBITMQ_NOTIFICATION_PASSWORD",
  "AUTH_WORKLOAD_CREDENTIAL",
  "GATEWAY_WORKLOAD_CREDENTIAL",
  "TUTOR_WORKLOAD_CREDENTIAL",
  "BOOKING_WORKLOAD_CREDENTIAL",
  "WALLET_WORKLOAD_CREDENTIAL",
  "REVIEW_WORKLOAD_CREDENTIAL",
  "MESSAGING_WORKLOAD_CREDENTIAL",
  "NOTIFICATION_WORKLOAD_CREDENTIAL",
  "AUTH_DEMO_PASSWORD",
];
// Five approved demo tutors. The first is the long-standing candidate account.
const TUTORS = [
  {
    userId: "10000000-0000-4000-8000-000000000003",
    email: "candidate.demo@example.test",
    name: "Alice Johnson",
    profile: {
      headline: "Demonstration tutor",
      bio: "Synthetic demonstration tutor. No real identification documents are used.",
      subject: {
        name: "Mathematics",
        description: "Synthetic algebra and calculus offering.",
        hourlyRate: "400.00",
        learningAreas: ["mathematics"],
      },
    },
  },
  {
    userId: "10000000-0000-4000-8000-000000000004",
    email: "nara.demo@example.test",
    name: "Nara Wongsa",
    profile: {
      headline: "IELTS and conversational English",
      bio: "Synthetic demonstration tutor. Speaking practice and IELTS strategies.",
      subject: {
        name: "English Conversation and IELTS",
        description:
          "Speaking confidence, vocabulary and IELTS writing feedback.",
        hourlyRate: "550.00",
        learningAreas: ["english"],
      },
    },
  },
  {
    userId: "10000000-0000-4000-8000-000000000005",
    email: "kitti.demo@example.test",
    name: "Kitti Suriyan",
    profile: {
      headline: "Physics made visual",
      bio: "Synthetic demonstration tutor. Mechanics, electricity and olympiad problems.",
      subject: {
        name: "Physics",
        description:
          "Mechanics, waves and electricity, from basics to olympiad level.",
        hourlyRate: "480.00",
        learningAreas: ["physics", "science"],
      },
    },
  },
  {
    userId: "10000000-0000-4000-8000-000000000006",
    email: "mali.demo@example.test",
    name: "Mali Chaiyo",
    profile: {
      headline: "Python for absolute beginners",
      bio: "Synthetic demonstration tutor. Friendly, project-based programming lessons.",
      subject: {
        name: "Python Programming",
        description:
          "Variables to small projects, with code review after every session.",
        hourlyRate: "650.00",
        learningAreas: ["computer-programming"],
      },
    },
  },
  {
    userId: "10000000-0000-4000-8000-000000000007",
    email: "ben.demo@example.test",
    name: "Ben Carter",
    profile: {
      headline: "Business and academic writing",
      bio: "Synthetic demonstration tutor. Structure, clarity and persuasive writing.",
      subject: {
        name: "Academic Writing",
        description:
          "Essay structure, argument and editing for reports and applications.",
        hourlyRate: "500.00",
        learningAreas: ["academic-writing", "business"],
      },
    },
  },
];
const ACCOUNTS = {
  admin: "10000000-0000-4000-8000-000000000001",
  student: "10000000-0000-4000-8000-000000000002",
  candidate: "10000000-0000-4000-8000-000000000003",
};

const say = (message = "") => console.log(message);
const fail = (message) => {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
};

/** Names defined in `.env.demo`. Values are never read into output. */
function definedNames() {
  if (!existsSync(envFile)) return new Map();
  const names = new Map();
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/.exec(line);
    if (match) names.set(match[1], match[2].trim() !== "");
  }
  return names;
}

/** Appends whatever runtime credentials are missing from `.env.demo`, silently. */
function ensureCredentials() {
  const names = definedNames();
  const missing = SECRETS.filter((name) => !names.get(name));
  const needKeys =
    !names.get("ACTOR_ASSERTION_PRIVATE_KEY") ||
    !names.get("ACTOR_ASSERTION_PUBLIC_KEY");
  if (missing.length === 0 && !needKeys) return 0;
  const lines = missing.map(
    (name) => `${name}=${randomBytes(32).toString("hex")}`,
  );
  if (needKeys) {
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    // Compose expands \n inside double quotes, so each PEM stays on one line.
    const quoted = (pem) => `"${pem.trim().replace(/\n/g, "\\n")}"`;
    lines.push(
      `ACTOR_ASSERTION_PRIVATE_KEY=${quoted(pair.privateKey)}`,
      `ACTOR_ASSERTION_PUBLIC_KEY=${quoted(pair.publicKey)}`,
    );
  }
  const existed = existsSync(envFile);
  const prefix =
    existed && !readFileSync(envFile, "utf8").endsWith("\n") ? "\n" : "";
  appendFileSync(envFile, `${prefix}${lines.join("\n")}\n`, { mode: 0o600 });
  if (!existed) chmodSync(envFile, 0o600);
  return lines.length;
}

function composeArgs(...rest) {
  return [
    "compose",
    "--env-file",
    envFile,
    "-p",
    project,
    "-f",
    join(root, "compose.yaml"),
    ...rest,
  ];
}

function run(args, { quiet = false, capture = false, input } = {}) {
  const result = spawnSync(docker, args, {
    cwd: root,
    encoding: "utf8",
    input,
    stdio:
      quiet || capture
        ? ["pipe", "pipe", capture ? "inherit" : "pipe"]
        : ["pipe", "inherit", "inherit"],
    env: { ...process.env, COMPOSE_PROJECT_NAME: project },
  });
  if (capture && result.stdout) process.stdout.write(result.stdout);
  return result;
}

function stream(args) {
  return new Promise((resolve) => {
    const child = spawn(docker, args, {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, COMPOSE_PROJECT_NAME: project },
    });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => child.kill(signal));
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

const portInUse = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });

function projectRunning() {
  const result = run(composeArgs("ps", "-q", "api-gateway"), { quiet: true });
  return result.status === 0 && result.stdout.trim() !== "";
}

function preflight() {
  const info = spawnSync(docker, ["info"], { encoding: "utf8" });
  if (info.error || info.status !== 0)
    fail(
      "Docker is not running. Start Docker Desktop and run `npm run demo` again.",
    );
}

async function checkPorts() {
  if (projectRunning()) return;
  for (const [port, what] of [
    [3000, "web"],
    [8080, "gateway"],
  ]) {
    if (await portInUse(port))
      fail(
        `Port ${port} (${what}) is already in use. Stop whatever is using it (see \`lsof -i :${port}\`) and run \`npm run demo\` again.`,
      );
  }
}

function selectedServices() {
  return [...SERVICES];
}

function seed() {
  say("\n→ Seeding synthetic demo data");
  const auth = run(
    composeArgs(
      "exec",
      "-T",
      "auth-service",
      "npm",
      "run",
      "seed",
      "--workspace",
      "services/auth-service",
    ),
  );
  if (auth.status !== 0)
    fail(
      "Seeding the demo accounts failed. Run `npm run demo -- logs` to see why.",
    );
  const tutor = run(
    composeArgs(
      "exec",
      "-T",
      "-e",
      `TUTOR_SEED_USERS=${JSON.stringify(TUTORS.map((tutor) => ({ userId: tutor.userId, adminUserId: ACCOUNTS.admin, profile: tutor.profile })))}`,
      "tutor-service",
      "npm",
      "run",
      "seed",
      "--workspace",
      "services/tutor-service",
    ),
    { capture: true },
  );
  if (tutor.status !== 0) {
    say(
      "  ! The demo tutor could not be seeded (the tutor service may still be starting). Run `npm run demo` again to retry.",
    );
    return;
  }
  // The tutor seed prints {"items":[{userId,tutorId,subjectId}]}; Booking opens demo availability for those tutors.
  let tutors = [];
  try {
    const lastJson = tutor.stdout
      .split("\n")
      .reverse()
      .find((line) => line.trim().startsWith("{"));
    tutors = JSON.parse(lastJson ?? "{}").items ?? [];
  } catch {
    tutors = [];
  }
  const booking = run(
    composeArgs(
      "exec",
      "-T",
      "-e",
      `BOOKING_SEED_TUTORS=${JSON.stringify(tutors)}`,
      "-e",
      `BOOKING_SEED_FIXTURE=${JSON.stringify({ studentUserId: ACCOUNTS.student, studentName: "Bob Smith", tutorName: TUTORS[0].name, tutor: tutors.find((t) => t.userId === TUTORS[0].userId), subject: { name: TUTORS[0].profile.subject.name, description: TUTORS[0].profile.subject.description, hourlyRate: TUTORS[0].profile.subject.hourlyRate } })}`,
      "booking-service",
      "npm",
      "run",
      "seed",
      "--workspace",
      "services/booking-service",
    ),
  );
  if (booking.status !== 0)
    say(
      "  ! Demo availability could not be seeded. Run `npm run demo` again to retry.",
    );
  const messaging = run(
    composeArgs(
      "exec",
      "-T",
      "-e",
      `MESSAGING_SEED=${JSON.stringify({
        studentUserId: ACCOUNTS.student,
        studentName: "Bob Smith",
        tutorUserId: TUTORS[0].userId,
        tutorName: TUTORS[0].name,
        messages: [
          {
            from: "STUDENT",
            text: "Hi Alice, could we go through limits and derivatives before my exam?",
          },
          {
            from: "TUTOR",
            text: "Of course! Book a half-hour slot and send me the topics you find hardest.",
          },
        ],
      })}`,
      "messaging-service",
      "npm",
      "run",
      "seed",
      "--workspace",
      "services/messaging-service",
    ),
  );
  if (messaging.status !== 0)
    say("  ! The demo conversation could not be seeded.");
}

async function probe(path, init) {
  try {
    const response = await fetch(`${GATEWAY_URL}${path}`, {
      ...init,
      signal: AbortSignal.timeout(8000),
    });
    return response.status;
  } catch {
    return 0;
  }
}

async function liveChecks() {
  const web = await fetch(WEB_URL, { signal: AbortSignal.timeout(8000) })
    .then((response) => response.status)
    .catch(() => 0);
  const checks = [
    ["Web app", web === 200, `${WEB_URL} → ${web || "no answer"}`],
    [
      "Sign in / sign up (auth)",
      (await probe("/api/auth/me")) === 401,
      "gateway → auth service",
    ],
    [
      "Bookings (booking service)",
      (await probe("/api/bookings")) === 401,
      "GET /api/bookings (needs sign-in)",
    ],
    [
      "Messages (messaging service)",
      (await probe("/api/messages/inbox")) === 401,
      "GET /api/messages/inbox (needs sign-in)",
    ],
    [
      "Find tutors (tutor service)",
      (await probe("/api/discovery/tutors?pageSize=1")) === 200,
      "GET /api/discovery/tutors",
    ],
  ];
  say("\nLive checks");
  for (const [name, ok, detail] of checks)
    say(`  ${ok ? "✔" : "✖"} ${name.padEnd(28)} ${detail}`);
  return checks.every(([, ok]) => ok);
}

function summary(healthy) {
  say(`\n${healthy ? "✔ Demo is ready" : "! Demo started with problems"}\n`);
  say(`  App      ${WEB_URL}`);
  say(`  Gateway  ${GATEWAY_URL}`);
  say("\n  Demo accounts (password: AUTH_DEMO_PASSWORD in .env.demo)");
  say("    admin.demo@example.test       Carol Davis, administrator");
  say("    piranat.admin@example.test    Piranat Wadlom, administrator");
  say(
    "    student.demo@example.test     Bob Smith, student (has a finished lesson to review)",
  );
  for (const tutor of TUTORS)
    say(
      `    ${tutor.email.padEnd(29)} ${tutor.name}, tutor: ${tutor.profile.subject.name}`,
    );
  say("\n  npm run demo -- logs     follow logs");
  say("  npm run demo -- down     stop (data is kept)");
  say("  npm run demo -- reset --yes   stop and delete this demo's data\n");
}

async function up() {
  preflight();
  await checkPorts();
  const added = ensureCredentials();
  if (added)
    say(
      `→ Added ${added} missing runtime value(s) to .env.demo (git-ignored, not printed)`,
    );
  say(
    `→ Starting the stack as Compose project "${project}" (first run builds images; this can take several minutes)`,
  );
  const code = await stream(
    composeArgs(
      "--profile",
      "target",
      "up",
      "-d",
      "--build",
      "--wait",
      "--wait-timeout",
      "420",
      ...selectedServices(),
    ),
  );
  if (code !== 0)
    fail(
      "Compose could not start the stack. Run `npm run demo -- logs` for details.",
    );
  seed();
  summary(await liveChecks());
}

async function main() {
  if (!["up", "status", "logs", "down", "reset"].includes(action))
    fail("Use one of: up, status, logs, down, reset --yes");
  if (action === "up") return up();
  preflight();
  ensureCredentials();
  if (action === "status") {
    run(composeArgs("ps"));
    return void (await liveChecks());
  }
  if (action === "logs")
    return void (process.exitCode = await stream(
      composeArgs("logs", "-f", "--tail", "100"),
    ));
  if (action === "down")
    return void (process.exitCode =
      run(composeArgs("--profile", "target", "down")).status ?? 1);
  if (!flags.includes("--yes"))
    fail(
      `Reset deletes the database volumes of project "${project}". Run \`npm run demo -- reset --yes\` to confirm.`,
    );
  process.exitCode =
    run(composeArgs("--profile", "target", "down", "--volumes")).status ?? 1;
}

main();
