import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { listServices } from "@/lib/db";
import { previewInvoiceLinkage } from "@/lib/invoice-linkage-db";
import { INVOICE_LINKAGE_MESSAGE } from "@/lib/invoice-clinical-linkage";
import { isCurrency, parseAmount, CLINIC_BASE_CURRENCY } from "@/lib/money";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (INV-LINK D) معاينة الربط السريري للفاتورة قبل حفظها — قراءةٌ فقط، لمن يصدر الفاتورة.
 * لكل بند: مالي فقط، أو علاجٌ بتخصصه وبند خطته (قائم/جديد) وحالته (قائمة/أولية/جسر/اختيار) وأي رفضٍ متوقَّع.
 */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try { body = (await readJsonBody(request, JSON_BODY_LIMIT_BYTES) ?? {}) as Record<string, unknown>; } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const patientId = Number(body.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) return NextResponse.json({ message: "اختر المريض أولًا." }, { status: 400 });
  const currency = isCurrency(body.currency) ? body.currency : CLINIC_BASE_CURRENCY;
  const raw = Array.isArray(body.items) ? body.items.slice(0, 40) as Record<string, unknown>[] : [];
  try {
    const services = new Map((await listServices(true)).map((service) => [service.id, service]));
    const toInt = (value: unknown) => (value === undefined || value === null || String(value).trim() === "" ? null : Number(value));
    const items = raw.map((item) => {
      const service = services.get(Number(item.serviceId));
      const typed = item.price === undefined || String(item.price).trim() === "" ? null : parseAmount(String(item.price), currency);
      const tooth = toInt(item.toothCode);
      const caseId = toInt(item.caseId);
      return {
        serviceId: service?.id ?? null, category: service?.category ?? null,
        quantity: Math.max(1, Math.round(Number(item.quantity ?? 1)) || 1),
        unitPriceMinor: typed ?? (currency === CLINIC_BASE_CURRENCY && service ? service.priceMinor : 0),
        toothCode: tooth !== null && Number.isInteger(tooth) ? tooth : null,
        caseId: caseId !== null && Number.isInteger(caseId) && caseId > 0 ? caseId : null,
      };
    });
    const lines = await previewInvoiceLinkage({ patientId, baseCurrency: currency, items });
    return NextResponse.json({
      lines: lines.map((line) => ({ ...line, refusalMessage: line.refusal ? INVOICE_LINKAGE_MESSAGE[line.refusal] : null })),
    });
  } catch {
    return NextResponse.json({ message: "تعذّرت معاينة الربط السريري." }, { status: 500 });
  }
}
