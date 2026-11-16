import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { getPool, ensureSchema, listPatientMaterialsWith } from "@/lib/db";
import { canonicalPatientGet } from "@/lib/canonical-patient-http";
import { readCanonicalPatientMaterials } from "@/lib/canonical-patient-reads";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  // M2 slice 82: a clinical grant inside the patient scope (read:patients.clinical); no costs.
  const canonical = await canonicalPatientGet((await context.params).id, readCanonicalPatientMaterials, "تعذّر تحميل سجل المستهلكات.");
  if (canonical) return canonical;
  const session = await requireSession();
  if (!session) return denied();
  const { id: rawId } = await context.params;
  const patientId = Number(rawId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  }
  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "غير مصرّح لك بالاطلاع على مستهلكات هذا المريض." }, { status: 403 });
  }

  try {
    await ensureSchema();
    const movements = await listPatientMaterialsWith(getPool(), patientId);
    return NextResponse.json(movements);
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل سجل المستهلكات." }, { status: 500 });
  }
}
