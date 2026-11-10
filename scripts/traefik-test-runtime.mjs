import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { accessSync, constants } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = path.join(root, ".cache/gateway");

function findContainerCli() {
  const requested = process.env.CONTAINER_CLI || process.env.CONTAINER_ENGINE;
  const candidates = requested ? [requested] : ["podman", "docker"];
  for (const candidate of candidates) {
    if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0)
      return candidate;
  }
  throw new Error(
    "Traefik binary is missing; install Docker or Podman, or set TRAEFIK_BIN.",
  );
}

function ensureTraefikBinary() {
  const configured = process.env.TRAEFIK_BIN;
  const binary = configured || path.join(cache, "traefik");
  if (configured || awaitExists(binary)) {
    const version = execFileSync(binary, ["version"], { encoding: "utf8" });
    assert.match(
      version,
      /Version:\s+3\.7\.17\b/,
      "Traefik 3.7.17 is required",
    );
    return binary;
  }
  const cli = findContainerCli();
  const image = "traefik:v3.7.17";
  const container = `gateway-traefik-test-${process.pid}-${Date.now()}`;
  try {
    try {
      execFileSync(cli, ["create", "--name", container, image], {
        stdio: "ignore",
      });
    } catch {
      execFileSync(cli, ["pull", image], { stdio: "ignore" });
      execFileSync(cli, ["create", "--name", container, image], {
        stdio: "ignore",
      });
    }
    execFileSync(cli, ["cp", `${container}:/usr/local/bin/traefik`, binary], {
      stdio: "ignore",
    });
    const version = execFileSync(binary, ["version"], { encoding: "utf8" });
    assert.match(
      version,
      /Version:\s+3\.7\.17\b/,
      "Traefik 3.7.17 is required",
    );
  } catch {
    throw new Error(
      `Unable to obtain Traefik 3.7.17 from ${image} using ${cli}.`,
    );
  } finally {
    spawnSync(cli, ["rm", "--force", container], { stdio: "ignore" });
  }
  return binary;
}

function awaitExists(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function providerFixture(
  provider,
  backends,
  initialTaskCounts = {},
  healthCheckTimeout = "100ms",
) {
  const networkId = "gateway-test-network";
  const networkName = "tutor-matcher_backend";
  const state = {
    discovery: true,
    taskCounts: Object.fromEntries(
      Object.entries(backends).map(([name, replicas]) => [
        name,
        initialTaskCounts[name] ?? replicas.length,
      ]),
    ),
    eventStreams: new Set(),
  };
  const labels = Object.fromEntries(
    Object.entries(backends).map(([name, replicas]) => [
      name,
      {
        "traefik.enable": "true",
        "tutor-matcher.gateway": "true",
        [`traefik.http.services.${name}.loadbalancer.server.port`]: String(
          replicas[0].port,
        ),
        [`traefik.http.services.${name}.loadbalancer.healthcheck.path`]:
          "/health",
        [`traefik.http.services.${name}.loadbalancer.healthcheck.interval`]:
          "100ms",
        [`traefik.http.services.${name}.loadbalancer.healthcheck.timeout`]:
          healthCheckTimeout,
        "com.docker.stack.namespace": "tutor-matcher",
      },
    ]),
  );

  const replicasFor = (name) =>
    (backends[name] || []).slice(0, state.taskCounts[name] || 0);
  const containers = () =>
    Object.entries(backends).flatMap(([name, replicas]) =>
      replicasFor(name).map((backend, index) => ({
        Id: `${name}-${index}`,
        Name: `/${name}-${index}`,
        Names: [`/${name}-${index}`],
        Labels: labels[name],
        Config: {
          Labels: labels[name],
          ExposedPorts: { [`${backend.port}/tcp`]: {} },
        },
        State: { Running: true, Health: { Status: "healthy" } },
        HostConfig: { NetworkMode: networkName },
        NetworkSettings: {
          Networks: {
            [networkName]: { NetworkID: networkId, IPAddress: backend.host },
          },
        },
      })),
    );
  const serviceList = () =>
    Object.entries(backends).map(([name]) => ({
      ID: name,
      Spec: {
        Name: `tutor-matcher_${name}`,
        Mode: { Replicated: { Replicas: state.taskCounts[name] || 0 } },
        Labels: labels[name],
      },
    }));
  const taskList = (name) =>
    replicasFor(name).map((backend, index) => ({
      ID: `${name}-${index}`,
      ServiceID: name,
      Slot: index + 1,
      DesiredState: "running",
      Status: { State: "running" },
      NetworksAttachments: [
        {
          Network: { ID: networkId },
          Addresses: [`${backend.host}/32`],
        },
      ],
    }));

  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("API-Version", "1.54");
    const url = new URL(req.url, "http://fixture");
    const endpoint = url.pathname.replace(/^\/v[0-9.]+/, "");
    if (!state.discovery) {
      res.writeHead(503);
      return res.end("{}");
    }
    if (endpoint === "/_ping") return res.end("OK");
    if (endpoint === "/version")
      return res.end(
        JSON.stringify({
          Version: "29.0.0",
          ApiVersion: "1.54",
          MinAPIVersion: "1.44",
          Os: "linux",
        }),
      );
    if (endpoint === "/info")
      return res.end(
        JSON.stringify({
          Swarm: {
            LocalNodeState: "active",
            ControlAvailable: true,
            NodeID: "gateway-test",
          },
        }),
      );
    if (endpoint === "/networks")
      return res.end(
        JSON.stringify([
          {
            Id: networkId,
            Name: networkName,
            Driver: "overlay",
            Scope: "swarm",
          },
        ]),
      );
    if (endpoint === "/containers/json")
      return res.end(
        JSON.stringify(
          containers().map((item) => ({ ...item, State: "running" })),
        ),
      );
    if (/^\/containers\/[^/]+\/json$/.test(endpoint)) {
      return res.end(
        JSON.stringify(
          containers().find((item) => item.Id === endpoint.split("/")[2]) ?? {},
        ),
      );
    }
    if (endpoint === "/services") return res.end(JSON.stringify(serviceList()));
    if (endpoint === "/tasks") {
      const filters = JSON.parse(url.searchParams.get("filters") || "{}");
      const name =
        Object.keys(filters.service || {})[0] || filters.service?.[0];
      return res.end(
        JSON.stringify(
          name && backends[name]
            ? taskList(name)
            : Object.keys(backends).flatMap(taskList),
        ),
      );
    }
    if (endpoint === "/events") {
      res.setHeader("Content-Type", "application/x-ndjson");
      res.flushHeaders();
      state.eventStreams.add(res);
      const timer = setInterval(
        () =>
          res.write(
            JSON.stringify({
              Type: provider === "docker" ? "container" : "service",
              Action: provider === "docker" ? "start" : "update",
              Actor: { ID: "gateway-test" },
            }) + "\n",
          ),
        500,
      );
      req.on("close", () => {
        clearInterval(timer);
        state.eventStreams.delete(res);
      });
      return;
    }
    res.writeHead(501);
    res.end(
      JSON.stringify({ error: "Unmodeled controlled discovery API request" }),
    );
  });
  return {
    server,
    setDiscoveryAvailable(available) {
      state.discovery = available;
      if (!available) {
        for (const stream of state.eventStreams) stream.destroy();
      }
    },
    setTaskCount(name, count) {
      assert.ok(Object.hasOwn(backends, name), `unknown test service ${name}`);
      assert.ok(
        Number.isInteger(count) && count >= 0 && count <= backends[name].length,
      );
      const previous = state.taskCounts[name];
      state.taskCounts[name] = count;
      for (const stream of state.eventStreams) {
        const changedIndex = Math.max(0, Math.min(previous, count) - 1);
        stream.write(
          JSON.stringify({
            Type: provider === "docker" ? "container" : "service",
            Action:
              provider === "docker"
                ? count > previous
                  ? "start"
                  : "die"
                : "update",
            Actor: {
              ID: `${name}-${changedIndex}`,
              Attributes: labels[name],
            },
          }) + "\n",
        );
      }
    },
  };
}

export async function startTestGateway({
  authUrl,
  workloadCredential,
  ownerUrls = {},
  provider = process.env.GATEWAY_TEST_PROVIDER || "swarm",
  redactValues = [],
  initialTaskCounts = {},
  healthCheckTimeout = "100ms",
}) {
  assert.ok(authUrl, "authUrl is required");
  assert.ok(workloadCredential, "workloadCredential is required");
  assert.ok(
    ["docker", "swarm"].includes(provider),
    "provider must be docker or swarm",
  );
  await mkdir(cache, { recursive: true });
  const binary = ensureTraefikBinary();
  const backends = {};
  for (const [owner, value] of Object.entries({
    ...ownerUrls,
    auth: authUrl,
  })) {
    const replicas = Array.isArray(value) ? value : [value];
    backends[`${owner}-service`] = replicas.map((url) => {
      const target = new URL(url);
      assert.ok(
        ["127.0.0.1", "127.0.0.2", "127.0.0.3", "localhost"].includes(
          target.hostname,
        ),
        "test backends must use loopback URLs",
      );
      return {
        host: target.hostname === "localhost" ? "127.0.0.1" : target.hostname,
        port: Number(target.port || 80),
      };
    });
  }

  const discoveryFixture = providerFixture(
    provider,
    backends,
    initialTaskCounts,
    healthCheckTimeout,
  );
  const api = discoveryFixture.server;
  const apiPort = await listen(api);
  const webPort = await freePort();
  const authListenerPort = await freePort();
  const pingPort = await freePort();
  const sourceConfig = await readFile(
    path.join(root, "infra/gateway/routes.yaml"),
    "utf8",
  );
  const configFile = path.join(cache, `routes-${process.pid}-${webPort}.yaml`);
  await writeFile(
    configFile,
    sourceConfig.replaceAll("127.0.0.1:8081", `127.0.0.1:${authListenerPort}`),
  );
  const common = [
    `--providers.file.filename=${configFile}`,
    "--providers.file.watch=false",
    `--entrypoints.web.address=127.0.0.1:${webPort}`,
    `--entrypoints.auth.address=127.0.0.1:${authListenerPort}`,
    "--entrypoints.auth.forwardedHeaders.trustedIPs=127.0.0.1/32,::1/128",
    "--entrypoints.auth.forwardedheaders.trustedips=127.0.0.1/32,::1/128",
    `--entrypoints.traefik.address=127.0.0.1:${pingPort}`,
    "--ping=true",
    "--ping.entrypoint=traefik",
    "--api.dashboard=false",
    "--accesslog=true",
    "--accesslog.format=json",
    "--accesslog.fields.headers.defaultmode=drop",
    "--log.format=json",
  ];
  const discoveryArgs =
    provider === "swarm"
      ? [
          `--providers.swarm.endpoint=http://127.0.0.1:${apiPort}`,
          "--providers.swarm.network=tutor-matcher_backend",
          "--providers.swarm.exposedbydefault=false",
          "--providers.swarm.allowemptyservices=true",
          "--providers.swarm.defaultRule=PathRegexp(`a^`)",
          "--providers.swarm.watch=true",
          "--providers.swarm.refreshseconds=200ms",
          "--providers.swarm.constraints=Label(`traefik.enable`,`true`) && Label(`tutor-matcher.gateway`,`true`) && Label(`com.docker.stack.namespace`,`tutor-matcher`)",
        ]
      : [
          `--providers.docker.endpoint=http://127.0.0.1:${apiPort}`,
          "--providers.docker.network=tutor-matcher_backend",
          "--providers.docker.exposedbydefault=false",
          "--providers.docker.allowemptyservices=true",
          "--providers.docker.defaultRule=PathRegexp(`a^`)",
          "--providers.docker.watch=true",
          "--providers.docker.constraints=Label(`tutor-matcher.gateway`,`true`)",
        ];
  const child = spawn(binary, [...common, ...discoveryArgs], {
    cwd: root,
    env: {
      ...process.env,
      TRAEFIK_DISCOVERY_PROVIDER: provider,
      GATEWAY_WORKLOAD_CREDENTIAL: workloadCredential,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const secrets = [workloadCredential, ...redactValues].filter(Boolean);
  const appendSafe = (chunk) => {
    let safe = String(chunk);
    for (const value of secrets) safe = safe.replaceAll(value, "[redacted]");
    safe = safe.replace(
      /((?:authorization|x-actor-context|x-workload-authorization)\s*[:=]\s*)"[^"\r\n]*"/gi,
      '$1"[redacted]"',
    );
    logs += safe;
  };
  child.stdout.on("data", appendSafe);
  child.stderr.on("data", appendSafe);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
    api.closeAllConnections();
    await new Promise((resolve) => api.close(() => resolve()));
    await writeFile(path.join(cache, "traefik.log"), logs);
  };
  const url = `http://127.0.0.1:${webPort}`;
  const deadline = Date.now() + 15000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    if (child.exitCode !== null) {
      await writeFile(path.join(cache, "traefik-startup.log"), logs);
      await close();
      throw new Error(
        `Traefik exited during test startup (${child.exitCode ?? child.signalCode}).`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${pingPort}/ping`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        const healthRoute = await fetch(`${url}/api/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (healthRoute.status === 200) {
          const forwardAuthRoute = await fetch(`${url}/api/auth/me`, {
            signal: AbortSignal.timeout(750),
          });
          ready = forwardAuthRoute.status === 401;
          if (ready) {
            // ForwardAuth talks to Auth directly. Public routes go to the backend that Traefik discovers,
            // which can lag behind: a missing backend answers with Traefik's plain-text 5xx or 404, while a
            // request that reaches the application answers in JSON. This route validates the body first,
            // so the empty request is rejected without reading or changing any data.
            const publicRoute = await fetch(
              `${url}/api/auth/password-reset/validate`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
                signal: AbortSignal.timeout(750),
              },
            );
            await publicRoute.arrayBuffer();
            ready =
              publicRoute.status < 500 &&
              (publicRoute.headers.get("content-type") ?? "").includes("json");
          }
        }
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!ready) {
    await writeFile(path.join(cache, "traefik-startup.log"), logs);
    await close();
    throw new Error(
      `Traefik did not load the health route. Sanitized log tail: ${logs.slice(-4000)}`,
    );
  }
  return {
    url,
    close,
    setDiscoveryAvailable: discoveryFixture.setDiscoveryAvailable,
    setTaskCount: discoveryFixture.setTaskCount,
  };
}
