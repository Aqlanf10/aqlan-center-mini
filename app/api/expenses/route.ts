import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { CLINIC_TIME_ZONE, expenseRequestKeyIsUnused, findUserByUsername, getSettings, listExpensesBetween, ratesFromSettings, recordExpense, voidExpense } from "@/lib/db";
import { parseExpenseRequest, refusalStatus } from "@/lib/expense-request";
import { expenseRequestHash } from "@/lib/expense-request-hash";
import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/idempotency-key";
import { CLINIC_BASE_CURRENCY } from "@/lib/money";
import { refusalMessage } from "@/lib/supplier-payments";
import { clinicDateString } from "@/lib/schedule";
import { canHandleMoney, canViewMoney, isAdmin } from "@/lib/roles";
import { canDoctorViewExpenses } from "@/lib/doctor-permissions";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { canonicalErrorResponse, NO_STORE } from "@/lib/canonical-route";
import { CanonicalExpenseRefusal, commandCanonicalExpenseCreate } from "@/lib/canonical-expense-create";
import { requestsOwnerPrivatePart } from "@/lib/expense-payment-split";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  /* صلاحيات الوكيل المساعد: المصروفات من «المالية المخفية» — تُفتح للطبيب
     بتصريح المدير الصريح فقط، وللإدارة والاستقبال كما كانت. */
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (!canDoctorViewExpenses(user?.permissions, session.role)) {
      return NextResponse.json(
        { message: "المصروفات وبنود الصرف مخفية بحسب سياسة المالية المخفية." },
        { status: 403 },
      );
    }
  } else if (!canViewMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  const params = new URL(request.url).searchParams;
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const from = DATE_PATTERN.test(params.get("from") ?? "") ? params.get("from")! : today;
  const to = DATE_PATTERN.test(params.get("to") ?? "") ? params.get("to")! : today;
  try {
    return NextResponse.json({ from, to, expenses: await listExpensesBetween(from, to) });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المصروفات." }, { status: 500 });
  }
}

/** Review #483 6882465665: a refusal says the key holds nothing only after checking it under its lock. */
async function keyState(requestKey: string): Promise<{ requestKeyState?: "unused" }> {
  try { return await expenseRequestKeyIsUnused(requestKey) ? { requestKeyState: "unused" } : {}; } catch { return {}; }
}

const KEY_REQUIRED = { code: "expense_request_key_required",
  message: "طلب الصرف بلا مفتاح طلب صالح؛ لم يُسجَّل شيء. حدّث الصفحة ثم أعد التسجيل." } as const;

/** M2 slice 97 (first route) and 0128: a canonical session never falls through to the legacy role path.
 * The domain command owns admission, its transaction, the voucher, the audit and the owner proof. */
async function canonicalExpenseCreate(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "legacy" || selected.kind === "none") return null;
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  const requestKey = request.headers.get("Idempotency-Key");
  if (!requestKey || !IDEMPOTENCY_KEY_PATTERN.test(requestKey)) return NextResponse.json(KEY_REQUIRED, { status: 400, headers: NO_STORE });
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const response = bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
    response.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
    return response;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  try {
    const { expense, replayed } = await commandCanonicalExpenseCreate(selected.handle, { source: body as Record<string, unknown>, requestKey });
    return replayed
      ? NextResponse.json({ ...expense, existing: true, replayed: true }, { status: 200, headers: NO_STORE })
      : NextResponse.json(expense, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof CanonicalExpenseRefusal) {
      return NextResponse.json({ code: error.code, message: error.message, quote: error.quote,
        ...(error.keyUnused ? { requestKeyState: "unused" } : {}),
        ...(error.code === "exceeds_drawer_cash" ? { drawerAvailableMinor: error.quote?.drawer?.availableMinor ?? null } : {}) },
      { status: error.status, headers: NO_STORE });
    }
    return canonicalErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const canonical = await canonicalExpenseCreate(request);
  if (canonical) return canonical;
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role) || (session.role === "cashier" && !session.financeAccess?.createExpenses)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }

  // 0128 (owner #483 6831365228 item 3): one key per intended voucher, reused for every retry of it.
  const requestKey = request.headers.get("Idempotency-Key");
  if (!requestKey || !IDEMPOTENCY_KEY_PATTERN.test(requestKey)) return NextResponse.json(KEY_REQUIRED, { status: 400 });

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  // 0128 (§2.2): a legacy session cannot prove the protected owner, so it can never record a private part.
  if (requestsOwnerPrivatePart(source)) {
    return NextResponse.json({ code: "owner_private_requires_owner",
      message: "الدفع من المصدر الخاص للمالك وحده، ويتطلب جلسة موثّقة للمالك؛ لم يُسجَّل شيء. سجّل المصروف من الدرج.",
      ...await keyState(requestKey) }, { status: 403 });
  }

  // (TD-05) الأساس دستوري من الكود — والإعدادات لأسعار الصرف لحظة الدفع.
  const base = CLINIC_BASE_CURRENCY;
  const settingsRates = ratesFromSettings(await getSettings());
  const parsed = parseExpenseRequest(source, settingsRates, isAdmin(session.role));
  if (!parsed.ok) return NextResponse.json({ message: parsed.message, ...await keyState(requestKey) }, { status: parsed.status });
  const request_ = parsed.value;

  const hash = expenseRequestHash(session.username, request_,
    { source: "drawer", drawerMinor: request_.amountMinor, ownerPrivateMinor: 0, ownerPrivateReason: null });
  try {
    const { expense, reason, quote, replayed, keyUnused } = await recordExpense({
      category: request_.category, partyId: request_.partyId, payeeText: request_.payeeText,
      amountMinor: request_.amountMinor, currency: request_.currency, baseCurrency: base,
      exchangeRate: request_.exchangeRate, payableId: request_.payableId, note: request_.note,
      createdBy: session.username, actorRole: session.role, rates: settingsRates,
      payableExchangeRate: request_.payableExchangeRate,
      rateOverrideReason: request_.rateOverrideReason,
      prepaymentReason: request_.prepaymentReason,
      expectedQuote: request_.expectedQuote,
      request: { key: requestKey, hash },
    });
    if (reason) {
      return NextResponse.json(
        { message: refusalMessage(reason, quote), code: reason, quote,
          ...(keyUnused ? { requestKeyState: "unused" } : {}),
          ...(reason === "exceeds_drawer_cash" ? { drawerAvailableMinor: quote?.drawer?.availableMinor ?? null } : {}) },
        { status: refusalStatus(reason) },
      );
    }
    if (replayed) return NextResponse.json({ ...expense, existing: true, replayed: true }, { status: 200 });
    return NextResponse.json(expense, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر تأكيد تسجيل الصرف. أعد الإرسال بالطلب نفسه للتحقق قبل تسجيل سند آخر." }, { status: 500 });
  }
}

/* حذف سند صرف — المدير وحده، وضمن ورديةٍ مفتوحة، ولا لسند يسدّد التزامًا. */
export async function DELETE(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "حذف سندات الصرف للمدير وحده." }, { status: 403 });
  }

  /* الجسم يُقرأ مرة واحدة (قيد الاستهلاك): الرقم من الاستعلام أو من الجسم،
     والسبب معه في القراءة نفسها. */
  const params = new URL(request.url).searchParams;
  let id = Number(params.get("id"));
  let reason: string | null = null;
  if (!Number.isInteger(id) || id <= 0) {
    try {
      const body = (await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES));
      const bodyId = Number(body?.id);
      if (Number.isInteger(bodyId) && bodyId > 0) id = bodyId;
      if (typeof body?.reason === "string" && body.reason.trim()) {
        reason = body.reason.trim().slice(0, 300);
      }
    } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded; /* فراغ */ }
  } else {
    try {
      const body = (await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES));
      if (typeof body?.reason === "string" && body.reason.trim()) {
        reason = body.reason.trim().slice(0, 300);
      }
    } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded; /* لا سبب — ليس شرطًا */ }
  }
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم السند غير صالح." }, { status: 400 });
  }

  try {
    const result = await voidExpense(id, { actor: session.username, actorRole: session.role, reason });
    if (!result.ok) {
      if (result.reason === "missing_reason") {
        return NextResponse.json(
          { message: "اكتب سبب الإبطال — تصحيح مالي بلا سبب مُوثَّق غير مقبول." },
          { status: 400 },
        );
      }
      if (result.reason === "already_voided") {
        return NextResponse.json(
          { message: "السند مُبطَل أصلًا — لا يُبطَل قيد الإبطال نفسه." },
          { status: 409 },
        );
      }
      if (result.reason === "closed_shift") {
        return NextResponse.json(
          { message: "وردية السند مقفلة ومجرودة — لا يُبطَل منها شيء بعد الاعتماد؛ القيد التصحيحي يُسجَّل في وردية مفتوحة." },
          { status: 409 },
        );
      }
      if (result.reason === "no_shift") {
        return NextResponse.json(
          { message: "لا توجد وردية مفتوحة. إبطال سداد المورد قيدٌ في وردية اليوم — افتح الوردية أولًا." },
          { status: 409 },
        );
      }
      return NextResponse.json({ message: "السند غير موجود." }, { status: 404 });
    }
    return NextResponse.json({
      message: `أُبطل السند بقيد معاكس (${result.voidedVoucherNumber ?? ""}) وسُجِّل الإبطال في التدقيق — الأصل باقٍ بلا تعديل.`,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر حذف السند. أعد المحاولة." }, { status: 500 });
  }
}
