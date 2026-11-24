import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { CLINIC_TIME_ZONE, browsePatients, createPatientWithDuplicateReview, findUserByUsername, getSettings, searchPatients } from "@/lib/db";
import { parseListFilter, parseListSort } from "@/lib/patient-browse";
import { openingBalanceAccess, parseOpeningInput, type OpeningInput } from "@/lib/opening-access";
import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/idempotency-key";
import { validatePatient } from "@/lib/patient";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";
import { duplicateWarning } from "@/lib/duplicates";
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

  // Match canAccessPatient: use the current doctor account and honor the explicit
  // all-patient grant before requiring its current party link. Null is the SQL
  // all-patients scope, so a missing link or failed account read must never reach it.
  let doctorPartyId: number | null = null;
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (!user || user.isActive !== true || user.id !== session.userId
      || user.username.toLowerCase() !== session.username.toLowerCase()
      || user.role !== session.role) return denied();
    if (user.permissions?.canViewAllPatients !== true) {
      if (typeof user.partyId !== "number" || !Number.isSafeInteger(user.partyId) || user.partyId <= 0) {
        return NextResponse.json({ message: "لا يمكنك عرض المرضى دون ربط حسابك بطبيب." }, { status: 403 });
      }
      doctorPartyId = user.partyId;
    }
  }

  try {
    // Explicit server projection: finance staff never receive clinical fields,
    // even when requesting this API directly rather than through the UI.
    const financeOnly = isRestrictedRole(session.role) || session.role === "reception";
    const financeSummary = (patient: { id: number; patientNumber: string; fullName: string; phone: string | null }) => ({
      id: patient.id, patientNumber: patient.patientNumber, fullName: patient.fullName, phone: patient.phone,
    });
    if (term.trim()) {
      const rows = await searchPatients(term, 20, doctorPartyId);
      return NextResponse.json(financeOnly ? rows.map(financeSummary) : rows);
    }

    // بلا كلمة بحث: صفحة من كل المرضى. الحدّ مغلق هنا لا مأخوذ من الطلب — رقم ضخم
    // في `offset` أو `limit` يجرّ الجدول كله إلى هاتف الاستقبال.
    // (PAT-1) المرشّح والترتيب على الخادم — يعملان على كل المرضى لا على الصفحة المعروضة.
    const page = Math.max(0, Math.floor(Number(params.get("page") ?? 0)) || 0);
    const filter = parseListFilter(params.get("filter"));
    const sort = parseListSort(params.get("sort"));
    // (PAT-3) علَمٌ بعينه — نصٌّ قصير يُقارن حرفيًّا بأعلام المريض (مُعامَلٌ لا يُلصق في SQL).
    const flag = (params.get("flag") ?? "").trim().slice(0, 30) || null;
    if (financeOnly && (flag || ["alert", "ortho", "debt"].includes(filter))) {
      return NextResponse.json({ message: "هذا المرشّح غير متاح لهذا الحساب." }, { status: 403 });
    }
    const { rows, total } = await browsePatients({
      offset: page * PAGE_SIZE, limit: PAGE_SIZE, filter, sort, doctorPartyId, flag,
      today: clinicDateString(new Date(), CLINIC_TIME_ZONE),
    });
    return NextResponse.json({
      // الأدوار المالية: هوية المريض فقط (عقد الأمن القائم) — لا أعمدة القائمة الإضافية.
      rows: financeOnly ? rows.map(financeSummary) : rows,
      total, page, pageSize: PAGE_SIZE, filter, sort, flag,
    });
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
    if (!user) return denied();
    if (user.permissions && user.permissions.canAddPatient === false) {
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

  const key = request.headers.get("Idempotency-Key");
  if (key !== null && !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return NextResponse.json({ message: "مفتاح إعادة التسجيل غير صالح." }, { status: 400 });
  }
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const validation = validatePatient((body ?? {}) as Record<string, unknown>, today);
  if (!validation.ok) {
    return NextResponse.json({ message: validation.message, field: validation.field }, { status: 400 });
  }

  /* (DAY1 — قرار المالك) مريضٌ سابق عليه مبلغٌ من قبل النظام: يُسجَّل رصيده السابق مع
     ملفه في الطلب نفسه — يُتحقق من الصلاحية والمبلغ **قبل** إنشاء الملف فلا يولد ملفٌ
     ناقص؛ والاستقبال يضيف (إن فعّله الإعداد) والمدير يضيف ويعدّل. */
  const rawOpening = (body as Record<string, unknown> | null)?.openingBalance;
  let opening: OpeningInput | null = null;
  let openingDateSpecified = false;
  if (rawOpening && typeof rawOpening === "object" && String((rawOpening as Record<string, unknown>).amount ?? "").trim()) {
    const settings = await getSettings().catch(() => null);
    const access = openingBalanceAccess(session.role, settings?.["finance.reception_adds_opening_balance"] === "true");
    if (!access.add) {
      return NextResponse.json({ message: "تسجيل الرصيد السابق ليس من صلاحيتك — اتركه للمدير." }, { status: 403 });
    }
    const fields = rawOpening as Record<string, unknown>;
    openingDateSpecified = typeof fields.asOfDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fields.asOfDate);
    const parsed = parseOpeningInput(fields, today);
    if (!parsed.ok) return NextResponse.json({ message: parsed.message, field: "openingBalance" }, { status: 400 });
    opening = parsed.value;
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
    const registration = await createPatientWithDuplicateReview(validation.value, confirmed, {
      actor: session.username, actorId: session.userId, actorRole: session.role, key, opening,
      // An omitted date means the day of the original write, even on a later retry.
      openingDateSpecified,
    });
    if (!registration.ok) {
      if ("status" in registration) {
        return NextResponse.json({ message: registration.message }, { status: registration.status });
      }
      return NextResponse.json(
        { message: duplicateWarning(registration.duplicates), duplicates: registration.duplicates },
        { status: 409 },
      );
    }
    return NextResponse.json(registration.patient, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ المريض. أعد المحاولة." }, { status: 500 });
  }
}
