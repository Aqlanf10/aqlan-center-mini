import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { readJsonBody, bodyErrorResponse } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { InventoryDomainError, invariant } from "@/lib/inventory-domain/quantities";
import { submitPurchaseRequest, revisePurchaseRequest, approvePurchaseRequest, issuePurchaseOrder, postInspectedReceipt,
  recordSupplierInvoiceMatch, readProcurementRequests, readProcurementCatalog, type InventoryActor } from "@/lib/inventory-domain/procurement-store";
import { dispatchCustodyTransfer,acknowledgeCustodyTransfer,readDoctorCustody,type CustodyDispatch,type CustodyAcknowledgement } from "@/lib/inventory-domain/custody-store";
import type { RequestRevision, PurchaseOrder, ReceiptRevision, SupplierInvoiceRevision } from "@/lib/inventory-domain/procurement";
export const dynamic = "force-dynamic";
function failure(error:unknown) {
  const bounded=bodyErrorResponse(error);if(bounded)return bounded;
  if(error instanceof InventoryDomainError){const status=error.code==="schema_not_ready"?503:error.code.includes("forbidden")?403:error.code==="not_found"?404:["stale_version","idempotency_conflict","invalid_transition","source_overallocated","overdelivery","receipt_already_invoiced"].includes(error.code)?409:400;
    return NextResponse.json({code:error.code,message:status===503?"دورة المشتريات بانتظار اعتماد ترحيل المخطط. لم تُسجّل العملية.":error.message},{status});}
  if(error && typeof error==="object" && "code" in error && error.code==="23505")return NextResponse.json({code:"duplicate_document",message:"هذا المستند أو مصدره مسجّل بالفعل. راجع العملية الأصلية."},{status:409});
  return NextResponse.json({code:"inventory_unavailable",message:"تعذّر تأكيد العملية. استعلم عن النتيجة واستخدم مفتاح العملية نفسه عند إعادة المحاولة."},{status:500});
}
const record=(value:unknown):Record<string,unknown>=>{invariant(value!==null && typeof value==="object" && !Array.isArray(value),"invalid_body","A document object is required");return value as Record<string,unknown>;};
function list(value:unknown,max=100):Record<string,unknown>[] {invariant(Array.isArray(value) && value.length<=max,"invalid_lines","Document lines must be a bounded array");return value.map(record);}
function shape(document:unknown,command:string){const source=record(document);invariant(typeof source.id==="string" && Number.isSafeInteger(source.version),"invalid_document","A document ID and version are required");for(const line of list(source.lines)){
  if(command==="request.submit"||command==="order.issue"){record(line.conversion);}
  if(command==="order.issue"){record(line.price);list(line.sources);}
  if(command==="receipt.post"){list(line.portions);}
  if(command==="invoice.match"){record(line.price);list(line.receiptAllocations);}
}return source;}
export async function GET(request:Request){const session=await requireSession();if(!session)return NextResponse.json({message:"سجّل الدخول."},{status:401});try{const url=new URL(request.url);if(url.searchParams.get("view")==="custody")return NextResponse.json(await readDoctorCustody(session,Number(url.searchParams.get("offset")??"0")));if(url.searchParams.get("view")==="catalog")return NextResponse.json(await readProcurementCatalog(session));const offset=Number(url.searchParams.get("offset") ?? "0");invariant(Number.isSafeInteger(offset)&&offset>=0&&offset<=100000,"invalid_page","Invalid page offset");return NextResponse.json(await readProcurementRequests(session,offset));}catch(error){return failure(error);}}
export async function POST(request:Request){const session=await requireSession();if(!session)return NextResponse.json({message:"سجّل الدخول."},{status:401});try{
  const source=record(await readJsonBody(request,JSON_BODY_LIMIT_BYTES));const command=source.command;
  invariant(typeof source.operationKey==="string","invalid_operation_key","Operation key is required");
  invariant(command==="request.submit" || command==="custody.acknowledge" || session.role==="admin","operation_forbidden","This management transition requires administrator authority");
  const actor:InventoryActor={userId:session.userId,username:session.username,role:session.role};
  switch(command){
    case "request.revise":{const revision=record(source.revision);record(revision.value);return NextResponse.json(await revisePurchaseRequest(actor,source.operationKey,revision as unknown as Parameters<typeof revisePurchaseRequest>[2]),{status:201});}
    case "custody.dispatch":{const transfer=record(source.transfer);list(transfer.lines);return NextResponse.json(await dispatchCustodyTransfer(actor,source.operationKey,transfer as unknown as CustodyDispatch),{status:201});}
    case "custody.acknowledge":{const acknowledgement=record(source.acknowledgement);list(acknowledgement.lines);return NextResponse.json(await acknowledgeCustodyTransfer(actor,source.operationKey,acknowledgement as unknown as CustodyAcknowledgement),{status:201});}
    case "request.submit":shape(source.document,command);return NextResponse.json(await submitPurchaseRequest(actor,source.operationKey,{...source.document as RequestRevision,requestedBy:actor.userId}),{status:201});
    case "request.approve":{const approval=record(source.approval);list(approval.decisions);invariant(typeof approval.requestId==="string"&&Number.isSafeInteger(approval.version),"invalid_approval","Approval targets an exact request/version");return NextResponse.json(await approvePurchaseRequest(actor,source.operationKey,approval as Parameters<typeof approvePurchaseRequest>[2]));}
    case "order.issue":shape(source.document,command);return NextResponse.json(await issuePurchaseOrder(actor,source.operationKey,source.document as PurchaseOrder),{status:201});
    case "receipt.post":shape(source.document,command);return NextResponse.json(await postInspectedReceipt(actor,source.operationKey,source.document as ReceiptRevision),{status:201});
    case "invoice.match":shape(source.document,command);return NextResponse.json(await recordSupplierInvoiceMatch(actor,source.operationKey,source.document as SupplierInvoiceRevision),{status:201});
    default:throw new InventoryDomainError("invalid_command","Use a supported procurement transition");
  }
}catch(error){return failure(error);}}
