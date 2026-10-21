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
async function invoiceReference(db: Runner, id: number, patientId: number | null, path: string): Promise<VisitSource | null> {
  const { rows: [row] } = await db.query<{status:string}>("SELECT status FROM invoices WHERE id=$1 AND patient_id=$2",[id,patientId]);
  return row ? { kind:"invoice", id, state:row.status === "cancelled" ? "historical" : "current", path } : null;
}

async function itemEvidence(db: Runner, itemId: number, patientId: number | null, line: VisitFinancialWork) {
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
    const reference = await invoiceReference(db,id,patientId,"plan_item");
    if (reference) line.references.push(reference); else line.reasons.push("invoice_owner_unverified");
  }
  const { rows: agreements } = await db.query<{id:number;status:string;document_id:number|null}>(
    "SELECT id,status,document_id FROM legacy_treatment_agreements WHERE plan_item_id=$1 AND patient_id=$2 ORDER BY id",[itemId,patientId]);
  let legacyValid = false;
  for (const agreement of agreements) {
    const documentValid = agreement.document_id === null || patientId !== null && await validVisitHistoricalDocument(db,patientId,agreement.document_id);
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

/** Caller supplies a read-only snapshot. No schema bootstrap, pricing, signing or receipt access. */
export async function readVisitFinancialContext(db: Runner, visitId: number, expectedPatientId?: number | null): Promise<VisitFinancialContext | null> {
  if (!Number.isSafeInteger(visitId) || visitId<=0) throw new Error("Invalid visit identity");
  const {rows:[visit]}=await db.query<{patient_id:number|null;signed_at:Date|null;invoice_id:number|null}>(
    "SELECT patient_id,signed_at,invoice_id FROM visits WHERE id=$1",[visitId]);
  if (!visit) return null;
  if (expectedPatientId!==undefined && visit.patient_id!==expectedPatientId) throw new Error("Visit owner changed");
  const directReference=visit.invoice_id===null?null:await invoiceReference(db,visit.invoice_id,visit.patient_id,"visit");
  const lines:VisitFinancialWork[]=[];
  const {rows:procedures}=await db.query<{id:string;plan_item_id:number|null;item_matches:boolean}>(`SELECT p.id::text,p.plan_item_id,
    (i.id IS NOT NULL AND t.patient_id=$2 AND i.service_id=p.service_id AND i.tooth_code IS NOT DISTINCT FROM p.tooth_code
      AND coalesce(i.surfaces,'')=coalesce(p.surfaces,'') AND (i.billed_invoice_id IS NULL OR i.doctor_id IS NOT DISTINCT FROM p.doctor_id)) AS item_matches
    FROM visit_procedures p LEFT JOIN plan_items i ON i.id=p.plan_item_id LEFT JOIN treatment_plans t ON t.id=i.plan_id
    WHERE p.visit_id=$1 ORDER BY p.id`,[visitId,visit.patient_id]);
  const representedItems=new Set<number>();
  for(const procedure of procedures) {
    const id=Number(procedure.id); if(!Number.isSafeInteger(id))throw new Error("Unsafe work identity");
    const line=work("procedure",id); lines.push(line);
    const {rows:sourceLines}=await db.query<{id:number;status:string;owned:boolean;matches:boolean}>(`WITH RECURSIVE source_items AS (
      SELECT ii.id FROM invoice_items ii WHERE ii.source_type='visit_procedure' AND ii.source_id=$1
      UNION SELECT cl.corrected_item_id FROM source_items previous
        JOIN invoice_correction_lines cl ON cl.original_item_id=previous.id
        JOIN invoice_corrections correction ON correction.id=cl.correction_id AND correction.patient_id=$2
          AND correction.currency=correction.original_currency
        JOIN invoice_items target ON target.id=cl.corrected_item_id AND target.invoice_id=correction.corrected_invoice_id
        JOIN invoice_items original ON original.id=previous.id AND original.invoice_id=correction.original_invoice_id
    ) SELECT inv.id,inv.status,inv.patient_id=$2 AS owned,
      (ii.service_id=p.service_id AND ii.quantity=p.quantity AND ii.unit_price_minor=p.unit_price_minor
        AND ii.total_minor=p.quantity*p.unit_price_minor AND ii.doctor_id IS NOT DISTINCT FROM p.doctor_id
        AND (ii.plan_item_id IS NULL OR ii.plan_item_id=p.plan_item_id)) AS matches
      FROM source_items source JOIN invoice_items ii ON ii.id=source.id JOIN invoices inv ON inv.id=ii.invoice_id
      JOIN visit_procedures p ON p.id=$1 ORDER BY inv.id`,[id,visit.patient_id]);
    const activeSources=new Set<number>();
    for(const source of sourceLines) {
      if(!source.owned){line.reasons.push("invoice_owner_unverified");continue;}
      line.references.push({kind:"invoice",id:source.id,state:source.status==="cancelled"?"historical":source.matches?"current":"review",path:"visit_procedure"});
      if(source.status!=="cancelled") { if(source.matches)activeSources.add(source.id); else line.reasons.push("invoice_item_identity_conflict"); }
    }
    const active=activeSources.size;
    if(active>1)line.reasons.push("multiple_financial_sources");
    if(procedure.plan_item_id!==null) {
      representedItems.add(procedure.plan_item_id);
      if(!procedure.item_matches)line.reasons.push("procedure_plan_identity_conflict");
      else await itemEvidence(db,procedure.plan_item_id,visit.patient_id,line);
    }
    if(active===1 && line.coverage==="verified" && line.references.some(reference =>
      reference.state==="current" && (reference.kind!=="invoice" || !activeSources.has(reference.id))))line.reasons.push("multiple_financial_sources");
    if(active===1 && !line.reasons.length)line.coverage="verified";
    if(line.reasons.length)line.coverage="unresolved";
  }
  // A completed session is an explicit visit/item edge; it is not a second copy of a procedure.
  const {rows:items}=await db.query<{id:number}>(`SELECT i.id FROM plan_items i WHERE
    (i.visit_id=$1 AND i.status='done' OR EXISTS(SELECT 1 FROM treatment_sessions s WHERE s.plan_item_id=i.id AND s.visit_id=$1 AND s.status='done'))
    ORDER BY i.id`,[visitId]);
  for(const item of items) if(!representedItems.has(item.id)) {
    const line=work("plan_item",item.id); await itemEvidence(db,item.id,visit.patient_id,line); lines.push(line);
  }
  const {rows:adjustments}=await db.query<{id:number;owned:boolean;billing_class:string|null;billing_decision:string|null;billing_decision_reason:string|null;billing_decided_by:string|null;billing_decided_at:Date|null;billing_invoice_id:number|null}>(
    `SELECT a.id,c.patient_id=$2 AS owned,a.billing_class,a.billing_decision,a.billing_decision_reason,a.billing_decided_by,a.billing_decided_at,a.billing_invoice_id
     FROM ortho_adjustments a JOIN ortho_cases c ON c.id=a.case_id WHERE a.visit_id=$1 ORDER BY a.id`,[visitId,visit.patient_id]);
  for(const adjustment of adjustments) {
    const line=work("orthodontic_adjustment",adjustment.id);lines.push(line);
    if(!adjustment.owned){line.reasons.push("adjustment_owner_unverified");continue;}
    if(adjustment.billing_class)line.recordedClassification=adjustment.billing_class;
    if(adjustment.billing_class==="OUTSIDE_CONTRACT" && adjustment.billing_decision==="no_charge" && adjustment.billing_decision_reason?.trim() && adjustment.billing_decided_by && adjustment.billing_decided_at && adjustment.billing_invoice_id===null)line.decision="no_charge";
    else if(adjustment.billing_decision==="billed") {
      line.decision="billed";
      const reference=adjustment.billing_invoice_id===null?null:await invoiceReference(db,adjustment.billing_invoice_id,visit.patient_id,"adjustment_decision");
      if(reference)line.references.push(reference);
      line.reasons.push("adjustment_coverage_unverified");
    } else line.reasons.push("adjustment_source_unresolved");
  }
  const {rows:endo}=await db.query<{id:number;owned:boolean}>(`SELECT ev.id,(t.patient_id=$2 AND c.patient_id=$2) AS owned
    FROM endo_visits ev JOIN endo_treatments t ON t.id=ev.treatment_id JOIN clinical_cases c ON c.id=t.case_id
    WHERE ev.visit_id=$1 ORDER BY ev.id`,[visitId,visit.patient_id]);
  for(const record of endo){const line=work("endodontic_record",record.id);line.reasons.push(record.owned?"endo_work_item_not_explicit":"endo_owner_unverified");lines.push(line);}
  for(const line of lines) {
    if(!visit.signed_at){line.coverage="unresolved";line.reasons.push("unsigned_work");}
    if(line.coverage==="unresolved" && line.decision!=="no_charge" && !line.reasons.length)line.reasons.push("source_not_established");
  }
  return projectVisitFinancialContext({visitId,patientId:visit.patient_id,signed:visit.signed_at!==null,directReference,directReferenceState:visit.invoice_id===null?"missing":directReference?.state??"review",work:lines});
}

/** Explicit visit identity only. Authorization belongs to the route; owner is rechecked in the snapshot. */
export async function getVisitFinancialContext(visitId:number,expectedPatientId:number|null){
  return withFinancialReadSnapshot(getPool(),db=>readVisitFinancialContext(db,visitId,expectedPatientId),usesSharedLocalDatabaseConnection());
}
