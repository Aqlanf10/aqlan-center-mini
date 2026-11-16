import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, getPool } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { canReadLabBacklog, parseLabBacklogQuery } from "@/lib/lab-backlog";
import { readLabBacklog } from "@/lib/lab-backlog-db";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { readCanonicalLabBacklog } from "@/lib/canonical-lab-reads";

export const dynamic = "force-dynamic";
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
export async function GET(request: Request) {
  /* M2 slice 66: clinical.lab.view with the WHOLE patient scope; tasks only with
     tasks.use; one owning snapshot; never the legacy session. */
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, 401);
  if (selected.kind === "canonical") {
    const input = parseLabBacklogQuery(new URL(request.url).searchParams);
    if (!input) return json({ message: "مرشح أو صفحة غير صالحين." }, 400);
    try { return json(await readCanonicalLabBacklog(selected.handle, input)); }
    catch (error) {
      const failure = canonicalPatientReadFailure(error, "تعذّر التحقق من التراكيب المفتوحة. الأعداد غير معروفة؛ أعد المحاولة.");
      failure.headers.set("Cache-Control", "private, no-store");
      return failure;
    }
  }
  const session = await requireSession();
  if (!session) return json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, 401);
  if (!canReadLabBacklog(session.role)) return json({ message: "قائمة متابعة المعمل الشاملة للإدارة فقط." }, 403);
  const input = parseLabBacklogQuery(new URL(request.url).searchParams);
  if (!input) return json({ message: "مرشح أو صفحة غير صالحين." }, 400);
  try {
    const snapshot = await readLabBacklog(getPool(), input, CLINIC_TIME_ZONE, session);
    const current = await requireSession();
    if (!current || current.userId !== session.userId || current.username !== session.username || !canReadLabBacklog(current.role)) {
      return json({ message: "تغيّرت الجلسة؛ أعد تسجيل الدخول." }, 401);
    }
    return json(snapshot);
  } catch {
    return json({ message: "تعذّر التحقق من التراكيب المفتوحة. الأعداد غير معروفة؛ أعد المحاولة." }, 503);
  }
}
