import { createHash, randomUUID } from "node:crypto";
import { ensureSchema, getPool, insertAuditRow, type DbClient } from "../db";
import { withTransaction } from "../transactions";
import { clinicDateString } from "../schedule";
import { CLINIC_ZONE_FALLBACK } from "../clinicZone";
import { invariant, InventoryDomainError, decimalRatio, convertQuantity, unitConversionSnapshot } from "./quantities";
import { approveRequest, matchSupplierInvoice, payloadIdentity, planInspectedReceipt, planOrderIssue, validateRequest,
  type CommittedSourceAllocation, type RequestRevision, type RequestApproval, type PurchaseOrder,
  type IssuedPurchaseOrder, type ReceiptRevision, type InspectedReceiptLine, type PriorInspectedQuantity,
  type SupplierInvoiceRevision, type InvoiceReceiptAllocation, type ValuationSnapshot } from "./procurement";

/** Temporary single-clinic boundary. The project has no branch identity on this
 * pinned base. Never accept a client invented branch or broaden branch reads. */
export const INVENTORY_CLINIC_SCOPE = "clinic";
export interface InventoryActor { userId: number; username: string; role: string }

function docId(value: string) { invariant(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value), "invalid_document_id", "Document ID must be a UUID"); }
function scope(value: string) { invariant(value === INVENTORY_CLINIC_SCOPE, "branch_forbidden", "This actor is not authorized for that inventory scope"); }
async function ready() {
  await ensureSchema();
  const { rows } = await getPool().query<{ present: boolean }>("SELECT to_regclass('purchase_requests') IS NOT NULL AND to_regclass('inventory_operations') IS NOT NULL AS present");
  if (!rows[0]?.present) throw new InventoryDomainError("schema_not_ready", "Inventory procurement schema awaits coordinated migration");
}
export async function requireInventoryActor(client: DbClient, actor: InventoryActor, management: boolean) {
  const { rows } = await client.query<{ username: string; role: string; is_active: boolean; party_id: number | null }>("SELECT username,role,is_active,party_id FROM users WHERE id=$1 FOR SHARE", [actor.userId]);
  const row = rows[0];
  invariant(row?.is_active && row.username === actor.username && row.role === actor.role, "actor_forbidden", "Authenticated actor is no longer active");
  invariant(management ? row.role === "admin" : ["admin", "reception", "doctor"].includes(row.role), "operation_forbidden", "Actor is not authorized for this operation");
  return row;
}
export async function writeInventoryAudit(client: DbClient, actor: InventoryActor, entity: string, id: string, operation: string, details: Record<string, unknown>) {
  // Reuses the existing throwing transactional audit writer. Specific new action
  // labels are a narrow root-owned audit enum proposal, not a second audit ledger.
  await insertAuditRow(client, { action: "inventory.item", entity, entityId: id, entityLabel: id,
    actor: actor.username, actorRole: actor.role, details: { operation, ...details } });
}
export async function inventoryOperation<T extends object>(actor: InventoryActor, key: string, name: string, payload: unknown, management: boolean, work: (client: DbClient) => Promise<T>): Promise<T & { replayed: boolean }> {
  invariant(typeof key === "string" && /^[A-Za-z0-9_.:-]{8,120}$/.test(key), "invalid_operation_key", "A bounded idempotency key is required");
  const hash = createHash("sha256").update(payloadIdentity(payload)).digest("hex");
  await ready();
  return withTransaction(getPool(), async client => {
    await requireInventoryActor(client, actor, management);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([name, actor.userId, key])]);
    const previous = await client.query<{ payload_hash: string; result: T }>("SELECT payload_hash,result FROM inventory_operations WHERE scope=$1 AND actor_id=$2 AND operation_key=$3", [name,actor.userId,key]);
    if (previous.rows[0]) {
      invariant(previous.rows[0].payload_hash === hash, "idempotency_conflict", "This operation key already identifies different content");
      return { ...previous.rows[0].result, replayed: true };
    }
    const result = await work(client);
    await client.query("INSERT INTO inventory_operations(scope,actor_id,operation_key,payload_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)", [name,actor.userId,key,hash,JSON.stringify(result)]);
    return { ...result, replayed: false };
  });
}
async function verifyUnits(client: DbClient, lines: readonly { itemId: number; conversion: RequestRevision["lines"][number]["conversion"] }[]) {
  invariant(lines.length > 0 && lines.length <= 100, "invalid_lines", "Use between one and 100 document lines");
  const itemIds = [...new Set(lines.map(line => line.itemId))].sort((a,b) => a-b);
  const items = await client.query<{ id: number; unit: string; is_active: boolean }>("SELECT id,unit,is_active FROM inventory_items WHERE id=ANY($1::int[]) ORDER BY id FOR SHARE", [itemIds]);
  const byId = new Map(items.rows.map(row => [row.id,row]));
  for (const line of lines) {
    const conversion = unitConversionSnapshot(line.conversion); const item = byId.get(line.itemId);
    invariant(item?.is_active && item.unit === conversion.baseUnit, "item_unit_mismatch", "An active item's established base unit must match its document");
    const version = await client.query<{ entered_unit:string; base_unit:string; factor:string; entered_precision:number; base_precision:number }>("SELECT entered_unit,base_unit,factor::text,entered_precision,base_precision FROM inventory_item_unit_versions WHERE item_id=$1 AND version=$2", [line.itemId,conversion.version]);
    const row = version.rows[0];
    invariant(row && row.entered_unit === conversion.enteredUnit && row.base_unit === conversion.baseUnit
      && decimalRatio(row.factor).numerator * decimalRatio(conversion.baseUnitsPerEnteredUnit).denominator === decimalRatio(conversion.baseUnitsPerEnteredUnit).numerator * decimalRatio(row.factor).denominator
      && row.entered_precision === conversion.enteredPrecision && row.base_precision === conversion.basePrecision,
      "conversion_version_mismatch", "Use the registered immutable item/package conversion version");
  }
}
export async function submitPurchaseRequest(actor: InventoryActor, key: string, request: RequestRevision) {
  docId(request.id); scope(request.branchId); validateRequest(request);
  invariant(request.requestedBy === actor.userId && request.version === 1, "request_owner_mismatch", "A new request belongs to its authenticated creator at version one");
  return inventoryOperation(actor,key,"request.submit",request,false, async client => {
    await verifyUnits(client,request.lines);
    await client.query("INSERT INTO purchase_requests(id,branch_key,current_version,status,requested_by) VALUES($1,$2,1,'submitted',$3)",[request.id,request.branchId,actor.userId]);
    await client.query("INSERT INTO purchase_request_revisions(request_id,version,document) VALUES($1,1,$2::jsonb)",[request.id,JSON.stringify(request)]);
    for (const line of request.lines) {
      const quantity=convertQuantity(line.quantity,line.conversion);
      await client.query("INSERT INTO purchase_request_lines(request_id,request_version,id,item_id,entered_qty,base_qty,conversion) VALUES($1,1,$2,$3,$4::numeric,$5::numeric,$6::jsonb)",[request.id,line.id,line.itemId,quantity.enteredQuantity,quantity.baseQuantity,JSON.stringify(quantity.conversion)]);
    }
    await writeInventoryAudit(client,actor,"purchase_request",request.id,"submit",{version:1,lines:request.lines.length});
    return { id:request.id,status:"submitted" as const,version:1 };
  });
}
async function lockedRequest(client: DbClient,id:string) {
  docId(id);
  const row=await client.query<{ current_version:number; status: "submitted"|"approved"|"partially_approved"|"rejected"; requested_by:number; branch_key:string }>("SELECT current_version,status,requested_by,branch_key FROM purchase_requests WHERE id=$1 FOR UPDATE",[id]);
  invariant(row.rows[0],"not_found","Purchase request was not found"); scope(row.rows[0].branch_key);
  const revision=await client.query<{ document:RequestRevision }>("SELECT document FROM purchase_request_revisions WHERE request_id=$1 AND version=$2",[id,row.rows[0].current_version]);
  return { ...row.rows[0],request:revision.rows[0].document };
}
/** Administration records a new monetary proposal before ordering.
 * Previous document and approvals remain immutable; a new version is submitted
 * and must be approved again. Once ordered, use a separately reviewed amendment
 * workflow instead of authorizing the same demand again through a revision.
 */
export async function revisePurchaseRequest(actor:InventoryActor,key:string,input:{requestId:string;expectedVersion:number;value:RequestRevision["value"];reason:string}){
  invariant(Number.isSafeInteger(input.expectedVersion)&&input.expectedVersion>0&&input.expectedVersion<100000,"stale_version","An exact current version is required");
  invariant(typeof input.reason==="string"&&input.reason.trim().length>0&&input.reason.length<=2000,"reason_required","A bounded revision reason is required");
  invariant(input.value!==null&&typeof input.value==="object","missing_valuation","Record an explicit monetary proposal");
  return inventoryOperation(actor,key,"request.revise",input,true,async client=>{
    const current=await lockedRequest(client,input.requestId);invariant(current.current_version===input.expectedVersion,"stale_version","The request changed; reload before revising");
    const issued=await client.query("SELECT id FROM purchase_order_source_allocations WHERE request_id=$1 LIMIT 1 FOR SHARE",[input.requestId]);invariant(!issued.rows.length,"invalid_transition","An ordered request requires a separately approved amendment; its demand cannot be reused through revision");
    const document:RequestRevision={...current.request,version:current.current_version+1,value:input.value};validateRequest(document);await verifyUnits(client,document.lines);
    await client.query("INSERT INTO purchase_request_revisions(request_id,version,document) VALUES($1,$2,$3::jsonb)",[input.requestId,document.version,JSON.stringify(document)]);
    for(const line of document.lines){const quantity=convertQuantity(line.quantity,line.conversion);await client.query("INSERT INTO purchase_request_lines(request_id,request_version,id,item_id,entered_qty,base_qty,conversion) VALUES($1,$2,$3,$4,$5::numeric,$6::numeric,$7::jsonb)",[input.requestId,document.version,line.id,line.itemId,quantity.enteredQuantity,quantity.baseQuantity,JSON.stringify(quantity.conversion)]);}
    await client.query("UPDATE purchase_requests SET current_version=$2,status='submitted' WHERE id=$1",[input.requestId,document.version]);
    await writeInventoryAudit(client,actor,"purchase_request",input.requestId,"revise",{previousVersion:input.expectedVersion,version:document.version,reason:input.reason,value:input.value});
    return {id:input.requestId,version:document.version,status:"submitted" as const};
  });
}
export async function approvePurchaseRequest(actor:InventoryActor,key:string,input:{ requestId:string; version:number; decisions: Parameters<typeof approveRequest>[0]["decisions"]; valuation:ValuationSnapshot|null; selfApprovalReason?:string|null }) {
  return inventoryOperation(actor,key,"request.approve",input,true,async client=>{
    const current=await lockedRequest(client,input.requestId);
    invariant(current.current_version === input.version,"stale_version","The request was revised; reload before approving");
    const policies=await client.query<{version:number;currency:"YER";limit_minor:string;allow_self_approval:boolean}>("SELECT version,currency,limit_minor::text,allow_self_approval FROM inventory_approval_policies WHERE branch_key=$1 ORDER BY version DESC LIMIT 1 FOR SHARE",[INVENTORY_CLINIC_SCOPE]);
    const policy=policies.rows[0];
    invariant(policy,"policy_not_configured","An explicit approval limit/policy must be configured before approval");
    const decision=approveRequest({request:current.request,state:current.status as "submitted",actorId:actor.userId,
      canApprove:true,allowedBranchIds:[INVENTORY_CLINIC_SCOPE],policy:{version:policy.version,currency:policy.currency,limitMinor:Number(policy.limit_minor),allowSelfApproval:policy.allow_self_approval},
      selfApprovalReason:input.selfApprovalReason ?? null,valuation:input.valuation,decisions:input.decisions});
    await client.query("INSERT INTO purchase_approval_events(id,request_id,request_version,actor_id,decision) VALUES($1,$2,$3,$4,$5::jsonb)",[randomUUID(),input.requestId,input.version,actor.userId,JSON.stringify(decision)]);
    await client.query("UPDATE purchase_requests SET status=$2 WHERE id=$1",[input.requestId,decision.status]);
    await writeInventoryAudit(client,actor,"purchase_request",input.requestId,"approve",{version:input.version,status:decision.status,decision});
    return {id:input.requestId,version:input.version,status:decision.status};
  });
}
export async function issuePurchaseOrder(actor:InventoryActor,key:string,order:PurchaseOrder) {
  docId(order.id); scope(order.branchId);
  return inventoryOperation(actor,key,"order.issue",order,true,async client=>{
    const sources=[...new Set(order.lines.flatMap(line=>line.sources.map(source=>source.requestId)))].sort();
    const requests:{request:RequestRevision;approval:RequestApproval}[]=[];
    for(const id of sources){
      const current=await lockedRequest(client,id);
      const event=await client.query<{decision:RequestApproval}>("SELECT decision FROM purchase_approval_events WHERE request_id=$1 AND request_version=$2",[id,current.current_version]);
      invariant(event.rows[0],"unapproved_source","This request revision has no approval");
      requests.push({request:current.request,approval:event.rows[0].decision});
    }
    await verifyUnits(client,order.lines);
    const supplier=await client.query<{id:number;kind:string;is_active:boolean}>("SELECT id,kind,is_active FROM parties WHERE id=$1 FOR SHARE",[order.supplierPartyId]);
    const old=await client.query<{id:string;request_id:string;request_line_id:string;base_qty:string;amount_minor:string;currency:CommittedSourceAllocation["currency"];base_amount_minor:string}>("SELECT id,request_id,request_line_id,base_qty::text,amount_minor::text,currency,base_amount_minor::text FROM purchase_order_source_allocations WHERE request_id=ANY($1::uuid[])",[sources]);
    const prior=old.rows.map(row=>({id:row.id,requestId:row.request_id,requestLineId:row.request_line_id,baseQuantity:row.base_qty,currency:row.currency,amountMinor:Number(row.amount_minor),baseAmountMinor:Number(row.base_amount_minor)}));
    const party=supplier.rows[0];
    const plan=planOrderIssue({order,requests,priorAllocations:prior,supplier:{id:party?.id ?? 0,active:party?.is_active ?? false,isSupplier:party?.kind === "supplier"}});
    await client.query("INSERT INTO purchase_orders(id,branch_key,supplier_party_id,document,created_by) VALUES($1,$2,$3,$4::jsonb,$5)",[order.id,order.branchId,order.supplierPartyId,JSON.stringify(plan.order),actor.userId]);
    for(const line of order.lines){
      await client.query("INSERT INTO purchase_order_lines(order_id,id,item_id,ordered_base_qty) VALUES($1,$2,$3,$4::numeric)",[order.id,line.id,line.itemId,convertQuantity(line.quantity,line.conversion).baseQuantity]);
      for(const source of line.sources){
        const amount=plan.allocations.find(row=>row.id===source.id)!;
        const revision=requests.find(row=>row.request.id===source.requestId)!.request.version;
        await client.query("INSERT INTO purchase_order_source_allocations(id,order_id,order_line_id,request_id,request_version,request_line_id,base_qty,amount_minor,currency,base_amount_minor) VALUES($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9,$10)",[source.id,order.id,line.id,source.requestId,revision,source.requestLineId,source.baseQuantity,amount.amountMinor,amount.currency,amount.baseAmountMinor]);
      }
    }
    await writeInventoryAudit(client,actor,"purchase_order",order.id,"issue",{version:order.version,total:plan.totalMinor,currency:order.currency});
    return {id:order.id,status:"issued" as const,totalMinor:plan.totalMinor,currency:order.currency};
  });
}
async function lockedOrder(client:DbClient,id:string):Promise<IssuedPurchaseOrder>{
  docId(id);const order=await client.query<{document:IssuedPurchaseOrder}>("SELECT document FROM purchase_orders WHERE id=$1 FOR UPDATE",[id]);
  invariant(order.rows[0],"not_found","Purchase order was not found");scope(order.rows[0].document.branchId);return order.rows[0].document;
}
export async function postInspectedReceipt(actor:InventoryActor,key:string,receipt:ReceiptRevision){
  docId(receipt.id);scope(receipt.branchId);
  return inventoryOperation(actor,key,"receipt.post",receipt,true,async client=>{
    const order=await lockedOrder(client,receipt.orderId);
    const old=await client.query<{order_line_id:string;accepted:string;quarantined:string;rejected:string}>(`SELECT order_line_id,
      COALESCE(SUM(base_qty) FILTER(WHERE disposition='accepted'),0)::text AS accepted,
      COALESCE(SUM(base_qty) FILTER(WHERE disposition='quarantined'),0)::text AS quarantined,
      COALESCE(SUM(base_qty) FILTER(WHERE disposition='rejected'),0)::text AS rejected
      FROM goods_receipt_lines WHERE order_id=$1 GROUP BY order_line_id`,[order.id]);
    const prior:PriorInspectedQuantity[]=old.rows.map(row=>({orderLineId:row.order_line_id,acceptedBaseQuantity:row.accepted,quarantinedBaseQuantity:row.quarantined,rejectedBaseQuantity:row.rejected}));
    const postingDate=clinicDateString(new Date(),CLINIC_ZONE_FALLBACK);
    const plan=planInspectedReceipt(order,receipt,prior,postingDate);
    const locations=[...new Set(plan.lines.map(line=>line.locationId))].sort();
    const places=await client.query<{id:string;branch_key:string;is_active:boolean}>("SELECT id,branch_key,is_active FROM inventory_locations WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE",[locations]);
    for(const locationId of locations){const place=places.rows.find(row=>row.id===locationId);invariant(place?.is_active && place.branch_key===receipt.branchId,"location_forbidden","Receipt location is unavailable in this inventory scope");}
    const itemIds=[...new Set(plan.stockEntries.map(line=>line.itemId))].sort((a,b)=>a-b);
    const items=await client.query<{id:number;is_active:boolean;unit:string}>("SELECT id,is_active,unit FROM inventory_items WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE",[itemIds]);
    for(const line of plan.stockEntries){const item=items.rows.find(row=>row.id===line.itemId);const source=plan.lines.find(row=>row.id===line.receiptLineId)!;invariant(item?.is_active && item.unit===source.conversion.baseUnit,"item_unit_mismatch","Receipt item/unit has changed since approval");}
    await client.query("INSERT INTO goods_receipts(id,order_id,document,created_by) VALUES($1,$2,$3::jsonb,$4)",[receipt.id,order.id,JSON.stringify(receipt),actor.userId]);
    for(const line of plan.lines){await client.query("INSERT INTO goods_receipt_lines(id,receipt_id,order_id,order_line_id,disposition,base_qty,document) VALUES($1,$2,$3,$4,$5,$6::numeric,$7::jsonb)",[line.id,receipt.id,order.id,line.orderLineId,line.disposition,line.baseQuantity,JSON.stringify(line)]);}
    for(const entry of plan.stockEntries){
      const line=plan.lines.find(row=>row.id===entry.receiptLineId)!;
      // Receipt is stock only. No supplierPartyId/payable/expense writer call.
      // Existing bigint unit cost cannot represent all converted piece costs.
      // Preserve unknown legacy WAC and an explicit rational provisional quote
      // snapshot rather than silently rounding a cheap piece to zero.
      const movement=await client.query<{id:number}>("INSERT INTO inventory_movements(item_id,kind,qty,expiry_date,reason,created_by,unit_cost_minor,is_return) VALUES($1,'in',$2::numeric,$3::date,$4,$5,NULL,FALSE) RETURNING id",[entry.itemId,entry.baseQuantity,line.expiryDate,`Inspected receipt ${receipt.id}`,actor.username]);
      const source=order.lines.find(row=>row.id===line.orderLineId)!;const lotId=randomUUID();
      await client.query("INSERT INTO stock_lots(id,receipt_line_id,item_id,location_id,movement_id,lot_code,expiry_date,status,cost_status,cost_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7::date,$8,'estimated',$9::jsonb)",[lotId,line.id,line.itemId,line.locationId,movement.rows[0].id,line.lotCode,line.expiryDate,line.disposition,JSON.stringify({source:"approved_order_quote",currency:order.currency,price:source.price,conversion:line.conversion,requiresExpiry:source.requiresExpiry,financialValuation:"pending_invoice_adapter"})]);
      await client.query("INSERT INTO inventory_movement_allocations(id,movement_id,lot_id,location_id,qty) VALUES($1,$2,$3,$4,$5::numeric)",[randomUUID(),movement.rows[0].id,lotId,line.locationId,entry.baseQuantity]);
    }
    await writeInventoryAudit(client,actor,"goods_receipt",receipt.id,"post",{version:receipt.version,actualArrivalDate:receipt.actualArrivalDate,postingDate,inspection:plan.lines});
    return {id:receipt.id,status:"posted" as const,remaining:plan.remaining,stockEntries:plan.stockEntries,financialEffects:plan.financialEffects};
  });
}
export async function recordSupplierInvoiceMatch(actor:InventoryActor,key:string,invoice:SupplierInvoiceRevision){
  docId(invoice.id);scope(invoice.branchId);
  return inventoryOperation(actor,key,"invoice.match",invoice,true,async client=>{
    const order=await lockedOrder(client,invoice.orderId);
    const receipts=await client.query<{document:InspectedReceiptLine}>("SELECT document FROM goods_receipt_lines WHERE order_id=$1 ORDER BY id",[order.id]);
    const priorRows=await client.query<{id:string;invoice_line_id:string;receipt_line_id:string;base_qty:string}>("SELECT a.id,a.invoice_line_id,a.receipt_line_id,a.base_qty::text FROM supplier_invoice_receipt_allocations a JOIN supplier_invoices i ON i.id=a.invoice_id WHERE i.order_id=$1",[order.id]);
    const prior:InvoiceReceiptAllocation[]=priorRows.rows.map(row=>({id:row.id,invoiceLineId:row.invoice_line_id,receiptLineId:row.receipt_line_id,baseQuantity:row.base_qty}));
    const match=matchSupplierInvoice(order,invoice,receipts.rows.map(row=>row.document),prior);
    await client.query("INSERT INTO supplier_invoices(id,order_id,supplier_party_id,duplicate_key,document,match_plan,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)",[invoice.id,order.id,invoice.supplierPartyId,match.duplicateKey,JSON.stringify(invoice),JSON.stringify(match),actor.userId]);
    if(match.status === "matched")for(const line of invoice.lines)for(const allocation of line.receiptAllocations){await client.query("INSERT INTO supplier_invoice_receipt_allocations(id,invoice_id,invoice_line_id,receipt_line_id,base_qty) VALUES($1,$2,$3,$4,$5::numeric)",[allocation.id,invoice.id,line.id,allocation.receiptLineId,allocation.baseQuantity]);}
    await writeInventoryAudit(client,actor,"supplier_invoice",invoice.id,"match",{version:invoice.version,status:match.status,issues:match.issues});
    return {id:invoice.id,status:match.status,match,financialPosting:"pending_shared_finance_review" as const};
  });
}
export async function readProcurementRequests(actor:InventoryActor,offset=0){
  await ready();return withTransaction(getPool(),async client=>{
    await requireInventoryActor(client,actor,false);
    const rows=await client.query<{id:string;current_version:number;status:string;document:RequestRevision;decision:RequestApproval|null}>(`SELECT p.id,p.current_version,p.status,r.document,a.decision FROM purchase_requests p
      JOIN purchase_request_revisions r ON r.request_id=p.id AND r.version=p.current_version
      LEFT JOIN purchase_approval_events a ON a.request_id=p.id AND a.request_version=p.current_version
      WHERE p.branch_key=$1 AND ($2 OR p.requested_by=$3) ORDER BY p.created_at DESC,p.id LIMIT 21 OFFSET $4`,[INVENTORY_CLINIC_SCOPE,actor.role === "admin",actor.userId,offset]);
    const shown=rows.rows.slice(0,20),ids=[...new Set(shown.flatMap(row=>row.document.lines.map(line=>line.itemId)))];
    const names=await client.query<{id:number;name:string}>("SELECT id,name FROM inventory_items WHERE id=ANY($1::int[])",[ids]);
    return {items:shown.map(row=>({id:row.id,version:row.current_version,status:row.status,document:actor.role === "admin"?row.document:{...row.document,value:null},decision:actor.role === "admin"?row.decision:row.decision?{...row.decision,valueCeiling:null}:null})),itemNames:Object.fromEntries(names.rows.map(row=>[row.id,row.name])),hasMore:rows.rows.length>20};
  });
}
export async function readProcurementCatalog(actor:InventoryActor){
  await ready();return withTransaction(getPool(),async client=>{
    await requireInventoryActor(client,actor,false);
    const rows=await client.query<{item_id:number;name:string;version:number;entered_unit:string;base_unit:string;factor:string;entered_precision:number;base_precision:number}>(`SELECT p.item_id,i.name,p.version,p.entered_unit,p.base_unit,p.factor::text,p.entered_precision,p.base_precision
      FROM inventory_item_unit_versions p JOIN inventory_items i ON i.id=p.item_id
      WHERE i.is_active AND i.unit=p.base_unit ORDER BY i.name,p.version DESC LIMIT 200`);
    return {items:rows.rows.map(row=>({itemId:row.item_id,name:row.name,conversion:unitConversionSnapshot({itemId:row.item_id,version:row.version,baseUnit:row.base_unit,enteredUnit:row.entered_unit,baseUnitsPerEnteredUnit:row.factor,enteredPrecision:row.entered_precision,basePrecision:row.base_precision})})),scope:INVENTORY_CLINIC_SCOPE};
  });
}
/** Administrator-only source documents for the order/inspection workbench.
 * Each page is a fresh authorized snapshot; posting still re-locks and validates
 * all source quantities, budgets and party/location ownership in its transaction.
 */
export async function readProcurementWorkbench(actor:InventoryActor,requestOffset=0,orderOffset=0){
  for(const offset of [requestOffset,orderOffset])invariant(Number.isSafeInteger(offset)&&offset>=0&&offset<=100000,"invalid_page","Invalid page offset");
  await ready();return withTransaction(getPool(),async client=>{
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await requireInventoryActor(client,actor,true);
    const requests=await client.query<{id:string;document:RequestRevision;decision:RequestApproval}>(`SELECT p.id,r.document,a.decision FROM purchase_requests p JOIN purchase_request_revisions r ON r.request_id=p.id AND r.version=p.current_version JOIN purchase_approval_events a ON a.request_id=p.id AND a.request_version=p.current_version WHERE p.branch_key=$1 AND p.status IN ('approved','partially_approved') ORDER BY p.created_at DESC,p.id LIMIT 21 OFFSET $2`,[INVENTORY_CLINIC_SCOPE,requestOffset]);
    const sources=await client.query<{request_id:string;request_line_id:string;qty:string;amount:string;currency:PurchaseOrder["currency"]}>("SELECT request_id,request_line_id,currency,SUM(base_qty)::text AS qty,SUM(amount_minor)::text AS amount FROM purchase_order_source_allocations WHERE request_id=ANY($1::uuid[]) GROUP BY request_id,request_line_id,currency",[requests.rows.slice(0,20).map(row=>row.id)]);
    invariant(sources.rows.every(row=>requests.rows.find(request=>request.id===row.request_id)?.decision.valueCeiling?.currency===row.currency),"currency_mismatch","Source allocations require their original approved currency");
    const suppliers=await client.query<{id:number;name:string}>("SELECT id,name FROM parties WHERE kind='supplier' AND is_active ORDER BY name,id");
    const locations=await client.query<{id:string;label:string;kind:string}>("SELECT id,label,kind FROM inventory_locations WHERE branch_key=$1 AND is_active ORDER BY label,id",[INVENTORY_CLINIC_SCOPE]);
    const orders=await client.query<{id:string;document:IssuedPurchaseOrder}>("SELECT id,document FROM purchase_orders WHERE branch_key=$1 ORDER BY created_at DESC,id LIMIT 21 OFFSET $2",[INVENTORY_CLINIC_SCOPE,orderOffset]);
    const orderIds=orders.rows.slice(0,20).map(row=>row.id);
    const orderResults=await client.query<{result:{id:string;totalMinor:number;currency:PurchaseOrder["currency"]}}>("SELECT result FROM inventory_operations WHERE scope='order.issue' AND result->>'id'=ANY($1::text[])",[orderIds]);
    const receiptHeaders=await client.query<{id:string;document:ReceiptRevision}>("SELECT id,document FROM goods_receipts WHERE order_id=ANY($1::uuid[]) ORDER BY created_at,id",[orderIds]);
    const receipts=await client.query<{id:string;order_id:string;document:InspectedReceiptLine}>("SELECT id,order_id,document FROM goods_receipt_lines WHERE order_id=ANY($1::uuid[]) ORDER BY receipt_id,id",[orderIds]);
    const allocations=await client.query<{receipt_line_id:string;qty:string}>("SELECT a.receipt_line_id,SUM(a.base_qty)::text AS qty FROM supplier_invoice_receipt_allocations a JOIN supplier_invoices i ON i.id=a.invoice_id WHERE i.order_id=ANY($1::uuid[]) GROUP BY a.receipt_line_id",[orderIds]);
    const invoices=await client.query<{id:string;order_id:string;document:SupplierInvoiceRevision;match_plan:ReturnType<typeof matchSupplierInvoice>}>("SELECT id,order_id,document,match_plan FROM supplier_invoices WHERE order_id=ANY($1::uuid[]) ORDER BY created_at,id",[orderIds]);
    const itemIds=[...new Set([...requests.rows.slice(0,20).flatMap(row=>row.document.lines.map(line=>line.itemId)),...orders.rows.slice(0,20).flatMap(row=>row.document.lines.map(line=>line.itemId))])];
    const names=await client.query<{id:number;name:string}>("SELECT id,name FROM inventory_items WHERE id=ANY($1::int[])",[itemIds]);
    return {scope:INVENTORY_CLINIC_SCOPE,requests:requests.rows.slice(0,20),sourceAllocations:sources.rows,suppliers:suppliers.rows,locations:locations.rows,orders:orders.rows.slice(0,20),orderResults:orderResults.rows.map(row=>row.result),receiptHeaders:receiptHeaders.rows,receipts:receipts.rows,invoiceAllocations:allocations.rows,invoices:invoices.rows,itemNames:Object.fromEntries(names.rows.map(row=>[row.id,row.name])),hasMoreRequests:requests.rows.length>20,hasMoreOrders:orders.rows.length>20,requestOffset,orderOffset,financialPosting:"pending_shared_finance_review" as const};
  });
}
