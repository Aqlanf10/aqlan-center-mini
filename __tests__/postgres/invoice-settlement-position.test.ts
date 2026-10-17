import {afterAll,beforeAll,describe,it,expect,vi} from "vitest";
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
  const reports=await import("../../lib/reports");
  const filters=reports.parseFilters(new URLSearchParams({patientId:String(patientId),preset:"custom",from:"2000-01-01",to:today}),today);
  const statement=await reports.buildReport("patient-statement",filters);
  expect(statement.kpis.find(row=>row.key==="balance-SAR")?.minor).toBe(160000);expect(statement.kpis.find(row=>row.key==="balance")?.minor).toBe(-100);
  expect(JSON.stringify(statement.rows)).toContain("إعادة تصنيف تسوية السند");
  const debtReport=await reports.buildReport("debt",filters);expect(debtReport.rows?.find(row=>row.currency==="SAR")).toMatchObject({billedMinor:250000,paidMinor:90000,balanceMinor:160000});
  const {loadDailyClinicReport}=await import("../../lib/daily-clinic-report");
  const daily=await loadDailyClinicReport(today);expect(daily.currentAccounts.find(row=>row.patientId===patientId)?.byCurrency).toMatchObject({SAR:{receivableMinor:160000},YER:{creditMinor:100}});
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
it.each(["replay","receipt","refund"])("serializes a currency correction racing with %s without duplicating settlement",async kind=>{
  const owner=await patient();const original=(await db.createInvoice({patientId:owner,baseCurrency:"YER",discountMinor:0,note:null,createdBy:session.username,items:[{serviceId:null,doctorId:null,description:"Synthetic racing currency",quantity:1,unitPriceMinor:2500}]}))!;
  const paid=await db.recordPayment({patientId:owner,invoiceId:original.id,kind:"payment",amountMinor:90000,currency:"SAR",baseCurrency:"YER",exchangeRate:410,method:"cash",note:null,createdBy:session.username,idempotencyKey:`currency-race-paid-${++serial}`});expect(paid.reason).toBeNull();
  const view=await revision.readInvoiceRevision(original.id,session);
  const command={idempotencyKey:`currency-race-correct-${++serial}`,expectedSourceHash:view.sourceHash,currency:"SAR",reason:"Synthetic currency concurrency",lines:[{itemId:original.items[0].id,quantity:1,unitPrice:"2500"}],discount:"0",repaymentTerms:{mode:"full",installments:[]},expectedRemainingMinor:160000};
  const competing=()=>kind==="replay"?revision.reviseInvoice(original.id,command,session):db.recordPayment({patientId:owner,invoiceId:original.id,kind:kind==="refund"?"refund":"payment",amountMinor:10000,currency:"SAR",baseCurrency:"YER",exchangeRate:410,method:"cash",note:null,createdBy:session.username,idempotencyKey:`currency-race-next-${++serial}`,...(kind==="refund"?{reversalOfId:paid.payment!.id}:{})});
  const results=await Promise.allSettled([revision.reviseInvoice(original.id,command,session),competing()]);
  for(const result of results)if(result.status==="rejected")expect(result.reason).toMatchObject({code:"stale"});
  const edges=await q("SELECT corrected_invoice_id FROM invoice_corrections WHERE patient_id=$1",[owner]);expect(edges.length).toBeLessThanOrEqual(1);
  if(kind==="replay"){expect(edges).toHaveLength(1);expect(results.every(row=>row.status==="fulfilled")).toBe(true);expect((await q("SELECT id FROM invoice_settlement_reclassifications WHERE patient_id=$1",[owner]))).toHaveLength(1);}
  if(edges.length){const ledger=await db.patientLedger(owner),balance=db.ledgerBalancesByCurrency(owner,ledger,new Map());const refundCount=(await q("SELECT id FROM payments WHERE patient_id=$1 AND kind='refund'",[owner])).length;
    expect(balance.SAR.dueMinor).toBe(160000+refundCount*10000);expect(balance.YER.dueMinor).toBe(0);
  }
  expect((await q("SELECT id FROM payments WHERE patient_id=$1 AND kind='payment'",[owner])).length).toBeLessThanOrEqual(kind==="receipt"?2:1);
});
it.each(["collected_cash","invoiced"] as const)("reclassifies unpaid %s commissions with original policy and applies a full refund exactly once",async basis=>{
  const owner=await patient(),doctor=await db.createParty({name:"Synthetic currency commission",kind:"doctor",phone:null,commissionPercent:30,note:null});
  const staff=await db.createStaffUser({username:`currency-doctor-${++serial}`,displayName:"Synthetic commission",passwordHash:"synthetic",role:"doctor",partyId:doctor.id});
  const config={calculationMode:"percentage" as const,defaultPercent:30,categoryRates:{},fixedAmountPerVisitMinor:0,deductLabCost:false,deductMaterialCost:false,basis,effectiveDate:"",rateHistory:[]};
  await db.updateUser(staff.id,{commissionConfig:config},{actor:session.username});
  const unrelatedDoctor=await db.createParty({name:"Synthetic unrelated SAR doctor",kind:"doctor",phone:null,commissionPercent:30,note:null});
  await db.createInvoice({patientId:owner,baseCurrency:"SAR",discountMinor:0,note:null,createdBy:session.username,items:[{serviceId:null,doctorId:unrelatedDoctor.id,description:"Synthetic unrelated SAR invoice",quantity:1,unitPriceMinor:10000}]});
  const original=(await db.createInvoice({patientId:owner,baseCurrency:"YER",discountMinor:0,note:null,createdBy:session.username,items:[{serviceId:null,doctorId:doctor.id,description:"Synthetic currency commission",quantity:1,unitPriceMinor:2500}]}))!;
  const paid=await db.recordPayment({patientId:owner,invoiceId:original.id,kind:"payment",amountMinor:90000,currency:"SAR",baseCurrency:"YER",exchangeRate:410,method:"cash",note:null,createdBy:session.username,idempotencyKey:`currency-full-paid-${++serial}`});expect(paid.reason).toBeNull();
  await db.updateUser(staff.id,{commissionConfig:{...config,defaultPercent:60}},{actor:session.username});
  const view=await revision.readInvoiceRevision(original.id,session),command={idempotencyKey:`currency-full-correct-${++serial}`,expectedSourceHash:view.sourceHash,currency:"SAR",reason:"Synthetic currency commission correction",lines:[{itemId:original.items[0].id,quantity:1,unitPrice:"2500"}],discount:"0",repaymentTerms:{mode:"full",installments:[]},expectedRemainingMinor:160000};
  await expect(revision.reviseInvoice(original.id,command,{...session,role:"cashier"})).rejects.toMatchObject({code:"unauthorized"});
  await revision.reviseInvoice(original.id,command,session);
  const rows=await db.commissionReport("2000-01-01","2099-12-31");expect(rows.find(row=>row.doctorId===doctor.id&&row.currency==="SAR")).toMatchObject({earnedMinor:basis==="invoiced"?75000:27000});
  expect(rows.find(row=>row.doctorId===unrelatedDoctor.id&&row.currency==="SAR")?.earnedMinor??0).toBe(0);
  expect(rows.find(row=>row.doctorId===doctor.id&&row.currency==="YER")?.earnedMinor??0).toBe(0);
  const request={patientId:owner,invoiceId:original.id,kind:"refund" as const,amountMinor:90000,currency:"SAR" as const,baseCurrency:"YER" as const,exchangeRate:410,method:"cash" as const,note:null,createdBy:session.username,reversalOfId:paid.payment!.id,idempotencyKey:`currency-full-refund-${++serial}`};
  expect((await db.recordPayment(request)).reason).toBeNull();expect((await db.recordPayment(request)).reason).toBeNull();
  expect(db.ledgerBalancesByCurrency(owner,await db.patientLedger(owner),new Map()).SAR.dueMinor).toBe(260000);
  expect((await q("SELECT e.id FROM invoice_settlement_reclassification_events e JOIN payments p ON p.id=e.payment_id WHERE p.patient_id=$1 AND e.direction=-1",[owner]))).toHaveLength(1);
  expect((await db.commissionReport("2000-01-01","2099-12-31")).find(row=>row.doctorId===doctor.id&&row.currency==="SAR")?.earnedMinor??0).toBe(basis==="invoiced"?75000:0);
});
it("keeps pre-correction report and commission cutoffs in YER and records today's noncash change in SAR",async()=>{
  const owner=await patient(),doctor=await db.createParty({name:"Synthetic historical commission",kind:"doctor",phone:null,commissionPercent:30,note:null});
  const [original]=await q("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by,created_at) VALUES($1,$2,2500,0,'YER',$3,'2020-01-10T09:00:00Z') RETURNING id",[`CURRENCY-HISTORY-${++serial}`,owner,session.username]);
  const [item]=await q("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor,doctor_id) VALUES($1,'Synthetic dated item',1,2500,2500,$2) RETURNING id",[original.id,doctor.id]);
  const shift=(await q("SELECT id FROM cashier_shifts WHERE status='open' LIMIT 1"))[0].id;
  await q("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by,created_at) VALUES($1,$2,$3,$4,'payment',90000,'SAR',410,369000,'YER','cash',$5,'2020-01-11T09:00:00Z')",[`CURRENCY-HISTORY-P-${++serial}`,owner,original.id,shift,session.username]);
  const view=await revision.readInvoiceRevision(original.id,session);
  await revision.reviseInvoice(original.id,{idempotencyKey:`currency-history-${++serial}`,expectedSourceHash:view.sourceHash,currency:"SAR",reason:"Synthetic historical currency correction",lines:[{itemId:item.id,quantity:1,unitPrice:"2500"}],discount:"0",repaymentTerms:{mode:"full",installments:[]},expectedRemainingMinor:160000},session);
  const reports=await import("../../lib/reports");
  const filters=reports.parseFilters(new URLSearchParams({patientId:String(owner),preset:"custom",from:"2020-01-01",to:"2020-01-31"}),"2020-01-31");
  const statement=await reports.buildReport("patient-statement",filters);
  expect(statement.kpis.find(row=>row.key==="balance")?.minor).toBe(2500-369000);
  expect(statement.kpis.find(row=>row.key==="balance-SAR")?.minor??0).toBe(0);
  expect(JSON.stringify(statement.rows)).not.toContain("إعادة تصنيف تسوية السند");
  const oldCommissions=await db.commissionReport("2020-01-01","2020-01-31");
  expect(oldCommissions.find(row=>row.doctorId===doctor.id&&row.currency==="YER")).toMatchObject({earnedMinor:750});
  expect(oldCommissions.find(row=>row.doctorId===doctor.id&&row.currency==="SAR")?.earnedMinor??0).toBe(0);
});
it("serializes receipt correction against currency correction without a deadlock or duplicate allocation",async()=>{
 const owner=await patient(),original=await invoice(owner);
 const paid=await db.recordPayment({patientId:owner,invoiceId:original.id,kind:"payment",amountMinor:90000,currency:"SAR",baseCurrency:"YER",exchangeRate:410,method:"cash",note:null,createdBy:session.username,idempotencyKey:`currency-race-receipt-${++serial}`});expect(paid.reason).toBeNull();
 const view=await revision.readInvoiceRevision(original.id,session);
 const command={idempotencyKey:`currency-race-invoice-${++serial}`,expectedSourceHash:view.sourceHash,currency:"SAR",reason:"Synthetic receipt correction race",lines:[{itemId:original.items[0].id,quantity:1,unitPrice:"2500"}],discount:"0",repaymentTerms:{mode:"full",installments:[]},expectedRemainingMinor:160000};
 const results=await Promise.allSettled([revision.reviseInvoice(original.id,command,session),db.correctPayment({paymentId:paid.payment!.id,reason:"Synthetic receipt race",actor:session.username,actorRole:"admin",idempotencyKey:`currency-race-replacement-${++serial}`,replacement:{amountMinor:70000,currency:"SAR",exchangeRate:410,method:"cash",target:{kind:"original"}}})]);
 for(const result of results)if(result.status==="rejected")expect(result.reason).toMatchObject({code:"stale"});
 expect(results[1].status).toBe("fulfilled");if(results[1].status==="fulfilled")expect(results[1].value).toMatchObject({reason:null});
 const documents=await q("SELECT id FROM invoice_settlement_reclassifications WHERE patient_id=$1",[owner]);
 const balance=db.ledgerBalancesByCurrency(owner,await db.patientLedger(owner),new Map());
 if(documents.length)expect(balance.SAR.dueMinor).toBe(180000);else expect(balance.YER.dueMinor).toBe(1000-287000);
 expect((await q("SELECT id FROM payments WHERE patient_id=$1",[owner]))).toHaveLength(3);
});
it("refuses currency correction in a locked period and after a paid commission without changing receipts",async()=>{
 const owner=await patient(),doctor=await db.createParty({name:"Synthetic blocked currency",kind:"doctor",phone:null,commissionPercent:30,note:null});
 const original=(await db.createInvoice({patientId:owner,baseCurrency:"YER",discountMinor:0,note:null,createdBy:session.username,items:[{serviceId:null,doctorId:doctor.id,description:"Synthetic blocked correction",quantity:1,unitPriceMinor:2500}]}))!;
 const paid=await db.recordPayment({patientId:owner,invoiceId:original.id,kind:"payment",amountMinor:90000,currency:"SAR",baseCurrency:"YER",exchangeRate:410,method:"cash",note:null,createdBy:session.username,idempotencyKey:`currency-block-paid-${++serial}`});expect(paid.reason).toBeNull();
 const before=await footprint(owner),view=await revision.readInvoiceRevision(original.id,session);
 const command={idempotencyKey:`currency-block-${++serial}`,expectedSourceHash:view.sourceHash,currency:"SAR",reason:"Synthetic blocked currency correction",lines:[{itemId:original.items[0].id,quantity:1,unitPrice:"2500"}],discount:"0",repaymentTerms:{mode:"full",installments:[]},expectedRemainingMinor:160000};
 await q("INSERT INTO settings(key,value) VALUES('finance.locked_before','2099-01-01') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
 try{await expect(revision.reviseInvoice(original.id,command,session)).rejects.toThrow(/مقفلة/);}finally{await q("DELETE FROM settings WHERE key='finance.locked_before'");}
 const shift=(await q("SELECT id FROM cashier_shifts WHERE status='open' LIMIT 1"))[0].id;
 await q("INSERT INTO expenses(voucher_number,category,party_id,shift_id,amount_minor,currency,base_amount_minor) VALUES($1,'commission',$2,$3,100,'YER',100)",[`CURRENCY-EXPENSE-${++serial}`,doctor.id,shift]);
 const blocked=await revision.readInvoiceRevision(original.id,session);expect(blocked.currencyCorrection).toMatchObject({available:false});expect(blocked.currencyCorrection?.message).toMatch(/عمولات/);
 await expect(revision.reviseInvoice(original.id,{...command,expectedSourceHash:blocked.sourceHash},session)).rejects.toThrow(/عمولات/);
 expect(await footprint(owner)).toEqual(before);expect(await q("SELECT id FROM invoice_corrections WHERE patient_id=$1",[owner])).toEqual([]);
});
it("rolls back a partially written currency correction by destroying a connection whose rollback failed",async()=>{
 const original=await invoice(),view=await revision.readInvoiceRevision(original.id,session);
 const command={idempotencyKey:`currency-rollback-${++serial}`,expectedSourceHash:view.sourceHash,currency:"SAR",reason:"Synthetic injected correction failure",lines:[{itemId:original.items[0].id,quantity:1,unitPrice:"2500"}],discount:"0",repaymentTerms:{mode:"full",installments:[]},expectedRemainingMinor:250000};
 const pool=db.getPool(),client=await pool.connect(),query=client.query.bind(client),failure=new Error("Synthetic document insert failure");
 const spy=vi.spyOn(client,"query").mockImplementation((...args:Parameters<typeof client.query>)=>{
  if(String(args[0]).includes("INSERT INTO invoice_settlement_reclassifications("))return Promise.reject(failure);
  if(args[0]==="ROLLBACK")return Promise.reject(new Error("Synthetic rollback transport failure"));
  return query(...args);
 }),release=vi.spyOn(client,"release"),connect=vi.spyOn(pool,"connect").mockResolvedValueOnce(client);
 try{await expect(revision.reviseInvoice(original.id,command,session)).rejects.toBe(failure);expect(release).toHaveBeenCalledWith(true);}
 finally{connect.mockRestore();spy.mockRestore();release.mockRestore();}
 expect((await db.getInvoice(original.id))?.status).not.toBe("cancelled");
 expect(await q("SELECT id FROM invoice_corrections WHERE patient_id=$1",[original.patientId])).toEqual([]);
 expect(await q("SELECT id FROM invoice_settlement_reclassifications WHERE patient_id=$1",[original.patientId])).toEqual([]);
 expect(await q("SELECT id FROM invoices WHERE patient_id=$1",[original.patientId])).toEqual([{id:original.id}]);
 await expect(revision.reviseInvoice(original.id,command,session)).resolves.toMatchObject({currency:"SAR",remainingMinor:250000});
});
