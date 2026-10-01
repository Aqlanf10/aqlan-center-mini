import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";
import type { IntakeAnswers } from "@/lib/portal";

export const dynamic = "force-dynamic";

interface IntakeRow {
  id: number;
  answers: IntakeAnswers;
  created_at: Date;
}

/**
 * سجل الاستمارات الصحية كما كتبها المريض.
 *
 * لا يكتب شيئًا ولا يستدعي ensureSchema: هذا مسار قراءة سريري على مخططٍ مُهاجَر.
 * وهو منفصل قصديًا عن medicalAlert الذي يكتبه الطبيب؛ كلام المريض لا يتحول
 * تلقائيًا إلى تشخيص أو تنبيه طبي موثّق.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json(
      { message: "انتهت الجلسة. سجّل الدخول من جديد." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { id: rawId } = await context.params;
  const patientId = Number(rawId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json(
      { message: "رقم المريض غير صالح." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json(
      { message: "غير مصرّح لك بالاطلاع على هذا الملف." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const { rows } = await getPool().query<IntakeRow>(
      `SELECT id, answers, created_at
         FROM patient_intake_forms
        WHERE patient_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 50`,
      [patientId],
    );

    const forms = rows.map((row) => {
      const source = row.answers && typeof row.answers === "object"
        ? row.answers as IntakeAnswers
        : {} as IntakeAnswers;
      return {
        id: row.id,
        answers: {
          conditions: Array.isArray(source.conditions)
            ? source.conditions.filter((value): value is string => typeof value === "string")
            : [],
          allergies: typeof source.allergies === "string" ? source.allergies : null,
          medications: typeof source.medications === "string" ? source.medications : null,
          emergencyName: typeof source.emergencyName === "string" ? source.emergencyName : null,
          emergencyPhone: typeof source.emergencyPhone === "string" ? source.emergencyPhone : null,
          note: typeof source.note === "string" ? source.note : null,
        },
        createdAt: row.created_at.toISOString(),
      };
    });

    return NextResponse.json(
      { forms },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { message: "تعذّر تحميل تاريخ الاستمارات الصحية." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
