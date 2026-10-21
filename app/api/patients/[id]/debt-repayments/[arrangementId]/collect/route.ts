import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { isCurrency, parseAmount } from "@/lib/money";
import { DebtRepaymentError } from "@/lib/debt-installments-db";
import { collectDebtInstallment } from "@/lib/debt-installment-collection";
import {findSimilarCollections,parseSimilarCollectionReview,reviewMatchesReceipts} from "@/lib/similar-collection";
import {getPaymentByIdempotencyKey} from "@/lib/db";
export const dynamic="force-dynamic";
export async function POST(request:Request,context:{params:Promise<{id:string;arrangementId:string}>}){
  const session=await requireSession();if(!session)return NextResponse.json({message:"سجّل الدخول من جديد."},{status:401});
  if(!["admin","reception"].includes(session.role))return NextResponse.json({message:"التحصيل للإدارة والاستقبال."},{status:403});
  try{
    const body=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);const params=await context.params;
    if(!body||typeof body!=="object"||Array.isArray(body))throw new DebtRepaymentError("invalid","طلب غير صالح.");
    const source=body as Record<string,unknown>;
    if(Object.keys(source).some(key=>!["amount","currency","method","note","expectedVersion","similarityReview"].includes(key))||!isCurrency(source.currency)
      ||typeof source.amount!=="string"||typeof source.expectedVersion!=="number"||source.method!=="cash"&&source.method!=="transfer"
      ||source.note!==null&&typeof source.note!=="string")throw new DebtRepaymentError("invalid","راجع مبلغ التحصيل وعملته وطريقته.");
    const amountMinor=parseAmount(source.amount,source.currency);if(amountMinor===null||amountMinor<=0)throw new DebtRepaymentError("invalid","اكتب مبلغًا موجبًا صحيحًا.");
    if(Object.hasOwn(source,"similarityReview")){
      const review=parseSimilarCollectionReview(source.similarityReview);
      if(!review)throw new DebtRepaymentError("invalid","تأكيد مراجعة السندات غير صالح.");
      const key=request.headers.get("idempotency-key");
      const replay=key?await getPaymentByIdempotencyKey(key):null;
      if(!replay&&!reviewMatchesReceipts(review,await findSimilarCollections(Number(params.id),amountMinor,source.currency)))
        return NextResponse.json({reason:"similar_collection_review_required",message:"ظهر سند قبض مشابه؛ راجع السندات قبل تحصيل قسط آخر."},{status:409});
    }
    const result=await collectDebtInstallment({patientId:Number(params.id),arrangementId:Number(params.arrangementId),expectedVersion:source.expectedVersion,amountMinor,currency:source.currency,
      method:source.method,note:typeof source.note==="string"?source.note.trim().slice(0,300)||null:null,idempotencyKey:request.headers.get("idempotency-key")??"",session});
    return NextResponse.json(result,{status:result.replayed?200:201});
  }catch(error){
    const bounded=bodyErrorResponse(error);if(bounded)return bounded;
    if(error instanceof DebtRepaymentError)return NextResponse.json({code:error.code,message:error.message},{status:error.code==="unauthorized"?401:error.code==="invalid"?400:409});
    return NextResponse.json({message:"نتيجة التحصيل غير مؤكدة؛ أعد نفس الطلب بالمفتاح نفسه."},{status:500});
  }
}
