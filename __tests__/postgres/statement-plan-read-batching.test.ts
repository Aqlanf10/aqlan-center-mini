import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {Client,type PoolClient} from 'pg';
import {assertRealPostgresUrl,createIsolatedDatabase,stubPostgresEnv} from './_setup';
assertRealPostgresUrl();stubPostgresEnv();
process.env.DATABASE_URL=await createIsolatedDatabase('aqlan_statement_batch_test');
const db=await import('../../lib/db');
let patientId:number,serial=0;
const today='2026-10-23';
async function plan(currency:'YER'|'SAR'|'USD'='YER'){
 const id=await db.createPlan({patientId,title:`Synthetic statement plan ${++serial}`,totalMinor:10000,baseCurrency:currency,startDate:'2026-01-01',note:null,createdBy:'synthetic',installments:[{number:1,dueDate:'2027-01-01',amountMinor:10000}]});
 if(!id)throw Error('Synthetic plan creation failed');return id;
}
beforeAll(async()=>{
 await db.ensureSchema();
 patientId=(await db.getPool().query("INSERT INTO patients(patient_number,full_name) VALUES('STATEMENT-BATCH','Synthetic statement batching') RETURNING id")).rows[0].id;
 await plan();
});
afterAll(async()=>db.resetPoolForTesting());
it('keeps draft-plan discovery bounded and patient-facing evidence adds exactly three reads at one and forty plans',async()=>{
 const measure=async(patientFacing=false)=>{const spy=vi.spyOn(Client.prototype,'query');try{const result=await db.patientStatementSnapshot(patientId,today,{patientFacing});return {result,calls:spy.mock.calls.length,sql:spy.mock.calls.map(args=>String(args[0]))};}finally{spy.mockRestore();}};
 const one=await measure();expect(one.result.plans).toHaveLength(1);
 const onePatientFacing=await measure(true);expect(onePatientFacing.calls-one.calls).toBe(3);
 expect(onePatientFacing.result.statementEvidence).toBeDefined();
 for(let i=0;i<39;i++)await plan(i%2?'SAR':'YER');
 const many=await measure();expect(many.result.plans).toHaveLength(40);
 expect(many.result.planCurrencies.size).toBe(40);
 expect(many.calls).toBeLessThanOrEqual(one.calls+1);
 expect(many.result.plans).toEqual(await db.listPatientPlans(patientId,today));
 const manyPatientFacing=await measure(true);
 expect(manyPatientFacing.result.plans).toHaveLength(40);
 expect(manyPatientFacing.result.plans).toEqual(many.result.plans);
 expect(manyPatientFacing.result.planCurrencies).toEqual(many.result.planCurrencies);
 expect(manyPatientFacing.calls-many.calls).toBe(3);
 expect(manyPatientFacing.calls-onePatientFacing.calls).toBeLessThanOrEqual(1);
 for(const table of ['invoice_corrections WHERE patient_id=$1','audit_log WHERE','patient_opening_balance_history WHERE patient_id=$1']){
  expect(manyPatientFacing.sql.filter(sql=>sql.includes(table))).toHaveLength(1);
 }
 expect(many.result.statementEvidence).toBeUndefined();
 expect(manyPatientFacing.result.statementEvidence).toEqual({invoiceCorrections:[],invoiceCancellations:[],paymentCorrections:[],openingHistory:[],allocationEffectiveAt:{}});
});
it('does not split the currency map from plans committed between snapshot reads',async()=>{
 const pool=db.getPool(),connect=pool.connect.bind(pool) as (...args:unknown[])=>unknown;
 let injected=false,newPlanId=0;
 const spy=vi.spyOn(pool,'connect').mockImplementation(((...args:unknown[])=>{
  if(typeof args[0]==='function')return connect(...args);
  return (async()=>{
   const client=await connect() as PoolClient;const query=client.query.bind(client) as (...args:unknown[])=>Promise<unknown>,release=client.release.bind(client);
   client.query=(async(...queryArgs:unknown[])=>{
    const sql=typeof queryArgs[0]==='string'?queryArgs[0]:'';
    const result=await query(...queryArgs);
    if(!injected&&sql.includes('t.total_from_items, t.consent_at')&&sql.includes('t.patient_id=$1')){injected=true;newPlanId=await plan('USD');}
    return result;
   }) as typeof client.query;
   client.release=((destroy?:boolean|Error)=>{client.query=query as typeof client.query;client.release=release;return release(destroy);}) as typeof client.release;
   return client;
  })();
 }) as unknown as typeof pool.connect);
 try{
  const during=await db.patientStatementSnapshot(patientId,today);
  expect(injected).toBe(true);expect(during.planCurrencies.has(newPlanId)).toBe(false);expect(during.plans.some(p=>p.id===newPlanId)).toBe(false);
  const after=await db.patientStatementSnapshot(patientId,today);
  expect(after.planCurrencies.get(newPlanId)).toEqual({patientId,currency:'USD'});expect(after.plans.find(p=>p.id===newPlanId)?.baseCurrency).toBe('USD');
 }finally{spy.mockRestore();}
});
