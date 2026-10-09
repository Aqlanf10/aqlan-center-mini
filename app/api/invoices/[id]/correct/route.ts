import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { correctInvoice, getInvoice, isPeriodLocked } from "@/lib/db";
import { CORRECTION_REASON_MAX, CORRECTION_REASON_MIN } from "@/lib/invoice-correction";
import { parseAmount } from "@/lib/money";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (FIN-2) تصحيح فاتورةٍ بمبلغٍ زائد — للمدير، بسببٍ مكتوب.
 *
 * الجسم: `{ reason, lines: [{ itemId, quantity, unitPrice }] }` — البنود الباقية بأسعارها
 * بعملة الفاتورة (نصًّا كما يُكتب في الشاشة). البند الغائب يُحذف. الأصل يُلغى وتصدر بدله
 * فاتورةٌ مصحَّحة (lib/db.ts correctInvoice).
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "تصحيح الفاتورة للمدير وحده." }, { status: 403 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الفاتورة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const reason = typeof source.reason === "string" ? source.reason.trim() : "";
  if (reason.length < CORRECTION_REASON_MIN) {
    return NextResponse.json({ message: "اكتب سبب التصحيح." }, { status: 400 });
  }
  if (reason.length > CORRECTION_REASON_MAX) {
    return NextResponse.json({ message: `سبب التصحيح أطول من ${CORRECTION_REASON_MAX} حرفًا.` }, { status: 400 });
  }
  if (!Array.isArray(source.lines) || source.lines.length > 200) {
    return NextResponse.json({ message: "بنود التصحيح غير صالحة." }, { status: 400 });
  }

  try {
    const invoice = await getInvoice(id);
    if (!invoice) return NextResponse.json({ message: "الفاتورة غير موجودة." }, { status: 404 });
    // تصحيح فاتورةٍ من فترةٍ مقفلة يغيّر إيراد شهرٍ صُدّق عليه — كالإلغاء تمامًا.
    if (await isPeriodLocked(invoice.createdAt.slice(0, 10))) {
      return NextResponse.json(
        { message: "الفاتورة في فترة مقفلة. صحّحها بقيدٍ في الفترة المفتوحة." },
        { status: 409 },
      );
    }

    const lines: { itemId: number; quantity: number; unitPriceMinor: number }[] = [];
    for (const raw of source.lines as unknown[]) {
      const line = (raw ?? {}) as Record<string, unknown>;
      const itemId = Number(line.itemId);
      const quantity = Number(line.quantity);
      const unitPriceMinor = parseAmount(String(line.unitPrice ?? ""), invoice.baseCurrency);
      if (!Number.isInteger(itemId) || itemId <= 0 || !Number.isInteger(quantity) || unitPriceMinor === null) {
        return NextResponse.json({ message: "بند تصحيح غير صالح: الكمية عدد صحيح والسعر مبلغ." }, { status: 400 });
      }
      lines.push({ itemId, quantity, unitPriceMinor });
    }

    const result = await correctInvoice({
      invoiceId: id, lines, reason, actor: session.username, actorRole: session.role,
    });
    if (!result.ok) {
      const status = result.reason === "not_found" ? 404 : result.reason === "invalid" ? 400 : 409;
      return NextResponse.json({ message: result.message }, { status });
    }
    return NextResponse.json({ original: result.original, corrected: result.corrected }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر تصحيح الفاتورة." }, { status: 500 });
  }
}
