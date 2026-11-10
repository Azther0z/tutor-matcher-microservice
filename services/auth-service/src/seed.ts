import 'dotenv/config';
import { inTransaction, migrate, pool } from './db';
import { hashPassword } from './security';

export const DEMO_ACCOUNTS=[
  {id:'10000000-0000-4000-8000-000000000001',email:'admin.demo@example.test',firstName:'Carol',lastName:'Davis',capabilities:['STUDENT','ADMIN']},
  {id:'10000000-0000-4000-8000-000000000002',email:'student.demo@example.test',firstName:'Bob',lastName:'Smith',capabilities:['STUDENT']},
  {id:'10000000-0000-4000-8000-000000000003',email:'candidate.demo@example.test',firstName:'Alice',lastName:'Johnson',capabilities:['STUDENT']},
  // Candidates the demo tutor seed turns into approved tutors.
  {id:'10000000-0000-4000-8000-000000000004',email:'nara.demo@example.test',firstName:'Nara',lastName:'Wongsa',capabilities:['STUDENT']},
  {id:'10000000-0000-4000-8000-000000000005',email:'kitti.demo@example.test',firstName:'Kitti',lastName:'Suriyan',capabilities:['STUDENT']},
  {id:'10000000-0000-4000-8000-000000000006',email:'mali.demo@example.test',firstName:'Mali',lastName:'Chaiyo',capabilities:['STUDENT']},
  {id:'10000000-0000-4000-8000-000000000007',email:'ben.demo@example.test',firstName:'Ben',lastName:'Carter',capabilities:['STUDENT']},
] as const;

export async function seedDemoAccounts():Promise<{created:number;existing:number}>{
  if(process.env.DEMO_MODE!=='true')throw new Error('DEMO_MODE must be true to seed demo accounts');
  const password=process.env.AUTH_DEMO_PASSWORD;
  if(!password||password.length<8||password.length>100)throw new Error('AUTH_DEMO_PASSWORD must contain 8 to 100 characters');
  await migrate();
  const passwordHash=await hashPassword(password);
  return inTransaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock($1)',[741012662]);
    let created=0; let existing=0;
    for(const user of DEMO_ACCOUNTS){
      const found=await client.query('SELECT id,email,synthetic FROM users WHERE id=$1 OR lower(email)=$2 FOR UPDATE',[user.id,user.email]);
      if(found.rowCount){
        if(found.rowCount!==1)throw new Error(`Demo identity fixture collision: ${user.id}`);
        const row=found.rows[0];
        if(row.id!==user.id||row.email!==user.email||row.synthetic!==true)throw new Error(`Demo identity fixture collision: ${user.id}`);
        existing+=1; continue;
      }
      await client.query(`INSERT INTO users(id,email,password_hash,password_scheme,display_name,first_name,last_name,capabilities,status,revision,synthetic)
        VALUES($1,$2,$3,'BCRYPT_SHA256_V1',$4,$5,$6,$7,'ACTIVE',0,true)`,[user.id,user.email,passwordHash,`${user.firstName} ${user.lastName}`,user.firstName,user.lastName,user.capabilities]);
      await client.query('INSERT INTO student_profiles(user_id) VALUES($1)',[user.id]);
      created+=1;
    }
    return {created,existing};
  });
}

if(require.main===module){
  void seedDemoAccounts().then(async result=>{
    console.log(`[Auth] synthetic demo accounts: ${result.created} created, ${result.existing} already present`);
    await pool.end();
  }).catch(async error=>{
    const message=error instanceof Error&&/^(DEMO_MODE|AUTH_DEMO_PASSWORD)/.test(error.message)?error.message:'synthetic demo seed failed';
    console.error('[Auth] seed failed',message);
    await pool.end(); process.exitCode=1;
  });
}
