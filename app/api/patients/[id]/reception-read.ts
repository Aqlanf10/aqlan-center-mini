import { NextResponse } from "next/server";
import type { SessionPayload } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { canAccessPatient, canViewPatientMoney } from "@/lib/patient-access";
import { readReceptionPatientAccount } from "@/lib/reception-patient-account";
import { canHandleMoney } from "@/lib/roles";
import { patientAppointmentId } from "@/lib/patient-appointments-contract";

interface DeskPatient { id: number; fullName: string; patientNumber: string; phone: string | null }

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function receptionRead(request: Request, session: SessionPayload, rawId: string) {
  const params = new URL(request.url).searchParams;
  const mode = params.get("projection");
  const id = patientAppointmentId(rawId);
  if (id === null || params.size !== 1 || (mode !== "reception" && mode !== "reception-money"))
    return json({ message: "طلب غير صالح." }, 400);
  if (session.role !== "reception") return json({ message: "هذه الواجهة للاستقبال." }, 403);
  const missing = () => json({ message: "الملف غير متاح." }, 404);
  try {
    if (!await canAccessPatient(session, id)) return missing();
    const pool = getPool();
    if (mode === "reception") {
      const { rows: [row] } = await pool.query<DeskPatient>(
        'SELECT id, full_name AS "fullName", patient_number AS "patientNumber", phone FROM patients WHERE id = $1', [id]);
      if (!row || row.id !== id) return missing();
      const { fullName, patientNumber, phone } = row;
      return json({ id, fullName, patientNumber, phone });
    }
    if (!await canViewPatientMoney(session, id)) return json({ message: "الرصيد غير متاح." }, 403);
    const exists = await pool.query<{id:number}>("SELECT id FROM patients WHERE id = $1", [id]);
    if (exists.rows[0]?.id !== id) return missing();
    const account = await readReceptionPatientAccount(id);
    return json({ ...account, canCollect: canHandleMoney(session.role) });
  } catch {
    return json({ message: "تعذّر التحقق من بيانات المريض." }, 500);
  }
}
