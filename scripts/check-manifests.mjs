import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

for (const [path, command] of [
  ["compose.yaml", ["compose", "-f", "compose.yaml", "config", "--quiet"]],
  [
    "deploy/compose.yaml",
    ["stack", "config", "--compose-file", "deploy/compose.yaml"],
  ],
]) {
  const env = { ...process.env };
  // Synthetic interpolation only. Do not expand or print actual runtime secrets.
  for (const match of readFileSync(path, "utf8").matchAll(
    /\$\{([A-Z][A-Z0-9_]*)(?::[^}]*)?\}/g,
  ))
    env[match[1]] = "synthetic-validation-only";
  const result = spawnSync("docker", command, { env, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    console.error(
      `${path}: validation failed. ${result.error?.message ?? result.stderr}`,
    );
    process.exitCode = 1;
  } else
    console.log(
      `${path}: Docker configuration parser passed (synthetic values; no deployment).`,
    );
}
