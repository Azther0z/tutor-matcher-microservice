// Creates the per-producer broker users and applies their restricted permissions
// through the RabbitMQ management API. Safe to repeat: every call is a PUT.
//
// `auth` is the broker's bootstrap user and is deliberately left untouched: Auth declares
// the versioned topology itself, so it keeps the permissions Compose gave it.
// A producer is provisioned only when RABBITMQ_<NAME>_PASSWORD is supplied, so each owner
// adds their own user by supplying one more variable.
import { readFileSync } from "node:fs";

const base = (process.env.RABBITMQ_MANAGEMENT_URL || "http://rabbitmq:15672").replace(/\/$/, "");
const definitionsPath = process.env.RABBITMQ_DEFINITIONS || "/definitions.json";
const adminUser = process.env.RABBITMQ_ADMIN_USER || "auth";
const adminPassword = process.env.RABBITMQ_AUTH_PASSWORD;
if (!adminPassword) throw new Error("RABBITMQ_AUTH_PASSWORD is required to call the management API");

const definitions = JSON.parse(readFileSync(definitionsPath, "utf8"));
const authorization = `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString("base64")}`;
const vhost = encodeURIComponent("/");

async function put(path, body) {
  const response = await fetch(`${base}/api/${path}`, {
    method: "PUT",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`PUT ${path} returned ${response.status}`);
}

const users = [...new Set(definitions.permissions.map((entry) => entry.user))].filter((user) => user !== "auth");
const provisioned = [];
const skipped = [];
for (const user of users) {
  const password = process.env[`RABBITMQ_${user.toUpperCase()}_PASSWORD`];
  if (!password) {
    skipped.push(user);
    continue;
  }
  const name = encodeURIComponent(user);
  await put(`users/${name}`, { password, tags: "" });
  const permission = definitions.permissions.find((entry) => entry.user === user);
  await put(`permissions/${vhost}/${name}`, {
    configure: permission.configure,
    write: permission.write,
    read: permission.read,
  });
  for (const topic of definitions.topic_permissions.filter((entry) => entry.user === user)) {
    await put(`topic-permissions/${vhost}/${name}`, {
      exchange: topic.exchange,
      write: topic.write,
      read: topic.read,
    });
  }
  provisioned.push(user);
}
console.log(`Broker users provisioned: ${provisioned.join(", ") || "none"}.`);
if (skipped.length) console.log(`Not provisioned (no RABBITMQ_<NAME>_PASSWORD supplied): ${skipped.join(", ")}.`);
