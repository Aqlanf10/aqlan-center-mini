import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireSession } from "@/lib/session";
import { rebookPlannedVisit } from "@/lib/planned-visit-rebooking";
import { parsePlannedRebookIntent } from "@/lib/planned-visit-rebooking-contract";

export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (!["admin", "reception", "doctor"].includes(session.role)) return NextResponse.json({ message: "غير مصرّح لك بإعادة الحجز." }, { status: 403 });
  const { id } = await context.params;
  if (!/^[1-9]\d*$/.test(id) || Number(id) > 2147483647) return NextResponse.json({ message: "رقم الجلسة غير صالح." }, { status: 400 });
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); }
  catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const intent = parsePlannedRebookIntent(Number(id), body);
  if (!intent) return NextResponse.json({ message: "أدخل التاريخ والوقت وسبب إعادة الحجز بشكل صحيح، ثم أعد المحاولة." }, { status: 400 });
  try {
    const result = await rebookPlannedVisit(intent, session);
    if (!result.ok) return NextResponse.json({ message: result.message, ...(result.code ? { code: result.code } : {}), ...(result.conflict ? { conflict: result.conflict } : {}) }, { status: result.status });
    return NextResponse.json({ appointmentId: result.appointmentId, title: result.title, replayed: result.replayed },
      { status: result.replayed ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ message: "تعذّر تأكيد إعادة الحجز. أعد المحاولة نفسها للتحقق دون إنشاء موعد مكرر." }, { status: 500 });
  }
}
