const assert = require("node:assert/strict");
const grpc = require("@grpc/grpc-js");
const protobuf = require("protobufjs");

const requestType = new protobuf.Type("PingRequest").add(new protobuf.Field("nonce", 1, "string"));
const responseType = new protobuf.Type("PingResponse")
  .add(new protobuf.Field("instance", 1, "string"))
  .add(new protobuf.Field("authorization", 2, "string"))
  .add(new protobuf.Field("nonce", 3, "string"));
const encode = (type, value) => Buffer.from(type.encode(type.fromObject(value)).finish());
const decode = (type, value) => type.toObject(type.decode(value), { defaults: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function httpRequest(path = "/private/test", identity = "fixture-identity") {
  const response = await fetch(`http://service.internal:8080${path}`, {
    headers: { "x-identity": identity },
    signal: AbortSignal.timeout(2500),
  });
  return { status: response.status, body: await response.text() };
}

function createGrpcClient() {
  const client = new grpc.Client("traefik:8080", grpc.credentials.createInsecure(), {
    "grpc.default_authority": "grpc.internal",
  });
  return {
    call(nonce = "fixture", authorization = "Bearer internal-fixture-canary") {
      return new Promise((resolve, reject) => {
        const metadata = new grpc.Metadata();
        if (authorization) metadata.set("authorization", authorization);
        client.makeUnaryRequest(
          "/fixture.v1.Probe/Ping",
          (value) => encode(requestType, value),
          (value) => decode(responseType, value),
          { nonce },
          metadata,
          { deadline: Date.now() + 1000 },
          (error, response) => error ? reject(error) : resolve(response),
        );
      });
    },
    close() { client.close(); },
  };
}

async function listInstances(client, count = 30) {
  const http = new Set();
  const grpcInstances = new Set();
  for (let index = 0; index < count; index += 1) {
    try {
      const result = await httpRequest();
      if (result.status === 200) http.add(JSON.parse(result.body).instance);
    } catch { /* transient during provider reconciliation */ }
    try {
      const response = await client.call(`distribution-${index}`);
      if (response.instance) grpcInstances.add(response.instance);
    } catch { /* transient during provider reconciliation */ }
  }
  return { http: [...http], grpc: [...grpcInstances] };
}

async function waitFor(check, message, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try {
      last = await check();
      if (last) return last;
    } catch { /* route or health check may still be converging */ }
    await pause(200);
  }
  throw new Error(`${message}; last observed ${JSON.stringify(last)}`);
}

async function control(ip, value, protocol = "") {
  const response = await fetch(`http://${ip}:8080/admin/ready?value=${value}&protocol=${protocol}`, { signal: AbortSignal.timeout(2500) });
  assert.equal(response.status, 200);
}

async function main() {
  const client = createGrpcClient();
  try {
    await waitFor(async () => {
      const response = await httpRequest();
      return response.status === 200 ? response : null;
    }, "HTTP route did not become ready");

    const httpIdentity = await httpRequest("/private/test", "forwarded-identity-canary");
    assert.equal(httpIdentity.status, 200);
    assert.equal(JSON.parse(httpIdentity.body).identity, "forwarded-identity-canary", "HTTP identity header is forwarded");
    assert.equal((await httpRequest("/admin/ready?value=true")).status, 404, "unlisted app route is rejected");

    const auth = await client.call("auth-canary");
    assert.equal(auth.authorization, "Bearer internal-fixture-canary", "gRPC authorization metadata is forwarded");
    await assert.rejects(client.call("invalid-auth", "Bearer invalid-fixture-canary"), (error) => error.code === grpc.status.UNAUTHENTICATED, "invalid workload credentials are rejected by the backend");

    let observed = await waitFor(async () => {
      const values = await listInstances(client, 40);
      return values.http.length >= 2 && values.grpc.length >= 2 ? values : null;
    }, "HTTP and persistent-channel gRPC requests did not reach both Docker backends");
    assert.ok(observed.http.length >= 2);
    assert.ok(observed.grpc.length >= 2);

    const ips = (process.env.FIXTURE_IPS || "").split(",").filter(Boolean);
    const names = (process.env.FIXTURE_HOSTNAMES || "").split(",").filter(Boolean);
    assert.equal(ips.length, 2, "fixture starts with exactly two application containers");

    await control(ips[0], false, "grpc");
    observed = await waitFor(async () => {
      const values = await listInstances(client, 12);
      return values.http.includes(names[0]) && values.http.includes(names[1]) && values.grpc.includes(names[1]) && !values.grpc.includes(names[0]) ? values : null;
    }, "gRPC readiness failure did not remove only the gRPC endpoint while REST remained healthy");
    assert.ok(observed.http.includes(names[0]) && observed.http.includes(names[1]));
    await control(ips[0], true, "grpc");
    await waitFor(async () => {
      const values = await listInstances(client, 30);
      return values.grpc.includes(names[0]) ? values : null;
    }, "gRPC endpoint did not recover after readiness returned to SERVING");

    await control(ips[0], false);
    observed = await waitFor(async () => {
      const values = await listInstances(client, 12);
      return values.http.every((name) => name !== names[0]) && values.grpc.every((name) => name !== names[0]) && values.http.includes(names[1]) && values.grpc.includes(names[1]) ? values : null;
    }, "Traefik did not remove the unhealthy endpoint from HTTP and gRPC routing");
    assert.ok(observed.http.includes(names[1]) && observed.grpc.includes(names[1]));

    await control(ips[0], true);
    observed = await waitFor(async () => {
      const values = await listInstances(client, 40);
      return values.http.includes(names[0]) && values.grpc.includes(names[0]) ? values : null;
    }, "Traefik did not restore the recovered endpoint within 15 seconds");
    assert.ok(observed.http.includes(names[0]) && observed.grpc.includes(names[0]));
  } finally {
    client.close();
  }
}

async function observe() {
  const client = createGrpcClient();
  try {
    console.log(JSON.stringify(await listInstances(client, Number(process.env.OBSERVE_CALLS || 60))));
  } finally {
    client.close();
  }
}

async function noRoute() {
  const response = await httpRequest();
  assert.ok([404, 503].includes(response.status), `zero tasks do not serve an application backend (HTTP ${response.status})`);
  const client = createGrpcClient();
  try {
    await assert.rejects(client.call("zero-task"), "zero tasks removes the gRPC backend");
  } finally {
    client.close();
  }
}

async function available() {
  await waitFor(async () => {
    const response = await httpRequest();
    return response.status === 200 ? response : null;
  }, "HTTP route did not recover within 15 seconds");
  const client = createGrpcClient();
  try {
    await waitFor(async () => {
      try { return await client.call("recovered") } catch { return null; }
    }, "gRPC route did not recover within 15 seconds");
  } finally {
    client.close();
  }
}

async function proxyUnavailable() {
  await assert.rejects(httpRequest(), "stopped Traefik proxy is unreachable over the private network");
  const client = createGrpcClient();
  try {
    await assert.rejects(client.call("proxy-down"), "stopped Traefik proxy cannot serve gRPC calls");
  } finally {
    client.close();
  }
}

async function offlineHealth() {
  const ips = (process.env.FIXTURE_IPS || "").split(",").filter(Boolean);
  const names = (process.env.FIXTURE_HOSTNAMES || "").split(",").filter(Boolean);
  assert.equal(ips.length, 2);
  const client = createGrpcClient();
  try {
    let values = await listInstances(client, 30);
    assert.ok(names.every((name) => values.http.includes(name) && values.grpc.includes(name)), "cached HTTP and gRPC endpoints continue during Docker API discovery outage");
    await control(ips[0], false, "grpc");
    values = await waitFor(async () => {
      const next = await listInstances(client, 12);
      return next.http.includes(names[0]) && next.http.includes(names[1]) && next.grpc.includes(names[1]) && !next.grpc.includes(names[0]) ? next : null;
    }, "active gRPC health checks did not exclude an unhealthy endpoint while Docker discovery was offline");
    assert.ok(values.http.includes(names[0]), "REST remains healthy while gRPC reports NOT_SERVING");
    await control(ips[0], true, "grpc");
    values = await waitFor(async () => {
      const next = await listInstances(client, 30);
      return next.grpc.includes(names[0]) ? next : null;
    }, "active gRPC health checks did not restore an endpoint while discovery was offline");
    console.log(JSON.stringify(values));
  } finally {
    client.close();
  }
}

async function cachedSurvivor() {
  const expected = process.env.SURVIVOR_HOSTNAME;
  assert.ok(expected, "survivor hostname is required");
  const client = createGrpcClient();
  try {
    const values = await waitFor(async () => {
      const next = await listInstances(client, 12);
      return next.http.includes(expected) && next.grpc.includes(expected) && next.http.every((name) => name === expected) && next.grpc.every((name) => name === expected) ? next : null;
    }, "cached routes did not continue through the surviving backend while discovery was offline");
    console.log(JSON.stringify(values));
  } finally {
    client.close();
  }
}

if (process.argv[2] === "run") {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
} else if (process.argv[2] === "observe") {
  observe().catch((error) => { console.error(error); process.exitCode = 1; });
} else if (process.argv[2] === "no-route") {
  noRoute().catch((error) => { console.error(error); process.exitCode = 1; });
} else if (process.argv[2] === "available") {
  available().catch((error) => { console.error(error); process.exitCode = 1; });
} else if (process.argv[2] === "proxy-unavailable") {
  proxyUnavailable().catch((error) => { console.error(error); process.exitCode = 1; });
} else if (process.argv[2] === "offline-health") {
  offlineHealth().catch((error) => { console.error(error); process.exitCode = 1; });
} else if (process.argv[2] === "cached-survivor") {
  cachedSurvivor().catch((error) => { console.error(error); process.exitCode = 1; });
} else if (process.argv[2] === "control") {
  control(process.argv[3], process.argv[4] === "true").catch((error) => { console.error(error); process.exitCode = 1; });
} else {
  throw new Error("Expected run or control mode");
}
