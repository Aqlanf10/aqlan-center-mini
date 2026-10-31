import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { getPool, ensureSchema } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE } from "@/lib/canonical-patient-http";
import { canonicalEndoVisitFailure, readCanonicalPatientMaterials } from "@/lib/canonical-endo-visits";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  }
  if (selected.kind === "canonical") {
    const { id: rawId } = await context.params;
    try {
      return NextResponse.json(await readCanonicalPatientMaterials(selected.handle, Number(rawId)), { headers: NO_STORE });
    } catch (error) {
      return canonicalEndoVisitFailure(error, "تعذّر تحميل سجل المستهلكات.");
    }
  }
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
    const { rows } = await getPool().query(
      `SELECT m.id, m.item_id, m.kind, m.qty, m.expiry_date, m.reason, m.visit_id, m.created_by, m.created_at,
              i.name AS item_name, i.unit, i.category
         FROM inventory_movements m
         JOIN inventory_items i ON i.id = m.item_id
        WHERE m.patient_id = $1 OR m.visit_id IN (SELECT id FROM visits WHERE patient_id = $1)
        ORDER BY m.id DESC
        LIMIT 100`,
      [patientId],
    );

    const movements = rows.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      itemName: r.item_name,
      category: r.category,
      unit: r.unit,
      kind: r.kind,
      qty: Number(r.qty),
      expiryDate: r.expiry_date ? String(r.expiry_date).slice(0, 10) : null,
      reason: r.reason,
      visitId: r.visit_id,
      createdBy: r.created_by,
      createdAt: r.created_at.toISOString(),
    }));

    return NextResponse.json(movements);
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل سجل المستهلكات." }, { status: 500 });
  }
}
