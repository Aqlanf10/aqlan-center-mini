import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {Client} from "pg";
import {baseUrl,harness} from "./_server";

/** Synthetic patient/shift only. Tests real HTTP, database receipts and native
 * no-write rejection; does not inspect or mutate Production/Railway patients. */
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
function post(body:Record<string,unknown>,key:string){
  return fetch(`${baseUrl}/api/payments`,{method:"POST",headers:{
    Cookie:ctx.sessions.admin.cookie,"Content-Type":"application/json","Idempotency-Key":key,
  },body:JSON.stringify(body)});
}
async function count(amountMinor:number){
  const r=await db.query<{n:number}>(`SELECT COUNT(*)::int AS n FROM payments
    WHERE patient_id=$1 AND kind='payment' AND amount_minor=$2 AND currency='YER'`,
  [ctx.seeded.patientAId,amountMinor]);return r.rows[0].n;
}
describe("similar-collection warning has no financial side effects",()=>{
  it("warns on an independent second request, allows deliberate confirmation, replays same key",async()=>{
    // Deliberately unusual amount to avoid seeded fixture overlap.
    const amount="71593",minor=71593;
    const intent={patientId:ctx.seeded.patientAId,kind:"payment",amount,currency:"YER",method:"cash"};
    const preview=await fetch(`${baseUrl}/api/payments/similar?patientId=${ctx.seeded.patientAId}&amountMinor=${minor}&currency=YER`,{
      headers:{Cookie:ctx.sessions.admin.cookie},cache:"no-store"});
    expect(preview.status).toBe(200);
    const initial=await preview.json() as {receipts:{id:number}[]};
    expect(initial.receipts).toHaveLength(0);
    const before=await count(minor);
    const firstBody={...intent,similarityReview:{observedReceiptIds:[],confirmed:false}};
    const first=await post(firstBody,"similar:test:first:20261022");
    expect(first.status).toBe(201);
    const firstReceipt=await first.json() as {id:number;receiptNumber:string};
    expect(firstReceipt.id).toBeGreaterThan(0);
    expect(await count(minor)).toBe(before+1);

    const stale=await post(firstBody,"similar:test:second:20261022");
    expect(stale.status).toBe(409);
    expect((await stale.json() as {reason:string}).reason).toBe("similar_collection_review_required");
    expect(await count(minor)).toBe(before+1);

    const checked=await fetch(`${baseUrl}/api/payments/similar?patientId=${ctx.seeded.patientAId}&amountMinor=${minor}&currency=YER`,{
      headers:{Cookie:ctx.sessions.admin.cookie},cache:"no-store"});
    const matches=await checked.json() as {receipts:{id:number;receiptNumber:string}[]};
    expect(matches.receipts.map(r=>r.id)).toContain(firstReceipt.id);
    const secondBody={...intent,similarityReview:{observedReceiptIds:matches.receipts.map(r=>r.id),confirmed:true}};
    const second=await post(secondBody,"similar:test:second:20261022");
    expect(second.status).toBe(201);
    const secondReceipt=await second.json() as {id:number};
    expect(secondReceipt.id).not.toBe(firstReceipt.id);
    expect(await count(minor)).toBe(before+2);

    // Replaying the exact second operation after the match-set changed must not
    // create a third receipt or block recovery with an unrelated warning.
    const replay=await post(secondBody,"similar:test:second:20261022");
    expect(replay.status).toBe(200);
    expect((await replay.json() as {id:number}).id).toBe(secondReceipt.id);
    expect(await count(minor)).toBe(before+2);
  },120000);
  it("does not leak another patient's collection information without collection rights",async()=>{
    const res=await fetch(`${baseUrl}/api/payments/similar?patientId=${ctx.seeded.patientAId}&amountMinor=100&currency=YER`,{cache:"no-store"});
    expect(res.status).toBe(401);
  });
});
