import { PURCHASE_RESET_FENCE } from "../clinic-reset";
import { requireInventoryIntegration } from "./rollout";
import { readInventoryCommandBinding, authorizeInventoryCommandBinding } from "./command-fence";
import type { InventoryPrincipal } from "./principal";
import { assertCanonicalInventoryAuthority, canonicalAuthorityOfClient, canonicalInventoryClient, canonicalInventoryGrant, isCanonicalInventoryAuthority, type CanonicalInventoryAuthority } from "./canonical-operation";
import { runCanonicalReadSnapshot } from "../canonical-read-snapshot";
import type { VerifiedDurableSession } from "../staff-durable-session";
import { createHash, randomUUID } from "node:crypto";
import { ensureSchema, getPool, insertAuditRow, type DbClient } from "../db";
import { withTransaction } from "../transactions";
import { clinicDateString } from "../schedule";
import { CLINIC_ZONE_FALLBACK } from "../clinicZone";
import { invariant, InventoryDomainError, decimalRatio, convertQuantity, unitConversionSnapshot } from "./quantities";
import { sanitizeInventoryAuditDetails } from "./presentation";
import {
  approveRequest,
  matchSupplierInvoice,
  payloadIdentity,
  planInspectedReceipt,
  planOrderAmendment,
  planOrderIssue,
  planQuarantineResolution,
  validateRequest,
  type CommittedSourceAllocation,
  type RequestRevision,
  type RequestApproval,
  type PurchaseOrder,
  type IssuedPurchaseOrder,
  type ReceiptRevision,
  type InspectedReceiptLine,
  type PriorInspectedQuantity,
  type SupplierInvoiceRevision,
  type InvoiceReceiptAllocation,
  type ValuationSnapshot,
  type QuarantineResolutionAction,
} from "./procurement";

/** Temporary single-clinic boundary. The project has no branch identity on this
 * pinned base. Never accept a client invented branch or broaden branch reads. */
export const INVENTORY_CLINIC_SCOPE = "clinic";
/** Serialized size bound for one canonical inventory read snapshot. */
export const INVENTORY_READ_MAX_BYTES = 4 * 1024 * 1024;
export interface InventoryActor { userId: number; username: string; role: string }
/** Legacy marker-free deployments pass the existing role policy (`true` = management).
 * Canonical deployments pass the opaque admitted authority token; its role label is
 * presentation only and every decision below comes from exact current grants. */
export type InventoryPolicy = boolean | CanonicalInventoryAuthority;
/** Recorded on command bindings so a policy can never be swapped between admission and execution. */
export function inventoryPolicyFlag(policy: InventoryPolicy): boolean {
  return isCanonicalInventoryAuthority(policy) ? true : policy;
}
/** Financial values (costs, prices, valuations) in reads and audit details. */
export function inventoryFinancialsVisible(actor: InventoryActor, policy?: InventoryPolicy): boolean {
  return isCanonicalInventoryAuthority(policy) ? canonicalInventoryGrant(policy, "inventory.costs.view") : actor.role === "admin";
}
/** Oversight of all purchase requests (otherwise only the actor's own). */
export function inventoryAllRequestsVisible(actor: InventoryActor, policy?: InventoryPolicy): boolean {
  return isCanonicalInventoryAuthority(policy) ? canonicalInventoryGrant(policy, "inventory.requests.approve") || canonicalInventoryGrant(policy, "inventory.orders.manage") : actor.role === "admin";
}

function docId(value: string) { invariant(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value), "invalid_document_id", "Document ID must be a UUID"); }
function scope(value: string) { invariant(value === INVENTORY_CLINIC_SCOPE, "branch_forbidden", "This actor is not authorized for that inventory scope"); }
async function ready() {
  requireInventoryIntegration();
  await ensureSchema();
  const { rows } = await getPool().query<{ present: boolean }>("SELECT to_regclass('purchase_requests') IS NOT NULL AND to_regclass('inventory_operations') IS NOT NULL AS present");
  if (!rows[0]?.present) throw new InventoryDomainError("schema_not_ready", "Inventory procurement schema awaits coordinated migration");
}
/** Canonical snapshot readers check presence read-only; they never call ensureSchema. */
async function assertProcurementSchema(client: Pick<DbClient, "query">) {
  const { rows } = await client.query<{ present: boolean }>("SELECT to_regclass('purchase_requests') IS NOT NULL AND to_regclass('inventory_operations') IS NOT NULL AS present");
  if (!rows[0]?.present) throw new InventoryDomainError("schema_not_ready", "Inventory procurement schema awaits coordinated migration");
}
export async function requireInventoryActor(client: DbClient, actor: InventoryActor, requested: InventoryPolicy) {
  // A canonical transaction never applies a role policy, whatever the caller passed.
  const policy: InventoryPolicy = isCanonicalInventoryAuthority(requested) ? requested : canonicalAuthorityOfClient(client) ?? requested;
  if (isCanonicalInventoryAuthority(policy)) {
    const state = await assertCanonicalInventoryAuthority(client, policy);
    invariant(state.userId === actor.userId && state.username === actor.username, "actor_forbidden", "Authenticated actor is no longer active");
    return { username: state.username, role: state.roleLabel, is_active: true, party_id: state.clinicianPartyId };
  }
  const management = policy;
  const { rows } = await client.query<{ username: string; role: string; is_active: boolean; party_id: number | null }>("SELECT username,role,is_active,party_id FROM users WHERE id=$1 FOR SHARE", [actor.userId]);
  const row = rows[0];
  invariant(row?.is_active && row.username === actor.username && row.role === actor.role, "actor_forbidden", "Authenticated actor is no longer active");
  invariant(management ? row.role === "admin" : ["admin", "reception", "doctor"].includes(row.role), "operation_forbidden", "Actor is not authorized for this operation");
  return row;
}
export async function writeInventoryAudit(client: DbClient, actor: InventoryActor, entity: string, id: string, operation: string, details: Record<string, unknown>, policy?: InventoryPolicy) {
  // Reuses the existing throwing transactional audit writer. Specific new action
  // labels are a narrow root-owned audit enum proposal, not a second audit ledger.
  const sanitized = sanitizeInventoryAuditDetails(
    { operation, ...details },
    { includeFinancials: inventoryFinancialsVisible(actor, policy ?? canonicalAuthorityOfClient(client) ?? undefined) },
  );
  await insertAuditRow(client, { action: "inventory.item", entity, entityId: id, entityLabel: id,
    actor: actor.username, actorRole: actor.role, details: sanitized });
}
export function inventoryOperationDigest(key: string, payload: unknown): string {
  invariant(typeof key === "string" && /^[A-Za-z0-9_.:-]{8,120}$/.test(key), "invalid_operation_key", "A bounded idempotency key is required");
  return createHash("sha256").update(payloadIdentity(payload)).digest("hex");
}
async function applyInventoryOperationInTransaction<T extends object>(client: DbClient, actor: InventoryActor, key: string, name: string, hash: string, policy: InventoryPolicy, work: (client: DbClient) => Promise<T>, principal?: InventoryPrincipal): Promise<T & { replayed: boolean }> {
  const management = inventoryPolicyFlag(policy);
  // Canonical: fresh proof before the domain reset fence, after it and after the
  // operation-key lock (central authority → reset fence → operation key → rows).
  if (isCanonicalInventoryAuthority(policy)) await requireInventoryActor(client, actor, policy);
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [PURCHASE_RESET_FENCE]);
  await requireInventoryActor(client, actor, policy);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([name, actor.userId, key])]);
  if (isCanonicalInventoryAuthority(policy)) await requireInventoryActor(client, actor, policy);
  const previous = await client.query<{ payload_hash: string; result: T }>("SELECT payload_hash,result FROM inventory_operations WHERE scope=$1 AND actor_id=$2 AND operation_key=$3", [name,actor.userId,key]);
  const binding = await readInventoryCommandBinding(client, actor, key, name, !!principal);
  if (binding) {
    authorizeInventoryCommandBinding(binding, actor, hash, management, principal);
    invariant(binding.admitted_in_current_transaction === false, "command_admission_uncommitted", "Admission must commit before execution");
  }
  else invariant(!principal, "command_provenance_required", "Prepared execution requires durable command admission");
  if (previous.rows[0]) {
    invariant(previous.rows[0].payload_hash === hash, "idempotency_conflict", "This operation key already identifies different content");
    return { ...previous.rows[0].result, replayed: true };
  }
  if (binding) {
    const terminal = await client.query("SELECT 1 FROM inventory_command_retirements WHERE scope=$1 AND actor_id=$2 AND operation_key=$3", [name,actor.userId,key]);
    invariant(terminal.rows.length === 0, "command_retired", "This exact command was durably retired and cannot execute");
  }
  const result = await work(client);
  await client.query("INSERT INTO inventory_operations(scope,actor_id,operation_key,payload_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)", [name,actor.userId,key,hash,JSON.stringify(result)]);
  return { ...result, replayed: false };
}
export async function inventoryOperation<T extends object>(actor: InventoryActor, key: string, name: string, payload: unknown, policy: InventoryPolicy, work: (client: DbClient) => Promise<T>): Promise<T & { replayed: boolean }> {
  const hash = inventoryOperationDigest(key, payload);
  // Canonical operations already own their admitted transaction; never open another.
  if (isCanonicalInventoryAuthority(policy)) {
    const client = canonicalInventoryClient(policy);
    await assertInventoryCallerTransaction(client);
    await assertInventorySchemaInTransaction(client);
    return applyInventoryOperationInTransaction(client, actor, key, name, hash, policy, work);
  }
  await ready();
  return withTransaction(getPool(), client => applyInventoryOperationInTransaction(client, actor, key, name, hash, policy, work));
}
/** SELECT-only presence check inside the caller's transaction (no initialisation). */
export async function assertInventorySchemaInTransaction(client: DbClient) {
  requireInventoryIntegration();
  const { rows } = await client.query<{ present: boolean }>("SELECT to_regclass('purchase_requests') IS NOT NULL AND to_regclass('inventory_operations') IS NOT NULL AS present");
  if (!rows[0]?.present) throw new InventoryDomainError("schema_not_ready", "Inventory procurement schema awaits coordinated migration");
}
/** Caller owns the transaction and must roll it back on any failure. This core
 * never provisions schema, obtains a connection, commits, releases or retries.
 * Runtime opt-in and live authority are checked here, not asserted by a caller.
 * A SAVEPOINT probe rejects autocommit misuse before any business query. It is
 * immediately released, without committing or rolling back caller work.
 * Missing proposal objects fail inside the caller transaction, never via fallback.
 */
export async function inventoryOperationInTransaction<T extends object>(client: DbClient, actor: InventoryActor, key: string, name: string, payload: unknown, policy: InventoryPolicy, work: (client: DbClient) => Promise<T>, principal?: InventoryPrincipal): Promise<T & { replayed: boolean }> {
  requireInventoryIntegration();
  const hash = inventoryOperationDigest(key, payload);
  await assertInventoryCallerTransaction(client);
  return applyInventoryOperationInTransaction(client, actor, key, name, hash, policy, work, principal);
}
async function assertInventoryCallerTransaction(client: DbClient) {
  try {
    await client.query("SAVEPOINT inventory_adapter_transaction_check");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "25P01") {
      throw new InventoryDomainError("transaction_required", "Inventory adapter requires an explicit caller-owned transaction");
    }
    throw error;
  }
  await client.query("RELEASE SAVEPOINT inventory_adapter_transaction_check");
}
/** Admission and retirement use the very same actor/key lock as execution.
 * This helper writes no operation result and never starts/commits a transaction. */
export async function withInventoryCommandLockInTransaction<T>(
  client: DbClient, actor: InventoryActor, key: string, name: string, payload: unknown,
  policy: InventoryPolicy, work: (hash: string) => Promise<T>,
): Promise<T> {
  requireInventoryIntegration();
  const hash = inventoryOperationDigest(key, payload);
  await assertInventoryCallerTransaction(client);
  if (isCanonicalInventoryAuthority(policy)) await requireInventoryActor(client, actor, policy);
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [PURCHASE_RESET_FENCE]);
  await requireInventoryActor(client, actor, policy);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([name, actor.userId, key])]);
  if (isCanonicalInventoryAuthority(policy)) await requireInventoryActor(client, actor, policy);
  return work(hash);
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
export async function submitPurchaseRequest(actor: InventoryActor, key: string, request: RequestRevision,authority?:CanonicalInventoryAuthority) {
  docId(request.id); scope(request.branchId); validateRequest(request);
  invariant(request.requestedBy === actor.userId && request.version === 1, "request_owner_mismatch", "A new request belongs to its authenticated creator at version one");
  return inventoryOperation(actor,key,"request.submit",request,authority??false, async client => {
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
export async function revisePurchaseRequest(actor:InventoryActor,key:string,input:{requestId:string;expectedVersion:number;value:RequestRevision["value"];reason:string},authority?:CanonicalInventoryAuthority){
  invariant(Number.isSafeInteger(input.expectedVersion)&&input.expectedVersion>0&&input.expectedVersion<100000,"stale_version","An exact current version is required");
  invariant(typeof input.reason==="string"&&input.reason.trim().length>0&&input.reason.length<=2000,"reason_required","A bounded revision reason is required");
  invariant(input.value!==null&&typeof input.value==="object","missing_valuation","Record an explicit monetary proposal");
  return inventoryOperation(actor,key,"request.revise",input,authority??true,async client=>{
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
export async function approvePurchaseRequest(actor:InventoryActor,key:string,input:{ requestId:string; version:number; decisions: Parameters<typeof approveRequest>[0]["decisions"]; valuation:ValuationSnapshot|null; selfApprovalReason?:string|null },authority?:CanonicalInventoryAuthority) {
  return inventoryOperation(actor,key,"request.approve",input,authority??true,async client=>{
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
export async function issuePurchaseOrder(actor:InventoryActor,key:string,order:PurchaseOrder,authority?:CanonicalInventoryAuthority) {
  docId(order.id); scope(order.branchId);
  return inventoryOperation(actor,key,"order.issue",order,authority??true,async client=>{
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
async function orderPriorInspectedQuantities(client: DbClient, order: IssuedPurchaseOrder): Promise<PriorInspectedQuantity[]> {
  const orderedByLine = Object.fromEntries(
    order.lines.map((line) => [line.id, convertQuantity(line.quantity, line.conversion).baseQuantity]),
  );
  const old = await client.query<{
    order_line_id: string;
    accepted: string;
    quarantined: string;
    rejected: string;
    disposed: string;
    disposed_excess: string;
  }>(
    `SELECT grl.order_line_id,
      (COALESCE(SUM(grl.base_qty) FILTER(WHERE grl.disposition='accepted'),0)
       + COALESCE((SELECT SUM(qd.base_qty) FROM quarantine_dispositions qd WHERE qd.order_id=$1 AND qd.order_line_id=grl.order_line_id AND qd.action='release'),0))::text AS accepted,
      (COALESCE(SUM(grl.base_qty) FILTER(WHERE grl.disposition='quarantined'),0)
       - COALESCE((SELECT SUM(qd.base_qty) FROM quarantine_dispositions qd WHERE qd.order_id=$1 AND qd.order_line_id=grl.order_line_id),0))::text AS quarantined,
      (COALESCE(SUM(grl.base_qty) FILTER(WHERE grl.disposition='rejected'),0)
       + COALESCE((SELECT SUM(qd.base_qty) FROM quarantine_dispositions qd WHERE qd.order_id=$1 AND qd.order_line_id=grl.order_line_id AND qd.action='reject_return'),0))::text AS rejected,
      COALESCE((SELECT SUM(qd.base_qty) FROM quarantine_dispositions qd WHERE qd.order_id=$1 AND qd.order_line_id=grl.order_line_id AND qd.action='dispose'),0)::text AS disposed,
      COALESCE((
        SELECT SUM(
          LEAST(
            qd_sum.disp_qty,
            CASE
              WHEN COALESCE((grl2.document->>'heldForOrderAmendmentBaseQuantity')::numeric, 0) <= 0 THEN 0
              WHEN $3::int <= COALESCE((grl2.document->>'orderVersion')::int, 1)
                THEN COALESCE((grl2.document->>'heldForOrderAmendmentBaseQuantity')::numeric, 0)
              ELSE GREATEST(
                0,
                LEAST(
                  COALESCE((grl2.document->>'heldForOrderAmendmentBaseQuantity')::numeric, 0),
                  COALESCE(
                    (grl2.document->>'orderLineHeldStartBaseQuantity')::numeric,
                    COALESCE((grl2.document->>'orderLineAcceptedAtReceiptBaseQuantity')::numeric, 0)
                      + GREATEST(grl2.base_qty - COALESCE((grl2.document->>'heldForOrderAmendmentBaseQuantity')::numeric, 0), 0)
                  )
                  + COALESCE((grl2.document->>'heldForOrderAmendmentBaseQuantity')::numeric, 0)
                  - COALESCE(($2::jsonb->>grl2.order_line_id)::numeric, 0)
                )
              )
            END
          )
        )
        FROM goods_receipt_lines grl2
        JOIN (
          SELECT receipt_line_id, SUM(base_qty) AS disp_qty
          FROM quarantine_dispositions
          WHERE order_id=$1 AND action='dispose'
          GROUP BY receipt_line_id
        ) qd_sum ON qd_sum.receipt_line_id = grl2.id
        WHERE grl2.order_id=$1 AND grl2.order_line_id=grl.order_line_id
      ),0)::text AS disposed_excess
     FROM goods_receipt_lines grl WHERE grl.order_id=$1 GROUP BY grl.order_line_id`,
    [order.id, JSON.stringify(orderedByLine), order.version],
  );
  return old.rows.map((row) => ({
    orderLineId: row.order_line_id,
    acceptedBaseQuantity: row.accepted,
    quarantinedBaseQuantity: row.quarantined,
    rejectedBaseQuantity: row.rejected,
    disposedBaseQuantity: row.disposed,
    disposedExcessBaseQuantity: row.disposed_excess,
  }));
}
export async function lockedOrder(client:DbClient,id:string):Promise<IssuedPurchaseOrder>{
  docId(id);const order=await client.query<{document:IssuedPurchaseOrder}>("SELECT document FROM purchase_orders WHERE id=$1 FOR UPDATE",[id]);
  invariant(order.rows[0],"not_found","Purchase order was not found");scope(order.rows[0].document.branchId);
  const amended=await client.query<{order_doc:IssuedPurchaseOrder}>("SELECT result->'order' AS order_doc FROM inventory_operations WHERE scope='order.amend' AND result->>'id'=$1 ORDER BY (result->>'version')::int DESC, created_at DESC LIMIT 1",[id]);
  return amended.rows[0]?.order_doc ?? order.rows[0].document;
}
export async function amendPurchaseOrder(
  actor: InventoryActor,
  key: string,
  input: { order: PurchaseOrder; reason: string },

  authority?:CanonicalInventoryAuthority
) {
  docId(input.order.id);
  scope(input.order.branchId);
  return inventoryOperation(actor, key, "order.amend", input, authority??true, async (client) => {
    const currentOrder = await lockedOrder(client, input.order.id);
    const sources = [...new Set(input.order.lines.flatMap((line) => line.sources.map((source) => source.requestId)))].sort();
    const requests: { request: RequestRevision; approval: RequestApproval }[] = [];
    for (const id of sources) {
      const current = await lockedRequest(client, id);
      const event = await client.query<{ decision: RequestApproval }>(
        "SELECT decision FROM purchase_approval_events WHERE request_id=$1 AND request_version=$2",
        [id, current.current_version],
      );
      invariant(event.rows[0], "unapproved_source", "This request revision has no approval");
      requests.push({ request: current.request, approval: event.rows[0].decision });
    }
    await verifyUnits(client, input.order.lines);
    const supplier = await client.query<{ id: number; kind: string; is_active: boolean }>(
      "SELECT id,kind,is_active FROM parties WHERE id=$1 FOR SHARE",
      [input.order.supplierPartyId],
    );
    const old = await client.query<{
      id: string;
      request_id: string;
      request_line_id: string;
      base_qty: string;
      amount_minor: string;
      currency: CommittedSourceAllocation["currency"];
      base_amount_minor: string;
    }>(
      "SELECT id,request_id,request_line_id,base_qty::text,amount_minor::text,currency,base_amount_minor::text FROM purchase_order_source_allocations WHERE request_id=ANY($1::uuid[])",
      [sources],
    );
    const prior = old.rows.map((row) => ({
      id: row.id,
      requestId: row.request_id,
      requestLineId: row.request_line_id,
      baseQuantity: row.base_qty,
      currency: row.currency,
      amountMinor: Number(row.amount_minor),
      baseAmountMinor: Number(row.base_amount_minor),
    }));
    const priorReceipts = await orderPriorInspectedQuantities(client, currentOrder);
    const party = supplier.rows[0];
    const plan = planOrderAmendment({
      currentOrder,
      amendedOrder: input.order,
      requests,
      priorAllocations: prior,
      priorReceipts,
      supplier: {
        id: party?.id ?? 0,
        active: party?.is_active ?? false,
        isSupplier: party?.kind === "supplier",
      },
      reason: input.reason,
    });
    const existingLineIds = new Set(currentOrder.lines.map((line) => line.id));
    for (const line of plan.order.lines) {
      if (!existingLineIds.has(line.id)) {
        await client.query(
          "INSERT INTO purchase_order_lines(order_id,id,item_id,ordered_base_qty) VALUES($1,$2,$3,$4::numeric)",
          [plan.order.id, line.id, line.itemId, convertQuantity(line.quantity, line.conversion).baseQuantity],
        );
      }
      for (const source of line.sources) {
        const added = plan.newAllocations.find((row) => row.id === source.id);
        if (!added) continue;
        const revision = requests.find((row) => row.request.id === source.requestId)!.request.version;
        await client.query(
          "INSERT INTO purchase_order_source_allocations(id,order_id,order_line_id,request_id,request_version,request_line_id,base_qty,amount_minor,currency,base_amount_minor) VALUES($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9,$10)",
          [source.id, input.order.id, line.id, source.requestId, revision, source.requestLineId, source.baseQuantity, added.amountMinor, added.currency, added.baseAmountMinor],
        );
      }
    }
    await writeInventoryAudit(client, actor, "purchase_order", input.order.id, "amend", {
      previousVersion: currentOrder.version,
      version: plan.order.version,
      total: plan.totalMinor,
      currency: plan.order.currency,
      reason: input.reason,
    });
    return {
      id: plan.order.id,
      version: plan.order.version,
      status: "issued" as const,
      totalMinor: plan.totalMinor,
      currency: plan.order.currency,
      order: plan.order,
    };
  });
}
export async function postInspectedReceipt(actor: InventoryActor, key: string, receipt: ReceiptRevision,authority?:CanonicalInventoryAuthority) {
  docId(receipt.id); scope(receipt.branchId);
  return inventoryOperation(actor, key, "receipt.post", receipt, authority??true, client => writeInspectedReceiptInTransaction(client, actor, receipt));
}
/** Lot-aware, stock-only receipt command for a caller-owned transaction. It uses
 * the same durable identity as the existing wrapper, never the legacy purchase
 * writer (which also creates supplier debt). No HTTP/legacy entry is wired here.
 */
export async function postInspectedReceiptInTransaction(client: DbClient, actor: InventoryActor, key: string, receipt: ReceiptRevision) {
  requireInventoryIntegration();
  docId(receipt.id); scope(receipt.branchId);
  return inventoryOperationInTransaction(client, actor, key, "receipt.post", receipt, true, tx => writeInspectedReceiptInTransaction(tx, actor, receipt));
}
async function writeInspectedReceiptInTransaction(client: DbClient, actor: InventoryActor, receipt: ReceiptRevision) {
  const order=await lockedOrder(client,receipt.orderId);
  const prior=await orderPriorInspectedQuantities(client,order);
  const postingDate=clinicDateString(new Date(),CLINIC_ZONE_FALLBACK);
  const plan=planInspectedReceipt(order,receipt,prior,postingDate);
  const locations=[...new Set(plan.lines.map(line=>line.locationId))].sort();
  const places = await client.query<{ id: string; branch_key: string; is_active: boolean; kind: string; doctor_party_id: number | null }>(
    "SELECT id,branch_key,is_active,kind,doctor_party_id FROM inventory_locations WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE", [locations],
  );
  for (const locationId of locations) {
    const place = places.rows.find(row => row.id === locationId);
    invariant(place?.is_active && place.branch_key === receipt.branchId && ["store", "custody"].includes(place.kind),
      "location_forbidden", "Final receipt requires an active store or explicitly owned custody location in this scope");
  }
  // Reuse the established custody ownership contract, never infer an owner from
  // the actor or a procedure performer. Lock the complete owner set in order.
  const ownerIds = [...new Set(places.rows.filter(place => place.kind === "custody").map(place => place.doctor_party_id).filter((id): id is number => id !== null))].sort((a, b) => a - b);
  const owners = ownerIds.length ? await client.query<{ id: number; kind: string; is_active: boolean }>(
    "SELECT id,kind,is_active FROM parties WHERE id=ANY($1::int[]) ORDER BY id FOR SHARE", [ownerIds],
  ) : { rows: [] };
  for (const place of places.rows) {
    if (place.kind !== "custody") continue;
    const owner = owners.rows.find(row => row.id === place.doctor_party_id);
    invariant(owner?.is_active && owner.kind === "doctor", "doctor_unavailable", "Custody receipt destination must belong to an active doctor");
  }
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
  await writeInventoryAudit(client,actor,"goods_receipt",receipt.id,"post",{version:receipt.version,actualArrivalDate:receipt.actualArrivalDate,postingDate,inspection:plan.lines,excessDecisions:plan.excessDecisions});
  return {id:receipt.id,status:"posted" as const,remaining:plan.remaining,stockEntries:plan.stockEntries,excessDecisions:plan.excessDecisions,financialEffects:plan.financialEffects};
}
export async function resolveQuarantineReceipt(
  actor: InventoryActor,
  key: string,
  input: {
    id: string;
    orderId: string;
    receiptLineId: string;
    action: QuarantineResolutionAction;
    quantity: string;
    reason: string;
    resolutionDate?: string;
  },

  authority?:CanonicalInventoryAuthority
) {
  docId(input.id);
  docId(input.orderId);
  return inventoryOperation(actor, key, "quarantine.resolve", input, authority??true, async (client) => {
    const order = await lockedOrder(client, input.orderId);
    const receiptLineRows = await client.query<{ document: InspectedReceiptLine; receipt_doc: ReceiptRevision }>(
      "SELECT grl.document, gr.document AS receipt_doc FROM goods_receipt_lines grl JOIN goods_receipts gr ON gr.id = grl.receipt_id WHERE grl.id=$1 AND grl.order_id=$2 FOR UPDATE",
      [input.receiptLineId, order.id],
    );
    const row = receiptLineRows.rows[0];
    invariant(row, "not_found", "Quarantine receipt line was not found");
    // Every quarantine transition shares the custody item lock. Acquire it
    // before the lot row: custody allocations take the lot FK's KEY SHARE lock
    // after locking the item, so lot -> item would create a deadlock cycle.
    await client.query("SELECT id FROM inventory_items WHERE id=$1 FOR UPDATE", [row.document.itemId]);
    await client.query(
      "SELECT id FROM goods_receipt_lines WHERE order_id=$1 AND order_line_id=$2 ORDER BY id FOR UPDATE",
      [order.id, row.document.orderLineId],
    );
    const priorTotals = await orderPriorInspectedQuantities(client, order);
    const linePrior = priorTotals.find((p) => p.orderLineId === row.document.orderLineId);
    const lineTotals = await client.query<{ committed_qty: string }>(
      "SELECT ($1::numeric + GREATEST($2::numeric - $3::numeric, 0))::text AS committed_qty",
      [
        linePrior?.acceptedBaseQuantity ?? "0",
        linePrior?.disposedBaseQuantity ?? "0",
        linePrior?.disposedExcessBaseQuantity ?? "0",
      ],
    );
    const orderLineAcceptedBaseQuantity = lineTotals.rows[0]?.committed_qty ?? "0";
    const portionDamaged = row.receipt_doc.lines
      .flatMap((line) => line.portions)
      .find((portion) => portion.id === input.receiptLineId)?.damaged;
    const priorRows = await client.query<{ id: string; receipt_line_id: string; action: QuarantineResolutionAction; base_qty: string }>(
      "SELECT id::text, receipt_line_id, action, base_qty::text FROM quarantine_dispositions WHERE receipt_line_id=$1 ORDER BY created_at, id",
      [input.receiptLineId],
    );
    const currentClinicDate = clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
    const resolutionDate = input.resolutionDate ?? currentClinicDate;
    const plan = planQuarantineResolution({
      id: input.id,
      order,
      receiptLine: {
        ...row.document,
        ...(typeof portionDamaged === "boolean" ? { damaged: portionDamaged } : {}),
      },
      priorResolutions: priorRows.rows.map((prior) => ({
        id: prior.id,
        receiptLineId: prior.receipt_line_id,
        action: prior.action,
        baseQuantity: prior.base_qty,
      })),
      orderLineAcceptedBaseQuantity,
      action: input.action,
      quantity: input.quantity,
      reason: input.reason,
      resolutionDate,
      currentDate: currentClinicDate,
    });
    let movementId: number | null = null;
    if (plan.stockCompensation) {
      const lotRows = await client.query<{ id: string }>(
        "SELECT id FROM stock_lots WHERE receipt_line_id=$1 FOR UPDATE",
        [plan.receiptLineId],
      );
      const lot = lotRows.rows[0];
      invariant(lot, "not_found", "Quarantined stock lot was not found");
      const movement = await client.query<{ id: number }>(
        "INSERT INTO inventory_movements(item_id,kind,qty,expiry_date,reason,created_by,unit_cost_minor,is_return) VALUES($1,'out',$2::numeric,NULL,$3,$4,NULL,$5) RETURNING id",
        [plan.stockCompensation.itemId, plan.stockCompensation.baseQuantity, plan.stockCompensation.reason, actor.username, plan.stockCompensation.isReturn],
      );
      movementId = movement.rows[0].id;
      await client.query(
        "INSERT INTO inventory_movement_allocations(id,movement_id,lot_id,location_id,qty) VALUES($1,$2,$3,$4,$5::numeric)",
        [randomUUID(), movementId, lot.id, plan.stockCompensation.locationId, plan.stockCompensation.baseQuantity],
      );
    }
    await client.query(
      "INSERT INTO quarantine_dispositions(id,receipt_line_id,order_id,order_line_id,action,base_qty,movement_id,reason,document,created_by) VALUES($1,$2,$3,$4,$5,$6::numeric,$7,$8,$9::jsonb,$10)",
      [plan.id, plan.receiptLineId, plan.orderId, plan.orderLineId, plan.action, plan.baseQuantity, movementId, plan.reason, JSON.stringify(plan), actor.userId],
    );
    await writeInventoryAudit(client, actor, "quarantine_disposition", plan.id, "resolve", {
      orderId: plan.orderId,
      receiptLineId: plan.receiptLineId,
      action: plan.action,
      baseQuantity: plan.baseQuantity,
      effectiveReceiptLine: plan.effectiveReceiptLine,
    });
    return {
      id: plan.id,
      status: "resolved" as const,
      action: plan.action,
      baseQuantity: plan.baseQuantity,
      effectiveReceiptLine: plan.effectiveReceiptLine,
      effects: plan.effects,
    };
  });
}
export async function recordSupplierInvoiceMatch(actor:InventoryActor,key:string,invoice:SupplierInvoiceRevision,authority?:CanonicalInventoryAuthority){
  docId(invoice.id);scope(invoice.branchId);
  return inventoryOperation(actor,key,"invoice.match",invoice,authority??true,async client=>{
    const order=await lockedOrder(client,invoice.orderId);
    const receipts=await client.query<{document:InspectedReceiptLine;released_qty:string}>(`SELECT grl.document,
      COALESCE((SELECT SUM(qd.base_qty) FROM quarantine_dispositions qd WHERE qd.receipt_line_id=grl.id AND qd.action='release'),0)::text AS released_qty
      FROM goods_receipt_lines grl WHERE grl.order_id=$1 ORDER BY grl.id`,[order.id]);
    const effectiveReceiptLines:InspectedReceiptLine[]=receipts.rows.map(row=>{
      if(row.document.disposition==="quarantined" && decimalRatio(row.released_qty).numerator>0n){
        return {...row.document,disposition:"accepted",baseQuantity:row.released_qty};
      }
      return row.document;
    });
    const prior=await readEffectiveInvoiceAllocations(client,[order.id]);
    const match=matchSupplierInvoice(order,invoice,effectiveReceiptLines,prior);
    await client.query("INSERT INTO supplier_invoices(id,order_id,supplier_party_id,duplicate_key,document,match_plan,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)",[invoice.id,order.id,invoice.supplierPartyId,match.duplicateKey,JSON.stringify(invoice),JSON.stringify(match),actor.userId]);
    if(match.status === "matched")for(const line of invoice.lines)for(const allocation of line.receiptAllocations){await client.query("INSERT INTO supplier_invoice_receipt_allocations(id,invoice_id,invoice_line_id,receipt_line_id,base_qty) VALUES($1,$2,$3,$4,$5::numeric)",[allocation.id,invoice.id,line.id,allocation.receiptLineId,allocation.baseQuantity]);}
    await writeInventoryAudit(client,actor,"supplier_invoice",invoice.id,"match",{version:invoice.version,status:match.status,issues:match.issues});
    return {id:invoice.id,status:match.status,match,financialPosting:"pending_shared_finance_review" as const};
  });
}
export async function readProcurementRequests(actor:InventoryActor,offset=0){
  await ready();return withTransaction(getPool(),async client=>{
    await requireInventoryActor(client,actor,false);
    return readRequestsWith(client,{userId:actor.userId,all:actor.role === "admin",values:actor.role === "admin"},offset);
  });
}
/** Canonical purchase-request list in one owning RR snapshot (`inventory.requests.view`).
 * All requests: approvers and order managers; otherwise the actor's own. Values and
 * approval ceilings: holders of approve, order management or cost visibility. */
export async function readProcurementRequestsCanonical(session:VerifiedDurableSession,offset=0){
  invariant(Number.isSafeInteger(offset)&&offset>=0&&offset<=100000,"invalid_page","Invalid page offset");requireInventoryIntegration();
  return runCanonicalReadSnapshot(session,"inventory.requests.view",async(client,scope)=>{
    await assertProcurementSchema(client);
    const manager=scope.granted("inventory.requests.approve")||scope.granted("inventory.orders.manage");
    return readRequestsWith(client,{userId:scope.userId,all:manager,values:manager||scope.granted("inventory.costs.view")},offset);
  },{errorPrefix:"STAFF_READ",maxBytes:INVENTORY_READ_MAX_BYTES});
}
async function readRequestsWith(client:Pick<DbClient,"query">,viewer:{userId:number;all:boolean;values:boolean},offset:number){
    const rows=await client.query<{id:string;current_version:number;status:string;document:RequestRevision;decision:RequestApproval|null}>(`SELECT p.id,p.current_version,p.status,r.document,a.decision FROM purchase_requests p
      JOIN purchase_request_revisions r ON r.request_id=p.id AND r.version=p.current_version
      LEFT JOIN purchase_approval_events a ON a.request_id=p.id AND a.request_version=p.current_version
      WHERE p.branch_key=$1 AND ($2 OR p.requested_by=$3) ORDER BY p.created_at DESC,p.id LIMIT 21 OFFSET $4`,[INVENTORY_CLINIC_SCOPE,viewer.all,viewer.userId,offset]);
    const shown=rows.rows.slice(0,20),ids=[...new Set(shown.flatMap(row=>row.document.lines.map(line=>line.itemId)))];
    const names=await client.query<{id:number;name:string}>("SELECT id,name FROM inventory_items WHERE id=ANY($1::int[])",[ids]);
    return {items:shown.map(row=>({id:row.id,version:row.current_version,status:row.status,document:viewer.values?row.document:{...row.document,value:null},decision:viewer.values?row.decision:row.decision?{...row.decision,valueCeiling:null}:null})),itemNames:Object.fromEntries(names.rows.map(row=>[row.id,row.name])),hasMore:rows.rows.length>20};
}
export async function readProcurementCatalog(actor:InventoryActor){
  await ready();return withTransaction(getPool(),async client=>{
    await requireInventoryActor(client,actor,false);
    return readCatalogWith(client);
  });
}
/** Canonical request catalogue (active items and their conversions) in one owning
 * RR snapshot, admitted by `inventory.references.view`. No values. */
export async function readProcurementCatalogCanonical(session:VerifiedDurableSession){
  requireInventoryIntegration();
  return runCanonicalReadSnapshot(session,"inventory.references.view",async client=>{await assertProcurementSchema(client);return readCatalogWith(client);},{errorPrefix:"STAFF_READ",maxBytes:INVENTORY_READ_MAX_BYTES});
}
async function readCatalogWith(client:Pick<DbClient,"query">){
    const rows=await client.query<{item_id:number;name:string;version:number;entered_unit:string;base_unit:string;factor:string;entered_precision:number;base_precision:number}>(`SELECT p.item_id,i.name,p.version,p.entered_unit,p.base_unit,p.factor::text,entered_precision,base_precision
      FROM inventory_item_unit_versions p JOIN inventory_items i ON i.id=p.item_id
      WHERE i.is_active AND i.unit=p.base_unit ORDER BY i.name,p.version DESC LIMIT 200`);
    return {items:rows.rows.map(row=>({itemId:row.item_id,name:row.name,conversion:unitConversionSnapshot({itemId:row.item_id,version:row.version,baseUnit:row.base_unit,enteredUnit:row.entered_unit,baseUnitsPerEnteredUnit:row.factor,enteredPrecision:row.entered_precision,basePrecision:row.base_precision})})),scope:INVENTORY_CLINIC_SCOPE};
}
/** Source documents for the order/inspection workbench (legacy: administrator only).
 * Each page is a fresh authorized snapshot; posting still re-locks and validates
 * all source quantities, budgets and party/location ownership in its transaction.
 */
export async function readProcurementWorkbench(actor:InventoryActor,requestOffset=0,orderOffset=0){
  for(const offset of [requestOffset,orderOffset])invariant(Number.isSafeInteger(offset)&&offset>=0&&offset<=100000,"invalid_page","Invalid page offset");
  await ready();return withTransaction(getPool(),async client=>{
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await requireInventoryActor(client,actor,true);
    return readWorkbenchWith(client,requestOffset,orderOffset);
  });
}
/** Canonical workbench in one owning RR READ ONLY snapshot, admitted by
 * `inventory.orders.view` (purchase orders, receipts and supplier invoices are priced
 * documents; the grant label says so). Every write re-admits its own exact action. */
export async function readProcurementWorkbenchCanonical(session:VerifiedDurableSession,requestOffset=0,orderOffset=0){
  for(const offset of [requestOffset,orderOffset])invariant(Number.isSafeInteger(offset)&&offset>=0&&offset<=100000,"invalid_page","Invalid page offset");
  requireInventoryIntegration();
  return runCanonicalReadSnapshot(session,"inventory.orders.view",async client=>{await assertProcurementSchema(client);return readWorkbenchWith(client,requestOffset,orderOffset);},{errorPrefix:"STAFF_READ",maxBytes:INVENTORY_READ_MAX_BYTES});
}
async function readWorkbenchWith(client:Pick<DbClient,"query">,requestOffset:number,orderOffset:number){
    const requests=await client.query<{id:string;document:RequestRevision;decision:RequestApproval}>(`SELECT p.id,r.document,a.decision FROM purchase_requests p JOIN purchase_request_revisions r ON r.request_id=p.id AND r.version=p.current_version JOIN purchase_approval_events a ON a.request_id=p.id AND a.request_version=p.current_version WHERE p.branch_key=$1 AND p.status IN ('approved','partially_approved') ORDER BY p.created_at DESC,p.id LIMIT 21 OFFSET $2`,[INVENTORY_CLINIC_SCOPE,requestOffset]);
    const sources=await client.query<{request_id:string;request_line_id:string;qty:string;amount:string;currency:PurchaseOrder["currency"]}>("SELECT request_id,request_line_id,currency,SUM(base_qty)::text AS qty,SUM(amount_minor)::text AS amount FROM purchase_order_source_allocations WHERE request_id=ANY($1::uuid[]) GROUP BY request_id,request_line_id,currency",[requests.rows.slice(0,20).map(row=>row.id)]);
    invariant(sources.rows.every(row=>requests.rows.find(request=>request.id===row.request_id)?.decision.valueCeiling?.currency===row.currency),"currency_mismatch","Source allocations require their original approved currency");
    const suppliers=await client.query<{id:number;name:string}>("SELECT id,name FROM parties WHERE kind='supplier' AND is_active ORDER BY name,id");
    const locations=await client.query<{id:string;label:string;kind:string}>("SELECT id,label,kind FROM inventory_locations WHERE branch_key=$1 AND is_active ORDER BY label,id",[INVENTORY_CLINIC_SCOPE]);
    const orders=await client.query<{id:string;document:IssuedPurchaseOrder}>("SELECT id,document FROM purchase_orders WHERE branch_key=$1 ORDER BY created_at DESC,id LIMIT 21 OFFSET $2",[INVENTORY_CLINIC_SCOPE,orderOffset]);
    const orderIds=orders.rows.slice(0,20).map(row=>row.id);
    const amendments=await client.query<{result:{id:string;version:number;totalMinor:number;currency:PurchaseOrder["currency"];order:IssuedPurchaseOrder}}>("SELECT result FROM inventory_operations WHERE scope='order.amend' AND result->>'id'=ANY($1::text[]) ORDER BY (result->>'version')::int ASC, created_at ASC",[orderIds]);
    const latestAmendmentByOrderId=new Map<string,{id:string;version:number;totalMinor:number;currency:PurchaseOrder["currency"];order:IssuedPurchaseOrder}>();
    for(const row of amendments.rows){latestAmendmentByOrderId.set(row.result.id,row.result);}
    const shownOrders=orders.rows.slice(0,20).map(row=>({id:row.id,document:latestAmendmentByOrderId.get(row.id)?.order ?? row.document}));
    const orderResults=await client.query<{result:{id:string;totalMinor:number;currency:PurchaseOrder["currency"]}}>("SELECT result FROM inventory_operations WHERE scope='order.issue' AND result->>'id'=ANY($1::text[])",[orderIds]);
    const effectiveOrderResults=orderResults.rows.map(row=>{const amended=latestAmendmentByOrderId.get(row.result.id);return amended?{id:amended.id,totalMinor:amended.totalMinor,currency:amended.currency}:row.result;});
    const receiptHeaders=await client.query<{id:string;document:ReceiptRevision}>("SELECT id,document FROM goods_receipts WHERE order_id=ANY($1::uuid[]) ORDER BY created_at,id",[orderIds]);
    const receipts=await client.query<{id:string;order_id:string;document:InspectedReceiptLine}>("SELECT id,order_id,document FROM goods_receipt_lines WHERE order_id=ANY($1::uuid[]) ORDER BY receipt_id,id",[orderIds]);
    const hasQuarantineTable=await client.query<{present:boolean}>("SELECT to_regclass('quarantine_dispositions') IS NOT NULL AS present");
    const quarantineDispositions=hasQuarantineTable.rows[0]?.present
      ? (await client.query<{id:string;receipt_line_id:string;order_id:string;order_line_id:string;action:QuarantineResolutionAction;base_qty:string;reason:string}>("SELECT id::text,receipt_line_id,order_id::text,order_line_id,action,base_qty::text,reason FROM quarantine_dispositions WHERE order_id=ANY($1::uuid[]) ORDER BY created_at,id",[orderIds])).rows
      : [];
    const invoiceSource=await effectiveInvoiceSource(client);
    const allocationSource=invoiceSource==="inventory_effective_supplier_invoices"
      ? "inventory_effective_invoice_allocations"
      : "supplier_invoice_receipt_allocations";
    const allocations=await client.query<{receipt_line_id:string;qty:string}>(`SELECT a.receipt_line_id,SUM(a.base_qty)::text AS qty FROM ${allocationSource} a JOIN supplier_invoices i ON i.id=a.invoice_id WHERE i.order_id=ANY($1::uuid[]) GROUP BY a.receipt_line_id`,[orderIds]);
    const invoices=await client.query<{id:string;order_id:string;document:SupplierInvoiceRevision;match_plan:ReturnType<typeof matchSupplierInvoice>}>(`SELECT id,order_id,document,match_plan FROM ${invoiceSource} WHERE order_id=ANY($1::uuid[]) ORDER BY created_at,id`,[orderIds]);
    const itemIds=[...new Set([...requests.rows.slice(0,20).flatMap(row=>row.document.lines.map(line=>line.itemId)),...shownOrders.flatMap(row=>row.document.lines.map(line=>line.itemId))])];
    const names=await client.query<{id:number;name:string}>("SELECT id,name FROM inventory_items WHERE id=ANY($1::int[])",[itemIds]);
    return {scope:INVENTORY_CLINIC_SCOPE,requests:requests.rows.slice(0,20),sourceAllocations:sources.rows,suppliers:suppliers.rows,locations:locations.rows,orders:shownOrders,orderResults:effectiveOrderResults,receiptHeaders:receiptHeaders.rows,receipts:receipts.rows,quarantineDispositions,invoiceAllocations:allocations.rows,invoices:invoices.rows,itemNames:Object.fromEntries(names.rows.map(row=>[row.id,row.name])),hasMoreRequests:requests.rows.length>20,hasMoreOrders:orders.rows.length>20,requestOffset,orderOffset,financialPosting:"pending_shared_finance_review" as const};
}

/** One effective reservation projection for legacy matching and the prepared finance core.
 * Missing additive proposal preserves the existing dormant matching behavior. */
export async function effectiveInvoiceSource(client:Pick<DbClient,"query">):Promise<"inventory_effective_supplier_invoices"|"supplier_invoices">{
 const result=await client.query<{present:boolean}>("SELECT to_regclass('inventory_effective_supplier_invoices') IS NOT NULL AS present");
 return result.rows[0]?.present?"inventory_effective_supplier_invoices":"supplier_invoices";
}
export async function readEffectiveInvoiceAllocations(client:DbClient,orderIds:string[],excludeInvoiceId:string|null=null):Promise<InvoiceReceiptAllocation[]>{
 const source=await effectiveInvoiceSource(client);
 const sql=source==="inventory_effective_supplier_invoices"
  ? "SELECT id,invoice_line_id,receipt_line_id,base_qty::text FROM inventory_effective_invoice_allocations WHERE order_id=ANY($1::uuid[]) AND ($2::uuid IS NULL OR invoice_id<>$2::uuid)"
  : "SELECT a.id,a.invoice_line_id,a.receipt_line_id,a.base_qty::text FROM supplier_invoice_receipt_allocations a JOIN supplier_invoices i ON i.id=a.invoice_id WHERE i.order_id=ANY($1::uuid[]) AND ($2::uuid IS NULL OR i.id<>$2::uuid)";
 const result=await client.query<{id:string;invoice_line_id:string;receipt_line_id:string;base_qty:string}>(sql,[orderIds,excludeInvoiceId]);
 return result.rows.map(row=>({id:row.id,invoiceLineId:row.invoice_line_id,receiptLineId:row.receipt_line_id,baseQuantity:row.base_qty}));
}
