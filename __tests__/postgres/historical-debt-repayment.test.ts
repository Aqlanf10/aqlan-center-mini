import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {assertRealPostgresUrl,dropPublicSchema,stubPostgresEnv} from "./_setup";
import {parseLegacyTreatmentRequest} from "../../lib/legacy-treatment";
import {DEFAULT_SPECIALTY_TEMPLATES} from "../../lib/specialty-templates";
import type {SessionPayload} from "../../lib/auth";
assertRealPostgresUrl();stubPostgresEnv();
const db=await import("../../lib/db");const auth=await import("../../lib/auth");const legacy=await import("../../lib/legacy-treatment-db");
const schedules=await import("../../lib/debt-installments-db");
let session:SessionPayload;let serviceId:number;let serial=0;
const q=async(sql:string,values:unknown[]=[]) => (await db.getPool().query(sql,values)).rows;
beforeAll(async()=>{
  await dropPublicSchema(process.env.DATABASE_URL!);await db.ensureSchema();
  const hash=await auth.hashPassword("synthetic-historical-debt");const id=(await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('historical-owner','Synthetic historical owner',$1,'admin',TRUE) RETURNING id",[hash]))[0].id;
  session={userId:id,username:"historical-owner",role:"admin",credentialVersion:auth.sessionCredentialVersion(hash),expiresAt:Date.now()+3_600_000};
  serviceId=(await q("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('Synthetic historical ortho','ortho',300000,TRUE,TRUE) RETURNING id"))[0].id;
},180000);
afterAll(async()=>{await db.resetPoolForTesting();});
async function command(paid="120000"){
  const patientId=(await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic historical agreement') RETURNING id",[`HIST-DEBT-${++serial}`]))[0].id;
  const remaining=300000-Number(paid);
  const source={serviceId,scope:"both",sessions:12,currency:"YER",agreedAmount:"300000",previouslyPaidAmount:paid,historicalAsOf:"2026-10-01",idempotencyKey:`historical-debt-${serial}`,
    repaymentRemainingMinor:remaining,repaymentTerms:remaining?{mode:"installments",installments:[{dueDate:"2026-10-12",amountMinor:80000,kind:"down_payment"},{dueDate:"2026-11-12",amountMinor:100000,kind:"installment"}]}:{mode:"full",installments:[]}};
  const parsed=parseLegacyTreatmentRequest(source,"2026-10-12");if(!parsed.ok)throw new Error(parsed.message);
  return {source,input:{patientId,request:parsed.value,actor:session.username,actorRole:session.role,canEditOpening:true,templates:DEFAULT_SPECIALTY_TEMPLATES,session}};
}
describe("historical agreement repayment composition",()=>{
  it("300000 agreed/120000 historical paid records only180000 opening and terms, with no fabricated receipt or invoice",async()=>{
    const {input}=await command();const first=await legacy.createLegacyTreatment(input);expect(first.ok).toBe(true);if(!first.ok)return;
    expect(first.agreement).toMatchObject({agreedMinor:300000,previouslyPaidMinor:120000,remainingMinor:180000,currency:"YER"});
    expect(await legacy.createLegacyTreatment(input)).toMatchObject({ok:true,replayed:true,agreement:{id:first.agreement.id}});
    expect((await q("SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id=$1",[input.patientId]))).toEqual([{amount_minor:"180000"}]);
    expect((await q("SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) AS invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) AS payments",[input.patientId]))).toEqual([{invoices:0,payments:0}]);
    expect((await schedules.listDebtRepayments(input.patientId,"2026-10-12"))[0]).toMatchObject({remainingMinor:180000,collectedMinor:0,terms:input.request.repaymentTerms,target:{patientId:input.patientId,currency:"YER",openingCurrency:"YER",invoiceId:null}});
  });
  it("rolls all historical/clinical/opening writes back if reviewed opening amount is stale",async()=>{
    const {input}=await command();const invalid={...input,request:{...input.request,repaymentRemainingMinor:180001}};
    await expect(legacy.createLegacyTreatment(invalid)).rejects.toMatchObject({code:"stale"});
    expect((await q("SELECT (SELECT count(*)::int FROM patient_opening_balances WHERE patient_id=$1) AS openings,(SELECT count(*)::int FROM treatment_plans WHERE patient_id=$1) AS plans,(SELECT count(*)::int FROM legacy_treatment_agreements WHERE patient_id=$1) AS agreements",[input.patientId]))).toEqual([{openings:0,plans:0,agreements:0}]);
  });
  it("keeps fully historically paid work at zero debt without a synthetic opening target",async()=>{
    const {input}=await command("300000");expect(await legacy.createLegacyTreatment(input)).toMatchObject({ok:true,agreement:{remainingMinor:0}});
    expect(await schedules.listDebtRepayments(input.patientId,"2026-10-12")).toEqual([]);
    expect(await q("SELECT 1 FROM payments WHERE patient_id=$1 UNION ALL SELECT 1 FROM invoices WHERE patient_id=$1 UNION ALL SELECT 1 FROM patient_opening_balances WHERE patient_id=$1",[input.patientId])).toEqual([]);
  });
});
