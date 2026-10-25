import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, getPool } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { canReadLeadershipPulse, parsePulseQuery } from "@/lib/leadership-pulse";
import { readLeadershipPulse } from "@/lib/leadership-pulse-db";
export const dynamic = "force-dynamic";
const json = (body: unknown,status=200) => NextResponse.json(body,{status,headers:{"Cache-Control":"private, no-store"}});
export async function GET(request:Request) {
 const session=await requireSession();
 if (!session) return json({message:"انتهت الجلسة. سجّل الدخول من جديد."},401);
 if (!canReadLeadershipPulse(session.role)) return json({message:"مراجعة القيادة للإدارة فقط."},403);
 const input=parsePulseQuery(new URL(request.url).searchParams,new Date(),CLINIC_TIME_ZONE);
 if (!input) return json({message:"اختر مصدرًا ويومًا وصفحة صحيحة."},400);
 try {
  const data=await readLeadershipPulse(getPool(),input,CLINIC_TIME_ZONE,session);
  const current=await requireSession();
  if (!current || current.userId!==session.userId || current.username!==session.username || !canReadLeadershipPulse(current.role))
   return json({message:"تغيّرت الجلسة أو الصلاحية. أعد تسجيل الدخول."},401);
  return json(data);
 } catch { return json({message:"تعذّر التحقق من المصدر. العدد غير معروف؛ أعد المحاولة."},503); }
}
