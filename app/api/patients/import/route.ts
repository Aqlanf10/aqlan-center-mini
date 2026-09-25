import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { IMPORT_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { CLINIC_TIME_ZONE, allPatientCandidates, commitPatientImport, findPatientImport } from "@/lib/db";
import { classifyImportRows, importSummary, looksLikeBrokenEncoding, parseCsv, type ImportRow } from "@/lib/patient-import";
import { clinicDateString } from "@/lib/schedule";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (P1-5) استيراد مرضى المركز القديم من ملف Excel محفوظ CSV.
 *
 * **للمدير وحده**: دفعةٌ واحدة تُنشئ آلاف الملفات وأرصدتها الافتتاحية — وهذا قرار
 * إدارة لا عمل استقبال. وخطوتان: `preview` تصنّف ولا تكتب شيئًا، و`commit` تعيد
 * التصنيف على القاعدة كما هي لحظة الحفظ وتكتب كل شيء في معاملة واحدة.
 */
function publicRow(row: ImportRow) {
  return {
    line: row.line,
    status: row.status,
    reason: row.reason,
    fullName: row.patient?.fullName ?? null,
    phone: row.patient?.phone ?? null,
    birthYear: row.patient?.birthYear ?? null,
    legacyNumber: row.legacyNumber,
    openingMinor: row.openingMinor,
    manualBalance: row.manualBalance,
    matchedPatient: row.matchedPatient,
  };
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "استيراد المرضى للمدير وحده." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(request, IMPORT_BODY_LIMIT_BYTES);
    body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const csv = typeof body.csv === "string" ? body.csv : "";
  const fileName = typeof body.fileName === "string" && body.fileName.trim() ? body.fileName.trim().slice(0, 120) : "ملف بلا اسم";
  const mode = body.mode === "commit" ? "commit" : body.mode === "preview" ? "preview" : null;
  if (!mode) return NextResponse.json({ message: "حدّد المعاينة أو الحفظ." }, { status: 400 });
  if (!csv.trim()) return NextResponse.json({ message: "الملف فارغ." }, { status: 400 });
  if (looksLikeBrokenEncoding(csv)) {
    return NextResponse.json({
      message: "الحروف العربية في الملف مكسورة. احفظه من Excel بصيغة «CSV UTF-8 (محدد بفاصلة)» ثم أعد رفعه.",
    }, { status: 400 });
  }

  const rows = parseCsv(csv);
  const fileSha256 = createHash("sha256").update(csv, "utf8").digest("hex");
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);

  try {
    if (mode === "preview") {
      const [existing, previous] = await Promise.all([allPatientCandidates(), findPatientImport(fileSha256)]);
      const classified = classifyImportRows(rows, existing, today);
      if (classified.rows.length === 0) {
        return NextResponse.json({ message: classified.problems[0] ?? "الملف غير صالح.", problems: classified.problems }, { status: 400 });
      }
      return NextResponse.json({
        fileSha256,
        alreadyImported: previous,
        problems: classified.problems,
        summary: importSummary(classified.rows),
        rows: classified.rows.map(publicRow),
      });
    }

    // الحفظ يطلب البصمة التي عاينها الموظف: ملفٌ تغيّر بعد المعاينة لا يُحفظ بمعاينةٍ قديمة.
    if (body.fileSha256 !== fileSha256) {
      return NextResponse.json({ message: "تغيّر الملف بعد المعاينة. عاينه من جديد قبل الاستيراد." }, { status: 409 });
    }
    const result = await commitPatientImport({
      rows, fileSha256, fileName, today,
      includePossibleDuplicates: body.includePossibleDuplicates === true,
      actor: session.username, actorRole: session.role,
    });
    if (!result.ok && result.reason === "already_imported") {
      return NextResponse.json({ message: "هذا الملف استُورد من قبل — لا يُستورد مرتين.", alreadyImported: { at: result.at, actor: result.actor } }, { status: 409 });
    }
    if (!result.ok) {
      return NextResponse.json({ message: result.problems[0] ?? "الملف غير صالح.", problems: result.problems }, { status: 400 });
    }
    return NextResponse.json({
      created: result.created,
      summary: importSummary(result.rows),
      // أرصدة بعملةٍ غير اليمني لم تُحوَّل — تُدخل يدويًّا في ملفات من أُنشئ منهم.
      manualBalances: result.created.flatMap((patient) => {
        const row = result.rows.find((candidate) => candidate.line === patient.line);
        return row?.manualBalance ? [{ ...publicRow(row), patientId: patient.id, patientNumber: patient.patientNumber }] : [];
      }),
    }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر الاستيراد. لم يُحفظ شيء — أعد المحاولة." }, { status: 500 });
  }
}
