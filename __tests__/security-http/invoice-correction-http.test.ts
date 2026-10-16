import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";
let h:Awaited<ReturnType<typeof harness>>,db:Client,patientId=0;
beforeAll(async()=>{h=await harness();db=new Client({connectionString:h.seeded.dbUrl,ssl:false});await db.connect();
  patientId=(await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic HTTP revision') RETURNING id",[`REV-H-${Date.now()}`])).rows[0].id;},120000);
afterAll(async()=>{await db?.end();});
describe("authorized immutable invoice revision HTTP",()=>{
  it("refuses other roles, binds the reviewed source, increases/decreases and replays exactly once",async()=>{
    const invoice=(await db.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by) VALUES($1,$2,50000,0,'YER','synthetic') RETURNING id",[`REV-HTTP-${Date.now()}`,patientId])).rows[0];
    const item=(await db.query("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES($1,'Synthetic financial work',1,50000,50000) RETURNING id",[invoice.id])).rows[0];
    const path=`/api/invoices/${invoice.id}/correct`;
    for(const role of ["reception","doctorA","accountant","cashier"] as const){
      expect((await authedGet(path,h.sessions[role])).status).toBe(403);
      expect((await authedMutation(path,h.sessions[role],"POST","{}")).status).toBe(403);
    }
    const view=await (await authedGet(path,h.sessions.admin)).json() as {sourceHash:string};
    const body={idempotencyKey:`revision-http-${invoice.id}`,expectedSourceHash:view.sourceHash,reason:"Correct agreed price",lines:[{itemId:item.id,quantity:1,unitPrice:"60000"}],discount:"0",discountReason:null,
      repaymentTerms:{mode:"full",installments:[]},expectedRemainingMinor:60000};
    expect((await authedMutation(path,h.sessions.admin,"POST",JSON.stringify({...body,reason:""}))).status).toBe(400);
    expect((await authedMutation(path,h.sessions.admin,"POST",JSON.stringify({...body,expectedSourceHash:"a".repeat(64)}))).status).toBe(409);
    const saved=await authedMutation(path,h.sessions.admin,"POST",JSON.stringify(body));expect(saved.status).toBe(201);
    const result=await saved.json() as {original:{id:number;status:string};corrected:{id:number;totalMinor:number;items:{id:number}[]};replayed:boolean};
    expect(result.original).toMatchObject({id:invoice.id,status:"cancelled"});expect(result.corrected.totalMinor).toBe(60000);
    const replay=await authedMutation(path,h.sessions.admin,"POST",JSON.stringify(body));expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({...result,replayed:true});
    expect((await authedMutation(path,h.sessions.admin,"POST",JSON.stringify({...body,reason:"Different intent"}))).status).toBe(409);
    const nextPath=`/api/invoices/${result.corrected.id}/correct`;
    const next=await (await authedGet(nextPath,h.sessions.admin)).json() as {sourceHash:string};
    const reduced=await authedMutation(nextPath,h.sessions.admin,"POST",JSON.stringify({...body,idempotencyKey:`revision-http-next-${invoice.id}`,expectedSourceHash:next.sourceHash,
      lines:[{itemId:result.corrected.items[0].id,quantity:1,unitPrice:"30000"}],expectedRemainingMinor:30000}));
    expect(reduced.status).toBe(201);expect((await reduced.json() as {corrected:{totalMinor:number}}).corrected.totalMinor).toBe(30000);
    expect((await db.query("SELECT id FROM invoices WHERE patient_id=$1 AND status<>'cancelled'",[patientId])).rows).toHaveLength(1);
    expect((await db.query("SELECT id FROM payments WHERE patient_id=$1",[patientId])).rows).toHaveLength(0);
  });
});
