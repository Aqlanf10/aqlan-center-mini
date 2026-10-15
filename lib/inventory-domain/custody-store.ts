import { randomUUID } from "node:crypto";
import { ensureSchema,getPool,type DbClient } from "../db";
import { withTransaction } from "../transactions";
import { clinicDateString } from "../schedule";
import { CLINIC_ZONE_FALLBACK } from "../clinicZone";
import { invariant,InventoryDomainError,quantityAtoms,quantityText,decimalRatio } from "./quantities";
import { allocateMinor,planHistoricalReconciliation } from "./procurement";
import { packageEvidenceAction,proposeSettlement,reconcileCustody,reconcileEmptyPackage,type PackageSafetyPolicy } from "./custody";
import { INVENTORY_CLINIC_SCOPE,inventoryOperation,requireInventoryActor,writeInventoryAudit,type InventoryActor } from "./procurement-store";
import { requireCurrency,type Currency } from "../money";

interface Location {id:string;label:string;kind:"store"|"custody"|"transit";doctor_party_id:number|null;branch_key:string;is_active:boolean}
interface Lot {id:string;item_id:number;name:string;unit:string;status:string;unreleased_qty:string;receipt_location_id:string;expiry_date:string|null;lot_code:string|null;cost_status:string;cost_snapshot:Record<string,unknown>}
export interface CustodyDispatch {id:string;fromLocationId:string;toLocationId:string;transitLocationId:string;reason:string;lines:{id:string;lotId:string;quantity:string}[]}
export interface CustodyAcknowledgement {id:string;transferId:string;reason:string;lines:{lineId:string;acceptedQuantity:string;returnedQuantity:string}[]}
export interface LegacyReconciliationInput {id:string;itemId:number;locationId:string;reason:string;requiresExpiry?:boolean}
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
async function ready(){await ensureSchema();const r=await getPool().query<{present:boolean}>("SELECT to_regclass('inventory_transfers') IS NOT NULL AS present");if(!r.rows[0]?.present)throw new InventoryDomainError("schema_not_ready","Doctor custody schema awaits coordinated migration");}
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
async function balances(client:DbClient){const r=await client.query<{lot_id:string;location_id:string;qty:string}>(BALANCES_SQL);for(const row of r.rows)invariant(!row.qty.startsWith("-"),"allocation_reconciliation_required","A location/lot allocation is negative; reconcile source records before transfer");return r.rows;}
async function locations(client:DbClient,ids?:string[]){return (await client.query<Location>("SELECT id,label,kind,doctor_party_id,branch_key,is_active FROM inventory_locations WHERE branch_key=$1 AND ($2::text[] IS NULL OR id=ANY($2::text[])) ORDER BY id FOR SHARE",[INVENTORY_CLINIC_SCOPE,ids??null])).rows;}
async function lots(client:DbClient,ids?:string[]){return (await client.query<Lot>(`SELECT l.id,l.item_id,i.name,i.unit,
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
async function ledgerRows(client:DbClient,itemIds?:number[]){
 const r=await client.query<{id:number;name:string;unit:string;global_qty:string;allocated_qty:string}>(`SELECT i.id,i.name,i.unit,
 COALESCE((SELECT SUM(CASE m.kind WHEN 'out' THEN -m.qty ELSE m.qty END) FROM inventory_movements m WHERE m.item_id=i.id),0)::text AS global_qty,
 COALESCE((SELECT SUM(CASE WHEN m.kind='out' OR(m.kind='adjust' AND m.qty<0) THEN -a.qty ELSE a.qty END) FROM inventory_movement_allocations a JOIN inventory_movements m ON m.id=a.movement_id WHERE m.item_id=i.id),0)::text AS allocated_qty
 FROM inventory_items i
 WHERE ($1::int[] IS NULL AND (EXISTS (SELECT 1 FROM inventory_movements m WHERE m.item_id=i.id) OR EXISTS (SELECT 1 FROM stock_lots l WHERE l.item_id=i.id)))
    OR i.id=ANY($1::int[])
 ORDER BY i.id`,[itemIds??null]);
 return r.rows;
}
function reconciled(row:{global_qty:string;allocated_qty:string}){try{return row.global_qty===row.allocated_qty||decimalRatio(row.global_qty).numerator*decimalRatio(row.allocated_qty).denominator===decimalRatio(row.allocated_qty).numerator*decimalRatio(row.global_qty).denominator;}catch{return false;}}
async function verifyLedgerReconciliation(client:DbClient,itemIds:number[]){const rows=await ledgerRows(client,itemIds);invariant(rows.every(reconciled),"legacy_allocation_incomplete","Clinic movements are not fully allocated to lots/locations; reconcile before transfer");}
function basePrecision(lot:Lot){const conversion=lot.cost_snapshot.conversion as {basePrecision?:number;baseUnit?:string}|undefined;invariant(conversion&&typeof conversion.basePrecision==="number"&&Number.isInteger(conversion.basePrecision)&&conversion.basePrecision>=0&&conversion.basePrecision<=3&&conversion.baseUnit===lot.unit,"unit_precision_unconfirmed","Use the lot's recorded base unit/precision before transferring it");return conversion.basePrecision;}
function eligible(lot:Lot,today:string){return lot.status==="accepted"&&((lot.expiry_date===null&&lot.cost_snapshot.requiresExpiry===false)||(lot.expiry_date!==null&&lot.expiry_date>=today));}
async function lockItems(client:DbClient,itemIds:number[]){const ids=[...new Set(itemIds)].sort((a,b)=>a-b);const r=await client.query<{id:number;is_active:boolean}>("SELECT id,is_active FROM inventory_items WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE",[ids]);invariant(r.rows.length===ids.length&&r.rows.every(row=>row.is_active),"item_unavailable","Transfer items must remain active");await verifyLedgerReconciliation(client,ids);}
export async function dispatchCustodyTransfer(actor:InventoryActor,key:string,input:CustodyDispatch){
 uuid(input.id);reason(input.reason);invariant(Array.isArray(input.lines)&&input.lines.length>0&&input.lines.length<=100,"invalid_lines","Use one to 100 transfer lines");
 const lineIds=new Set<string>(),lotIds=new Set<string>();for(const line of input.lines){uuid(line.id);uuid(line.lotId);quantityAtoms(line.quantity);invariant(!lineIds.has(line.id)&&!lotIds.has(line.lotId),"duplicate_source","Transfer lines/lots must be unique");lineIds.add(line.id);lotIds.add(line.lotId);}
 await ready();return inventoryOperation(actor,key,"custody.dispatch",input,true,async client=>{
  const places=await locations(client,[input.fromLocationId,input.toLocationId,input.transitLocationId]);const source=places.find(row=>row.id===input.fromLocationId),dest=places.find(row=>row.id===input.toLocationId),transit=places.find(row=>row.id===input.transitLocationId);
  invariant(source?.is_active&&dest?.is_active&&transit?.is_active&&source.kind!=="transit"&&dest.kind!=="transit"&&transit.kind==="transit"&&new Set([source.id,dest.id,transit.id]).size===3,"location_forbidden","Use distinct active source, destination and transit locations in this clinic");
  if(dest.kind==="custody"){const party=await client.query<{kind:string;is_active:boolean}>("SELECT kind,is_active FROM parties WHERE id=$1 FOR SHARE",[dest.doctor_party_id]);invariant(party.rows[0]?.kind==="doctor"&&party.rows[0]?.is_active,"doctor_unavailable","Destination must belong to an active doctor");}
  const stock=await lots(client,[...lotIds]);invariant(stock.length===lotIds.size,"not_found","Transfer lot was not found");await lockItems(client,stock.map(row=>row.item_id));const current=await balances(client);const today=clinicDateString(new Date(),CLINIC_ZONE_FALLBACK);
  for(const line of input.lines){
   const lot=stock.find(row=>row.id===line.lotId)!;invariant(eligible(lot,today),"lot_unavailable","Expired or quarantined material cannot be dispatched as available custody");
   const qty=current.find(row=>row.lot_id===line.lotId&&row.location_id===source.id)?.qty??"0";
   const heldAtoms=source.id===lot.receipt_location_id?quantityAtoms(lot.unreleased_qty??"0",3,true):0n;
   const availableAtoms=quantityAtoms(qty,3,true)>heldAtoms?quantityAtoms(qty,3,true)-heldAtoms:0n;
   invariant(quantityAtoms(line.quantity,basePrecision(lot))<=availableAtoms,"insufficient_location_stock","Source location has insufficient tracked stock");
  }
  await client.query("INSERT INTO inventory_transfers(id,from_location_id,to_location_id,transit_location_id,reason,created_by) VALUES($1,$2,$3,$4,$5,$6)",[input.id,source.id,dest.id,transit.id,input.reason,actor.userId]);
  for(const line of input.lines){const lot=stock.find(row=>row.id===line.lotId)!;await client.query("INSERT INTO inventory_transfer_lines(id,transfer_id,lot_id,qty,cost_snapshot) VALUES($1,$2,$3,$4::numeric,$5::jsonb)",[line.id,input.id,line.lotId,quantityText(quantityAtoms(line.quantity)),JSON.stringify(lot.cost_snapshot)]);}
  await writeInventoryAudit(client,actor,"inventory_transfer",input.id,"dispatch",{source:source.id,destination:dest.id,transit:transit.id,reason:input.reason,lines:input.lines});
  return {id:input.id,status:"in_transit" as const,clinicMovementEffects:0,payableEffects:0,cashEffects:0};
 });
}
export async function acknowledgeCustodyTransfer(actor:InventoryActor,key:string,input:CustodyAcknowledgement){
 uuid(input.id);uuid(input.transferId);reason(input.reason);invariant(Array.isArray(input.lines)&&input.lines.length>0&&input.lines.length<=100,"invalid_lines","Acknowledgement lines are required");
 const ids=new Set<string>();for(const line of input.lines){uuid(line.lineId);invariant(!ids.has(line.lineId),"duplicate_source","Acknowledgement line is duplicated");ids.add(line.lineId);invariant(quantityAtoms(line.acceptedQuantity,3,true)+quantityAtoms(line.returnedQuantity,3,true)>0n,"zero_quantity","Acknowledge or return a positive quantity");}
 await ready();return inventoryOperation(actor,key,"custody.acknowledge",input,false,async client=>{
  const who=await requireInventoryActor(client,actor,false);const r=await client.query<{id:string;from_location_id:string;to_location_id:string;transit_location_id:string}>("SELECT id,from_location_id,to_location_id,transit_location_id FROM inventory_transfers WHERE id=$1 FOR UPDATE",[input.transferId]);const transfer=r.rows[0];invariant(transfer,"not_found","Transfer was not found");
  const places=await locations(client,[transfer.from_location_id,transfer.to_location_id,transfer.transit_location_id]);const dest=places.find(row=>row.id===transfer.to_location_id);invariant(dest?.is_active,"location_forbidden","Destination is inactive");if(dest.kind==="custody"){const party=await client.query<{kind:string;is_active:boolean}>("SELECT kind,is_active FROM parties WHERE id=$1 FOR SHARE",[dest.doctor_party_id]);invariant(party.rows[0]?.kind==="doctor"&&party.rows[0]?.is_active,"doctor_unavailable","Destination must belong to an active doctor");}invariant(actor.role==="admin"||(actor.role==="doctor"&&dest.kind==="custody"&&who.party_id!==null&&dest.doctor_party_id===who.party_id),"custody_owner_forbidden","Only the receiving doctor or authorized administrator can acknowledge custody");
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
export async function reconcileHistoricalMovements(actor:InventoryActor,key:string,input:LegacyReconciliationInput){
 uuid(input.id);reason(input.reason);
 invariant(Number.isSafeInteger(input.itemId)&&input.itemId>0,"invalid_identifier","A positive itemId is required");
 await ready();return inventoryOperation(actor,key,"legacy.reconcile",input,true,async client=>{
  const itemRows=await client.query<{id:number;unit:string;is_active:boolean}>("SELECT id,unit,is_active FROM inventory_items WHERE id=$1 FOR UPDATE",[input.itemId]);
  const item=itemRows.rows[0];invariant(item?.is_active,"item_unavailable","Historical reconciliation item must be active");
  const placeRows=await locations(client,[input.locationId]);const place=placeRows[0];
  invariant(place?.is_active&&place.kind==="store","location_forbidden","Historical reconciliation requires an active clinic store location");
  const unitRows=await client.query<{version:number;base_precision:number}>("SELECT version,base_precision FROM inventory_item_unit_versions WHERE item_id=$1 AND base_unit=$2 ORDER BY version DESC LIMIT 1",[item.id,item.unit]);
  const conversionVersion=unitRows.rows[0]?.version??1;
  const basePrecisionValue=(unitRows.rows[0]?.base_precision??0) as 0|1|2|3;
  const movementRows=await client.query<{id:number;kind:"in"|"out"|"adjust";qty:string;expiry_date:string|null;unit_cost_minor:string|null;payable_id:number|null;allocated_qty:string}>(`SELECT m.id,m.kind,m.qty::text,m.expiry_date::text,m.unit_cost_minor::text,m.payable_id,
   COALESCE((SELECT SUM(a.qty) FROM inventory_movement_allocations a WHERE a.movement_id=m.id),0)::text AS allocated_qty
   FROM inventory_movements m WHERE m.item_id=$1 ORDER BY m.id ASC FOR UPDATE`,[item.id]);
  const plan=planHistoricalReconciliation({
   itemId:item.id,
   baseUnit:item.unit,
   basePrecision:basePrecisionValue,
   conversionVersion,
   requiresExpiry:Boolean(input.requiresExpiry),
   locationId:place.id,
   reason:input.reason,
   movements:movementRows.rows.map(row=>({
    movementId:row.id,
    kind:row.kind,
    signedBaseQuantity:row.qty,
    alreadyAllocatedBaseQuantity:row.allocated_qty,
    expiryDate:row.expiry_date,
    unitCostMinor:row.unit_cost_minor===null?null:Number(row.unit_cost_minor),
    payableId:row.payable_id,
   })),
  });
  const lotIdByMovement=new Map<number,string>();
  const existingLots=await client.query<{id:string;movement_id:number}>("SELECT id::text,movement_id FROM stock_lots WHERE item_id=$1",[item.id]);
  for(const row of existingLots.rows)lotIdByMovement.set(row.movement_id,row.id);
  for(const lot of plan.lotsToCreate){
   let lotId=lotIdByMovement.get(lot.movementId);
   if(!lotId){
    lotId=randomUUID();
    await client.query("INSERT INTO stock_lots(id,receipt_line_id,item_id,location_id,movement_id,lot_code,expiry_date,status,cost_status,cost_snapshot) VALUES($1,NULL,$2,$3,$4,NULL,$5::date,'accepted',$6,$7::jsonb)",[lotId,lot.itemId,lot.locationId,lot.movementId,lot.expiryDate,lot.costStatus,JSON.stringify(lot.costSnapshot)]);
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
export async function recordCustodyUsage(actor:InventoryActor,key:string,input:CustodyUsageInput){
 uuid(input.id);uuid(input.lotId);reason(input.reason);
 invariant(["consumed","approved_waste","returned_to_store"].includes(input.kind),"invalid_custody_event","Invalid custody usage kind");
 const quantityState=input.quantityState??"confirmed";
 invariant(quantityState==="confirmed"||quantityState==="estimated","invalid_quantity_state","Quantity state must be confirmed or estimated");
 const usageKey=(typeof input.usageKey==="string"&&input.usageKey.trim()?input.usageKey.trim():input.id);
 invariant(usageKey.length>=1&&usageKey.length<=240,"invalid_document_id","Usage key must be 1 to 240 characters");
 if(input.kind==="approved_waste")invariant(typeof input.wasteApprovalId==="string"&&input.wasteApprovalId.trim().length>0,"missing_waste_approval","Approved waste requires an explicit wasteApprovalId");
 if(input.kind==="returned_to_store")invariant(typeof input.storeLocationId==="string"&&input.storeLocationId.trim().length>0,"location_forbidden","Returning unused custody material requires a store location");
 const opScope=input.kind==="returned_to_store"?"custody.return_to_store":"custody.consume";
 await ready();return inventoryOperation(actor,key,opScope,input,false,async client=>{
  const who=await requireInventoryActor(client,actor,false);
  const placeIds=input.kind==="returned_to_store"&&input.storeLocationId?[input.locationId,input.storeLocationId]:[input.locationId];
  const places=await locations(client,placeIds);
  const source=places.find(row=>row.id===input.locationId);
  invariant(source?.is_active&&source.kind==="custody","location_forbidden","Source must be an active doctor custody location");
  const party=await client.query<{kind:string;is_active:boolean}>("SELECT kind,is_active FROM parties WHERE id=$1 FOR SHARE",[source.doctor_party_id]);
  invariant(party.rows[0]?.kind==="doctor"&&party.rows[0]?.is_active,"doctor_unavailable","Custody location must belong to an active doctor");
  invariant(actor.role==="admin"||(actor.role==="doctor"&&who.party_id!==null&&source.doctor_party_id===who.party_id),"custody_owner_forbidden","Only the custody owner doctor or an administrator can record custody usage or return");
  let storePlace:Location|null=null;
  if(input.kind==="returned_to_store"){
   storePlace=places.find(row=>row.id===input.storeLocationId)??null;
   invariant(storePlace?.is_active&&storePlace.kind==="store","location_forbidden","Return destination must be an active clinic store location");
  }
  const dup=await client.query<{id:string}>("SELECT id::text FROM custody_usage_events WHERE usage_key=$1 FOR SHARE",[usageKey]);
  invariant(!dup.rows.length,"duplicate_consumption","This custody usage key was already recorded");
  const stock=await lots(client,[input.lotId]);const lot=stock[0];invariant(lot,"not_found","Custody lot was not found");
  await lockItems(client,[lot.item_id]);const current=await balances(client);const today=clinicDateString(new Date(),CLINIC_ZONE_FALLBACK);
  if(input.kind==="consumed"||input.kind==="returned_to_store")invariant(eligible(lot,today),"lot_unavailable","Expired or quarantined material cannot be consumed or returned as available store stock");
  const precision=basePrecision(lot);const qtyAtoms=quantityAtoms(input.quantity,precision);const normalizedQty=quantityText(qtyAtoms);
  const availableAtoms=quantityAtoms(current.find(row=>row.lot_id===lot.id&&row.location_id===source.id)?.qty??"0",3,true);
  invariant(qtyAtoms<=availableAtoms,"insufficient_location_stock","Doctor custody location has insufficient balance for this lot");
  let movementId:number|null=null;
  if(input.kind==="consumed"||input.kind==="approved_waste"){
   const movementReason=`Custody ${input.kind} ${input.id}: ${input.reason}`;
   const movement=await client.query<{id:number}>("INSERT INTO inventory_movements(item_id,kind,qty,expiry_date,reason,created_by,unit_cost_minor,is_return) VALUES($1,'out',$2::numeric,$3::date,$4,$5,NULL,FALSE) RETURNING id",[lot.item_id,normalizedQty,lot.expiry_date,movementReason,actor.username]);
   movementId=movement.rows[0].id;
   await client.query("INSERT INTO inventory_movement_allocations(id,movement_id,lot_id,location_id,qty) VALUES($1,$2,$3,$4,$5::numeric)",[randomUUID(),movementId,lot.id,source.id,normalizedQty]);
  }
  const doc={id:input.id,usageKey,locationId:source.id,storeLocationId:storePlace?.id??null,lotId:lot.id,itemId:lot.item_id,kind:input.kind,baseQuantity:normalizedQty,quantityState,patientId:input.patientId??null,visitId:input.visitId??null,caseId:input.caseId??null,procedureId:input.procedureId??null,wasteApprovalId:input.wasteApprovalId??null,reason:input.reason};
  await client.query("INSERT INTO custody_usage_events(id,usage_key,location_id,store_location_id,lot_id,movement_id,kind,qty,quantity_state,patient_id,visit_id,case_id,procedure_id,waste_approval_id,reason,cost_snapshot,document,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18)",[input.id,usageKey,source.id,storePlace?.id??null,lot.id,movementId,input.kind,normalizedQty,quantityState,input.patientId??null,input.visitId??null,input.caseId??null,input.procedureId??null,input.wasteApprovalId??null,input.reason,JSON.stringify(lot.cost_snapshot),JSON.stringify(doc),actor.userId]);
  await writeInventoryAudit(client,actor,"custody_usage",input.id,input.kind,{locationId:source.id,storeLocationId:storePlace?.id??null,lotId:lot.id,baseQuantity:normalizedQty,quantityState,patientId:input.patientId??null,visitId:input.visitId??null,procedureId:input.procedureId??null});
  return {id:input.id,usageKey,kind:input.kind,locationId:source.id,storeLocationId:storePlace?.id??null,lotId:lot.id,baseQuantity:normalizedQty,movementId,clinicMovementEffects:movementId?1:0,payableEffects:0,cashEffects:0};
 });
}
export async function recordCustodyStocktake(actor:InventoryActor,key:string,input:CustodyStocktakeInput){
 uuid(input.id);uuid(input.lotId);reason(input.reason);
 await ready();return inventoryOperation(actor,key,"custody.stocktake",input,false,async client=>{
  const who=await requireInventoryActor(client,actor,false);
  const places=await locations(client,[input.locationId]);const source=places[0];
  invariant(source?.is_active&&source.kind==="custody","location_forbidden","Stocktake requires an active doctor custody location");
  invariant(actor.role==="admin"||(actor.role==="doctor"&&who.party_id!==null&&source.doctor_party_id===who.party_id),"custody_owner_forbidden","Only the custody owner doctor or an administrator can record a custody stocktake");
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
export async function closeCustodyPackage(actor:InventoryActor,key:string,input:CustodyPackageClosureInput){
 uuid(input.id);uuid(input.lotId);reason(input.reason);
 invariant(typeof input.packageId==="string"&&input.packageId.trim().length>0&&input.packageId.trim().length<=240,"invalid_document_id","A packageId is required");
 invariant(typeof input.evidenceEventId==="string"&&input.evidenceEventId.trim().length>0&&input.evidenceEventId.trim().length<=240,"invalid_document_id","An evidenceEventId is required");
 await ready();return inventoryOperation(actor,key,"custody.close_package",input,false,async client=>{
  const who=await requireInventoryActor(client,actor,false);
  const places=await locations(client,[input.locationId]);const source=places[0];
  invariant(source?.is_active&&source.kind==="custody","location_forbidden","Package closure requires an active doctor custody location");
  invariant(actor.role==="admin"||(actor.role==="doctor"&&who.party_id!==null&&source.doctor_party_id===who.party_id),"custody_owner_forbidden","Only the custody owner doctor or an administrator can close a custody package");
  const stock=await lots(client,[input.lotId]);const lot=stock[0];invariant(lot,"not_found","Custody lot was not found");
  const precision=basePrecision(lot);const scale=10n**BigInt(3-precision);
  const toUnits=(val:string)=>Number(quantityAtoms(val,precision,true)/scale);
  const priorRows=await client.query<{package_id:string;evidence_event_id:string}>("SELECT package_id,evidence_event_id FROM custody_package_closures WHERE package_id=$1 OR evidence_event_id=$2 FOR SHARE",[input.packageId.trim(),input.evidenceEventId.trim()]);
  const expectedAction=mapDomainCall(()=>packageEvidenceAction(input.hazard,input.policy));
  const plan=mapDomainCall(()=>reconcileEmptyPackage({
   packageId:input.packageId.trim(),
   evidenceEventId:input.evidenceEventId.trim(),
   previousClosures:priorRows.rows.map(row=>({packageId:row.package_id,evidenceEventId:row.evidence_event_id})),
   hazard:input.hazard,
   policy:input.policy,
   evidenceAction:input.evidenceAction??expectedAction,
   originalAtoms:toUnits(input.originalQuantity),
   recordedConsumptionAtoms:toUnits(input.recordedConsumptionQuantity),
   returnedOrTransferredAtoms:toUnits(input.returnedOrTransferredQuantity),
   approvedWasteAtoms:toUnits(input.approvedWasteQuantity),
   remainingAtoms:toUnits(input.remainingQuantity),
  }));
  const doc={id:input.id,locationId:source.id,lotId:lot.id,...plan,reason:input.reason};
  await client.query("INSERT INTO custody_package_closures(id,package_id,evidence_event_id,location_id,lot_id,hazard,policy,evidence_action,unexplained_atoms,review_required,reason,document,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)",[input.id,plan.packageId,plan.evidenceEventId,source.id,lot.id,input.hazard,input.policy,plan.evidenceAction,plan.unexplainedAtoms,plan.reviewRequired,input.reason,JSON.stringify(doc),actor.userId]);
  await writeInventoryAudit(client,actor,"custody_package",input.id,"close_package",doc);
  return {...doc,clinicMovementEffects:0,payableEffects:0,cashEffects:0};
 });
}
export async function proposeAnnualCustodySettlement(actor:InventoryActor,key:string,input:CustodySettlementProposalInput){
 uuid(input.id);reason(input.reason);
 invariant(Number.isSafeInteger(input.doctorPartyId)&&input.doctorPartyId>0,"invalid_identifier","A positive doctorPartyId is required");
 invariant(typeof input.periodId==="string"&&input.periodId.trim().length>0&&input.periodId.trim().length<=120,"invalid_identifier","A bounded periodId is required");
 requireCurrency(input.currency,"custody_settlement",input.id);
 await ready();return inventoryOperation(actor,key,"custody.propose_settlement",input,true,async client=>{
  const party=await client.query<{kind:string;is_active:boolean}>("SELECT kind,is_active FROM parties WHERE id=$1 FOR SHARE",[input.doctorPartyId]);
  invariant(party.rows[0]?.kind==="doctor"&&party.rows[0]?.is_active,"doctor_unavailable","Settlement must target an active doctor party");
  const periodId=input.periodId.trim();
  const priorRows=await client.query<{id:string;supplemental_minor:string}>("SELECT id::text,supplemental_minor::text FROM custody_annual_settlements WHERE doctor_party_id=$1 AND period_id=$2 AND currency=$3 AND supplemental_minor IS NOT NULL ORDER BY created_at,id FOR SHARE",[input.doctorPartyId,periodId,input.currency]);
  const scope={doctorId:String(input.doctorPartyId),periodId};
  const proposal=mapDomainCall(()=>proposeSettlement({
   scope,
   deductions:{currency:input.currency,amountMinor:input.appliedDeductionsMinor},
   attributable:input.attributableConsumptionMinor===null?null:{currency:input.currency,amountMinor:input.attributableConsumptionMinor},
   prerequisitesComplete:input.prerequisitesComplete??(input.attributableConsumptionMinor!==null),
   priorAdjustments:priorRows.rows.map(row=>({id:row.id,doctorId:scope.doctorId,periodId:scope.periodId,currency:input.currency,signedMinor:Number(row.supplemental_minor)})),
  }));
  const doc={id:input.id,doctorPartyId:input.doctorPartyId,periodId,currency:proposal.currency,appliedDeductionsMinor:input.appliedDeductionsMinor,attributableConsumptionMinor:input.attributableConsumptionMinor,targetDifferenceMinor:proposal.targetDifferenceMinor,priorAdjustmentMinor:proposal.priorAdjustmentMinor,supplementalMinor:proposal.supplementalMinor,direction:proposal.direction,status:proposal.status,cashDeltaMinor:0,automaticWageDeductionMinor:0,reason:input.reason};
  await client.query("INSERT INTO custody_annual_settlements(id,doctor_party_id,period_id,currency,applied_deductions_minor,attributable_consumption_minor,supplemental_minor,direction,status,reason,document,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)",[input.id,input.doctorPartyId,periodId,proposal.currency,input.appliedDeductionsMinor,input.attributableConsumptionMinor,proposal.supplementalMinor,proposal.direction,proposal.status,input.reason,JSON.stringify(doc),actor.userId]);
  await writeInventoryAudit(client,actor,"custody_settlement",input.id,"propose",{doctorPartyId:input.doctorPartyId,periodId,currency:proposal.currency,direction:proposal.direction,status:proposal.status});
  return {...doc,clinicMovementEffects:0,payableEffects:0,cashEffects:0};
 });
}
export async function objectCustodySettlement(actor:InventoryActor,key:string,input:CustodySettlementObjectionInput){
 uuid(input.id);uuid(input.settlementId);reason(input.reason);
 await ready();return inventoryOperation(actor,key,"custody.object_settlement",input,false,async client=>{
  const who=await requireInventoryActor(client,actor,false);
  const settlementRows=await client.query<{id:string;doctor_party_id:number;period_id:string}>("SELECT id::text,doctor_party_id,period_id FROM custody_annual_settlements WHERE id=$1 FOR SHARE",[input.settlementId]);
  const settlement=settlementRows.rows[0];invariant(settlement,"not_found","Custody settlement proposal was not found");
  invariant(actor.role==="admin"||(actor.role==="doctor"&&who.party_id!==null&&settlement.doctor_party_id===who.party_id),"custody_owner_forbidden","Only the settlement doctor or an administrator can record an objection");
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
export async function readDoctorCustody(actor:InventoryActor,offset=0){invariant(Number.isSafeInteger(offset)&&offset>=0&&offset<=100000,"invalid_page","Invalid page offset");await ready();return withTransaction(getPool(),async client=>{
 const who=await requireInventoryActor(client,actor,false);invariant(actor.role==="admin"||(actor.role==="doctor"&&who.party_id!==null),"custody_read_forbidden","Custody statements are limited to the doctor owner or administrator");
 const allLocations=await locations(client);const visible=allLocations.filter(row=>actor.role==="admin"||(row.kind==="custody"&&row.doctor_party_id===who.party_id));const visibleIds=visible.map(row=>row.id);const stock=await lots(client);const current=await balances(client);const today=clinicDateString(new Date(),CLINIC_ZONE_FALLBACK);const ledger=await ledgerRows(client);const incomplete=new Set(ledger.filter(row=>!reconciled(row)).map(row=>row.id));
 const values=new Map<string,{currency:Currency;amountMinor:number}>();if(actor.role==="admin")for(const lot of stock){const rows=current.filter(row=>row.lot_id===lot.id&&quantityAtoms(row.qty,3,true)>0n);if(!rows.length)continue;const total=rows.reduce((sum,row)=>sum+quantityAtoms(row.qty),0n);const quote=roundedQuote(lot,quantityText(total));if(quote)for(const share of allocateMinor(quote.amountMinor,rows.map(row=>({id:row.location_id,weight:String(quantityAtoms(row.qty))}))))values.set(`${lot.id}:${share.id}`,{currency:quote.currency,amountMinor:share.amountMinor});}
 const transfers=await client.query<{id:string;from_location_id:string;to_location_id:string;transit_location_id:string;reason:string;created_at:Date}>(`SELECT t.id,t.from_location_id,t.to_location_id,t.transit_location_id,t.reason,t.created_at FROM inventory_transfers t WHERE (t.to_location_id=ANY($1::text[]) OR ($2 AND t.from_location_id=ANY($1::text[]))) AND EXISTS (SELECT 1 FROM inventory_transfer_lines l WHERE l.transfer_id=t.id AND l.qty>COALESCE((SELECT SUM(a.accepted_qty+a.returned_qty) FROM inventory_transfer_ack_lines a WHERE a.transfer_line_id=l.id),0)) ORDER BY t.created_at DESC,t.id LIMIT 21 OFFSET $3`,[visibleIds,actor.role==="admin",offset]);
 const pending=[];for(const transfer of transfers.rows.slice(0,20)){const lines=await client.query<{id:string;lot_id:string;remaining:string}>(`SELECT l.id,l.lot_id,(l.qty-COALESCE((SELECT SUM(a.accepted_qty+a.returned_qty) FROM inventory_transfer_ack_lines a WHERE a.transfer_line_id=l.id),0))::text AS remaining FROM inventory_transfer_lines l WHERE transfer_id=$1 ORDER BY id`,[transfer.id]);const open=lines.rows.filter(line=>quantityAtoms(line.remaining,3,true)>0n);if(open.length)pending.push({id:transfer.id,reason:transfer.reason,fromLabel:allLocations.find(row=>row.id===transfer.from_location_id)?.label??"",destinationLabel:allLocations.find(row=>row.id===transfer.to_location_id)?.label??"",createdAt:transfer.created_at.toISOString(),lines:open.map(line=>({id:line.id,lotId:line.lot_id,name:stock.find(row=>row.id===line.lot_id)?.name??"",unit:stock.find(row=>row.id===line.lot_id)?.unit??"",remainingQuantity:quantityText(quantityAtoms(line.remaining))}))});}
 const usageRows=visibleIds.length?(await client.query<{id:string;usage_key:string;location_id:string;store_location_id:string|null;lot_id:string;kind:string;qty:string;quantity_state:string;patient_id:string|null;visit_id:string|null;case_id:string|null;procedure_id:string|null;reason:string;created_at:Date}>("SELECT id::text,usage_key,location_id,store_location_id,lot_id::text,kind,qty::text,quantity_state,patient_id,visit_id,case_id,procedure_id,reason,created_at FROM custody_usage_events WHERE location_id=ANY($1::text[]) ORDER BY created_at DESC,id LIMIT 25",[visibleIds])).rows:[];
 const stocktakeRows=visibleIds.length?(await client.query<{id:string;location_id:string;lot_id:string;expected_qty:string;counted_qty:string;difference_qty:string;review_required:boolean;reason:string;created_at:Date}>("SELECT id::text,location_id,lot_id::text,expected_qty::text,counted_qty::text,difference_qty::text,review_required,reason,created_at FROM custody_stocktakes WHERE location_id=ANY($1::text[]) ORDER BY created_at DESC,id LIMIT 25",[visibleIds])).rows:[];
 const closureRows=visibleIds.length?(await client.query<{id:string;package_id:string;evidence_event_id:string;location_id:string;lot_id:string;hazard:string;policy:string;evidence_action:string;unexplained_atoms:string;review_required:boolean;reason:string;created_at:Date}>("SELECT id::text,package_id,evidence_event_id,location_id,lot_id::text,hazard,policy,evidence_action,unexplained_atoms::text,review_required,reason,created_at FROM custody_package_closures WHERE location_id=ANY($1::text[]) ORDER BY created_at DESC,id LIMIT 25",[visibleIds])).rows:[];
 const settlementRows=(await client.query<{id:string;doctor_party_id:number;period_id:string;currency:Currency;applied_deductions_minor:string;attributable_consumption_minor:string|null;supplemental_minor:string|null;direction:string;status:string;reason:string;created_at:Date;objection_count:number}>("SELECT s.id::text,s.doctor_party_id,s.period_id,s.currency,s.applied_deductions_minor::text,s.attributable_consumption_minor::text,s.supplemental_minor::text,s.direction,s.status,s.reason,s.created_at,(SELECT COUNT(*)::int FROM custody_settlement_objections o WHERE o.settlement_id=s.id) AS objection_count FROM custody_annual_settlements s WHERE ($1 OR s.doctor_party_id=$2) ORDER BY s.created_at DESC,s.id LIMIT 25",[actor.role==="admin",who.party_id])).rows;
 return {
  scope:INVENTORY_CLINIC_SCOPE,
  pricesAllowed:actor.role==="admin",
  locations:visible.map(place=>({id:place.id,label:place.label,kind:place.kind,doctorPartyId:place.doctor_party_id,lots:current.filter(row=>row.location_id===place.id&&quantityAtoms(row.qty,3,true)>0n).map(row=>{const lot=stock.find(lot=>lot.id===row.lot_id)!;const quote=values.get(`${lot.id}:${place.id}`);return {lotId:lot.id,itemId:lot.item_id,name:lot.name,unit:lot.unit,quantity:quantityText(quantityAtoms(row.qty)),lotCode:lot.lot_code,expiryDate:lot.expiry_date,availability:eligible(lot,today)&&!incomplete.has(lot.item_id)?"available":"unavailable",trackingState:incomplete.has(lot.item_id)?"incomplete":"allocated",...(actor.role==="admin"?{quote:quote??null,costState:quote?"estimated":lot.cost_status==="known"?"known":"missing"}:{})};})})),
  storeLocations:allLocations.filter(row=>row.kind==="store"&&row.is_active).map(row=>({id:row.id,label:row.label})),
  pendingTransfers:pending,
  transferOffset:offset,
  hasMoreTransfers:transfers.rows.length>20,
  reconciliationRequired:actor.role==="admin"?ledger.filter(row=>!reconciled(row)).map(row=>({itemId:row.id,name:row.name,unit:row.unit,clinicQuantity:row.global_qty,allocatedQuantity:row.allocated_qty})):[],
  usageEvents:usageRows.map(row=>({id:row.id,usageKey:row.usage_key,locationId:row.location_id,storeLocationId:row.store_location_id,lotId:row.lot_id,name:stock.find(l=>l.id===row.lot_id)?.name??"",unit:stock.find(l=>l.id===row.lot_id)?.unit??"",kind:row.kind,quantity:quantityText(quantityAtoms(row.qty,3,true)),quantityState:row.quantity_state,patientId:row.patient_id,visitId:row.visit_id,caseId:row.case_id,procedureId:row.procedure_id,reason:row.reason,createdAt:row.created_at.toISOString()})),
  stocktakes:stocktakeRows.map(row=>({id:row.id,locationId:row.location_id,lotId:row.lot_id,name:stock.find(l=>l.id===row.lot_id)?.name??"",unit:stock.find(l=>l.id===row.lot_id)?.unit??"",expectedQuantity:quantityText(quantityAtoms(row.expected_qty,3,true)),countedQuantity:quantityText(quantityAtoms(row.counted_qty,3,true)),differenceQuantity:row.difference_qty.startsWith("-")?`-${quantityText(quantityAtoms(row.difference_qty.slice(1),3,true))}`:quantityText(quantityAtoms(row.difference_qty,3,true)),reviewRequired:row.review_required,reason:row.reason,createdAt:row.created_at.toISOString()})),
  packageClosures:closureRows.map(row=>({id:row.id,packageId:row.package_id,evidenceEventId:row.evidence_event_id,locationId:row.location_id,lotId:row.lot_id,name:stock.find(l=>l.id===row.lot_id)?.name??"",hazard:row.hazard,policy:row.policy,evidenceAction:row.evidence_action,unexplainedAtoms:Number(row.unexplained_atoms),reviewRequired:row.review_required,reason:row.reason,createdAt:row.created_at.toISOString()})),
  settlements:settlementRows.map(row=>({id:row.id,doctorPartyId:row.doctor_party_id,periodId:row.period_id,currency:row.currency,appliedDeductionsMinor:Number(row.applied_deductions_minor),attributableConsumptionMinor:row.attributable_consumption_minor===null?null:Number(row.attributable_consumption_minor),supplementalMinor:row.supplemental_minor===null?null:Number(row.supplemental_minor),direction:row.direction,status:row.objection_count>0?"objected_under_review":row.status,objectionCount:row.objection_count,reason:row.reason,createdAt:row.created_at.toISOString()})),
  financialAdjustments:"not_automatic" as const,
 };
 });}

