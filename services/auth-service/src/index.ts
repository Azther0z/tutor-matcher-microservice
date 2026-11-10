import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import { AppError, toHttpError } from '@tutor-matcher/shared';
import { migrate, pool } from './db';
import { publicRouter } from './routes';
import { requestId } from './security';
import { createAuthGrpcServer, listenAuthGrpc } from './grpc';
import { startOutboxPublisher } from './events';

export type AuthAppConfig = { jsonLimit?: string };

export function createAuthApp(config: AuthAppConfig = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.use(requestId);
  const jsonParser=express.json({ limit: config.jsonLimit ?? '1mb', strict: true });
  app.use((req,res,next)=>req.path==='/internal/gateway/authorize'?next():jsonParser(req,res,next));
  app.use(publicRouter);
  app.use((_req, res) => {
    const failure = toHttpError(new AppError(404,'ROUTE_NOT_FOUND','Route not found.'),res.getHeader('X-Request-Id')?.toString() ?? '');
    res.status(failure.status).json(failure.body);
  });
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const request = req.requestId ?? res.getHeader('X-Request-Id')?.toString() ?? '';
    if (error instanceof SyntaxError) error = new AppError(400,'MALFORMED_JSON','Request body is not valid JSON.');
    const code = (error as { code?: string } | null)?.code;
    const constraint = (error as { constraint?: string } | null)?.constraint;
    if (code === '23505' && constraint?.includes('email')) error = new AppError(409,'EMAIL_EXISTS','An account already uses this email address.',{'/email':'An account already uses this email address.'});
    else if (code === '23505') error = new AppError(409,'DUPLICATE_RESOURCE','This resource already exists.');
    else if (typeof code === 'string' && (code.startsWith('08') || ['57P01','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','EHOSTUNREACH','EPIPE'].includes(code))) error = new AppError(503,'DEPENDENCY_UNAVAILABLE','Auth storage is unavailable.',undefined,true);
    const retryAfter = (error as { retryAfterSeconds?: number } | null)?.retryAfterSeconds;
    if (typeof retryAfter === 'number') res.setHeader('Retry-After',String(retryAfter));
    const normalized=toHttpError(error,request);
    res.status(normalized.status).json(normalized.body);
  });
  return app;
}

async function main():Promise<void>{
  for(const name of ['DATABASE_URL','JWT_SECRET','RESET_CONTENT_KEY','ACTOR_ASSERTION_PRIVATE_KEY','ACTOR_ASSERTION_PUBLIC_KEY','GATEWAY_WORKLOAD_CREDENTIAL']) if(!process.env[name]) throw new Error(`${name} is required`);
  await migrate();
  const app=createAuthApp();
  const httpPort=Number(process.env.PORT??4002); const grpcPort=Number(process.env.GRPC_PORT??50051);
  const httpServer=app.listen(httpPort,'0.0.0.0');
  const grpcServer=createAuthGrpcServer();
  await listenAuthGrpc(grpcServer,grpcPort);
  const stopOutbox=startOutboxPublisher();
  console.log(`[Auth] REST listening on ${httpPort}; gRPC listening on ${grpcPort}`);
  const shutdown=()=>{
    stopOutbox();
    grpcServer.tryShutdown(()=>undefined);
    httpServer.close(()=>undefined);
    void pool.end();
  };
  process.once('SIGTERM',shutdown); process.once('SIGINT',shutdown);
}

if(require.main===module){
  void main().catch(error=>{
    const message=error instanceof Error&&/ is required$/.test(error.message)?error.message:'startup dependencies unavailable';
    console.error('[Auth] startup failed',message);
    process.exitCode=1;
  });
}
