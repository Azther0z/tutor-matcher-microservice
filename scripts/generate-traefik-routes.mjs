#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "infra/gateway/routes.yaml");
const checkOnly = process.argv.includes("--check");
const spec = JSON.parse(
  await readFile(path.join(root, "contracts/public.openapi.json"), "utf8"),
);
const inventory = JSON.parse(
  await readFile(path.join(root, "contracts/operation-map.json"), "utf8"),
);
const operations = inventory.filter(
  (entry) => entry.protocol === "REST" && entry.surface === "PUBLIC",
);
assert.equal(
  operations.length,
  90,
  "expected exactly 90 public REST operations",
);
const owners = [
  "auth",
  "booking",
  "messaging",
  "notification",
  "review",
  "tutor",
  "wallet",
];

function pathRule(route) {
  const escaped = route
    .split(/(\{[^/{}]+\})/)
    .map((part) =>
      part.startsWith("{")
        ? "[^/]+"
        : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return route.includes("{")
    ? "PathRegexp(`^" + escaped + "$`)"
    : "Path(`" + route + "`)";
}
function routePriority(route) {
  const parts = route.split("/").filter(Boolean);
  const literal = parts.filter((part) => !part.startsWith("{")).length;
  return 10000 + literal * 100 + parts.length;
}
function middlewareNames(operation) {
  return operation.protected
    ? "[strip-client-identity, gateway-auth-credential, authorize, strip-forwardauth-proof, owner-credential, strip-api-prefix]"
    : "[strip-client-identity, owner-credential, strip-api-prefix]";
}

const specOperations = new Map();
for (const [route, pathItem] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (operation.operationId)
      specOperations.set(
        `${method.toUpperCase()} ${"/api" + route}`,
        operation,
      );
  }
}
const normalized = operations.map((entry) => {
  assert.ok(
    owners.includes(entry.owner) ||
      entry.operationId === "getHealth" ||
      entry.operationId === "getOperation",
    `unsupported REST owner ${entry.owner}`,
  );
  const contractOperation = specOperations.get(`${entry.method} ${entry.path}`);
  assert.ok(
    contractOperation,
    `operation map route missing from OpenAPI: ${entry.method} ${entry.path}`,
  );
  return {
    ...entry,
    protected: Boolean(contractOperation.security?.length),
    route: entry.path,
  };
});
assert.equal(
  new Set(normalized.map(({ method, route }) => `${method} ${route}`)).size,
  90,
  "route inventory must be unique",
);
assert.equal(
  specOperations.size,
  90,
  "OpenAPI public route count differs from operation map",
);

const lines = [
  "# Generated from contracts/public.openapi.json and contracts/operation-map.json by scripts/generate-traefik-routes.mjs.",
  "# Edit the source contracts, then regenerate. Do not add wildcard public routes.",
  "http:",
  "  middlewares:",
  "    strip-client-identity:",
  "      headers:",
  "        customRequestHeaders:",
  '          X-User-Id: ""',
  '          X-User-Email: ""',
  '          X-Actor-Context: ""',
  '          X-Caller-Id: ""',
  '          X-Workload-Authorization: ""',
  "    gateway-auth-credential:",
  "      headers:",
  "        customRequestHeaders:",
  "          X-Workload-Authorization: 'Bearer {{ env \"GATEWAY_WORKLOAD_CREDENTIAL\" }}'",
  "    owner-credential:",
  "      headers:",
  "        customRequestHeaders:",
  "          Authorization: 'Bearer {{ env \"GATEWAY_WORKLOAD_CREDENTIAL\" }}'",
  "    strip-forwardauth-proof:",
  "      headers:",
  "        customRequestHeaders:",
  '          X-Workload-Authorization: ""',
  "    authorize:",
  "      forwardAuth:",
  "        address: http://127.0.0.1:8081/internal/gateway/authorize",
  "        trustForwardHeader: false",
  "        authRequestHeaders: [Authorization, X-Workload-Authorization, X-Request-Id, X-Forwarded-Method, X-Forwarded-Uri, Idempotency-Key, If-Match, If-None-Match, Content-Type]",
  "        authResponseHeaders: [X-Actor-Context, X-Request-Id]",
  "    strip-api-prefix:",
  "      stripPrefix:",
  "        prefixes: [/api]",
  "    replace-operation-prefix:",
  "      replacePathRegex:",
  "        regex: ^/api/operations/([^/]+)/([^/]+)$",
  "        replacement: /internal/v1/$1/operations/$2",
  "    retry-read:",
  "      retry:",
  "        attempts: 2",
  "        initialInterval: 50ms",
  '        status: ["502-504"]',
  "  services:",
  "    unavailable:",
  "      loadBalancer:",
  "        servers: []",
  "  routers:",
  "    auth-check:",
  "      entryPoints: [auth]",
  "      rule: Path(`/internal/gateway/authorize`) && Method(`GET`)",
  "      middlewares: [gateway-auth-credential]",
  '      service: auth-service@{{ env "TRAEFIK_DISCOVERY_PROVIDER" }}',
];

function routeBlock(
  name,
  operation,
  service,
  fallback = false,
  specialOwner = null,
) {
  const route = specialOwner
    ? `/api/operations/${specialOwner}/{operationId}`
    : operation.route;
  const method = operation.method;
  const match = pathRule(route) + " && Method(`" + method + "`)";
  lines.push(`    ${name}:`);
  lines.push("      entryPoints: [web]");
  lines.push(`      rule: ${match}`);
  lines.push(`      priority: ${fallback ? 1 : routePriority(route)}`);
  const chain = specialOwner
    ? operation.protected
      ? "[strip-client-identity, gateway-auth-credential, authorize, strip-forwardauth-proof, owner-credential, replace-operation-prefix]"
      : "[strip-client-identity, owner-credential, replace-operation-prefix]"
    : middlewareNames(operation);
  lines.push(
    `      middlewares: ${chain.replace(/\]$/, operation.method === "GET" || operation.method === "HEAD" ? ", retry-read]" : "]")}`,
  );
  lines.push(`      service: ${service}`);
}

for (const operation of normalized) {
  const opName = operation.operationId
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
  const routedOwner =
    operation.operationId === "getHealth" ? "auth" : operation.owner;
  const ownerService = `${routedOwner}-service@{{ env "TRAEFIK_DISCOVERY_PROVIDER" }}`;
  if (operation.operationId === "getOperation") {
    for (const owner of owners) {
      const scoped = {
        ...operation,
        operationId: `${operation.operationId}-${owner}`,
      };
      routeBlock(
        scoped.operationId,
        scoped,
        ownerService.replace("gateway-service", `${owner}-service`),
        false,
        owner,
      );
      routeBlock(
        `${scoped.operationId}-unavailable`,
        scoped,
        "unavailable",
        true,
        owner,
      );
    }
  } else {
    routeBlock(opName, operation, ownerService);
    routeBlock(`${opName}-unavailable`, operation, "unavailable", true);
  }
}

const generated = `${lines.join("\n")}\n`;
if (checkOnly) {
  const current = await readFile(output, "utf8").catch(() => "");
  if (current !== generated) {
    console.error(
      "infra/gateway/routes.yaml is stale; run node scripts/generate-traefik-routes.mjs",
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(output, generated);
}
