import {afterAll,beforeAll,describe,it,expect} from "vitest";
import {assertRealPostgresUrl,dropPublicSchema,stubPostgresEnv} from "./_setup";
import {invoiceCatalogRequestFingerprint,invoiceCommandFingerprint,parseInvoiceCommand} from "../../lib/invoice-template";
import {DEFAULT_SPECIALTY_TEMPLATES} from "../../lib/specialty-templates";
import type {SessionPayload} from "../../lib/auth";
assertRealPostgresUrl();stubPostgresEnv();
const db=await import("../../lib/db"),auth=await import("../../lib/auth"),linked=await import("../../lib/invoice-linkage-db");
let session:SessionPayload,serviceId:number,serial=0;
const q=async(sql:string,values:unknown[]=[]) => (await db.getPool().query(sql,values)).rows;
beforeAll(async()=>{await dropPublicSchema(process.env.DATABASE_URL!);await db.ensureSchema();
  const password=await auth.hashPassword("synthetic-invoice-visit-owner");const [user]=await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('invoice-visit-owner','Synthetic visit owner',$1,'admin',TRUE) RETURNING id",[password]);
  session={userId:user.id,username:"invoice-visit-owner",role:"admin",expiresAt:Date.now()+3600000,credentialVersion:auth.sessionCredentialVersion(password)};
  serviceId=(await q("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('Synthetic consultation fee','consultation',3000,TRUE,TRUE) RETURNING id"))[0].id;
},180000);
afterAll(async()=>{await db.resetPoolForTesting();});
async function patient(){return (await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic explicit invoice visit') RETURNING id",[`VIS-INV-${++serial}`]))[0].id as number;}
async function visit(patientId:number){return (await q("INSERT INTO visits(patient_id,patient_name) VALUES($1,'Synthetic explicit invoice visit') RETURNING id",[patientId]))[0].id as number;}
async function command(patientId:number,visitId?:number){
  const source={patientId,...(visitId!==undefined?{visitId}:{}),currency:"YER",items:[{serviceId,price:"3000",catalogPriceMinor:3000}],discount:"0",idempotencyKey:`invoice-visit-${patientId}-${++serial}`};
  const parsed=parseInvoiceCommand(source,new Map((await db.listServices(true)).map(service=>[service.id,service])),new Set(),await db.getSettings(),true);
  if(!parsed.ok)throw new Error(parsed.message);
  const {authorityLines:_authority,template:_template,...values}=parsed;void _authority;void _template;
  const input={...values,createdBy:session.username,actorRole:session.role,templates:DEFAULT_SPECIALTY_TEMPLATES,requestHash:invoiceCatalogRequestFingerprint(source,session),auditDetails:{},catalogueAuthority:{source,fingerprint:invoiceCommandFingerprint(parsed),session}};
  return {source,input};
}
const count=async(patientId:number)=>(await q("SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) AS invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) AS payments,(SELECT count(*)::int FROM treatment_plans WHERE patient_id=$1) AS plans",[patientId]))[0];
describe("explicit invoice visit binding without generic visit inference",()=>{
  it("attaches one consultation invoice atomically and replays it after a visit lifecycle transition",async()=>{
    const owner=await patient(),context=await visit(owner),{input}=await command(owner,context);
    const results=await Promise.all([linked.createLinkedInvoice(input),linked.createLinkedInvoice(input)]);
    expect(results.every(row=>row.ok)).toBe(true);if(!results[0].ok||!results[1].ok)throw new Error("Expected invoice");
    expect(results.map(row=>row.ok?row.replayed:null).sort()).toEqual([false,true]);expect(results[0].invoice.id).toBe(results[1].invoice.id);expect(results[0].visitId).toBe(context);
    expect(await q("SELECT invoice_id FROM visits WHERE id=$1",[context])).toEqual([{invoice_id:results[0].invoice.id}]);expect(await count(owner)).toEqual({invoices:1,payments:0,plans:0});
    await q("UPDATE visits SET status='done',signed_at=NOW() WHERE id=$1",[context]);
    expect(await linked.recoverLinkedInvoice({patientId:owner,visitId:context,idempotencyKey:input.idempotencyKey!,requestHash:input.requestHash,createdBy:session.username,session})).toMatchObject({ok:true,replayed:true,visitId:context,invoice:{id:results[0].invoice.id}});
    expect(await count(owner)).toEqual({invoices:1,payments:0,plans:0});
  });
  it("leaves all nearby open visits untouched for an independent invoice",async()=>{
    const owner=await patient();await visit(owner);await visit(owner);const {input}=await command(owner);
    expect(await linked.createLinkedInvoice(input)).toMatchObject({ok:true});expect(await q("SELECT invoice_id FROM visits WHERE patient_id=$1",[owner])).toEqual([{invoice_id:null},{invoice_id:null}]);
  });
  it.each(["foreign","closed","signed","already-billed"])("refuses %s visit context without partial invoice or plan writes",async fault=>{
    const owner=await patient(),other=await patient(),context=await visit(fault==="foreign"?other:owner);
    if(fault==="closed")await q("UPDATE visits SET status='done' WHERE id=$1",[context]);
    if(fault==="signed")await q("UPDATE visits SET signed_at=NOW() WHERE id=$1",[context]);
    if(fault==="already-billed"){const ordinary=await linked.createLinkedInvoice((await command(owner)).input);if(!ordinary.ok)throw new Error("Fixture");await q("UPDATE visits SET invoice_id=$2 WHERE id=$1",[context,ordinary.invoice.id]);}
    const before=await count(owner);expect(await linked.createLinkedInvoice((await command(owner,context)).input)).toMatchObject({ok:false,reason:"visit_context_invalid"});expect(await count(owner)).toEqual(before);
  });
  it("requires current authority and binds a key to the original visit",async()=>{
    const owner=await patient(),context=await visit(owner),other=await visit(owner),first=await command(owner,context);
    const saved=await linked.createLinkedInvoice(first.input);expect(saved.ok).toBe(true);
    const services=new Map((await db.listServices(true)).map(service=>[service.id,service])),source={...first.source,visitId:other};
    const parsed=parseInvoiceCommand(source,services,new Set(),await db.getSettings(),true);if(!parsed.ok)throw new Error(parsed.message);
    expect(await linked.createLinkedInvoice({...first.input,visitId:other,requestHash:invoiceCatalogRequestFingerprint(source,session),catalogueAuthority:{source,fingerprint:invoiceCommandFingerprint(parsed),session}})).toMatchObject({ok:false,reason:"idempotency_conflict"});
    await q("UPDATE users SET is_active=FALSE WHERE id=$1",[session.userId]);
    try{await expect(linked.createLinkedInvoice((await command(owner,other)).input)).rejects.toThrow(/الجلسة|صلاحية/);}finally{await q("UPDATE users SET is_active=TRUE WHERE id=$1",[session.userId]);}
    expect(await q("SELECT invoice_id FROM visits WHERE id=$1",[other])).toEqual([{invoice_id:null}]);expect(await count(owner)).toEqual({invoices:1,payments:0,plans:0});
  });
});
