import type { DbClient } from './db';
import { ReclassificationProofError } from './invoice-currency-reclassification';
import { readUnpaidCurrencyTransitions } from './invoice-unpaid-currency-evidence';

/** Additive dispatch, never widened v1 receipt allocation. Unknown kinds,
 * missing zero-event documents and cross-kind documents fail closed. */
export async function readCurrencyEvidenceDispatch(client: Pick<DbClient,'query'>, patientIds: readonly number[]) {
  if (!patientIds.length) return [];
  const {rows}=await client.query<{id:number;kind:string;changing:boolean;legacy_id:number|null}>(`SELECT c.id,
    COALESCE(to_jsonb(c)->>'currency_evidence_kind','legacy_v1') AS kind,
    (c.original_currency IS NOT NULL AND c.original_currency<>c.currency) AS changing,d.id AS legacy_id
    FROM invoice_corrections c LEFT JOIN invoice_settlement_reclassifications d ON d.correction_id=c.id
    WHERE c.patient_id=ANY($1::int[]) ORDER BY c.id`,[[...new Set(patientIds)]]);
  if (rows.some(row=>!['legacy_v1','unpaid_root_v1'].includes(row.kind)
    || row.kind==='legacy_v1' && row.changing!==(row.legacy_id!==null)
    || row.kind==='unpaid_root_v1' && (!row.changing || row.legacy_id!==null))) throw new ReclassificationProofError();
  const {rows:[schema]}=await client.query<{installed:boolean}>("SELECT to_regclass('invoice_unpaid_currency_claims') IS NOT NULL AS installed");
  if (!schema?.installed && !rows.some(row=>row.kind==='unpaid_root_v1')) return [];
  const documents=await readUnpaidCurrencyTransitions(client,patientIds);
  const expected=rows.filter(row=>row.kind==='unpaid_root_v1').map(row=>row.id).sort((a,b)=>a-b);
  if (JSON.stringify(documents.map(row=>row.correctionId).sort((a,b)=>a-b))!==JSON.stringify(expected)) throw new ReclassificationProofError();
  return documents;
}
