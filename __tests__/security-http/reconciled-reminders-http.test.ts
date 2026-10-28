import { afterAll, beforeAll, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";
let db:Client,h:Awaited<ReturnType<typeof harness>>,serial=0;
beforeAll(async()=>{
 h=await harness();db=new Client({connectionString:h.seeded.dbUrl,ssl:false});await db.connect();
 await db.query("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
 await db.query("INSERT INTO cashier_shifts(opened_by) SELECT 'secadmin' WHERE NOT EXISTS(SELECT 1 FROM cashier_shifts WHERE status='open')");
},180000);
afterAll(async()=>{await db?.end();});
async function fixture(){
 const patientId=(await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic reconciliation browser') RETURNING id",[`REC-UI-${Date.now()}-${++serial}`])).rows[0].id as number;
 const doctorId=(await db.query("INSERT INTO parties(name,kind,commission_percent) VALUES('Synthetic reconciliation provider','doctor',30) RETURNING id")).rows[0].id as number;
 await db.query("INSERT INTO doctor_commission_history(party_id,percent,config,effective_from,source,reason,recorded_by) VALUES($1,30,NULL,'2020-01-01','baseline','Synthetic policy','secadmin')",[doctorId]);
 const planId=(await db.query("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,start_date,billing_mode,primary_doctor_id,total_from_items,consent_at,consent_by) VALUES($1,'Synthetic classic reconciliation',180000,'SAR','2026-10-01','installments',$2,false,now(),'secadmin') RETURNING id",[patientId,doctorId])).rows[0].id as number;
 await db.query("INSERT INTO plan_installments(plan_id,number,due_date,amount_minor) VALUES($1,1,'2026-10-01',12000),($1,2,'2099-12-01',168000)",[planId]);
 const payment=await authedMutation(`/api/plans/${planId}`,h.sessions.admin,'POST',JSON.stringify({amount:'120',currency:'SAR'}),{'Idempotency-Key':`reconcile-fixture-${planId}`,'x-collection-similarity-review':'none'});
 expect(payment.status,await payment.clone().text()).toBe(201);
 await db.query("UPDATE treatment_plans SET status='completed' WHERE id=$1",[planId]);
 const preview=await authedGet(`/api/plans/${planId}/reconcile`,h.sessions.admin); expect(preview.status).toBe(200);
 const data=await preview.json();
 const saved=await authedMutation(`/api/plans/${planId}/reconcile`,h.sessions.admin,'POST',JSON.stringify({operationKey:`reminder-http-${planId}`,expectedSourceHash:data.sourceHash,reason:'Synthetic reminder test'}));
 expect(saved.status,await saved.clone().text()).toBe(200);
 return {patientId,planId};
}

async function snapshot(ids:number[]) {
 return {plans:(await db.query("SELECT id,last_reminder_at FROM treatment_plans WHERE id=ANY($1::int[]) ORDER BY id",[ids])).rows,
 installments:(await db.query("SELECT * FROM plan_installments WHERE plan_id=ANY($1::int[]) ORDER BY id",[ids])).rows,
 audits:(await db.query("SELECT * FROM audit_log WHERE action='plan.installment_reminder' AND entity_id=ANY($1::text[]) ORDER BY id",[ids.map(String)])).rows};
}
const post=(body:unknown)=>authedMutation('/api/plans/reminders',h.sessions.reception,'POST',JSON.stringify(body));
it('records a reconciled individual reminder and no financial mutation through real HTTP',async()=>{
 const f=await fixture(),before=await snapshot([f.planId]);
 const res=await post({planId:f.planId,installmentNumber:1});expect(res.status,await res.clone().text()).toBe(200);
 const after=await snapshot([f.planId]);expect(after.audits).toHaveLength(1);expect(after.audits[0].actor).toBe('secreception');
 expect(after.installments[0].last_reminder_at).toEqual(after.plans[0].last_reminder_at);expect(after.installments[1].last_reminder_at).toBeNull();
 expect(after.installments.map(({last_reminder_at:_,...row})=>row)).toEqual(before.installments.map(({last_reminder_at:_,...row})=>row));
});
it('deduplicates bulk reminders and leaves missing installment untouched',async()=>{
 const a=await fixture(),b=await fixture(),ids=[a.planId,b.planId];
 const before=await snapshot(ids);expect((await post({planId:a.planId,installmentNumber:99})).status).toBe(404);expect(await snapshot(ids)).toEqual(before);
 const res=await post({planIds:[b.planId,a.planId,a.planId,2147483647]});expect(res.status).toBe(200);expect(await res.json()).toMatchObject({updatedCount:2});
 const after=await snapshot(ids);expect(after.audits).toHaveLength(2);expect(after.installments.filter(row=>row.number===2).every(row=>row.last_reminder_at===null)).toBe(true);
});
it('returns500 with no partial batch writes when mandatory audit fails on the second plan',async()=>{
 const a=await fixture(),b=await fixture(),ids=[a.planId,b.planId],before=await snapshot(ids);
 await db.query(`CREATE FUNCTION synthetic_http_reminder_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='plan.installment_reminder' AND NEW.entity_id='${b.planId}' THEN RAISE EXCEPTION 'synthetic reminder fault'; END IF; RETURN NEW; END $$`);
 await db.query("CREATE TRIGGER synthetic_http_reminder_fault BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_http_reminder_fault()");
 try {expect((await post({planIds:ids})).status).toBe(500);expect(await snapshot(ids)).toEqual(before);}
 finally {await db.query("DROP TRIGGER synthetic_http_reminder_fault ON audit_log");await db.query("DROP FUNCTION synthetic_http_reminder_fault()");}
 expect((await post({planIds:ids})).status).toBe(200);expect((await snapshot(ids)).audits).toHaveLength(2);
});

it('rejects malformed or oversized identifiers before writes',async()=>{
 const f=await fixture(),before=await snapshot([f.planId]);
 for(const body of [{planId:2147483648},{planId:f.planId,installmentNumber:0},{planId:f.planId,installmentNumber:2147483648},{planIds:[f.planId,2147483648]},{planIds:Array(501).fill(f.planId)}]) {
  expect((await post(body)).status).toBe(400);
 }
 expect(await snapshot([f.planId])).toEqual(before);
});
