import { requireInventoryIntegration } from "./rollout";
import { randomUUID } from "node:crypto";
import { doctorOwnsPatient,ensureSchema,getPool,type DbClient } from "../db";
import { withTransaction } from "../transactions";
import { clinicDateString } from "../schedule";
import { CLINIC_ZONE_FALLBACK } from "../clinicZone";
import { invariant,InventoryDomainError,quantityAtoms,quantityText,decimalRatio } from "./quantities";
import { allocateMinor,planHistoricalReconciliation } from "./procurement";
import { canonicalCustodyReferenceKey,canonicalSettlementPeriodId,classifyDefaultPackageSafety,matchCustodyPackageSource,packageEvidenceAction,proposeSettlement,reconcileCustody,reconcileEmptyPackage,resolveCustodyPackageSources,resolvePackageSafetyWithFieldObservation,type PackageSafetyPolicy } from "./custody";
import { INVENTORY_CLINIC_SCOPE,INVENTORY_READ_MAX_BYTES,inventoryOperation,requireInventoryActor,writeInventoryAudit,type InventoryActor } from "./procurement-store";
/** Read-only query surface: a transaction client or the canonical snapshot facade. */
type Q=Pick<DbClient,"query">;
import { canonicalAccountHolds,canonicalAuthorityOfClient,canonicalInventoryGrant,type CanonicalInventoryAuthority } from "./canonical-operation";
import { runCanonicalReadSnapshot } from "../canonical-read-snapshot";
import type { VerifiedDurableSession } from "../staff-durable-session";
import { requireCurrency,type Currency } from "../money";

interface Location {id:string;label:string;kind:"store"|"custody"|"transit";doctor_party_id:number|null;branch_key:string;is_active:boolean}
interface Lot {id:string;item_id:number;name:string;category:string;unit:string;status:string;unreleased_qty:string;receipt_location_id:string;expiry_date:string|null;lot_code:string|null;cost_status:string;cost_snapshot:Record<string,unknown>}
export interface CustodyDispatch {id:string;fromLocationId:string;toLocationId:string;transitLocationId:string;reason:string;lines:{id:string;lotId:string;quantity:string}[]}
export interface CustodyAcknowledgement {id:string;transferId:string;reason:string;lines:{lineId:string;acceptedQuantity:string;returnedQuantity:string}[]}
export interface LegacyReconciliationInput {id:string;itemId:number;locationId:string;reason:string;requiresExpiry?:boolean}
export interface CustodyWasteApprovalInput {
 id:string;
 locationId:string;
 lotId:string;
 maxQuantity?:string;
 quantity?:string;
 reason:string;
}
export interface CustodyUsageInput {
 id:string;
 usageKey?:string;
 locationId:string;
 storeLocationId?:string|null;
 lotId:string;
 kind:"consumed"|"approved_waste"|"returned_to_store";
 quantity:string;
 quantityState?:"confirmed"|"estimated";
 patientId?:string|null;
 visitId?:string|null;
 caseId?:string|null;
 procedureId?:string|null;
 wasteApprovalId?:string|null;
 approvalId?:string|null;
 reason:string;
}
export interface CustodyStocktakeInput {
 id:string;
 locationId:string;
 lotId:string;
 countedQuantity:string;
 reason:string;
}
export interface CustodyPackageClosureInput {
 id:string;
 packageId:string;
 evidenceEventId:string;
 locationId:string;
 lotId:string;
 hazard:"none"|"sharp"|"contaminated";
 policy:PackageSafetyPolicy;
 evidenceAction?:ReturnType<typeof packageEvidenceAction>;
 originalQuantity:string;
 recordedConsumptionQuantity:string;
 returnedOrTransferredQuantity:string;
 approvedWasteQuantity:string;
 remainingQuantity:string;
 reason:string;
}
export interface CustodySettlementProposalInput {
 id:string;
 doctorPartyId:number;
 periodId:string;
 currency:Currency;
 appliedDeductionsMinor:number;
 attributableConsumptionMinor:number|null;
 prerequisitesComplete?:boolean;
 reason:string;
}
export interface CustodySettlementObjectionInput {
 id:string;
 settlementId:string;
 reason:string;
}
const uuid=(id:string)=>invariant(typeof id==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),"invalid_document_id","Use a document UUID");
const reason=(value:string)=>invariant(typeof value==="string"&&value.trim().length>0&&value.length<=2000,"reason_required","A bounded reason is required");
function mapDomainCall<T>(fn:()=>T):T{try{return fn();}catch(err){if(err instanceof InventoryDomainError)throw err;const code=err instanceof Error&&err.message?err.message:"invalid_custody_operation";throw new InventoryDomainError(code,code);}}
/** JSON fields are untrusted even when the TypeScript caller names an input type.
 * Never turn a supplied malformed clinical reference into unlinked consumption. */
function clinicalReference(value:unknown,allowUnmatchedProcedure=false):string|null{
 if(value===undefined||value===null)return null;
 invariant(typeof value==="string"&&value.length<=240,"clinical_context_mismatch","Clinical references must be bounded text identifiers");
 const normalized=value.trim();if(!normalized)return null;
 const numeric=/^[1-9]\d*$/.test(normalized);
 invariant(allowUnmatchedProcedure||numeric,"clinical_context_mismatch","Clinical references must be positive integer identifiers");
 if(numeric)invariant(Number.isSafeInteger(Number(normalized))&&Number(normalized)<=2147483647,"clinical_context_mismatch","Clinical reference exceeds the registered identifier range");
 return normalized;
}
function savedClinicalAttribution(row:{patient_id:string|null;visit_id:string|null;case_id:string|null;procedure_id:string|null;clinical_attribution_status:string|null}):"none"|"verified"|"unmatched_pending_review"{
 if(!row.patient_id&&!row.visit_id&&!row.case_id&&!row.procedure_id)return "none";
 return row.patient_id&&row.clinical_attribution_status==="verified"?"verified":"unmatched_pending_review";
}
/** Custody ownership decision. Legacy: the administrator role, or the doctor owning
 * the custody. Canonical: the exact `oversight` grant, or the actor's validated linked
 * active clinician owning it (proved in the same admitted transaction). */
function custodyOwnerAllowed(client:DbClient,actor:InventoryActor,who:{party_id:number|null},ownerParty:number|null,oversight:"inventory.custody.dispatch"|"inventory.custody.settlement.propose"):boolean{
 const authority=canonicalAuthorityOfClient(client);
 if(authority)return canonicalInventoryGrant(authority,oversight)||(who.party_id!==null&&ownerParty!==null&&ownerParty===who.party_id);
 return actor.role==="admin"||(actor.role==="doctor"&&who.party_id!==null&&ownerParty===who.party_id);
}
async function ready(){requireInventoryIntegration();await ensureSchema();const r=await getPool().query<{present:boolean}>("SELECT to_regclass('inventory_transfers') IS NOT NULL AS present");if(!r.rows[0]?.present)throw new InventoryDomainError("schema_not_ready","Doctor custody schema awaits coordinated migration");}
const BALANCES_SQL=`SELECT lot_id,location_id,SUM(delta)::text AS qty FROM (
 SELECT a.lot_id,a.location_id,CASE WHEN m.kind='out' OR(m.kind='adjust' AND m.qty<0) THEN -a.qty ELSE a.qty END AS delta
 FROM inventory_movement_allocations a JOIN inventory_movements m ON m.id=a.movement_id
 UNION ALL SELECT l.lot_id,t.from_location_id,-l.qty FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.id=l.transfer_id
 UNION ALL SELECT l.lot_id,t.transit_location_id,l.qty FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.id=l.transfer_id
 UNION ALL SELECT l.lot_id,t.transit_location_id,-(a.accepted_qty+a.returned_qty) FROM inventory_transfer_ack_lines a JOIN inventory_transfer_lines l ON l.id=a.transfer_line_id JOIN inventory_transfers t ON t.id=l.transfer_id
 UNION ALL SELECT l.lot_id,t.to_location_id,a.accepted_qty FROM inventory_transfer_ack_lines a JOIN inventory_transfer_lines l ON l.id=a.transfer_line_id JOIN inventory_transfers t ON t.id=l.transfer_id
 UNION ALL SELECT l.lot_id,t.from_location_id,a.returned_qty FROM inventory_transfer_ack_lines a JOIN inventory_transfer_lines l ON l.id=a.transfer_line_id JOIN inventory_transfers t ON t.id=l.transfer_id
 UNION ALL SELECT u.lot_id,u.location_id,-u.qty FROM custody_usage_events u WHERE u.kind='returned_to_store'
 UNION ALL SELECT u.lot_id,u.store_location_id,u.qty FROM custody_usage_events u WHERE u.kind='returned_to_store' AND u.store_location_id IS NOT NULL
) allocations GROUP BY lot_id,location_id`;
async function balances(client:Q){const r=await client.query<{lot_id:string;location_id:string;qty:string}>(BALANCES_SQL);for(const row of r.rows)invariant(!row.qty.startsWith("-"),"allocation_reconciliation_required","A location/lot allocation is negative; reconcile source records before transfer");return r.rows;}
/** Writers share-lock the locations they read; snapshot readers take no row locks. */
async function locations(client:Q,ids?:string[],lock=true){return (await client.query<Location>(`SELECT id,label,kind,doctor_party_id,branch_key,is_active FROM inventory_locations WHERE branch_key=$1 AND ($2::text[] IS NULL OR id=ANY($2::text[])) ORDER BY id${lock?" FOR SHARE":""}`,[INVENTORY_CLINIC_SCOPE,ids??null])).rows;}
async function lots(client:Q,ids?:string[]){return (await client.query<Lot>(`SELECT l.id,l.item_id,i.name,i.category,i.unit,
 CASE
  WHEN l.status='quarantined' AND l.receipt_line_id IS NOT NULL THEN
   CASE
    WHEN COALESCE((SELECT SUM(qd.base_qty) FROM quarantine_dispositions qd WHERE qd.receipt_line_id=l.receipt_line_id),0)>=grl.base_qty THEN
     CASE WHEN COALESCE((SELECT SUM(qd.base_qty) FILTER(WHERE qd.action='release') FROM quarantine_dispositions qd WHERE qd.receipt_line_id=l.receipt_line_id),0)>0 THEN 'accepted' ELSE 'recalled' END
    WHEN COALESCE((SELECT SUM(qd.base_qty) FILTER(WHERE qd.action='release') FROM quarantine_dispositions qd WHERE qd.receipt_line_id=l.receipt_line_id),0)>0 THEN 'accepted'
    ELSE 'quarantined'
   END
  ELSE l.status
 END AS status,
 CASE
  WHEN l.status='quarantined' AND l.receipt_line_id IS NOT NULL THEN
   GREATEST(grl.base_qty-COALESCE((SELECT SUM(qd.base_qty) FROM quarantine_dispositions qd WHERE qd.receipt_line_id=l.receipt_line_id),0),0)::text
  ELSE '0'
 END AS unreleased_qty,
 l.location_id AS receipt_location_id,
 l.expiry_date::text,l.lot_code,l.cost_status,l.cost_snapshot
 FROM stock_lots l JOIN inventory_items i ON i.id=l.item_id LEFT JOIN goods_receipt_lines grl ON grl.id=l.receipt_line_id
 WHERE ($1::uuid[] IS NULL OR l.id=ANY($1::uuid[])) ORDER BY l.id`,[ids??null])).rows;}
async function ledgerRows(client:Q,itemIds?:number[]){
 const r=await client.query<{id:number;name:string;unit:string;global_qty:string;allocated_qty:string;source_allocations_complete:boolean}>(`SELECT i.id,i.name,i.unit,
 COALESCE((SELECT SUM(CASE m.kind WHEN 'out' THEN -m.qty ELSE m.qty END) FROM inventory_movements m WHERE m.item_id=i.id),0)::text AS global_qty,
 COALESCE((SELECT SUM(CASE WHEN m.kind='out' OR(m.kind='adjust' AND m.qty<0) THEN -a.qty ELSE a.qty END) FROM inventory_movement_allocations a JOIN inventory_movements m ON m.id=a.movement_id WHERE m.item_id=i.id),0)::text AS allocated_qty,
 NOT EXISTS (
  SELECT 1 FROM inventory_movements m WHERE m.item_id=i.id AND (
   ABS(m.qty) <> COALESCE((SELECT SUM(a.qty) FROM inventory_movement_allocations a WHERE a.movement_id=m.id),0)
   OR EXISTS (SELECT 1 FROM inventory_movement_allocations a JOIN stock_lots l ON l.id=a.lot_id WHERE a.movement_id=m.id AND l.item_id<>m.item_id)
  )
 ) AND NOT EXISTS (
  SELECT 1 FROM inventory_movement_allocations a
  JOIN stock_lots l ON l.id=a.lot_id JOIN inventory_movements m ON m.id=a.movement_id
  WHERE l.item_id=i.id AND m.item_id<>l.item_id
 ) AS source_allocations_complete
 FROM inventory_items i
 WHERE ($1::int[] IS NULL AND (EXISTS (SELECT 1 FROM inventory_movements m WHERE m.item_id=i.id) OR EXISTS (SELECT 1 FROM stock_lots l WHERE l.item_id=i.id)))
    OR i.id=ANY($1::int[])
 ORDER BY i.id`,[itemIds??null]);
 return r.rows;
}
function reconciled(row:{global_qty:string;allocated_qty:string;source_allocations_complete:boolean}){try{return row.source_allocations_complete&&(row.global_qty===row.allocated_qty||decimalRatio(row.global_qty).numerator*decimalRatio(row.allocated_qty).denominator===decimalRatio(row.allocated_qty).numerator*decimalRatio(row.global_qty).denominator);}catch{return false;}}
/** Held inspection quantity remains at its receipt origin until a quarantine
 * disposition retires it. Custody usage/waste/returns cannot spend that reserve. */
function locationCapacity(lot:Lot,locationId:string,current:readonly {lot_id:string;location_id:string;qty:string}[]){
 const at=(id:string)=>quantityAtoms(current.find(row=>row.lot_id===lot.id&&row.location_id===id)?.qty??"0",3,true);
 const total=at(locationId);
 const reserve=quantityAtoms(lot.unreleased_qty??"0",3,true);
 // Check the receipt origin even when reading/spending another location. A
 // zero/missing origin must not hide held stock that escaped in old data.
 invariant(reserve<=at(lot.receipt_location_id),"allocation_reconciliation_required","Quarantine reserve exceeds its tracked receipt-origin balance");
 const held=locationId===lot.receipt_location_id?reserve:0n;
 return {total,held,available:total-held};
}
async function verifyLedgerReconciliation(client:DbClient,itemIds:number[]){const rows=await ledgerRows(client,itemIds);invariant(rows.every(reconciled),"legacy_allocation_incomplete","Clinic movements are not fully allocated to lots/locations; reconcile before transfer");}
function basePrecision(lot:Lot){const conversion=lot.cost_snapshot.conversion as {basePrecision?:number;baseUnit?:string}|undefined;invariant(conversion&&typeof conversion.basePrecision==="number"&&Number.isInteger(conversion.basePrecision)&&conversion.basePrecision>=0&&conversion.basePrecision<=3&&conversion.baseUnit===lot.unit,"unit_precision_unconfirmed","Use the lot's recorded base unit/precision before transferring it");return conversion.basePrecision;}
function eligible(lot:Lot,today:string){return lot.status==="accepted"&&((lot.expiry_date===null&&lot.cost_snapshot.requiresExpiry===false)||(lot.expiry_date!==null&&lot.expiry_date>=today));}
async function lockItems(client:DbClient,itemIds:number[]){const ids=[...new Set(itemIds)].sort((a,b)=>a-b);const r=await client.query<{id:number;is_active:boolean}>("SELECT id,is_active FROM inventory_items WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE",[ids]);invariant(r.rows.length===ids.length&&r.rows.every(row=>row.is_active),"item_unavailable","Transfer items must remain active");await verifyLedgerReconciliation(client,ids);}
export async function dispatchCustodyTransfer(actor:InventoryActor,key:string,input:CustodyDispatch,authority?:CanonicalInventoryAuthority){
 uuid(input.id);reason(input.reason);invariant(Array.isArray(input.lines)&&input.lines.length>0&&input.lines.length<=100,"invalid_lines","Use one to 100 transfer lines");
 const lineIds=new Set<string>(),lotIds=new Set<string>();for(const line of input.lines){uuid(line.id);uuid(line.lotId);quantityAtoms(line.quantity);invariant(!lineIds.has(line.id)&&!lotIds.has(line.lotId),"duplicate_source","Transfer lines/lots must be unique");lineIds.add(line.id);lotIds.add(line.lotId);}
 if(!authority)await ready();return inventoryOperation(actor,key,"custody.dispatch",input,authority??true,async client=>{
  const places=await locations(client,[input.fromLocationId,input.toLocationId,input.transitLocationId]);const source=places.find(row=>row.id===input.fromLocationId),dest=places.find(row=>row.id===input.toLocationId),transit=places.find(row=>row.id===input.transitLocationId);
  invariant(source?.is_active&&dest?.is_active&&transit?.is_active&&source.kind!=="transit"&&dest.kind!=="transit"&&transit.kind==="transit"&&new Set([source.id,dest.id,transit.id]).size===3,"location_forbidden","Use distinct active source, destination and transit locations in this clinic");
  if(dest.kind==="custody"){const party=await client.query<{kind:string;is_active:boolean}>("SELECT kind,is_active FROM parties WHERE id=$1 FOR SHARE",[dest.doctor_party_id]);invariant(party.rows[0]?.kind==="doctor"&&party.rows[0]?.is_active,"doctor_unavailable","Destination must belong to an active doctor");}
  let stock=await lots(client,[...lotIds]);invariant(stock.length===lotIds.size,"not_found","Transfer lot was not found");await lockItems(client,stock.map(row=>row.item_id));stock=await lots(client,[...lotIds]);const current=await balances(client);const today=clinicDateString(new Date(),CLINIC_ZONE_FALLBACK);
  for(const line of input.lines){
   const lot=stock.find(row=>row.id===line.lotId)!;invariant(eligible(lot,today),"lot_unavailable","Expired or quarantined material cannot be dispatched as available custody");
   const availableAtoms=locationCapacity(lot,source.id,current).available;
   invariant(quantityAtoms(line.quantity,basePrecision(lot))<=availableAtoms,"insufficient_location_stock","Source location has insufficient tracked stock");
  }
  await client.query("INSERT INTO inventory_transfers(id,from_location_id,to_location_id,transit_location_id,reason,created_by) VALUES($1,$2,$3,$4,$5,$6)",[input.id,source.id,dest.id,transit.id,input.reason,actor.userId]);
  for(const line of input.lines){const lot=stock.find(row=>row.id===line.lotId)!;await client.query("INSERT INTO inventory_transfer_lines(id,transfer_id,lot_id,qty,cost_snapshot) VALUES($1,$2,$3,$4::numeric,$5::jsonb)",[line.id,input.id,line.lotId,quantityText(quantityAtoms(line.quantity)),JSON.stringify(lot.cost_snapshot)]);}
  await writeInventoryAudit(client,actor,"inventory_transfer",input.id,"dispatch",{source:source.id,destination:dest.id,transit:transit.id,reason:input.reason,lines:input.lines});
  return {id:input.id,status:"in_transit" as const,clinicMovementEffects:0,payableEffects:0,cashEffects:0};
 });
}
export async function acknowledgeCustodyTransfer(actor:InventoryActor,key:string,input:CustodyAcknowledgement,authority?:CanonicalInventoryAuthority){
 uuid(input.id);uuid(input.transferId);reason(input.reason);invariant(Array.isArray(input.lines)&&input.lines.length>0&&input.lines.length<=100,"invalid_lines","Acknowledgement lines are required");
 const ids=new Set<string>();for(const line of input.lines){uuid(line.lineId);invariant(!ids.has(line.lineId),"duplicate_source","Acknowledgement line is duplicated");ids.add(line.lineId);invariant(quantityAtoms(line.acceptedQuantity,3,true)+quantityAtoms(line.returnedQuantity,3,true)>0n,"zero_quantity","Acknowledge or return a positive quantity");}
 if(!authority)await ready();return inventoryOperation(actor,key,"custody.acknowledge",input,authority??false,async client=>{
  const who=await requireInventoryActor(client,actor,false);const r=await client.query<{id:string;from_location_id:string;to_location_id:string;transit_location_id:string}>("SELECT id,from_location_id,to_location_id,transit_location_id FROM inventory_transfers WHERE id=$1 FOR UPDATE",[input.transferId]);const transfer=r.rows[0];invariant(transfer,"not_found","Transfer was not found");
  const places=await locations(client,[transfer.from_location_id,transfer.to_location_id,transfer.transit_location_id]);const dest=places.find(row=>row.id===transfer.to_location_id);invariant(dest?.is_active,"location_forbidden","Destination is inactive");if(dest.kind==="custody"){const party=await client.query<{kind:string;is_active:boolean}>("SELECT kind,is_active FROM parties WHERE id=$1 FOR SHARE",[dest.doctor_party_id]);invariant(party.rows[0]?.kind==="doctor"&&party.rows[0]?.is_active,"doctor_unavailable","Destination must belong to an active doctor");}invariant(custodyOwnerAllowed(client,actor,who,dest.kind==="custody"?dest.doctor_party_id:null,"inventory.custody.dispatch"),"custody_owner_forbidden","Only the receiving doctor or authorized administrator can acknowledge custody");
  const lines=await client.query<{id:string;lot_id:string;qty:string;accepted:string;returned:string}>(`SELECT l.id,l.lot_id,l.qty::text,
 COALESCE((SELECT SUM(a.accepted_qty) FROM inventory_transfer_ack_lines a WHERE a.transfer_line_id=l.id),0)::text AS accepted,
 COALESCE((SELECT SUM(a.returned_qty) FROM inventory_transfer_ack_lines a WHERE a.transfer_line_id=l.id),0)::text AS returned
 FROM inventory_transfer_lines l WHERE l.transfer_id=$1 ORDER BY l.id`,[transfer.id]);
  const stock=await lots(client,lines.rows.map(row=>row.lot_id));await lockItems(client,stock.map(row=>row.item_id));const today=clinicDateString(new Date(),CLINIC_ZONE_FALLBACK);
  for(const line of input.lines){const source=lines.rows.find(row=>row.id===line.lineId);invariant(source,"unknown_transfer_line","Acknowledgement line belongs to another transfer");const precision=basePrecision(stock.find(row=>row.id===source.lot_id)!);const total=quantityAtoms(line.acceptedQuantity,precision,true)+quantityAtoms(line.returnedQuantity,precision,true);invariant(total<=quantityAtoms(source.qty)-quantityAtoms(source.accepted,3,true)-quantityAtoms(source.returned,3,true),"transfer_overacknowledged","This quantity was already acknowledged/returned");if(quantityAtoms(line.acceptedQuantity,3,true)>0n)invariant(eligible(stock.find(row=>row.id===source.lot_id)!,today),"lot_unavailable","Expired/quarantined material cannot be accepted as available custody");}
  await client.query("INSERT INTO inventory_transfer_acknowledgements(id,transfer_id,actor_id,reason) VALUES($1,$2,$3,$4)",[input.id,transfer.id,actor.userId,input.reason]);for(const line of input.lines)await client.query("INSERT INTO inventory_transfer_ack_lines(acknowledgement_id,transfer_line_id,accepted_qty,returned_qty) VALUES($1,$2,$3::numeric,$4::numeric)",[input.id,line.lineId,line.acceptedQuantity,line.returnedQuantity]);
  await writeInventoryAudit(client,actor,"inventory_transfer",transfer.id,"acknowledge",{acknowledgementId:input.id,reason:input.reason,lines:input.lines});return {id:input.id,transferId:transfer.id,clinicMovementEffects:0,payableEffects:0,cashEffects:0};
 });
}
/**
 * Reconciles unallocated historical clinic movements (`inventory_movements`) into location/lot allocations.
 * - Derives `requiresExpiry` from the item's authoritative server records (`stock_lots` or `purchase_order_lines`),
 *   defaulting fail-closed to `true` when no non-expiry policy is registered on the server; client payload cannot
 *   disable `requiresExpiry` for an expiry-tracked item.
 * - Legacy lots created with `expiry_date = NULL` for expiry-tracked items are isolated in `quarantined` status
 *   (`receipt_line_id = NULL`). This reconciles global ledger allocations so other valid lots of the same item can
 *   be transferred, while the quarantined legacy lot itself remains blocked from dispatch or consumption until a
 *   dedicated legacy lot inspection/release migration is introduced.
 */
export async function reconcileHistoricalMovements(actor:InventoryActor,key:string,input:LegacyReconciliationInput,authority?:CanonicalInventoryAuthority){
 uuid(input.id);reason(input.reason);
 invariant(Number.isSafeInteger(input.itemId)&&input.itemId>0,"invalid_identifier","A positive itemId is required");
 if(!authority)await ready();return inventoryOperation(actor,key,"legacy.reconcile",input,authority??true,async client=>{
  const itemRows=await client.query<{id:number;unit:string;is_active:boolean}>("SELECT id,unit,is_active FROM inventory_items WHERE id=$1 FOR UPDATE",[input.itemId]);
  const item=itemRows.rows[0];invariant(item?.is_active,"item_unavailable","Historical reconciliation item must be active");
  const placeRows=await locations(client,[input.locationId]);const place=placeRows[0];
  invariant(place?.is_active&&place.kind==="store","location_forbidden","Historical reconciliation requires an active clinic store location");
  const unitRows=await client.query<{version:number;base_precision:number}>("SELECT version,base_precision FROM inventory_item_unit_versions WHERE item_id=$1 AND base_unit=$2 ORDER BY version DESC LIMIT 1",[item.id,item.unit]);
  const conversionVersion=unitRows.rows[0]?.version??1;
  const basePrecisionValue=(unitRows.rows[0]?.base_precision??0) as 0|1|2|3;
  const expiryPolicyRows=await client.query<{requires_expiry:boolean}>(`SELECT COALESCE(
   (SELECT BOOL_OR(req_exp) FROM (
    SELECT (l.cost_snapshot->>'requiresExpiry')::boolean AS req_exp FROM stock_lots l WHERE l.item_id=$1 AND l.cost_snapshot ? 'requiresExpiry'
    UNION ALL
    SELECT (line->>'requiresExpiry')::boolean AS req_exp FROM purchase_orders po CROSS JOIN LATERAL jsonb_array_elements(po.document->'lines') AS line WHERE (line->>'itemId')::int=$1 AND line ? 'requiresExpiry'
    UNION ALL
    SELECT (line->>'requiresExpiry')::boolean AS req_exp FROM inventory_operations op CROSS JOIN LATERAL jsonb_array_elements(op.result->'order'->'lines') AS line WHERE op.scope='order.amend' AND (line->>'itemId')::int=$1 AND line ? 'requiresExpiry'
   ) policy_sources),
   TRUE
  ) AS requires_expiry`,[item.id]);
  const serverRequiresExpiry=expiryPolicyRows.rows[0]?.requires_expiry!==false;
  const movementRows=await client.query<{id:number;kind:"in"|"out"|"adjust";qty:string;expiry_date:string|null;unit_cost_minor:string|null;payable_id:number|null;allocated_qty:string}>(`SELECT m.id,m.kind,m.qty::text,m.expiry_date::text,m.unit_cost_minor::text,m.payable_id,
   COALESCE((SELECT SUM(a.qty) FROM inventory_movement_allocations a WHERE a.movement_id=m.id),0)::text AS allocated_qty
   FROM inventory_movements m WHERE m.item_id=$1 ORDER BY m.id ASC FOR UPDATE`,[item.id]);
  const existingLots=await client.query<{id:string;movement_id:number}>("SELECT id::text,movement_id FROM stock_lots WHERE item_id=$1",[item.id]);
  const currentBalances=await balances(client);
  const lotIdByMovement=new Map<number,string>();
  const existingRemainingByMovement=new Map<number,string>();
  for(const row of existingLots.rows){
   lotIdByMovement.set(row.movement_id,row.id);
   const rem=currentBalances.find(b=>b.lot_id===row.id&&b.location_id===place.id)?.qty??"0";
   existingRemainingByMovement.set(row.movement_id,rem);
  }
  const plan=planHistoricalReconciliation({
   itemId:item.id,
   baseUnit:item.unit,
   basePrecision:basePrecisionValue,
   conversionVersion,
   requiresExpiry:serverRequiresExpiry,
   locationId:place.id,
   reason:input.reason,
   movements:movementRows.rows.map(row=>({
    movementId:row.id,
    kind:row.kind,
    signedBaseQuantity:row.qty,
    alreadyAllocatedBaseQuantity:row.allocated_qty,
    ...(existingRemainingByMovement.has(row.id)?{existingLotRemainingBaseQuantity:existingRemainingByMovement.get(row.id)!}:{}),
    expiryDate:row.expiry_date,
    unitCostMinor:row.unit_cost_minor===null?null:Number(row.unit_cost_minor),
    payableId:row.payable_id,
   })),
  });
  for(const lot of plan.lotsToCreate){
   let lotId=lotIdByMovement.get(lot.movementId);
   if(!lotId){
    lotId=randomUUID();
    await client.query("INSERT INTO stock_lots(id,receipt_line_id,item_id,location_id,movement_id,lot_code,expiry_date,status,cost_status,cost_snapshot) VALUES($1,NULL,$2,$3,$4,NULL,$5::date,$6,$7,$8::jsonb)",[lotId,lot.itemId,lot.locationId,lot.movementId,lot.expiryDate,lot.status,lot.costStatus,JSON.stringify(lot.costSnapshot)]);
    lotIdByMovement.set(lot.movementId,lotId);
   }
  }
  for(const alloc of plan.allocationsToCreate){
   const lotId=lotIdByMovement.get(alloc.sourceLotMovementId);
   invariant(lotId,"not_found","Legacy lot for historical movement was not found");
   await client.query("INSERT INTO inventory_movement_allocations(id,movement_id,lot_id,location_id,qty) VALUES($1,$2,$3,$4,$5::numeric)",[randomUUID(),alloc.movementId,lotId,alloc.locationId,alloc.baseQuantity]);
  }
  await verifyLedgerReconciliation(client,[item.id]);
  await writeInventoryAudit(client,actor,"inventory_reconciliation",input.id,"legacy_reconcile",{itemId:item.id,locationId:place.id,netReconciledBaseQuantity:plan.netReconciledBaseQuantity,lotsCreated:plan.lotsToCreate.length,allocationsCreated:plan.allocationsToCreate.length,reason:input.reason});
  return {id:input.id,itemId:item.id,locationId:place.id,status:"reconciled" as const,netReconciledBaseQuantity:plan.netReconciledBaseQuantity,lotsCreated:plan.lotsToCreate.length,allocationsCreated:plan.allocationsToCreate.length,clinicMovementEffects:0,payableEffects:0,cashEffects:0};
 });
}
export async function approveCustodyWaste(actor:InventoryActor,key:string,input:CustodyWasteApprovalInput,authority?:CanonicalInventoryAuthority){
 uuid(input.id);uuid(input.lotId);reason(input.reason);
 invariant(typeof input.locationId==="string"&&input.locationId.trim().length>0,"invalid_location","Custody location is required");
 if(!authority)await ready();return inventoryOperation(actor,key,"custody.approve_waste",input,authority??true,async client=>{
  const who=await requireInventoryActor(client,actor,true);
  const places=await locations(client,[input.locationId]);const source=places[0];
  invariant(source?.is_active&&source.kind==="custody"&&source.doctor_party_id!==null,"location_forbidden","Waste approval requires an active doctor custody location");
  invariant(who.party_id===null||who.party_id!==source.doctor_party_id,"invalid_waste_approval","Custody waste approval requires an independent administrator");
  const party=await client.query<{kind:string;is_active:boolean}>("SELECT kind,is_active FROM parties WHERE id=$1 FOR SHARE",[source.doctor_party_id]);
  invariant(party.rows[0]?.kind==="doctor"&&party.rows[0]?.is_active,"doctor_unavailable","Custody location must belong to an active doctor");
  const stock=await lots(client,[input.lotId]);const lot=stock[0];invariant(lot,"not_found","Custody lot was not found");
  const rawMaxQuantity=input.maxQuantity??input.quantity??"";
  const precision=basePrecision(lot);const maxAtoms=quantityAtoms(rawMaxQuantity,precision);const maxQtyText=quantityText(maxAtoms);
  const doc={id:input.id,locationId:source.id,lotId:lot.id,doctorPartyId:source.doctor_party_id,maxQuantity:maxQtyText,approvedBy:actor.userId,reason:input.reason};
  await client.query("INSERT INTO custody_waste_approvals(id,location_id,lot_id,doctor_party_id,max_qty,reason,document,approved_by) VALUES($1,$2,$3,$4,$5::numeric,$6,$7::jsonb,$8)",[input.id,source.id,lot.id,source.doctor_party_id,maxQtyText,input.reason,JSON.stringify(doc),actor.userId]);
  await writeInventoryAudit(client,actor,"custody_waste_approval",input.id,"approve_waste",doc);
  return {...doc,status:"approved" as const,clinicMovementEffects:0,payableEffects:0,cashEffects:0};
 });
}
export async function recordCustodyUsage(actor:InventoryActor,key:string,input:CustodyUsageInput,authority?:CanonicalInventoryAuthority){
 uuid(input.id);uuid(input.lotId);reason(input.reason);
 invariant(["consumed","approved_waste","returned_to_store"].includes(input.kind),"invalid_custody_event","Invalid custody usage kind");
 const rawPatient=clinicalReference(input.patientId);
 const rawVisit=clinicalReference(input.visitId);
 const rawCase=clinicalReference(input.caseId);
 const rawProcedure=clinicalReference(input.procedureId,true);
 if(rawPatient||rawVisit||rawCase||rawProcedure)invariant(input.kind==="consumed","clinical_context_mismatch","Clinical patient/visit attribution applies only to patient consumption");
 const quantityState=input.quantityState??"confirmed";
 invariant(quantityState==="confirmed"||quantityState==="estimated","invalid_quantity_state","Quantity state must be confirmed or estimated");
 const usageKey=(typeof input.usageKey==="string"&&input.usageKey.trim()?input.usageKey.trim():input.id);
 invariant(usageKey.length>=1&&usageKey.length<=240,"invalid_document_id","Usage key must be 1 to 240 characters");
 const rawWasteApprovalId=typeof input.wasteApprovalId==="string"&&input.wasteApprovalId.trim()?input.wasteApprovalId.trim():typeof input.approvalId==="string"&&input.approvalId.trim()?input.approvalId.trim():null;
 if(input.kind==="approved_waste")invariant(rawWasteApprovalId!==null&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawWasteApprovalId),"invalid_waste_approval","Approved waste requires a valid registered wasteApprovalId UUID");
 if(input.kind==="returned_to_store")invariant(typeof input.storeLocationId==="string"&&input.storeLocationId.trim().length>0,"location_forbidden","Returning unused custody material requires a store location");
 const opScope=input.kind==="returned_to_store"?"custody.return_to_store":"custody.consume";
 if(!authority)await ready();return inventoryOperation(actor,key,opScope,input,authority??false,async client=>{
  const who=await requireInventoryActor(client,actor,false);
  const placeIds=input.kind==="returned_to_store"&&input.storeLocationId?[input.locationId,input.storeLocationId]:[input.locationId];
  const places=await locations(client,placeIds);
  const source=places.find(row=>row.id===input.locationId);
  invariant(source?.is_active&&source.kind==="custody"&&source.doctor_party_id!==null,"location_forbidden","Source must be an active doctor custody location");
  const party=await client.query<{kind:string;is_active:boolean}>("SELECT kind,is_active FROM parties WHERE id=$1 FOR SHARE",[source.doctor_party_id]);
  invariant(party.rows[0]?.kind==="doctor"&&party.rows[0]?.is_active,"doctor_unavailable","Custody location must belong to an active doctor");
  invariant(custodyOwnerAllowed(client,actor,who,source.doctor_party_id,"inventory.custody.dispatch"),"custody_owner_forbidden","Only the custody owner doctor or an administrator can record custody usage or return");
  let storePlace:Location|null=null;
  if(input.kind==="returned_to_store"){
   storePlace=places.find(row=>row.id===input.storeLocationId)??null;
   invariant(storePlace?.is_active&&storePlace.kind==="store","location_forbidden","Return destination must be an active clinic store location");
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`custody.usage:${usageKey}`]);
  const dup=await client.query<{id:string}>("SELECT id::text FROM custody_usage_events WHERE usage_key=$1 FOR SHARE",[usageKey]);
  invariant(!dup.rows.length,"duplicate_consumption","This custody usage key was already recorded");
  const stock=await lots(client,[input.lotId]);let lot=stock[0];invariant(lot,"not_found","Custody lot was not found");
  await lockItems(client,[lot.item_id]);
  // Quarantine dispositions use the same item lock. Refresh their capacity only
  // after acquiring it, not from the pre-lock lot snapshot.
  lot=(await lots(client,[input.lotId]))[0];invariant(lot,"not_found","Custody lot was not found");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`custody.lot_loc:${source.id}:${lot.id}`]);
  const current=await balances(client);const today=clinicDateString(new Date(),CLINIC_ZONE_FALLBACK);
  if(input.kind==="consumed"||input.kind==="returned_to_store")invariant(eligible(lot,today),"lot_unavailable","Expired or quarantined material cannot be consumed or returned as available store stock");
  const precision=basePrecision(lot);const qtyAtoms=quantityAtoms(input.quantity,precision);const normalizedQty=quantityText(qtyAtoms);
  const availableAtoms=locationCapacity(lot,source.id,current).available;
  invariant(qtyAtoms<=availableAtoms,"insufficient_location_stock","Doctor custody location has insufficient balance for this lot");
  if(input.kind==="approved_waste"){
   const approvalId=rawWasteApprovalId!;
   // Serialize the allowance row, but only share-lock its approver. Updating
   // that joined user after the item lock would invert inventoryOperation's
   // actor SHARE -> item order against a concurrent admin disposition.
   const approvalRows=await client.query<{id:string;location_id:string;lot_id:string;doctor_party_id:number;max_qty:string;approved_by:number;approver_role:string;approver_active:boolean;approver_party_id:number|null}>(`SELECT a.id::text,a.location_id,a.lot_id::text,a.doctor_party_id,a.max_qty::text,a.approved_by,
    u.role AS approver_role,u.is_active AS approver_active,u.party_id AS approver_party_id
    FROM custody_waste_approvals a JOIN users u ON u.id=a.approved_by WHERE a.id=$1 FOR UPDATE OF a FOR SHARE OF u`,[approvalId]);
   const approval=approvalRows.rows[0];
   invariant(approval&&approval.approver_active&&(canonicalAuthorityOfClient(client)
    ? await canonicalAccountHolds(client,approval.approved_by,"inventory.custody.approve-waste")
    : approval.approver_role==="admin"),"invalid_waste_approval","Approved waste requires an active administrator approval record");
   invariant(approval.approver_party_id===null||approval.approver_party_id!==source.doctor_party_id,"invalid_waste_approval","Self-approval of custody waste is forbidden");
   invariant(approval.location_id===source.id&&approval.lot_id===lot.id&&approval.doctor_party_id===source.doctor_party_id,"invalid_waste_approval","Waste approval does not match this custody location, doctor, or lot");
   const usedRows=await client.query<{used_qty:string}>("SELECT COALESCE(SUM(qty),0)::text AS used_qty FROM custody_usage_events WHERE waste_approval_id=$1 AND kind='approved_waste'",[approvalId]);
   const usedAtoms=quantityAtoms(usedRows.rows[0]?.used_qty??"0",3,true);
   const maxAtoms=quantityAtoms(approval.max_qty,3,true);
   invariant(usedAtoms+qtyAtoms<=maxAtoms,"invalid_waste_approval","Waste quantity exceeds the remaining approved waste allowance");
  }
  let verifiedPatientId:string|null=null;
  let verifiedVisitId:string|null=null;
  let verifiedCaseId:string|null=null;
  let verifiedProcedureId:string|null=null;
  let clinicalAttributionStatus:"none"|"verified"|"unmatched_pending_review"="none";
  if(rawPatient||rawVisit||rawCase||rawProcedure){
   invariant(input.kind==="consumed","clinical_context_mismatch","Clinical patient/visit attribution applies only to patient consumption");
   let patientIdNum:number|null=null;
   if(rawPatient){
    invariant(/^[1-9]\d*$/.test(rawPatient),"clinical_context_mismatch","Invalid patient identifier");
    patientIdNum=Number(rawPatient);
    const pRows=await client.query<{id:number}>("SELECT id FROM patients WHERE id=$1 FOR SHARE",[patientIdNum]);
    invariant(pRows.rows[0],"clinical_context_mismatch","Referenced patient was not found");
   }
   let visitIdNum:number|null=null;
   if(rawVisit){
    invariant(/^[1-9]\d*$/.test(rawVisit),"clinical_context_mismatch","Invalid visit identifier");
    visitIdNum=Number(rawVisit);
    const vRows=await client.query<{id:number;patient_id:number|null;doctor_id:number|null}>("SELECT id,patient_id,doctor_id FROM visits WHERE id=$1 FOR SHARE",[visitIdNum]);
    const visit=vRows.rows[0];
    invariant(visit&&visit.patient_id!==null,"clinical_context_mismatch","Referenced visit was not found or is not linked to a patient");
    invariant(patientIdNum===null||patientIdNum===visit.patient_id,"clinical_context_mismatch","Visit does not belong to the specified patient");
    invariant(visit.doctor_id===null||visit.doctor_id===source.doctor_party_id,"clinical_context_forbidden","Visit belongs to a different doctor");
    patientIdNum=visit.patient_id;
    verifiedVisitId=String(visit.id);
   }
   let caseIdNum:number|null=null;
   if(rawCase){
    invariant(/^[1-9]\d*$/.test(rawCase),"clinical_context_mismatch","Invalid clinical case/plan identifier");
    caseIdNum=Number(rawCase);
    const cRows=await client.query<{id:number;patient_id:number;primary_doctor_id:number|null}>("SELECT id,patient_id,primary_doctor_id FROM treatment_plans WHERE id=$1 FOR SHARE",[caseIdNum]);
    const planRow=cRows.rows[0];
    invariant(planRow,"clinical_context_mismatch","Referenced clinical case/treatment plan was not found");
    invariant(patientIdNum===null||planRow.patient_id===patientIdNum,"clinical_context_mismatch","Clinical case/treatment plan does not belong to the specified patient");
    invariant(planRow.primary_doctor_id===null||planRow.primary_doctor_id===source.doctor_party_id,"clinical_context_forbidden","Clinical case/treatment plan belongs to a different doctor");
    patientIdNum=planRow.patient_id;
    verifiedCaseId=String(planRow.id);
   }
   if(rawProcedure){
    if(/^[1-9]\d*$/.test(rawProcedure)){
     const procNum=Number(rawProcedure);
     const pvRows=await client.query<{id:number;patient_id:number;plan_id:number|null;doctor_id:number|null;visit_id:number|null}>("SELECT id,patient_id,plan_id,doctor_id,visit_id FROM planned_visits WHERE id=$1 FOR SHARE",[procNum]);
     const pv=pvRows.rows[0];
     if(pv){
      invariant(patientIdNum===null||pv.patient_id===patientIdNum,"clinical_context_mismatch","Procedure does not belong to the specified patient");
      if(visitIdNum!==null){
       invariant(pv.visit_id!==null&&pv.visit_id===visitIdNum,"clinical_context_mismatch","Procedure is not linked to the specified visit");
      }else if(pv.visit_id!==null){
       const linkedVisitRows=await client.query<{id:number;patient_id:number|null;doctor_id:number|null}>("SELECT id,patient_id,doctor_id FROM visits WHERE id=$1 FOR SHARE",[pv.visit_id]);
       const linkedVisit=linkedVisitRows.rows[0];
       invariant(linkedVisit&&linkedVisit.patient_id===pv.patient_id,"clinical_context_mismatch","Procedure visit link is inconsistent with patient");
       invariant(linkedVisit.doctor_id===null||linkedVisit.doctor_id===source.doctor_party_id,"clinical_context_forbidden","Procedure visit belongs to a different doctor");
       verifiedVisitId=String(linkedVisit.id);
      }
      if(caseIdNum!==null){
       invariant(pv.plan_id!==null&&pv.plan_id===caseIdNum,"clinical_context_mismatch","Procedure is not linked to the specified treatment plan");
      }else if(pv.plan_id!==null){
       const linkedPlanRows=await client.query<{id:number;patient_id:number;primary_doctor_id:number|null}>("SELECT id,patient_id,primary_doctor_id FROM treatment_plans WHERE id=$1 FOR SHARE",[pv.plan_id]);
       const linkedPlan=linkedPlanRows.rows[0];
       invariant(linkedPlan&&linkedPlan.patient_id===pv.patient_id,"clinical_context_mismatch","Procedure plan link is inconsistent with patient");
       invariant(linkedPlan.primary_doctor_id===null||linkedPlan.primary_doctor_id===source.doctor_party_id,"clinical_context_forbidden","Procedure treatment plan belongs to a different doctor");
       verifiedCaseId=String(linkedPlan.id);
      }
      invariant(pv.doctor_id===null||pv.doctor_id===source.doctor_party_id,"clinical_context_forbidden","Procedure belongs to a different doctor");
      patientIdNum=pv.patient_id;
      verifiedProcedureId=String(pv.id);
      clinicalAttributionStatus="verified";
     }else{
      invariant(patientIdNum!==null,"clinical_context_mismatch","Procedure attribution requires a verified patient, visit, or treatment plan");
      verifiedProcedureId=rawProcedure;
      clinicalAttributionStatus="unmatched_pending_review";
     }
    }else{
     invariant(patientIdNum!==null,"clinical_context_mismatch","Procedure attribution requires a verified patient, visit, or treatment plan");
     verifiedProcedureId=rawProcedure;
     clinicalAttributionStatus="unmatched_pending_review";
    }
   }else{
    clinicalAttributionStatus="verified";
   }
   invariant(patientIdNum!==null,"clinical_context_mismatch","Clinical attribution requires a verified patient");
   const allowed=await doctorOwnsPatient(source.doctor_party_id,patientIdNum,client);
   invariant(allowed,"clinical_context_forbidden","Doctor is not authorized to attribute material consumption to this patient");
   verifiedPatientId=String(patientIdNum);
  }
  let movementId:number|null=null;
  if(input.kind==="consumed"||input.kind==="approved_waste"){
   const movementReason=`Custody ${input.kind} ${input.id}: ${input.reason}`;
   const movement=await client.query<{id:number}>("INSERT INTO inventory_movements(item_id,kind,qty,expiry_date,reason,created_by,unit_cost_minor,is_return) VALUES($1,'out',$2::numeric,$3::date,$4,$5,NULL,FALSE) RETURNING id",[lot.item_id,normalizedQty,lot.expiry_date,movementReason,actor.username]);
   movementId=movement.rows[0].id;
   await client.query("INSERT INTO inventory_movement_allocations(id,movement_id,lot_id,location_id,qty) VALUES($1,$2,$3,$4,$5::numeric)",[randomUUID(),movementId,lot.id,source.id,normalizedQty]);
  }
  const doc={id:input.id,usageKey,locationId:source.id,storeLocationId:storePlace?.id??null,lotId:lot.id,itemId:lot.item_id,kind:input.kind,baseQuantity:normalizedQty,quantityState,patientId:verifiedPatientId,visitId:verifiedVisitId,caseId:verifiedCaseId,procedureId:verifiedProcedureId,clinicalAttributionStatus,wasteApprovalId:rawWasteApprovalId,reason:input.reason};
  await client.query("INSERT INTO custody_usage_events(id,usage_key,location_id,store_location_id,lot_id,movement_id,kind,qty,quantity_state,patient_id,visit_id,case_id,procedure_id,waste_approval_id,reason,cost_snapshot,document,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18)",[input.id,usageKey,source.id,storePlace?.id??null,lot.id,movementId,input.kind,normalizedQty,quantityState,verifiedPatientId,verifiedVisitId,verifiedCaseId,verifiedProcedureId,rawWasteApprovalId,input.reason,JSON.stringify(lot.cost_snapshot),JSON.stringify(doc),actor.userId]);
  await writeInventoryAudit(client,actor,"custody_usage",input.id,input.kind,{locationId:source.id,storeLocationId:storePlace?.id??null,lotId:lot.id,baseQuantity:normalizedQty,quantityState,patientId:verifiedPatientId,visitId:verifiedVisitId,caseId:verifiedCaseId,procedureId:verifiedProcedureId,clinicalAttributionStatus});
  return {id:input.id,usageKey,kind:input.kind,locationId:source.id,storeLocationId:storePlace?.id??null,lotId:lot.id,baseQuantity:normalizedQty,clinicalAttributionStatus,movementId,clinicMovementEffects:movementId?1:0,payableEffects:0,cashEffects:0};
 });
}
export async function recordCustodyStocktake(actor:InventoryActor,key:string,input:CustodyStocktakeInput,authority?:CanonicalInventoryAuthority){
 uuid(input.id);uuid(input.lotId);reason(input.reason);
 if(!authority)await ready();return inventoryOperation(actor,key,"custody.stocktake",input,authority??false,async client=>{
  const who=await requireInventoryActor(client,actor,false);
  const places=await locations(client,[input.locationId]);const source=places[0];
  invariant(source?.is_active&&source.kind==="custody","location_forbidden","Stocktake requires an active doctor custody location");
  invariant(custodyOwnerAllowed(client,actor,who,source.doctor_party_id,"inventory.custody.dispatch"),"custody_owner_forbidden","Only the custody owner doctor or an administrator can record a custody stocktake");
  const stock=await lots(client,[input.lotId]);const lot=stock[0];invariant(lot,"not_found","Custody lot was not found");
  await lockItems(client,[lot.item_id]);const current=await balances(client);
  const precision=basePrecision(lot);const scale=10n**BigInt(3-precision);
  const expectedAtoms3=quantityAtoms(current.find(row=>row.lot_id===lot.id&&row.location_id===source.id)?.qty??"0",3,true);
  const countedAtoms3=quantityAtoms(input.countedQuantity,precision,true);
  const reconciliation=mapDomainCall(()=>reconcileCustody({openingAtoms:Number(expectedAtoms3/scale),events:[],countedAtoms:Number(countedAtoms3/scale)}));
  const diffAtoms3=countedAtoms3-expectedAtoms3;
  const differenceQuantity=diffAtoms3<0n?`-${quantityText(-diffAtoms3)}`:quantityText(diffAtoms3);
  const expectedQuantity=quantityText(expectedAtoms3);const countedQuantity=quantityText(countedAtoms3);
  const doc={id:input.id,locationId:source.id,lotId:lot.id,expectedQuantity,countedQuantity,differenceQuantity,reviewRequired:reconciliation.reviewRequired,automaticFinancialAdjustmentMinor:0,reason:input.reason};
  await client.query("INSERT INTO custody_stocktakes(id,location_id,lot_id,expected_qty,counted_qty,difference_qty,review_required,reason,document,created_by) VALUES($1,$2,$3,$4::numeric,$5::numeric,$6::numeric,$7,$8,$9::jsonb,$10)",[input.id,source.id,lot.id,expectedQuantity,countedQuantity,differenceQuantity,reconciliation.reviewRequired,input.reason,JSON.stringify(doc),actor.userId]);
  await writeInventoryAudit(client,actor,"custody_stocktake",input.id,"stocktake",doc);
  return {...doc,clinicMovementEffects:0,payableEffects:0,cashEffects:0};
 });
}
async function custodyLotHistory(client:Q,locationId:string,lot:Lot,currentBalanceText:string){
 const precision=basePrecision(lot);const scale=10n**BigInt(3-precision);
 const toUnits=(atoms3:bigint)=>Number(atoms3/scale);
 const inboundRows=await client.query<{inbound_qty:string;outbound_transfer_qty:string}>(`SELECT
  (COALESCE((SELECT SUM(a.accepted_qty) FROM inventory_transfer_ack_lines a JOIN inventory_transfer_lines l ON l.id=a.transfer_line_id JOIN inventory_transfers t ON t.id=l.transfer_id WHERE t.to_location_id=$1 AND l.lot_id=$2),0)
   + COALESCE((SELECT SUM(ma.qty) FROM inventory_movement_allocations ma JOIN inventory_movements m ON m.id=ma.movement_id WHERE ma.location_id=$1 AND ma.lot_id=$2 AND (m.kind='in' OR (m.kind='adjust' AND m.qty>0))),0))::text AS inbound_qty,
  GREATEST(COALESCE((SELECT SUM(l.qty) FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.id=l.transfer_id WHERE t.from_location_id=$1 AND l.lot_id=$2),0)
   - COALESCE((SELECT SUM(a.returned_qty) FROM inventory_transfer_ack_lines a JOIN inventory_transfer_lines l ON l.id=a.transfer_line_id JOIN inventory_transfers t ON t.id=l.transfer_id WHERE t.from_location_id=$1 AND l.lot_id=$2),0),0)::text AS outbound_transfer_qty`,[locationId,lot.id]);
 const usageRows=await client.query<{consumed_qty:string;waste_qty:string;returned_qty:string}>(`SELECT
  COALESCE(SUM(qty) FILTER(WHERE kind='consumed' AND quantity_state='confirmed'),0)::text AS consumed_qty,
  COALESCE(SUM(qty) FILTER(WHERE kind='approved_waste'),0)::text AS waste_qty,
  COALESCE(SUM(qty) FILTER(WHERE kind='returned_to_store'),0)::text AS returned_qty
  FROM custody_usage_events WHERE location_id=$1 AND lot_id=$2`,[locationId,lot.id]);
 const closedRows=await client.query<{closed_original_qty:string;closed_consumed_qty:string;closed_returned_qty:string;closed_waste_qty:string}>(`SELECT
  COALESCE(SUM(original_qty),0)::text AS closed_original_qty,
  COALESCE(SUM(consumed_qty),0)::text AS closed_consumed_qty,
  COALESCE(SUM(returned_qty),0)::text AS closed_returned_qty,
  COALESCE(SUM(waste_qty),0)::text AS closed_waste_qty
  FROM custody_package_closures WHERE location_id=$1 AND lot_id=$2`,[locationId,lot.id]);
 const totalInboundAtoms3=quantityAtoms(inboundRows.rows[0]?.inbound_qty??"0",3,true);
 const outboundTransferAtoms3=quantityAtoms(inboundRows.rows[0]?.outbound_transfer_qty??"0",3,true);
 const totalConsumedAtoms3=quantityAtoms(usageRows.rows[0]?.consumed_qty??"0",3,true);
 const totalWasteAtoms3=quantityAtoms(usageRows.rows[0]?.waste_qty??"0",3,true);
 const returnedStoreAtoms3=quantityAtoms(usageRows.rows[0]?.returned_qty??"0",3,true);
 const totalReturnedOrTransferredAtoms3=returnedStoreAtoms3+outboundTransferAtoms3;
 const closedOriginalAtoms3=quantityAtoms(closedRows.rows[0]?.closed_original_qty??"0",3,true);
 const closedConsumedAtoms3=quantityAtoms(closedRows.rows[0]?.closed_consumed_qty??"0",3,true);
 const closedReturnedAtoms3=quantityAtoms(closedRows.rows[0]?.closed_returned_qty??"0",3,true);
 const closedWasteAtoms3=quantityAtoms(closedRows.rows[0]?.closed_waste_qty??"0",3,true);
 const inboundAtoms3=totalInboundAtoms3>closedOriginalAtoms3?totalInboundAtoms3-closedOriginalAtoms3:0n;
 const consumedAtoms3=totalConsumedAtoms3>closedConsumedAtoms3?totalConsumedAtoms3-closedConsumedAtoms3:0n;
 const returnedOrTransferredAtoms3=totalReturnedOrTransferredAtoms3>closedReturnedAtoms3?totalReturnedOrTransferredAtoms3-closedReturnedAtoms3:0n;
 const wasteAtoms3=totalWasteAtoms3>closedWasteAtoms3?totalWasteAtoms3-closedWasteAtoms3:0n;
 const remainingAtoms3=quantityAtoms(currentBalanceText,3,true);
 return {
  precision,
  scale,
  totalInboundAtoms3,
  inboundAtoms3,
  consumedAtoms3,
  returnedOrTransferredAtoms3,
  wasteAtoms3,
  remainingAtoms3,
  originalQuantity:quantityText(inboundAtoms3),
  recordedConsumptionQuantity:quantityText(consumedAtoms3),
  returnedOrTransferredQuantity:quantityText(returnedOrTransferredAtoms3),
  approvedWasteQuantity:quantityText(wasteAtoms3),
  remainingQuantity:quantityText(remainingAtoms3),
  originalUnits:toUnits(inboundAtoms3),
  consumedUnits:toUnits(consumedAtoms3),
  returnedOrTransferredUnits:toUnits(returnedOrTransferredAtoms3),
  wasteUnits:toUnits(wasteAtoms3),
  remainingUnits:toUnits(remainingAtoms3),
 };
}
async function resolveLocationLotSources(client:Q,locationId:string,lotId:string){
 const srcRows=await client.query<{
  kind:"transfer_ack"|"mov_alloc";
  raw_id:string;
  canonical_id:string;
  ack_id:string|null;
  line_id:string|null;
  transfer_id:string|null;
  allocation_id:string|null;
  movement_id:string|null;
  accepted_qty:string;
  source_ts:string;
 }>(`SELECT * FROM (
  SELECT 'transfer_ack'::text AS kind,
   a.acknowledgement_id::text||':'||l.id::text AS raw_id,
   'transfer_ack:'||a.acknowledgement_id::text||':'||l.id::text AS canonical_id,
   a.acknowledgement_id::text AS ack_id,
   l.id::text AS line_id,
   t.id::text AS transfer_id,
   NULL::text AS allocation_id,
   NULL::text AS movement_id,
   a.accepted_qty::text AS accepted_qty,
   ack.created_at::text AS source_ts
  FROM inventory_transfer_ack_lines a
  JOIN inventory_transfer_acknowledgements ack ON ack.id=a.acknowledgement_id
  JOIN inventory_transfer_lines l ON l.id=a.transfer_line_id
  JOIN inventory_transfers t ON t.id=l.transfer_id
  WHERE t.to_location_id=$1 AND l.lot_id=$2 AND a.accepted_qty>0
  UNION ALL
  SELECT 'mov_alloc'::text AS kind,
   ma.id::text AS raw_id,
   'mov_alloc:'||ma.id::text AS canonical_id,
   NULL::text AS ack_id,
   NULL::text AS line_id,
   NULL::text AS transfer_id,
   ma.id::text AS allocation_id,
   m.id::text AS movement_id,
   ma.qty::text AS accepted_qty,
   COALESCE(gr.created_at,m.created_at)::text AS source_ts
  FROM inventory_movement_allocations ma
  JOIN inventory_movements m ON m.id=ma.movement_id
  LEFT JOIN stock_lots sl ON sl.id=ma.lot_id
  LEFT JOIN goods_receipt_lines grl ON grl.id=sl.receipt_line_id
  LEFT JOIN goods_receipts gr ON gr.id=grl.receipt_id
  WHERE ma.location_id=$1 AND ma.lot_id=$2 AND (m.kind='in' OR (m.kind='adjust' AND m.qty>0)) AND ma.qty>0
 ) inbound ORDER BY inbound.source_ts ASC,inbound.raw_id ASC`,[locationId,lotId]);
 const closureRows=await client.query<{
  id:string;
  package_id:string;
  evidence_event_id:string;
  original_qty:string;
  remaining_qty:string;
  document:Record<string,unknown>|null;
  created_at:string;
 }>(`SELECT id::text,package_id,evidence_event_id,original_qty::text AS original_qty,remaining_qty::text AS remaining_qty,document,created_at::text AS created_at
  FROM custody_package_closures
  WHERE location_id=$1 AND lot_id=$2
  ORDER BY created_at ASC,id ASC`,[locationId,lotId]);
 return resolveCustodyPackageSources({
  sources:srcRows.rows.map(row=>({
   kind:row.kind,
   rawId:row.raw_id,
   canonicalId:row.canonical_id,
   ackId:row.ack_id,
   lineId:row.line_id,
   transferId:row.transfer_id,
   allocationId:row.allocation_id,
   movementId:row.movement_id,
   acceptedQuantity:row.accepted_qty,
   sourceTs:row.source_ts,
  })),
  closures:closureRows.rows.map(row=>({
   id:row.id,
   packageId:row.package_id,
   evidenceEventId:row.evidence_event_id,
   originalQuantity:row.original_qty,
   remainingQuantity:row.remaining_qty,
   document:row.document,
   createdAt:row.created_at,
  })),
 });
}
async function verifyPackageSource(client:Q,pkgKey:string,locationId:string,lotId:string):Promise<{canonicalId:string;rawId:string;sourceQty:string|null;sourceTs:string|null;terminallyClosed:boolean}>{
 const normKey=canonicalCustodyReferenceKey(pkgKey);
 const resolved=await resolveLocationLotSources(client,locationId,lotId);
 const matched=matchCustodyPackageSource(resolved,pkgKey);
 if(matched){
  return {
   canonicalId:matched.canonicalId,
   rawId:matched.rawId,
   sourceQty:matched.openQuantity,
   sourceTs:matched.sourceTs,
   terminallyClosed:matched.terminallyClosed,
  };
 }
 const r=await client.query<{location_id:string;lot_id:string}>(`SELECT t.to_location_id AS location_id,l.lot_id::text AS lot_id
  FROM inventory_transfer_ack_lines a
  JOIN inventory_transfer_lines l ON l.id=a.transfer_line_id
  JOIN inventory_transfers t ON t.id=l.transfer_id
  WHERE a.accepted_qty>0 AND (
   $1 IN (l.id::text,a.acknowledgement_id::text,t.id::text,'pkg:'||l.id::text,'pkg:'||a.acknowledgement_id::text,'pkg:'||t.id::text,a.acknowledgement_id::text||':'||l.id::text,'pkg:'||a.acknowledgement_id::text||':'||l.id::text,'transfer_ack:'||a.acknowledgement_id::text||':'||l.id::text,'transfer_line:'||l.id::text)
   OR $2 IN (l.id::text,a.acknowledgement_id::text,t.id::text,a.acknowledgement_id::text||':'||l.id::text)
  )
  UNION ALL
  SELECT ma.location_id,ma.lot_id::text AS lot_id
  FROM inventory_movement_allocations ma
  JOIN inventory_movements m ON m.id=ma.movement_id
  WHERE (m.kind='in' OR (m.kind='adjust' AND m.qty>0)) AND ma.qty>0 AND ($1 IN (ma.id::text,'pkg:'||ma.id::text,'mov:'||m.id::text,'mov_alloc:'||ma.id::text) OR $2 IN (ma.id::text,m.id::text))`,[pkgKey,normKey]);
 invariant(r.rows.length>0,"invalid_package_source","Package identifier does not match any server-recorded custody receipt or transfer line");
 throw new InventoryDomainError("package_source_mismatch","Package identifier belongs to a different custody location or lot");
}
async function verifyPackageEvidence(client:Q,evKey:string,locationId:string,lotId:string):Promise<{canonicalId:string;rawId:string;kind:string;evTs:string|null}>{
 const normKey=canonicalCustodyReferenceKey(evKey);
 const r=await client.query<{location_id:string;lot_id:string;canonical_id?:string;raw_id?:string;ev_kind?:string;ev_ts?:string}>(`SELECT u.location_id,u.lot_id::text AS lot_id,'usage:'||u.id::text AS canonical_id,u.id::text AS raw_id,u.kind::text AS ev_kind,u.created_at::text AS ev_ts
  FROM custody_usage_events u WHERE $1 IN (u.id::text,u.usage_key,'ev:'||u.id::text,'ev:'||u.usage_key,'usage:'||u.id::text) OR $2 IN (u.id::text,u.usage_key)
  UNION ALL
  SELECT s.location_id,s.lot_id::text AS lot_id,'stocktake:'||s.id::text AS canonical_id,s.id::text AS raw_id,'stocktake' AS ev_kind,s.created_at::text AS ev_ts
  FROM custody_stocktakes s WHERE $1 IN (s.id::text,'ev:'||s.id::text,'stocktake:'||s.id::text) OR $2=s.id::text
  UNION ALL
  SELECT w.location_id,w.lot_id::text AS lot_id,
   COALESCE((SELECT 'usage:'||u.id::text FROM custody_usage_events u WHERE u.waste_approval_id=w.id::text AND u.kind='approved_waste' ORDER BY u.created_at DESC,u.id LIMIT 1),'waste_approval:'||w.id::text) AS canonical_id,
   COALESCE((SELECT u.id::text FROM custody_usage_events u WHERE u.waste_approval_id=w.id::text AND u.kind='approved_waste' ORDER BY u.created_at DESC,u.id LIMIT 1),w.id::text) AS raw_id,
   CASE WHEN EXISTS (SELECT 1 FROM custody_usage_events u WHERE u.waste_approval_id=w.id::text AND u.kind='approved_waste') THEN 'executed_waste_approval' ELSE 'unexecuted_waste_approval' END AS ev_kind,
   COALESCE((SELECT u.created_at::text FROM custody_usage_events u WHERE u.waste_approval_id=w.id::text AND u.kind='approved_waste' ORDER BY u.created_at DESC,u.id LIMIT 1),w.created_at::text) AS ev_ts
  FROM custody_waste_approvals w WHERE $1 IN (w.id::text,'ev:'||w.id::text,'waste_approval:'||w.id::text) OR $2=w.id::text
  UNION ALL
  SELECT t.from_location_id AS location_id,l.lot_id::text AS lot_id,'transfer_out:'||l.id::text AS canonical_id,l.id::text AS raw_id,'transfer_out' AS ev_kind,t.created_at::text AS ev_ts
  FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.id=l.transfer_id
  WHERE $1 IN (l.id::text,t.id::text,'ev:'||l.id::text,'ev:'||t.id::text,'transfer_out:'||l.id::text) OR $2 IN (l.id::text,t.id::text)`,[evKey,normKey]);
 invariant(r.rows.length>0,"invalid_package_evidence","Evidence event identifier does not match any server-recorded custody usage, stocktake, or waste event");
 const matching=r.rows.filter(row=>row.location_id===locationId&&row.lot_id===lotId);
 invariant(matching.length>0,"package_evidence_mismatch","Evidence event belongs to a different doctor custody location or lot");
 invariant(matching.length===1,"ambiguous_package_evidence","Evidence identifier matches multiple records; specify the exact event ID");
 const matched=matching[0];
 return {
  canonicalId:matched.canonical_id??`ev:${normKey}`,
  rawId:matched.raw_id??normKey,
  kind:matched.ev_kind??"consumed",
  evTs:matched.ev_ts??null,
 };
}
export async function closeCustodyPackage(actor:InventoryActor,key:string,input:CustodyPackageClosureInput,authority?:CanonicalInventoryAuthority){
 uuid(input.id);uuid(input.lotId);reason(input.reason);
 invariant(typeof input.packageId==="string"&&input.packageId.trim().length>0&&input.packageId.trim().length<=240,"invalid_document_id","A packageId is required");
 invariant(typeof input.evidenceEventId==="string"&&input.evidenceEventId.trim().length>0&&input.evidenceEventId.trim().length<=240,"invalid_document_id","An evidenceEventId is required");
 if(!authority)await ready();return inventoryOperation(actor,key,"custody.close_package",input,authority??false,async client=>{
  const who=await requireInventoryActor(client,actor,false);
  const places=await locations(client,[input.locationId]);const source=places[0];
  invariant(source?.is_active&&source.kind==="custody","location_forbidden","Package closure requires an active doctor custody location");
  invariant(custodyOwnerAllowed(client,actor,who,source.doctor_party_id,"inventory.custody.dispatch"),"custody_owner_forbidden","Only the custody owner doctor or an administrator can close a custody package");
  const stock=await lots(client,[input.lotId]);const lot=stock[0];invariant(lot,"not_found","Custody lot was not found");
  await lockItems(client,[lot.item_id]);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`custody.lot_loc:${source.id}:${lot.id}`]);
  const pkgKey=input.packageId.trim();const evKey=input.evidenceEventId.trim();
  const current=await balances(client);
  const currentBalanceText=current.find(row=>row.lot_id===lot.id&&row.location_id===source.id)?.qty??"0";
  const history=await custodyLotHistory(client,source.id,lot,currentBalanceText);
  invariant(history.totalInboundAtoms3>0n,"lot_not_in_custody_location","Lot was never allocated to this custody location");
  const defaultSafety=classifyDefaultPackageSafety({name:lot.name,category:lot.category,unit:lot.unit,costSnapshot:lot.cost_snapshot});
  const resolvedSafety=mapDomainCall(()=>resolvePackageSafetyWithFieldObservation({
   minimumHazard:defaultSafety.minimumHazard,
   defaultPolicy:defaultSafety.defaultPolicy,
   observedHazard:input.hazard,
   requestedPolicy:input.policy,
  }));
  const resolvedSource=await verifyPackageSource(client,pkgKey,source.id,lot.id);
  const resolvedEvidence=await verifyPackageEvidence(client,evKey,source.id,lot.id);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`custody.pkg:${resolvedSource.rawId}`]);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`custody.ev:${resolvedEvidence.rawId}`]);
  const priorRows=await client.query<{package_id:string;evidence_event_id:string}>("SELECT package_id,evidence_event_id FROM custody_package_closures WHERE location_id=$1 AND lot_id=$2 OR package_id=$3 OR evidence_event_id=$4 FOR SHARE",[source.id,lot.id,resolvedSource.rawId,resolvedEvidence.rawId]);
  const toUnits=(val:string)=>Number(quantityAtoms(val,history.precision,true)/history.scale);
  const sourceOpenUnits=resolvedSource.sourceQty!==null?toUnits(resolvedSource.sourceQty):null;
  if(resolvedSource.terminallyClosed||priorRows.rows.some(row=>!row.package_id.startsWith("checkpoint:")&&canonicalCustodyReferenceKey(row.package_id)===resolvedSource.rawId)||priorRows.rows.some(row=>canonicalCustodyReferenceKey(row.evidence_event_id)===resolvedEvidence.rawId)||history.inboundAtoms3<=0n||(sourceOpenUnits!==null&&sourceOpenUnits<=0)){
   throw new InventoryDomainError("package_or_evidence_already_closed","Package source, evidence event, or lot custody tranche was already closed");
  }
  invariant(pkgKey!==evKey&&resolvedSource.rawId!==resolvedEvidence.rawId&&resolvedSource.canonicalId!==resolvedEvidence.canonicalId,"invalid_package_evidence","Package source and evidence event must be distinct server records");
  if(resolvedSource.sourceTs&&resolvedEvidence.evTs){
   const tsOrder=await client.query<{valid_order:boolean}>("SELECT ($1::timestamptz >= $2::timestamptz) AS valid_order",[resolvedEvidence.evTs,resolvedSource.sourceTs]);
   invariant(tsOrder.rows[0]?.valid_order===true,"package_evidence_mismatch","Evidence event occurred before the selected package source was received");
  }
  const submittedOriginal=toUnits(input.originalQuantity);
  const submittedConsumed=toUnits(input.recordedConsumptionQuantity);
  const submittedReturned=toUnits(input.returnedOrTransferredQuantity);
  const submittedWaste=toUnits(input.approvedWasteQuantity);
  const submittedRemaining=toUnits(input.remainingQuantity);
  invariant(resolvedEvidence.kind!=="unexecuted_waste_approval","package_evidence_mismatch","Unexecuted waste approval cannot serve as package closure evidence");
  if(resolvedEvidence.kind==="consumed"){
   invariant(submittedConsumed>0,"package_evidence_mismatch","Consumption evidence requires a positive recordedConsumptionQuantity on the closed tranche");
   const evCum=await client.query<{unretired:boolean}>(
    `SELECT COALESCE((
       SELECT SUM(u2.qty) FROM custody_usage_events u2
       WHERE u2.location_id=$1 AND u2.lot_id=$2 AND u2.kind='consumed' AND u2.quantity_state='confirmed'
         AND (u2.created_at < u.created_at OR (u2.created_at = u.created_at AND u2.id <= u.id))
     ),0) > COALESCE((
       SELECT MAX(
         GREATEST(
           COALESCE((
             SELECT SUM(c2.consumed_qty) FROM custody_package_closures c2
             WHERE c2.location_id=$1 AND c2.lot_id=$2
               AND (c2.created_at < c.created_at OR (c2.created_at = c.created_at AND c2.id <= c.id))
           ),0) - COALESCE((
             SELECT SUM(u3.qty) FROM custody_usage_events u3
             WHERE u3.location_id=$1 AND u3.lot_id=$2 AND u3.kind='consumed' AND u3.quantity_state='confirmed'
               AND (u3.created_at > u.created_at OR (u3.created_at = u.created_at AND u3.id > u.id))
               AND u3.created_at <= c.created_at
           ),0),
           0
         )
       ) FROM custody_package_closures c
       WHERE c.location_id=$1 AND c.lot_id=$2
     ),0) AS unretired
     FROM custody_usage_events u WHERE u.id=$3::uuid`,
    [source.id,lot.id,resolvedEvidence.rawId],
   );
   invariant(evCum.rows[0]?.unretired===true,"package_evidence_mismatch","Consumption evidence was already accounted for in an earlier tranche closure");
  }else if(resolvedEvidence.kind==="approved_waste"||resolvedEvidence.kind==="executed_waste_approval"){
   invariant(submittedWaste>0,"package_evidence_mismatch","Waste evidence requires a positive approvedWasteQuantity on the closed tranche");
   const evCum=await client.query<{unretired:boolean}>(
    `SELECT COALESCE((
       SELECT SUM(u2.qty) FROM custody_usage_events u2
       WHERE u2.location_id=$1 AND u2.lot_id=$2 AND u2.kind='approved_waste'
         AND (u2.created_at < u.created_at OR (u2.created_at = u.created_at AND u2.id <= u.id))
     ),0) > COALESCE((
       SELECT MAX(
         GREATEST(
           COALESCE((
             SELECT SUM(c2.waste_qty) FROM custody_package_closures c2
             WHERE c2.location_id=$1 AND c2.lot_id=$2
               AND (c2.created_at < c.created_at OR (c2.created_at = c.created_at AND c2.id <= c.id))
           ),0) - COALESCE((
             SELECT SUM(u3.qty) FROM custody_usage_events u3
             WHERE u3.location_id=$1 AND u3.lot_id=$2 AND u3.kind='approved_waste'
               AND (u3.created_at > u.created_at OR (u3.created_at = u.created_at AND u3.id > u.id))
               AND u3.created_at <= c.created_at
           ),0),
           0
         )
       ) FROM custody_package_closures c
       WHERE c.location_id=$1 AND c.lot_id=$2
     ),0) AS unretired
     FROM custody_usage_events u WHERE u.id=$3::uuid`,
    [source.id,lot.id,resolvedEvidence.rawId],
   );
   invariant(evCum.rows[0]?.unretired===true,"package_evidence_mismatch","Waste evidence was already accounted for in an earlier tranche closure");
  }else if(resolvedEvidence.kind==="returned_to_store"||resolvedEvidence.kind==="transfer_out"){
   invariant(submittedReturned>0,"package_evidence_mismatch","Return/transfer evidence requires a positive returnedOrTransferredQuantity on the closed tranche");
  }
  const retiredOriginal=submittedOriginal-submittedRemaining;
  const remainingOpenOriginal=history.originalUnits-retiredOriginal;
  const remainingOpenConsumed=history.consumedUnits-submittedConsumed;
  const remainingOpenReturned=history.returnedOrTransferredUnits-submittedReturned;
  const remainingOpenWaste=history.wasteUnits-submittedWaste;
  const remainingOpenBalance=history.remainingUnits-submittedRemaining;
  const singleTranche=submittedOriginal===history.originalUnits;
  invariant(
   submittedOriginal>0&&
   submittedOriginal<=history.originalUnits&&
   (sourceOpenUnits===null||submittedOriginal===sourceOpenUnits)&&
   (singleTranche
    ?(submittedConsumed===history.consumedUnits&&
      submittedReturned===history.returnedOrTransferredUnits&&
      submittedWaste===history.wasteUnits&&
      submittedRemaining<=history.remainingUnits)
    :(submittedConsumed<=history.consumedUnits&&
      submittedReturned<=history.returnedOrTransferredUnits&&
      submittedWaste<=history.wasteUnits&&
      submittedRemaining<=history.remainingUnits&&
      remainingOpenConsumed+remainingOpenReturned+remainingOpenWaste+remainingOpenBalance<=remainingOpenOriginal)),
   "package_history_mismatch",
   "Submitted package closure quantities contradict server custody history",
  );
  const expectedAction=mapDomainCall(()=>packageEvidenceAction(resolvedSafety.effectiveHazard,resolvedSafety.effectivePolicy));
  const disposalEvidenceVerified=input.evidenceAction==="document_safe_disposal"&&(resolvedEvidence.kind==="approved_waste"||resolvedEvidence.kind==="executed_waste_approval");
  const plan=mapDomainCall(()=>reconcileEmptyPackage({
   packageId:resolvedSource.rawId,
   evidenceEventId:resolvedEvidence.rawId,
   previousClosures:priorRows.rows.map(row=>({packageId:row.package_id,evidenceEventId:row.evidence_event_id})),
   hazard:resolvedSafety.effectiveHazard,
   policy:resolvedSafety.effectivePolicy,
   evidenceAction:input.evidenceAction??expectedAction,
   disposalEvidenceVerified,
   originalAtoms:submittedOriginal,
   recordedConsumptionAtoms:submittedConsumed,
   returnedOrTransferredAtoms:submittedReturned,
   approvedWasteAtoms:submittedWaste,
   remainingAtoms:submittedRemaining,
  }));
  const isTerminal=submittedRemaining===0;
  const persistedPackageId=isTerminal?resolvedSource.rawId:`checkpoint:${input.id}:${resolvedSource.rawId}`;
  const submittedOriginalText=quantityText(BigInt(submittedOriginal)*history.scale);
  const retiredOriginalText=quantityText(BigInt(Math.max(0,retiredOriginal))*history.scale);
  const submittedConsumedText=quantityText(BigInt(submittedConsumed)*history.scale);
  const submittedReturnedText=quantityText(BigInt(submittedReturned)*history.scale);
  const submittedWasteText=quantityText(BigInt(submittedWaste)*history.scale);
  const submittedRemainingText=quantityText(BigInt(submittedRemaining)*history.scale);
  const doc={id:input.id,locationId:source.id,lotId:lot.id,hazard:resolvedSafety.effectiveHazard,policy:resolvedSafety.effectivePolicy,canonicalPackageSourceId:resolvedSource.canonicalId,canonicalEvidenceId:resolvedEvidence.canonicalId,evidenceKind:resolvedEvidence.kind,originalQuantity:submittedOriginalText,retiredOriginalQuantity:retiredOriginalText,recordedConsumptionQuantity:submittedConsumedText,returnedOrTransferredQuantity:submittedReturnedText,approvedWasteQuantity:submittedWasteText,remainingQuantity:submittedRemainingText,...plan,reason:input.reason};
  await client.query("INSERT INTO custody_package_closures(id,package_id,evidence_event_id,location_id,lot_id,hazard,policy,evidence_action,original_qty,consumed_qty,returned_qty,waste_qty,remaining_qty,unexplained_atoms,review_required,reason,document,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10::numeric,$11::numeric,$12::numeric,$13::numeric,$14,$15,$16,$17::jsonb,$18)",[input.id,persistedPackageId,resolvedEvidence.rawId,source.id,lot.id,resolvedSafety.effectiveHazard,resolvedSafety.effectivePolicy,plan.evidenceAction,retiredOriginalText,submittedConsumedText,submittedReturnedText,submittedWasteText,submittedRemainingText,plan.unexplainedAtoms,plan.reviewRequired,input.reason,JSON.stringify(doc),actor.userId]);
  await writeInventoryAudit(client,actor,"custody_package",input.id,"close_package",doc);
  return {...doc,clinicMovementEffects:0,payableEffects:0,cashEffects:0};
 });
}
function parseSettlementPeriodBounds(periodId:string):{startIso:string;endIso:string}{
 const m=/^(\d{4})(?:-(annual|Q([1-4])|(0[1-9]|1[0-2])))?$/.exec(periodId);
 invariant(m,"invalid_period_id","Settlement periodId must be YYYY, YYYY-annual, YYYY-Q1..Q4, or YYYY-MM");
 const year=Number(m[1]);
 invariant(year>=2020&&year<=2100,"invalid_period_id","Settlement period year is out of range");
 if(!m[2]||m[2]==="annual"){
  return {startIso:`${year}-01-01T00:00:00.000Z`,endIso:`${year+1}-01-01T00:00:00.000Z`};
 }
 if(m[3]){
  const q=Number(m[3]);
  const startMonth=(q-1)*3+1;
  const endYear=q===4?year+1:year;
  const endMonth=q===4?1:startMonth+3;
  return {
   startIso:`${year}-${String(startMonth).padStart(2,"0")}-01T00:00:00.000Z`,
   endIso:`${endYear}-${String(endMonth).padStart(2,"0")}-01T00:00:00.000Z`,
  };
 }
 const month=Number(m[4]);
 const endYear=month===12?year+1:year;
 const endMonth=month===12?1:month+1;
 return {
  startIso:`${year}-${String(month).padStart(2,"0")}-01T00:00:00.000Z`,
  endIso:`${endYear}-${String(endMonth).padStart(2,"0")}-01T00:00:00.000Z`,
 };
}
export async function proposeAnnualCustodySettlement(actor:InventoryActor,key:string,input:CustodySettlementProposalInput,authority?:CanonicalInventoryAuthority){
 uuid(input.id);reason(input.reason);
 invariant(Number.isSafeInteger(input.doctorPartyId)&&input.doctorPartyId>0,"invalid_identifier","A positive doctorPartyId is required");
 invariant(typeof input.periodId==="string"&&input.periodId.trim().length>0&&input.periodId.trim().length<=120,"invalid_identifier","A bounded periodId is required");
 const rawPeriodId=input.periodId.trim();
 const bounds=parseSettlementPeriodBounds(rawPeriodId);
 const periodId=canonicalSettlementPeriodId(rawPeriodId);
 requireCurrency(input.currency,"custody_settlement",input.id);
 if(!authority)await ready();return inventoryOperation(actor,key,"custody.propose_settlement",input,authority??true,async client=>{
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[JSON.stringify(["custody.settlement.scope",input.doctorPartyId,periodId,input.currency])]);
  const party=await client.query<{kind:string;is_active:boolean}>("SELECT kind,is_active FROM parties WHERE id=$1 FOR SHARE",[input.doctorPartyId]);
  invariant(party.rows[0]?.kind==="doctor"&&party.rows[0]?.is_active,"doctor_unavailable","Settlement must target an active doctor party");
  const doctorLocations=await client.query<{id:string}>("SELECT id FROM inventory_locations WHERE branch_key=$1 AND kind='custody' AND doctor_party_id=$2 ORDER BY id FOR SHARE",[INVENTORY_CLINIC_SCOPE,input.doctorPartyId]);
  const locIds=doctorLocations.rows.map(row=>row.id);
  const usageRows=locIds.length
   ? (await client.query<{id:string;lot_id:string;kind:string;qty:string;quantity_state:string;cost_snapshot:Record<string,unknown>;document:Record<string,unknown>}>(
      "SELECT id::text,lot_id::text,kind,qty::text,quantity_state,cost_snapshot,document FROM custody_usage_events WHERE location_id=ANY($1::text[]) AND kind IN ('consumed','approved_waste') AND created_at>=$2::timestamptz AND created_at<$3::timestamptz ORDER BY created_at,id FOR SHARE",
      [locIds,bounds.startIso,bounds.endIso],
     )).rows
   : [];
  const stocktakeIssues=locIds.length
   ? (await client.query<{cnt:number}>("SELECT COUNT(*)::int AS cnt FROM custody_stocktakes WHERE location_id=ANY($1::text[]) AND review_required=TRUE",[locIds])).rows[0]?.cnt??0
   : 0;
  const ledger=await ledgerRows(client);
  const ledgerComplete=ledger.every(reconciled);
  const allLots=usageRows.length?await lots(client,[...new Set(usageRows.map(r=>r.lot_id))]):[];
  let serverConsumptionMinor=0;
  let consumptionSourcesComplete=true;
  for(const u of usageRows){
   if(u.quantity_state!=="confirmed"||u.document?.clinicalAttributionStatus==="unmatched_pending_review"){
    consumptionSourcesComplete=false;
    continue;
   }
   const lot=allLots.find(l=>l.id===u.lot_id);
   if(!lot){consumptionSourcesComplete=false;continue;}
   const quote=roundedQuote(lot,u.qty);
   if(!quote||quote.currency!==input.currency||lot.cost_status!=="known"){
    consumptionSourcesComplete=false;
    continue;
   }
   serverConsumptionMinor+=quote.amountMinor;
  }
  if(usageRows.length>0&&consumptionSourcesComplete&&input.attributableConsumptionMinor!==null&&input.attributableConsumptionMinor!==undefined){
   invariant(
    input.attributableConsumptionMinor===serverConsumptionMinor,
    "settlement_source_mismatch",
    "Submitted attributable consumption contradicts server-recorded custody usage",
   );
  }
  // Unposted proposals in custody_annual_settlements are worksheets/proposals, NOT posted financial entries.
  // Never subtract unposted/provisional/objected proposals as priorAdjustments (R01).
  // Furthermore, until an authoritative commission deduction ledger adapter is integrated and all
  // stocktake/cost/consumption sources are complete, proposals remain provisional worksheets (R02).
  const hasAuthoritativeDeductionAdapter=false;
  const serverPrerequisitesComplete=
   hasAuthoritativeDeductionAdapter&&
   ledgerComplete&&
   stocktakeIssues===0&&
   usageRows.length>0&&
   consumptionSourcesComplete;
  const scope={doctorId:String(input.doctorPartyId),periodId};
  const proposal=mapDomainCall(()=>proposeSettlement({
   scope,
   deductions:{currency:input.currency,amountMinor:input.appliedDeductionsMinor},
   attributable:input.attributableConsumptionMinor===null?null:{currency:input.currency,amountMinor:input.attributableConsumptionMinor},
   prerequisitesComplete:serverPrerequisitesComplete,
   sourceBacked:serverPrerequisitesComplete,
   priorAdjustments:[],
  }));
  const doc={
   id:input.id,
   doctorPartyId:input.doctorPartyId,
   periodId,
   periodBounds:bounds,
   currency:proposal.currency,
   appliedDeductionsMinor:input.appliedDeductionsMinor,
   attributableConsumptionMinor:input.attributableConsumptionMinor,
   serverVerifiedConsumptionMinor:consumptionSourcesComplete&&usageRows.length>0?serverConsumptionMinor:null,
   unresolvedStocktakes:stocktakeIssues,
   sourceStatus:"provisional_manual_worksheet" as const,
   targetDifferenceMinor:proposal.targetDifferenceMinor,
   priorAdjustmentMinor:proposal.priorAdjustmentMinor,
   supplementalMinor:proposal.supplementalMinor,
   direction:proposal.direction,
   status:proposal.status,
   cashDeltaMinor:0,
   automaticWageDeductionMinor:0,
   reason:input.reason,
  };
  await client.query("INSERT INTO custody_annual_settlements(id,doctor_party_id,period_id,currency,applied_deductions_minor,attributable_consumption_minor,supplemental_minor,direction,status,reason,document,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)",[input.id,input.doctorPartyId,periodId,proposal.currency,input.appliedDeductionsMinor,input.attributableConsumptionMinor,proposal.supplementalMinor,proposal.direction,proposal.status,input.reason,JSON.stringify(doc),actor.userId]);
  await writeInventoryAudit(client,actor,"custody_settlement",input.id,"propose",{doctorPartyId:input.doctorPartyId,periodId,currency:proposal.currency,direction:proposal.direction,status:proposal.status,sourceStatus:doc.sourceStatus});
  return {...doc,clinicMovementEffects:0,payableEffects:0,cashEffects:0};
 });
}
export async function objectCustodySettlement(actor:InventoryActor,key:string,input:CustodySettlementObjectionInput,authority?:CanonicalInventoryAuthority){
 uuid(input.id);uuid(input.settlementId);reason(input.reason);
 if(!authority)await ready();return inventoryOperation(actor,key,"custody.object_settlement",input,authority??false,async client=>{
  const who=await requireInventoryActor(client,actor,false);
  const settlementRows=await client.query<{id:string;doctor_party_id:number;period_id:string}>("SELECT id::text,doctor_party_id,period_id FROM custody_annual_settlements WHERE id=$1 FOR SHARE",[input.settlementId]);
  const settlement=settlementRows.rows[0];invariant(settlement,"not_found","Custody settlement proposal was not found");
  invariant(custodyOwnerAllowed(client,actor,who,settlement.doctor_party_id,"inventory.custody.settlement.propose"),"custody_owner_forbidden","Only the settlement doctor or an administrator can record an objection");
  await client.query("INSERT INTO custody_settlement_objections(id,settlement_id,actor_id,reason) VALUES($1,$2,$3,$4)",[input.id,settlement.id,actor.userId,input.reason]);
  await writeInventoryAudit(client,actor,"custody_settlement",settlement.id,"object",{objectionId:input.id,reason:input.reason});
  return {id:input.id,settlementId:settlement.id,status:"objected_under_review" as const,clinicMovementEffects:0,payableEffects:0,cashEffects:0};
 });
}
function roundedQuote(lot:Lot,quantity:string):{currency:Currency;amountMinor:number}|null{
 try{const price=lot.cost_snapshot.price as {state:string;currency:string;unitPriceMinor:number};const conversion=lot.cost_snapshot.conversion as {baseUnitsPerEnteredUnit:string};const currency=lot.cost_snapshot.currency as Currency;
  if(!price||price.state!=="known"||!["YER","SAR","USD"].includes(currency)||price.currency!==currency||!Number.isSafeInteger(price.unitPriceMinor)||price.unitPriceMinor<0)return null;
  const factor=decimalRatio(conversion.baseUnitsPerEnteredUnit);if(factor.numerator<=0n)return null;const numerator=BigInt(price.unitPriceMinor)*quantityAtoms(quantity,3,true)*factor.denominator,denominator=1000n*factor.numerator;const rounded=(numerator*2n+denominator)/(denominator*2n);if(rounded>BigInt(Number.MAX_SAFE_INTEGER))return null;return {currency,amountMinor:Number(rounded)};
 }catch{return null;}
}
/** Who may see what in one custody statement. Legacy derives it from the role;
 * canonical derives it from current grants and the validated clinician link. */
interface CustodyViewer{readonly oversight:boolean;readonly partyId:number|null;readonly prices:boolean;readonly reconcile:boolean}
export async function readDoctorCustody(actor:InventoryActor,offset=0){invariant(Number.isSafeInteger(offset)&&offset>=0&&offset<=100000,"invalid_page","Invalid page offset");await ready();return withTransaction(getPool(),async client=>{
 await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
 const who=await requireInventoryActor(client,actor,false);const admin=actor.role==="admin";
 return readCustodyStatement(client,{oversight:admin,partyId:actor.role==="doctor"?who.party_id:null,prices:admin,reconcile:admin},offset,true);
 });}
/** Canonical custody statement in one owning RR READ ONLY snapshot
 * (`inventory.custody.view`). All locations: `inventory.custody.dispatch`; otherwise
 * only the actor's validated linked doctor custody. Values: `inventory.costs.view`.
 * Reconciliation backlog: `inventory.reconcile`. No ensureSchema, DDL or row locks. */
export async function readDoctorCustodyCanonical(session:VerifiedDurableSession,offset=0){invariant(Number.isSafeInteger(offset)&&offset>=0&&offset<=100000,"invalid_page","Invalid page offset");requireInventoryIntegration();
 return runCanonicalReadSnapshot(session,"inventory.custody.view",async(client,scope)=>{
  const present=await client.query<{present:boolean}>("SELECT to_regclass('inventory_transfers') IS NOT NULL AS present");invariant(present.rows[0]?.present,"schema_not_ready","Doctor custody schema awaits coordinated migration");
  return readCustodyStatement(client,{oversight:scope.granted("inventory.custody.dispatch"),partyId:scope.clinicianPartyId,prices:scope.granted("inventory.costs.view"),reconcile:scope.granted("inventory.reconcile")},offset,false);
 },{errorPrefix:"STAFF_READ",maxBytes:INVENTORY_READ_MAX_BYTES});}
async function readCustodyStatement(client:Q,viewer:CustodyViewer,offset:number,lock:boolean){
 invariant(viewer.oversight||viewer.partyId!==null,"custody_read_forbidden","Custody statements are limited to the doctor owner or administrator");
 const allLocations=await locations(client,undefined,lock);const visible=allLocations.filter(row=>viewer.oversight||(row.kind==="custody"&&row.doctor_party_id===viewer.partyId));const visibleIds=visible.map(row=>row.id);const stock=await lots(client);const current=await balances(client);const today=clinicDateString(new Date(),CLINIC_ZONE_FALLBACK);const ledger=await ledgerRows(client);const incomplete=new Set(ledger.filter(row=>!reconciled(row)).map(row=>row.id));
 const values=new Map<string,{currency:Currency;amountMinor:number}>();if(viewer.prices)for(const lot of stock){const rows=current.filter(row=>row.lot_id===lot.id&&quantityAtoms(row.qty,3,true)>0n);if(!rows.length)continue;const total=rows.reduce((sum,row)=>sum+quantityAtoms(row.qty),0n);const quote=roundedQuote(lot,quantityText(total));if(quote)for(const share of allocateMinor(quote.amountMinor,rows.map(row=>({id:row.location_id,weight:String(quantityAtoms(row.qty))}))))values.set(`${lot.id}:${share.id}`,{currency:quote.currency,amountMinor:share.amountMinor});}
 const transfers=await client.query<{id:string;from_location_id:string;to_location_id:string;transit_location_id:string;reason:string;created_at:Date}>(`SELECT t.id,t.from_location_id,t.to_location_id,t.transit_location_id,t.reason,t.created_at FROM inventory_transfers t WHERE (t.to_location_id=ANY($1::text[]) OR ($2 AND t.from_location_id=ANY($1::text[]))) AND EXISTS (SELECT 1 FROM inventory_transfer_lines l WHERE l.transfer_id=t.id AND l.qty>COALESCE((SELECT SUM(a.accepted_qty+a.returned_qty) FROM inventory_transfer_ack_lines a WHERE a.transfer_line_id=l.id),0)) ORDER BY t.created_at DESC,t.id LIMIT 21 OFFSET $3`,[visibleIds,viewer.oversight,offset]);
 const pending=[];for(const transfer of transfers.rows.slice(0,20)){const lines=await client.query<{id:string;lot_id:string;remaining:string}>(`SELECT l.id,l.lot_id,(l.qty-COALESCE((SELECT SUM(a.accepted_qty+a.returned_qty) FROM inventory_transfer_ack_lines a WHERE a.transfer_line_id=l.id),0))::text AS remaining FROM inventory_transfer_lines l WHERE transfer_id=$1 ORDER BY id`,[transfer.id]);const open=lines.rows.filter(line=>quantityAtoms(line.remaining,3,true)>0n);if(open.length)pending.push({id:transfer.id,reason:transfer.reason,fromLabel:allLocations.find(row=>row.id===transfer.from_location_id)?.label??"",destinationLabel:allLocations.find(row=>row.id===transfer.to_location_id)?.label??"",createdAt:transfer.created_at.toISOString(),lines:open.map(line=>({id:line.id,lotId:line.lot_id,name:stock.find(row=>row.id===line.lot_id)?.name??"",unit:stock.find(row=>row.id===line.lot_id)?.unit??"",remainingQuantity:quantityText(quantityAtoms(line.remaining))}))});}
  const usageRows=visibleIds.length?(await client.query<{id:string;usage_key:string;location_id:string;store_location_id:string|null;lot_id:string;kind:string;qty:string;quantity_state:string;patient_id:string|null;visit_id:string|null;case_id:string|null;procedure_id:string|null;clinical_attribution_status:string|null;reason:string;created_at:Date}>("SELECT id::text,usage_key,location_id,store_location_id,lot_id::text,kind,qty::text,quantity_state,patient_id,visit_id,case_id,procedure_id,document->>'clinicalAttributionStatus' AS clinical_attribution_status,reason,created_at FROM custody_usage_events WHERE location_id=ANY($1::text[]) ORDER BY created_at DESC,id LIMIT 25",[visibleIds])).rows:[];
 const stocktakeRows=visibleIds.length?(await client.query<{id:string;location_id:string;lot_id:string;expected_qty:string;counted_qty:string;difference_qty:string;review_required:boolean;reason:string;created_at:Date}>("SELECT id::text,location_id,lot_id::text,expected_qty::text,counted_qty::text,difference_qty::text,review_required,reason,created_at FROM custody_stocktakes WHERE location_id=ANY($1::text[]) ORDER BY created_at DESC,id LIMIT 25",[visibleIds])).rows:[];
 const closureRows=visibleIds.length?(await client.query<{id:string;package_id:string;evidence_event_id:string;location_id:string;lot_id:string;hazard:string;policy:string;evidence_action:string;unexplained_atoms:string;review_required:boolean;reason:string;created_at:Date}>("SELECT id::text,package_id,evidence_event_id,location_id,lot_id::text,hazard,policy,evidence_action,unexplained_atoms::text,review_required,reason,created_at FROM custody_package_closures WHERE location_id=ANY($1::text[]) ORDER BY created_at DESC,id LIMIT 25",[visibleIds])).rows:[];
 const settlementRows=(await client.query<{id:string;doctor_party_id:number;period_id:string;currency:Currency;applied_deductions_minor:string;attributable_consumption_minor:string|null;supplemental_minor:string|null;direction:string;status:string;reason:string;created_at:Date;objection_count:number}>("SELECT s.id::text,s.doctor_party_id,s.period_id,s.currency,s.applied_deductions_minor::text,s.attributable_consumption_minor::text,s.supplemental_minor::text,s.direction,s.status,s.reason,s.created_at,(SELECT COUNT(*)::int FROM custody_settlement_objections o WHERE o.settlement_id=s.id) AS objection_count FROM custody_annual_settlements s WHERE ($1 OR s.doctor_party_id=$2) ORDER BY s.created_at DESC,s.id LIMIT 25",[viewer.oversight,viewer.partyId])).rows;
 // Build closableLots per custody location (including depleted 0-balance lots that had historical custody inbound allocation at that location — R06)
 // Uses full-table unclosed tranche calculation in custodyLotHistory (never truncated by closureRows LIMIT 25).
 const custodyLocationIds=visible.filter(p=>p.kind==="custody").map(p=>p.id);
 const historicalPairs=custodyLocationIds.length
  ? (await client.query<{location_id:string;lot_id:string}>(`SELECT DISTINCT location_id,lot_id FROM (
     SELECT t.to_location_id AS location_id,l.lot_id::text AS lot_id
     FROM inventory_transfer_ack_lines a JOIN inventory_transfer_lines l ON l.id=a.transfer_line_id JOIN inventory_transfers t ON t.id=l.transfer_id
     WHERE t.to_location_id=ANY($1::text[]) AND a.accepted_qty>0
     UNION
     SELECT ma.location_id,ma.lot_id::text AS lot_id
     FROM inventory_movement_allocations ma JOIN inventory_movements m ON m.id=ma.movement_id
     WHERE ma.location_id=ANY($1::text[]) AND (m.kind='in' OR (m.kind='adjust' AND m.qty>0)) AND ma.qty>0
    ) pairs ORDER BY location_id,lot_id`,[custodyLocationIds])).rows
  : [];
 type ClosableTranche={
  packageId:string;
  canonicalPackageId:string;
  receivedAt:string;
  originalQuantity:string;
  inboundQuantity:string;
  recordedConsumptionQuantity:string;
  consumedQuantity:string;
  returnedOrTransferredQuantity:string;
  approvedWasteQuantity:string;
  remainingQuantity:string;
  quantity:string;
  defaultEvidenceEventId:string|null;
 };
 const closableByLocation=new Map<string,Array<{locationId:string;lotId:string;itemId:number;name:string;unit:string;lotCode:string|null;expiryDate:string|null;originalQuantity:string;inboundQuantity:string;recordedConsumptionQuantity:string;consumedQuantity:string;returnedOrTransferredQuantity:string;approvedWasteQuantity:string;remainingQuantity:string;quantity:string;lotOriginalQuantity:string;lotRemainingQuantity:string;minimumHazard:"none"|"sharp"|"contaminated";defaultHazard:"none"|"sharp"|"contaminated";defaultPolicy:PackageSafetyPolicy;defaultPackageId:string|null;defaultEvidenceEventId:string|null;tranches:ClosableTranche[];alreadyClosed:boolean;legacySourceReconciliationRequired:boolean;legacyReconciliationLines:string[]}>>();
 const legacySourceReconciliationRequired:Array<{locationId:string;lotId:string;itemId:number;name:string;unit:string;transferLineIds:string[];reason:"legacy_source_reconciliation_required"}>=[];
 for(const pair of historicalPairs){
  const lot=stock.find(l=>l.id===pair.lot_id);
  if(!lot)continue;
  const balText=current.find(b=>b.lot_id===lot.id&&b.location_id===pair.location_id)?.qty??"0";
  const hist=await custodyLotHistory(client,pair.location_id,lot,balText);
  if(hist.totalInboundAtoms3<=0n)continue;
  const safety=classifyDefaultPackageSafety({name:lot.name,category:lot.category,unit:lot.unit,costSnapshot:lot.cost_snapshot});
  const resolvedSources=await resolveLocationLotSources(client,pair.location_id,lot.id);
  const hasLegacyReconciliation=resolvedSources.legacyReconciliationRequiredLines.length>0||resolvedSources.hasInvalidLegacyClosure;
  if(hasLegacyReconciliation){
   legacySourceReconciliationRequired.push({
    locationId:pair.location_id,
    lotId:lot.id,
    itemId:lot.item_id,
    name:lot.name,
    unit:lot.unit,
    transferLineIds:[...resolvedSources.legacyReconciliationRequiredLines],
    reason:"legacy_source_reconciliation_required",
   });
  }
  let remConsumed=hist.consumedAtoms3;
  let remReturned=hist.returnedOrTransferredAtoms3;
  let remWaste=hist.wasteAtoms3;
  let remBalance=hist.remainingAtoms3;
  const tranches:ClosableTranche[]=[];
  for(const cand of resolvedSources.openTranches){
   const openAtoms3=cand.openAtoms3;
   let cap=openAtoms3;
   const tConsumed=remConsumed<=cap?remConsumed:cap;remConsumed-=tConsumed;cap-=tConsumed;
   const tReturned=remReturned<=cap?remReturned:cap;remReturned-=tReturned;cap-=tReturned;
   const tWaste=remWaste<=cap?remWaste:cap;remWaste-=tWaste;cap-=tWaste;
   const tRemaining=remBalance<=cap?remBalance:cap;remBalance-=tRemaining;cap-=tRemaining;
   const tOrigText=quantityText(openAtoms3);
   const tConsumedText=quantityText(tConsumed);
   const tReturnedText=quantityText(tReturned);
   const tWasteText=quantityText(tWaste);
   const tRemainingText=quantityText(tRemaining);
   const evCandidateRows=await client.query<{ev_id:string}>(`SELECT candidate.ev_id FROM (
     SELECT u.id::text AS ev_id,u.created_at AS ts,u.kind::text AS kind,CASE WHEN u.kind='approved_waste' THEN 1 ELSE 2 END AS prio FROM custody_usage_events u WHERE u.location_id=$1 AND u.lot_id=$2
     UNION ALL
     SELECT s.id::text AS ev_id,s.created_at AS ts,'stocktake' AS kind,3 AS prio FROM custody_stocktakes s WHERE s.location_id=$1 AND s.lot_id=$2
    ) candidate
    WHERE candidate.ts >= $3::timestamptz
      AND NOT EXISTS (SELECT 1 FROM custody_package_closures c WHERE c.evidence_event_id=candidate.ev_id)
    ORDER BY
      CASE
        WHEN candidate.kind='approved_waste' AND $4::numeric>0 THEN 0
        WHEN candidate.kind='consumed' AND $5::numeric>0 THEN 1
        WHEN candidate.kind='returned_to_store' AND $6::numeric>0 THEN 2
        WHEN candidate.kind='stocktake' THEN 3
        ELSE 4
      END ASC,
      candidate.prio ASC,candidate.ts DESC,candidate.ev_id LIMIT 1`,
    [pair.location_id,lot.id,cand.sourceTs,tWasteText,tConsumedText,tReturnedText],
   );
   tranches.push({
    packageId:cand.rawId,
    canonicalPackageId:cand.canonicalId,
    receivedAt:cand.sourceTs,
    originalQuantity:tOrigText,
    inboundQuantity:tOrigText,
    recordedConsumptionQuantity:tConsumedText,
    consumedQuantity:tConsumedText,
    returnedOrTransferredQuantity:tReturnedText,
    approvedWasteQuantity:tWasteText,
    remainingQuantity:tRemainingText,
    quantity:tRemainingText,
    defaultEvidenceEventId:evCandidateRows.rows[0]?.ev_id??null,
   });
  }
  const firstTranche=tranches[0]??null;
  const alreadyClosed=hist.inboundAtoms3<=0n||firstTranche===null;
  const arr=closableByLocation.get(pair.location_id)??[];
  arr.push({
   locationId:pair.location_id,
   lotId:lot.id,
   itemId:lot.item_id,
   name:lot.name,
   unit:lot.unit,
   lotCode:lot.lot_code,
   expiryDate:lot.expiry_date,
   originalQuantity:firstTranche?firstTranche.originalQuantity:hist.originalQuantity,
   inboundQuantity:firstTranche?firstTranche.inboundQuantity:hist.originalQuantity,
   recordedConsumptionQuantity:firstTranche?firstTranche.recordedConsumptionQuantity:hist.recordedConsumptionQuantity,
   consumedQuantity:firstTranche?firstTranche.consumedQuantity:hist.recordedConsumptionQuantity,
   returnedOrTransferredQuantity:firstTranche?firstTranche.returnedOrTransferredQuantity:hist.returnedOrTransferredQuantity,
   approvedWasteQuantity:firstTranche?firstTranche.approvedWasteQuantity:hist.approvedWasteQuantity,
   remainingQuantity:firstTranche?firstTranche.remainingQuantity:hist.remainingQuantity,
   quantity:firstTranche?firstTranche.quantity:hist.remainingQuantity,
   lotOriginalQuantity:hist.originalQuantity,
   lotRemainingQuantity:hist.remainingQuantity,
   minimumHazard:safety.minimumHazard,
   defaultHazard:safety.minimumHazard,
   defaultPolicy:safety.defaultPolicy,
   defaultPackageId:firstTranche?.packageId??null,
   defaultEvidenceEventId:firstTranche?.defaultEvidenceEventId??null,
   tranches,
   alreadyClosed,
   legacySourceReconciliationRequired:hasLegacyReconciliation,
   legacyReconciliationLines:[...resolvedSources.legacyReconciliationRequiredLines],
  });
  closableByLocation.set(pair.location_id,arr);
 }
 const allClosableLots=Array.from(closableByLocation.values()).flat().filter(c=>!c.alreadyClosed);
 return {
  scope:INVENTORY_CLINIC_SCOPE,
  pricesAllowed:viewer.prices,
  locations:visible.map(place=>({id:place.id,label:place.label,kind:place.kind,doctorPartyId:place.doctor_party_id,lots:current.filter(row=>row.location_id===place.id&&quantityAtoms(row.qty,3,true)>0n).map(row=>{const lot=stock.find(lot=>lot.id===row.lot_id)!;const quote=values.get(`${lot.id}:${place.id}`);const capacity=locationCapacity(lot,place.id,current);const canIssue=eligible(lot,today)&&!incomplete.has(lot.item_id);return {lotId:lot.id,itemId:lot.item_id,name:lot.name,unit:lot.unit,quantity:quantityText(capacity.total),availableQuantity:quantityText(canIssue?capacity.available:0n),wasteQuantity:quantityText(!incomplete.has(lot.item_id)?capacity.available:0n),heldQuantity:quantityText(capacity.held),lotCode:lot.lot_code,expiryDate:lot.expiry_date,availability:canIssue&&capacity.available>0n?"available":"unavailable",trackingState:incomplete.has(lot.item_id)?"incomplete":"allocated",...(viewer.prices?{quote:quote??null,costState:quote?"estimated":lot.cost_status==="known"?"known":"missing"}:{})};}),closableLots:(closableByLocation.get(place.id)??[]).filter(c=>!c.alreadyClosed)})),
  closableLots:allClosableLots,
  storeLocations:allLocations.filter(row=>row.kind==="store"&&row.is_active).map(row=>({id:row.id,label:row.label})),
  pendingTransfers:pending,
  transferOffset:offset,
  hasMoreTransfers:transfers.rows.length>20,
  reconciliationRequired:viewer.reconcile?ledger.filter(row=>!reconciled(row)).map(row=>({itemId:row.id,name:row.name,unit:row.unit,clinicQuantity:row.global_qty,allocatedQuantity:row.allocated_qty})):[],
  legacySourceReconciliationRequired,
  usageEvents:usageRows.map(row=>({id:row.id,usageKey:row.usage_key,locationId:row.location_id,storeLocationId:row.store_location_id,lotId:row.lot_id,name:stock.find(l=>l.id===row.lot_id)?.name??"",unit:stock.find(l=>l.id===row.lot_id)?.unit??"",kind:row.kind,quantity:quantityText(quantityAtoms(row.qty,3,true)),quantityState:row.quantity_state,patientId:row.patient_id,visitId:row.visit_id,caseId:row.case_id,procedureId:row.procedure_id,clinicalAttributionStatus:savedClinicalAttribution(row),reason:row.reason,createdAt:row.created_at.toISOString()})),
  stocktakes:stocktakeRows.map(row=>({id:row.id,locationId:row.location_id,lotId:row.lot_id,name:stock.find(l=>l.id===row.lot_id)?.name??"",unit:stock.find(l=>l.id===row.lot_id)?.unit??"",expectedQuantity:quantityText(quantityAtoms(row.expected_qty,3,true)),countedQuantity:quantityText(quantityAtoms(row.counted_qty,3,true)),differenceQuantity:row.difference_qty.startsWith("-")?`-${quantityText(quantityAtoms(row.difference_qty.slice(1),3,true))}`:quantityText(quantityAtoms(row.difference_qty,3,true)),reviewRequired:row.review_required,reason:row.reason,createdAt:row.created_at.toISOString()})),
  packageClosures:closureRows.map(row=>({id:row.id,packageId:row.package_id,evidenceEventId:row.evidence_event_id,locationId:row.location_id,lotId:row.lot_id,name:stock.find(l=>l.id===row.lot_id)?.name??"",hazard:row.hazard,policy:row.policy,evidenceAction:row.evidence_action,unexplainedAtoms:Number(row.unexplained_atoms),reviewRequired:row.review_required,reason:row.reason,createdAt:row.created_at.toISOString()})),
  settlements:settlementRows.map(row=>({id:row.id,doctorPartyId:row.doctor_party_id,periodId:row.period_id,currency:row.currency,appliedDeductionsMinor:Number(row.applied_deductions_minor),attributableConsumptionMinor:row.attributable_consumption_minor===null?null:Number(row.attributable_consumption_minor),supplementalMinor:row.supplemental_minor===null?null:Number(row.supplemental_minor),direction:row.direction,status:row.objection_count>0?"objected_under_review":row.status,objectionCount:row.objection_count,reason:row.reason,createdAt:row.created_at.toISOString()})),
  financialAdjustments:"not_automatic" as const,
 };
}

