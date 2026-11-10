import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(
  root,
  "tests/fixtures/internal-traefik-compose/compose.yaml",
);
const engine = process.env.CONTAINER_ENGINE || "docker";
const project = `tm-internal-${process.pid}`.toLowerCase();
const composeEnv = { ...process.env };

function command(binary, args, options = {}) {
  return execFileSync(binary, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    ...options,
  });
}

function compose(args, options = {}) {
  return command(
    engine,
    ["compose", "--project-name", project, "--file", composeFile, ...args],
    {
      env: composeEnv,
      ...options,
    },
  );
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function socketPath() {
  const host = command(engine, [
    "context",
    "inspect",
    "--format",
    "{{.Endpoints.docker.Host}}",
  ]).trim();
  assert.ok(
    host.startsWith("unix://"),
    `Docker Compose qualification requires a local Unix socket context; got ${host}`,
  );
  const socket = host.slice("unix://".length);
  assert.equal(
    statSync(socket).isSocket(),
    true,
    "Docker API socket is available",
  );
  return socket;
}

function fixtureInstances() {
  const ids = compose(["ps", "--all", "--quiet", "fixture"])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return ids.map((id) => {
    const data = JSON.parse(
      command(engine, ["inspect", id, "--format", "{{json .}}"]),
    );
    const network = Object.values(data.NetworkSettings.Networks)[0];
    return { id, ip: network.IPAddress, hostname: data.Config.Hostname };
  });
}

function probe(mode, instances = [], extraEnv = {}) {
  const envArgs = [];
  if (instances.length) {
    envArgs.push(
      "-e",
      `FIXTURE_IPS=${instances.map((item) => item.ip).join(",")}`,
    );
    envArgs.push(
      "-e",
      `FIXTURE_HOSTNAMES=${instances.map((item) => item.hostname).join(",")}`,
    );
  }
  for (const [key, value] of Object.entries(extraEnv))
    envArgs.push("-e", `${key}=${value}`);
  return compose(
    [
      "exec",
      "--no-TTY",
      ...envArgs,
      "probe",
      "node",
      "/workspace/tests/fixtures/internal-traefik-compose/probe.cjs",
      mode,
    ],
    { timeout: 30_000 },
  );
}

function observed(output) {
  const line = output
    .trim()
    .split("\n")
    .filter((entry) => entry.startsWith("{"))
    .at(-1);
  return JSON.parse(line || "{}");
}

async function waitForInstances(count, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  let instances = [];
  while (Date.now() < until) {
    instances = fixtureInstances();
    if (
      instances.length === count &&
      instances.every((item) => item.ip && item.hostname)
    )
      return instances;
    await pause(200);
  }
  throw new Error(
    `Expected ${count} running fixture containers; found ${instances.length}`,
  );
}

async function waitForObserved(count, expected = []) {
  const until = Date.now() + 15_000;
  let last = {};
  while (Date.now() < until) {
    try {
      last = observed(probe("observe", [], { OBSERVE_CALLS: "24" }));
      const matches = (instances) => {
        if (expected.length) {
          const actual = new Set(instances);
          return (
            actual.size === expected.length &&
            expected.every((name) => actual.has(name))
          );
        }
        return instances.length >= count;
      };
      if (matches(last.http || []) && matches(last.grpc || [])) return last;
    } catch {
      /* Traefik provider may still be reconciling a task change. */
    }
    await pause(200);
  }
  throw new Error(
    `Traffic did not converge to ${count} backends; last observed ${JSON.stringify(last)}`,
  );
}

async function main() {
  composeEnv.DOCKER_SOCKET = socketPath();
  composeEnv.REPO_ROOT = root;
  composeEnv.PROJECT_NAME = project;
  let completed = false;
  try {
    compose(["up", "--detach", "--scale", "fixture=2"]);
    const two = await waitForInstances(2);
    await probe("run", two);
    console.log(
      "PASS: Docker-provider routes distribute HTTP and persistent-channel gRPC, forward auth metadata, reject unlisted paths, and remove/recover unhealthy endpoints.",
    );

    compose(["up", "--detach", "--scale", "fixture=3"]);
    const three = await waitForInstances(3);
    const expanded = await waitForObserved(
      3,
      three.map((item) => item.hostname),
    );
    assert.ok(
      expanded.http.length >= 3 && expanded.grpc.length >= 3,
      "HTTP and gRPC reach all added containers",
    );
    console.log(
      "PASS: a newly added container receives HTTP and persistent-channel gRPC traffic.",
    );

    compose(["up", "--detach", "--scale", "fixture=1"]);
    const one = await waitForInstances(1);
    const reduced = await waitForObserved(
      1,
      one.map((item) => item.hostname),
    );
    assert.deepEqual(
      new Set(reduced.http),
      new Set(one.map((item) => item.hostname)),
    );
    assert.deepEqual(
      new Set(reduced.grpc),
      new Set(one.map((item) => item.hostname)),
    );
    console.log(
      "PASS: removed containers stop receiving HTTP and gRPC traffic.",
    );

    compose(["up", "--detach", "--scale", "fixture=2"]);
    const cached = await waitForInstances(2);
    compose(["stop", "docker-api"]);
    const duringOutage = observed(probe("observe", cached));
    assert.ok(
      cached.every(
        (item) =>
          duringOutage.http.includes(item.hostname) &&
          duringOutage.grpc.includes(item.hostname),
      ),
      "cached HTTP and gRPC endpoints continue while Docker API discovery is unavailable",
    );
    console.log(
      "PASS: cached HTTP and gRPC endpoints continue during Docker API discovery loss.",
    );

    await probe("offline-health", cached);
    console.log(
      "PASS: active gRPC health checks continue while discovery is unavailable, with REST readiness remaining independent.",
    );

    compose(["scale", "fixture=1"]);
    const survivorSet = await waitForInstances(1);
    const survivor = cached.find((item) => item.id === survivorSet[0].id);
    assert.ok(
      survivor,
      "one cached application task remains during the discovery outage",
    );
    compose(["scale", "fixture=2"]);
    const replacedSet = await waitForInstances(2);
    const replacement = replacedSet.find(
      (item) => !cached.some((old) => old.id === item.id),
    );
    assert.ok(
      replacement,
      "Compose replaces one task while Traefik cannot discover it",
    );
    assert.ok(
      !replacedSet.some(
        (item) => item.id === cached.find((old) => old.id !== survivor.id)?.id,
      ),
      "the old task has been removed",
    );
    await probe("cached-survivor", [], {
      SURVIVOR_HOSTNAME: survivor.hostname,
    });
    compose(["start", "docker-api"]);
    const refreshed = await waitForObserved(2, [
      survivor.hostname,
      replacement.hostname,
    ]);
    assert.ok(
      refreshed.http.includes(replacement.hostname) &&
        refreshed.grpc.includes(replacement.hostname),
      "restored discovery adds replacement to both protocols",
    );
    console.log(
      "PASS: cached healthy survivor serves during task replacement; restored Docker API discovery routes to the replacement within 15 seconds.",
    );

    compose(["up", "--detach", "--scale", "fixture=0"]);
    await waitForInstances(0);
    const noRouteUntil = Date.now() + 15_000;
    let noRoute = false;
    while (Date.now() < noRouteUntil) {
      try {
        probe("no-route");
        noRoute = true;
        break;
      } catch {
        await pause(200);
      }
    }
    assert.equal(
      noRoute,
      true,
      "zero Docker tasks remove the HTTP and gRPC routes within 15 seconds",
    );
    console.log("PASS: zero tasks expose no application backend.");

    const restoredAt = Date.now();
    compose(["up", "--detach", "--scale", "fixture=1"]);
    await waitForInstances(1);
    await probe("available");
    assert.ok(
      Date.now() - restoredAt <= 15_000,
      "adding a task restores both protocols within 15 seconds",
    );
    console.log(
      "PASS: adding a task restores HTTP and gRPC routing within 15 seconds.",
    );

    compose(["kill", "traefik"]);
    await probe("proxy-unavailable");
    const proxyRestoredAt = Date.now();
    compose(["start", "traefik"]);
    await probe("available");
    assert.ok(
      Date.now() - proxyRestoredAt <= 15_000,
      "restarting the single Traefik task restores both protocols within 15 seconds",
    );
    completed = true;
    console.log(
      "PASS: restarting the single internal Traefik task restores HTTP and gRPC routing within 15 seconds.",
    );
  } finally {
    try {
      compose(["down", "--remove-orphans", "--volumes"]);
    } catch (error) {
      if (completed) throw error;
      console.error("Cleanup also failed:", error.message);
    }
  }
}

try {
  if (
    spawnSync(engine, ["compose", "version"], { stdio: "ignore" }).status !== 0
  ) {
    throw new Error(`${engine} Compose is required for this qualification.`);
  }
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
