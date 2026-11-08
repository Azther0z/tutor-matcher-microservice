import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const cli = process.env.CONTAINER_CLI || "docker";
const name = `tutor-matcher-auth-test-${randomUUID().slice(0, 8)}`;
function run(args) {
  const result = spawnSync(cli, args, { encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error(
      `Isolated database command failed: ${result.error?.message ?? result.stderr}`,
    );
  return result.stdout.trim();
}
let created = false;
try {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    run([
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "-e",
      "POSTGRES_DB=saint_test",
      "-p",
      "127.0.0.1::5432",
      "postgres:16-alpine",
    ]);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const check = spawnSync(
        cli,
        ["exec", name, "pg_isready", "-U", "postgres", "-d", "saint_test"],
        { stdio: "ignore" },
      );
      if (check.status === 0) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error("Isolated PostgreSQL did not become ready");
    const port = run(["port", name, "5432"]).split(":").at(-1);
    url = `postgresql://postgres@127.0.0.1:${port}/saint_test`;
  }
  const code = await new Promise((resolve, reject) => {
    const child = spawn("npm", ["test"], {
      env: { ...process.env, TEST_DATABASE_URL: url },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  process.exitCode = code ?? 1;
} finally {
  if (created) spawnSync(cli, ["stop", name], { stdio: "ignore" });
}
