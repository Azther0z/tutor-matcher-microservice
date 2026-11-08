import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const output = resolve(
  root,
  process.argv[2] || ".runtime/hosted/apps/tutor-matcher-microservice",
);
const rel = relative(root, output);
if (rel.startsWith("..") || isAbsolute(rel) || !rel)
  throw new Error("Output must be a new directory inside this repository.");
let ancestor = output;
while (!existsSync(ancestor)) ancestor = dirname(ancestor);
const realRelative = relative(root, realpathSync(ancestor));
if (realRelative.startsWith("..") || isAbsolute(realRelative))
  throw new Error("Output cannot follow a symlink outside this repository.");
mkdirSync(output, { recursive: true });
if (readdirSync(output).length)
  throw new Error("Output directory is not empty; no files were replaced.");
let stack = readFileSync(resolve(root, "deploy/compose.yaml"), "utf8");
for (const [source, target] of [
  ["../docker/postgres-owned-databases.sh", "postgres-owned-databases.sh"],
  ["../docker/mongo-init.js", "mongo-init.js"],
  ["../docker/traefik-start.sh", "traefik-start.sh"],
  ["../api-gateway/routes.yaml", "routes.yaml"],
]) {
  stack = stack.replace(`file: ${source}`, `file: ./${target}`);
  copyFileSync(resolve(root, "deploy", source), resolve(output, target));
}
writeFileSync(resolve(output, "compose.yaml"), stack);
copyFileSync(
  resolve(root, "docker/hosted/doco-cd.yaml.example"),
  resolve(output, ".doco-cd.yaml"),
);
mkdirSync(resolve(output, "secrets"));
writeFileSync(
  resolve(output, "secrets/README.md"),
  "Supply approved SOPS/age-encrypted runtime.env.enc using the existing homelab key workflow. No plaintext runtime values belong here.\n",
);
console.log(
  "Prepared a local homelab app bundle. Images, encrypted runtime configuration, ingress and rollout remain review gates; nothing was deployed.",
);
