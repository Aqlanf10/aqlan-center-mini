import { NextResponse } from "next/server";
import { patientLegacyHistory } from "@/lib/db";
import { canAccessPatient, canViewPatientMoney } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { CanonicalLegacyArchiveRefusal, readCanonicalLegacyArchive } from "@/lib/canonical-legacy-reads";

export const dynamic = "force-dynamic";

/**
 * (P1-5ج) سجل النظام القديم لمريض — معالجاته ودفعاته كما كانت، للقراءة.
 * حارس الملف مع صلاحية قراءة ماله: الأرشيف يحتوي مبالغ حتى لو كان مسدّدًا بالكامل.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  // M2 slice 95a (G4-2): the archive is money; the ledger view inside the patient scope.
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try { return NextResponse.json(await readCanonicalLegacyArchive(selected.handle, Number((await context.params).id)), { headers: NO_STORE }); }
    catch (error) {
      if (error instanceof CanonicalLegacyArchiveRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: 403, headers: NO_STORE });
      return canonicalPatientReadFailure(error, "تعذّر تحميل سجل النظام القديم.");
    }
  }
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  const id = Number((await context.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  if (!(await canAccessPatient(session, id))) return NextResponse.json({ message: "الملف غير موجود." }, { status: 404 });
  if (!(await canViewPatientMoney(session, id))) {
    return NextResponse.json({ message: "غير مصرّح لك بالاطلاع على السجل المالي السابق لهذا المريض." }, { status: 403 });
  }
  try {
    return NextResponse.json(await patientLegacyHistory(id));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل سجل النظام القديم." }, { status: 500 });
  }
}
