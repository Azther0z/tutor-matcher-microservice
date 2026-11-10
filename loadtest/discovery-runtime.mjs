import { spawn } from "node:child_process";
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  createHash,
} from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  readdir,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const owners = [
  "AUTH",
  "GATEWAY",
  "TUTOR",
  "BOOKING",
  "REVIEW",
  "WALLET",
  "MESSAGING",
  "NOTIFICATION",
];
const services = [
  "postgres",
  "mongo",
  "mongo-init",
  "rabbitmq",
  "rabbitmq-provision",
  "docker-api",
  "api-gateway",
  "internal-traefik",
  "auth-service",
  "tutor-service",
  "booking-service",
  "review-service",
];

export async function createRuntime() {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const project = `discovery-${randomBytes(5).toString("hex")}`;
  const directory = resolve(
    root,
    process.env.DISCOVERY_OUTPUT || `.runtime/discovery/${id}`,
  );
  const relative = directory.slice(root.length + 1);
  if (
    !directory.startsWith(`${root}/`) ||
    !(
      relative.startsWith(".runtime/") ||
      relative.startsWith("loadtest/results/")
    )
  )
    throw new Error(
      "DISCOVERY_OUTPUT must be a new directory in .runtime/ or loadtest/results/.",
    );
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
  const env = {
    ...process.env,
    COMPOSE_PROJECT_NAME: project,
    DISCOVERY_OUTPUT: directory,
    DISCOVERY_IMAGE_TAG: project,
  };
  for (const key of [
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
    "AUTH_DEMO_PASSWORD",
    ...["TUTOR", "REVIEW", "MESSAGING", "NOTIFICATION"].map(
      (owner) => `${owner}_DB_PASSWORD`,
    ),
    ...owners.map((owner) => `${owner}_WORKLOAD_CREDENTIAL`),
    ...owners
      .filter((owner) => owner !== "GATEWAY")
      .map((owner) => `RABBITMQ_${owner}_PASSWORD`),
  ])
    env[key] = randomBytes(32).toString("hex");
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  env.ACTOR_ASSERTION_PRIVATE_KEY = pair.privateKey;
  env.ACTOR_ASSERTION_PUBLIC_KEY = pair.publicKey;
  const port = Number(process.env.DISCOVERY_PORT || 18080);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid DISCOVERY_PORT");
  env.DISCOVERY_PORT = String(port);
  const base = `http://127.0.0.1:${port}`;
  const composeArgs = [
    "compose",
    "--env-file",
    "/dev/null",
    "-p",
    project,
    "-f",
    "compose.yaml",
    "-f",
    "loadtest/compose.performance.yaml",
    "--profile",
    "target",
    "--profile",
    "performance",
  ];
  let started = false,
    replicas = 1;
  async function command(
    binary,
    args,
    { accepted = [0], log, timeout = 600000 } = {},
  ) {
    return new Promise((done, reject) => {
      const child = spawn(binary, args, {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", async (code) => {
        clearTimeout(timer);
        if (log) await writeFile(resolve(directory, log), stdout + stderr);
        if (!accepted.includes(code))
          return reject(
            new Error(
              `${binary} ${args.slice(0, 2).join(" ")} exited ${code}; ${log ? `see ${log}` : stderr.slice(-1200)}`,
            ),
          );
        done({ stdout, stderr, code });
      });
    });
  }
  const docker = (args, options) => command("docker", args, options);
  const compose = (args, options) => docker([...composeArgs, ...args], options);
  const write = (name, data) => {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name))
      throw new Error("Unsafe artifact name");
    return writeFile(
      resolve(directory, name),
      typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`,
    );
  };
  const metadata = {
    id,
    project,
    startedAt: new Date().toISOString(),
    baseRevision: (await command("git", ["rev-parse", "HEAD"])).stdout.trim(),
    platform: `${os.platform()}/${os.arch()}`,
    hostCpus: os.cpus().length,
    hostMemoryBytes: os.totalmem(),
    configs: ["1/1/1", "3/1/1"],
    k6Image: "grafana/k6:1.6.1",
    datasetSweep: false,
  };
  const sources = (await readdir(resolve(root, "loadtest")))
    .filter((file) => /discovery|compose.performance/.test(file))
    .sort();
  const fingerprint = createHash("sha256");
  for (const file of sources)
    fingerprint
      .update(file)
      .update(await readFile(resolve(root, "loadtest", file)));
  metadata.loadtestSourceSha256 = fingerprint.digest("hex");
  function stableContainers(current, previous) {
    const required = services.filter(
      (service) => !["mongo-init", "rabbitmq-provision"].includes(service),
    );
    return required.every((service) => {
      const items = current.filter((item) => item.service === service);
      return (
        items.length === (service === "tutor-service" ? replicas : 1) &&
        items.every(
          (item) =>
            item.status === "running" &&
            !item.oomKilled &&
            item.health !== "unhealthy" &&
            item.restarts ===
              (previous.find((old) => old.id === item.id)?.restarts ?? 0),
        )
      );
    });
  }
  async function inspect() {
    const ids = (
      await docker([
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ])
    ).stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!ids.length) throw new Error("Experiment containers are missing");
    const values = JSON.parse((await docker(["inspect", ...ids])).stdout);
    return values.map((item) => ({
      id: item.Id,
      name: item.Name.replace(/^\//, ""),
      service: item.Config.Labels["com.docker.compose.service"],
      image: item.Image,
      status: item.State.Status,
      health: item.State.Health?.Status,
      oomKilled: item.State.OOMKilled,
      restarts: item.RestartCount,
      nanoCpus: item.HostConfig.NanoCpus,
      memoryBytes: item.HostConfig.Memory,
    }));
  }
  async function sample(label) {
    const containers = await inspect();
    const ids = containers
      .filter((item) => item.status === "running")
      .map((item) => item.id);
    const stats = ids.length
      ? (
          await docker(
            ["stats", "--no-stream", "--all", "--format", "{{json .}}", ...ids],
            { accepted: [0, 1] },
          )
        ).stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    if (stats.length < ids.length)
      throw new Error("Incomplete Docker resource samples");
    const result = {
      timestamp: new Date().toISOString(),
      label,
      containers,
      stats,
    };
    await appendFile(
      resolve(directory, "resources.jsonl"),
      `${JSON.stringify(result)}\n`,
    );
    return result;
  }
  async function pressure(label) {
    const postgres = await compose([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-tAc",
      "SELECT json_agg(x) FROM (SELECT datname,numbackends,xact_commit,xact_rollback,blks_read,blks_hit,temp_bytes,deadlocks FROM pg_stat_database WHERE datname IN ('auth_db','booking_db')) x;",
    ]);
    const mongo = await compose([
      "exec",
      "-T",
      "mongo",
      "mongosh",
      "--quiet",
      "--eval",
      'const a=db.getSiblingDB("admin");a.auth(process.env.MONGO_INITDB_ROOT_USERNAME,process.env.MONGO_INITDB_ROOT_PASSWORD);const s=a.serverStatus();print(JSON.stringify({connections:s.connections,opcounters:s.opcounters,mem:s.mem,globalLock:s.globalLock}));',
    ]);
    await appendFile(
      resolve(directory, "database-pressure.jsonl"),
      `${JSON.stringify({ timestamp: new Date().toISOString(), label, postgres: JSON.parse(postgres.stdout.trim() || "null"), mongo: JSON.parse(mongo.stdout.trim().split("\n").at(-1)) })}\n`,
    );
  }
  async function readiness() {
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        const containers = await inspect();
        if (
          [
            "auth-service",
            "tutor-service",
            "booking-service",
            "review-service",
            "api-gateway",
            "internal-traefik",
          ].every(
            (service) =>
              containers.filter(
                (c) => c.service === service && c.health === "healthy",
              ).length === (service === "tutor-service" ? replicas : 1),
          )
        ) {
          const response = await fetch(
            `${base}/api/discovery/tutors?pageSize=1`,
            { signal: AbortSignal.timeout(10000) },
          );
          if (response.ok) return;
        }
      } catch {
        /* Readiness failures are retried before any measurement. */
      }
      await sleep(2000);
    }
    throw new Error(
      "Real discovery stack did not become ready within three minutes",
    );
  }
  let cleaning;
  const cleanup = async () => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    if (!cleaning && started)
      cleaning = compose(["down", "-v", "--remove-orphans"], {
        log: "cleanup.txt",
        timeout: 120000,
      });
    await cleaning;
  };
  const interrupted = async (code) => {
    try {
      await docker(["stop", "-t", "2", `${project}-generator`], {
        accepted: [0, 1],
        timeout: 10000,
      });
      await cleanup();
    } finally {
      process.exit(code);
    }
  };
  const interrupt = () => void interrupted(130);
  const terminate = () => void interrupted(143);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  return {
    directory,
    metadata,
    write,
    sample,
    async start() {
      const info = JSON.parse(
        (await docker(["info", "--format", "{{json .}}"])).stdout,
      );
      metadata.engine = {
        version: info.ServerVersion,
        cpus: info.NCPU,
        memoryBytes: info.MemTotal,
        operatingSystem: info.OperatingSystem,
      };
      if (info.NCPU < 8 || info.MemTotal < 7 * 1024 ** 3)
        throw new Error(
          "Experiment requires at least 8 Docker CPUs and 7 GiB RAM to avoid overcommitting declared budgets",
        );
      // Reserve a new project: never rotate credentials against existing storage.
      const existing = (
        await docker([
          "volume",
          "ls",
          "-q",
          "--filter",
          `label=com.docker.compose.project=${project}`,
        ])
      ).stdout.trim();
      if (existing)
        throw new Error(
          "Fresh experiment project unexpectedly has existing storage",
        );
      const config = JSON.parse(
        (await compose(["config", "--format", "json"])).stdout,
      );
      metadata.resourceLimits = Object.fromEntries(
        [...services, "load-generator"]
          .filter((service) => config.services[service])
          .map((service) => [
            service,
            {
              cpus: config.services[service].cpus ?? null,
              memoryBytes: config.services[service].mem_limit ?? null,
            },
          ]),
      );
      const measuredServices = [...services, "load-generator"].filter(
        (service) => !["mongo-init", "rabbitmq-provision"].includes(service),
      );
      metadata.peakBudget = measuredServices.reduce(
        (total, service) => {
          const count = service === "tutor-service" ? 3 : 1;
          const limits = metadata.resourceLimits[service];
          if (!(limits.cpus > 0) || !(limits.memoryBytes > 0))
            throw new Error(`Missing explicit resource limits for ${service}`);
          return {
            cpus: total.cpus + Number(limits.cpus) * count,
            memoryBytes: total.memoryBytes + Number(limits.memoryBytes) * count,
          };
        },
        { cpus: 0, memoryBytes: 0 },
      );
      if (
        metadata.peakBudget.cpus > info.NCPU ||
        metadata.peakBudget.memoryBytes > info.MemTotal * 0.9
      )
        throw new Error(
          "Declared peak budgets exceed available Docker capacity with memory headroom",
        );
      started = true;
      await compose(
        [
          "build",
          "auth-service",
          "tutor-service",
          "booking-service",
          "review-service",
        ],
        { log: "build.txt", timeout: 1200000 },
      );
      await compose(["pull", "load-generator"], { log: "pull-k6.txt" });
      await compose(["up", "-d", ...services], { log: "startup.txt" });
      await readiness();
      await compose(
        [
          "exec",
          "-T",
          "auth-service",
          "npm",
          "run",
          "seed",
          "--workspace",
          "@tutor-matcher/auth-service",
        ],
        { log: "seed-auth.txt" },
      );
      metadata.containers = await inspect();
      await write("environment.json", metadata);
    },
    async prepare() {
      const response = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": randomUUID(),
        },
        body: JSON.stringify({
          email: "admin.demo@example.test",
          password: env.AUTH_DEMO_PASSWORD,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok)
        throw new Error(`Synthetic Admin login failed (${response.status})`);
      const { token } = await response.json();
      if (!token) throw new Error("Synthetic Admin session missing");
      const prepared = await new Promise((done, reject) => {
        const child = spawn(
          process.execPath,
          ["loadtest/prepare-discovery.mjs"],
          {
            cwd: root,
            env: {
              ...env,
              BASE_URL: base,
              SYNTHETIC_LOADTEST: "true",
              LOADTEST_ADMIN_TOKEN: token,
              FIXTURE_OUTPUT: resolve(directory, "fixture.json"),
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), 600000);
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          output += chunk;
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", async (code) => {
          clearTimeout(timer);
          await write("fixture-preparation.txt", output);
          code === 0
            ? done(true)
            : reject(
                new Error(
                  "Fixture preparation failed; see fixture-preparation.txt",
                ),
              );
        });
      });
      const fixture = JSON.parse(
        await readFile(resolve(directory, "fixture.json"), "utf8"),
      );
      const first = fixture.items[0];
      const lesson = {
        studentUserId: "10000000-0000-4000-8000-000000000002",
        studentName: "Bob Smith",
        tutorName: first.tutorDisplayName,
        tutor: {
          userId: first.userId,
          tutorId: first.tutorId,
          subjectId: first.subjectId,
        },
        subject: {
          name: first.subjectName,
          description: first.description,
          hourlyRate: first.hourlyRate,
        },
      };
      // Booking owns this historical synthetic fixture. Review still validates
      // eligibility through the real Booking service before accepting a review.
      await compose(
        [
          "exec",
          "-T",
          "-e",
          "BOOKING_SEED_TUTORS=[]",
          "-e",
          `BOOKING_SEED_FIXTURE=${JSON.stringify(lesson)}`,
          "booking-service",
          "npm",
          "run",
          "seed",
          "--workspace",
          "@tutor-matcher/booking-service",
        ],
        { log: "seed-historical-lesson.txt" },
      );
      const bookingId = (
        await compose([
          "exec",
          "-T",
          "booking-service",
          "node",
          "-e",
          'process.stdout.write(require("./services/booking-service/dist/ids.js").derivedId("fixture:completed-lesson"))',
        ])
      ).stdout.trim();
      const studentLogin = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": randomUUID(),
        },
        body: JSON.stringify({
          email: "student.demo@example.test",
          password: env.AUTH_DEMO_PASSWORD,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!studentLogin.ok) throw new Error("Synthetic Student login failed");
      const student = await studentLogin.json();
      const reviewed = await fetch(`${base}/api/bookings/${bookingId}/review`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": randomUUID(),
          "Idempotency-Key": randomUUID(),
          Authorization: `Bearer ${student.token}`,
        },
        body: JSON.stringify({
          rating: 5,
          text: "Synthetic historical lesson used only for discovery measurements.",
          headline: "Synthetic discovery fixture",
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!reviewed.ok)
        throw new Error(
          `Synthetic historical lesson review failed (${reviewed.status})`,
        );
      first.reviewCount = 1;
      first.average = 5;
      for (const query of fixture.queries)
        for (const item of query.expected.items)
          if (item.subjectId === first.subjectId) {
            item.reviewCount = 1;
            item.average = 5;
          }
      fixture.fixture.reviewCount = 1;
      fixture.ratingSemantics = {
        note: "One real Review API submission uses Booking's owner-seeded historical synthetic completed lesson; other subjects are unrated. This does not exercise payment or lesson completion workflows.",
        ratedSubjectId: first.subjectId,
        bookingId,
      };
      const { validateResponse } = await import("./discovery-model.mjs");
      for (const query of fixture.queries) {
        const result = await fetch(`${base}${query.path}`, {
          signal: AbortSignal.timeout(10000),
        });
        const validation = validateResponse(
          result.status,
          await result.text(),
          query,
        );
        if (!validation.ok)
          throw new Error(
            `Rated fixture validation failed: ${query.name} (${validation.reason})`,
          );
      }
      await write("fixture.json", fixture);
      metadata.fixtureSha256 = createHash("sha256")
        .update(await readFile(resolve(directory, "fixture.json")))
        .digest("hex");
      metadata.fixture = fixture.fixture;
      await write("environment.json", metadata);
      return prepared;
    },
    async scale(count) {
      if (![1, 3].includes(count))
        throw new Error("Only one or three Tutor replicas are authorized");
      replicas = count;
      await compose(
        [
          "up",
          "-d",
          "--no-deps",
          "--scale",
          `tutor-service=${count}`,
          "tutor-service",
        ],
        { log: `scale-${Date.now()}.txt` },
      );
      await readiness();
      await sleep(3000);
      await sample(`scale-${count}`);
    },
    async runK6({
      name,
      mode,
      ratePerSecond,
      durationSeconds,
      vus = 50,
      maxVUs = 1000,
    }) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error("Unsafe run name");
      await readiness();
      const before = await inspect();
      const startedAt = new Date().toISOString();
      await pressure(`${name}-before`);
      const args = [
        ...composeArgs,
        "run",
        "--no-deps",
        "--name",
        `${project}-generator`,
        "-e",
        "BASE_URL=http://api-gateway:8080",
        "-e",
        "FIXTURE_FILE=/results/fixture.json",
        "-e",
        `SUMMARY_PATH=/results/${name}.json`,
        "-e",
        `MODE=${mode}`,
        "-e",
        `RATE_PER_SECOND=${ratePerSecond || 1}`,
        "-e",
        `DURATION=${durationSeconds}s`,
        "-e",
        `VUS=${vus}`,
        "-e",
        `MAX_VUS=${maxVUs}`,
        "-e",
        `TUTOR_REPLICAS=${replicas}`,
        "-e",
        `TESTED_REVISION=${metadata.baseRevision}`,
        "load-generator",
        "run",
        "/scripts/discovery-search.js",
      ];
      let text = "",
        stopped = false,
        samplingError = null,
        terminationReason = null;
      const child = spawn("docker", args, {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => {
        text += chunk;
      });
      child.stderr.on("data", (chunk) => {
        text += chunk;
      });
      const finished = new Promise((done, reject) => {
        child.on("error", reject);
        child.on("close", (code) => {
          stopped = true;
          done(code);
        });
      });
      const samples = [];
      const sampler = (async () => {
        while (!stopped) {
          try {
            const value = await sample(name);
            samples.push(value);
            const unstable = !stableContainers(value.containers, before);
            const memoryPressure = value.stats.some(
              (item) => Number.parseFloat(item.MemPerc || "0") > 90,
            );
            // OOM/restarts/unhealthy owners invalidate the run and stop new load.
            if (unstable || memoryPressure) {
              terminationReason = unstable
                ? "service_instability"
                : value.stats.some(
                      (item) =>
                        item.Name === `${project}-generator` &&
                        Number.parseFloat(item.MemPerc || "0") > 90,
                    )
                  ? "generator_memory_pressure"
                  : "service_memory_pressure";
              await docker(["stop", "-t", "2", `${project}-generator`], {
                accepted: [0, 1],
              });
              break;
            }
          } catch (error) {
            if (!stopped) {
              samplingError = error.message;
              terminationReason = "telemetry_error";
              await docker(["stop", "-t", "2", `${project}-generator`], {
                accepted: [0, 1],
              });
              break;
            }
          }
          await sleep(5000);
        }
      })();
      const timer = setTimeout(
        () => {
          samplingError = "Load generator exceeded its bounded runtime";
          terminationReason = "runtime_timeout";
          void docker(["stop", "-t", "2", `${project}-generator`], {
            accepted: [0, 1],
            timeout: 10000,
          })
            .catch(() => {})
            .finally(() => child.kill("SIGKILL"));
        },
        (durationSeconds + 90) * 1000,
      );
      let exitCode;
      try {
        exitCode = await finished;
      } finally {
        clearTimeout(timer);
        stopped = true;
        await sampler;
      }
      await write(`${name}.txt`, text);
      try {
        await pressure(`${name}-after`);
      } catch (error) {
        if (!terminationReason?.startsWith("service_"))
          samplingError ||= error.message;
      }
      let report;
      try {
        report = JSON.parse(
          await readFile(resolve(directory, `${name}.json`), "utf8"),
        );
      } catch {
        report = {
          metrics: {},
          assessment: { pass: false },
          missingSummary: true,
        };
      }
      const after = await inspect();
      const generatorStats = samples
        .flatMap((sample) => sample.stats)
        .filter((item) => item.Name === `${project}-generator`);
      if (!generatorStats.length && !samplingError)
        samplingError = "No load-generator resource samples were captured";
      const generatorPeakCpu = generatorStats.length
        ? Math.max(
            ...generatorStats.map((item) => Number.parseFloat(item.CPUPerc)),
          )
        : null;
      const generatorMeanCpu = generatorStats.length
        ? generatorStats.reduce(
            (total, item) => total + Number.parseFloat(item.CPUPerc),
            0,
          ) / generatorStats.length
        : 0;
      const serviceResources = {};
      for (const snapshot of samples)
        for (const stat of snapshot.stats) {
          const container = snapshot.containers.find(
            (item) => item.name === stat.Name,
          );
          if (!container || !container.nanoCpus) continue;
          const key = container.name;
          const entry = (serviceResources[key] ||= {
            service: container.service,
            cpus: container.nanoCpus / 1e9,
            samples: 0,
            sumCpuPercent: 0,
            peakCpuPercent: 0,
            peakMemoryPercent: 0,
          });
          const cpu = Number.parseFloat(stat.CPUPerc);
          entry.samples++;
          entry.sumCpuPercent += cpu;
          entry.peakCpuPercent = Math.max(entry.peakCpuPercent, cpu);
          entry.peakMemoryPercent = Math.max(
            entry.peakMemoryPercent,
            Number.parseFloat(stat.MemPerc),
          );
        }
      for (const entry of Object.values(serviceResources)) {
        entry.meanCpuPercent = entry.sumCpuPercent / entry.samples;
        entry.meanCpuPercentOfLimit = entry.meanCpuPercent / entry.cpus;
        delete entry.sumCpuPercent;
      }
      const routing = await compose([
        "logs",
        "--no-color",
        "--since",
        startedAt,
        "api-gateway",
      ]);
      const distribution = {};
      for (const line of routing.stdout.split("\n")) {
        const start = line.indexOf("{");
        if (start < 0) continue;
        try {
          const record = JSON.parse(line.slice(start));
          if (
            record.RequestPath?.startsWith("/api/discovery/tutors") &&
            record.ServiceAddr
          )
            distribution[record.ServiceAddr] =
              (distribution[record.ServiceAddr] || 0) + 1;
        } catch {
          /* Other startup messages are not access records. */
        }
      }
      const hostValidity = {
        telemetryError: samplingError,
        terminationReason,
        boundedStop: [
          "service_instability",
          "service_memory_pressure",
        ].includes(terminationReason),
        generatorPeakCpuPercent: generatorPeakCpu,
        generatorMeanCpuPercent: generatorMeanCpu,
        generatorPossiblyLimited:
          generatorMeanCpu > 85 ||
          terminationReason === "generator_memory_pressure",
        containersStable: stableContainers(after, before),
        routingDistribution: distribution,
        replicas,
      };
      report = { ...report, name, exitCode, hostValidity, serviceResources };
      await write(`${name}.json`, report);
      await docker(["rm", "-f", `${project}-generator`], { accepted: [0, 1] });
      return report;
    },
    cleanup,
  };
}
