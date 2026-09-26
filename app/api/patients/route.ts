import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { CLINIC_TIME_ZONE, createPatient, duplicateCandidates, findUserByUsername, listPatients, recordAudit, searchPatients } from "@/lib/db";
import { PATIENT_AUDIT_FIELDS, auditSnapshot } from "@/lib/audit-diff";
import { validatePatient } from "@/lib/patient";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";
import { duplicateWarning, findDuplicates } from "@/lib/duplicates";
import { isRestrictedRole } from "@/lib/role-routes";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const PAGE_SIZE = 25;

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  const params = new URL(request.url).searchParams;
  const term = params.get("q") ?? "";

  // عزل الطبيب (§٣٩): طبيبٌ مربوطٌ بجهته يرى مرضاه فقط — والفلترة في الاستعلام
  // نفسه لا بعد جلب النتائج، فما ليس له لا يصل إلى الشبكة أصلًا.
  // صلاحيات الوكيل المساعد: من منحه المدير «عرض جميع المرضى» صراحةً يُرفع عنه
  // العزل — المنح الاستثنائي يوثّقه عمود الصلاحيات لا خيارٌ في الشاشة.
  let doctorPartyId =
    session.role === "doctor" && typeof session.partyId === "number" && session.partyId > 0
      ? session.partyId
      : null;
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (user?.permissions?.canViewAllPatients) doctorPartyId = null;
  }

  try {
    // Explicit server projection: finance staff never receive clinical fields,
    // even when requesting this API directly rather than through the UI.
    const financeOnly = isRestrictedRole(session.role);
    const financeSummary = (patient: { id: number; patientNumber: string; fullName: string; phone: string | null }) => ({
      id: patient.id, patientNumber: patient.patientNumber, fullName: patient.fullName, phone: patient.phone,
    });
    if (term.trim()) {
      const rows = await searchPatients(term, 20, doctorPartyId);
      return NextResponse.json(financeOnly ? rows.map(financeSummary) : rows);
    }

    // بلا كلمة بحث: صفحة من كل المرضى. الحدّ مغلق هنا لا مأخوذ من الطلب — رقم ضخم
    // في `offset` أو `limit` يجرّ الجدول كله إلى هاتف الاستقبال.
    const page = Math.max(0, Math.floor(Number(params.get("page") ?? 0)) || 0);
    const { rows, total } = await listPatients(page * PAGE_SIZE, PAGE_SIZE, doctorPartyId);
    return NextResponse.json({ rows: financeOnly ? rows.map(financeSummary) : rows, total, page, pageSize: PAGE_SIZE });
  } catch {
    return NextResponse.json({ message: "تعذّر البحث. أعد المحاولة." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  /* صلاحيات الوكيل المساعد: الطبيب الذي أغلق المدير عليه «إضافة مريض» لا ينشئ
     ملفات — الاستقبال والإدارة يبقى لهم الحق دائمًا. */
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (user?.permissions && user.permissions.canAddPatient === false) {
      return NextResponse.json(
        { message: "إضافة المرضى مخفية عنك بحسب صلاحياتك." },
        { status: 403 },
      );
    }
  }
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const validation = validatePatient((body ?? {}) as Record<string, unknown>, today);
  if (!validation.ok) {
    return NextResponse.json({ message: validation.message, field: validation.field }, { status: 400 });
  }

  try {
    /*
     * كشف التكرار — **تحذير لا منع**.
     *
     * سجلٌّ ثانٍ لمريض موجود لا يظهر ثمنه يوم الإنشاء بل بعد شهور: تاريخٌ نصفه في
     * ملف ونصفه في آخر، ورصيدٌ منقسم فيبدو المريض غير مدين وهو مدين. ودمج ملفين
     * يحمل كلٌّ منهما فواتير ودفعات عملٌ محاسبي لا زرّ.
     *
     * ولا يُمنع الإنشاء: التوائم موجودة، والأب وابنه قد يتشاركان رقمًا. ونظامٌ يمنع
     * يعلّم الاستقبال أن تحتال عليه بنقطة في الاسم — فيصير التكرار أخفى لا أقلّ.
     * ولذلك يُرسل `confirmDuplicate` من الواجهة بعد أن يراها الموظف بعينه.
     */
    const confirmed = (body as Record<string, unknown>)?.confirmDuplicate === true;
    if (!confirmed) {
      const candidates = await duplicateCandidates(validation.value);
      const matches = findDuplicates(validation.value, candidates);
      if (matches.length > 0) {
        return NextResponse.json(
          { message: duplicateWarning(matches), duplicates: matches },
          { status: 409 },
        );
      }
    }
    const created = await createPatient(validation.value);
    // (P1-4) الإنشاء يُدقَّق بلقطته — ومع علامة إن أُكِّد رغم تحذير التكرار.
    await recordAudit({
      action: "patient.create",
      entity: "patient", entityId: created.id, entityLabel: `${created.fullName} (${created.patientNumber})`,
      details: { ...auditSnapshot(created as unknown as Record<string, unknown>, PATIENT_AUDIT_FIELDS), تأكيد_رغم_التكرار: confirmed },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json(created, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ المريض. أعد المحاولة." }, { status: 500 });
  }
}
