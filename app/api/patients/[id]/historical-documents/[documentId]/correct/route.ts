import {NextResponse} from "next/server";
import {requireSession} from "@/lib/session";
import {readJsonBody} from "@/lib/http-body";
import {JSON_BODY_LIMIT_BYTES} from "@/lib/security-limits";
import {correctHistoricalDocument} from "@/lib/legacy-treatment-document-db";
import {DebtRepaymentError} from "@/lib/debt-installments-db";
import {historicalDocumentError} from "@/lib/historical-document-http";
export const dynamic="force-dynamic";
export async function POST(request:Request,context:{params:Promise<{id:string;documentId:string}>}){
  const session=await requireSession();if(!session)return NextResponse.json({message:"سجّل الدخول من جديد."},{status:401});
  if(session.role!=="admin")return NextResponse.json({message:"تصحيح الاتفاق للمدير وحده."},{status:403});
  try{const params=await context.params,patientId=Number(params.id),documentId=Number(params.documentId);
    if(!Number.isSafeInteger(patientId)||patientId<=0||!Number.isSafeInteger(documentId)||documentId<=0)throw new DebtRepaymentError("invalid","هوية الاتفاق غير صالحة.");
    const source=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);if(!source||typeof source!=="object"||Array.isArray(source))throw new DebtRepaymentError("invalid","طلب غير صالح.");
    return NextResponse.json(await correctHistoricalDocument(patientId,documentId,source as Record<string,unknown>,session));
  }catch(error){return historicalDocumentError(error);}
}
