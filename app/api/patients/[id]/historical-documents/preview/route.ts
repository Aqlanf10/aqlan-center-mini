import {NextResponse} from "next/server";
import {requireSession} from "@/lib/session";
import {readJsonBody} from "@/lib/http-body";
import {JSON_BODY_LIMIT_BYTES} from "@/lib/security-limits";
import {previewHistoricalDocument} from "@/lib/legacy-treatment-document-db";
import {DebtRepaymentError} from "@/lib/debt-installments-db";
import {historicalDocumentError} from "@/lib/historical-document-http";
export const dynamic="force-dynamic";
export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  const session=await requireSession();if(!session)return NextResponse.json({message:"سجّل الدخول من جديد."},{status:401});
  if(!["admin","reception"].includes(session.role))return NextResponse.json({message:"معاينة الاتفاق للمدير والاستقبال المخوّل."},{status:403});
  try{const patientId=Number((await context.params).id);if(!Number.isSafeInteger(patientId)||patientId<=0)throw new DebtRepaymentError("invalid","رقم المريض غير صالح.");
    const source=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);if(!source||typeof source!=="object"||Array.isArray(source))throw new DebtRepaymentError("invalid","طلب غير صالح.");
    if((source as Record<string,unknown>).patientId!==patientId)throw new DebtRepaymentError("invalid","هوية المريض لا تطابق الطلب.");
    return NextResponse.json(await previewHistoricalDocument(patientId,source as Record<string,unknown>,session),{headers:{"Cache-Control":"no-store"}});
  }catch(error){return historicalDocumentError(error);}
}
