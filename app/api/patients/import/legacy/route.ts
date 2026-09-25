import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { IMPORT_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  CLINIC_TIME_ZONE, applyLegacyAssignments, commitLegacyImport, existingOpeningKeys, findLegacyImport, legacyPatientRefs,
} from "@/lib/db";
import { parseLegacySessions, parseLegacyTreatments, planLegacyImport } from "@/lib/legacy-import";
import { looksLikeBrokenEncoding, parseCsv } from "@/lib/patient-import";
import { clinicDateString } from "@/lib/schedule";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (P1-5ج) استيراد معالجات النظام القديم ودفعاته — للمدير وحده، بعد استيراد المرضى.
 *
 * `preview`: كل معالجة ودفعة بمريضها، وما لم يُربط (اسمٌ غير موجود أو مكرر بلا هاتف
 * يفرّقه) ليختار المالك صاحبه، والأرصدة الناتجة بعملاتها، وتعارضها مع أرصدة قائمة.
 * `commit`: ببصمة المعاينة واختيارات المالك — معاملةٌ واحدة.
 */

function assignmentsOf(value: unknown): Record<number, number> {
  const result: Record<number, number> = {};
  if (!value || typeof value !== "object") return result;
  for (const [key, patient] of Object.entries(value as Record<string, unknown>)) {
    const treatment = Number(key);
    const patientId = Number(patient);
    if (Number.isInteger(treatment) && treatment > 0 && Number.isInteger(patientId) && patientId > 0) result[treatment] = patientId;
  }
  return result;
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (!isAdmin(session.role)) return NextResponse.json({ message: "استيراد النظام القديم للمدير وحده." }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(request, IMPORT_BODY_LIMIT_BYTES);
    body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const mode = body.mode === "commit" ? "commit" : body.mode === "preview" ? "preview" : null;
  if (!mode) return NextResponse.json({ message: "حدّد المعاينة أو الحفظ." }, { status: 400 });
  const treatmentsCsv = typeof body.treatmentsCsv === "string" ? body.treatmentsCsv : "";
  const sessionsCsv = typeof body.sessionsCsv === "string" ? body.sessionsCsv : "";
  if (!treatmentsCsv.trim()) return NextResponse.json({ message: "اختر ملف المعالجات." }, { status: 400 });
  // الاستيراد مرةً واحدة: المعالجات فريدة برقمها، فلو حُفظت بلا ملف الجلسات لما أمكن
  // إضافة دفعاتها لاحقًا — فالحفظ يطلب الملفين معًا.
  if (mode === "commit" && !sessionsCsv.trim()) {
    return NextResponse.json({ message: "اختر ملف الجلسات (الدفعات) أيضًا — يُستورد الملفان معًا مرةً واحدة." }, { status: 400 });
  }
  if (looksLikeBrokenEncoding(treatmentsCsv) || looksLikeBrokenEncoding(sessionsCsv)) {
    return NextResponse.json({ message: "الحروف العربية في الملف مكسورة. ارفع ملف Excel نفسه أو احفظه «CSV UTF-8»." }, { status: 400 });
  }
  const fileNames = typeof body.fileNames === "string" ? body.fileNames.slice(0, 200) : "";

  const treatments = parseLegacyTreatments(parseCsv(treatmentsCsv));
  const sessions = sessionsCsv.trim() ? parseLegacySessions(parseCsv(sessionsCsv)) : { records: [], problems: [] };
  if (treatments.records.length === 0) {
    return NextResponse.json({ message: treatments.problems[0]?.reason ?? "ملف المعالجات فارغ.", problems: treatments.problems }, { status: 400 });
  }
  if (sessionsCsv.trim() && sessions.records.length === 0) {
    return NextResponse.json({ message: sessions.problems[0]?.reason ?? "ملف الدفعات فارغ.", problems: sessions.problems }, { status: 400 });
  }
  const fileSha256 = createHash("sha256").update(`${treatmentsCsv}\n--\n${sessionsCsv}`, "utf8").digest("hex");
  const assignments = assignmentsOf(body.assignments);

  try {
    if (mode === "preview") {
      const [patients, previous, existing] = await Promise.all([legacyPatientRefs(), findLegacyImport(fileSha256), existingOpeningKeys()]);
      const plan = applyLegacyAssignments(planLegacyImport(treatments.records, sessions.records, patients), assignments, patients);
      return NextResponse.json({
        fileSha256,
        alreadyImported: previous,
        problems: [...treatments.problems.map((p) => ({ ...p, file: "المعالجات" })), ...sessions.problems.map((p) => ({ ...p, file: "الدفعات" }))],
        summary: plan.summary,
        unresolved: plan.treatments
          .filter((row) => row.match.kind !== "matched")
          .map((row) => ({
            legacyNumber: row.record.legacyNumber, patientName: row.record.patientName, phone: row.record.phone,
            treatedOn: row.record.treatedOn, service: row.record.service,
            currency: row.record.currency, remainingMinor: row.record.remainingMinor,
            candidates: row.match.kind === "ambiguous"
              ? row.match.candidates.map((patient) => ({ id: patient.id, patientNumber: patient.patientNumber, fullName: patient.fullName, phone: patient.phone }))
              : [],
          })),
        conflicts: plan.balances.filter((balance) => existing.has(`${balance.patientId}:${balance.currency}`)).length,
      });
    }

    if (body.fileSha256 !== fileSha256) {
      return NextResponse.json({ message: "تغيّر الملفان بعد المعاينة. عاينهما من جديد قبل الاستيراد." }, { status: 409 });
    }
    const result = await commitLegacyImport({
      treatments: treatments.records, sessions: sessions.records, assignments, fileSha256, fileNames,
      asOfDate: clinicDateString(new Date(), CLINIC_TIME_ZONE),
      actor: session.username, actorRole: session.role,
    });
    if (!result.ok) {
      return NextResponse.json({ message: "هذان الملفان استُوردا من قبل — لا يُستوردان مرتين.", alreadyImported: { at: result.at, actor: result.actor } }, { status: 409 });
    }
    return NextResponse.json(result, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر استيراد النظام القديم. لم يُحفظ شيء — أعد المحاولة." }, { status: 500 });
  }
}
