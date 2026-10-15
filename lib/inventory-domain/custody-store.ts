import { randomUUID } from "node:crypto";
import { ensureSchema,getPool,type DbClient } from "../db";
import { withTransaction } from "../transactions";
import { clinicDateString } from "../schedule";
import { CLINIC_ZONE_FALLBACK } from "../clinicZone";
import { invariant,InventoryDomainError,quantityAtoms,quantityText,decimalRatio } from "./quantities";
import { allocateMinor,planHistoricalReconciliation } from "./procurement";
import { INVENTORY_CLINIC_SCOPE,inventoryOperation,requireInventoryActor,writeInventoryAudit,type InventoryActor } from "./procurement-store";
import type { Currency } from "../money";

interface Location {id:string;label:string;kind:"store"|"custody"|"transit";doctor_party_id:number|null;branch_key:string;is_active:boolean}
interface Lot {id:string;item_id:number;name:string;unit:string;status:string;unreleased_qty:string;receipt_location_id:string;expiry_date:string|null;lot_code:string|null;cost_status:string;cost_snapshot:Record<string,unknown>}
export interface CustodyDispatch {id:string;fromLocationId:string;toLocationId:string;transitLocationId:string;reason:string;lines:{id:string;lotId:string;quantity:string}[]}
export interface CustodyAcknowledgement {id:string;transferId:string;reason:string;lines:{lineId:string;acceptedQuantity:string;returnedQuantity:string}[]}
export interface LegacyReconciliationInput {id:string;itemId:number;locationId:string;reason:string;requiresExpiry?:boolean}
const uuid=(id:string)=>invariant(typeof id==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),"invalid_document_id","Use a document UUID");
const reason=(value:string)=>invariant(typeof value==="string"&&value.trim().length>0&&value.length<=2000,"reason_required","A bounded reason is required");
async function ready(){await ensureSchema();const r=await getPool().query<{present:boolean}>("SELECT to_regclass('inventory_transfers') IS NOT NULL AS present");if(!r.rows[0]?.present)throw new InventoryDomainError("schema_not_ready","Doctor custody schema awaits coordinated migration");}
const BALANCES_SQL=`SELECT lot_id,location_id,SUM(delta)::text AS qty FROM (
 SELECT a.lot_id,a.location_id,CASE WHEN m.kind='out' OR(m.kind='adjust' AND m.qty<0) THEN -a.qty ELSE a.qty END AS delta
 FROM inventory_movement_allocations a JOIN inventory_movements m ON m.id=a.movement_id
 UNION ALL SELECT l.lot_id,t.from_location_id,-l.qty FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.id=l.transfer_id
 UNION ALL SELECT l.lot_id,t.transit_location_id,l.qty FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.id=l.transfer_id
 UNION ALL SELECT l.lot_id,t.transit_location_id,-(a.accepted_qty+a.returned_qty) FROM inventory_transfer_ack_lines a JOIN inventory_transfer_lines l ON l.id=a.transfer_line_id JOIN inventory_transfers t ON t.id=l.transfer_id
 UNION ALL SELECT l.lot_id,t.to_location_id,a.accepted_qty FROM inventory_transfer_ack_lines a JOIN inventory_transfer_lines l ON l.id=a.transfer_line_id JOIN inventory_transfers t ON t.id=l.transfer_id
 UNION ALL SELECT l.lot_id,t.from_location_id,a.returned_qty FROM inventory_transfer_ack_lines a JOIN inventory_transfer_lines l ON l.id=a.transfer_line_id JOIN inventory_transfers t ON t.id=l.transfer_id
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
function roundedQuote(lot:Lot,quantity:string):{currency:Currency;amountMinor:number}|null{
 try{const price=lot.cost_snapshot.price as {state:string;currency:string;unitPriceMinor:number};const conversion=lot.cost_snapshot.conversion as {baseUnitsPerEnteredUnit:string};const currency=lot.cost_snapshot.currency as Currency;
  if(!price||price.state!=="known"||!["YER","SAR","USD"].includes(currency)||price.currency!==currency||!Number.isSafeInteger(price.unitPriceMinor)||price.unitPriceMinor<0)return null;
  const factor=decimalRatio(conversion.baseUnitsPerEnteredUnit);if(factor.numerator<=0n)return null;const numerator=BigInt(price.unitPriceMinor)*quantityAtoms(quantity,3,true)*factor.denominator,denominator=1000n*factor.numerator;const rounded=(numerator*2n+denominator)/(denominator*2n);if(rounded>BigInt(Number.MAX_SAFE_INTEGER))return null;return {currency,amountMinor:Number(rounded)};
 }catch{return null;}
}
export async function readDoctorCustody(actor:InventoryActor,offset=0){invariant(Number.isSafeInteger(offset)&&offset>=0&&offset<=100000,"invalid_page","Invalid page offset");await ready();return withTransaction(getPool(),async client=>{
 const who=await requireInventoryActor(client,actor,false);invariant(actor.role==="admin"||(actor.role==="doctor"&&who.party_id!==null),"custody_read_forbidden","Custody statements are limited to the doctor owner or administrator");
 const allLocations=await locations(client);const visible=allLocations.filter(row=>actor.role==="admin"||(row.kind==="custody"&&row.doctor_party_id===who.party_id));const stock=await lots(client);const current=await balances(client);const today=clinicDateString(new Date(),CLINIC_ZONE_FALLBACK);const ledger=await ledgerRows(client);const incomplete=new Set(ledger.filter(row=>!reconciled(row)).map(row=>row.id));
 const values=new Map<string,{currency:Currency;amountMinor:number}>();if(actor.role==="admin")for(const lot of stock){const rows=current.filter(row=>row.lot_id===lot.id&&quantityAtoms(row.qty,3,true)>0n);if(!rows.length)continue;const total=rows.reduce((sum,row)=>sum+quantityAtoms(row.qty),0n);const quote=roundedQuote(lot,quantityText(total));if(quote)for(const share of allocateMinor(quote.amountMinor,rows.map(row=>({id:row.location_id,weight:String(quantityAtoms(row.qty))}))))values.set(`${lot.id}:${share.id}`,{currency:quote.currency,amountMinor:share.amountMinor});}
 const transfers=await client.query<{id:string;from_location_id:string;to_location_id:string;transit_location_id:string;reason:string;created_at:Date}>(`SELECT t.id,t.from_location_id,t.to_location_id,t.transit_location_id,t.reason,t.created_at FROM inventory_transfers t WHERE (t.to_location_id=ANY($1::text[]) OR ($2 AND t.from_location_id=ANY($1::text[]))) AND EXISTS (SELECT 1 FROM inventory_transfer_lines l WHERE l.transfer_id=t.id AND l.qty>COALESCE((SELECT SUM(a.accepted_qty+a.returned_qty) FROM inventory_transfer_ack_lines a WHERE a.transfer_line_id=l.id),0)) ORDER BY t.created_at DESC,t.id LIMIT 21 OFFSET $3`,[visible.map(row=>row.id),actor.role==="admin",offset]);
 const pending=[];for(const transfer of transfers.rows.slice(0,20)){const lines=await client.query<{id:string;lot_id:string;remaining:string}>(`SELECT l.id,l.lot_id,(l.qty-COALESCE((SELECT SUM(a.accepted_qty+a.returned_qty) FROM inventory_transfer_ack_lines a WHERE a.transfer_line_id=l.id),0))::text AS remaining FROM inventory_transfer_lines l WHERE transfer_id=$1 ORDER BY id`,[transfer.id]);const open=lines.rows.filter(line=>quantityAtoms(line.remaining,3,true)>0n);if(open.length)pending.push({id:transfer.id,reason:transfer.reason,fromLabel:allLocations.find(row=>row.id===transfer.from_location_id)?.label??"",destinationLabel:allLocations.find(row=>row.id===transfer.to_location_id)?.label??"",createdAt:transfer.created_at.toISOString(),lines:open.map(line=>({id:line.id,lotId:line.lot_id,name:stock.find(row=>row.id===line.lot_id)?.name??"",unit:stock.find(row=>row.id===line.lot_id)?.unit??"",remainingQuantity:quantityText(quantityAtoms(line.remaining))}))});}
 return {scope:INVENTORY_CLINIC_SCOPE,pricesAllowed:actor.role==="admin",locations:visible.map(place=>({id:place.id,label:place.label,kind:place.kind,doctorPartyId:place.doctor_party_id,lots:current.filter(row=>row.location_id===place.id&&quantityAtoms(row.qty,3,true)>0n).map(row=>{const lot=stock.find(lot=>lot.id===row.lot_id)!;const quote=values.get(`${lot.id}:${place.id}`);return {lotId:lot.id,itemId:lot.item_id,name:lot.name,unit:lot.unit,quantity:quantityText(quantityAtoms(row.qty)),lotCode:lot.lot_code,expiryDate:lot.expiry_date,availability:eligible(lot,today)&&!incomplete.has(lot.item_id)?"available":"unavailable",trackingState:incomplete.has(lot.item_id)?"incomplete":"allocated",...(actor.role==="admin"?{quote:quote??null,costState:quote?"estimated":lot.cost_status==="known"?"known":"missing"}:{})};})})),pendingTransfers:pending,transferOffset:offset,hasMoreTransfers:transfers.rows.length>20,reconciliationRequired:actor.role==="admin"?ledger.filter(row=>!reconciled(row)).map(row=>({itemId:row.id,name:row.name,unit:row.unit,clinicQuantity:row.global_qty,allocatedQuantity:row.allocated_qty})):[],financialAdjustments:"not_automatic" as const};
 });}
