import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import {toInputAmount,type Currency} from "../../lib/money";
assertRealPostgresUrl(); stubPostgresEnv();
const db=await import("../../lib/db"), auth=await import("../../lib/auth");
const addition=await import("../../lib/invoice-add-service-db");
const q=async(sql:string,values:unknown[]=[]) => (await db.getPool().query(sql,values)).rows;
let session:SessionPayload,serviceId:number,clinicalServiceId:number,doctorId:number,serial=0;
beforeAll(async()=>{
 await dropPublicSchema(process.env.DATABASE_URL!);await db.ensureSchema();
 const password=await auth.hashPassword("synthetic-add-service");
 const [user]=await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES ('addition-owner','Synthetic addition owner',$1,'admin',TRUE) RETURNING id",[password]);
 session={userId:user.id,username:"addition-owner",role:"admin",credentialVersion:auth.sessionCredentialVersion(password),expiresAt:Date.now()+3_600_000};
 doctorId=(await q("INSERT INTO parties(kind,name) VALUES ('doctor','Synthetic addition doctor') RETURNING id"))[0].id;
 serviceId=(await q("INSERT INTO services(name,category,price_minor,price_sar_minor,price_usd_minor,price_configured,is_active) VALUES ('Synthetic additional consultation','consultation',2000,2000,2000,TRUE,TRUE) RETURNING id"))[0].id;
 clinicalServiceId=(await q("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES ('Synthetic new crown','crown',2000,TRUE,TRUE) RETURNING id"))[0].id;
 await db.openShift({openedBy:session.username,opening:{YER:0,SAR:0,USD:0}});
},180000);
afterAll(async()=>{await db.resetPoolForTesting();});
async function fixture(paid=0,currency:Currency="YER"){
 const patientId=(await q("INSERT INTO patients(patient_number,full_name) VALUES ($1,'Synthetic service addition') RETURNING id",[`SYN-ADD-${++serial}`]))[0].id;
 const invoice=await db.createInvoice({patientId,baseCurrency:currency,discountMinor:0,note:"Synthetic original",createdBy:session.username,items:[{serviceId:null,doctorId,description:"Synthetic original work",quantity:1,unitPriceMinor:10000}]});
 if(!invoice)throw new Error("Synthetic original missing");
 await q("UPDATE invoices SET created_at='2026-10-01T12:00:00Z' WHERE id=$1",[invoice.id]);
 if(paid)expect((await db.recordPayment({patientId,invoiceId:invoice.id,kind:"payment",amountMinor:paid,currency,baseCurrency:currency,exchangeRate:1,method:"cash",note:null,createdBy:session.username,idempotencyKey:`synthetic-add-paid-${serial}`})).reason).toBeNull();
 return (await db.getInvoice(invoice.id))!;
}
async function command(id:number,extra:Record<string,unknown>={}){
 const view=await addition.readInvoiceAddService(id,session);
 return {idempotencyKey:`synthetic-add-${++serial}`,expectedSourceHash:view.sourceHash,reason:"Synthetic new service requested",serviceId,doctorId,price:toInputAmount(2000,view.original.currency),priceReason:null,discount:"0",discountReason:null,currency:view.original.currency,...extra};
}
it("fails closed before the unnumbered schema proposal is separately adopted",async()=>{
 const original=await fixture();await expect(addition.readInvoiceAddService(original.id,session)).rejects.toMatchObject({code:"schema_unavailable"});
 expect(await q("SELECT id FROM invoices WHERE patient_id=$1",[original.patientId])).toHaveLength(1);
 await q(readFileSync("migrations/proposals/invoice-service-additions.sql","utf8"));
});
it.each((["YER","SAR","USD"] as const).flatMap(currency=>[0,4000].map(paid=>({currency,paid}))))("adds exactly new debt in $currency after $paid collected; preserves original and receipts",async({currency,paid})=>{
 const original=await fixture(paid,currency),body=await command(original.id);
 const receipts=await q("SELECT * FROM payments WHERE patient_id=$1 ORDER BY id",[original.patientId]);
 const cash=(await db.getOpenShift())!.expected;
 const preview=await addition.previewInvoiceAddService(original.id,body,session);
 expect(preview).toMatchObject({addedNetMinor:2000,accountDueBeforeMinor:10000-paid,accountDueAfterMinor:12000-paid,currency});
 const result=await addition.addInvoiceService(original.id,body,session);
 expect(result).toMatchObject({originalInvoiceId:original.id,patientId:original.patientId,currency,addedNetMinor:2000,cashMovementMinor:0,requestHash:preview.requestHash,replayed:false});
 expect(result.additionalInvoiceId).not.toBe(original.id);expect(result.additionalCreatedAt).not.toBe(original.createdAt);
 expect(await db.getInvoice(original.id)).toEqual(original);
 const created=(await db.getInvoice(result.additionalInvoiceId))!;expect(created.items).toHaveLength(1);expect(created.items[0]).toMatchObject({serviceId,unitPriceMinor:2000,quantity:1});expect(created.note).toContain(original.invoiceNumber);
 expect(await q("SELECT * FROM payments WHERE patient_id=$1 ORDER BY id",[original.patientId])).toEqual(receipts);expect((await db.getOpenShift())!.expected).toEqual(cash);
 const ledger=await db.patientLedger(original.patientId);expect(db.ledgerBalancesByCurrency(original.patientId,ledger,new Map())[currency]).toMatchObject({billedMinor:12000,collectedMinor:paid,dueMinor:12000-paid});
 expect(await addition.addInvoiceService(original.id,body,session)).toEqual({...result,replayed:true});
 expect(await q("SELECT id FROM invoice_service_additions WHERE original_invoice_id=$1",[original.id])).toHaveLength(1);
 expect(await q("SELECT id FROM audit_log WHERE action='invoice.service_add' AND entity_id=$1",[String(original.id)])).toHaveLength(1);
});
it("recovers a lost response before changed catalogue validation and rejects altered intent",async()=>{
 const original=await fixture(4000),body=await command(original.id);const saved=await addition.addInvoiceService(original.id,body,session);
 await q("UPDATE services SET is_active=FALSE,price_minor=9000 WHERE id=$1",[serviceId]);
 try{expect(await addition.addInvoiceService(original.id,body,session)).toEqual({...saved,replayed:true});await expect(addition.addInvoiceService(original.id,{...body,reason:"Different intent"},session)).rejects.toMatchObject({code:"conflict"});}
 finally{await q("UPDATE services SET is_active=TRUE,price_minor=2000 WHERE id=$1",[serviceId]);}
});
it("serializes same-key saves and refuses a second key from the same preview",async()=>{
 const original=await fixture(),body=await command(original.id);const saved=await Promise.all([addition.addInvoiceService(original.id,body,session),addition.addInvoiceService(original.id,body,session)]);
 expect(new Set(saved.map(r=>r.additionalInvoiceId)).size).toBe(1);expect(saved.map(r=>r.replayed).sort()).toEqual([false,true]);
 await expect(addition.addInvoiceService(original.id,{...body,idempotencyKey:`other-${body.idempotencyKey}`},session)).rejects.toMatchObject({code:"stale",terminal:true});
 expect(await q("SELECT id FROM invoices WHERE patient_id=$1",[original.patientId])).toHaveLength(2);
});
it("stores a durable stale refusal when an intervening payment changes the preview",async()=>{
 const original=await fixture(),body=await command(original.id);
 expect((await db.recordPayment({patientId:original.patientId,invoiceId:original.id,kind:"payment",amountMinor:1000,currency:"YER",baseCurrency:"YER",exchangeRate:1,method:"cash",note:null,createdBy:session.username,idempotencyKey:`synthetic-add-race-${serial}`})).reason).toBeNull();
 await expect(addition.addInvoiceService(original.id,body,session)).rejects.toMatchObject({code:"stale",terminal:true,idempotencyKey:body.idempotencyKey});
 await expect(addition.addInvoiceService(original.id,body,session)).rejects.toMatchObject({code:"stale",terminal:true});
 expect(await q("SELECT id FROM invoices WHERE patient_id=$1",[original.patientId])).toHaveLength(1);
 expect(await q("SELECT idempotency_key FROM invoice_service_addition_rejections WHERE idempotency_key=$1",[body.idempotencyKey])).toHaveLength(1);
});
it("preserves completed clinical visits, signatures, lab orders and original financial work",async()=>{
 const original=await fixture();const visit=(await q("INSERT INTO visits(patient_id,patient_name,status,invoice_id,signed_at,signed_by) VALUES ($1,'Synthetic completed visit','done',$2,NOW(),'synthetic') RETURNING id",[original.patientId,original.id]))[0].id;
 const before=await q("SELECT * FROM visits WHERE id=$1",[visit]);
 const body=await command(original.id,{serviceId:clinicalServiceId,toothCode:36});const result=await addition.addInvoiceService(original.id,body,session);
 expect(result.sourceVisitIds).toEqual([visit]);expect(await q("SELECT * FROM visits WHERE id=$1",[visit])).toEqual(before);
 expect(await db.getInvoice(original.id)).toEqual(original);
 expect(await q("SELECT id FROM lab_orders WHERE patient_id=$1",[original.patientId])).toHaveLength(0);
 const [item]=await q("SELECT status,billed_invoice_id,doctor_id,tooth_code FROM plan_items WHERE billed_invoice_id=$1",[result.additionalInvoiceId]);expect(item).toMatchObject({status:"planned",billed_invoice_id:result.additionalInvoiceId,doctor_id:doctorId,tooth_code:36});
 await expect(addition.addInvoiceService(original.id,await command(original.id,{serviceId:clinicalServiceId,toothCode:36}),session)).rejects.toMatchObject({code:"already_billed"});
});
it("does not append clinical work to a consented master or manufacture a second plan",async()=>{
 const original=await fixture();const first=await addition.addInvoiceService(original.id,await command(original.id,{serviceId:clinicalServiceId,toothCode:36}),session);
 const planId=first.clinical.planId!;await q("UPDATE treatment_plans SET consent_at=NOW(),consent_by='synthetic' WHERE id=$1",[planId]);
 await expect(addition.addInvoiceService(original.id,await command(original.id,{serviceId:clinicalServiceId,toothCode:46,existingPlanId:planId}),session)).rejects.toMatchObject({code:"incompatible_plan"});
 expect(await q("SELECT id FROM treatment_plans WHERE patient_id=$1",[original.patientId])).toHaveLength(1);
});
it("refuses missing/revoked authority, both locked dates, currency changes and nonpositive additions",async()=>{
 const original=await fixture(),body=await command(original.id);
 await expect(addition.addInvoiceService(original.id,body,{...session,role:"reception"})).rejects.toMatchObject({code:"unauthorized"});
 await q("UPDATE users SET is_active=FALSE WHERE id=$1",[session.userId]);try{await expect(addition.addInvoiceService(original.id,body,session)).rejects.toMatchObject({code:"unauthorized"});}finally{await q("UPDATE users SET is_active=TRUE WHERE id=$1",[session.userId]);}
 for(const locked of ["2026-10-02","2099-01-01"]){await q("INSERT INTO settings(key,value) VALUES ('finance.locked_before',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[locked]);try{const lockedBody=await command(original.id);await expect(addition.addInvoiceService(original.id,lockedBody,session)).rejects.toMatchObject({code:"locked_period"});}finally{await q("DELETE FROM settings WHERE key='finance.locked_before'");}}
 await expect(addition.addInvoiceService(original.id,{...body,currency:"USD"},session)).rejects.toMatchObject({code:"invalid"});
 await expect(addition.addInvoiceService(original.id,{...body,discount:"2000",discountReason:"Synthetic full discount"},session)).rejects.toMatchObject({code:"invalid"});
 expect(await q("SELECT id FROM invoices WHERE patient_id=$1",[original.patientId])).toHaveLength(1);
});
it("enforces immutable evidence and restricted invoice deletion",async()=>{
 const original=await fixture();const result=await addition.addInvoiceService(original.id,await command(original.id),session);
 await expect(q("UPDATE invoice_service_additions SET reason='mutated' WHERE additional_invoice_id=$1",[result.additionalInvoiceId])).rejects.toThrow();
 await expect(q("DELETE FROM invoice_service_additions WHERE additional_invoice_id=$1",[result.additionalInvoiceId])).rejects.toThrow();
 await expect(q("DELETE FROM invoices WHERE id=$1",[original.id])).rejects.toThrow();
 await expect(q("TRUNCATE invoice_service_additions")).rejects.toThrow();
});
it.each(["cancel","replacement","period"])("returns durable terminal rejection after %s invalidates a valid preview",async(change)=>{
 const original=await fixture(),body=await command(original.id);const preview=await addition.previewInvoiceAddService(original.id,body,session);
 if(change==="cancel")await db.setInvoiceStatus(original.id,"cancelled",{actor:session.username,actorRole:session.role});
 if(change==="replacement"){
   const result=await db.correctInvoice({invoiceId:original.id,lines:[{itemId:original.items[0].id,quantity:1,unitPriceMinor:9000}],reason:"Synthetic replacement after preview",actor:session.username,actorRole:session.role});expect(result.ok).toBe(true);
 }
 if(change==="period")await q("INSERT INTO settings(key,value) VALUES ('finance.locked_before','2099-01-01') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
 try{
   await expect(addition.addInvoiceService(original.id,body,session)).rejects.toMatchObject({code:"stale",terminal:true,idempotencyKey:body.idempotencyKey,requestHash:preview.requestHash});
   if(change==="period")await q("DELETE FROM settings WHERE key='finance.locked_before'");
   await expect(addition.addInvoiceService(original.id,body,session)).rejects.toMatchObject({code:"stale",terminal:true});
   expect(await q("SELECT id FROM invoice_service_additions WHERE original_invoice_id=$1",[original.id])).toHaveLength(0);
   expect(await q("SELECT idempotency_key FROM invoice_service_addition_rejections WHERE idempotency_key=$1",[body.idempotencyKey])).toHaveLength(1);
 }finally{if(change==="period")await q("DELETE FROM settings WHERE key='finance.locked_before'");}
});
it("rolls back the invoice, new work and audit when evidence insertion fails",async()=>{
 const original=await fixture(),body=await command(original.id,{serviceId:clinicalServiceId,toothCode:36});
 const tables=["invoices","invoice_items","treatment_plans","plan_items","clinical_cases","treatment_sessions","planned_visits","audit_log"];
 const fingerprint=async()=>Promise.all(tables.map(async table=>(await q(`SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) AS value FROM ${table} t`))[0].value));
 const before=await fingerprint();
 await q("CREATE FUNCTION synthetic_reject_addition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic evidence insertion failure'; END $$");
 await q("CREATE TRIGGER synthetic_reject_addition BEFORE INSERT ON invoice_service_additions FOR EACH ROW EXECUTE FUNCTION synthetic_reject_addition()");
 try{await expect(addition.addInvoiceService(original.id,body,session)).rejects.toThrow("synthetic evidence insertion failure");expect(await fingerprint()).toEqual(before);}
 finally{await q("DROP TRIGGER synthetic_reject_addition ON invoice_service_additions");await q("DROP FUNCTION synthetic_reject_addition()");}
 expect((await addition.addInvoiceService(original.id,body,session)).additionalInvoiceId).toBeGreaterThan(original.id);
});
it("retains nonempty historical procedures, laboratory costs, policies and old commission results",async()=>{
 const original=await fixture(4000);
 await q("INSERT INTO doctor_commission_history(party_id,percent,config,effective_from,source) VALUES ($1,20,NULL,'2000-01-01','baseline')",[doctorId]);
 const [visit]=await q("INSERT INTO visits(patient_id,patient_name,status,invoice_id,signed_at,signed_by) VALUES ($1,'Synthetic completed care','done',$2,'2026-10-01T12:30:00Z','synthetic') RETURNING id",[original.patientId,original.id]);
 await q("INSERT INTO visit_procedures(visit_id,service_id,doctor_id,tooth_code,quantity,unit_price_minor,note) VALUES ($1,$2,$3,11,1,10000,'Synthetic completed procedure')",[visit.id,clinicalServiceId,doctorId]);
 await q("INSERT INTO lab_orders(patient_id,lab_name,work_type,due_date,status,received_at,delivered_at,visit_id,doctor_id,cost_minor,cost_currency) VALUES ($1,'Synthetic laboratory','Synthetic original crown','2026-10-01','delivered','2026-10-01T10:00:00Z','2026-10-01T12:00:00Z',$2,$3,500,'YER')",[original.patientId,visit.id,doctorId]);
 const tables=["visits","visit_procedures","lab_orders","doctor_commission_history","payments"];
 const rows=async()=>Promise.all(tables.map(table=>q(`SELECT * FROM ${table} ORDER BY id`)));
 const before=await rows(),report=await db.commissionReport("2026-10-01","2026-10-01");
 expect(report.some(row=>row.doctorId===doctorId&&row.accruedMinor>0)).toBe(true);
 const result=await addition.addInvoiceService(original.id,await command(original.id),session);
 expect(result.sourceVisitIds).toEqual([visit.id]);expect(await rows()).toEqual(before);
 expect(await db.commissionReport("2026-10-01","2026-10-01")).toEqual(report);
 expect(await db.getInvoice(original.id)).toEqual(original);
});
it("binds clinical changes to the preview and displays an inherited existing provider",async()=>{
 const original=await fixture();
 const plan=await db.createPlanV2({patientId:original.patientId,title:"Synthetic unconsented plan",specialty:null,primaryDoctorId:doctorId,billingMode:"per_procedure",baseCurrency:"YER",startDate:"2026-10-01",note:null,createdBy:session.username,
   items:[{serviceId:clinicalServiceId,serviceName:"Synthetic new crown",category:"crown",toothCode:36,surfaces:null,note:null,quantity:1,unitPriceMinor:2000,billingRule:"on_completion",sessionCount:2}],installments:[]});
 if(!plan.ok)throw new Error(plan.message);
 await q("UPDATE plan_items SET doctor_id=$2 WHERE plan_id=$1",[plan.planId,doctorId]);
 const body=await command(original.id,{serviceId:clinicalServiceId,toothCode:36,doctorId:null,existingPlanId:plan.planId});
 const preview=await addition.previewInvoiceAddService(original.id,body,session);
 expect(preview.clinical[0]).toMatchObject({effectiveDoctorId:doctorId,effectiveDoctorName:"Synthetic addition doctor",effectivePlanId:plan.planId,item:{mode:"existing"}});
 await q("UPDATE plan_items SET status='done',sessions_completed=2 WHERE plan_id=$1",[plan.planId]);
 await expect(addition.addInvoiceService(original.id,body,session)).rejects.toMatchObject({code:"stale",terminal:true});
 expect(await q("SELECT id FROM invoice_service_additions WHERE original_invoice_id=$1",[original.id])).toHaveLength(0);
});
it.each(["column","key","fk","trigger_events","trigger_function"])("rejects malformed readiness with the same names but wrong %s",async(kind)=>{
 const {invoiceAddServiceSchemaReady}=await import("../../lib/invoice-add-service-schema");const client=await db.getPool().connect();
 try{await client.query("BEGIN");
   if(kind==="column"){await client.query("ALTER TABLE invoice_service_additions DROP CONSTRAINT invoice_service_additions_receipt_check");await client.query("ALTER TABLE invoice_service_additions ALTER COLUMN receipt TYPE TEXT USING receipt::text");}
   if(kind==="key"){await client.query("ALTER TABLE invoice_service_additions DROP CONSTRAINT invoice_service_additions_idempotency_key_key");await client.query("ALTER TABLE invoice_service_additions ADD CONSTRAINT invoice_service_additions_idempotency_key_key UNIQUE (source_hash)");}
   if(kind==="fk"){await client.query("ALTER TABLE invoice_service_additions DROP CONSTRAINT invoice_service_additions_original_invoice_id_fkey");await client.query("ALTER TABLE invoice_service_additions ADD CONSTRAINT invoice_service_additions_original_invoice_id_fkey FOREIGN KEY(original_invoice_id) REFERENCES invoices(id) ON DELETE CASCADE");}
   if(kind==="trigger_events"){await client.query("DROP TRIGGER invoice_service_additions_immutable ON invoice_service_additions");await client.query("CREATE TRIGGER invoice_service_additions_immutable AFTER UPDATE OR DELETE ON invoice_service_additions FOR EACH ROW EXECUTE FUNCTION aqlan_invoice_service_addition_immutable()");}
   if(kind==="trigger_function"){await client.query("CREATE FUNCTION synthetic_wrong_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$");await client.query("DROP TRIGGER invoice_service_additions_immutable ON invoice_service_additions");await client.query("CREATE TRIGGER invoice_service_additions_immutable BEFORE UPDATE OR DELETE ON invoice_service_additions FOR EACH ROW EXECUTE FUNCTION synthetic_wrong_immutable()");}
   expect(await invoiceAddServiceSchemaReady(client)).toBe(false);
 }finally{await client.query("ROLLBACK");client.release();}
});
