import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { CLINIC_TIME_ZONE, browsePatients, createPatientWithDuplicateReview, findUserByUsername, getSettings, isPeriodLocked, recordAudit, searchPatients, setPatientOpeningBalance } from "@/lib/db";
import { parseListFilter, parseListSort } from "@/lib/patient-browse";
import { openingBalanceAccess, parseOpeningInput, type OpeningInput } from "@/lib/opening-access";
import { PATIENT_AUDIT_FIELDS, auditSnapshot } from "@/lib/audit-diff";
import { validatePatient } from "@/lib/patient";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";
import { duplicateWarning } from "@/lib/duplicates";
import { isRestrictedRole } from "@/lib/role-routes";

export const dynamic = "force-dynamic";

// Patient identifiers and clinical/financial metadata must never enter a shared cache.
function patientJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(body, { ...init, headers });
}

const denied = () =>
  patientJson({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

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
        return patientJson({ message: "لا يمكنك عرض المرضى دون ربط حسابك بطبيب." }, { status: 403 });
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
      return patientJson(financeOnly ? rows.map(financeSummary) : rows);
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
      return patientJson({ message: "هذا المرشّح غير متاح لهذا الحساب." }, { status: 403 });
    }
    const { rows, total } = await browsePatients({
      offset: page * PAGE_SIZE, limit: PAGE_SIZE, filter, sort, doctorPartyId, flag,
      today: clinicDateString(new Date(), CLINIC_TIME_ZONE),
    });
    return patientJson({
      // الأدوار المالية: هوية المريض فقط (عقد الأمن القائم) — لا أعمدة القائمة الإضافية.
      rows: financeOnly ? rows.map(financeSummary) : rows,
      total, page, pageSize: PAGE_SIZE, filter, sort, flag,
    });
  } catch {
    return patientJson({ message: "تعذّر البحث. أعد المحاولة." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  // Match the HTTP proxy and patient PATCH: restricted finance and assistant
  // accounts must never create an archive file, even without proxy mediation.
  if (!["admin", "doctor", "reception"].includes(session.role)) {
    return patientJson({ message: "إضافة المرضى غير مصرّح لهذا الدور." },
      { status: 403 });
  }
  /* صلاحيات الوكيل المساعد: الطبيب الذي أغلق المدير عليه «إضافة مريض» لا ينشئ
     ملفات — الاستقبال والإدارة يبقى لهم الحق دائمًا. */
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (!user || user.isActive !== true || user.id !== session.userId
      || user.username.toLowerCase() !== session.username.toLowerCase()
      || user.role !== session.role) return denied();
    if (user.permissions && user.permissions.canAddPatient === false) {
      return patientJson(
        { message: "إضافة المرضى مخفية عنك بحسب صلاحياتك." },
        { status: 403 },
      );
    }
  }
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) { bounded.headers.set("Cache-Control", "private, no-store"); return bounded; }
    return patientJson({ message: "طلب غير صالح." }, { status: 400 });
  }

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const validation = validatePatient((body ?? {}) as Record<string, unknown>, today);
  if (!validation.ok) {
    return patientJson({ message: validation.message, field: validation.field }, { status: 400 });
  }

  /* (DAY1 — قرار المالك) مريضٌ سابق عليه مبلغٌ من قبل النظام: يُسجَّل رصيده السابق مع
     ملفه في الطلب نفسه — يُتحقق من الصلاحية والمبلغ **قبل** إنشاء الملف فلا يولد ملفٌ
     ناقص؛ والاستقبال يضيف (إن فعّله الإعداد) والمدير يضيف ويعدّل. */
  const rawOpening = (body as Record<string, unknown> | null)?.openingBalance;
  let opening: OpeningInput | null = null;
  if (rawOpening && typeof rawOpening === "object" && String((rawOpening as Record<string, unknown>).amount ?? "").trim()) {
    const settings = await getSettings().catch(() => null);
    const access = openingBalanceAccess(session.role, settings?.["finance.reception_adds_opening_balance"] === "true");
    if (!access.add) {
      return patientJson({ message: "تسجيل الرصيد السابق ليس من صلاحيتك — اتركه للمدير." }, { status: 403 });
    }
    const parsed = parseOpeningInput(rawOpening as Record<string, unknown>, today);
    if (!parsed.ok) return patientJson({ message: parsed.message, field: "openingBalance" }, { status: 400 });
    if (await isPeriodLocked(parsed.value.asOfDate)) {
      return patientJson({ message: "تاريخ الرصيد السابق في فترة مقفلة. اختر تاريخًا بعد تاريخ الإقفال." }, { status: 409 });
    }
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
    const registration = await createPatientWithDuplicateReview(validation.value, confirmed);
    if (!registration.ok) {
      return patientJson(
        { message: duplicateWarning(registration.duplicates), duplicates: registration.duplicates },
        { status: 409 },
      );
    }
    const created = registration.patient;
    // (P1-4) الإنشاء يُدقَّق بلقطته — ومع علامة إن أُكِّد رغم تحذير التكرار.
    await recordAudit({
      action: "patient.create",
      entity: "patient", entityId: created.id, entityLabel: `${created.fullName} (${created.patientNumber})`,
      details: { ...auditSnapshot(created as unknown as Record<string, unknown>, PATIENT_AUDIT_FIELDS), تأكيد_رغم_التكرار: confirmed },
      actor: session.username, actorRole: session.role,
    });
    if (opening) {
      try {
        await setPatientOpeningBalance({
          patientId: created.id, currency: opening.currency, amountMinor: opening.amountMinor,
          asOfDate: opening.asOfDate, note: opening.note, createdBy: session.username, addOnly: true,
        });
        await recordAudit({
          action: "opening_balance.set", entity: "patient", entityId: created.id, entityLabel: created.fullName,
          details: { المبلغ: opening.amountMinor, العملة: opening.currency, التاريخ: opening.asOfDate, ملاحظة: opening.note, عند_التسجيل: true },
          actor: session.username, actorRole: session.role,
        });
      } catch {
        // الملف وُلد — والرصيد يُعاد من ملفه؛ يُقال ذلك صراحةً لا يُبلَع.
        return patientJson({
          ...created,
          warning: "حُفظ المريض لكن تعذّر حفظ الرصيد السابق — أضفه من ملفه ← الحساب ← «رصيد سابق».",
        }, { status: 201 });
      }
    }
    return patientJson(created, { status: 201 });
  } catch {
    return patientJson({ message: "تعذّر حفظ المريض. أعد المحاولة." }, { status: 500 });
  }
}
