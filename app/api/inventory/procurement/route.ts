import { admitSupplierIntent, executeSupplierIntent, readSupplierFinance } from "@/lib/inventory-domain/supplier-transport";
import { referenceTransport } from "@/lib/inventory-domain/reference-transport";
import type { ReferenceIntent } from "@/lib/inventory-reference-protocol";
import type { SupplierIntent, SupplierAdmission } from "@/lib/inventory-supplier-protocol";
import { inventoryIntegrationEnabled, INVENTORY_DISABLED_MESSAGE } from "@/lib/inventory-domain/rollout";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { readJsonBody, bodyErrorResponse } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { InventoryDomainError, invariant } from "@/lib/inventory-domain/quantities";
import { createHash, randomUUID } from "node:crypto";
import { INVENTORY_RECOVERY_PROTOCOL, inventoryRecoveryIdentity, isInventoryOperationKey, isInventoryRecoveryDigest, type InventoryRecoveryAcknowledgement } from "@/lib/inventory-command-recovery";
import {
  DEFAULT_SAFE_INVENTORY_ERROR_MESSAGE,
  publicInventoryErrorCode,
  safeInventoryErrorMessage,
} from "@/lib/inventory-domain/presentation";
import {
  submitPurchaseRequest,
  revisePurchaseRequest,
  approvePurchaseRequest,
  issuePurchaseOrder,
  amendPurchaseOrder,
  postInspectedReceipt,
  resolveQuarantineReceipt,
  recordSupplierInvoiceMatch,
  readProcurementRequests,
  readProcurementCatalog,
  readProcurementWorkbench,
  type InventoryActor,
} from "@/lib/inventory-domain/procurement-store";
import {
  dispatchCustodyTransfer,
  acknowledgeCustodyTransfer,
  reconcileHistoricalMovements,
  recordCustodyUsage,
  recordCustodyStocktake,
  closeCustodyPackage,
  proposeAnnualCustodySettlement,
  objectCustodySettlement,
  approveCustodyWaste,
  readDoctorCustody,
  type CustodyDispatch,
  type CustodyAcknowledgement,
  type LegacyReconciliationInput,
  type CustodyUsageInput,
  type CustodyStocktakeInput,
  type CustodyPackageClosureInput,
  type CustodySettlementProposalInput,
  type CustodySettlementObjectionInput,
  type CustodyWasteApprovalInput,
} from "@/lib/inventory-domain/custody-store";
import type { RequestRevision, PurchaseOrder, ReceiptRevision, SupplierInvoiceRevision } from "@/lib/inventory-domain/procurement";
export const dynamic = "force-dynamic";

const CONFLICT_CODES = new Set([
  "stale_version",
  "stale_order",
  "stale_approval",
  "idempotency_conflict",
  "invalid_transition",
  "source_overallocated",
  "source_budget_exceeded",
  "overdelivery",
  "order_amendment_required",
  "receipt_already_invoiced",
  "quarantine_overresolved",
  "already_reconciled",
  "legacy_source_reconciliation_required",
  "duplicate_consumption",
  "package_or_evidence_already_closed",
  "transfer_overacknowledged",
  "duplicate_settlement_adjustment",
  "unposted_settlement_adjustment",
  "settlement_source_mismatch",
]);

function failure(error: unknown) {
  if (error instanceof Error && error.message === "inventory_reference_authority_unavailable") {
    return NextResponse.json({ code: "inventory_reference_authority_unavailable", message: "تهيئة المخزون بانتظار ربط الصلاحية المركزية. تبقى المسودات والعمليات المحفوظة دون تغيير." }, { status: 503 });
  }
  if(error instanceof InventoryDomainError && ["supplier_invoice_intent_pending","supplier_reauthentication_required","supplier_saved_authority_mismatch","invoice_payment_reversal_required","invoice_cancelled","invoice_already_posted","invoice_not_posted","invoice_source_mismatch","principal_realm_mismatch","command_retired","command_provenance_required","invoice_not_matched","rate_precision_unsupported","supplier_unavailable","valuation_mismatch"].includes(error.code)){
    return NextResponse.json({code:error.code,message:error.code==="supplier_reauthentication_required"?"سجّل الدخول من جديد لتأكيد هوية العملية. تبقى العمليات المحفوظة دون تغيير.":error.code==="invoice_payment_reversal_required"?"للفاتورة دفعات قائمة. اعكسها من مسار الدفعات المخوّل قبل إلغاء الفاتورة.":"تعذّر تنفيذ العملية بحالتها الحالية. راجع الفاتورة والعملية المحفوظة قبل المتابعة."},{status:error.code==="supplier_reauthentication_required"?401:error.code==="supplier_saved_authority_mismatch"?403:409});
  }

  const bounded = bodyErrorResponse(error);
  if (bounded) return bounded;
  if (error instanceof InventoryDomainError) {
    const publicCode = publicInventoryErrorCode(error.code);
    const status =
      publicCode === "schema_not_ready"
        ? 503
        : publicCode.includes("forbidden")
          ? 403
          : publicCode === "not_found"
            ? 404
            : CONFLICT_CODES.has(publicCode)
              ? 409
              : 400;
    return NextResponse.json(
      {
        code: publicCode,
        message:
          status === 503
            ? "دورة المشتريات بانتظار اعتماد المخطط. تعذّر تأكيد نتيجة العملية؛ احتفظ بالطلب المحفوظ وأعد التحقق عند إتاحة المسار."
            : safeInventoryErrorMessage(error, DEFAULT_SAFE_INVENTORY_ERROR_MESSAGE),
      },
      { status },
    );
  }
  if (error && typeof error === "object" && "code" in error && error.code === "23505") {
    return NextResponse.json(
      { code: "duplicate_document", message: "هذا المستند أو مصدره مسجّل بالفعل. راجع العملية الأصلية." },
      { status: 409 },
    );
  }
  const correlationId = randomUUID();
  const rawErrorName = error instanceof Error ? error.name : typeof error;
  const errorType = /^[A-Za-z0-9_]{1,48}$/.test(rawErrorName) ? rawErrorName : "Error";
  console.error(
    JSON.stringify({
      event: "inventory_api_error",
      correlationId,
      code: "inventory_unavailable",
      errorType,
    }),
  );
  return NextResponse.json(
    {
      code: "inventory_unavailable",
      correlationId,
      message: "تعذّر تأكيد العملية. استعلم عن النتيجة واستخدم مفتاح العملية نفسه عند إعادة المحاولة.",
    },
    { status: 500 },
  );
}
const record=(value:unknown):Record<string,unknown>=>{invariant(value!==null && typeof value==="object" && !Array.isArray(value),"invalid_body","A document object is required");return value as Record<string,unknown>;};
function list(value:unknown,max=100):Record<string,unknown>[] {invariant(Array.isArray(value) && value.length<=max,"invalid_lines","Document lines must be a bounded array");return value.map(record);}
function shape(document:unknown,command:string){const source=record(document);invariant(typeof source.id==="string" && Number.isSafeInteger(source.version),"invalid_document","A document ID and version are required");for(const line of list(source.lines)){
  if(command==="request.submit"||command==="order.issue"||command==="order.amend"){record(line.conversion);}
  if(command==="order.issue"||command==="order.amend"){record(line.price);list(line.sources);}
  if(command==="receipt.post"){list(line.portions);}
  if(command==="invoice.match"){record(line.price);list(line.receiptAllocations);}
}return source;}
const DOCTOR_OR_ADMIN_COMMANDS=new Set(["request.submit","custody.acknowledge","custody.consume","custody.return_to_store","custody.stocktake","custody.close_package","custody.object_settlement"]);
export async function GET(request:Request){const session=await requireSession();if(!session)return NextResponse.json({message:"سجّل الدخول."},{status:401});if(!inventoryIntegrationEnabled())return disabled();try{const url=new URL(request.url);if(url.searchParams.get("view")==="reference-setup")return NextResponse.json(await referenceTransport.read(session,url.searchParams.get("query")??"",Number(url.searchParams.get("page")??"0")),{headers:{"Cache-Control":"private, no-store"}});if(url.searchParams.get("view")==="first-use-readiness")return NextResponse.json(await referenceTransport.readiness(session),{headers:{"Cache-Control":"private, no-store"}});if(url.searchParams.get("view")==="supplier-finance")return NextResponse.json(await readSupplierFinance(session,url.searchParams.get("orderId")??""),{headers:{"Cache-Control":"private, no-store"}});if(url.searchParams.get("view")==="workbench")return NextResponse.json(await readProcurementWorkbench(session,Number(url.searchParams.get("requestOffset")??"0"),Number(url.searchParams.get("orderOffset")??"0")));if(url.searchParams.get("view")==="custody")return NextResponse.json(await readDoctorCustody(session,Number(url.searchParams.get("offset")??"0")));if(url.searchParams.get("view")==="catalog")return NextResponse.json(await readProcurementCatalog(session));const offset=Number(url.searchParams.get("offset") ?? "0");invariant(Number.isSafeInteger(offset)&&offset>=0&&offset<=100000,"invalid_page","Invalid page offset");return NextResponse.json(await readProcurementRequests(session,offset));}catch(error){return failure(error);}}
export async function POST(request:Request){const session=await requireSession();if(!session)return NextResponse.json({message:"سجّل الدخول."},{status:401});if(!inventoryIntegrationEnabled())return disabled();try{
  // Optional versioned browser recovery. These headers bind the saved command
  // to the authenticated session; they never grant identity or permissions.
  const recoveryHeaders = ["X-Inventory-Recovery", "X-Inventory-Actor", "X-Inventory-Actor-Id", "X-Inventory-Digest"];
  const recovering = recoveryHeaders.some(name => request.headers.has(name));
  if (recovering) {
    let actor: string | null = null;
    try { actor = decodeURIComponent(request.headers.get("X-Inventory-Actor") ?? ""); } catch { /* Refuse malformed binding. */ }
    if (request.headers.get("X-Inventory-Recovery") !== INVENTORY_RECOVERY_PROTOCOL || actor !== session.username
      || request.headers.get("X-Inventory-Actor-Id") !== String(session.userId)) {
      return NextResponse.json({code:"inventory_recovery_actor_mismatch",message:"تغيّرت الجلسة. سجّل الدخول بالحساب الذي بدأ العملية."},{status:403});
    }
  }
  const source=record(await readJsonBody(request,JSON_BODY_LIMIT_BYTES));const command=String(source.command??"");
  if(command.startsWith("reference.")){const mode=command.slice("reference.".length);invariant(["admit","execute","lookup","retire"].includes(mode),"invalid_document","Unknown setup command");return NextResponse.json(await referenceTransport.command(session,record(source.intent) as unknown as ReferenceIntent,mode as "admit"|"execute"|"lookup"|"retire",typeof source.reason==="string"?source.reason:undefined));}
  if(command==="supplier.admit")return NextResponse.json(await admitSupplierIntent(session,record(source.intent) as unknown as SupplierIntent),{status:201});
  if(command==="supplier.execute")return NextResponse.json(await executeSupplierIntent(session,record(source.admission) as unknown as SupplierAdmission));
  if(command==="supplier.retire"){invariant(typeof source.reason==="string","reason_required","Retirement reason is required");return NextResponse.json(await executeSupplierIntent(session,record(source.admission) as unknown as SupplierAdmission,source.reason));}

  let recovery: InventoryRecoveryAcknowledgement | null = null;
  if (recovering) {
    const digest = request.headers.get("X-Inventory-Digest");
    if (!isInventoryOperationKey(source.operationKey) || !isInventoryRecoveryDigest(digest)
      || createHash("sha256").update(inventoryRecoveryIdentity(source)).digest("hex") !== digest) {
      return NextResponse.json({code:"inventory_recovery_payload_mismatch",message:"لا تطابق العملية محتواها المحفوظ. أعد محاولة العملية الأصلية."},{status:409});
    }
    recovery = {protocol:INVENTORY_RECOVERY_PROTOCOL,status:"committed",actorUserId:session.userId,key:source.operationKey,digest};
  }
  // Only a completed transaction or committed replay receives this proof.
  // Generic errors cannot retire recovery, including post-commit response loss.
  const success = (result: Record<string,unknown>, init?: ResponseInit) => NextResponse.json(recovery ? {...result,recovery} : result,init);
  invariant(typeof source.operationKey==="string","invalid_operation_key","Operation key is required");
  invariant(DOCTOR_OR_ADMIN_COMMANDS.has(command) || session.role==="admin","operation_forbidden","This management transition requires administrator authority");
  const actor:InventoryActor={userId:session.userId,username:session.username,role:session.role};
  switch(command){
    case "request.revise":{const revision=record(source.revision);record(revision.value);return success(await revisePurchaseRequest(actor,source.operationKey,revision as unknown as Parameters<typeof revisePurchaseRequest>[2]),{status:201});}
    case "custody.dispatch":{const transfer=record(source.transfer);list(transfer.lines);return success(await dispatchCustodyTransfer(actor,source.operationKey,transfer as unknown as CustodyDispatch),{status:201});}
    case "custody.acknowledge":{const acknowledgement=record(source.acknowledgement);list(acknowledgement.lines);return success(await acknowledgeCustodyTransfer(actor,source.operationKey,acknowledgement as unknown as CustodyAcknowledgement),{status:201});}
    case "custody.consume":{const usage=record(source.usage ?? source.document);return success(await recordCustodyUsage(actor,source.operationKey,{...usage,kind:usage.kind==="approved_waste"?"approved_waste":"consumed"} as unknown as CustodyUsageInput),{status:201});}
    case "custody.return_to_store":{const usage=record(source.usage ?? source.document);return success(await recordCustodyUsage(actor,source.operationKey,{...usage,kind:"returned_to_store"} as unknown as CustodyUsageInput),{status:201});}
    case "custody.stocktake":{const stocktake=record(source.stocktake ?? source.document);return success(await recordCustodyStocktake(actor,source.operationKey,stocktake as unknown as CustodyStocktakeInput),{status:201});}
    case "custody.close_package":{const closure=record(source.packageClosure ?? source.document);return success(await closeCustodyPackage(actor,source.operationKey,closure as unknown as CustodyPackageClosureInput),{status:201});}
    case "custody.propose_settlement":{const settlement=record(source.settlement ?? source.document);return success(await proposeAnnualCustodySettlement(actor,source.operationKey,settlement as unknown as CustodySettlementProposalInput),{status:201});}
    case "custody.object_settlement":{const objection=record(source.objection ?? source.document);return success(await objectCustodySettlement(actor,source.operationKey,objection as unknown as CustodySettlementObjectionInput),{status:201});}
    case "custody.approve_waste":{const approval=record(source.wasteApproval ?? source.document);return success(await approveCustodyWaste(actor,source.operationKey,approval as unknown as CustodyWasteApprovalInput),{status:201});}
    case "legacy.reconcile":{const reconciliation=record(source.reconciliation ?? source.document);return success(await reconcileHistoricalMovements(actor,source.operationKey,reconciliation as unknown as LegacyReconciliationInput),{status:201});}
    case "request.submit":shape(source.document,command);return success(await submitPurchaseRequest(actor,source.operationKey,{...source.document as RequestRevision,requestedBy:actor.userId}),{status:201});
    case "request.approve":{const approval=record(source.approval);list(approval.decisions);invariant(typeof approval.requestId==="string"&&Number.isSafeInteger(approval.version),"invalid_approval","Approval targets an exact request/version");return success(await approvePurchaseRequest(actor,source.operationKey,approval as Parameters<typeof approvePurchaseRequest>[2]));}
    case "order.issue":shape(source.document,command);return success(await issuePurchaseOrder(actor,source.operationKey,source.document as PurchaseOrder),{status:201});
    case "order.amend":{const amendment=record(source.amendment ?? source.document);shape(amendment.order,command);invariant(typeof amendment.reason==="string","reason_required","Amendment reason is required");return success(await amendPurchaseOrder(actor,source.operationKey,{order:amendment.order as PurchaseOrder,reason:amendment.reason}),{status:201});}
    case "receipt.post":shape(source.document,command);return success(await postInspectedReceipt(actor,source.operationKey,source.document as ReceiptRevision),{status:201});
    case "quarantine.resolve":{const resolution=record(source.resolution ?? source.document);return success(await resolveQuarantineReceipt(actor,source.operationKey,resolution as unknown as Parameters<typeof resolveQuarantineReceipt>[2]),{status:201});}
    case "invoice.match":shape(source.document,command);return success(await recordSupplierInvoiceMatch(actor,source.operationKey,source.document as SupplierInvoiceRevision),{status:201});
    default:throw new InventoryDomainError("invalid_command","Use a supported procurement transition");
  }
}catch(error){return failure(error);}}

function disabled() {
  return NextResponse.json({ code: "inventory_integration_disabled", message: INVENTORY_DISABLED_MESSAGE }, { status: 503 });
}
