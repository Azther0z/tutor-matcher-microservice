#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engine = process.env.CONTAINER_ENGINE || "docker";
const fixture = path.join(root, "tests/fixtures/internal-traefik-swarm.yaml");
const probeScript =
  "/workspace/tests/fixtures/internal-traefik-compose/probe.cjs";
const optIn = "INTERNAL_TRAEFIK_SWARM_QUALIFY";
const stack = `tm-internal-qual-${process.pid}`.toLowerCase();
const outputDir = path.join(root, ".cache/internal-traefik");
const stackFile = path.join(outputDir, `${stack}.yaml`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(binary, args, options = {}) {
  return execFileSync(binary, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}
function docker(args, options = {}) {
  return run(engine, args, options);
}
function service(name) {
  return `${stack}_${name}`;
}
function taskContainers(name) {
  return docker([
    "ps",
    "--quiet",
    "--filter",
    `label=com.docker.swarm.service.name=${service(name)}`,
  ])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
function inspectInstances(name) {
  return taskContainers(name)
    .map((id) => {
      const item = JSON.parse(docker(["inspect", id]))[0];
      return {
        id,
        ip: item.NetworkSettings.Networks[`${stack}_backend`]?.IPAddress,
      };
    })
    .filter((item) => item.ip);
}
function probeContainer() {
  const [id] = taskContainers("probe");
  assert.ok(
    id,
    "qualification probe service is running on the selected Swarm manager",
  );
  return id;
}
function probe(mode, instances = [], extraEnv = {}) {
  const args = ["exec"];
  if (instances.length) {
    args.push(
      "-e",
      `FIXTURE_IPS=${instances.map((item) => item.ip).join(",")}`,
    );
    args.push(
      "-e",
      `FIXTURE_HOSTNAMES=${instances.map((item) => item.hostname).join(",")}`,
    );
  }
  for (const [key, value] of Object.entries(extraEnv))
    args.push("-e", `${key}=${value}`);
  args.push(probeContainer(), "node", probeScript, mode);
  return docker(args);
}
function parseObserved(output) {
  const line = output
    .trim()
    .split("\n")
    .filter((value) => value.startsWith("{"))
    .at(-1);
  return JSON.parse(line || "{}");
}
async function mapInstances(instances) {
  const script =
    "Promise.all(process.env.FIXTURE_IPS.split(',').map(async ip => { const r=await fetch(`http://${ip}:8080/private/test`, {signal:AbortSignal.timeout(2000)}); return {ip,hostname:(await r.json()).instance}; })).then(x=>console.log(JSON.stringify(x)))";
  const output = docker([
    "exec",
    "-e",
    `FIXTURE_IPS=${instances.map((item) => item.ip).join(",")}`,
    probeContainer(),
    "node",
    "-e",
    script,
  ]);
  const mapped = JSON.parse(output.trim().split("\n").at(-1));
  return mapped.map((item) => ({
    ...instances.find((instance) => instance.ip === item.ip),
    hostname: item.hostname,
  }));
}
async function waitFor(check, message, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try {
      last = await check();
      if (last) return last;
    } catch {
      /* Swarm task reconciliation */
    }
    await pause(250);
  }
  throw new Error(`${message}; last observation ${JSON.stringify(last)}`);
}
async function waitTasks(name, count) {
  return await waitFor(() => {
    const items = inspectInstances(name);
    return items.length === count ? items : null;
  }, `expected ${count} running ${name} task(s)`);
}
async function waitServicesAndNetworksRemoved() {
  const serviceNames = docker(["service", "ls", "--format", "{{.Name}}"])
    .trim()
    .split("\n")
    .filter(Boolean);
  const networkNames = docker(["network", "ls", "--format", "{{.Name}}"])
    .trim()
    .split("\n")
    .filter(Boolean);
  return (
    !serviceNames.some((name) => name.startsWith(`${stack}_`)) &&
    !networkNames.includes(`${stack}_backend`) &&
    !networkNames.includes(`${stack}_socket`)
  );
}
async function cleanup() {
  for (const id of taskContainers("docker-api")) {
    try {
      docker(["unpause", id]);
    } catch {
      /* It may already be running or the task may have exited. */
    }
  }
  const listed = docker(["stack", "ls", "--format", "{{.Name}}"])
    .trim()
    .split("\n")
    .filter(Boolean);
  if (listed.includes(stack)) {
    docker(["stack", "rm", stack]);
    await waitFor(
      waitServicesAndNetworksRemoved,
      `isolated Swarm stack ${stack} cleanup did not complete`,
      30_000,
    );
  }
  await rm(stackFile, { force: true });
}
function renderStack(source, managerId) {
  return source
    .replaceAll("${STACK_NAME}", stack)
    .replaceAll("${MANAGER_NODE_ID}", managerId)
    .replaceAll("${REPO_ROOT}", root);
}

async function main() {
  const source = await readFile(fixture, "utf8");
  const managerId = process.argv.includes("--render-only")
    ? "render-validation-node"
    : undefined;
  if (managerId) {
    await mkdir(outputDir, { recursive: true });
    await writeFile(stackFile, renderStack(source, managerId), { mode: 0o600 });
    const parsed = spawnSync(
      engine,
      ["stack", "config", "--compose-file", stackFile],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
    );
    await rm(stackFile, { force: true });
    assert.equal(
      parsed.status,
      0,
      `rendered Swarm fixture is invalid: ${parsed.error?.message ?? parsed.stderr}`,
    );
    console.log(
      "PASS: static Swarm qualification stack parses; no Swarm state was changed.",
    );
    return;
  }
  if (process.env[optIn] !== "1") {
    throw new Error(
      `Refusing to mutate Swarm. Review the fixture and set ${optIn}=1 only after approving this uniquely named test stack and its cleanup.`,
    );
  }
  assert.equal(
    spawnSync(engine, ["info"], { stdio: "ignore" }).status,
    0,
    `${engine} must be available`,
  );
  const endpoint = docker([
    "context",
    "inspect",
    "--format",
    "{{.Endpoints.docker.Host}}",
  ]).trim();
  assert.ok(
    endpoint.startsWith("unix://"),
    `qualification is restricted to the current local Unix-socket Docker context; found ${endpoint}`,
  );
  assert.equal(
    statSync(endpoint.slice("unix://".length)).isSocket(),
    true,
    "local Docker API socket is available",
  );
  const info = docker([
    "info",
    "--format",
    "{{.Swarm.LocalNodeState}}|{{.Swarm.ControlAvailable}}|{{.Swarm.NodeID}}",
  ])
    .trim()
    .split("|");
  assert.equal(
    info[0],
    "active",
    "a Swarm must already be active; this script never initializes Swarm",
  );
  assert.equal(info[1], "true", "run from a Swarm manager");
  const activeManagerId = info[2];
  assert.ok(activeManagerId, "manager node id is available");
  const existing = docker(["stack", "ls", "--format", "{{.Name}}"])
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.ok(
    !existing.includes(stack),
    `isolated stack name ${stack} already exists; refusing to reuse it`,
  );
  await mkdir(outputDir, { recursive: true });
  await writeFile(stackFile, renderStack(source, activeManagerId), {
    mode: 0o600,
  });
  try {
    docker(["stack", "deploy", "--compose-file", stackFile, stack]);
    await waitFor(
      () =>
        taskContainers("traefik").length === 2 &&
        taskContainers("docker-api").length === 1 &&
        taskContainers("fixture").length === 2 &&
        taskContainers("probe").length === 1,
      "test stack services did not converge",
    );
    await probe("available");
    let apps = await mapInstances(await waitTasks("fixture", 2));
    await probe("run", apps);
    console.log(
      "PASS: Swarm routes distribute HTTP and persistent-channel gRPC, forward credentials/identity, enforce destination auth, reject unlisted paths, and independently check readiness.",
    );

    docker(["service", "scale", `${service("fixture")}=3`]);
    const three = await mapInstances(await waitTasks("fixture", 3));
    let seen;
    await waitFor(() => {
      seen = parseObserved(probe("observe"));
      const all = new Set([...(seen.http || []), ...(seen.grpc || [])]);
      return three.every((task) => all.has(task.hostname)) ? seen : null;
    }, "new Swarm task did not receive HTTP and gRPC traffic");
    docker(["service", "scale", `${service("fixture")}=2`]);
    apps = await mapInstances(await waitTasks("fixture", 2));
    await waitFor(() => {
      seen = parseObserved(probe("observe"));
      const all = new Set([...(seen.http || []), ...(seen.grpc || [])]);
      return apps.every((task) => all.has(task.hostname)) && all.size === 2
        ? seen
        : null;
    }, "removed Swarm task remained in rotation");
    console.log(
      "PASS: Swarm task addition and removal converge on both protocols.",
    );

    docker(["service", "scale", `${service("fixture")}=0`]);
    await waitTasks("fixture", 0);
    await waitFor(() => {
      try {
        probe("no-route");
        return true;
      } catch {
        return null;
      }
    }, "zero tasks did not fail closed within 15 seconds");
    docker(["service", "scale", `${service("fixture")}=2`]);
    apps = await mapInstances(await waitTasks("fixture", 2));
    await probe("available");
    console.log(
      "PASS: zero backends fail closed, and a new task restores calls within 15 seconds.",
    );

    apps = await mapInstances(await waitTasks("fixture", 2));
    const apiId = taskContainers("docker-api")[0];
    assert.ok(apiId, "restricted Docker API proxy task exists");
    docker(["pause", apiId]);
    await pause(750);
    await probe("offline-health", apps);
    docker(["service", "scale", `${service("fixture")}=1`]);
    const survivor = (await mapInstances(await waitTasks("fixture", 1)))[0];
    await probe("cached-survivor", [], {
      SURVIVOR_HOSTNAME: survivor.hostname,
    });
    docker(["service", "scale", `${service("fixture")}=2`]);
    const replacement = (
      await mapInstances(await waitTasks("fixture", 2))
    ).find((item) => item.hostname !== survivor.hostname);
    assert.ok(
      replacement,
      "Swarm created a replacement while discovery was offline",
    );
    await probe("cached-survivor", [], {
      SURVIVOR_HOSTNAME: survivor.hostname,
    });
    docker(["unpause", apiId]);
    await waitFor(() => {
      seen = parseObserved(probe("observe"));
      return seen.http?.includes(replacement.hostname) &&
        seen.grpc?.includes(replacement.hostname)
        ? seen
        : null;
    }, "replacement task was not discovered within 15 seconds after Docker API recovery");
    console.log(
      "PASS: cached endpoints remain health checked during discovery outage; new task appears after API recovery.",
    );

    const proxyContainers = taskContainers("traefik");
    assert.equal(
      proxyContainers.length,
      2,
      "two internal Traefik tasks are active before failure injection",
    );
    const failedAt = Date.now();
    docker(["kill", proxyContainers[0]]);
    await probe("available");
    assert.ok(
      Date.now() - failedAt <= 15_000,
      "new HTTP and gRPC calls recover through the surviving proxy within 15 seconds",
    );
    console.log(
      "PASS: new calls recover through the surviving proxy within 15 seconds.",
    );
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
