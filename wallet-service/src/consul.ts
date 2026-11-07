import os from 'node:os';

/**
 * Registers this service's reachable HTTP address with an HTTP health check and advertises its gRPC port as
 * metadata, so peers never mistake the HTTP registration port for the gRPC port.
 * (shared/consul.js has no metadata option yet; Saint can fold this in when that file gains one.)
 */
export async function registerWithConsul(options: {
  consulUrl?: string; name: string; httpPort: number; grpcPort?: number; log?: (message: string) => void;
}): Promise<(() => Promise<void>) | undefined> {
  const log = options.log ?? console.log;
  if (!options.consulUrl) {
    log('[Wallet] CONSUL_URL not set; skipping service registration');
    return undefined;
  }
  const address = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1';
  const id = `${options.name}-${os.hostname()}`;
  const body = JSON.stringify({
    ID: id, Name: options.name, Address: address, Port: options.httpPort,
    ...(options.grpcPort ? { Meta: { grpc_port: String(options.grpcPort) } } : {}),
    Check: { HTTP: `http://${address}:${options.httpPort}/health`, Interval: '2s', Timeout: '1s', DeregisterCriticalServiceAfter: '1m' },
  });
  const consul = (path: string, init: RequestInit = {}) => fetch(options.consulUrl + path, { ...init, signal: AbortSignal.timeout(2000) });
  const put = async () => { const r = await consul('/v1/agent/service/register', { method: 'PUT', body }); if (!r.ok) throw new Error(`Consul returned ${r.status}`); };

  for (let attempt = 1; ; attempt += 1) {
    try { await put(); break; } catch (error) {
      if (attempt >= 30) { log(`[Wallet] could not register with Consul: ${(error as Error).message}`); return undefined; }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  log(`[Wallet] registered in Consul as ${id} at ${address}:${options.httpPort} (grpc_port ${options.grpcPort ?? '-'})`);
  const refresh = setInterval(() => put().catch(() => undefined), 30_000);
  refresh.unref();
  return async () => {
    clearInterval(refresh);
    await consul(`/v1/agent/service/deregister/${id}`, { method: 'PUT' }).catch(() => undefined);
  };
}
