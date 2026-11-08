import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const workspace = process.argv[2];
if (workspace === "auth-service") {
  const { createAuthApp } = await import("../auth-service/dist/index.js");
  const { createAuthGrpcServer } = await import("../auth-service/dist/grpc.js");
  if (typeof createAuthApp() !== "function")
    throw new Error("Auth HTTP factory unavailable");
  createAuthGrpcServer().forceShutdown();
  console.log(
    "Auth production dependencies, HTTP factory and gRPC descriptors load.",
  );
} else if (workspace === "web") {
  const reserve = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => reserve.once("listening", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const require = createRequire(
    new URL("../web/package.json", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [
      require.resolve("next/dist/bin/next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: new URL("../web/", import.meta.url),
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: "ignore",
    },
  );
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null)
        throw new Error("Web production process exited before readiness");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/login`);
        if (response.ok && (await response.text()).includes("Tutor Matcher")) {
          ready = true;
          break;
        }
      } catch {
        /* Wait for the isolated production process. */
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error("Web production login did not become ready");
    console.log("Web production dependencies and login page request pass.");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
} else throw new Error("Choose auth-service or web");
