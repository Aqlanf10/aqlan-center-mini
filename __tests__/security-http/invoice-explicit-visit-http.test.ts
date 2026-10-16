import {afterAll,beforeAll,describe,it,expect} from "vitest";
import {Client} from "pg";
import {authedMutation,harness} from "./_server";
import {readInvoiceCommandReceipt,type InvoiceTemplateReceiptExpectation} from "../../lib/invoice-template-receipt";
let h:Awaited<ReturnType<typeof harness>>,db:Client,serviceId:number,serial=0;
beforeAll(async()=>{h=await harness();db=new Client({connectionString:h.seeded.dbUrl,ssl:false});await db.connect();serviceId=(await db.query("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('Synthetic visit consultation','consultation',3000,TRUE,TRUE) RETURNING id")).rows[0].id;},240000);
afterAll(async()=>{await db?.end();});
async function patient(){return (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic visit HTTP') RETURNING id",[`VIS-HTTP-${Date.now()}-${++serial}`])).rows[0].id as number;}
async function visit(patientId:number){return (await db.query("INSERT INTO visits(patient_id,patient_name) VALUES($1,'Synthetic visit HTTP') RETURNING id",[patientId])).rows[0].id as number;}
const body=(patientId:number,visitId?:number)=>({patientId,...(visitId!==undefined?{visitId}:{}),currency:"YER",items:[{serviceId,quantity:1,price:"3000",catalogPriceMinor:3000}],discount:"0",repaymentTerms:{mode:"full",installments:[]},idempotencyKey:`visit-http-${patientId}-${++serial}`});
describe("explicit invoice visit through the authenticated HTTP boundary",()=>{
  it("returns the bound visit, exactly one invoice and a complete reusable acknowledgement",async()=>{
    const owner=await patient(),context=await visit(owner),source=body(owner,context);
    const replies=await Promise.all([authedMutation("/api/invoices",h.sessions.admin,"POST",JSON.stringify(source)),authedMutation("/api/invoices",h.sessions.admin,"POST",JSON.stringify(source))]);
    expect(replies.map(response=>response.status).sort()).toEqual([200,201]);const first=await replies[0].json(),second=await replies[1].json();expect(first.id).toBe(second.id);expect(first.visitId).toBe(context);expect(second.visitId).toBe(context);
    const lease={},expected:InvoiceTemplateReceiptExpectation={owner:lease,patientId:owner,visitId:context,currency:"YER",discountMinor:0,note:null,expectedPlanId:null,repaymentTerms:{mode:"full",installments:[]},
      lines:[{source:"manual",serviceId,doctorId:null,description:"Synthetic visit consultation",quantity:1,unitPriceMinor:3000,toothCode:null,surfaces:null,kind:"financial",specialty:null,scheduled:false,planItem:{mode:"none"},case:{mode:"none"}}]};
    expect(readInvoiceCommandReceipt(first,expected,lease)).not.toBeNull();expect(readInvoiceCommandReceipt({...first,visitId:context+1},expected,lease)).toBeNull();
    expect((await db.query("SELECT invoice_id FROM visits WHERE id=$1",[context])).rows).toEqual([{invoice_id:first.id}]);
    expect((await db.query("SELECT id FROM invoices WHERE patient_id=$1",[owner])).rows).toHaveLength(1);expect((await db.query("SELECT id FROM payments WHERE patient_id=$1",[owner])).rows).toHaveLength(0);
  });
  it("keeps independent entry unbound and refuses a foreign or no-longer-open visit without a financial write",async()=>{
    const owner=await patient(),other=await patient(),nearby=await visit(owner),foreign=await visit(other),source=body(owner);
    const independent=await authedMutation("/api/invoices",h.sessions.admin,"POST",JSON.stringify(source));expect(independent.status).toBe(201);expect(await independent.json()).not.toHaveProperty("visitId");
    expect((await db.query("SELECT invoice_id FROM visits WHERE id=$1",[nearby])).rows).toEqual([{invoice_id:null}]);
    for(const context of [foreign,nearby]){
      if(context===nearby)await db.query("UPDATE visits SET status='done' WHERE id=$1",[nearby]);
      const denied=await authedMutation("/api/invoices",h.sessions.admin,"POST",JSON.stringify(body(owner,context)));expect(denied.status).toBe(409);
    }
    expect((await db.query("SELECT id FROM invoices WHERE patient_id=$1",[owner])).rows).toHaveLength(1);
  });
  it("keeps role and exact visit/key intent boundaries",async()=>{
    const owner=await patient(),context=await visit(owner),source=body(owner,context);
    expect((await authedMutation("/api/invoices",h.sessions.doctorA,"POST",JSON.stringify(source))).status).toBe(403);
    expect((await authedMutation("/api/invoices",h.sessions.admin,"POST",JSON.stringify({...source,visitId:String(context)}))).status).toBe(400);
    expect((await authedMutation("/api/invoices",h.sessions.admin,"POST",JSON.stringify(source))).status).toBe(201);
    const next=await visit(owner);expect((await authedMutation("/api/invoices",h.sessions.admin,"POST",JSON.stringify({...source,visitId:next}))).status).toBe(409);
    expect((await db.query("SELECT invoice_id FROM visits WHERE id=$1",[next])).rows).toEqual([{invoice_id:null}]);
    expect((await db.query("SELECT id FROM invoices WHERE patient_id=$1",[owner])).rows).toHaveLength(1);
  });
});
