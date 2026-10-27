import {NextResponse} from "next/server";
import {requireSession} from "@/lib/session";
import {readJsonBody,bodyErrorResponse} from "@/lib/http-body";
import {JSON_BODY_LIMIT_BYTES} from "@/lib/security-limits";
import {readInvoiceAddService,previewInvoiceAddService,addInvoiceService,InvoiceAddServiceError} from "@/lib/invoice-add-service-db";
export const dynamic="force-dynamic";
type Context={params:Promise<{id:string}>};
async function owner(context:Context){
 const session=await requireSession();if(!session||session.role!=="admin")throw new InvoiceAddServiceError("unauthorized","إضافة الخدمة تحتاج جلسة مدير سارية.");
 const id=Number((await context.params).id);if(!Number.isSafeInteger(id)||id<=0)throw new InvoiceAddServiceError("invalid","رقم الفاتورة غير صالح.");
 return {id,session};
}
function failure(error:unknown){
 const bounded=bodyErrorResponse(error);if(bounded)return bounded;
 if(error instanceof InvoiceAddServiceError)return NextResponse.json({code:error.code,message:error.message,
  ...(error.terminal?{terminal:true,idempotencyKey:error.idempotencyKey,requestHash:error.requestHash}:{})},
  {status:error.code==="unauthorized"?403:error.code==="missing"?404:error.code==="invalid"?400:409});
 return NextResponse.json({message:"تعذّر تأكيد إضافة الخدمة؛ احتفظ بالطلب نفسه وأعد المحاولة للتحقق من النتيجة."},{status:500});
}
export async function GET(_request:Request,context:Context){try{const {id,session}=await owner(context);return NextResponse.json(await readInvoiceAddService(id,session),{headers:{"Cache-Control":"no-store"}});}catch(error){return failure(error);}}
export async function PUT(request:Request,context:Context){try{const {id,session}=await owner(context);const body=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);return NextResponse.json(await previewInvoiceAddService(id,body,session),{headers:{"Cache-Control":"no-store"}});}catch(error){return failure(error);}}
export async function POST(request:Request,context:Context){try{const {id,session}=await owner(context);const body=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);const result=await addInvoiceService(id,body,session);return NextResponse.json(result,{status:result.replayed?200:201});}catch(error){return failure(error);}}
