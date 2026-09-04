import { NextResponse } from "next/server";
import { getInvoice, isPeriodLocked, recordAudit, setInvoiceStatus } from "@/lib/db";
import { canHandleMoney, isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
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
  try {
    const invoice = await getInvoice(id);
    if (!invoice) return NextResponse.json({ message: "الفاتورة غير موجودة." }, { status: 404 });
    return NextResponse.json(invoice);
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الفاتورة." }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
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
  try { body = await request.json(); } catch {
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

    const updated = await setInvoiceStatus(id, status);
    if (!updated) {
      return NextResponse.json(
        { message: "الفاتورة غير موجودة أو ملغاة — والملغاة لا تُعاد." },
        { status: 409 },
      );
    }
    if (status === "cancelled") {
      await recordAudit({
        action: "invoice.cancel", entity: "invoice", entityId: id,
        entityLabel: updated.invoiceNumber,
        details: { الصافي: updated.totalMinor - updated.discountMinor, المريض: updated.patientId },
        actor: session.username, actorRole: session.role,
      });
    }
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ message: "تعذّر تنفيذ الإجراء." }, { status: 500 });
  }
}
