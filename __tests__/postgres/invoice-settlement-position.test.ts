import {afterAll,beforeAll,describe,it,expect} from "vitest";
import {assertRealPostgresUrl,dropPublicSchema,stubPostgresEnv} from "./_setup";
import {readInvoiceSettlementPosition} from "../../lib/invoice-settlement-position";
import type {SessionPayload} from "../../lib/auth";
assertRealPostgresUrl();stubPostgresEnv();
const db=await import("../../lib/db"),auth=await import("../../lib/auth"),revision=await import("../../lib/invoice-revision-db"),debt=await import("../../lib/debt-installments-db");
let session:SessionPayload,serial=0;
const q=async(sql:string,values:unknown[]=[]) => (await db.getPool().query(sql,values)).rows;
beforeAll(async()=>{await dropPublicSchema(process.env.DATABASE_URL!);await db.ensureSchema();
  const password=await auth.hashPassword("synthetic-settlement-reader");const [user]=await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('settlement-reader-owner','Synthetic settlement owner',$1,'admin',TRUE) RETURNING id",[password]);
  session={userId:user.id,username:"settlement-reader-owner",role:"admin",expiresAt:Date.now()+3600000,credentialVersion:auth.sessionCredentialVersion(password)};
  await db.openShift({openedBy:session.username,opening:{YER:0,SAR:0,USD:0}});
},180000);
afterAll(async()=>{await db.resetPoolForTesting();});
async function patient(){return (await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic settlement reader') RETURNING id",[`SETTLE-${++serial}`]))[0].id as number;}
async function invoice(patientId=0){const owner=patientId||await patient();return (await db.createInvoice({patientId:owner,baseCurrency:"YER",discountMinor:0,note:null,createdBy:session.username,
  items:[{serviceId:null,doctorId:null,description:"Synthetic settlement invoice",quantity:1,unitPriceMinor:1000}]}))!;}
async function payment(patientId:number,invoiceId:number,amountMinor:number,reversalOfId?:number){
  const result=await db.recordPayment({patientId,invoiceId,kind:reversalOfId?"refund":"payment",amountMinor,currency:"YER",baseCurrency:"YER",exchangeRate:1,method:"cash",note:null,createdBy:session.username,reversalOfId,idempotencyKey:`settlement-payment-${++serial}`});
  expect(result.reason).toBeNull();return result.payment!;
}
async function correct(invoiceId:number,amount:number){const view=await revision.readInvoiceRevision(invoiceId,session);
  const result=await revision.reviseInvoice(invoiceId,{idempotencyKey:`settlement-correction-${++serial}`,expectedSourceHash:view.sourceHash,reason:"Synthetic settlement correction",
    lines:view.invoice.items.map(item=>({itemId:item.id,quantity:1,unitPrice:String(amount)})),discount:"0",discountReason:null,repaymentTerms:{mode:"full",installments:[]},expectedRemainingMinor:Math.max(0,amount-view.settledMinor)},session);
  if(!("corrected" in result)||!result.corrected)throw new Error("Expected full correction acknowledgement");
  return {...result,corrected:result.corrected};
}
async function read(patientId:number,invoiceId:number){const client=await db.getPool().connect();try{await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");const result=await readInvoiceSettlementPosition(client,{patientId,invoiceId,currency:"YER"});await client.query("COMMIT");return result;}finally{await client.query("ROLLBACK").catch(()=>undefined);client.release();}}
async function footprint(patientId:number){return q("SELECT to_jsonb(p) AS value FROM payments p WHERE patient_id=$1 ORDER BY id",[patientId]);}
describe("one scoped settlement/proof across immutable invoice corrections",()=>{
  it("carries original payment and earlier/later refunds through two corrections without changing any payment target",async()=>{
    const original=await invoice(),paid=await payment(original.patientId,original.id,400);await payment(original.patientId,original.id,100,paid.id);
    const first=await correct(original.id,900),before=await read(original.patientId,first.corrected!.id);
    expect(before).toMatchObject({principalMinor:900,settledMinor:300,remainingMinor:600,lineageInvoiceIds:[original.id,first.corrected!.id]});
    const second=await correct(first.corrected!.id,800),current=second.corrected!.id,after=await read(original.patientId,current);
    expect(after).toMatchObject({principalMinor:800,settledMinor:300,remainingMinor:500});expect(after.proofHash).not.toBe(before.proofHash);
    await payment(original.patientId,current,100);const collected=await read(original.patientId,current);expect(collected).toMatchObject({settledMinor:400,remainingMinor:400});
    await payment(original.patientId,original.id,50,paid.id);const refunded=await read(original.patientId,current);
    expect(refunded).toMatchObject({settledMinor:350,remainingMinor:450});expect(refunded.proofHash).not.toBe(collected.proofHash);
    const snapshot=await footprint(original.patientId);expect((await q("SELECT invoice_id FROM payments WHERE id=$1",[paid.id]))[0].invoice_id).toBe(original.id);
    expect(await read(original.patientId,current)).toEqual(refunded);expect(await footprint(original.patientId)).toEqual(snapshot);
    const client=await db.getPool().connect();try{expect(await debt.readDebtPosition(client,{patientId:original.patientId,invoiceId:current,currency:"YER",openingCurrency:null})).toMatchObject({settledMinor:350,remainingMinor:450,settlementProofHash:refunded.proofHash});}finally{client.release();}
  });
  it("changes proof when a refund consumes credit even though the invoice remains settled",async()=>{
    const original=await invoice(),paid=await payment(original.patientId,original.id,1000),changed=await correct(original.id,900);
    const before=await read(original.patientId,changed.corrected!.id);expect(before).toMatchObject({settledMinor:1000,remainingMinor:0,creditMinor:100});
    await payment(original.patientId,original.id,100,paid.id);const after=await read(original.patientId,changed.corrected!.id);
    expect(after).toMatchObject({settledMinor:900,remainingMinor:0,creditMinor:0});expect(after.proofHash).not.toBe(before.proofHash);
    const unrelated=await invoice(original.patientId);await payment(original.patientId,unrelated.id,200);
    expect(await read(original.patientId,changed.corrected!.id)).toEqual(after);
  });
  it("includes a later imported original-reference receipt in the proof without moving or creating money during reads",async()=>{
    const original=await invoice();await payment(original.patientId,original.id,400);const changed=await correct(original.id,900),before=await read(original.patientId,changed.corrected!.id);
    // A synthetic bank/import receipt retains its historical document reference.
    // New interactive collection targets the active invoice; this tests the reader's import boundary.
    const shift=(await q("SELECT id FROM cashier_shifts WHERE status='open'"))[0].id;
    const [late]=await q("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by) VALUES($1,$2,$3,$4,'payment',100,'YER',1,100,'YER','transfer','synthetic-bank-import') RETURNING id",[`SYN-BANK-${++serial}`,original.patientId,original.id,shift]);
    const stored=await footprint(original.patientId),after=await read(original.patientId,changed.corrected!.id);
    expect(after).toMatchObject({settledMinor:500,remainingMinor:400});expect(after.proofHash).not.toBe(before.proofHash);expect(after.paymentIds).toContain(late.id);
    expect(await footprint(original.patientId)).toEqual(stored);expect((await q("SELECT invoice_id FROM payments WHERE id=$1",[late.id]))[0].invoice_id).toBe(original.id);
  });
  it.each(["patient","currency","edge-patient","edge-currency","live-ancestor","cycle"])("refuses an imported mismatched %s lineage rather than borrowing another scope",async fault=>{
    const original=await invoice();await payment(original.patientId,original.id,400);const changed=await correct(original.id,900),other=await patient(),client=await db.getPool().connect();
    try{await client.query("BEGIN");await client.query("SET LOCAL session_replication_role='replica'");
      if(fault==="patient")await client.query("UPDATE invoices SET patient_id=$2 WHERE id=$1",[original.id,other]);
      else if(fault==="currency")await client.query("UPDATE invoices SET base_currency='SAR' WHERE id=$1",[original.id]);
      else if(fault==="edge-patient")await client.query("UPDATE invoice_corrections SET patient_id=$2 WHERE original_invoice_id=$1",[original.id,other]);
      else if(fault==="edge-currency")await client.query("UPDATE invoice_corrections SET currency='SAR' WHERE original_invoice_id=$1",[original.id]);
      else if(fault==="live-ancestor")await client.query("UPDATE invoices SET status='open' WHERE id=$1",[original.id]);
      else await client.query("INSERT INTO invoice_corrections(patient_id,currency,original_invoice_id,corrected_invoice_id,idempotency_key,request_hash,reason,created_by) VALUES($1,'YER',$2,$3,$4,$5,'Synthetic corrupt cycle',$6)",[original.patientId,changed.corrected!.id,original.id,`synthetic-cycle-${++serial}`,"0".repeat(64),session.username]);
      await expect(readInvoiceSettlementPosition(client,{patientId:original.patientId,invoiceId:changed.corrected!.id,currency:"YER"})).rejects.toThrow(/المريض|عملة|عملتها|مراجعة/);
    }finally{await client.query("ROLLBACK");client.release();}
    expect(await read(original.patientId,changed.corrected!.id)).toMatchObject({settledMinor:400,remainingMinor:500});
  });
  it("refuses a foreign patient receipt forged onto an otherwise valid owned invoice",async()=>{
    const original=await invoice(),receipt=await payment(original.patientId,original.id,400),other=await patient(),client=await db.getPool().connect();
    try{await client.query("BEGIN");await client.query("SET LOCAL session_replication_role='replica'");await client.query("UPDATE payments SET patient_id=$2 WHERE id=$1",[receipt.id,other]);
      await expect(readInvoiceSettlementPosition(client,{patientId:original.patientId,invoiceId:original.id,currency:"YER"})).rejects.toThrow(/مراجعة/);
    }finally{await client.query("ROLLBACK");client.release();}
  });
  it("binds the proof to receipt changes even when a new payment and refund leave the settled total unchanged",async()=>{
    const original=await invoice(),paid=await payment(original.patientId,original.id,400),before=await revision.readInvoiceRevision(original.id,session);
    const request={idempotencyKey:`settlement-neutral-${++serial}`,expectedSourceHash:before.sourceHash,reason:"Synthetic neutral-proof correction",lines:before.invoice.items.map(item=>({itemId:item.id,quantity:1,unitPrice:"900"})),discount:"0",discountReason:null,repaymentTerms:{mode:"full",installments:[]},expectedRemainingMinor:500};
    await payment(original.patientId,original.id,100);await payment(original.patientId,original.id,100,paid.id);
    const after=await revision.readInvoiceRevision(original.id,session);expect(after.settledMinor).toBe(before.settledMinor);expect(after.sourceHash).not.toBe(before.sourceHash);
    await expect(revision.reviseInvoice(original.id,request,session)).rejects.toMatchObject({code:"stale"});
    expect((await q("SELECT count(*)::int AS n FROM invoice_corrections WHERE patient_id=$1",[original.patientId]))[0].n).toBe(0);
  });
  it("refuses a foreign-to-foreign currency receipt and wrong requested ownership without a guessed conversion",async()=>{
    const original=await invoice(),receipt=await payment(original.patientId,original.id,400),client=await db.getPool().connect();
    try{await client.query("BEGIN");await client.query("SET LOCAL session_replication_role='replica'");
      await client.query("UPDATE invoices SET base_currency='SAR' WHERE id=$1",[original.id]);await client.query("UPDATE payments SET currency='USD' WHERE id=$1",[receipt.id]);
      await expect(readInvoiceSettlementPosition(client,{patientId:original.patientId,invoiceId:original.id,currency:"SAR"})).rejects.toMatchObject({code:"invalid"});
      await expect(readInvoiceSettlementPosition(client,{patientId:await patient(),invoiceId:original.id,currency:"SAR"})).rejects.toMatchObject({code:"missing"});
    }finally{await client.query("ROLLBACK");client.release();}
  });
});
