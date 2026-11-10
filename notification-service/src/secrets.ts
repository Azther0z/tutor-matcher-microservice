import { readFileSync } from 'node:fs';

/**
 * Swarm mounts secrets as files. Each named secret may be given directly or through `<NAME>_FILE`, never both.
 * Call before reading configuration so a mounted file populates the same variable the code already reads.
 */
export function loadSecretFiles(names: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  for (const name of names) {
    const file = env[`${name}_FILE`];
    if (!file) continue;
    if (env[name]) throw new Error(`Configure either ${name} or ${name}_FILE`);
    const value = readFileSync(file, 'utf8').trim();
    if (!value) throw new Error(`${name}_FILE must not be empty`);
    env[name] = value;
  }
}

/** Opaque workload credentials must be long enough to resist guessing; the platform supplies distinct values per caller. */
export function credentialsFrom(env: NodeJS.ProcessEnv, callers: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const caller of callers) {
    const name = `${caller.toUpperCase()}_WORKLOAD_CREDENTIAL`;
    const value = env[name];
    if (!value) continue;
    if (value.length < 16) throw new Error(`${name} must be at least 16 characters`);
    out[caller] = value;
  }
  return out;
}
