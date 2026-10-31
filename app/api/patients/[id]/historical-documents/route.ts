import {NextResponse} from "next/server";
import {NO_STORE} from "@/lib/canonical-patient-http";
import {createHistoricalDocumentCanonicalResponse,listHistoricalDocumentsCanonicalResponse} from "@/lib/canonical-patient-finance-history";
import {requireSession} from "@/lib/session";
import {selectRequestStaffEnvelope} from "@/lib/staff-session-admission";
import {canAccessPatient} from "@/lib/patient-access";
import {readJsonBody} from "@/lib/http-body";
import {JSON_BODY_LIMIT_BYTES} from "@/lib/security-limits";
import {createHistoricalDocument,listHistoricalDocuments} from "@/lib/legacy-treatment-document-db";
import {DebtRepaymentError} from "@/lib/debt-installments-db";
import {historicalDocumentError} from "@/lib/historical-document-http";
export const dynamic="force-dynamic";
type Context={params:Promise<{id:string}>};
export async function GET(_request:Request,context:Context){
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") return listHistoricalDocumentsCanonicalResponse(selected.handle, (await context.params).id);
  const session=await requireSession();if(!session)return NextResponse.json({message:"سجّل الدخول من جديد."},{status:401});
  const patientId=Number((await context.params).id);
  if(!["admin","reception"].includes(session.role)&&!(session.role==="doctor"&&await canAccessPatient(session,patientId,"canViewPatientPayments")))return NextResponse.json({message:"غير مصرّح لك بعرض الاتفاقات."},{status:403});
  try{if(!Number.isSafeInteger(patientId)||patientId<=0)throw new DebtRepaymentError("invalid","رقم المريض غير صالح.");
    return NextResponse.json({documents:await listHistoricalDocuments(patientId)},{headers:{"Cache-Control":"no-store"}});
  }catch(error){return historicalDocumentError(error);}
}
export async function POST(request:Request,context:Context){
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") return createHistoricalDocumentCanonicalResponse(selected.handle, request, (await context.params).id);
  const session=await requireSession();if(!session)return NextResponse.json({message:"سجّل الدخول من جديد."},{status:401});
  if(!["admin","reception"].includes(session.role))return NextResponse.json({message:"تسجيل الاتفاق للمدير والاستقبال المخوّل."},{status:403});
  try{const patientId=Number((await context.params).id);if(!Number.isSafeInteger(patientId)||patientId<=0)throw new DebtRepaymentError("invalid","رقم المريض غير صالح.");
    const source=await readJsonBody(request,JSON_BODY_LIMIT_BYTES);if(!source||typeof source!=="object"||Array.isArray(source))throw new DebtRepaymentError("invalid","طلب غير صالح.");
    const result=await createHistoricalDocument(patientId,source as Record<string,unknown>,session);return NextResponse.json(result,{status:result.replayed?200:201});
  }catch(error){return historicalDocumentError(error);}
}
