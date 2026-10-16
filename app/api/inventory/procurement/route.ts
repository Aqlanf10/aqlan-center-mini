import { inventoryIntegrationEnabled, INVENTORY_DISABLED_MESSAGE } from "@/lib/inventory-domain/rollout";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { readJsonBody, bodyErrorResponse } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { InventoryDomainError, invariant } from "@/lib/inventory-domain/quantities";
import { randomUUID } from "node:crypto";
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
            ? "دورة المشتريات بانتظار اعتماد ترحيل المخطط. لم تُسجّل العملية."
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
export async function GET(request:Request){const session=await requireSession();if(!session)return NextResponse.json({message:"سجّل الدخول."},{status:401});if(!inventoryIntegrationEnabled())return disabled();try{const url=new URL(request.url);if(url.searchParams.get("view")==="workbench")return NextResponse.json(await readProcurementWorkbench(session,Number(url.searchParams.get("requestOffset")??"0"),Number(url.searchParams.get("orderOffset")??"0")));if(url.searchParams.get("view")==="custody")return NextResponse.json(await readDoctorCustody(session,Number(url.searchParams.get("offset")??"0")));if(url.searchParams.get("view")==="catalog")return NextResponse.json(await readProcurementCatalog(session));const offset=Number(url.searchParams.get("offset") ?? "0");invariant(Number.isSafeInteger(offset)&&offset>=0&&offset<=100000,"invalid_page","Invalid page offset");return NextResponse.json(await readProcurementRequests(session,offset));}catch(error){return failure(error);}}
export async function POST(request:Request){const session=await requireSession();if(!session)return NextResponse.json({message:"سجّل الدخول."},{status:401});if(!inventoryIntegrationEnabled())return disabled();try{
  const source=record(await readJsonBody(request,JSON_BODY_LIMIT_BYTES));const command=String(source.command??"");
  invariant(typeof source.operationKey==="string","invalid_operation_key","Operation key is required");
  invariant(DOCTOR_OR_ADMIN_COMMANDS.has(command) || session.role==="admin","operation_forbidden","This management transition requires administrator authority");
  const actor:InventoryActor={userId:session.userId,username:session.username,role:session.role};
  switch(command){
    case "request.revise":{const revision=record(source.revision);record(revision.value);return NextResponse.json(await revisePurchaseRequest(actor,source.operationKey,revision as unknown as Parameters<typeof revisePurchaseRequest>[2]),{status:201});}
    case "custody.dispatch":{const transfer=record(source.transfer);list(transfer.lines);return NextResponse.json(await dispatchCustodyTransfer(actor,source.operationKey,transfer as unknown as CustodyDispatch),{status:201});}
    case "custody.acknowledge":{const acknowledgement=record(source.acknowledgement);list(acknowledgement.lines);return NextResponse.json(await acknowledgeCustodyTransfer(actor,source.operationKey,acknowledgement as unknown as CustodyAcknowledgement),{status:201});}
    case "custody.consume":{const usage=record(source.usage ?? source.document);return NextResponse.json(await recordCustodyUsage(actor,source.operationKey,{...usage,kind:usage.kind==="approved_waste"?"approved_waste":"consumed"} as unknown as CustodyUsageInput),{status:201});}
    case "custody.return_to_store":{const usage=record(source.usage ?? source.document);return NextResponse.json(await recordCustodyUsage(actor,source.operationKey,{...usage,kind:"returned_to_store"} as unknown as CustodyUsageInput),{status:201});}
    case "custody.stocktake":{const stocktake=record(source.stocktake ?? source.document);return NextResponse.json(await recordCustodyStocktake(actor,source.operationKey,stocktake as unknown as CustodyStocktakeInput),{status:201});}
    case "custody.close_package":{const closure=record(source.packageClosure ?? source.document);return NextResponse.json(await closeCustodyPackage(actor,source.operationKey,closure as unknown as CustodyPackageClosureInput),{status:201});}
    case "custody.propose_settlement":{const settlement=record(source.settlement ?? source.document);return NextResponse.json(await proposeAnnualCustodySettlement(actor,source.operationKey,settlement as unknown as CustodySettlementProposalInput),{status:201});}
    case "custody.object_settlement":{const objection=record(source.objection ?? source.document);return NextResponse.json(await objectCustodySettlement(actor,source.operationKey,objection as unknown as CustodySettlementObjectionInput),{status:201});}
    case "custody.approve_waste":{const approval=record(source.wasteApproval ?? source.document);return NextResponse.json(await approveCustodyWaste(actor,source.operationKey,approval as unknown as CustodyWasteApprovalInput),{status:201});}
    case "legacy.reconcile":{const reconciliation=record(source.reconciliation ?? source.document);return NextResponse.json(await reconcileHistoricalMovements(actor,source.operationKey,reconciliation as unknown as LegacyReconciliationInput),{status:201});}
    case "request.submit":shape(source.document,command);return NextResponse.json(await submitPurchaseRequest(actor,source.operationKey,{...source.document as RequestRevision,requestedBy:actor.userId}),{status:201});
    case "request.approve":{const approval=record(source.approval);list(approval.decisions);invariant(typeof approval.requestId==="string"&&Number.isSafeInteger(approval.version),"invalid_approval","Approval targets an exact request/version");return NextResponse.json(await approvePurchaseRequest(actor,source.operationKey,approval as Parameters<typeof approvePurchaseRequest>[2]));}
    case "order.issue":shape(source.document,command);return NextResponse.json(await issuePurchaseOrder(actor,source.operationKey,source.document as PurchaseOrder),{status:201});
    case "order.amend":{const amendment=record(source.amendment ?? source.document);shape(amendment.order,command);invariant(typeof amendment.reason==="string","reason_required","Amendment reason is required");return NextResponse.json(await amendPurchaseOrder(actor,source.operationKey,{order:amendment.order as PurchaseOrder,reason:amendment.reason}),{status:201});}
    case "receipt.post":shape(source.document,command);return NextResponse.json(await postInspectedReceipt(actor,source.operationKey,source.document as ReceiptRevision),{status:201});
    case "quarantine.resolve":{const resolution=record(source.resolution ?? source.document);return NextResponse.json(await resolveQuarantineReceipt(actor,source.operationKey,resolution as unknown as Parameters<typeof resolveQuarantineReceipt>[2]),{status:201});}
    case "invoice.match":shape(source.document,command);return NextResponse.json(await recordSupplierInvoiceMatch(actor,source.operationKey,source.document as SupplierInvoiceRevision),{status:201});
    default:throw new InventoryDomainError("invalid_command","Use a supported procurement transition");
  }
}catch(error){return failure(error);}}

function disabled() {
  return NextResponse.json({ code: "inventory_integration_disabled", message: INVENTORY_DISABLED_MESSAGE }, { status: 503 });
}
