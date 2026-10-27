const os = require('node:os');

const CONSUL_URL = process.env.CONSUL_URL;

function ownAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '127.0.0.1';
}

async function consul(path, options = {}) {
  const response = await fetch(CONSUL_URL + path, { ...options, signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`Consul ${path} returned ${response.status}`);
  return response;
}

async function registerService({ name, port, tag, ttl = false }) {
  if (!CONSUL_URL) {
    console.log(`[${tag}] CONSUL_URL not set; skipping service registration`);
    return;
  }
  const address = ownAddress();
  const id = `${name}-${os.hostname()}`;
  const check = ttl
    ? { TTL: '15s', DeregisterCriticalServiceAfter: '1m' }
    : { HTTP: `http://${address}:${port}/health`, Interval: '2s', Timeout: '1s', DeregisterCriticalServiceAfter: '1m' };
  const body = JSON.stringify({ ID: id, Name: name, Address: address, Port: port, Check: check });
  const put = () => consul('/v1/agent/service/register', { method: 'PUT', body });

  for (let attempt = 1; ; attempt += 1) {
    try {
      await put();
      break;
    } catch (error) {
      if (attempt >= 30) {
        console.warn(`[${tag}] could not register with Consul: ${error.message}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  console.log(`[${tag}] registered in Consul as ${id} at ${address}:${port}`);
  setInterval(() => put().catch(() => {}), 30000).unref();

  if (ttl) {
    const beat = () => consul(`/v1/agent/check/pass/service:${id}`, { method: 'PUT' }).catch(() => {});
    beat();
    setInterval(beat, 5000).unref();
  }

  const leave = async () => {
    await consul(`/v1/agent/service/deregister/${id}`, { method: 'PUT' }).catch(() => {});
    console.log(`[${tag}] deregistered from Consul`);
    process.exit(0);
  };
  process.once('SIGTERM', leave);
  process.once('SIGINT', leave);
}

module.exports = { registerService };
