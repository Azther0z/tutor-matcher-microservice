import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { Server, ServerCredentials, status, type ServerUnaryCall, type sendUnaryData, Metadata } from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { randomUUID } from 'node:crypto';
import { AppError, encodeErrorDetail, normalizeProtoMessage, validateGrpcRequest, validateGrpcResponse, verifyActorAssertion, verifyWorkload } from '@tutor-matcher/shared';
import { inTransaction, pool } from './db';
import { now, decryptResetMaterial } from './security';

type Call = ServerUnaryCall<any, any>;
type Callback = sendUnaryData<any>;
const rpcAllowlist: Record<string, string[]> = {
  'LookupAccounts': ['tutor','booking','wallet','review','messaging','notification'],
  'ListActiveAdmins': ['notification'],
  'GrantTutorCapability': ['tutor'],
  'GetTutorGrant': ['tutor'],
  'GetResetNotificationContent': ['notification'],
};
const rpcStatus: Record<number, number> = {
  400: status.INVALID_ARGUMENT, 401: status.UNAUTHENTICATED, 403: status.PERMISSION_DENIED, 422: status.INVALID_ARGUMENT,
  404: status.NOT_FOUND, 409: status.FAILED_PRECONDITION, 429: status.RESOURCE_EXHAUSTED,
  503: status.UNAVAILABLE, 500: status.INTERNAL, 502: status.INTERNAL,
};

function requestId(call: Call): string {
  const value = call.metadata.get('x-request-id')[0];
  return typeof value === 'string' && isUuid(value) ? value : randomUUID();
}
function metadataText(call: Call, key: string): string | undefined {
  const value = call.metadata.get(key)[0];
  return typeof value === 'string' ? value : undefined;
}
function authenticate(call: Call, method: keyof typeof rpcAllowlist): string {
  const allowed = rpcAllowlist[method];
  const auth = metadataText(call,'authorization') ?? '';
  const allCallers=['tutor','booking','wallet','review','messaging','notification'];
  const matched=allCallers.find(name=>{
    const credential=process.env[`${name.toUpperCase()}_WORKLOAD_CREDENTIAL`];
    if(!credential)return false;
    try{verifyWorkload(auth,credential,name,method,{[name]:[method]});return true;}catch{return false;}
  });
  if (!matched) throw new AppError(401,'INVALID_WORKLOAD','Workload authentication failed.');
  if(!allowed.includes(matched))throw new AppError(403,'FORBIDDEN','This workload is not allowed to call this Auth method.');
  const caller=matched;
  return caller;
}
function fail(error: unknown, call: Call, callback: Callback): void {
  const appError = error instanceof AppError ? error : new AppError(500,'INTERNAL_ERROR','The Auth operation failed.');
  const trailer = new Metadata();
  const fields = appError.fields ? Object.entries(appError.fields).map(([path,message])=>({path,code:'INVALID_FIELD',message})) : [];
  trailer.set('tutor-error-bin',encodeErrorDetail({code:appError.code,message:appError.message,requestId:requestId(call),retryable:appError.retryable,fields}));
  callback({ code:rpcStatus[appError.status] ?? status.INTERNAL, details:appError.message, metadata:trailer });
}
function guarded(method: keyof typeof rpcAllowlist, work: (call: Call, caller: string, req: any) => Promise<any>) {
  return (call: Call, callback: Callback) => {
    void (async () => {
      try {
        const incomingRequestId=metadataText(call,'x-request-id');
        if(!incomingRequestId||!isUuid(incomingRequestId))throw new AppError(400,'INVALID_REQUEST_ID','A valid x-request-id UUID is required.');
        const caller = authenticate(call,method);
        const request = normalizeProtoMessage(stripProtoPresence(call.request)) as Record<string, any>;
        const operationId=method[0].toLowerCase()+method.slice(1);
        validateGrpcRequest(operationId,request);
        const response = await work(call,caller,request);
        validateGrpcResponse(operationId,response);
        const headers = new Metadata(); headers.set('x-request-id',requestId(call)); call.sendMetadata(headers);
        callback(null,response);
      } catch(error) { fail(error,call,callback); }
    })();
  };
}
function stripProtoPresence(value: unknown): unknown {
  if(Array.isArray(value))return value.map(stripProtoPresence);
  if(!value||typeof value!=='object'||Buffer.isBuffer(value))return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!key.startsWith('_')).map(([key,item])=>[key,stripProtoPresence(item)]));
}
function requiredString(value: unknown, field: string, uuid = false): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || (uuid && !isUuid(value))) throw new AppError(400,'VALIDATION_FAILED',`${field} is required or invalid.`,{[`/${field}`]:'Required valid value.'});
  return value;
}
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function ensureArray(value: unknown, field: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum || value.some(item=>typeof item!=='string')) throw new AppError(400,'VALIDATION_FAILED',`${field} is invalid.`);
  const items=value as string[];
  if(new Set(items).size!==items.length || items.some(item=>!isUuid(item))) throw new AppError(400,'VALIDATION_FAILED',`${field} must contain unique UUIDs.`);
  return items;
}
function actorAdmission(call: Call, admission: any) {
  const id=requiredString(admission?.id,'admission.id',true);
  const actorUserId=requiredString(admission?.actorUserId,'admission.actorUserId',true);
  const sessionId=requiredString(admission?.sessionId,'admission.sessionId',true);
  const admittedAt=requiredString(admission?.admittedAt,'admission.admittedAt');
  const request=requiredString(admission?.requestId,'admission.requestId',true);
  const publicOperation=requiredString(admission?.publicOperation,'admission.publicOperation');
  const token=metadataText(call,'x-actor-context');
  if(token && process.env.ACTOR_ASSERTION_PUBLIC_KEY){
    const claims=verifyActorAssertion(token,process.env.ACTOR_ASSERTION_PUBLIC_KEY);
    if(claims.admissionId!==id||claims.userId!==actorUserId||claims.sessionId!==sessionId||claims.requestId!==request||claims.publicOperation!==publicOperation||!claims.capabilities.includes('ADMIN')) throw new AppError(403,'FORBIDDEN','Admission does not match the signed actor.');
  }
  if(Number.isNaN(Date.parse(admittedAt))) throw new AppError(400,'VALIDATION_FAILED','Admission timestamp is invalid.');
  if(Date.parse(admittedAt)>now().getTime()+30_000) throw new AppError(400,'VALIDATION_FAILED','Admission timestamp cannot be in the future.');
  return {id,actorUserId,sessionId,admittedAt,requestId:request,publicOperation};
}

export function createAuthGrpcServer(): Server {
  const root = process.env.CONTRACTS_GRPC_DIR ?? path.resolve(__dirname,'../../contracts/grpc');
  const proto = path.join(root,'auth/v1/collaboration.proto');
  const definition=protoLoader.loadSync(proto,{includeDirs:[root],keepCase:false,longs:String,enums:String,defaults:false,oneofs:true});
  const loaded=grpc.loadPackageDefinition(definition) as any;
  const service=loaded.tutor_matcher.auth.v1.AuthCollaborationService.service;
  const server=new Server({ 'grpc.max_receive_message_length':32*1024*1024, 'grpc.max_send_message_length':32*1024*1024 });
  server.addService(service,{
    lookupAccounts:guarded('LookupAccounts',async(_call,_caller,req)=>{
      const ids=ensureArray(req.userIds,'userIds',100);
      const {rows}=await pool.query('SELECT * FROM users WHERE id=ANY($1::uuid[])',[ids]);
      const byId=new Map(rows.map(row=>[row.id,row]));
      return {items:ids.filter(id=>byId.has(id)).map(id=>{const row=byId.get(id)!;return {id:row.id,displayName:`${row.first_name} ${row.last_name}`.trim(),email:row.email,status:row.status,capabilities:row.capabilities};})};
    }),
    listActiveAdmins:guarded('ListActiveAdmins',async()=>{
      const {rows}=await pool.query("SELECT * FROM users WHERE status='ACTIVE' AND 'ADMIN'=ANY(capabilities) ORDER BY id");
      return {items:rows.map(row=>({id:row.id,displayName:`${row.first_name} ${row.last_name}`.trim(),email:row.email,status:row.status,capabilities:row.capabilities}))};
    }),
    grantTutorCapability:guarded('GrantTutorCapability',async(call,_caller,req)=>{
      const operationId=requiredString(req.operationId,'operationId',true);
      const userId=requiredString(req.command?.userId,'command.userId',true);
      const submissionId=requiredString(req.command?.submissionId,'command.submissionId',true);
      const approvalRevision=requiredString(req.command?.approvalRevision,'command.approvalRevision');
      if(!/^(0|[1-9][0-9]*)$/.test(approvalRevision))throw new AppError(400,'VALIDATION_FAILED','approvalRevision must be a non-negative decimal string.');
      const admission=actorAdmission(call,req.command?.admission);
      return inTransaction(async client=>{
        const lockKey=`tutor-grant:${operationId}`;
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lockKey]);
        const existing=await client.query('SELECT * FROM tutor_grants WHERE operation_id=$1 FOR UPDATE',[operationId]);
        if(existing.rowCount){const g=existing.rows[0];const saved=g.admission as typeof admission|undefined;if(g.user_id!==userId||g.submission_id!==submissionId||g.approval_revision!==approvalRevision||!saved||saved.id!==admission.id||saved.actorUserId!==admission.actorUserId||saved.sessionId!==admission.sessionId||saved.admittedAt!==admission.admittedAt||saved.requestId!==admission.requestId||saved.publicOperation!==admission.publicOperation)throw new AppError(409,'IDEMPOTENCY_CONFLICT','Tutor grant identity was reused with different input.');return {operationId:g.operation_id,userId:g.user_id,capability:'TUTOR',status:'APPLIED',appliedAt:g.applied_at.toISOString()};}
        const bySubmission=await client.query('SELECT * FROM tutor_grants WHERE submission_id=$1 AND approval_revision=$2 FOR UPDATE',[submissionId,approvalRevision]);
        if(bySubmission.rowCount)throw new AppError(409,'IDEMPOTENCY_CONFLICT','This Tutor approval already has a different grant identity.');
        const {rows}=await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[userId]);
        if(!rows[0])throw new AppError(404,'NOT_FOUND','Applicant account was not found.');
        const capabilities:string[]=rows[0].capabilities;
        if(!capabilities.includes('TUTOR')){capabilities.push('TUTOR');await client.query('UPDATE users SET capabilities=$2,revision=revision+1,updated_at=now() WHERE id=$1',[userId,capabilities]);}
        const at=now();
        await client.query('INSERT INTO tutor_grants(operation_id,user_id,submission_id,approval_revision,applied_at,admission) VALUES($1,$2,$3,$4,$5,$6)',[operationId,userId,submissionId,approvalRevision,at,JSON.stringify(admission)]);
        await client.query(`INSERT INTO auth_operations(id,actor_user_id,kind,status,resource,created_at,updated_at) VALUES($1,$2,'tutor-grant','SUCCEEDED',$3,$4,$4) ON CONFLICT(id) DO NOTHING`,[operationId,admission.actorUserId,JSON.stringify({type:'account',id:userId,url:`/api/admin/users/${userId}`}),at]);
        return {operationId,userId,capability:'TUTOR',status:'APPLIED',appliedAt:at.toISOString()};
      });
    }),
    getTutorGrant:guarded('GetTutorGrant',async(_call,_caller,req)=>{
      const operationId=requiredString(req.operationId,'operationId',true);
      const {rows}=await pool.query('SELECT * FROM tutor_grants WHERE operation_id=$1',[operationId]);
      if(!rows[0])throw new AppError(404,'NOT_FOUND','Tutor grant was not found.');
      return {operationId:rows[0].operation_id,userId:rows[0].user_id,capability:'TUTOR',status:'APPLIED',appliedAt:rows[0].applied_at.toISOString()};
    }),
    getResetNotificationContent:guarded('GetResetNotificationContent',async(_call,_caller,req)=>{
      const contentRef=requiredString(req.contentRef,'contentRef',true);
      const {rows}=await pool.query(`SELECT rc.*,rt.consumed_at AS token_consumed,u.id AS recipient_user_id FROM reset_contents rc
        JOIN reset_tokens rt ON rt.id=rc.reset_token_id JOIN users u ON u.id=rc.user_id
        WHERE rc.content_ref=$1 AND rc.expires_at>$2 AND rc.consumed_at IS NULL AND rt.expires_at>$2 AND rt.consumed_at IS NULL AND rt.revoked_at IS NULL`,[contentRef,now()]);
      if(!rows[0])throw new AppError(404,'NOT_FOUND','Reset notification content is unavailable.');
      const text=decryptResetMaterial(rows[0].nonce,rows[0].ciphertext,rows[0].auth_tag);
      return {contentRef,recipientUserId:rows[0].recipient_user_id,subject:'Tutor Matcher password reset',text,sensitive:true,expiresAt:rows[0].expires_at.toISOString()};
    }),
  });
  return server;
}

export async function listenAuthGrpc(server: Server, port=Number(process.env.GRPC_PORT??50051)):Promise<void>{
  await new Promise<void>((resolve,reject)=>server.bindAsync(`0.0.0.0:${port}`,ServerCredentials.createInsecure(),error=>error?reject(error):resolve()));
}
