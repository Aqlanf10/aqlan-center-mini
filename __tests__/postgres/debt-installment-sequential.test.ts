import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {assertRealPostgresUrl,dropPublicSchema,stubPostgresEnv} from "./_setup";
import type {SessionPayload} from "../../lib/auth";
assertRealPostgresUrl();stubPostgresEnv();
const db=await import("../../lib/db");
const auth=await import("../../lib/auth");
const schedules=await import("../../lib/debt-installments-db");
const collection=await import("../../lib/debt-installment-collection");
let session:SessionPayload;
const q=async(sql:string,values:unknown[]=[]) => (await db.getPool().query(sql,values)).rows;
beforeAll(async()=>{
  await dropPublicSchema(process.env.DATABASE_URL!);await db.ensureSchema();
  const hash=await auth.hashPassword("synthetic-sequential-password");
  const user=(await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('sequence-owner','Synthetic sequence owner',$1,'admin',TRUE) RETURNING id",[hash]))[0];
  session={userId:user.id,username:"sequence-owner",role:"admin",credentialVersion:auth.sessionCredentialVersion(hash),expiresAt:Date.now()+3_600_000};
  await db.openShift({openedBy:session.username,opening:{YER:0,SAR:0,USD:0}});
  await q("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','410') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
},180_000);
afterAll(async()=>{await db.resetPoolForTesting();});
describe("scheduled debt remains collectible after ordinary sequential receipts",()=>{
  it("collects three fresh keys without review, schedule rewrites or duplicate invoices",async()=>{
    const patientId=(await q("INSERT INTO patients(patient_number,full_name) VALUES('SYN-SEQUENCE-001','Synthetic sequential debt') RETURNING id"))[0].id;
    const invoiceId=(await q("INSERT INTO invoices(invoice_number,patient_id,base_currency,total_minor,discount_minor,created_by) VALUES('SYN-SEQUENCE-001',$1,'SAR',60000,0,'synthetic') RETURNING id",[patientId]))[0].id;
    const target={patientId,currency:"SAR" as const,invoiceId,openingCurrency:null};
    const saved=await schedules.saveDebtRepayment({target,terms:{mode:"installments",installments:[
      {dueDate:"2026-10-17",amountMinor:20000,kind:"installment"},
      {dueDate:"2026-11-17",amountMinor:20000,kind:"installment"},
      {dueDate:"2026-12-17",amountMinor:20000,kind:"installment"},
    ]},expectedVersion:0,expectedRemainingMinor:60000,reason:"Synthetic sequential schedule",idempotencyKey:"synthetic-sequence-schedule",session});
    const outcomes:unknown[]=[],positions:unknown[]=[];
    for(let step=1;step<=3;step++){
      try{
        const result=await collection.collectDebtInstallment({patientId,arrangementId:saved.arrangementId,expectedVersion:1,amountMinor:20000,
          currency:"SAR",method:"cash",note:null,idempotencyKey:`synthetic-sequence-${step}`,session});
        outcomes.push({step,invoiceId:result.payment?.invoiceId,replayed:result.replayed});
      }catch(error){outcomes.push({step,error:error instanceof Error?error.message:String(error)});}
      const position=(await schedules.listDebtRepayments(patientId,"2026-10-17"))[0];
      positions.push({remainingMinor:position.remainingMinor,collectedMinor:position.collectedMinor,requiresReview:position.requiresReview});
    }
    expect.soft(outcomes).toEqual([1,2,3].map(step=>({step,invoiceId,replayed:false})));
    expect.soft(positions).toEqual([1,2,3].map(step=>({remainingMinor:60000-step*20000,collectedMinor:step*20000,requiresReview:false})));
    expect.soft((await q("SELECT count(*)::int AS n FROM invoices WHERE patient_id=$1",[patientId]))[0].n).toBe(1);
    expect.soft((await q("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1",[patientId]))[0].n).toBe(3);
    expect((await q("SELECT count(*)::int AS n FROM debt_repayment_revisions WHERE arrangement_id=$1",[saved.arrangementId]))[0].n).toBe(1);
  });
});
