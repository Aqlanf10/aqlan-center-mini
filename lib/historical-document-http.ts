import {NextResponse} from "next/server";
import {bodyErrorResponse} from "./http-body";
import {DebtRepaymentError} from "./debt-installments-db";
import {LegacyTreatmentWriteError} from "./legacy-treatment-db";
import {LEGACY_TREATMENT_MESSAGE} from "./legacy-treatment";
export function historicalDocumentError(error:unknown){
  const bounded=bodyErrorResponse(error);if(bounded)return bounded;
  if(error instanceof LegacyTreatmentWriteError)return NextResponse.json({message:LEGACY_TREATMENT_MESSAGE[error.reason],code:"conflict"},{status:409});
  if(error instanceof DebtRepaymentError)return NextResponse.json({message:error.message,code:error.code},{status:error.code==="unauthorized"?403:error.code==="missing"?404:error.code==="invalid"?400:409});
  if((error as {code?:string})?.code==="55P03")return NextResponse.json({message:"يجري تحديث البيانات؛ أعد الطلب نفسه بعد لحظة.",code:"busy"},{status:409});
  return NextResponse.json({message:"تعذّر تأكيد حفظ الاتفاق؛ احتفظ بالطلب وأعده بالمفتاح نفسه."},{status:500});
}
