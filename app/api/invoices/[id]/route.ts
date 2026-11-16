import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getInvoice, invoiceLinkedPaymentsByCurrency, isPeriodLocked, recordAudit, setInvoiceStatus } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { canHandleMoney, canViewMoney, isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { readCanonicalInvoice } from "@/lib/canonical-invoice-reads";
import { commandCanonicalInvoiceStatus, isCanonicalInvoiceRefusal, parseCanonicalInvoiceStatus } from "@/lib/canonical-invoice-writes";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  // M2 slice 92: finance.invoices.view; an invoice outside the patient scope reads like a missing one.
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try { return NextResponse.json(await readCanonicalInvoice(selected.handle, Number((await context.params).id)), { headers: NO_STORE }); }
    catch (error) { return canonicalPatientReadFailure(error, "تعذّر تحميل الفاتورة."); }
  }
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!canViewMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الفاتورة غير صالح." }, { status: 400 });
  }
  try {
    const invoice = await getInvoice(id);
    if (!invoice) return NextResponse.json({ message: "الفاتورة غير موجودة." }, { status: 404 });
    return NextResponse.json(invoice);
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الفاتورة." }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  // M2 slice 93a: reopen finance.invoices.create, cancel finance.invoices.cancel (+ reason),
  // manual "paid" finance.invoices.mark-paid; scope and period decided after the writer's locks.
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try {
      const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
      const command = parseCanonicalInvoiceStatus(body);
      return NextResponse.json(await commandCanonicalInvoiceStatus(selected.handle, Number((await context.params).id), command), { headers: NO_STORE });
    } catch (error) {
      const bounded = bodyErrorResponse(error); if (bounded) return bounded;
      if (isCanonicalInvoiceRefusal(error)) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
      return canonicalPatientReadFailure(error, "تعذّر تحديث الفاتورة.");
    }
  }
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الفاتورة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const status = (body as Record<string, unknown>)?.status;
  if (status !== "open" && status !== "paid" && status !== "cancelled") {
    return NextResponse.json({ message: "حالة غير معروفة." }, { status: 400 });
  }
  // الإلغاء يمسح مبلغًا من رصيد المريض، فهو للمدير وحده.
  if (status === "cancelled" && !isAdmin(session.role)) {
    return NextResponse.json({ message: "إلغاء الفاتورة للمدير وحده." }, { status: 403 });
  }
  /* (P2-4) الإلغاء قرارٌ مسبَّب: بلا سببٍ مكتوب لا يُعرف لاحقًا لماذا سقط مبلغٌ من
     رصيد مريض. */
  const rawReason = (body as Record<string, unknown>)?.reason;
  const reason = typeof rawReason === "string" ? rawReason.trim().slice(0, 300) : "";
  if (status === "cancelled" && reason.length < 3) {
    return NextResponse.json({ message: "اكتب سبب إلغاء الفاتورة." }, { status: 400 });
  }
  // وسم الفاتورة كـ paid يدوياً دون سند مالي للمدير وحده — الاستقبال تسجل سند قبض
  if (status === "paid" && !isAdmin(session.role)) {
    return NextResponse.json({ message: "سداد الفاتورة يتم تلقائياً عبر تسجيل سند قبض بالصندوق." }, { status: 403 });
  }

  try {
    // إلغاء فاتورة من فترة مقفلة يغيّر إيراد شهرٍ صُدّق عليه. التصحيح يكون بقيد في
    // الفترة المفتوحة لا بتعديل الماضي.
    const existing = await getInvoice(id);
    if (existing && await isPeriodLocked(existing.createdAt.slice(0, 10))) {
      return NextResponse.json(
        { message: "الفاتورة في فترة مقفلة. صحّحها بفاتورة أو قيد في الفترة المفتوحة." },
        { status: 409 },
      );
    }

    const updated = await setInvoiceStatus(id, status, { actor: session.username, actorRole: session.role });
    if (!updated) {
      return NextResponse.json(
        { message: "الفاتورة غير موجودة أو ملغاة — والملغاة لا تُعاد." },
        { status: 409 },
      );
    }
    if (status === "cancelled") {
      /* (P2-4) ما دُفع على الفاتورة لا يختفي بإلغائها: يبقى رصيدًا دائنًا للمريض
         بعملته. يُقال ذلك صراحةً مع طريق التصحيح، ويُحفظ في التدقيق. */
      const linked = await invoiceLinkedPaymentsByCurrency(id);
      const paidText = linked.map((row) => formatMoney(row.netMinor, row.currency)).join(" · ");
      await recordAudit({
        action: "invoice.cancel", entity: "invoice", entityId: id,
        entityLabel: updated.invoiceNumber,
        details: {
          الصافي: updated.totalMinor - updated.discountMinor, العملة: updated.baseCurrency,
          المريض: updated.patientId, السبب: reason,
          مدفوع_عليها: linked.length > 0 ? paidText : null,
        },
        actor: session.username, actorRole: session.role,
      });
      return NextResponse.json({
        ...updated,
        cancellation: {
          reason,
          paidOnInvoice: linked,
          guidance: linked.length > 0
            ? `دُفع على هذه الفاتورة ${paidText}. المبلغ باقٍ رصيدًا دائنًا للمريض: استرده له من الصندوق، أو اتركه يسدّد فاتورته القادمة.`
            : null,
        },
      });
    }
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ message: "تعذّر تنفيذ الإجراء." }, { status: 500 });
  }
}
