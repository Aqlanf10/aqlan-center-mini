import {NextResponse} from "next/server";
import {requireSession} from "@/lib/session";
import {canHandleMoney} from "@/lib/roles";
import {isCurrency} from "@/lib/money";
import {findSimilarCollections} from "@/lib/similar-collection";

export const dynamic="force-dynamic";
/** Read-only preview: no payment, shift, installment or commission writes. */
export async function GET(request:Request) {
  const session=await requireSession();
  if(!session)return NextResponse.json({message:"انتهت الجلسة."},{status:401});
  if(!canHandleMoney(session.role)||(session.role==="cashier"&&!session.financeAccess?.collectPayments))
    return NextResponse.json({message:"ليس لديك صلاحية تحصيل."},{status:403});
  const params=new URL(request.url).searchParams;
  const patientId=Number(params.get("patientId")), amountMinor=Number(params.get("amountMinor")), currency=params.get("currency");
  if(!Number.isSafeInteger(patientId)||patientId<=0||!Number.isSafeInteger(amountMinor)||amountMinor<=0||!isCurrency(currency))
    return NextResponse.json({message:"طلب فحص التحصيل غير صالح."},{status:400});
  try{
    const receipts=await findSimilarCollections(patientId,amountMinor,currency);
    // Latest 32 receipts bound the preview; new receipts always displace the newest-first snapshot.
    return NextResponse.json({receipts,windowHours:24},{headers:{"Cache-Control":"no-store"}});
  }catch{return NextResponse.json({message:"تعذّر التأكد من السندات السابقة، لم يبدأ التحصيل."},{status:503});}
}
