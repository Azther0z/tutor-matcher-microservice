#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalDir = path.join(root, "infra/internal-traefik");
const inventory = JSON.parse(
  await readFile(path.join(root, "contracts/operation-map.json"), "utf8"),
);
const owners = new Set([
  "auth",
  "booking",
  "messaging",
  "notification",
  "review",
  "tutor",
  "wallet",
]);
const grpcOwners = new Set(["auth", "booking", "review", "tutor", "wallet"]);
const rest = inventory.filter(
  (route) =>
    route.protocol === "REST" &&
    route.surface === "PUBLIC" &&
    owners.has(route.owner),
);
const grpc = inventory.filter(
  (route) =>
    route.protocol === "GRPC" &&
    route.surface === "INTERNAL" &&
    grpcOwners.has(route.owner),
);
assert.equal(
  rest.length,
  88,
  "expected all existing contracted public REST operations",
);
assert.equal(
  grpc.length,
  20,
  "expected all existing contracted gRPC operations for the five owners",
);

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
    ? `PathRegexp(\`^${escaped}$\`)`
    : `Path(\`${route}\`)`;
}
function render(provider) {
  const lines = [
    `# Generated from contracts/operation-map.json by scripts/generate-internal-traefik-routes.mjs (${provider}).`,
    "# Internal owner routes are separate from public gateway routes and omit health/admin paths.",
    "http:",
    "  routers:",
  ];
  for (const route of [...rest].sort((a, b) =>
    a.operationId.localeCompare(b.operationId),
  )) {
    const routePath = route.path.startsWith("/api/")
      ? route.path.slice(4)
      : route.path;
    const method = route.method.toUpperCase();
    lines.push(`    ${route.operationId}:`);
    lines.push("      entryPoints: [internal]");
    lines.push(
      `      rule: Host(\`${route.owner}.internal\`) && ${pathRule(routePath)} && Method(\`${method}\`)`,
    );
    lines.push(
      `      priority: ${10000 + (routePath.match(/[^/]+/g)?.length ?? 0) * 100}`,
    );
    lines.push(`      service: internal-${route.owner}-http@${provider}`);
  }
  for (const owner of [...grpcOwners].sort()) {
    const methods = grpc
      .filter((route) => route.owner === owner)
      .map((route) => route.path)
      .sort();
    if (!methods.length) continue;
    lines.push(`    ${owner}-grpc:`);
    lines.push("      entryPoints: [internal]");
    lines.push(
      `      rule: Host(\`${owner}.internal\`) && (${methods.map((method) => `Path(\`${method}\`)`).join(" || ")})`,
    );
    lines.push(`      service: internal-${owner}-grpc@${provider}`);
  }
  return `${lines.join("\n")}\n`;
}
for (const [file, provider] of [
  ["routes.docker.yaml", "docker"],
  ["routes.swarm.yaml", "swarm"],
]) {
  const output = path.join(internalDir, file);
  const content = render(provider);
  if (process.argv.includes("--check")) {
    assert.equal(
      await readFile(output, "utf8"),
      content,
      `${output} is stale; run node scripts/generate-internal-traefik-routes.mjs`,
    );
  } else await writeFile(output, content);
}
