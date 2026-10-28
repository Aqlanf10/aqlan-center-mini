import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { CLINIC_TIME_ZONE, browsePatients, createPatient, duplicateCandidates, findUserByUsername, getSettings, isPeriodLocked, recordAudit, searchPatients, setPatientOpeningBalance } from "@/lib/db";
import { parseListFilter, parseListSort } from "@/lib/patient-browse";
import { openingBalanceAccess, parseOpeningInput, type OpeningInput } from "@/lib/opening-access";
import { PATIENT_AUDIT_FIELDS, auditSnapshot } from "@/lib/audit-diff";
import { validatePatient } from "@/lib/patient";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";
import { duplicateWarning, findDuplicates } from "@/lib/duplicates";
import { isRestrictedRole } from "@/lib/role-routes";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { staffAdmissionRefusal } from "@/lib/staff-capability-editor";
import { CanonicalPatientReadRefusal, readCanonicalPatientBrowse, readCanonicalPatientSearch } from "@/lib/canonical-patient-reads";
import type { VerifiedDurableSession } from "@/lib/staff-durable-session";
import { commandCanonicalPatientCreate } from "@/lib/canonical-patient-writes";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const PAGE_SIZE = 25;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/**
 * Canonical identity (M2 slice 1). A canonical cookie never falls back to the legacy
 * session or role: the list is one owning RR snapshot admitted by the registered
 * record read `read:patients.directory` (patient scope + grant projection, see
 * lib/canonical-patient-reads.ts). Same query parameters and response shapes as the
 * legacy path, plus `projection` so the screen knows which column groups it holds.
 */
async function canonicalGet(request: Request, handle: VerifiedDurableSession) {
  const params = new URL(request.url).searchParams;
  const term = params.get("q") ?? "";
  try {
    if (term.trim()) {
      const { rows } = await readCanonicalPatientSearch(handle, { kind: "search", term });
      return NextResponse.json(rows, { headers: NO_STORE });
    }
    const page = Math.max(0, Math.floor(Number(params.get("page") ?? 0)) || 0);
    const body = await readCanonicalPatientBrowse(handle, {
      kind: "browse", page, filter: parseListFilter(params.get("filter")), sort: parseListSort(params.get("sort")),
      flag: (params.get("flag") ?? "").trim().slice(0, 30) || null, today: clinicDateString(new Date(), CLINIC_TIME_ZONE),
    });
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof CanonicalPatientReadRefusal) {
      return NextResponse.json({ code: error.code, message: error.message }, { status: error.code === "invalid_patient_query" ? 400 : 403, headers: NO_STORE });
    }
    const refusal = staffAdmissionRefusal(error);
    if (refusal) {
      const message = /RECORD_SCOPE_DENIED$/.test(refusal.code) ? "لا تملك صلاحية عرض المرضى." : refusal.message;
      return NextResponse.json({ code: refusal.code, message }, { status: refusal.status, headers: NO_STORE });
    }
    return NextResponse.json({ message: "تعذّر البحث. أعد المحاولة." }, { status: 500, headers: NO_STORE });
  }
}

export async function GET(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "canonical") return canonicalGet(request, selected.handle);
  if (selected.kind === "denied") return denied();
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
    // (PAT-1) المرشّح والترتيب على الخادم — يعملان على كل المرضى لا على الصفحة المعروضة.
    const page = Math.max(0, Math.floor(Number(params.get("page") ?? 0)) || 0);
    const filter = parseListFilter(params.get("filter"));
    const sort = parseListSort(params.get("sort"));
    // (PAT-3) علَمٌ بعينه — نصٌّ قصير يُقارن حرفيًّا بأعلام المريض (مُعامَلٌ لا يُلصق في SQL).
    const flag = (params.get("flag") ?? "").trim().slice(0, 30) || null;
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

/**
 * Canonical creation (M2 slice 1b): one admitted `patients.create` operation, with the
 * same validation and duplicate warning as the legacy path (lib/canonical-patient-writes.ts).
 * The previous-balance step is refused, not dropped: it is not canonical yet.
 */
async function canonicalPost(request: Request, handle: VerifiedDurableSession) {
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const validation = validatePatient(source, clinicDateString(new Date(), CLINIC_TIME_ZONE));
  if (!validation.ok) {
    return NextResponse.json({ message: validation.message, field: validation.field }, { status: 400, headers: NO_STORE });
  }
  const rawOpening = source.openingBalance;
  if (rawOpening && typeof rawOpening === "object" && String((rawOpening as Record<string, unknown>).amount ?? "").trim()) {
    return NextResponse.json({ code: "opening_balance_not_canonical", field: "openingBalance",
      message: "تسجيل الرصيد السابق لم يُنقل بعد إلى الهوية الموحّدة. أنشئ الملف دون الرصيد، ويُسجَّل الرصيد حين تُنقل شاشة الحساب." },
      { status: 409, headers: NO_STORE });
  }
  try {
    const result = await commandCanonicalPatientCreate(handle, validation.value, source.confirmDuplicate === true);
    if (result.kind === "duplicates") {
      return NextResponse.json({ message: result.message, duplicates: result.duplicates, disclosed: result.disclosed }, { status: 409, headers: NO_STORE });
    }
    return NextResponse.json(result.patient, { status: 201, headers: NO_STORE });
  } catch (error) {
    const refusal = staffAdmissionRefusal(error);
    if (refusal) return NextResponse.json({ code: refusal.code, message: refusal.message }, { status: refusal.status, headers: NO_STORE });
    return NextResponse.json({ message: "تعذّر حفظ المريض. أعد المحاولة." }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "canonical") return canonicalPost(request, selected.handle);
  if (selected.kind === "denied") return denied();
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
  if (rawOpening && typeof rawOpening === "object" && String((rawOpening as Record<string, unknown>).amount ?? "").trim()) {
    const settings = await getSettings().catch(() => null);
    const access = openingBalanceAccess(session.role, settings?.["finance.reception_adds_opening_balance"] === "true");
    if (!access.add) {
      return NextResponse.json({ message: "تسجيل الرصيد السابق ليس من صلاحيتك — اتركه للمدير." }, { status: 403 });
    }
    const parsed = parseOpeningInput(rawOpening as Record<string, unknown>, today);
    if (!parsed.ok) return NextResponse.json({ message: parsed.message, field: "openingBalance" }, { status: 400 });
    if (await isPeriodLocked(parsed.value.asOfDate)) {
      return NextResponse.json({ message: "تاريخ الرصيد السابق في فترة مقفلة. اختر تاريخًا بعد تاريخ الإقفال." }, { status: 409 });
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
        return NextResponse.json({
          ...created,
          warning: "حُفظ المريض لكن تعذّر حفظ الرصيد السابق — أضفه من ملفه ← الحساب ← «رصيد سابق».",
        }, { status: 201 });
      }
    }
    return NextResponse.json(created, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ المريض. أعد المحاولة." }, { status: 500 });
  }
}
