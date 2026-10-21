import { afterAll, beforeAll, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import type {SessionPayload} from "../../lib/auth";
import {getVisitFinancialContext} from "../../lib/visit-financial-context-db";
import {redactVisitFinancialContext} from "../../lib/visit-financial-context";
assertRealPostgresUrl();stubPostgresEnv();
const db=await import("../../lib/db");
const auth=await import("../../lib/auth");
const documents=await import("../../lib/legacy-treatment-document-db");
const q=async<T=Record<string,unknown>>(sql:string,params:unknown[]=[]) => (await db.getPool().query(sql,params)).rows as T[];
let serial=0, serviceId=0,session:SessionPayload;
beforeAll(async()=>{
  await dropPublicSchema(process.env.DATABASE_URL!);await db.ensureSchema();
  serviceId=(await q<{id:number}>("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('Synthetic source service','rct',10000,true,true) RETURNING id"))[0].id;
  const hash=await auth.hashPassword("synthetic-visit-sources-only");
  const [user]=await q<{id:number}>("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('visit-source-test','Synthetic source owner',$1,'admin',true) RETURNING id",[hash]);
  session={userId:user.id,username:"visit-source-test",role:"admin",credentialVersion:auth.sessionCredentialVersion(hash),expiresAt:Date.now()+3600000};
});
afterAll(async()=>db.resetPoolForTesting());
async function patient(){return (await q<{id:number}>("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic source patient') RETURNING id",[`SOURCE-${++serial}`]))[0].id;}
async function visit(patientId:number,currency:string|null="YER"){return (await q<{id:number}>("INSERT INTO visits(patient_name,patient_id,status,signed_at,arrived_at,billing_currency) VALUES('Synthetic source visit',$1,'done',NOW(),'2026-10-01 10:00+03',$2) RETURNING id",[patientId,currency]))[0].id;}
async function procedure(visitId:number,itemId:number|null=null,price=10000){return Number((await q<{id:string}>("INSERT INTO visit_procedures(visit_id,service_id,quantity,unit_price_minor,tooth_code,plan_item_id) VALUES($1,$2,1,$3,16,$4) RETURNING id::text",[visitId,serviceId,price,itemId]))[0].id);}
async function invoice(patientId:number,procedureId:number,status="open",source=true,currency="YER"){
 const [invoice]=await q<{id:number}>("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency,created_by,status) VALUES($1,$2,10000,$4,'synthetic',$3) RETURNING id",[`SOURCE-INV-${++serial}`,patientId,status,currency]);
 await q("INSERT INTO invoice_items(invoice_id,service_id,description,quantity,unit_price_minor,total_minor,source_type,source_id) VALUES($1,$2,'Synthetic source line',1,10000,10000,$4,$3)",[invoice.id,serviceId,source?procedureId:null,source?"visit_procedure":null]);return invoice.id;
}
const snapshot=()=>q("SELECT (SELECT count(*) FROM invoices)::int AS invoices,(SELECT count(*) FROM payments)::int AS payments,(SELECT count(*) FROM legacy_treatment_agreements)::int AS agreements,(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM visits v) AS visits");
it("links an exact procedure invoice without a visit pointer; same-day other visits stay unresolved; reads do not write",async()=>{
 const p=await patient(),v=await visit(p),other=await visit(p),proc=await procedure(v);const inv=await invoice(p,proc);
 const before=await snapshot(); const result=await getVisitFinancialContext(v,p);
 expect(result).toMatchObject({directReference:null,summary:"verified",work:[{coverage:"verified",references:[{id:inv,kind:"invoice",path:"visit_procedure"}]}]});
 expect((await getVisitFinancialContext(other,p))?.summary).toBe("no_recorded_work");expect(await snapshot()).toEqual(before);
 await expect(getVisitFinancialContext(v,await patient())).rejects.toThrow("owner");
});
it("keeps mixed work distinct from fully covered or free work",async()=>{
 const p=await patient(),v=await visit(p);await invoice(p,await procedure(v));await procedure(v,null,0);
 const result=await getVisitFinancialContext(v,p);expect(result?.summary).toBe("mixed");expect(result?.work[1]).toMatchObject({coverage:"unresolved",decision:"none"});
});
it.each(["cancelled","foreign","identity"])("refuses %s source coverage",async mode=>{
 const p=await patient(),v=await visit(p),proc=await procedure(v);const inv=await invoice(mode==="foreign"?await patient():p,proc,mode==="cancelled"?"cancelled":"open");
 if(mode==="identity")await q("UPDATE invoice_items SET quantity=2,total_minor=20000 WHERE invoice_id=$1",[inv]);
 const result=await getVisitFinancialContext(v,p);expect(result?.summary).toBe("unresolved");expect(result?.work[0].coverage).toBe("unresolved");
 if(mode==="foreign")expect(result?.work[0].references).toEqual([]);
});
it("reuses historical-document validation for one agreement across visits without monetary totals or duplicate session work",async()=>{
 const p=await patient();const saved=await documents.createHistoricalDocument(p,{patientId:p,currency:"YER",
 items:[{serviceId,quantity:1,price:"10000",catalogPriceMinor:10000,toothCode:16}],discount:"0",previouslyPaidAmount:"10000",historicalAsOf:"2026-10-01",
 idempotencyKey:`source-history-${++serial}`,repaymentTerms:{mode:"full",installments:[]},repaymentRemainingMinor:0,repaymentVersion:0,repaymentSourceHash:null},session);
 const item=saved.document.lines[0];
 const first=await visit(p),second=await visit(p);await procedure(first,item.planItemId,0);await procedure(second,item.planItemId,0);
 await q("INSERT INTO treatment_sessions(plan_item_id,sequence,status,visit_id,completed_at,title) VALUES($1,99,'done',$2,NOW(),'Synthetic session')",[item.planItemId,first]);
 const before=await snapshot();
 for(const v of [first,second]){const result=await getVisitFinancialContext(v,p);expect(result?.work).toHaveLength(1);expect(result?.summary).toBe("verified");
 expect(result?.work[0].references).toContainEqual({kind:"historical_agreement",id:item.agreementId,state:"current",path:"plan_item"});
 expect(JSON.stringify(result)).not.toMatch(/Minor|total|paid|remaining/i);}
 expect(await snapshot()).toEqual(before);
 await q("UPDATE visit_procedures SET quantity=2 WHERE visit_id=$1",[first]);
 expect((await getVisitFinancialContext(first,p))?.summary).toBe("unresolved");
 expect((await getVisitFinancialContext(second,p))?.summary).toBe("verified");

});
it("requires an explicit recorded no-charge decision, not a missing invoice or legacy class",async()=>{
 const p=await patient(),v=await visit(p);const [c]=await q<{id:number}>("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'synthetic') RETURNING id",[p]);
 await q("INSERT INTO ortho_adjustments(case_id,visit_id,recorded_by,billing_class) VALUES($1,$2,'synthetic','LEGACY_INCLUDED')",[c.id,v]);
 expect((await getVisitFinancialContext(v,p))?.summary).toBe("unresolved");
 await q("UPDATE ortho_adjustments SET billing_class='OUTSIDE_CONTRACT',billing_decision='no_charge',billing_decision_reason='Synthetic explicit decision',billing_decided_by='synthetic',billing_decided_at=NOW() WHERE visit_id=$1",[v]);
 expect((await getVisitFinancialContext(v,p))?.summary).toBe("no_new_charge");
});
it("returns endodontic-only work as unresolved without guessing an item from its case",async()=>{
 const p=await patient(),v=await visit(p);const [c]=await q<{id:number}>("INSERT INTO clinical_cases(patient_id,specialty,title,site,created_by) VALUES($1,'endodontics','Synthetic episode','16','synthetic') RETURNING id",[p]);
 const [t]=await q<{id:number}>("INSERT INTO endo_treatments(patient_id,case_id,tooth_code,created_by) VALUES($1,$2,16,'synthetic') RETURNING id",[p,c.id]);
 await q("INSERT INTO endo_visits(treatment_id,visit_id,recorded_by) VALUES($1,$2,'synthetic')",[t.id,v]);
 const result=await getVisitFinancialContext(v,p);expect(result?.work[0].reasons).toContain("endo_work_item_not_explicit");expect(result?.summary).toBe("unresolved");
});
it("redacts financial source identifiers and never introduces monetary fields",async()=>{
 const p=await patient(),v=await visit(p);await invoice(p,await procedure(v));const result=(await getVisitFinancialContext(v,p))!;
 expect(redactVisitFinancialContext(result,false).work[0].references).toEqual([]);expect(redactVisitFinancialContext(result,true).work[0].references).toHaveLength(1);
});
it.each(["YER","SAR"])("follows only explicit same-denomination replacement identities: %s",async currency=>{
 const p=await patient(),v=await visit(p),proc=await procedure(v),original=await invoice(p,proc,"cancelled");
 const replacement=await invoice(p,proc,"open",false,currency);
 await q("UPDATE invoice_items SET source_type=NULL,source_id=NULL WHERE invoice_id=$1",[replacement]);
 expect((await getVisitFinancialContext(v,p))?.summary).toBe("unresolved");
 const client=await db.getPool().connect();
 try {
 await client.query("BEGIN");
 const cq=async<T=Record<string,unknown>>(sql:string,params:unknown[]=[]) => (await client.query(sql,params)).rows as T[];
 const [correction]=await cq<{id:number}>("INSERT INTO invoice_corrections(patient_id,currency,original_currency,original_invoice_id,corrected_invoice_id,idempotency_key,request_hash,reason,created_by) VALUES($1,$6,'YER',$2,$3,$4,$5,'Synthetic replacement','synthetic') RETURNING id",[p,original,replacement,`source-correction-${++serial}`,"a".repeat(64),currency]);
 await cq("INSERT INTO invoice_correction_lines(correction_id,original_item_id,corrected_item_id,approved_work) SELECT $1,a.id,b.id,'{}'::jsonb FROM invoice_items a,invoice_items b WHERE a.invoice_id=$2 AND b.invoice_id=$3",[correction.id,original,replacement]);
 await cq("INSERT INTO invoice_correction_receipts(correction_id,receipt) VALUES($1,$2::jsonb)",[correction.id,JSON.stringify({patientId:p,currency,idempotencyKey:`source-correction-${serial}`,createdBy:"synthetic",original:{id:original,patientId:p,baseCurrency:"YER"},corrected:{id:replacement,patientId:p,baseCurrency:currency}})]);
 if(currency!=="YER")await cq("INSERT INTO invoice_settlement_reclassifications(correction_id,patient_id,source_currency,target_currency,source_invoice_ids) VALUES($1,$2,'YER',$3,$4)",[correction.id,p,currency,[original]]);
 await client.query("COMMIT");
 } catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
 const result=await getVisitFinancialContext(v,p);
 expect(result?.summary).toBe(currency==="YER"?"verified":"unresolved");
 if(currency==="YER")expect(result?.work[0].references).toEqual(expect.arrayContaining([
  expect.objectContaining({id:original,state:"historical"}),expect.objectContaining({id:replacement,state:"current"})]));
 if(currency==="YER"){
  // A malformed historical read snapshot: no application record or guard is changed.
  const malformed=await db.getPool().connect();
  try{
   await malformed.query("BEGIN");
   await malformed.query("CREATE TEMP TABLE invoice_corrections ON COMMIT DROP AS SELECT * FROM public.invoice_corrections");
   await malformed.query("UPDATE pg_temp.invoice_corrections SET original_currency=NULL WHERE original_invoice_id=$1",[original]);
   const {readVisitFinancialContext}=await import("../../lib/visit-financial-context-db");
   // Legacy metadata follows the existing correction guard's COALESCE semantics,
   // but both actual invoices must still prove the same denomination.
   expect((await readVisitFinancialContext(malformed,v,p))?.summary).toBe("verified");
   await malformed.query("UPDATE pg_temp.invoice_corrections SET currency='SAR',original_currency='SAR' WHERE original_invoice_id=$1",[original]);
   // The old metadata-only equality accepted this edge despite actual YER invoice denominations.
   const old=(await malformed.query("SELECT id FROM pg_temp.invoice_corrections WHERE original_invoice_id=$1 AND currency=original_currency",[original])).rows;
   expect(old).toHaveLength(1);

   expect((await readVisitFinancialContext(malformed,v,p))?.summary).toBe("unresolved");
  }finally{await malformed.query("ROLLBACK");malformed.release();}
 }
 await q("UPDATE invoices SET status='cancelled' WHERE id=$1",[replacement]);
 expect((await getVisitFinancialContext(v,p))?.summary).toBe("unresolved");
});
it("separates invalid direct references from independently proven work coverage",async()=>{
 const p=await patient(),v=await visit(p);await invoice(p,await procedure(v));const foreign=await invoice(await patient(),await procedure(await visit(await patient())));
 await q("UPDATE visits SET invoice_id=$1 WHERE id=$2",[foreign,v]);
 expect(await getVisitFinancialContext(v,p)).toMatchObject({directReference:null,directReferenceState:"review",summary:"verified"});
});
it("does not certify unsigned work or conflicting no-charge decisions",async()=>{
 const p=await patient(),v=await visit(p),inv=await invoice(p,await procedure(v));
 await q("UPDATE visits SET signed_at=NULL WHERE id=$1",[v]);expect((await getVisitFinancialContext(v,p))?.summary).toBe("unresolved");
 const other=await visit(p);const [c]=await q<{id:number}>("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'synthetic') RETURNING id",[p]);
 await q("INSERT INTO ortho_adjustments(case_id,visit_id,recorded_by,billing_class,billing_decision,billing_decision_reason,billing_decided_by,billing_decided_at,billing_invoice_id) VALUES($1,$2,'synthetic','OUTSIDE_CONTRACT','no_charge','Synthetic conflicting decision','synthetic',NOW(),$3)",[c.id,other,inv]);
 expect((await getVisitFinancialContext(other,p))?.summary).toBe("unresolved");
});
it("rejects a historical source whose current work identity changed",async()=>{
 const p=await patient();const saved=await documents.createHistoricalDocument(p,{patientId:p,currency:"YER",items:[{serviceId,quantity:1,price:"10000",catalogPriceMinor:10000,toothCode:16}],discount:"0",previouslyPaidAmount:"10000",historicalAsOf:"2026-10-01",idempotencyKey:`source-invalid-history-${++serial}`,repaymentTerms:{mode:"full",installments:[]},repaymentRemainingMinor:0,repaymentVersion:0,repaymentSourceHash:null},session);
 const item=saved.document.lines[0],v=await visit(p);await procedure(v,item.planItemId,0);
 await q("UPDATE plan_items SET tooth_code=26 WHERE id=$1",[item.planItemId]);
 expect((await getVisitFinancialContext(v,p))?.summary).toBe("unresolved");
});
it("shares the source summary with the visits report without changing direct invoice or collection columns",async()=>{
 const p=await patient(),v=await visit(p);await invoice(p,await procedure(v));
 const {buildReport,parseFilters}=await import("../../lib/reports");
 const {VISIT_SOURCE_SUMMARY}=await import("../../lib/visit-financial-context");
 const filters=parseFilters(new URLSearchParams({preset:"custom",from:"2026-10-01",to:"2026-10-01",patientId:String(p)}),"2026-10-01");
 const result=await buildReport("visits",filters),context=await getVisitFinancialContext(v,p);
 expect(result.rows).toHaveLength(1);expect(result.rows![0].workSource).toBe(VISIT_SOURCE_SUMMARY[context!.summary]);
 expect(result.rows![0].collection).toBe("—");expect(result.kpis.find(k=>k.key==="invoiced")?.count).toBe(0);
});
it("deduplicates a completed session and direct plan-item path while preserving exact prepaid identity",async()=>{
 const p=await patient(),v=await visit(p);const [doctor]=await q<{id:number}>("INSERT INTO parties(name,kind) VALUES('Synthetic source doctor','doctor') RETURNING id");
 const [plan]=await q<{id:number}>("INSERT INTO treatment_plans(patient_id,title,total_minor,created_by) VALUES($1,'Synthetic plan',10000,'synthetic') RETURNING id",[p]);
 const [item]=await q<{id:number}>("INSERT INTO plan_items(plan_id,service_id,service_name,category,tooth_code,doctor_id,quantity,unit_price_minor,status,visit_id,billing_status) VALUES($1,$2,'Synthetic prepaid work','rct',16,$3,1,10000,'done',$4,'billed') RETURNING id",[plan.id,serviceId,doctor.id,v]);
 const inv=await invoice(p,0,"open",false);
 await q("UPDATE invoice_items SET source_type='plan_item',source_id=$1::int,plan_item_id=$1::int,doctor_id=$2 WHERE invoice_id=$3",[item.id,doctor.id,inv]);
 await q("UPDATE plan_items SET billed_invoice_id=$1,origin_invoice_id=$1 WHERE id=$2",[inv,item.id]);
 await q("INSERT INTO treatment_sessions(plan_item_id,sequence,status,visit_id,completed_at,title) VALUES($1,1,'done',$2,NOW(),'Synthetic completed session')",[item.id,v]);
 const result=await getVisitFinancialContext(v,p);expect(result?.summary).toBe("verified");expect(result?.work).toHaveLength(1);
 await q("UPDATE invoices SET status='cancelled' WHERE id=$1",[inv]);expect((await getVisitFinancialContext(v,p))?.summary).toBe("unresolved");
});
it("keeps an approved plan principal documentary until its canonical current-source proof is integrated",async()=>{
 const p=await patient(),v=await visit(p);
 const [plan]=await q<{id:number}>("INSERT INTO treatment_plans(patient_id,title,total_minor,status,consent_at,created_by) VALUES($1,'Synthetic approved plan',10000,'active',NOW(),'synthetic') RETURNING id",[p]);
 const [item]=await q<{id:number}>("INSERT INTO plan_items(plan_id,service_id,service_name,category,tooth_code,quantity,unit_price_minor,status,visit_id,billing_status) VALUES($1,$2,'Synthetic approved item','rct',16,1,10000,'done',$3,'included_in_package') RETURNING id",[plan.id,serviceId,v]);
 const {approveAgreement}=await import("../../lib/approved-agreements");
 await approveAgreement({planId:plan.id,expectedTotalMinor:10000,currency:"YER",source:{kind:"new"},reason:"Synthetic explicit approval",idempotencyKey:`source-approved-${++serial}`,session});
 const context=await getVisitFinancialContext(v,p);
 expect(context?.summary).toBe("unresolved");expect(context?.work).toHaveLength(1);
 expect(context?.work[0]).toMatchObject({id:item.id,reasons:["approved_source_unverified"],references:[{kind:"approved_agreement",id:plan.id,state:"review"}]});
});

it("retains a void standalone historical agreement as historical, never active coverage",async()=>{
 const {parseLegacyTreatmentRequest}=await import("../../lib/legacy-treatment");
 const {DEFAULT_SPECIALTY_TEMPLATES}=await import("../../lib/specialty-templates");
 const {createLegacyTreatment,voidLegacyTreatment}=await import("../../lib/legacy-treatment-db");
 const p=await patient();const request=parseLegacyTreatmentRequest({serviceId,toothCode:16,currency:"YER",agreedAmount:"10000",previouslyPaidAmount:"10000",historicalAsOf:"2026-10-01"},"2026-10-21");
 if(!request.ok)throw new Error(request.message);
 const result=await createLegacyTreatment({patientId:p,request:request.value,actor:session.username,actorRole:"admin",canEditOpening:true,templates:DEFAULT_SPECIALTY_TEMPLATES});
 if(!result.ok)throw new Error(result.reason);
 const v=await visit(p);await procedure(v,result.agreement.planItemId,0);
 expect((await getVisitFinancialContext(v,p))?.summary).toBe("verified");
 expect(await voidLegacyTreatment({patientId:p,agreementId:result.agreement.id,reason:"Synthetic void source",actor:session.username,actorRole:"admin"})).toMatchObject({ok:true});
 const context=await getVisitFinancialContext(v,p);expect(context?.summary).toBe("unresolved");
 expect(context?.work[0].references).toContainEqual(expect.objectContaining({kind:"historical_agreement",id:result.agreement.id,state:"historical"}));
});

it.each([{visitCurrency:"YER",invoiceCurrency:"YER",expected:"verified"},{visitCurrency:"YER",invoiceCurrency:"SAR",expected:"unresolved"},{visitCurrency:null,invoiceCurrency:"YER",expected:"unresolved"}])("requires explicit matching denominations: $visitCurrency / $invoiceCurrency",async({visitCurrency,invoiceCurrency,expected})=>{
 const p=await patient(),v=await visit(p,visitCurrency),proc=await procedure(v),inv=await invoice(p,proc,"open",true,invoiceCurrency);
 const context=await getVisitFinancialContext(v,p);
 expect(context?.summary).toBe(expected);
 expect(context?.work[0].coverage).toBe(expected);
 if(expected==="unresolved")expect(context?.work[0].references).toContainEqual(expect.objectContaining({id:inv,state:"review"}));
});

it("bounds empty report source reads by batches rather than five queries per visit",async()=>{
 const p=await patient();const rows=await q<{id:number}>("INSERT INTO visits(patient_name,patient_id,status,signed_at,billing_currency) SELECT 'Synthetic batch visit',$1,'done',NOW(),'YER' FROM generate_series(1,201) RETURNING id",[p]);
 const {readVisitFinancialContexts}=await import("../../lib/visit-financial-context-db");
 const client=await db.getPool().connect();let reads=0;
 const counted={query:async(...args:Parameters<typeof client.query>)=>{reads++;return client.query(...args);}} as typeof client;
 try{await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
 const results=[...(await readVisitFinancialContexts(counted,rows.map(row=>({visitId:row.id,expectedPatientId:p})))).values()];
 expect(results).toHaveLength(201);expect(results.every(row=>row?.summary==="no_recorded_work")).toBe(true);
 expect(reads).toBe(10);
 }finally{await client.query("ROLLBACK");client.release();}
});
it.each(["SAR","YER"])("uses an explicitly linked SAR plan denomination, not the visit YER preference: invoice %s",async currency=>{
 const p=await patient(),v=await visit(p,"YER");
 const [plan]=await q<{id:number}>("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,created_by) VALUES($1,'Synthetic SAR plan',10000,'SAR','synthetic') RETURNING id",[p]);
 const [item]=await q<{id:number}>("INSERT INTO plan_items(plan_id,service_id,service_name,category,tooth_code,quantity,unit_price_minor,billing_status) VALUES($1,$2,'Synthetic SAR work','rct',16,1,10000,'unbilled') RETURNING id",[plan.id,serviceId]);
 const proc=await procedure(v,item.id);await invoice(p,proc,"open",true,currency);
 expect((await getVisitFinancialContext(v,p))?.summary).toBe(currency==="SAR"?"verified":"unresolved");
});
it("deduplicates repeated historical item/document reads across batch boundaries and retains every visit",async()=>{
 const p=await patient();const saved=await documents.createHistoricalDocument(p,{patientId:p,currency:"YER",items:[{serviceId,quantity:1,price:"10000",catalogPriceMinor:10000,toothCode:16}],discount:"0",previouslyPaidAmount:"10000",historicalAsOf:"2026-10-01",idempotencyKey:`source-batched-history-${++serial}`,repaymentTerms:{mode:"full",installments:[]},repaymentRemainingMinor:0,repaymentVersion:0,repaymentSourceHash:null},session);
 const item=saved.document.lines[0];
 const rows=await q<{id:number}>("INSERT INTO visits(patient_name,patient_id,status,signed_at,billing_currency) SELECT 'Synthetic shared source visit',$1,'done',NOW(),'YER' FROM generate_series(1,201) RETURNING id",[p]);
 await q("INSERT INTO visit_procedures(visit_id,service_id,quantity,unit_price_minor,tooth_code,plan_item_id) SELECT unnest($1::int[]),$2,1,0,16,$3",[rows.map(row=>row.id),serviceId,item.planItemId]);
 const {readVisitFinancialContexts}=await import("../../lib/visit-financial-context-db");
 const client=await db.getPool().connect();let reads=0;
 const counted={query:async(...args:Parameters<typeof client.query>)=>{reads++;return client.query(...args);}} as typeof client;
 try{await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
 const results=await readVisitFinancialContexts(counted,rows.map(row=>({visitId:row.id,expectedPatientId:p})));
 expect(results.size).toBe(201);for(const context of results.values()){
  expect(context.summary).toBe("verified");expect(context.work).toHaveLength(1);
  expect(context.work[0].references).toContainEqual({kind:"historical_agreement",id:item.agreementId,state:"current",path:"plan_item"});
 }
 expect(reads).toBe(17);
 await expect(readVisitFinancialContexts(counted,[{visitId:rows[0].id,expectedPatientId:p+99999}])).rejects.toThrow("Visit owner changed");
 }finally{await client.query("ROLLBACK");client.release();}
});
