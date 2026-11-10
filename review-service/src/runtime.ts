import { createRequire } from "node:module";

const runtimeRequire = createRequire(__filename);
const runtime = runtimeRequire("../../shared/runtime-env") as {
  loadRuntimeEnv(): void;
};

export const loadRuntimeEnv = runtime.loadRuntimeEnv;
