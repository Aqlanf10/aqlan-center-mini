import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getSettings, listParties, listServices } from "@/lib/db";
import { previewInvoiceLinkage } from "@/lib/invoice-linkage-db";
import { INVOICE_LINKAGE_MESSAGE } from "@/lib/invoice-clinical-linkage";
import { parseInvoiceInput } from "@/lib/invoice-input";
import { checkInvoiceAuthority } from "@/lib/invoice-pricing";
import { foreignRatesFromSettings } from "@/lib/service-pricing";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Read-only linkage preview uses the exact save parser and price-authority engine. */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (!canHandleMoney(session.role)) return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  let body: Record<string, unknown>;
  try { body = (await readJsonBody(request, JSON_BODY_LIMIT_BYTES) ?? {}) as Record<string, unknown>; }
  catch (error) { return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 }); }
  try {
    const services = new Map((await listServices(true)).map((service) => [service.id, service]));
    const doctors = new Set((await listParties("doctor")).map((party) => party.id));
    const parsed = parseInvoiceInput(body, services, doctors);
    if (!parsed.ok) return NextResponse.json({ message: parsed.message }, { status: 400 });
    const settings = await getSettings();
    const authority = checkInvoiceAuthority({
      lines: parsed.authorityLines, currency: parsed.baseCurrency, rates: foreignRatesFromSettings(settings), role: session.role,
      maxDiscountPercent: Number(settings["billing.max_discount_percent"]),
      totalMinor: parsed.items.reduce((sum, item) => sum + item.quantity * item.unitPriceMinor, 0),
      discountMinor: parsed.discountMinor, discountReason: typeof body.discountReason === "string" ? body.discountReason : null,
    });
    if (!authority.ok) return NextResponse.json({ message: authority.message }, { status: 400 });
    const lines = await previewInvoiceLinkage({ patientId: parsed.patientId, baseCurrency: parsed.baseCurrency, items: parsed.items });
    return NextResponse.json({ lines: lines.map((line) => ({ ...line,
      refusalMessage: line.refusal ? INVOICE_LINKAGE_MESSAGE[line.refusal] : null,
    })) }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ message: "تعذّرت معاينة الربط السريري." }, { status: 500 }); }
}
