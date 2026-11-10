import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { verifyActorAssertion } from '@tutor-matcher/shared';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as protobuf from 'protobufjs';
import { signActorAssertion } from '@tutor-matcher/shared';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(databaseUrl){
  const parsed=new URL(databaseUrl);
  if(!parsed.pathname.toLowerCase().includes('test')||!['127.0.0.1','localhost','::1'].includes(parsed.hostname))throw new Error('TEST_DATABASE_URL must identify an isolated loopback test database.');
}
test('Auth database, idempotency, rate limits, reset lifecycle and gRPC ACLs', {skip:!databaseUrl}, async t=>{
  assert.ok(databaseUrl);
  process.env.DATABASE_URL=databaseUrl;
  process.env.AUTH_MIGRATIONS_DIR=path.resolve(__dirname,'../migrations');
  process.env.JWT_SECRET=randomBytes(32).toString('hex');
  process.env.IDEMPOTENCY_SECRET=randomBytes(32).toString('hex');
  process.env.AUTH_FINGERPRINT_KEY=process.env.IDEMPOTENCY_SECRET;
  process.env.RESET_CONTENT_KEY=randomBytes(32).toString('hex');
  process.env.RESET_TOKEN_PEPPER=randomBytes(32).toString('hex');
  process.env.GATEWAY_WORKLOAD_CREDENTIAL=randomBytes(32).toString('hex');
  process.env.TUTOR_WORKLOAD_CREDENTIAL=randomBytes(32).toString('hex');
  process.env.NOTIFICATION_WORKLOAD_CREDENTIAL=randomBytes(32).toString('hex');
  process.env.DEMO_MODE='true';
  process.env.AUTH_SYNTHETIC_EMAILS='';
  delete process.env.CONSUL_URL; delete process.env.RABBITMQ_URL;
  const keys=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  process.env.ACTOR_ASSERTION_PUBLIC_KEY=keys.publicKey;
  process.env.ACTOR_ASSERTION_PRIVATE_KEY=keys.privateKey;
  process.env.ADMIN_SIGNUP_KEY=randomBytes(32).toString('hex');
  process.env.AUTH_DEMO_PASSWORD=randomBytes(18).toString('base64url');

  const {migrate,pool}=await import('./db');
  const {createAuthApp}=await import('./index');
  const {createAuthGrpcServer}=await import('./grpc');
  const {setAuthClock,decryptResetMaterial}=await import('./security');
  const {DEMO_ACCOUNTS,seedDemoAccounts}=await import('./seed');
  const seeded=await seedDemoAccounts();
  assert.equal(seeded.created+seeded.existing,DEMO_ACCOUNTS.length);
  const seedRows=await pool.query('SELECT id,email,capabilities,synthetic,password_hash FROM users WHERE id=ANY($1::uuid[])',[DEMO_ACCOUNTS.map(user=>user.id)]);
  assert.equal(seedRows.rowCount,DEMO_ACCOUNTS.length);
  assert.ok(seedRows.rows.every(row=>row.synthetic));
  const candidateRow=seedRows.rows.find(row=>row.email==='candidate.demo@example.test');
  assert.deepEqual(candidateRow?.capabilities,['STUDENT'],'demo candidate remains a Student until Tutor approval');
  const originalSeedHash=candidateRow?.password_hash;
  await seedDemoAccounts();
  const repeatedSeed=await pool.query('SELECT password_hash FROM users WHERE id=$1',[DEMO_ACCOUNTS[2].id]);
  assert.equal(repeatedSeed.rows[0].password_hash,originalSeedHash,'seed reruns must not reset demo passwords');
  const {server:grpcServer,port:grpcPort}=await startGrpc(createAuthGrpcServer());
  const httpServer=createAuthApp().listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>httpServer.once('listening',()=>resolve()));
  await migrate();
  t.after(async()=>{
    httpServer.close(); grpcServer.forceShutdown();
    await pool.end();
  });

  const address=httpServer.address(); assert.ok(address&&typeof address==='object');
  const base=`http://127.0.0.1:${address.port}`;
  const health=await fetch(`${base}/health`);
  assert.equal(health.status,200);
  assert.deepEqual(await health.json(),{status:'OK',service:'auth-service'});
  const gateway=process.env.GATEWAY_WORKLOAD_CREDENTIAL!;
  const commonHeaders=()=>({authorization:`Bearer ${gateway}`,'content-type':'application/json','x-request-id':randomUUID()});
  const request=async(pathname:string,body:unknown,headers:Record<string,string>={},method='POST')=>fetch(base+pathname,{method,headers:{...commonHeaders(),...headers},body:method==='GET'?undefined:JSON.stringify(body)});
  const unique=`auth-${randomUUID()}@example.test`;
  const longPassword='a'.repeat(72)+'one';
  const signupBody={firstName:'Auth',lastName:'Fixture',email:unique,password:longPassword,passwordConfirmation:longPassword,termsAccepted:true,privacyAccepted:true};
  const idempotencyKey=randomUUID();
  const sameKeyHeaders={'idempotency-key':idempotencyKey};
  const [signupA,signupB]=await Promise.all([
    request('/auth/signup',signupBody,sameKeyHeaders),
    request('/auth/signup',signupBody,sameKeyHeaders),
  ]);
  assert.equal(signupA.status,201); assert.equal(signupB.status,201);
  const sessionA=await signupA.json() as any; const sessionB=await signupB.json() as any;
  assert.equal(sessionA.user.id,sessionB.user.id,'same idempotency key must create one account under concurrency');
  assert.equal(sessionA.token,sessionB.token,'same signup replay must recover the original still-valid session');

  const admissionHeaders=(session:any, forwardedMethod:string, forwardedUri:string, extra:Record<string,string>={})=>({
    'x-workload-authorization':`Bearer ${gateway}`,
    authorization:`Bearer ${session.token}`,
    'x-forwarded-method':forwardedMethod,
    'x-forwarded-uri':forwardedUri,
    'x-request-id':randomUUID(),
    ...extra,
  });
  const admit=async(headers:Record<string,string>)=>fetch(`${base}/internal/gateway/authorize`,{method:'GET',headers});
  const admittedRequestId=randomUUID();
  const admitted=await admit(admissionHeaders(sessionA,'GET','/profiles/me/student',{'x-request-id':admittedRequestId}));
  assert.equal(admitted.status,204,'valid protected request must pass ForwardAuth');
  const admittedActor=admitted.headers.get('x-actor-context');
  assert.ok(admittedActor,'successful admission must return a signed actor assertion');
  const admittedClaims=verifyActorAssertion(admittedActor!,keys.publicKey);
  assert.equal(admittedClaims.publicOperation,'getStudentProfile');
  assert.equal(admittedClaims.requestId,admittedRequestId);
  assert.equal(admittedClaims.userId,sessionA.user.id);
  assert.equal(admittedClaims.exp! - admittedClaims.iat!,60,'actor assertions expire after 60 seconds');
  assert.throws(()=>verifyActorAssertion(admittedActor!,keys.publicKey,admittedClaims.exp!+1),'expired assertions must fail verification');
  const generatedIdHeaders:Record<string,string>=admissionHeaders(sessionA,'GET','/profiles/me/student');
  delete generatedIdHeaders['x-request-id'];
  generatedIdHeaders['x-actor-context']='browser-forged-actor';
  const generatedIdAdmission=await admit(generatedIdHeaders);
  assert.equal(generatedIdAdmission.status,204,'missing request IDs are generated by Auth and spoofed actor assertions are ignored');
  const generatedId=generatedIdAdmission.headers.get('x-request-id');
  assert.ok(generatedId&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generatedId));
  assert.equal(verifyActorAssertion(generatedIdAdmission.headers.get('x-actor-context')!,keys.publicKey).requestId,generatedId);
  const bookingAdmission=await admit(admissionHeaders(sessionA,'GET','/bookings'));
  const bookingAdmissionBody=bookingAdmission.status===204?'':await bookingAdmission.text();
  assert.equal(bookingAdmission.status,204,`Auth admits a protected operation owned by another service from the same OpenAPI map: ${bookingAdmissionBody}`);
  assert.equal(verifyActorAssertion(bookingAdmission.headers.get('x-actor-context')!,keys.publicKey).publicOperation,'listBookings');
  const missingProof=await admit({...admissionHeaders(sessionA,'GET','/profiles/me/student'),'x-workload-authorization':'Bearer invalid'});
  assert.equal(missingProof.status,401,'private admission rejects an invalid Gateway workload proof');
  const missingProofError=await missingProof.json() as any;
  assert.deepEqual(Object.keys(missingProofError).sort(),['code','fields','message','requestId','retryable']);
  assert.ok(!JSON.stringify(missingProofError).includes(gateway),'ForwardAuth errors do not expose credentials');
  const publicRouteThroughAdmission=await admit(admissionHeaders(sessionA,'POST','/auth/login'));
  assert.equal(publicRouteThroughAdmission.status,403,'anonymous public operations cannot use protected admission');
  const unknownQuery=await admit(admissionHeaders(sessionA,'GET','/admin/users?unknown=1'));
  assert.equal(unknownQuery.status,400,'admission rejects query parameters outside the public contract');
  const missingConditional=await admit(admissionHeaders(sessionA,'PUT','/profiles/me/student',{'idempotency-key':randomUUID()}));
  assert.equal(missingConditional.status,428,'protected mutation admission enforces required If-Match');
  const unknownPath=await admit(admissionHeaders(sessionA,'GET','/internal/v1/auth/operations/'+randomUUID()));
  assert.equal(unknownPath.status,404,'private internal routes are outside the public admission map');
  const malformedPath=await admit(admissionHeaders(sessionA,'GET','/admin/users/not-a-uuid'));
  assert.equal(malformedPath.status,400,'path parameters are validated against OpenAPI schemas');

  const actorForwarded=await fetch(`${base}/profiles/me/student`,{method:'GET',headers:{...commonHeaders(),'x-request-id':admittedRequestId,'x-actor-context':admittedActor!}});
  assert.equal(actorForwarded.status,200,'owner accepts the signed assertion returned by ForwardAuth');
  const operationMismatch=await fetch(`${base}/profiles/me/account`,{method:'GET',headers:{...commonHeaders(),'x-request-id':admittedRequestId,'x-actor-context':admittedActor!}});
  assert.equal(operationMismatch.status,401,'owners reject an actor assertion bound to another public operation');

  await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1',[(jwt.decode(sessionA.token) as jwt.JwtPayload).sid]);
  const revokedAdmission=await admit(admissionHeaders(sessionA,'GET','/profiles/me/student'));
  assert.equal(revokedAdmission.status,401,'current revoked sessions fail admission');
  await pool.query('UPDATE sessions SET revoked_at=NULL WHERE id=$1',[(jwt.decode(sessionA.token) as jwt.JwtPayload).sid]);
  await pool.query('UPDATE sessions SET expires_at=now()-interval \'1 second\' WHERE id=$1',[(jwt.decode(sessionA.token) as jwt.JwtPayload).sid]);
  const expiredSessionAdmission=await admit(admissionHeaders(sessionA,'GET','/profiles/me/student'));
  assert.equal(expiredSessionAdmission.status,401,'expired current sessions fail admission');
  await pool.query('UPDATE sessions SET expires_at=now()+interval \'1 hour\' WHERE id=$1',[(jwt.decode(sessionA.token) as jwt.JwtPayload).sid]);
  await pool.query("UPDATE users SET status='BANNED' WHERE id=$1",[sessionA.user.id]);
  const bannedAdmission=await admit(admissionHeaders(sessionA,'GET','/profiles/me/student'));
  assert.equal(bannedAdmission.status,403,'current restricted account status fails admission');
  await pool.query("UPDATE users SET status='ACTIVE' WHERE id=$1",[sessionA.user.id]);
  await pool.query("UPDATE users SET capabilities='{}'::text[] WHERE id=$1",[sessionA.user.id]);
  const capabilityAdmission=await admit(admissionHeaders(sessionA,'GET','/profiles/me/student'));
  assert.equal(capabilityAdmission.status,403,'current capabilities must satisfy the OpenAPI operation');
  await pool.query("UPDATE users SET capabilities=ARRAY['STUDENT']::text[] WHERE id=$1",[sessionA.user.id]);

  const duplicateSignup=await request('/auth/signup',signupBody,{'idempotency-key':randomUUID()});
  assert.equal(duplicateSignup.status,409);
  const duplicateError=await duplicateSignup.json() as any;
  assert.equal(duplicateError.code,'EMAIL_EXISTS');
  assert.ok(duplicateError.fields.some((field:any)=>field.path==='/email'));
  const mismatchedSignup=await request('/auth/signup',{...signupBody,passwordConfirmation:`${longPassword}-different`},{'idempotency-key':randomUUID()});
  assert.equal(mismatchedSignup.status,422);
  assert.equal((await mismatchedSignup.json() as any).code,'PASSWORD_MISMATCH');
  const structurallyInvalidSignup=await request('/auth/signup',{...signupBody,unknownField:true},{'idempotency-key':randomUUID()});
  assert.equal(structurallyInvalidSignup.status,422);
  assert.equal((await structurallyInvalidSignup.json() as any).code,'VALIDATION_FAILED');

  const signedRequest=(session:any,operation:string,requestId:string)=>signActorAssertion({
    userId:session.user.id,sessionId:(jwt.decode(session.token) as jwt.JwtPayload).sid as string,
    admissionId:randomUUID(),admittedAt:new Date().toISOString(),requestId,publicOperation:operation,
    capabilities:session.user.capabilities,accountRevision:String(session.user.revision),purpose:'USER_ACTION',
  },keys.privateKey);
  const profileReadId=randomUUID();
  const profileRead=await request('/profiles/me/student',undefined,{
    authorization:`Bearer ${gateway}`,'x-request-id':profileReadId,'x-actor-context':signedRequest(sessionA,'getStudentProfile',profileReadId),
  },'GET');
  assert.equal(profileRead.status,200);
  const profileEtag=profileRead.headers.get('etag');
  assert.equal(profileEtag,'"0"','revision reads must return a strong quoted ETag');
  const profileWriteId=randomUUID();
  const profileWriteKey=randomUUID();
  const profileWrite=await request('/profiles/me/student',{learningAreas:[],level:'',goals:'',preferredPeriods:[]},{
    authorization:`Bearer ${gateway}`,'x-request-id':profileWriteId,'x-actor-context':signedRequest(sessionA,'putStudentProfile',profileWriteId),
    'if-match':profileEtag!,'idempotency-key':profileWriteKey,
  },'PUT');
  assert.equal(profileWrite.status,200,'a GET ETag must be accepted by the matching revision write');
  const profileOperationRequestId=randomUUID();
  const profileOperation=await request(`/internal/v1/auth/operations/${profileWriteKey}`,undefined,{
    authorization:`Bearer ${gateway}`,'x-request-id':profileOperationRequestId,
    'x-actor-context':signedRequest(sessionA,'getOperation',profileOperationRequestId),
  },'GET');
  assert.equal(profileOperation.status,200,'successful student profile changes must be pollable by their owner');
  const profileOperationBody=await profileOperation.json() as any;
  assert.equal(profileOperationBody.status,'SUCCEEDED');
  assert.deepEqual(profileOperationBody.resource,{type:'student-profile',id:sessionA.user.id,url:'/api/profiles/me/student'});
  const accountUpdateId=randomUUID();
  const missingCurrentPassword=await request('/profiles/me/account',{email:`renamed-${randomUUID()}@example.test`},{
    authorization:`Bearer ${gateway}`,'x-request-id':accountUpdateId,'x-actor-context':signedRequest(sessionA,'updateAccountSettings',accountUpdateId),
    'if-match':'"0"','idempotency-key':randomUUID(),
  },'PUT');
  assert.equal(missingCurrentPassword.status,422);
  assert.equal((await missingCurrentPassword.json() as any).code,'CURRENT_PASSWORD_REQUIRED');

  const badPasswordResponse=await request('/auth/login',{email:unique,password:'a'.repeat(72)+'two'});
  assert.equal(badPasswordResponse.status,401,'password bytes after bcrypt legacy boundary must still distinguish credentials');
  const loginResponse=await request('/auth/login',{email:unique,password:longPassword});
  assert.equal(loginResponse.status,200);
  const login=await loginResponse.json() as any;
  const claims=jwt.decode(login.token) as jwt.JwtPayload;
  assert.equal(typeof claims.sid,'string');
  const logoutKey=randomUUID(); const logoutRequestId=randomUUID();
  const logoutResponse=await request('/auth/logout',{}, {
    authorization:`Bearer ${gateway}`,'x-request-id':logoutRequestId,
    'x-actor-context':signedRequest(login,'logout',logoutRequestId),'idempotency-key':logoutKey,
  });
  assert.equal(logoutResponse.status,204);
  const reauthenticatedResponse=await request('/auth/login',{email:unique,password:longPassword});
  assert.equal(reauthenticatedResponse.status,200);
  const reauthenticated=await reauthenticatedResponse.json() as any;
  const logoutPollId=randomUUID();
  const logoutPoll=await request(`/internal/v1/auth/operations/${logoutKey}`,undefined,{
    authorization:`Bearer ${gateway}`,'x-request-id':logoutPollId,
    'x-actor-context':signedRequest(reauthenticated,'getOperation',logoutPollId),
  },'GET');
  assert.equal(logoutPoll.status,200,'logout should remain queryable after reauthentication');
  const logoutOperation=await logoutPoll.json() as any;
  assert.equal(logoutOperation.status,'SUCCEEDED'); assert.equal(logoutOperation.kind,'logout'); assert.equal(logoutOperation.resource,null);

  const rateTag=randomUUID();
  await pool.query("DELETE FROM auth_rate_limits WHERE bucket='login-ip' AND subject_digest=$1",[createHmacFingerprint('127.0.0.1')]);
  for(let i=0;i<40;i++){
    const response=await request('/auth/login',{email:`missing-${rateTag}-${i}@example.test`,password:'not-a-secret'});
    assert.equal(response.status,401);
  }
  const throttled=await request('/auth/login',{email:`missing-${rateTag}-limit@example.test`,password:'not-a-secret'});
  assert.equal(throttled.status,429); assert.ok(Number(throttled.headers.get('retry-after'))>0);

  const adminEmail=`admin-${randomUUID()}@example.test`;
  const adminResponse=await request('/auth/signup',{...signupBody,email:adminEmail,adminSignupKey:process.env.ADMIN_SIGNUP_KEY}, {'idempotency-key':randomUUID()});
  assert.equal(adminResponse.status,201);
  const admin=await adminResponse.json() as any;
  const duplicateEmailUpdateId=randomUUID();
  const duplicateEmailUpdate=await request('/profiles/me/account',{email:adminEmail,currentPassword:longPassword},{
    authorization:`Bearer ${gateway}`,'x-request-id':duplicateEmailUpdateId,'x-actor-context':signedRequest(sessionA,'updateAccountSettings',duplicateEmailUpdateId),
    'if-match':'"0"','idempotency-key':randomUUID(),
  },'PUT');
  assert.equal(duplicateEmailUpdate.status,409);
  const duplicateEmailUpdateError=await duplicateEmailUpdate.json() as any;
  assert.equal(duplicateEmailUpdateError.code,'EMAIL_EXISTS');
  assert.ok(duplicateEmailUpdateError.fields.some((field:any)=>field.path==='/email'));
  const learningEmail=`reset-${randomUUID()}@example.test`;
  process.env.AUTH_SYNTHETIC_EMAILS=learningEmail;
  const learnerResponse=await request('/auth/signup',{...signupBody,email:learningEmail}, {'idempotency-key':randomUUID()});
  assert.equal(learnerResponse.status,201);
  const learner=await learnerResponse.json() as any;
  const baseTime=new Date(); let timeOffset=0;
  const restoreClock=setAuthClock(()=>new Date(baseTime.getTime()+timeOffset));
  try{
    const resetBody={email:learningEmail};
    assert.equal((await request('/auth/password-reset/request',resetBody)).status,202);
    const firstContent=await pool.query(`SELECT rc.* FROM reset_contents rc JOIN users u ON u.id=rc.user_id WHERE u.email=$1 ORDER BY rc.expires_at DESC LIMIT 1`,[learningEmail]);
    const firstLink=decryptResetMaterial(firstContent.rows[0].nonce,firstContent.rows[0].ciphertext,firstContent.rows[0].auth_tag);
    const firstToken=new URLSearchParams(new URL(firstLink.match(/https?:\/\/\S+/)![0]).hash.slice(1)).get('token')!;
    timeOffset=1;
    assert.equal((await request('/auth/password-reset/request',resetBody)).status,202);
    const contents=await pool.query(`SELECT rc.* FROM reset_contents rc JOIN users u ON u.id=rc.user_id WHERE u.email=$1 ORDER BY rc.expires_at ASC,rc.content_ref ASC`,[learningEmail]);
    assert.equal(contents.rowCount,2);
    assert.equal(contents.rows[0].ciphertext.length,0,'replaced encrypted reset material must be erased');
    const newLink=decryptResetMaterial(contents.rows[1].nonce,contents.rows[1].ciphertext,contents.rows[1].auth_tag);
    const tokens=[firstToken,new URLSearchParams(new URL(newLink.match(/https?:\/\/\S+/)![0]).hash.slice(1)).get('token')!];
    const invalidOld=await request('/auth/password-reset/validate',{token:tokens[0]});
    assert.equal(invalidOld.status,400,'a replaced reset token must be invalid');
    const validNew=await request('/auth/password-reset/validate',{token:tokens[1]});
    assert.equal(validNew.status,200);
    const resetContentRef=contents.rows[1].content_ref as string;
    const notificationClient=grpcClient(grpcPort);
    const content=await grpcCall(notificationClient,'getResetNotificationContent',{contentRef:resetContentRef},'notification');
    assert.equal(content.sensitive,true);
    assert.equal(content.recipientUserId,learner.user.id);
    assert.ok(String(content.text).includes(tokens[1]));
    notificationClient.close();
    timeOffset=31*60*1000;
    const restoreFuture=setAuthClock(()=>new Date(baseTime.getTime()+timeOffset));
    try{
      const expired=await request('/auth/password-reset/validate',{token:tokens[1]});
      assert.equal(expired.status,400,'reset tokens must expire at 30 minutes using the injected clock');
    }finally{restoreFuture();}
  }finally{restoreClock();}

  const tutorClient=grpcClient(grpcPort);
  const listDenied=await grpcCallError(tutorClient,'listActiveAdmins',{},'tutor');
  assert.equal(listDenied.code,grpc.status.PERMISSION_DENIED,'valid Tutor workload must fail Notification-only RPC authorization');
  const lookup=await grpcCall(tutorClient,'lookupAccounts',{userIds:[learner.user.id]},'tutor');
  assert.equal(lookup.items[0].id,learner.user.id);
  const unauthenticated=await grpcCallError(tutorClient,'lookupAccounts',{userIds:[learner.user.id]},'missing');
  assert.equal(unauthenticated.code,grpc.status.UNAUTHENTICATED,'unknown workload credential must fail authentication');
  const grantOperation=randomUUID();
  const adminClaims=jwt.decode(admin.token) as jwt.JwtPayload;
  const admission={id:randomUUID(),actorUserId:admin.user.id,sessionId:adminClaims.sid as string,admittedAt:new Date().toISOString(),requestId:randomUUID(),publicOperation:'reviewTutorRequest'};
  const command={operationId:grantOperation,command:{userId:learner.user.id,submissionId:randomUUID(),approvalRevision:'4',admission}};
  const granted=await grpcCall(tutorClient,'grantTutorCapability',command,'tutor');
  const retried=await grpcCall(tutorClient,'grantTutorCapability',command,'tutor');
  assert.equal(granted.status,'APPLIED'); assert.deepEqual(retried,granted);
  const changedAdmission={...admission,requestId:randomUUID()};
  const conflictingReplay=await grpcCallError(tutorClient,'grantTutorCapability',{...command,command:{...command.command,admission:changedAdmission}},'tutor');
  assert.equal(conflictingReplay.code,grpc.status.FAILED_PRECONDITION,'a grant retry cannot change its original admission');
  const grantRow=await pool.query('SELECT count(*)::int AS count FROM tutor_grants WHERE operation_id=$1',[grantOperation]);
  assert.equal(grantRow.rows[0].count,1,'recovery must keep one durable grant result');
  tutorClient.close();
});

function createHmacFingerprint(value:string):string{
  return createHmac('sha256',process.env.IDEMPOTENCY_SECRET!).update(value).digest('hex');
}

async function startGrpc(server:grpc.Server):Promise<{server:grpc.Server;port:number}>{
  const port=await new Promise<number>((resolve,reject)=>server.bindAsync('127.0.0.1:0',grpc.ServerCredentials.createInsecure(),(error,bound)=>error?reject(error):resolve(bound)));
  return {server,port};
}

function grpcClient(port:number):any{
  const root=path.resolve(__dirname,'../../contracts/grpc');
  const definition=protoLoader.loadSync(path.join(root,'auth/v1/collaboration.proto'),{includeDirs:[root],keepCase:false,longs:String,enums:String,defaults:false,oneofs:true});
  const loaded=grpc.loadPackageDefinition(definition) as any;
  return new loaded.tutor_matcher.auth.v1.AuthCollaborationService(`127.0.0.1:${port}`,grpc.credentials.createInsecure());
}

function grpcMetadata(caller:string):grpc.Metadata{
  const metadata=new grpc.Metadata();
  if(caller!=='missing')metadata.set('authorization',`Bearer ${process.env[`${caller.toUpperCase()}_WORKLOAD_CREDENTIAL`]}`);
  else metadata.set('authorization','Bearer invalid-workload');
  metadata.set('x-request-id',randomUUID()); return metadata;
}

function grpcCall(client:any,method:string,body:unknown,caller:string):Promise<any>{
  return new Promise((resolve,reject)=>client[method](body,grpcMetadata(caller),(error:grpc.ServiceError|null,value:any)=>{
    if(!error)return resolve(value);
    try{
      const bytes=error.metadata.get('tutor-error-bin')[0] as Buffer;
      const root=protobuf.loadSync(path.resolve(__dirname,'../../contracts/grpc/common/v1/types.proto'));
      const type=root.lookupType('tutor_matcher.common.v1.ErrorDetail');
      const detail=type.toObject(type.decode(bytes),{defaults:false});
      reject(new Error(`${error.message} ${JSON.stringify(detail)}`));
    }catch{reject(error);}
  }));
}
function grpcCallError(client:any,method:string,body:unknown,caller:string):Promise<grpc.ServiceError>{
  return new Promise((resolve,reject)=>client[method](body,grpcMetadata(caller),(error:grpc.ServiceError|null)=>error?resolve(error):reject(new Error('Expected gRPC error'))));
}
