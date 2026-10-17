import {createHash} from "node:crypto";

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical)
  :record(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
export const debtRequestHash=(value:unknown)=>createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

/** Keep every source fact except settlement events and the live invoice's
 * derived open/paid status. Cancellation, principal, currency and lineage still
 * change this fingerprint. The full request/preview hash is deliberately intact.
 */
function debtIdentity(snapshot:Record<string,unknown>){
  const {payments:_payments,...identity}=snapshot;
  return {...identity,lineage:(snapshot.lineage as Record<string,unknown>[]).map(row=>({
    ...row,status:row.id===snapshot.invoiceId&&["open","paid"].includes(String(row.status))?"active":row.status,
  }))};
}

/** A saved schedule tolerates append-only ordinary collection, not arbitrary
 * changes to its settlement proof. Preserve every baseline row byte-for-byte
 * (canonical JSON), reject any new refund/reversal, and never update the saved
 * revision to conceal drift. Call only after the canonical position validator.
 * Opening/legacy snapshot shapes keep the existing exact comparison policy.
 */
export function debtRevisionSourceMatches(current:Record<string,unknown>,saved:unknown):boolean{
  if(!record(saved))return false;
  if(!Array.isArray(current.payments)||!Array.isArray(saved.payments))return debtRequestHash(current)===debtRequestHash(saved);
  if(!Number.isSafeInteger(current.invoiceId)||!Number.isSafeInteger(saved.invoiceId)
    ||!Array.isArray(current.lineage)||!Array.isArray(saved.lineage)
    ||!current.lineage.every(record)||!saved.lineage.every(record))return false;
  if(debtRequestHash(debtIdentity(current))!==debtRequestHash(debtIdentity(saved)))return false;
  const index=(rows:unknown[])=>{
    const result=new Map<number,Record<string,unknown>>();
    for(const row of rows){
      if(!record(row)||typeof row.id!=="number"||!Number.isSafeInteger(row.id)||row.id<=0||result.has(row.id))return null;
      result.set(row.id,row);
    }
    return result;
  };
  const before=index(saved.payments),after=index(current.payments);
  if(!before||!after)return false;
  for(const [id,row] of before){if(!after.has(id)||debtRequestHash(row)!==debtRequestHash(after.get(id)))return false;}
  for(const [id,row] of after){
    if(!before.has(id)&&(row.kind!=="payment"||row.reversal_of_id!==null
      ||!Number.isSafeInteger(Number(row.amount_minor))||Number(row.amount_minor)<=0))return false;
  }
  return true;
}
