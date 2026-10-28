import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { listReturnBookingContexts, parseReturnBookingSource, readReturnBookingContext, type ReturnBookingResolution } from "@/lib/return-booking-context";
import { patientResponsibilitySettings, ResponsibilityError } from "@/lib/patient-responsibility-settings";
import type { SessionPayload } from "@/lib/auth";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, 401);
  if (!["admin", "doctor", "reception"].includes(session.role)) return json({ message: "غير مصرّح لك بحجز موعد." }, 403);
  const { id } = await context.params;
  if (!/^[1-9]\d*$/.test(id) || Number(id) > 2147483647) return json({ message: "رقم المريض غير صالح." }, 400);
  const patientId = Number(id);
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => !["kind", "sourceId", "originKind", "originId"].includes(key))
    || [...new Set(params.keys())].some(key => params.getAll(key).length !== 1)) return json({ message: "سياق الحجز غير صالح." }, 400);
  const source = params.has("kind") || params.has("sourceId") ? parseReturnBookingSource({ kind: params.get("kind"), id: Number(params.get("sourceId")) }) : null;
  const origin = params.has("originKind") || params.has("originId") ? parseReturnBookingSource({ kind: params.get("originKind"), id: Number(params.get("originId")) }) : undefined;
  if (((params.has("kind") || params.has("sourceId")) && !source)
    || ((params.has("originKind") || params.has("originId")) && (!origin || !source))) return json({ message: "سياق الحجز غير صالح." }, 400);
  try {
    if (!await canAccessPatient(session, patientId)) return json({ message: "غير مصرّح لك بملف هذا المريض." }, 403);
    await ensureSchema();
    if (!source) return json({ contexts: await listReturnBookingContexts(getPool(), patientId) });
    const result = await readReturnBookingContext(getPool(), patientId, source, { origin: origin ?? undefined });
    if (!result.ok && result.code === "responsibility_missing") return json({ ...result, responsibilitySuggestion: await pendingSuggestion(session, patientId, result) }, 409);
    return json(result, result.ok ? 200 : 409);
  } catch {
    return json({ message: "تعذّر التحقق من الطبيب المسؤول. حدّث السياق وأعد المحاولة." }, 500);
  }
}

/** Display only: the suggested doctor awaiting confirmation, for an actor allowed to view case responsibility.
 * Reading it writes nothing and never unlocks booking. Null when the actor may not view it. */
async function pendingSuggestion(session: SessionPayload, patientId: number, refusal: Extract<ReturnBookingResolution, { ok: false }>) {
  const targets = (refusal.contexts ?? []).filter(context => context.code === "responsibility_missing").map(context => context.settingsTarget);
  if (targets.length !== 1) return { doctorName: null, basis: null, message: "تحديد الطبيب المسؤول مطلوب من الإدارة." };
  try {
    const settings = await patientResponsibilitySettings({ patientId, kind: targets[0].kind, sourceId: targets[0].id }, session);
    if (settings.doctorId !== null) return null; // Changed meanwhile: the next context read decides.
    return settings.suggestion
      ? { doctorName: settings.suggestion.doctorName, basis: settings.suggestion.basis, message: "بانتظار تأكيد المدير." }
      : { doctorName: null, basis: null, message: "تحديد الطبيب المسؤول مطلوب من الإدارة." };
  } catch (error) {
    if (error instanceof ResponsibilityError) return null;
    throw error;
  }
}
