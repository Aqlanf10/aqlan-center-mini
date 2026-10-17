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
  it("refuses an old unstructured replacement instead of silently dropping its original receipt",async()=>{
    const original=await invoice();await payment(original.patientId,original.id,400);
    const changed=await db.correctInvoice({invoiceId:original.id,lines:[{itemId:original.items[0].id,quantity:1,unitPriceMinor:900}],reason:"Synthetic legacy correction without structured lineage",actor:session.username,actorRole:"admin"});
    if(!changed.ok)throw new Error("Fixture legacy correction");
    const before=await footprint(original.patientId);
    await expect(read(original.patientId,changed.corrected.id)).rejects.toMatchObject({code:"invalid"});
    expect(await footprint(original.patientId)).toEqual(before);
    expect((await q("SELECT invoice_id FROM payments WHERE patient_id=$1",[original.patientId]))).toEqual([{invoice_id:original.id}]);
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
it("corrects the issued partially paid synthetic 2500 YER invoice to 2500 SAR through the canonical writer",async()=>{
  const patientId=await patient();
  const original=(await db.createInvoice({patientId,baseCurrency:"YER",discountMinor:0,note:null,createdBy:session.username,items:[{serviceId:null,doctorId:null,description:"Synthetic currency correction",quantity:1,unitPriceMinor:2500}]}))!;
  const shift=(await q("SELECT id FROM cashier_shifts WHERE status='open' ORDER BY id LIMIT 1"))[0].id;
  for(const amount of [70000,10000,10000])await q("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by) VALUES($1,$2,$3,$4,'payment',$5,'SAR',410,$6,'YER','cash',$7)",[`SYN-CURRENCY-${++serial}`,patientId,original.id,shift,amount,amount/100*410,session.username]);
  await q("INSERT INTO payments(receipt_number,patient_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by) VALUES($1,$2,$3,'payment',100,'YER',1,100,'YER','cash',$4)",[`SYN-CURRENCY-${++serial}`,patientId,shift,session.username]);
  const before=await footprint(patientId),view=await revision.readInvoiceRevision(original.id,session);
  expect(view.currencyCorrection).toMatchObject({available:true,settledMinor:90000,accountDueMinor:0});
  const request={idempotencyKey:`currency-writer-${++serial}`,expectedSourceHash:view.sourceHash,currency:"SAR",reason:"Synthetic incorrect original currency",lines:[{itemId:original.items[0].id,quantity:1,unitPrice:"2500"}],discount:"0",discountReason:null,repaymentTerms:{mode:"full",installments:[]},expectedRemainingMinor:160000};
  const receipt=await revision.reviseInvoice(original.id,request,session);
  expect(receipt).toMatchObject({currency:"SAR",settledMinor:90000,remainingMinor:160000,accountDueMinor:160000});
  const corrected=(receipt as {corrected:{id:number}}).corrected;
  const client=await db.getPool().connect();try{expect(await readInvoiceSettlementPosition(client,{patientId,invoiceId:corrected.id,currency:"SAR"})).toMatchObject({settledMinor:90000,remainingMinor:160000});}finally{client.release();}
  const ledger=await db.patientLedger(patientId);
  const balances=db.ledgerBalancesByCurrency(patientId,ledger,new Map());
  expect(balances.SAR.dueMinor).toBe(160000);expect(balances.YER.dueMinor).toBe(-100);
  const rows=await db.computeDebtRows([patientId],true);expect(rows.find(row=>row.currency==="SAR")?.dueMinor).toBe(160000);expect(rows.find(row=>row.currency==="YER")?.dueMinor).toBe(-100);
  expect(await revision.reviseInvoice(original.id,request,session)).toMatchObject({replayed:true,settledMinor:90000,remainingMinor:160000});
  expect(await footprint(patientId)).toEqual(before);
  const [visit]=await q("INSERT INTO visits(patient_name,patient_id,invoice_id) VALUES('Synthetic currency walkout',$1,$2) RETURNING id",[patientId,corrected.id]);
  const walkout=await db.visitWalkout(visit.id);expect(walkout?.checkout.current).toMatchObject({SAR:160000,YER:-100});expect(walkout?.checkout.invoicePaidMinor).toBe(90000);
  const {clinicDateString}=await import("../../lib/schedule");const today=clinicDateString(new Date(),db.CLINIC_TIME_ZONE);
  const entries=await db.journalEntries("2000-01-01",today);
  const refs=new Set([original.invoiceNumber,(await db.getInvoice(corrected.id))!.invoiceNumber,...before.map(row=>row.value.receipt_number)]);
  const owned=entries.filter(entry=>refs.has(entry.reference)||entry.reference===`ISR-${(receipt as {reclassificationId:number}).reclassificationId}/${original.invoiceNumber}`||entry.reference.startsWith(`ISR-${(receipt as {reclassificationId:number}).reclassificationId}/P-`));
  const ar={YER:0,SAR:0};for(const entry of owned)for(const line of entry.lines)if(line.accountCode==="1201"&&(line.currency==="YER"||line.currency==="SAR"))ar[line.currency]+=(line.side==="debit"?1:-1)*line.amountMinor;
  expect(ar).toEqual({YER:-100,SAR:160000});
  const adjustments=owned.filter(entry=>entry.source==="invoice-settlement-reclassification");expect(adjustments).toHaveLength(3);expect(adjustments.flatMap(entry=>entry.lines).every(line=>!["1101","1102"].includes(line.accountCode))).toBe(true);
  const paidId=before[0].value.id;
  const refund=await db.recordPayment({patientId,invoiceId:original.id,kind:"refund",amountMinor:5000,currency:"SAR",baseCurrency:"YER",exchangeRate:410,method:"cash",note:null,createdBy:session.username,reversalOfId:paidId,idempotencyKey:`currency-refund-${++serial}`});expect(refund.reason).toBeNull();
  const afterRefund=db.ledgerBalancesByCurrency(patientId,await db.patientLedger(patientId),new Map());expect(afterRefund.SAR.dueMinor).toBe(165000);expect(afterRefund.YER.dueMinor).toBe(-100);
  const correction=await db.correctPayment({paymentId:paidId,reason:"Synthetic receipt correction after allocation",actor:session.username,actorRole:"admin",idempotencyKey:`currency-receipt-correction-${++serial}`,replacement:{amountMinor:65000,currency:"SAR",exchangeRate:410,method:"cash",target:{kind:"original"}}});
  expect(correction.reason).toBeNull();if(correction.reason===null)expect(correction.replacement?.invoiceId).toBe(corrected.id);
  expect(db.ledgerBalancesByCurrency(patientId,await db.patientLedger(patientId),new Map()).SAR.dueMinor).toBe(165000);
});
