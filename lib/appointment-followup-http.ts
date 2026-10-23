import { NextResponse } from "next/server";
import { FollowupRejected } from "./appointment-followup-db";
export const followupJson = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
export function followupError(error: unknown) {
  if (error instanceof FollowupRejected) return followupJson({ code: error.code, message: error.status === 403 ? "متابعة الغياب متاحة للاستقبال والمدير فقط." : error.status === 401 ? "انتهت الجلسة. سجّل الدخول من جديد." : "تغيّرت بيانات المتابعة أو لم تعد صالحة. حدّث السياق قبل إجراء جديد." }, error.status);
  return followupJson({ message: "تعذّر تأكيد العملية. أعد المحاولة نفسها دون تغيير بياناتها." }, 500);
}
