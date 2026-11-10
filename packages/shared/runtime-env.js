const { readFileSync } = require('node:fs');

// Swarm mounts secrets as files. Local Compose can continue using environment values.
function loadRuntimeEnv() {
  for (const name of ['DATABASE_URL', 'JWT_SECRET', 'MONGO_URI', 'RABBITMQ_URL']) {
    const file = process.env[`${name}_FILE`];
    if (!file) continue;
    if (process.env[name]) throw new Error(`Configure either ${name} or ${name}_FILE`);
    const value = readFileSync(file, 'utf8').trim();
    if (!value) throw new Error(`${name}_FILE must not be empty`);
    process.env[name] = value;
  }
}

module.exports = { loadRuntimeEnv };
