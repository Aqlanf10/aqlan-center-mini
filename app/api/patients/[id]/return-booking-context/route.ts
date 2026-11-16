import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { listReturnBookingContexts, parseReturnBookingSource, readReturnBookingContext } from "@/lib/return-booking-context";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { readCanonicalReturnBookingContext } from "@/lib/canonical-planned-visits";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  // M2 slice 22: a canonical envelope reads in the patient record snapshot (patient scope);
  // it never falls back to the legacy session. The query rules below are shared.
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, 401);
  const session = selected.kind === "canonical" ? null : await requireSession();
  if (selected.kind !== "canonical") {
    if (!session) return json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, 401);
    if (!["admin", "doctor", "reception"].includes(session.role)) return json({ message: "غير مصرّح لك بحجز موعد." }, 403);
  }
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
  if (selected.kind === "canonical") {
    try {
      const read = await readCanonicalReturnBookingContext(selected.handle, patientId, source, origin ?? undefined);
      return json(read.body, read.status);
    } catch (error) {
      return canonicalPatientReadFailure(error, "تعذّر التحقق من الطبيب المسؤول. حدّث السياق وأعد المحاولة.");
    }
  }
  try {
    if (!await canAccessPatient(session!, patientId)) return json({ message: "غير مصرّح لك بملف هذا المريض." }, 403);
    await ensureSchema();
    if (!source) return json({ contexts: await listReturnBookingContexts(getPool(), patientId) });
    const result = await readReturnBookingContext(getPool(), patientId, source, { origin: origin ?? undefined });
    return json(result, result.ok ? 200 : 409);
  } catch {
    return json({ message: "تعذّر التحقق من الطبيب المسؤول. حدّث السياق وأعد المحاولة." }, 500);
  }
}
