import { decodePrescriptionPrintCursor } from "@/lib/prescription-print-pagination";
import { NextResponse } from "next/server";
import { NO_STORE } from "@/lib/canonical-patient-http";
import { canonicalClinicalRecordsFailure, readCanonicalSavedPrescriptionPrints } from "@/lib/canonical-clinical-records";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { canPrintSavedPrescription } from "@/lib/prescription-print-access";
import { getClinicalVisit, getPatient, listSavedPrescriptionPrints } from "@/lib/db";
export const dynamic = "force-dynamic";
/** Minimal print picker; no medications, notes, suggestions or issuer options. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try {
      const url = new URL(request.url);
      return NextResponse.json(
        await readCanonicalSavedPrescriptionPrints(
          selected.handle,
          (await context.params).id,
          url.searchParams.get("visitId"),
          url.searchParams.get("cursor"),
        ),
        { headers: NO_STORE },
      );
    } catch (error) {
      return canonicalClinicalRecordsFailure(error, "تعذرت قراءة الوصفات المحفوظة.");
    }
  }
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "سجّل الدخول من جديد." }, { status: 401 });
  if (!await canPrintSavedPrescription(session)) return NextResponse.json({ message: "لا تملك صلاحية إعادة طباعة الوصفات المحفوظة." }, { status: 403 });
  const patientId = Number((await context.params).id);
  const rawVisit = new URL(request.url).searchParams.get("visitId");
  const visitId = rawVisit === null ? null : Number(rawVisit);
  if (!Number.isSafeInteger(patientId) || patientId <= 0 || (visitId !== null && (!Number.isSafeInteger(visitId) || visitId <= 0)))
    return NextResponse.json({ message: "رقم المريض أو الزيارة غير صالح." }, { status: 400 });
  if (!await canAccessPatient(session, patientId)) return NextResponse.json({ message: "غير مصرح بالوصول إلى المريض." }, { status: 403 });
  try {
    if (!await getPatient(patientId)) return NextResponse.json({ message: "الملف غير موجود." }, { status: 404 });
    if (visitId !== null && (await getClinicalVisit(visitId))?.patientId !== patientId)
      return NextResponse.json({ message: "الزيارة لا تطابق المريض." }, { status: 404 });
    let cursor;
    try { cursor = decodePrescriptionPrintCursor(new URL(request.url).searchParams.get("cursor"), patientId, visitId); }
    catch { return NextResponse.json({ message: "مؤشر الصفحة غير صالح؛ حدّث القائمة." }, { status: 400 }); }
    const page = await listSavedPrescriptionPrints(patientId, visitId, cursor);
    return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ message: "تعذرت قراءة الوصفات المحفوظة." }, { status: 500 }); }
}
