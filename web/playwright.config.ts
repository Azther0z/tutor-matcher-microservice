import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const systemChrome =
  process.platform === "linux" && existsSync("/usr/bin/google-chrome")
    ? "/usr/bin/google-chrome"
    : undefined;
const executablePath = process.env.CHROME_BIN || systemChrome;
const testPort = 3127;
const localBaseURL = `http://localhost:${testPort}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || localBaseURL,
    ...devices["Desktop Chrome"],
    launchOptions: executablePath ? { executablePath } : {},
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${testPort}`,
    url: localBaseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
