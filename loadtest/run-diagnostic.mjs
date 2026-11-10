import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

export async function runDiagnostic({ gatewayUrl, token, request }) {
  for (let index = 1; index < 20; index += 1) {
    const result = await request("/profiles/me/tutor/subjects", {
      token,
      method: "POST",
      body: {
        name: `Integration Mathematics ${index}`,
        description: "Synthetic diagnostic offering.",
        hourlyRate: `${300 + index}.00`,
        format: "ONLINE",
        learningAreas: ["mathematics"],
      },
    });
    if (result.status !== 201)
      throw new Error("Diagnostic fixture creation failed before measurement.");
  }
  const directory = path.resolve("loadtest/results/ideal-2026-11-10");
  await mkdir(directory, { recursive: true });
  const hash = createHash("sha256");
  async function include(directory) {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await include(file);
      else {
        hash.update(file);
        hash.update(await readFile(file));
      }
    }
  }
  for (const folder of [
    "services/tutor-service/src",
    "services/review-service/src",
    "packages/shared/src",
    "contracts",
  ])
    await include(folder);
  const metadata = {
    measuredAt: new Date().toISOString(),
    baseRevision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    workingTree: true,
    sourceSha256: hash.digest("hex"),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuCount: os.cpus().length,
    memoryBytes: os.totalmem(),
    catalogueSubjects: 20,
    tutorProcesses: 1,
    resourceLimits: "Native host processes, no per-service CPU caps.",
    real: [
      "Traefik 3.7.17",
      "Auth/PostgreSQL",
      "Tutor/MongoDB replica set",
      "Review/MongoDB replica set",
      "gRPC transport",
    ],
    fixtures: ["Booking availability", "Swarm API discovery"],
    acceptance:
      "Diagnostic only. Does not establish Q-03 or a one-versus-three-replica result with real peers.",
    runs: [],
  };
  for (const mode of ["steady", "stress"]) {
    const summary = path.join(directory, `diagnostic-${mode}.json`);
    const child = spawn(
      process.env.K6_BIN || "k6",
      ["run", "--summary-export", summary, "loadtest/marketplace-search.js"],
      {
        env: {
          ...process.env,
          BASE_URL: gatewayUrl,
          TEST_TYPE: mode,
          SEARCH_QUERY: "Integration",
          MIN_RESULTS: "20",
          TUTOR_REPLICAS: "1-native-process",
          TESTED_REVISION: `${metadata.baseRevision}+working-tree`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let log = "";
    child.stdout.on("data", (chunk) => {
      log += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      log += String(chunk);
    });
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    await writeFile(path.join(directory, `diagnostic-${mode}.txt`), log);
    metadata.runs.push({ mode, exitCode, summary: path.basename(summary) });
    console.log(
      `Diagnostic ${mode} completed with k6 exit ${exitCode}; peer-fixture limitation applies.`,
    );
    if (![0, 99].includes(exitCode))
      throw new Error(`k6 ${mode} did not complete a measurement.`);
  }
  await writeFile(
    path.join(directory, "environment.json"),
    JSON.stringify(metadata, null, 2) + "\n",
  );
  return metadata.runs;
}
