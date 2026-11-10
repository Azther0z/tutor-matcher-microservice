import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import type { WorkloadAuthenticator } from '../auth';
import type { Contracts } from '../contracts';
import type { FinancialService } from '../domain/financial';
import { AppError, asAppError } from '../errors';
import { isUuid } from '../ids';
import { CHANNEL_OPTIONS, decoded, encodeErrorDetail, loadProtos, toWire } from './proto';

type Unary = (call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) => void;

const ALLOWED_CALLERS = ['booking'] as const;

interface Deps {
  contractsDir: string;
  contracts: Contracts;
  workload: WorkloadAuthenticator;
  finance: FinancialService;
}

/** Builds the seven WalletFinanceService handlers. Each authenticates the workload, validates the decoded view, and maps errors. */
export function buildHandlers(deps: Deps): Record<string, Unary> {
  const { contracts, workload, finance } = deps;

  const wrap = (view: string, responseDef: string, run: (request: any) => Promise<unknown>): Unary => async (call, callback) => {
    const supplied = call.metadata.get('x-request-id')[0];
    const requestId = typeof supplied === 'string' && isUuid(supplied) ? supplied : randomUUID();
    const initial = new grpc.Metadata();
    initial.set('x-request-id', requestId);
    call.sendMetadata(initial);
    try {
      workload.require(call.metadata.get('authorization')[0] as string | undefined, ALLOWED_CALLERS);
      const request = contracts.assertView<any>(view, decoded(call.request));
      const result = await run(request);
      contracts.assertDef(responseDef, result); // a response that breaks the contract is our bug, never the caller's
      callback(null, toWire(result));
    } catch (error) {
      const app = error instanceof AppError ? error : asAppError(error);
      const trailer = new grpc.Metadata();
      trailer.set('x-request-id', requestId);
      trailer.set('tutor-error-bin', encodeErrorDetail(deps.contractsDir, {
        code: app.code, message: app.message, requestId, retryable: app.retryable, fields: app.fields, ...(app.operationId ? { operationId: app.operationId } : {}),
      }));
      if (app.code === 'INTERNAL') console.error(`[Wallet] gRPC request ${requestId} failed`, error);
      callback({ code: app.grpc, details: app.message.slice(0, 200), metadata: trailer }, null);
    }
  };

  return {
    ApplyLessonCharge: wrap('ApplyLessonChargeRequest', 'PaymentResult', (r) => finance.applyLessonCharge(r.operationId, r.command)),
    GetLessonCharge: wrap('GetLessonChargeRequest', 'PaymentResult', (r) => finance.getLessonCharge(r.operationId)),
    ResolveOrCloseLessonCharge: wrap('ResolveOrCloseLessonChargeRequest', 'PaymentResult', (r) => finance.resolveOrCloseLessonCharge(r.operationId, r.command)),
    ApplyCancellationRefund: wrap('ApplyCancellationRefundRequest', 'RefundResult', (r) => finance.applyCancellationRefund(r.operationId, r.command)),
    GetRefundOutcome: wrap('GetRefundOutcomeRequest', 'RefundResult', (r) => finance.getRefundOutcome(r.operationId)),
    RecordLessonCompletion: wrap('RecordLessonCompletionRequest', 'FinancialRecord', (r) => finance.recordLessonCompletion(r.bookingId, r.command)),
    GetBookingFinancialRecord: wrap('GetBookingFinancialRecordRequest', 'FinancialRecord', (r) => finance.getBookingFinancialRecord(r.bookingId)),
  };
}

export async function startGrpcServer(deps: Deps, port: number, host = '0.0.0.0'): Promise<{ server: grpc.Server; port: number }> {
  const proto = loadProtos(deps.contractsDir, ['wallet/v1/finance.proto']) as any;
  const service = proto.tutor_matcher.wallet.v1.WalletFinanceService.service;
  const server = new grpc.Server(CHANNEL_OPTIONS);
  server.addService(service, buildHandlers(deps));
  // The private overlay network plus the per-caller workload credential protect this port; it is never published.
  const bound = await new Promise<number>((resolve, reject) => {
    server.bindAsync(`${host}:${port}`, grpc.ServerCredentials.createInsecure(), (error, actual) => (error ? reject(error) : resolve(actual)));
  });
  return { server, port: bound };
}
