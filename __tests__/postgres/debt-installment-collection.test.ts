import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { assertRealPostgresUrl,dropPublicSchema,stubPostgresEnv,rawPool } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import type { Currency } from "../../lib/money";
assertRealPostgresUrl();stubPostgresEnv();
const db=await import("../../lib/db");const auth=await import("../../lib/auth");
const schedules=await import("../../lib/debt-installments-db");const collection=await import("../../lib/debt-installment-collection");
const legacy=await import("../../lib/legacy-balance-arrangements-db");
let session:SessionPayload;let serial=0;
const q=async(sql:string,values:unknown[]=[]) => (await db.getPool().query(sql,values)).rows;
beforeAll(async()=>{
  await dropPublicSchema(process.env.DATABASE_URL!);await db.ensureSchema();
  const hash=await auth.hashPassword("synthetic-debt-collection-password");const id=(await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('debt-owner','Synthetic debt owner',$1,'admin',TRUE) RETURNING id",[hash]))[0].id;
  session={userId:id,username:"debt-owner",role:"admin",credentialVersion:auth.sessionCredentialVersion(hash),expiresAt:Date.now()+3_600_000};
  await db.openShift({openedBy:session.username,opening:{YER:0,SAR:0,USD:0}});
  await q("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
},180_000);
afterAll(async()=>{await db.resetPoolForTesting();});
async function debt(amount=60000,currency:Currency="SAR",opening=false){
  const patientId=(await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic debt collection') RETURNING id",[`DEBT-COL-${++serial}`]))[0].id;
  const invoiceId=opening?null:(await q("INSERT INTO invoices(invoice_number,patient_id,base_currency,total_minor,discount_minor,created_by) VALUES($1,$2,$3,$4,0,'synthetic') RETURNING id",[`DEBT-COL-${serial}`,patientId,currency,amount]))[0].id;
  if(opening)await q("INSERT INTO patient_opening_balances(patient_id,currency,amount_minor,as_of_date,created_by) VALUES($1,$2,$3,'2026-10-01','synthetic')",[patientId,currency,amount]);
  const target={patientId,currency,invoiceId,openingCurrency:opening?currency:null};
  const write={target,terms:{mode:"installments",installments:[{dueDate:"2026-10-12",amountMinor:amount,kind:"installment"}]},expectedVersion:0,expectedRemainingMinor:amount,reason:"Synthetic schedule",idempotencyKey:`debt-schedule-${serial}`,session};
  return {target,write};
}
const collect=(patientId:number,arrangementId:number,amountMinor:number,key:string,currency:Currency="SAR",expectedVersion=1)=>collection.collectDebtInstallment({patientId,arrangementId,amountMinor,idempotencyKey:key,currency,expectedVersion,method:"cash",note:null,session});
const receipt=(patientId:number,amountMinor:number,currency:Currency="YER",invoiceId:number|null=null,openingCurrency:Currency|null=null)=>db.recordPayment({patientId,invoiceId,openingCurrency,amountMinor,currency,baseCurrency:"YER",exchangeRate:currency==="SAR"?140:currency==="USD"?530:1,kind:"payment",method:"cash",note:null,createdBy:session.username,idempotencyKey:`canonical-${++serial}`});

describe("bounded collection against existing debt",()=>{
  it("collects partially through canonical receipts, replays exactly and creates no new invoice",async()=>{
    const {target,write}=await debt();const schedule=await schedules.saveDebtRepayment(write);
    const first=await collect(target.patientId,schedule.arrangementId,20000,"debt-collect-partial");expect(first.payment?.invoiceId).toBe(target.invoiceId);
    expect((await collect(target.patientId,schedule.arrangementId,20000,"debt-collect-partial")).payment?.id).toBe(first.payment?.id);
    await expect(collect(target.patientId,schedule.arrangementId,20001,"debt-collect-partial")).rejects.toMatchObject({code:"conflict"});
    expect((await schedules.listDebtRepayments(target.patientId,"2026-10-13"))[0]).toMatchObject({remainingMinor:40000,collectedMinor:20000,progress:{settledSinceRevisionMinor:20000}});
    expect((await q("SELECT count(*)::int AS n FROM invoices WHERE patient_id=$1",[target.patientId]))[0].n).toBe(1);
    expect((await q("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1",[target.patientId]))[0].n).toBe(1);
  });
  it("serializes different keys so simultaneous collections cannot overcollect",async()=>{
    const {target,write}=await debt();const schedule=await schedules.saveDebtRepayment(write);
    const results=await Promise.allSettled([collect(target.patientId,schedule.arrangementId,40000,"debt-race-a"),collect(target.patientId,schedule.arrangementId,40000,"debt-race-b")]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
    expect(results.find(r=>r.status==="rejected")).toMatchObject({reason:{code:"invalid"}});
    expect((await schedules.listDebtRepayments(target.patientId,"2026-10-13"))[0].remainingMinor).toBe(20000);
  });
  it("accepts both concurrent fresh keys when their sum fits the unchanged debt",async()=>{
    const {target,write}=await debt();const schedule=await schedules.saveDebtRepayment(write);
    const results=await Promise.all([
      collect(target.patientId,schedule.arrangementId,20000,"debt-fit-race-a"),
      collect(target.patientId,schedule.arrangementId,20000,"debt-fit-race-b"),
    ]);
    expect(new Set(results.map(result=>result.payment?.id)).size).toBe(2);
    expect((await schedules.listDebtRepayments(target.patientId,"2026-10-13"))[0]).toMatchObject({remainingMinor:20000,requiresReview:false});
  });
  it.each(["partial-refund","full-refund","receipt-correction","principal","cancelled"])("keeps review and collection guards after %s",async change=>{
    const {target,write}=await debt();const schedule=await schedules.saveDebtRepayment(write);
    const first=await collect(target.patientId,schedule.arrangementId,20000,`debt-change-first-${change}`);
    expect(first.payment).not.toBeNull();
    if(change.endsWith("refund")){
      const refund=await db.recordPayment({patientId:target.patientId,invoiceId:target.invoiceId,kind:"refund",amountMinor:change==="full-refund"?20000:1000,
        currency:"SAR",baseCurrency:"YER",exchangeRate:140,method:"cash",note:"Synthetic refund guard",createdBy:session.username,
        reversalOfId:first.payment!.id,idempotencyKey:`debt-change-${change}`});
      expect(refund.reason).toBeNull();
    }else if(change==="receipt-correction"){
      const correction=await db.correctPayment({paymentId:first.payment!.id,reason:"Synthetic receipt correction guard",actor:session.username,actorRole:"admin",
        idempotencyKey:"debt-change-receipt-correction",replacement:{amountMinor:15000,currency:"SAR",exchangeRate:140,method:"cash",target:{kind:"original"}}});
      expect(correction.reason).toBeNull();
    }else if(change==="principal")await q("UPDATE invoices SET total_minor=70000 WHERE id=$1",[target.invoiceId]);
    else await q("UPDATE invoices SET status='cancelled' WHERE id=$1",[target.invoiceId]);
    expect((await schedules.listDebtRepayments(target.patientId,"2026-10-13"))[0].requiresReview).toBe(true);
    const before=(await q("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1",[target.patientId]))[0].n;
    await expect(collect(target.patientId,schedule.arrangementId,1000,`debt-change-after-${change}`)).rejects.toMatchObject({code:"stale"});
    expect((await q("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1",[target.patientId]))[0].n).toBe(before);
  });
  it("uses recorded FX only for YER targets and refuses foreign-to-foreign",async()=>{
    const {target,write}=await debt(280,"YER");const schedule=await schedules.saveDebtRepayment(write);
    const saved=await collect(target.patientId,schedule.arrangementId,100,"debt-fx-one","SAR");expect(saved.payment?.baseAmountMinor).toBe(140);
    await q("UPDATE settings SET value='150' WHERE key='finance.rate.SAR'");
    expect((await collect(target.patientId,schedule.arrangementId,100,"debt-fx-one","SAR")).payment?.exchangeRate).toBe(140);
    await q("UPDATE settings SET value='140' WHERE key='finance.rate.SAR'");
    const foreign=await debt(60000,"SAR");const foreignSchedule=await schedules.saveDebtRepayment(foreign.write);
    await expect(collect(foreign.target.patientId,foreignSchedule.arrangementId,100,"debt-fx-cross","USD")).rejects.toMatchObject({code:"invalid"});
  });
  it("requires allocation review for opening100 + unassigned50, and caps already-scheduled collection at account50",async()=>{
    const first=await debt(100,"YER",true);await receipt(first.target.patientId,50);
    await expect(schedules.saveDebtRepayment(first.write)).rejects.toMatchObject({code:"stale"});
    expect((await q("SELECT count(*)::int AS n FROM debt_repayment_arrangements WHERE patient_id=$1",[first.target.patientId]))[0].n).toBe(0);
    const second=await debt(100,"YER",true);const schedule=await schedules.saveDebtRepayment(second.write);await receipt(second.target.patientId,50);
    expect((await schedules.listDebtRepayments(second.target.patientId,"2026-10-13"))[0]).toMatchObject({remainingMinor:100,accountDueMinor:50,collectibleMinor:50,requiresReview:true});
    await expect(collect(second.target.patientId,schedule.arrangementId,60,"debt-cap-refused","YER")).rejects.toMatchObject({code:"invalid"});
    await collect(second.target.patientId,schedule.arrangementId,50,"debt-cap-exact","YER");
    expect((await schedules.listDebtRepayments(second.target.patientId,"2026-10-13"))[0]).toMatchObject({remainingMinor:50,accountDueMinor:0,collectibleMinor:0,requiresReview:true});
  });
  it("refuses competing legacy/new opening arrangements, including two-tab creation",async()=>{
    const {target,write}=await debt(100,"YER",true);
    const old=()=>legacy.createLegacyBalanceArrangement({patientId:target.patientId,currency:"YER",cadence:"monthly",installmentMinor:50,firstDueDate:"2026-10-12",note:null,createdBy:session.username,today:"2026-10-12"});
    const results=await Promise.allSettled([schedules.saveDebtRepayment(write),old()]);
    const activeNew=(await q("SELECT count(*)::int AS n FROM debt_repayment_arrangements WHERE patient_id=$1",[target.patientId]))[0].n;
    const activeOld=(await q("SELECT count(*)::int AS n FROM legacy_balance_arrangements WHERE patient_id=$1 AND cancelled_at IS NULL",[target.patientId]))[0].n;
    expect(activeNew+activeOld).toBe(1);expect(results).toHaveLength(2);
    if(activeNew)expect(await old()).toMatchObject({ok:false,reason:"already_active"});
    else await expect(schedules.saveDebtRepayment({...write,idempotencyKey:"debt-legacy-second"})).rejects.toMatchObject({code:"conflict"});
    expect((await q("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1",[target.patientId]))[0].n).toBe(0);
    expect((await q("SELECT count(*)::int AS n FROM invoices WHERE patient_id=$1",[target.patientId]))[0].n).toBe(0);
  });
  it("rechecks expiry after a held shift wait and writes no receipt for an expired actor",async()=>{
    const {target,write}=await debt();const schedule=await schedules.saveDebtRepayment(write);const pool=rawPool();const holder=await pool.connect();
    let pending:Promise<unknown>|undefined;
    try{
      await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;await holder.query("SELECT id FROM cashier_shifts WHERE status='open' FOR UPDATE");
      const shortSession={...session,expiresAt:Date.now()+500};
      pending=collection.collectDebtInstallment({patientId:target.patientId,arrangementId:schedule.arrangementId,amountMinor:1000,idempotencyKey:"debt-expired-wait",currency:"SAR",expectedVersion:1,method:"cash",note:null,session:shortSession}).catch(error=>error);
      await expect.poll(async()=>(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE $1=ANY(pg_blocking_pids(a.pid))) AS blocked",[pid])).rows[0].blocked,{timeout:5000,interval:20}).toBe(true);
      await expect.poll(()=>Date.now()>shortSession.expiresAt,{timeout:2000,interval:20}).toBe(true);
      await holder.query("COMMIT");expect(await pending).toMatchObject({code:"unauthorized"});
      expect((await q("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1",[target.patientId]))[0].n).toBe(0);
    }finally{await holder.query("ROLLBACK").catch(()=>undefined);await pending;holder.release();await pool.end();await q("UPDATE users SET is_active=TRUE WHERE id=$1",[session.userId]);}
  });
  it("refuses a revoked actor before collection",async()=>{
    const {target,write}=await debt();const schedule=await schedules.saveDebtRepayment(write);
    await q("UPDATE users SET is_active=FALSE WHERE id=$1",[session.userId]);
    try{await expect(collect(target.patientId,schedule.arrangementId,1000,"debt-revoked-now")).rejects.toMatchObject({code:"unauthorized"});
      expect((await q("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1",[target.patientId]))[0].n).toBe(0);
    }finally{await q("UPDATE users SET is_active=TRUE WHERE id=$1",[session.userId]);}
  });
});


describe("FIN011 explicit default FX save enables canonical installment collection", () => {
  it.each([["SAR", "140"], ["USD", "530"]] as const)("uses explicitly saved %s without rewriting earlier receipts", async (currency, defaultValue) => {
    const key = `finance.rate.${currency}`;
    const saved = await q("SELECT key, value, updated_at FROM settings WHERE key = $1", [key]);
    try {
      const oldRate = Number(defaultValue) + 10;
      await q("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [key, String(oldRate)]);
      const { target, write } = await debt(100000, "YER");
      const schedule = await schedules.saveDebtRepayment(write);
      const first = await collect(target.patientId, schedule.arrangementId, 100, `fin011-old-${currency}`, currency);
      expect(first.payment?.exchangeRate).toBe(oldRate);
      const historical = await q("SELECT to_jsonb(p) AS receipt FROM payments p WHERE id=$1", [first.payment!.id]);
      await q("DELETE FROM settings WHERE key=$1", [key]);
      await expect(collect(target.patientId, schedule.arrangementId, 100, `fin011-missing-${currency}`, currency))
        .rejects.toMatchObject({ code: "invalid" });
      expect((await q("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1", [target.patientId]))[0].n).toBe(1);
      expect(await db.saveSettingsAudited({ values: { [key]: defaultValue }, expected: { [key]: null },
        actor: session.username, actorRole: "admin" })).toMatchObject({ ok: true, changed: [key] });
      const second = await collect(target.patientId, schedule.arrangementId, 100, `fin011-new-${currency}`, currency);
      expect(second.payment).toMatchObject({ exchangeRate: Number(defaultValue), baseAmountMinor: Number(defaultValue) });
      expect(await q("SELECT to_jsonb(p) AS receipt FROM payments p WHERE id=$1", [first.payment!.id])).toEqual(historical);
      expect((await collect(target.patientId, schedule.arrangementId, 100, `fin011-old-${currency}`, currency)).payment?.exchangeRate).toBe(oldRate);
      expect((await q("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1", [target.patientId]))[0].n).toBe(2);
    } finally {
      await q("DELETE FROM settings WHERE key=$1", [key]);
      for (const row of saved) await q("INSERT INTO settings(key,value,updated_at) VALUES($1,$2,$3)", [row.key, row.value, row.updated_at]);
    }
  });
});
