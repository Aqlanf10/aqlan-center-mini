import { getPool, PLAN_ITEM_PREBILLED_SQL, PLAN_ITEM_LEGACY_COVERED_SQL, PLAN_ITEM_FINANCIAL_REVIEW_SQL,
  PLAN_ITEM_LEGACY_CONTEXT_SQL, usesSharedLocalDatabaseConnection, type DbClient, type DbPool } from "./db";
import { withFinancialReadSnapshot } from "./financial-read-snapshot";
import { legacyCoverageContains, legacyCoverageStateFromContext } from "./legacy-treatment-coverage";
import { validateLineSite } from "./invoice-clinical-linkage";
import { validVisitHistoricalDocument } from "./visit-historical-document-read";
import { projectVisitFinancialContext, type VisitSource, type VisitFinancialWork, type VisitFinancialContext } from "./visit-financial-context";

type Runner = DbClient | DbPool;
const work = (kind: VisitFinancialWork["kind"], id: number): VisitFinancialWork => ({ key: `${kind}:${id}`, kind, id,
  references: [], coverage: "unresolved", decision: "none", reasons: [] });

/** Exact owned documentary reference only. Never find another invoice for the patient. */
async function invoiceReference(db: Runner, id: number, patientId: number | null, path: string, cache: ReadCache): Promise<VisitSource | null> {
  const key = `${patientId}:${id}`;
  if (cache.invoices.has(key)) { const source=cache.invoices.get(key); return source ? {...source,path} : null; }
  const { rows: [row] } = await db.query<{status:string}>("SELECT status FROM invoices WHERE id=$1 AND patient_id=$2",[id,patientId]);
  const source: VisitSource | null = row ? { kind:"invoice", id, state:row.status === "cancelled" ? "historical" : "current", path } : null;
  cache.invoices.set(key,source);
  return source;
}

async function loadItemEvidence(db: Runner, itemId: number, patientId: number | null, line: VisitFinancialWork, cache: ReadCache) {
  const { rows: [item] } = await db.query<{
    id:number; plan_id:number; status:string; plan_status:string; billed_invoice_id:number|null; origin_invoice_id:number|null;
    prebilled:boolean; legacy_covered:boolean; financial_review:boolean; legacy_context:unknown;
    category:string|null; tooth_code:number|null; surfaces:string|null;
  }>(`SELECT i.id,i.plan_id,i.status,t.status AS plan_status,i.billed_invoice_id,i.origin_invoice_id,i.category,i.tooth_code,i.surfaces,
    ${PLAN_ITEM_PREBILLED_SQL} AS prebilled,${PLAN_ITEM_LEGACY_COVERED_SQL} AS legacy_covered,
    ${PLAN_ITEM_FINANCIAL_REVIEW_SQL} AS financial_review,${PLAN_ITEM_LEGACY_CONTEXT_SQL} AS legacy_context
    FROM plan_items i JOIN treatment_plans t ON t.id=i.plan_id
    WHERE i.id=$1 AND t.patient_id=$2 AND (i.case_id IS NULL OR EXISTS(
      SELECT 1 FROM clinical_cases c WHERE c.id=i.case_id AND c.patient_id=t.patient_id))`,[itemId,patientId]);
  if (!item) { line.reasons.push("plan_item_owner_unverified"); return; }
  if (item.financial_review || item.status === "cancelled" || item.plan_status === "cancelled") line.reasons.push("plan_source_needs_review");
  for (const id of new Set([item.billed_invoice_id,item.origin_invoice_id].filter((id):id is number=>id!==null))) {
    const reference = await invoiceReference(db,id,patientId,"plan_item",cache);
    if (reference) line.references.push(reference); else line.reasons.push("invoice_owner_unverified");
  }
  const { rows: agreements } = await db.query<{id:number;status:string;document_id:number|null}>(
    "SELECT id,status,document_id FROM legacy_treatment_agreements WHERE plan_item_id=$1 AND patient_id=$2 ORDER BY id",[itemId,patientId]);
  let legacyValid = false;
  for (const agreement of agreements) {
    const documentValid = agreement.document_id === null || patientId !== null && await documentEvidence(db,patientId,agreement.document_id,cache);
    const legacyState=legacyCoverageStateFromContext(item.legacy_context);
    const site=validateLineSite({category:item.category,toothCode:item.tooth_code,surfaces:item.surfaces});
    const valid = item.legacy_covered && site.ok && legacyCoverageContains(legacyState,site.site) && documentValid && agreement.status === "live";
    line.references.push({kind:"historical_agreement",id:agreement.id,state:valid ? "current" : agreement.status === "void" ? "historical" : "review",path:"plan_item"});
    legacyValid ||= valid;
    if (!valid) line.reasons.push("historical_source_needs_review");
  }
  // Approval terms may record item IDs, but membership alone does not validate the current backing source.
  // Leave this documentary path unresolved; do not reconstruct coverage from plan/opening amounts.
  const {rows: principals} = await db.query<{id:number}>(
    "SELECT ap.plan_id AS id FROM approved_agreement_principals ap JOIN treatment_plans t ON t.id=ap.plan_id WHERE ap.plan_id=$1 AND ap.patient_id=$2 AND t.patient_id=$2",
    [item.plan_id,patientId]);
  for(const principal of principals) {
    line.references.push({kind:"approved_agreement",id:principal.id,state:"review",path:"plan_item_plan"});
    line.reasons.push("approved_source_unverified");
  }
  const {rows:[schedule]}=await db.query<{recorded:boolean}>("SELECT EXISTS(SELECT 1 FROM plan_installments WHERE plan_id=$1) AS recorded",[item.plan_id]);
  const sources = Number(item.prebilled) + Number(legacyValid);
  if (sources > 1) line.reasons.push("multiple_financial_sources");
  if (sources === 1 && !line.reasons.length) line.coverage="verified";
  if (!sources && schedule?.recorded) {
    line.references.push({kind:"installment_plan",id:item.plan_id,state:"review",path:"plan_item_plan"});
    line.reasons.push("installment_principal_unverified");
  }
}


/** Caches live only for this caller-supplied snapshot, and include patient identity in every key. */
type ReadCache = {
  invoices: Map<string, VisitSource | null>;
  items: Map<string, VisitFinancialWork>;
  documents: Map<string, boolean>;
};
async function documentEvidence(db: Runner, patientId: number, documentId: number, cache: ReadCache) {
  const key=`${patientId}:${documentId}`;
  if (!cache.documents.has(key)) cache.documents.set(key,await validVisitHistoricalDocument(db,patientId,documentId));
  return cache.documents.get(key)!;
}
async function itemEvidence(db: Runner,itemId:number,patientId:number|null,line:VisitFinancialWork,cache:ReadCache) {
  const key=`${patientId}:${itemId}`;
  if (!cache.items.has(key)) {
    const evidence=work("plan_item",itemId);
    await loadItemEvidence(db,itemId,patientId,evidence,cache);
    cache.items.set(key,evidence);
  }
  const evidence=cache.items.get(key)!;
  line.coverage=evidence.coverage;
  line.reasons.push(...evidence.reasons);
  line.references.push(...evidence.references.map(reference=>({...reference})));
}
type VisitRow={id:number;patient_id:number|null;signed_at:Date|null;invoice_id:number|null;billing_currency:string|null};
type ProcedureRow={id:string;visit_id:number;plan_item_id:number|null;item_matches:boolean};
type SourceLine={procedure_id:string;id:number;status:string;owned:boolean;matches:boolean;denomination_matches:boolean};
type ItemRow={id:number;visit_id:number};
type AdjustmentRow={id:number;visit_id:number;owned:boolean;billing_class:string|null;billing_decision:string|null;billing_decision_reason:string|null;billing_decided_by:string|null;billing_decided_at:Date|null;billing_invoice_id:number|null};
type EndoRow={id:number;visit_id:number;owned:boolean};
function byKey<T>(rows:T[],key:(row:T)=>number):Map<number,T[]> {
  const result=new Map<number,T[]>();
  for(const row of rows){const id=key(row);const group=result.get(id)??[];group.push(row);result.set(id,group);}
  return result;
}
const BATCH_SIZE=200;
/** Bounded round trips for visit-local evidence; no patient-wide financial fallback. */
async function loadBatch(db:Runner,ids:number[],cache:ReadCache) {
  const {rows:visits}=await db.query<VisitRow>("SELECT id,patient_id,signed_at,invoice_id,billing_currency FROM visits WHERE id=ANY($1::int[]) ORDER BY id",[ids]);
  const {rows:procedures}=await db.query<ProcedureRow>(`SELECT p.id::text,p.visit_id,p.plan_item_id,
    (i.id IS NOT NULL AND t.patient_id=v.patient_id AND p.quantity=1
      AND i.service_id=p.service_id AND i.tooth_code IS NOT DISTINCT FROM p.tooth_code
      AND coalesce(i.surfaces,'')=coalesce(p.surfaces,'') AND (i.billed_invoice_id IS NULL OR i.doctor_id IS NOT DISTINCT FROM p.doctor_id)) AS item_matches
    FROM visit_procedures p JOIN visits v ON v.id=p.visit_id
    LEFT JOIN plan_items i ON i.id=p.plan_item_id LEFT JOIN treatment_plans t ON t.id=i.plan_id
    WHERE p.visit_id=ANY($1::int[]) ORDER BY p.id`,[ids]);
  const {rows:items}=await db.query<ItemRow>(`SELECT i.id,i.visit_id FROM plan_items i WHERE i.visit_id=ANY($1::int[]) AND i.status='done'
    UNION SELECT i.id,s.visit_id FROM plan_items i JOIN treatment_sessions s ON s.plan_item_id=i.id
      WHERE s.visit_id=ANY($1::int[]) AND s.status='done'`,[ids]);
  const {rows:adjustments}=await db.query<AdjustmentRow>(`SELECT a.id,a.visit_id,c.patient_id=v.patient_id AS owned,
    a.billing_class,a.billing_decision,a.billing_decision_reason,a.billing_decided_by,a.billing_decided_at,a.billing_invoice_id
    FROM ortho_adjustments a JOIN ortho_cases c ON c.id=a.case_id JOIN visits v ON v.id=a.visit_id
    WHERE a.visit_id=ANY($1::int[]) ORDER BY a.id`,[ids]);
  const {rows:endo}=await db.query<EndoRow>(`SELECT ev.id,ev.visit_id,(t.patient_id=v.patient_id AND c.patient_id=v.patient_id) AS owned
    FROM endo_visits ev JOIN endo_treatments t ON t.id=ev.treatment_id JOIN clinical_cases c ON c.id=t.case_id
    JOIN visits v ON v.id=ev.visit_id WHERE ev.visit_id=ANY($1::int[]) ORDER BY ev.id`,[ids]);
  let sourceLines:SourceLine[]=[];
  if(procedures.length) {
    ({rows:sourceLines}=await db.query<SourceLine>(`WITH RECURSIVE source_items AS (
      SELECT ii.id,ii.source_id AS procedure_id FROM invoice_items ii
        JOIN visit_procedures p ON p.id=ii.source_id AND ii.source_type='visit_procedure'
        WHERE p.visit_id=ANY($1::int[])
      UNION SELECT cl.corrected_item_id,previous.procedure_id FROM source_items previous
        JOIN visit_procedures p ON p.id=previous.procedure_id JOIN visits v ON v.id=p.visit_id
        JOIN invoice_correction_lines cl ON cl.original_item_id=previous.id
        JOIN invoice_corrections correction ON correction.id=cl.correction_id AND correction.patient_id=v.patient_id
          AND correction.currency=COALESCE(correction.original_currency,correction.currency)
        JOIN invoice_items target ON target.id=cl.corrected_item_id AND target.invoice_id=correction.corrected_invoice_id
        JOIN invoice_items original ON original.id=previous.id AND original.invoice_id=correction.original_invoice_id
        JOIN invoices target_invoice ON target_invoice.id=target.invoice_id AND target_invoice.patient_id=v.patient_id
          AND target_invoice.base_currency=correction.currency
        JOIN invoices original_invoice ON original_invoice.id=original.invoice_id AND original_invoice.patient_id=v.patient_id
          AND original_invoice.base_currency=COALESCE(correction.original_currency,correction.currency)
    ) SELECT source.procedure_id::text,inv.id,inv.status,inv.patient_id=v.patient_id AS owned,
      (inv.base_currency IN ('YER','SAR','USD') AND inv.base_currency=CASE
        WHEN p.plan_item_id IS NULL THEN v.billing_currency
        WHEN t.patient_id=v.patient_id THEN t.base_currency ELSE NULL END) AS denomination_matches,
      (ii.service_id=p.service_id AND ii.quantity=p.quantity AND ii.unit_price_minor=p.unit_price_minor
        AND ii.total_minor=p.quantity*p.unit_price_minor AND ii.doctor_id IS NOT DISTINCT FROM p.doctor_id
        AND (ii.plan_item_id IS NULL OR ii.plan_item_id=p.plan_item_id)) AS matches
      FROM source_items source JOIN invoice_items ii ON ii.id=source.id JOIN invoices inv ON inv.id=ii.invoice_id
      JOIN visit_procedures p ON p.id=source.procedure_id JOIN visits v ON v.id=p.visit_id
      LEFT JOIN plan_items i ON i.id=p.plan_item_id LEFT JOIN treatment_plans t ON t.id=i.plan_id ORDER BY p.id,inv.id`,[ids]));
  }
  // Documentary visit/adjustment references are batched too, including negative ownership results.
  const requests=visits.filter(v=>v.invoice_id!==null).map(v=>({id:v.invoice_id!,patientId:v.patient_id}));
  const owners=new Map(visits.map(v=>[v.id,v.patient_id]));
  for(const row of adjustments)if(row.owned&&row.billing_invoice_id!==null)requests.push({id:row.billing_invoice_id,patientId:owners.get(row.visit_id)??null});
  const missing=requests.filter(row=>!cache.invoices.has(`${row.patientId}:${row.id}`));
  if(missing.length){
    const {rows}=await db.query<{id:number;patient_id:number;status:string}>("SELECT id,patient_id,status FROM invoices WHERE id=ANY($1::int[])",[[...new Set(missing.map(row=>row.id))]]);
    const invoices=new Map(rows.map(row=>[row.id,row]));
    for(const request of missing){const row=invoices.get(request.id);cache.invoices.set(`${request.patientId}:${request.id}`,
      row&&row.patient_id===request.patientId?{kind:"invoice",id:row.id,state:row.status==="cancelled"?"historical":"current",path:"visit"}:null);}
  }
  return {visits,procedures:byKey(procedures,row=>row.visit_id),items:byKey(items,row=>row.visit_id),
    adjustments:byKey(adjustments,row=>row.visit_id),endo:byKey(endo,row=>row.visit_id),sourceLines:byKey(sourceLines,row=>Number(row.procedure_id))};
}

async function projectVisit(db:Runner,visit:VisitRow,batch:Awaited<ReturnType<typeof loadBatch>>,cache:ReadCache) {
  const visitId=visit.id;
  const directReference=visit.invoice_id===null?null:await invoiceReference(db,visit.invoice_id,visit.patient_id,"visit",cache);
  const lines:VisitFinancialWork[]=[];
  const representedItems=new Set<number>();
  for(const procedure of batch.procedures.get(visitId)??[]) {
    const id=Number(procedure.id);if(!Number.isSafeInteger(id))throw new Error("Unsafe work identity");
    const line=work("procedure",id);lines.push(line);
    const activeSources=new Set<number>();
    for(const source of batch.sourceLines.get(id)??[]) {
      if(!source.owned){line.reasons.push("invoice_owner_unverified");continue;}
      const matches=source.matches&&source.denomination_matches;
      line.references.push({kind:"invoice",id:source.id,state:source.status==="cancelled"?"historical":matches?"current":"review",path:"visit_procedure"});
      if(source.status!=="cancelled") {
        if(matches)activeSources.add(source.id);
        else line.reasons.push(source.denomination_matches?"invoice_item_identity_conflict":"invoice_denomination_unverified");
      }
    }
    const active=activeSources.size;
    if(active>1)line.reasons.push("multiple_financial_sources");
    if(procedure.plan_item_id!==null) {
      representedItems.add(procedure.plan_item_id);
      if(!procedure.item_matches)line.reasons.push("procedure_plan_identity_conflict");
      else await itemEvidence(db,procedure.plan_item_id,visit.patient_id,line,cache);
    }
    if(active===1&&line.coverage==="verified"&&line.references.some(reference=>
      reference.state==="current"&&(reference.kind!=="invoice"||!activeSources.has(reference.id))))line.reasons.push("multiple_financial_sources");
    if(active===1&&!line.reasons.length)line.coverage="verified";
    if(line.reasons.length)line.coverage="unresolved";
  }
  for(const item of batch.items.get(visitId)??[])if(!representedItems.has(item.id)) {
    const line=work("plan_item",item.id);await itemEvidence(db,item.id,visit.patient_id,line,cache);lines.push(line);
  }
  for(const adjustment of batch.adjustments.get(visitId)??[]) {
    const line=work("orthodontic_adjustment",adjustment.id);lines.push(line);
    if(!adjustment.owned){line.reasons.push("adjustment_owner_unverified");continue;}
    if(adjustment.billing_class)line.recordedClassification=adjustment.billing_class;
    if(adjustment.billing_class==="OUTSIDE_CONTRACT"&&adjustment.billing_decision==="no_charge"&&adjustment.billing_decision_reason?.trim()
      &&adjustment.billing_decided_by&&adjustment.billing_decided_at&&adjustment.billing_invoice_id===null)line.decision="no_charge";
    else if(adjustment.billing_decision==="billed") {
      line.decision="billed";
      const reference=adjustment.billing_invoice_id===null?null:await invoiceReference(db,adjustment.billing_invoice_id,visit.patient_id,"adjustment_decision",cache);
      if(reference)line.references.push(reference);
      line.reasons.push("adjustment_coverage_unverified");
    }else line.reasons.push("adjustment_source_unresolved");
  }
  for(const record of batch.endo.get(visitId)??[]){const line=work("endodontic_record",record.id);line.reasons.push(record.owned?"endo_work_item_not_explicit":"endo_owner_unverified");lines.push(line);}
  for(const line of lines){
    if(!visit.signed_at){line.coverage="unresolved";line.reasons.push("unsigned_work");}
    if(line.coverage==="unresolved"&&line.decision!=="no_charge"&&!line.reasons.length)line.reasons.push("source_not_established");
  }
  return projectVisitFinancialContext({visitId,patientId:visit.patient_id,signed:visit.signed_at!==null,directReference,
    directReferenceState:visit.invoice_id===null?"missing":directReference?.state??"review",work:lines});
}

/** Caller supplies one read-only snapshot. Batch size bounds SQL parameters, never report row count. */
export async function readVisitFinancialContexts(db:Runner,bindings:readonly {visitId:number;expectedPatientId?:number|null}[]) {
  const requested=new Map<number,number|null|undefined>();
  for(const binding of bindings){
    if(!Number.isSafeInteger(binding.visitId)||binding.visitId<=0)throw new Error("Invalid visit identity");
    if(requested.has(binding.visitId)&&requested.get(binding.visitId)!==binding.expectedPatientId)throw new Error("Conflicting visit owner");
    requested.set(binding.visitId,binding.expectedPatientId);
  }
  const cache:ReadCache={invoices:new Map(),items:new Map(),documents:new Map()};
  const result=new Map<number,VisitFinancialContext>();const ids=[...requested.keys()];
  for(let start=0;start<ids.length;start+=BATCH_SIZE){
    const batch=await loadBatch(db,ids.slice(start,start+BATCH_SIZE),cache);
    for(const visit of batch.visits){const expected=requested.get(visit.id);if(expected!==undefined&&visit.patient_id!==expected)throw new Error("Visit owner changed");}
    for(const visit of batch.visits)result.set(visit.id,await projectVisit(db,visit,batch,cache));
  }
  return result;
}
export async function readVisitFinancialContext(db:Runner,visitId:number,expectedPatientId?:number|null):Promise<VisitFinancialContext|null>{
  return (await readVisitFinancialContexts(db,[{visitId,expectedPatientId}])).get(visitId)??null;
}
/** Explicit visit identity only. Authorization belongs to the route; owner is rechecked in the snapshot. */
export async function getVisitFinancialContext(visitId:number,expectedPatientId:number|null){
  return withFinancialReadSnapshot(getPool(),db=>readVisitFinancialContext(db,visitId,expectedPatientId),usesSharedLocalDatabaseConnection());
}
