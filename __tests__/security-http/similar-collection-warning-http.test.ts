import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {Client} from "pg";
import {baseUrl,harness} from "./_server";

/** Built app, synthetic patient/shift only. The advisory review is answered inside the writer
 * transaction: a 409 proves nothing was written; confirmation reuses the same key and body. */
let ctx:Awaited<ReturnType<typeof harness>>;
let db:Client;
beforeAll(async()=>{
  ctx=await harness();
  db=new Client({connectionString:ctx.seeded.dbUrl,ssl:false});
  await db.connect();
  await db.query(`INSERT INTO cashier_shifts (opened_by,opening_yer,opening_sar,opening_usd)
    SELECT 'similar-receipt-fixture',0,0,0
    WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status='open')`);
},240000);
afterAll(async()=>{await db?.end();});
function post(body:Record<string,unknown>,key:string,review?:string,cookie:string|null=ctx.sessions.admin.cookie){
  return fetch(`${baseUrl}/api/payments`,{method:"POST",headers:{
    ...(cookie?{Cookie:cookie}:{}),"Content-Type":"application/json","Idempotency-Key":key,Origin:baseUrl,"Sec-Fetch-Site":"same-origin",
    ...(review!==undefined?{"x-collection-similarity-review":review}:{}),
  },body:JSON.stringify(body)});
}
async function count(amountMinor:number){
  const r=await db.query<{n:number}>(`SELECT COUNT(*)::int AS n FROM payments
    WHERE patient_id=$1 AND kind='payment' AND amount_minor=$2 AND currency='YER'`,
  [ctx.seeded.patientAId,amountMinor]);return r.rows[0].n;
}
describe("similar-collection review over HTTP has no financial side effects",()=>{
  it("asks on an independent second request, records on deliberate confirmation, replays the same key",async()=>{
    // Deliberately unusual amount to avoid seeded fixture overlap.
    const minor=71593;
    const intent={patientId:ctx.seeded.patientAId,kind:"payment",amount:"71593",currency:"YER",method:"cash"};
    const before=await count(minor);
    const first=await post(intent,"similar:http:first:20261022");
    expect(first.status).toBe(201);
    const firstReceipt=await first.json() as {id:number;receiptNumber:string};
    expect(await count(minor)).toBe(before+1);

    const asked=await post(intent,"similar:http:second:20261022","none");
    expect(asked.status).toBe(409);
    const refusal=await asked.json() as {reason:string;message:string;windowHours:number;receipts:{id:number;receiptNumber:string}[]};
    expect(refusal).toMatchObject({reason:"similar_collection_review_required",windowHours:24});
    expect(refusal.message).toMatch(/[؀-ۿ]/);
    expect(refusal.receipts.map(r=>r.id)).toEqual([firstReceipt.id]);
    expect(await count(minor)).toBe(before+1);

    const confirmed=await post(intent,"similar:http:second:20261022",`ids:${firstReceipt.id}`);
    expect(confirmed.status).toBe(201);
    const secondReceipt=await confirmed.json() as {id:number};
    expect(secondReceipt.id).not.toBe(firstReceipt.id);
    expect(await count(minor)).toBe(before+2);

    // The exact second operation replays even though the similar set changed and no header is sent.
    const replay=await post(intent,"similar:http:second:20261022");
    expect(replay.status).toBe(200);
    expect((await replay.json() as {id:number}).id).toBe(secondReceipt.id);
    expect(await count(minor)).toBe(before+2);
  },120000);
  it("never reveals receipts to an unauthenticated caller",async()=>{
    const res=await post({patientId:ctx.seeded.patientAId,kind:"payment",amount:"71593",currency:"YER",method:"cash"},"similar:http:anon:20261022",undefined,null);
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("receipts");
  });
});
