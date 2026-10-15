import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {Pool} from "pg";
import {loadMigrationFiles,migrate} from "../../lib/migrations";
import {LEGACY_TREATMENT_DOCUMENT_SQL} from "../../lib/legacy-treatment-document-schema";
import {prepareBackupSql} from "../../lib/restore/sql.mjs";
import {assertRealPostgresUrl,dropPublicSchema,stubPostgresEnv,createIsolatedDatabase,adminClient} from "./_setup";
import type {SessionPayload} from "../../lib/auth";
import type {HistoricalDocumentReceipt} from "../../lib/legacy-treatment-document";
assertRealPostgresUrl();stubPostgresEnv();
const db=await import("../../lib/db"),auth=await import("../../lib/auth");
const documents=await import("../../lib/legacy-treatment-document-db");
const schedules=await import("../../lib/debt-installments-db");
const collection=await import("../../lib/debt-installment-collection");
const legacySchedules=await import("../../lib/legacy-balance-arrangements-db");
let session:SessionPayload;let endo:number;let ortho:number;let serial=0;
const q=async(sql:string,values:unknown[]=[]) => (await db.getPool().query(sql,values)).rows;
beforeAll(async()=>{
  await dropPublicSchema(process.env.DATABASE_URL!);await db.ensureSchema();
  const hash=await auth.hashPassword("synthetic-mixed-historical");const id=(await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('mixed-history-owner','Synthetic mixed history',$1,'admin',TRUE) RETURNING id",[hash]))[0].id;
  session={userId:id,username:"mixed-history-owner",role:"admin",credentialVersion:auth.sessionCredentialVersion(hash),expiresAt:Date.now()+3_600_000};
  endo=(await q("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('Synthetic historical root canal','rct',55000,TRUE,TRUE) RETURNING id"))[0].id;
  ortho=(await q("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('Synthetic historical orthodontics','ortho',210000,TRUE,TRUE) RETURNING id"))[0].id;
  await db.openShift({openedBy:session.username,opening:{YER:0,SAR:0,USD:0}});
  await q("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
},180000);
afterAll(async()=>{await db.resetPoolForTesting();});
const terms=(amount:number)=>amount?{mode:"installments",installments:[{dueDate:"2026-11-12",amountMinor:amount,kind:"installment"}]}:{mode:"full",installments:[]};
async function command(){
  const patientId=(await q("INSERT INTO patients(patient_number,full_name,birth_date) VALUES($1,'Synthetic mixed agreement','1990-01-01') RETURNING id",[`HIST-DOC-${++serial}`]))[0].id;
  return {patientId,currency:"YER",items:[{serviceId:endo,quantity:1,price:"55000",catalogPriceMinor:55000,toothCode:16},{serviceId:endo,quantity:1,price:"55000",catalogPriceMinor:55000,toothCode:17},{serviceId:ortho,quantity:1,price:"210000",catalogPriceMinor:210000,scope:"both"}],discount:"20000",discountReason:"Synthetic historical discount",previouslyPaidAmount:"120000",historicalAsOf:"2026-10-01",note:null,
    idempotencyKey:`historical-document-${serial}`,repaymentTerms:terms(180000),repaymentRemainingMinor:180000,repaymentVersion:0,repaymentSourceHash:null as string|null};
}
async function counts(patientId:number){return (await q(`SELECT
  (SELECT count(*)::int FROM invoices WHERE patient_id=$1) AS invoices,
  (SELECT count(*)::int FROM payments WHERE patient_id=$1) AS payments,
  (SELECT count(*)::int FROM clinical_cases WHERE patient_id=$1) AS cases,
  (SELECT count(*)::int FROM treatment_plans WHERE patient_id=$1) AS plans,
  (SELECT count(*)::int FROM plan_items WHERE plan_id IN(SELECT id FROM treatment_plans WHERE patient_id=$1)) AS items,
  (SELECT count(*)::int FROM legacy_treatment_documents WHERE patient_id=$1) AS documents,
  (SELECT count(*)::int FROM legacy_treatment_agreements WHERE patient_id=$1) AS agreements,
  (SELECT count(*)::int FROM patient_opening_balances WHERE patient_id=$1) AS openings`,[patientId]))[0];}
async function correction(document:HistoricalDocumentReceipt,paid="130000"){
  const [view]=await documents.listHistoricalDocuments(document.patientId);
  const remaining=view.openingRemainingMinor+document.previouslyPaidMinor-Number(paid);
  return {idempotencyKey:`historical-correction-${++serial}`,expectedVersion:document.version,expectedSourceHash:view.sourceHash,
    prices:document.lines.map(line=>String(line.unitPriceMinor)),discount:String(document.discountMinor),discountReason:document.discountReason,
    previouslyPaidAmount:paid,historicalAsOf:document.historicalAsOf,note:document.note,reason:"Corrected documented historical facts",
    repaymentTerms:terms(remaining),repaymentRemainingMinor:remaining,repaymentVersion:view.scheduleVersion};
}

describe("one heterogeneous historical document, one canonical opening bucket",()=>{
  it("atomically saves2teeth+grouped orthodontics as300000/120000/180000 with exact discount proof and no fake invoice/receipt",async()=>{
    const source=await command();const preview=await documents.previewHistoricalDocument(source.patientId,source,session);
    expect(preview).toMatchObject({remainingMinor:180000,accountDueMinor:180000,openingPrincipalMinor:180000,sourceHash:null,scheduleVersion:0});
    expect(preview.lines).toHaveLength(3);
    expect(await counts(source.patientId)).toEqual({invoices:0,payments:0,cases:0,plans:0,items:0,documents:0,agreements:0,openings:0});
    const saved=await documents.createHistoricalDocument(source.patientId,source,session);
    expect(saved.document).toMatchObject({agreedMinor:300000,previouslyPaidMinor:120000,remainingMinor:180000,discountMinor:20000,version:1,currency:"YER"});
    expect(saved.document.lines.map(line=>line.discountMinor)).toEqual([3438,3437,13125]);
    expect(await counts(source.patientId)).toEqual({invoices:0,payments:0,cases:3,plans:1,items:3,documents:1,agreements:3,openings:1});
    expect(await q("SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id=$1",[source.patientId])).toEqual([{amount_minor:"180000"}]);
    expect(await q("SELECT previously_paid_minor,remaining_minor FROM legacy_treatment_agreements WHERE patient_id=$1",[source.patientId])).toEqual(Array(3).fill({previously_paid_minor:null,remaining_minor:null}));
    expect((await schedules.listDebtRepayments(source.patientId,"2026-10-12"))[0]).toMatchObject({remainingMinor:180000,target:{patientId:source.patientId,currency:"YER",openingCurrency:"YER",invoiceId:null}});
    expect(new Set(saved.document.lines.map(line=>line.planId)).size).toBe(1);
    expect(saved.document.lines.map(line=>line.site)).toMatchObject([{toothCode:16},{toothCode:17},{scope:"both"}]);
  });
  it("same-command concurrent submissions replay one complete saved acknowledgement after catalogue changes",async()=>{
    const source=await command();const results=await Promise.all([documents.createHistoricalDocument(source.patientId,source,session),documents.createHistoricalDocument(source.patientId,source,session)]);
    expect(results.map(result=>result.replayed).sort()).toEqual([false,true]);expect(results[0].document).toEqual(results[1].document);
    await q("UPDATE services SET price_minor=55001 WHERE id=$1",[endo]);
    try{expect(await documents.createHistoricalDocument(source.patientId,source,session)).toEqual({document:results[0].document,replayed:true});}
    finally{await q("UPDATE services SET price_minor=55000 WHERE id=$1",[endo]);}
    expect(await counts(source.patientId)).toMatchObject({documents:1,items:3,openings:1});
    await expect(documents.createHistoricalDocument(source.patientId,{...source,note:"different intent"},session)).rejects.toMatchObject({code:"conflict"});
  });
  it("rolls earlier clinical lines back when a later line is rejected",async()=>{
    const other=await command();const foreign=await documents.createHistoricalDocument(other.patientId,other,session);
    const draft=await command();const source={...draft,items:draft.items.map((line,index)=>index===2?{...line,caseId:foreign.document.lines[2].caseId}:line)};
    await expect(documents.createHistoricalDocument(source.patientId,source,session)).rejects.toMatchObject({code:"conflict"});
    expect(await counts(source.patientId)).toEqual({invoices:0,payments:0,cases:0,plans:0,items:0,documents:0,agreements:0,openings:0});
  });
  it("refuses an unowned manual opening without partial clinical or financial writes",async()=>{
    const source=await command();await q("INSERT INTO patient_opening_balances(patient_id,currency,amount_minor,as_of_date,created_by) VALUES($1,'YER',25000,'2026-09-01','synthetic-manual')",[source.patientId]);
    await expect(documents.previewHistoricalDocument(source.patientId,source,session)).rejects.toMatchObject({code:"conflict"});
    await expect(documents.createHistoricalDocument(source.patientId,source,session)).rejects.toMatchObject({code:"conflict"});
    expect(await counts(source.patientId)).toMatchObject({documents:0,items:0,cases:0,openings:1});
    expect(await q("SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id=$1",[source.patientId])).toEqual([{amount_minor:"25000"}]);
  });
  it("accepts separate upper and lower jaw groups of one service but rejects overlapping groups atomically",async()=>{
    const draft=await command();
    const source={...draft,items:["upper","lower"].map(scope=>({serviceId:ortho,quantity:1,price:"210000",catalogPriceMinor:210000,scope})),repaymentRemainingMinor:280000,repaymentTerms:terms(280000)};
    const saved=await documents.createHistoricalDocument(source.patientId,source,session);
    expect(saved.document.lines.map(line=>line.site.scope)).toEqual(["upper","lower"]);
    expect(new Set(saved.document.lines.map(line=>line.caseId)).size).toBe(2);
    expect(await counts(source.patientId)).toMatchObject({invoices:0,payments:0,documents:1,items:2,cases:2});
    const overlap={...await command(),items:source.items.map((line,index)=>({...line,scope:index===0?"both":"upper"})),repaymentRemainingMinor:280000,repaymentTerms:terms(280000)};
    await expect(documents.createHistoricalDocument(overlap.patientId,overlap,session)).rejects.toMatchObject({code:"conflict"});
    expect(await counts(overlap.patientId)).toMatchObject({documents:0,items:0,cases:0,openings:0});
  });
  it("records fully paid earlier work without changing an existing opening date or its audited amount",async()=>{
    const first=await command();await documents.createHistoricalDocument(first.patientId,first,session);
    const before=await q("SELECT to_jsonb(b) AS value FROM patient_opening_balances b WHERE patient_id=$1",[first.patientId]);
    const history=await q("SELECT to_jsonb(h) AS value FROM patient_opening_balance_history h WHERE patient_id=$1 ORDER BY id",[first.patientId]);
    const next={...first,items:[{serviceId:endo,quantity:1,price:"55000",catalogPriceMinor:55000,toothCode:26}],discount:"0",discountReason:null,previouslyPaidAmount:"55000",historicalAsOf:"2026-09-01",idempotencyKey:`historical-fully-paid-${++serial}`};
    const preview=await documents.previewHistoricalDocument(first.patientId,next,session);
    const saved=await documents.createHistoricalDocument(first.patientId,{...next,repaymentRemainingMinor:preview.remainingMinor,repaymentVersion:preview.scheduleVersion,repaymentSourceHash:preview.sourceHash},session);
    expect(saved.document).toMatchObject({remainingMinor:0,historicalAsOf:"2026-09-01"});
    expect(await q("SELECT to_jsonb(b) AS value FROM patient_opening_balances b WHERE patient_id=$1",[first.patientId])).toEqual(before);
    expect(await q("SELECT to_jsonb(h) AS value FROM patient_opening_balance_history h WHERE patient_id=$1 ORDER BY id",[first.patientId])).toEqual(history);
    expect(await counts(first.patientId)).toMatchObject({invoices:0,payments:0,documents:2,openings:1});
  });
  it("keeps historical evidence readable after a manual opening correction while refusing further historical writes",async()=>{
    const source=await command();const {document}=await documents.createHistoricalDocument(source.patientId,source,session);
    const change=await correction(document);
    await db.setPatientOpeningBalance({patientId:source.patientId,currency:"YER",amountMinor:190000,asOfDate:"2026-10-01",note:"Synthetic external reconciliation",createdBy:session.username,reason:"External reconciliation"});
    const [view]=await documents.listHistoricalDocuments(source.patientId);
    expect(view).toMatchObject({id:document.id,version:1,openingRemainingMinor:190000,correctionAvailable:false});
    expect(view.history).toHaveLength(1);
    await expect(documents.correctHistoricalDocument(source.patientId,document.id,change,session)).rejects.toMatchObject({code:"conflict"});
    expect(await counts(source.patientId)).toMatchObject({documents:1,items:3,invoices:0,payments:0});
  });
  it("adds a second document to the whole opening bucket and supersedes its single schedule with explicit aggregate terms",async()=>{
    const first=await command();await documents.createHistoricalDocument(first.patientId,first,session);
    const second={...first,items:[{serviceId:endo,quantity:1,price:"55000",catalogPriceMinor:55000,toothCode:26}],discount:"0",discountReason:null,previouslyPaidAmount:"5000",idempotencyKey:`historical-second-${++serial}`};
    const preview=await documents.previewHistoricalDocument(first.patientId,second,session);
    expect(preview).toMatchObject({remainingMinor:230000,accountDueMinor:230000,scheduleVersion:1});
    await expect(documents.createHistoricalDocument(first.patientId,second,session)).rejects.toMatchObject({code:"stale"});
    const reviewed={...second,repaymentVersion:preview.scheduleVersion,repaymentSourceHash:preview.sourceHash,repaymentRemainingMinor:preview.remainingMinor,repaymentTerms:terms(preview.remainingMinor)};
    await documents.createHistoricalDocument(first.patientId,reviewed,session);
    expect((await schedules.listDebtRepayments(first.patientId,"2026-10-12"))).toHaveLength(1);
    expect((await schedules.listDebtRepayments(first.patientId,"2026-10-12"))[0]).toMatchObject({version:2,remainingMinor:230000});
    expect(await counts(first.patientId)).toMatchObject({invoices:0,payments:0,documents:2,items:4,openings:1});
  });
  it("fully historically paid mixed work creates identities but no opening or schedule or cash",async()=>{
    const source={...await command(),previouslyPaidAmount:"300000",repaymentRemainingMinor:0,repaymentTerms:terms(0)};
    const saved=await documents.createHistoricalDocument(source.patientId,source,session);
    expect(saved.document).toMatchObject({remainingMinor:0,repayment:null});
    expect(await counts(source.patientId)).toMatchObject({invoices:0,payments:0,openings:0,documents:1,items:3});
    expect(await schedules.listDebtRepayments(source.patientId,"2026-10-12")).toEqual([]);
  });
  it("appends a correction preserving original lineage and receipts; displays current account remaining after collection",async()=>{
    const source=await command();const first=await documents.createHistoricalDocument(source.patientId,source,session);const document=first.document;
    await collection.collectDebtInstallment({patientId:source.patientId,arrangementId:document.repayment!.arrangementId,amountMinor:20000,idempotencyKey:`historical-collection-${++serial}`,currency:"YER",expectedVersion:1,method:"cash",note:null,session});
    const before=await q("SELECT row_to_json(p) AS value FROM payments p WHERE patient_id=$1",[source.patientId]);
    const corrected=await documents.correctHistoricalDocument(source.patientId,document.id,await correction(document),session);
    expect(corrected.document).toMatchObject({version:2,remainingMinor:170000,previouslyPaidMinor:130000});
    expect(corrected.document.lines).toEqual(document.lines);
    expect(await q("SELECT row_to_json(p) AS value FROM payments p WHERE patient_id=$1",[source.patientId])).toEqual(before);
    expect((await documents.listHistoricalDocuments(source.patientId))[0]).toMatchObject({version:2,remainingMinor:170000,openingRemainingMinor:150000,accountDueMinor:150000,scheduleVersion:2});
    expect(await counts(source.patientId)).toMatchObject({invoices:0,payments:1,documents:1,items:3,cases:3});
    expect((await documents.createHistoricalDocument(source.patientId,source,session)).document).toEqual(document);
  });
  it("corrects the last unpaid opening to zero by clearing it and cancelling its dates, retaining both versions",async()=>{
    const source=await command();const {document}=await documents.createHistoricalDocument(source.patientId,source,session);
    const change=await correction(document,"300000");
    const saved=await documents.correctHistoricalDocument(source.patientId,document.id,change,session);
    expect(saved.document).toMatchObject({version:2,remainingMinor:0,previouslyPaidMinor:300000});
    expect(await counts(source.patientId)).toMatchObject({payments:0,invoices:0,openings:0,documents:1,items:3});
    expect((await schedules.listDebtRepayments(source.patientId,"2026-10-12"))[0]).toMatchObject({version:2,status:"cancelled",remainingMinor:0});
    expect((await documents.listHistoricalDocuments(source.patientId))[0]).toMatchObject({version:2,accountDueMinor:0,history:[{version:1},{version:2}]});
    expect(await documents.correctHistoricalDocument(source.patientId,document.id,change,session)).toEqual({...saved,replayed:true});
  });
  it("keeps collected receipts and exposes credit after an authorized historical reduction without a cash refund",async()=>{
    const source=await command();const {document}=await documents.createHistoricalDocument(source.patientId,source,session);
    await collection.collectDebtInstallment({patientId:source.patientId,arrangementId:document.repayment!.arrangementId,amountMinor:20000,idempotencyKey:`historical-lower-${++serial}`,currency:"YER",expectedVersion:1,method:"cash",note:null,session});
    const originalReceipts=await q("SELECT to_jsonb(p) AS value FROM payments p WHERE patient_id=$1",[source.patientId]);
    const change={...await correction(document,"290000"),repaymentRemainingMinor:0,repaymentTerms:terms(0)};
    const saved=await documents.correctHistoricalDocument(source.patientId,document.id,change,session);
    expect((await documents.listHistoricalDocuments(source.patientId))[0]).toMatchObject({version:2,openingPrincipalMinor:10000,openingCollectedMinor:20000,openingRemainingMinor:0,accountDueMinor:-10000});
    expect(await q("SELECT to_jsonb(p) AS value FROM payments p WHERE patient_id=$1",[source.patientId])).toEqual(originalReceipts);
    expect(await counts(source.patientId)).toMatchObject({invoices:0,payments:1,documents:1,items:3});
    expect(await documents.correctHistoricalDocument(source.patientId,document.id,change,session)).toEqual({...saved,replayed:true});
    expect((await schedules.listDebtRepayments(source.patientId,"2026-10-14"))[0]).toMatchObject({status:"cancelled",remainingMinor:0});
  });
  it("recalculates the owned opening date from current positive document versions",async()=>{
    const source=await command();const {document}=await documents.createHistoricalDocument(source.patientId,source,session);
    const change={...await correction(document,"120000"),historicalAsOf:"2026-10-10"};
    await documents.correctHistoricalDocument(source.patientId,document.id,change,session);
    expect(await q("SELECT as_of_date::text FROM patient_opening_balances WHERE patient_id=$1",[source.patientId])).toEqual([{as_of_date:"2026-10-10"}]);
    const first=(await documents.listHistoricalDocuments(source.patientId))[0];
    const next={...source,items:[{serviceId:endo,quantity:1,price:"55000",catalogPriceMinor:55000,toothCode:26}],discount:"0",discountReason:null,previouslyPaidAmount:"0",historicalAsOf:"2026-09-01",idempotencyKey:`date-second-${++serial}`,
      repaymentSourceHash:first.sourceHash,repaymentVersion:first.scheduleVersion,repaymentRemainingMinor:235000,repaymentTerms:terms(235000)};
    const second=await documents.createHistoricalDocument(source.patientId,next,session);
    expect(await q("SELECT as_of_date::text FROM patient_opening_balances WHERE patient_id=$1",[source.patientId])).toEqual([{as_of_date:"2026-09-01"}]);
    const [secondView]= (await documents.listHistoricalDocuments(source.patientId)).filter(row=>row.id===second.document.id);
    await documents.correctHistoricalDocument(source.patientId,second.document.id,{...await correction(second.document,"0"),expectedSourceHash:secondView.sourceHash,repaymentVersion:secondView.scheduleVersion,
      historicalAsOf:"2026-10-12",repaymentRemainingMinor:235000,repaymentTerms:terms(235000)},session);
    expect(await q("SELECT as_of_date::text FROM patient_opening_balances WHERE patient_id=$1",[source.patientId])).toEqual([{as_of_date:"2026-10-10"}]);
    expect(await counts(source.patientId)).toMatchObject({invoices:0,payments:0,documents:2});
  });
  it("reopens a cleared historical opening with the reviewed date and a new schedule version",async()=>{
    const source=await command();const {document}=await documents.createHistoricalDocument(source.patientId,source,session);
    const cleared=await documents.correctHistoricalDocument(source.patientId,document.id,await correction(document,"300000"),session);
    const input=await correction(cleared.document,"120000");
    const saved=await documents.correctHistoricalDocument(source.patientId,document.id,input,session);
    expect(saved.document).toMatchObject({version:3,remainingMinor:180000,repayment:{version:3}});
    expect(await q("SELECT amount_minor::text,as_of_date::text FROM patient_opening_balances WHERE patient_id=$1",[source.patientId])).toEqual([{amount_minor:"180000",as_of_date:source.historicalAsOf}]);
    expect(await counts(source.patientId)).toMatchObject({invoices:0,payments:0,documents:1,items:3,openings:1});
  });
  it("different concurrent corrections serialize and the stale version cannot append a second revision",async()=>{
    const source=await command();const {document}=await documents.createHistoricalDocument(source.patientId,source,session);
    const change=await correction(document);const result=await Promise.allSettled([documents.correctHistoricalDocument(source.patientId,document.id,change,session),documents.correctHistoricalDocument(source.patientId,document.id,{...change,idempotencyKey:`historical-race-${++serial}`},session)]);
    expect(result.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect(result.filter(result=>result.status==="rejected")).toHaveLength(1);
    expect((await documents.listHistoricalDocuments(source.patientId))[0]).toMatchObject({version:2,openingRemainingMinor:170000});
  });
  it("retains old/new schedule exclusivity and refuses to allocate an unrelated old receipt",async()=>{
    const source=await command();const {document}=await documents.createHistoricalDocument(source.patientId,source,session);
    expect(await legacySchedules.createLegacyBalanceArrangement({patientId:source.patientId,currency:"YER",cadence:"monthly",installmentMinor:50000,firstDueDate:"2026-10-12",note:null,createdBy:session.username,today:"2026-10-12"})).toMatchObject({ok:false,reason:"already_active"});
    expect(document.repayment).not.toBeNull();
    const second=await command();await db.recordPayment({patientId:second.patientId,invoiceId:null,amountMinor:1000,currency:"YER",baseCurrency:"YER",exchangeRate:1,kind:"payment",method:"cash",note:null,createdBy:session.username,idempotencyKey:`unallocated-history-${++serial}`});
    await expect(documents.createHistoricalDocument(second.patientId,second,session)).rejects.toMatchObject({code:"conflict"});
    expect(await counts(second.patientId)).toMatchObject({payments:1,documents:0,items:0,openings:0});
  });
  it("checks current session and denies doctor/cashier/accountant and revoked replay",async()=>{
    const source=await command();await documents.createHistoricalDocument(source.patientId,source,session);
    for(const role of ["doctor","cashier","accountant"] as const)await expect(documents.createHistoricalDocument(source.patientId,source,{...session,role})).rejects.toMatchObject({code:"unauthorized"});
    await q("UPDATE users SET is_active=FALSE WHERE id=$1",[session.userId]);
    try{await expect(documents.createHistoricalDocument(source.patientId,source,session)).rejects.toMatchObject({code:"unauthorized"});}
    finally{await q("UPDATE users SET is_active=TRUE WHERE id=$1",[session.userId]);}
    expect(await counts(source.patientId)).toMatchObject({documents:1,items:3});
  });
  it("protects immutable document/revisions and forbids a per-line void that would hide aggregate debt",async()=>{
    const source=await command();const {document}=await documents.createHistoricalDocument(source.patientId,source,session);
    await expect(q("UPDATE legacy_treatment_documents SET currency='SAR' WHERE id=$1",[document.id])).rejects.toThrow(/append-only/);
    await expect(q("UPDATE legacy_treatment_document_revisions SET previously_paid_minor=0 WHERE document_id=$1",[document.id])).rejects.toThrow();
    await expect(q("UPDATE legacy_treatment_agreements SET status='void',voided_at=NOW(),voided_by='synthetic',void_reason='direct void rejected' WHERE id=$1",[document.lines[0].agreementId])).rejects.toThrow(/document correction/);
    const legacy=await import("../../lib/legacy-treatment-db");
    expect(await legacy.getLegacyVoidPreview({patientId:source.patientId,agreementId:document.lines[0].agreementId,actor:session.username,actorRole:session.role})).toMatchObject({ok:false,reason:"document_correction_required"});
  });
  it("0060 matches bootstrap and canonical backup restores complete lines before ordered immutable revisions",async()=>{
    expect(readFileSync("migrations/0060_historical_treatment_documents.sql","utf8")).toBe(LEGACY_TREATMENT_DOCUMENT_SQL);
    const files=await loadMigrationFiles();expect(files.map(file=>file.filename)).toEqual(expect.arrayContaining(["0059_invoice_debt_installments.sql","0060_historical_treatment_documents.sql"]));
    const tables=["legacy_treatment_documents","legacy_treatment_agreements","legacy_treatment_coverage_snapshots","legacy_treatment_document_revisions","debt_repayment_revisions","payments"];
    const before=await Promise.all(tables.map(table=>q(`SELECT to_jsonb(t) AS facts FROM ${table} t ORDER BY ${table==="legacy_treatment_coverage_snapshots"?"agreement_id":"id"}`)));
    const chunks:string[]=[];for await(const chunk of db.backupSnapshotSqlLines(db.getPool()))chunks.push(chunk);const sql=chunks.join("");
    expect(sql.indexOf("-- legacy_treatment_document_revisions (")).toBeGreaterThan(sql.indexOf("-- legacy_treatment_coverage_snapshots ("));
    const name="aqlan_historical_document_restore_test";const restored=new Pool({connectionString:await createIsolatedDatabase(name),ssl:false});
    try{
      await migrate(restored as unknown as Parameters<typeof migrate>[0],{apply:true,files});
      const registry=(await restored.query("SELECT to_jsonb(m)::text AS facts FROM schema_migrations m ORDER BY version")).rows;
      await restored.query(prepareBackupSql(sql).sql);
      expect((await restored.query("SELECT to_jsonb(m)::text AS facts FROM schema_migrations m ORDER BY version")).rows).toEqual(registry);
      for(const [index,table] of tables.entries())expect((await restored.query(`SELECT to_jsonb(t) AS facts FROM ${table} t ORDER BY ${table==="legacy_treatment_coverage_snapshots"?"agreement_id":"id"}`)).rows).toEqual(before[index]);
    }finally{await restored.end();const admin=adminClient("postgres");await admin.connect();try{await admin.query(`DROP DATABASE ${name} WITH(FORCE)`);}finally{await admin.end();}}
  },120000);

});


describe("daily close reads unified historical document facts once", () => {
  it.each(["YER", "SAR", "USD"] as const)("keeps %s header corrections, line coverage and real opening receipts distinct", async currency => {
    const {toInputAmount} = await import("../../lib/money");
    const {loadDailyClinicReport,getDailyClinicReportToday} = await import("../../lib/daily-clinic-report");
    await q("UPDATE services SET price_sar_minor=price_minor,price_usd_minor=price_minor WHERE id=ANY($1::int[])", [[endo,ortho]]);
    const source = {...await command(),currency};
    source.items = source.items.map(line => ({...line,price:toInputAmount(line.catalogPriceMinor,currency)}));
    source.discount=toInputAmount(20000,currency);source.previouslyPaidAmount=toInputAmount(120000,currency);
    const {document} = await documents.createHistoricalDocument(source.patientId,source,session);
    await db.addVisit({patientId:source.patientId,patientName:"Synthetic mixed agreement",patientPhone:null,note:null});
    let report = await loadDailyClinicReport(getDailyClinicReportToday());
    expect(report.historicalDocuments?.filter(row=>row.patientId===source.patientId)).toEqual([expect.objectContaining({
      id:document.id,currency,version:1,agreedMinor:300000,previouslyPaidMinor:120000,remainingAtStartMinor:180000,
      lines:document.lines.map(line=>expect.objectContaining({agreementId:line.agreementId,planItemId:line.planItemId,caseId:line.caseId,coverageState:"verified"})),
    })]);
    expect(report.legacyAgreements.filter(row=>row.patientId===source.patientId)).toEqual([]);
    expect((await db.recordPayment({patientId:source.patientId,openingCurrency:currency,invoiceId:null,planId:null,amountMinor:20000,currency,baseCurrency:"YER",exchangeRate:currency==="YER"?1:currency==="SAR"?140:530,kind:"payment",method:"cash",note:null,createdBy:session.username})).reason).toBeNull();
    const correctionSource=await correction(document,"130000");
    correctionSource.prices=document.lines.map(line=>toInputAmount(line.unitPriceMinor,currency));
    correctionSource.discount=toInputAmount(document.discountMinor,currency);correctionSource.previouslyPaidAmount=toInputAmount(130000,currency);
    const corrected=await documents.correctHistoricalDocument(source.patientId,document.id,correctionSource,session);
    expect(corrected.document.version).toBe(2);
    const footprint=async()=>({counts:await counts(source.patientId),revisions:await q("SELECT to_jsonb(r) AS value FROM legacy_treatment_document_revisions r WHERE document_id=$1 ORDER BY version",[document.id]),payments:await q("SELECT to_jsonb(p) AS value FROM payments p WHERE patient_id=$1 ORDER BY id",[source.patientId])});
    const before=await footprint(); report=await loadDailyClinicReport(getDailyClinicReportToday());expect(await footprint()).toEqual(before);
    expect(report.historicalDocuments?.filter(row=>row.id===document.id)).toEqual([expect.objectContaining({version:2,currency,agreedMinor:300000,previouslyPaidMinor:130000,remainingAtStartMinor:170000})]);
    expect(report.currentAccounts.find(row=>row.patientId===source.patientId)?.byCurrency[currency].receivableMinor).toBe(150000);
    expect(report.receipts.filter(row=>row.patientId===source.patientId)).toEqual([expect.objectContaining({tenderMinor:20000,openingCurrency:currency,invoiceId:null})]);
    expect(await q("SELECT previously_paid_minor::text FROM legacy_treatment_document_revisions WHERE document_id=$1 ORDER BY version",[document.id])).toEqual([{previously_paid_minor:"120000"},{previously_paid_minor:"130000"}]);
    expect((await counts(source.patientId)).invoices).toBe(0);
  });
});
