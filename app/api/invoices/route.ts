import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getSettings, listParties, listPatientInvoices, listServices } from "@/lib/db";
import { createLinkedInvoice } from "@/lib/invoice-linkage-db";
import {
  INVOICE_LINKAGE_MESSAGE, invoiceRequestFingerprint, linkageRefusalStatus,
} from "@/lib/invoice-clinical-linkage";
import { effectiveTemplates } from "@/lib/specialty-templates";
import { checkInvoiceAuthority, formatPriceOverrides } from "@/lib/invoice-pricing";
import { foreignRatesFromSettings } from "@/lib/service-pricing";
import { parseInvoiceInput } from "@/lib/invoice-input";
import { canHandleMoney, canViewMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canViewMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  const patientId = Number(new URL(request.url).searchParams.get("patientId"));
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  }
  try {
    return NextResponse.json(await listPatientInvoices(patientId));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الفواتير." }, { status: 500 });
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

  const services = new Map((await listServices(true)).map((service) => [service.id, service]));
  const doctors = new Set((await listParties("doctor")).map((party) => party.id));
  const parsed = parseInvoiceInput(source, services, doctors);
  if (!parsed.ok) return NextResponse.json({ message: parsed.message }, { status: 400 });
  const { patientId, baseCurrency: base, items, authorityLines, discountMinor, note, idempotencyKey } = parsed;

  /* (FIN-4) حدّ الخصم نفسه الذي يحكم الزيارة: سعر خدمة الدليل المكتوب أقل، والخصم على
     الفاتورة — بسببٍ مكتوب، ولغير المدير حتى `billing.max_discount_percent`. */
  const settings = await getSettings();
  const authority = checkInvoiceAuthority({
    lines: authorityLines,
    currency: base,
    rates: foreignRatesFromSettings(settings),
    role: session.role,
    maxDiscountPercent: Number(settings["billing.max_discount_percent"]),
    totalMinor: items.reduce((sum, item) => sum + item.quantity * item.unitPriceMinor, 0),
    discountMinor,
    discountReason: typeof source.discountReason === "string" ? source.discountReason : null,
  });
  if (!authority.ok) {
    return NextResponse.json({ message: authority.message }, { status: 400 });
  }

  try {
    const result = await createLinkedInvoice({
      patientId, baseCurrency: base, discountMinor, note, createdBy: session.username, actorRole: session.role, items,
      templates: effectiveTemplates(settings["plans.specialty_templates"]).templates,
      idempotencyKey,
      requestHash: idempotencyKey ? invoiceRequestFingerprint({ patientId, currency: base, discountMinor, note, items }) : null,
      auditDetails: {
        ...(authority.discount ? { سبب_الخصم: authority.discount.reason, نسبة_الخصم: authority.discount.percent } : {}),
        ...(authority.overrides.length ? { أسعار_معدلة: formatPriceOverrides(authority.overrides) } : {}),
      },
    });
    if (!result.ok) {
      if (result.reason === "no_patient") return NextResponse.json({ message: "المريض غير موجود." }, { status: 404 });
      const prefix = result.line !== null ? `البند ${result.line + 1}: ` : "";
      const status = linkageRefusalStatus(result.reason);
      return NextResponse.json({ message: prefix + INVOICE_LINKAGE_MESSAGE[result.reason] }, { status });
    }
    return NextResponse.json(
      { ...result.invoice, clinical: { planId: result.planId, links: result.links }, replayed: result.replayed },
      { status: result.replayed ? 200 : 201 },
    );
  } catch {
    return NextResponse.json({ message: "تعذّر إنشاء الفاتورة. أعد المحاولة." }, { status: 500 });
  }
}
