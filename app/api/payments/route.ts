import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getSettings, listPaymentsByDate, recordAudit, recordPayment } from "@/lib/db";
import { isCurrency, parseAmount, type Currency } from "@/lib/money";
import { CLINIC_TIME_ZONE } from "@/lib/db";
import { clinicDateString } from "@/lib/schedule";
import { canHandleMoney } from "@/lib/roles";
import { rateFromSettings } from "@/lib/settings";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  const requested = new URL(request.url).searchParams.get("date") ?? "";
  const date = DATE_PATTERN.test(requested)
    ? requested : clinicDateString(new Date(), CLINIC_TIME_ZONE);
  try {
    return NextResponse.json({ date, payments: await listPaymentsByDate(date) });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المقبوضات." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patientId = Number(source.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "اختر المريض أولًا." }, { status: 400 });
  }

  const currency = source.currency;
  if (!isCurrency(currency)) {
    return NextResponse.json({ message: "اختر العملة." }, { status: 400 });
  }

  const amountMinor = parseAmount(String(source.amount ?? ""), currency);
  if (amountMinor === null || amountMinor === 0) {
    return NextResponse.json({ message: "اكتب مبلغًا أكبر من صفر." }, { status: 400 });
  }

  const kind = source.kind === "refund" ? "refund" : "payment";
  const method = source.method === "transfer" ? "transfer" : "cash";
  const invoiceIdRaw = Number(source.invoiceId);
  const invoiceId = Number.isInteger(invoiceIdRaw) && invoiceIdRaw > 0 ? invoiceIdRaw : null;
  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300) : null;

  /* (P1.5) مفتاح الإعادة من ترويسة الطلب: النقر المزدوج/إعادة الإرسال/انقطاع
     الشبكة كلها تنتج الطلب نفسه بالمفتاح نفسه → سند واحد فقط، والثاني replay
     يعيد السند الأول نفسه (200 لا 201). بلا الترويسة يبقى السلوك كما كان. */
  const idempotencyKeyRaw = request.headers.get("idempotency-key");
  const idempotencyKey = idempotencyKeyRaw && idempotencyKeyRaw.trim()
    ? idempotencyKeyRaw.trim() : null;
  if (idempotencyKey && !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    return NextResponse.json(
      { message: "مفتاح الإعادة (Idempotency-Key) غير صالح: ٨–١٢٨ محرفًا من حروف وأرقام و . _ : -" },
      { status: 400 },
    );
  }

  const reversalOfRaw = Number(source.reversalOfId);
  const reversalOfId = Number.isInteger(reversalOfRaw) && reversalOfRaw > 0 ? reversalOfRaw : null;

  /* (P1-FIX-5) الردّ بلا سند أصلي مرفوض من الباب: لا ردّ «حُرّ». */
  if (kind === "refund" && reversalOfId === null) {
    return NextResponse.json(
      { message: "الردّ يتطلب تحديد السند الأصلي (reversalOfId) — لا يُردّ مال بلا أصل." },
      { status: 400 },
    );
  }

  const settings = await getSettings();
  const base = settings["finance.base_currency"];
  if (!isCurrency(base)) {
    return NextResponse.json({ message: "العملة الأساسية في الإعدادات غير صالحة." }, { status: 500 });
  }
  const exchangeRate = rateFromSettings(settings, currency, base);
  if (exchangeRate === null) {
    return NextResponse.json(
      { message: "سعر الصرف غير مضبوط. اضبطه في الإعدادات قبل قبض عملة أجنبية." },
      { status: 409 },
    );
  }

  try {
    const { payment, reason, replayed } = await recordPayment({
      patientId, invoiceId, kind, amountMinor, currency,
      baseCurrency: base, exchangeRate, method, note, createdBy: session.username,
      idempotencyKey, reversalOfId,
    });
    if (reason === "invalid_invoice") {
      return NextResponse.json({ message: "الفاتورة لا تخص المريض أو غير صالحة." }, { status: 409 });
    }
    if (reason === "invalid_reversal") {
      return NextResponse.json(
        { message: "السند المُراد ردّه غير موجود، أو لا يخص المريض، أو ليس دفعة أصلية." },
        { status: 409 },
      );
    }
    if (reason === "reversal_currency_mismatch") {
      return NextResponse.json(
        { message: "الردّ يجب أن يكون بعملة السند الأصلي نفسها — لا ردّ بعملة مختلفة." },
        { status: 409 },
      );
    }
    if (reason === "reversal_exceeds_remaining") {
      return NextResponse.json(
        { message: "المبلغ يتجاوز المتبقي القابل للرد من السند الأصلي — مجموع الردود لا يتخطى مبلغ الأصل." },
        { status: 409 },
      );
    }
    if (reason === "idempotency_conflict") {
      return NextResponse.json(
        { message: "مفتاح الإعادة مستعمل بعملية مختلفة — مفتاح واحد لعملية واحدة." },
        { status: 409 },
      );
    }
    if (reason === "no_shift") {
      // بلا هذا الشرط تُسجَّل الدفعة خارج أي وردية فلا تظهر في جرد أحد — مالٌ دخل
      // ولا أثر له في أي إغلاق.
      return NextResponse.json(
        { message: "لا توجد وردية مفتوحة. افتح الوردية من شاشة المالية أولًا." },
        { status: 409 },
      );
    }
    // بعد النجاح لا قبله: تسجيلُ ما لم يقع أسوأ من عدم تسجيل ما وقع.
    if (payment && !replayed) {
      await recordAudit({
        action: payment.kind === "refund" ? "payment.refund" : "payment.create",
        entity: "payment", entityId: payment.id, entityLabel: payment.receiptNumber,
        details: {
          المريض: patientId, المبلغ: payment.amountMinor, العملة: payment.currency,
          سعر_الصرف: payment.exchangeRate, المكافئ: payment.baseAmountMinor,
          الطريقة: payment.method,
          ...(reversalOfId ? { ردٌّ_لسند: reversalOfId } : {}),
        },
        actor: session.username, actorRole: session.role,
      });
    }
    if (payment && replayed) {
      await recordAudit({
        action: "payment.idempotent_replay", entity: "payment",
        entityId: payment.id, entityLabel: payment.receiptNumber,
        details: { المريض: patientId, مفتاح_الإعادة: idempotencyKey },
        actor: session.username, actorRole: session.role,
      });
    }
    // replay = نفس العملية المالية التي نجحت قبل قليل، فيُعاد السند نفسه بلا 201.
    return NextResponse.json(payment, { status: replayed ? 200 : 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر تسجيل الدفعة. أعد المحاولة." }, { status: 500 });
  }
}
