import { basename } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const workspace = basename(process.argv[2] ?? "");
if (workspace === "auth-service") {
  const { createAuthApp } =
    await import("../services/auth-service/dist/index.js");
  const { createAuthGrpcServer } =
    await import("../services/auth-service/dist/grpc.js");
  if (typeof createAuthApp() !== "function")
    throw new Error("Auth HTTP factory unavailable");
  createAuthGrpcServer().forceShutdown();
  console.log(
    "Auth production dependencies, HTTP factory and gRPC descriptors load.",
  );
} else if (workspace === "tutor-service") {
  const { createTutorApp } =
    await import("../services/tutor-service/dist/http.js");
  const { createTutorGrpcServer } =
    await import("../services/tutor-service/dist/grpc.js");
  if (typeof createTutorApp({}) !== "function")
    throw new Error("Tutor HTTP factory unavailable");
  createTutorGrpcServer({}).forceShutdown();
  console.log(
    "Tutor production dependencies, HTTP factory and gRPC descriptors load.",
  );
} else if (workspace === "review-service") {
  const { createReviewApp } =
    await import("../services/review-service/dist/routes.js");
  const { createRatingServer } =
    await import("../services/review-service/dist/grpc.js");
  if (
    typeof createReviewApp(
      {},
      { gatewayCredential: "factory-check", actorPublicKey: "factory-check" },
    ) !== "function"
  )
    throw new Error("Review HTTP factory unavailable");
  createRatingServer({}, "factory-check").forceShutdown();
  console.log(
    "Review production dependencies, HTTP factory and gRPC descriptors load.",
  );
} else if (workspace === "web") {
  const reserve = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => reserve.once("listening", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const require = createRequire(
    new URL("../apps/web/package.json", import.meta.url),
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
      cwd: new URL("../apps/web/", import.meta.url),
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
} else
  throw new Error("Choose auth-service, tutor-service, review-service or web");
