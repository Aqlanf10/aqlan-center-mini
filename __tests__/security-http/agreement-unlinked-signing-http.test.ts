import { afterAll, beforeAll, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let serial = 0;
beforeAll(async () => { h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect(); });
afterAll(async () => { await db?.end(); });
const q = (sql: string, values: unknown[] = []) => db.query(sql, values);
async function fixture(funding: "approved" | "direct_installments", mode = "unlinked") {
 const patient = (await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic unlinked coverage') RETURNING id", [`UNC-${Date.now()}-${++serial}`])).rows[0].id;
 const doctor = (await q("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic coverage doctor') RETURNING id")).rows[0].id;
 const service = (await q("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES('Synthetic covered service','general',150000,TRUE,TRUE) RETURNING id")).rows[0].id;
 async function plan(covered: boolean) {
  const id = (await q("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,start_date,consent_at,consent_by) VALUES($1,'Synthetic explicit work',150000,'SAR','2026-10-01',now(),'secadmin') RETURNING id", [patient])).rows[0].id;
  const item = (await q("INSERT INTO plan_items(plan_id,service_id,service_name,quantity,unit_price_minor,doctor_id,billing_rule,session_count) VALUES($1,$2,'Synthetic covered service',1,150000,$3,'per_session',1) RETURNING id", [id,service,doctor])).rows[0].id;
  if (covered && funding === "approved") {
   const r = await authedMutation(`/api/plans/${id}/financial-approval`,h.sessions.admin,"POST",JSON.stringify({expectedTotalMinor:150000,currency:"SAR",source:{kind:"new"},reason:"Synthetic approved coverage"}),{"Idempotency-Key":`coverage-approval-${id}`});
   expect(r.status,await r.clone().text()).toBe(201);
  } else if (covered) await q("INSERT INTO plan_installments(plan_id,number,due_date,amount_minor) VALUES($1,1,'2026-10-01',150000)",[id]);
  return item;
 }
 const covered = [await plan(true)];
 if(mode === "ambiguous") covered.push(await plan(true));
 const linked = mode === "linked" ? covered[0] : mode === "explicit_extra" ? await plan(false) : null;
 const workService = mode === "unrelated" ? (await q("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES('Synthetic unrelated work','general',150000,TRUE,TRUE) RETURNING id")).rows[0].id : service;
 const visit = (await q("INSERT INTO visits(patient_id,patient_name,doctor_id,diagnosis,billing_currency) VALUES($1,'Synthetic coverage',$2,'Synthetic diagnosis','SAR') RETURNING id",[patient,doctor])).rows[0].id;
 await q("INSERT INTO visit_procedures(visit_id,service_id,doctor_id,quantity,unit_price_minor,plan_item_id) VALUES($1,$2,$3,1,150000,$4)",[visit,workService,doctor,linked]);
 return {patient,visit,covered};
}
async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
 return (await q(`SELECT
 (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i WHERE patient_id=$1) AS invoices,
 (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM plan_items i WHERE id=ANY($2::int[])) AS items,
 (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM treatment_sessions s WHERE plan_item_id=ANY($2::int[])) AS sessions,
 (SELECT signed_at FROM visits WHERE id=$3) AS signed_at`,[f.patient,f.covered,f.visit])).rows[0];
}
it.each(["approved","direct_installments"] as const)("%s: unlinked matching work refuses twice without any debt or clinical mutation",async funding=>{
 const f=await fixture(funding); const before=await snapshot(f);
 for(let attempt=0;attempt<2;attempt++) {
  const r=await authedMutation(`/api/visits/${f.visit}/clinical`,h.sessions.admin,"POST",JSON.stringify({action:"sign"}));
  expect(r.status,await r.clone().text()).toBe(409);
  expect((await r.json()).sessionConflicts?.length).toBeGreaterThan(0);
  expect(await snapshot(f)).toEqual(before);
 }
});
it("ambiguous funded plans refuse without auto-attaching or completing either",async()=>{
 const f=await fixture("approved","ambiguous"); const before=await snapshot(f);
 const r=await authedMutation(`/api/visits/${f.visit}/clinical`,h.sessions.admin,"POST",JSON.stringify({action:"sign"}));
 expect(r.status).toBe(409); expect(await snapshot(f)).toEqual(before);
});
it.each(["linked","unrelated","explicit_extra"])("%s keeps its explicit billing policy and repeated signing never bills twice",async mode=>{
 const f=await fixture("approved",mode);
 const sign=()=>authedMutation(`/api/visits/${f.visit}/clinical`,h.sessions.admin,"POST",JSON.stringify({action:"sign"}));
 const r=await sign(); expect(r.status,await r.clone().text()).toBe(200);
 const after=await snapshot(f);
 expect(after.invoices).toHaveLength(mode==="linked"?1:2);
 expect(after.items[0].status).toBe(mode==="linked"?"done":"planned");
 expect((await sign()).status).toBe(409); expect(await snapshot(f)).toEqual(after);
});
it("reception cannot sign covered work",async()=>{
 const f=await fixture("approved"); const before=await snapshot(f);
 expect((await authedMutation(`/api/visits/${f.visit}/clinical`,h.sessions.reception,"POST",JSON.stringify({action:"sign"}))).status).toBe(403);
 expect(await snapshot(f)).toEqual(before);
});
it("completed covered work remains protected on a new unlinked visit",async()=>{
 const f=await fixture("approved","linked");
 expect((await authedMutation(`/api/visits/${f.visit}/clinical`,h.sessions.admin,"POST",JSON.stringify({action:"sign"}))).status).toBe(200);
 await q("UPDATE treatment_plans SET status='completed' WHERE id=(SELECT plan_id FROM plan_items WHERE id=$1)",[f.covered[0]]);
 const visit=(await q("INSERT INTO visits(patient_id,patient_name,doctor_id,diagnosis,billing_currency) SELECT patient_id,patient_name,doctor_id,diagnosis,billing_currency FROM visits WHERE id=$1 RETURNING id",[f.visit])).rows[0].id;
 await q("INSERT INTO visit_procedures(visit_id,service_id,doctor_id,quantity,unit_price_minor) SELECT $1,service_id,doctor_id,quantity,150000 FROM visit_procedures WHERE visit_id=$2",[visit,f.visit]);
 const next={...f,visit}; const before=await snapshot(next);
 const response=await authedMutation(`/api/visits/${visit}/clinical`,h.sessions.admin,"POST",JSON.stringify({action:"sign"}));
 expect(response.status,await response.clone().text()).toBe(409);
 expect(await snapshot(next)).toEqual(before);
});
