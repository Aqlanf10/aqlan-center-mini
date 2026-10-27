import { LabWorkIntentError } from "@/lib/lab-work-intent-db";
import { hasInvoiceLabWork } from "@/lib/invoice-template";
import { invoicePricingSettings } from "@/lib/invoice-price-settings-db";
import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { listParties, listPatientInvoices, listServices } from "@/lib/db";
import { createLinkedInvoice, recoverLinkedInvoice } from "@/lib/invoice-linkage-db";
import {
  INVOICE_IDEMPOTENCY_PATTERN, INVOICE_LINKAGE_MESSAGE, linkageRefusalStatus,
} from "@/lib/invoice-clinical-linkage";
import { effectiveTemplates } from "@/lib/specialty-templates";
import { checkInvoiceAuthority, formatPriceOverrides } from "@/lib/invoice-pricing";
import { foreignRatesFromSettings } from "@/lib/service-pricing";
import { parseInvoiceCommand, invoiceCommandFingerprint, invoiceTemplateRequestFingerprint, hasInvoiceCatalogQuote, invoiceCatalogRequestFingerprint } from "@/lib/invoice-template";
import { InvoiceTemplateAuthorityError, InvoiceTemplateBusyError, InvoiceTemplateAuthorizationError } from "@/lib/invoice-template-db";
import { canHandleMoney, canViewMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { DebtRepaymentError, invoiceDebtRepaymentReceipt } from "@/lib/debt-installments-db";

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
  if (hasInvoiceLabWork(source) && session.role !== "admin" && session.role !== "doctor") return NextResponse.json({message:"وصفة المختبر السريرية للطبيب والإدارة فقط."},{status:403});
  const templateIntent = source && typeof source === "object" && !Array.isArray(source)
    && source.templateSelection !== null && typeof source.templateSelection === "object" && !Array.isArray(source.templateSelection);
  const catalogIntent = source && typeof source === "object" && !Array.isArray(source) && hasInvoiceCatalogQuote(source);

  // A lost acknowledgement must remain recoverable after a catalogue/template edit.
  // The stored versioned raw intent includes actor, patient and all submitted values.
  // This read-only path never treats a key alone, GET, or current expansion as proof.
  if ((templateIntent || catalogIntent)
    && typeof source.idempotencyKey === "string" && INVOICE_IDEMPOTENCY_PATTERN.test(source.idempotencyKey.trim())
    && Number.isInteger(Number(source.patientId)) && Number(source.patientId) > 0) {
    try {
      const recovered = await recoverLinkedInvoice({ patientId: Number(source.patientId), idempotencyKey: source.idempotencyKey.trim(),
        requestHash: templateIntent ? invoiceTemplateRequestFingerprint(source, session) : invoiceCatalogRequestFingerprint(source, session), createdBy: session.username, session,...(typeof source.visitId==="number"?{visitId:source.visitId}:{}) });
      if (recovered && !recovered.ok) return NextResponse.json({ code: recovered.reason,
        message: recovered.reason === "no_patient" ? "المريض غير موجود." : INVOICE_LINKAGE_MESSAGE[recovered.reason],
      }, { status: recovered.reason === "no_patient" ? 404 : linkageRefusalStatus(recovered.reason) });
      if (recovered?.ok) return NextResponse.json({ ...recovered.invoice, clinical: { planId: recovered.planId, links: recovered.links },...(recovered.labWork ? {labWork:recovered.labWork} : {}),
        ...(typeof source.visitId==="number"?{visitId:recovered.visitId}:{}),
        ...(Object.hasOwn(source,"repaymentTerms") ? {repayment:await invoiceDebtRepaymentReceipt(recovered.invoice.patientId,recovered.invoice.id)} : {}), replayed: true }, { status: 200 });
    } catch (error) {
      if (error instanceof InvoiceTemplateAuthorizationError) return NextResponse.json({ code: error.code, message: error.message }, { status: 401 });
      return NextResponse.json({ message: "تعذّر التحقق من نتيجة الطلب السابق؛ احتفظ بالمفتاح نفسه وأعد المحاولة." }, { status: 500 });
    }
  }

  const services = new Map((await listServices(true)).map((service) => [service.id, service]));
  const doctors = new Set((await listParties("doctor")).map((party) => party.id));
  const settings = await invoicePricingSettings();
  const parsed = parseInvoiceCommand(source, services, doctors, settings, true);
  if (!parsed.ok) return NextResponse.json({ message: parsed.message, ...(parsed.code ? { code: parsed.code } : {}) }, { status: parsed.status ?? 400 });
  const { patientId, baseCurrency: base, existingPlanId, items, authorityLines, discountMinor, note, idempotencyKey } = parsed;

  /* (FIN-4) حدّ الخصم نفسه الذي يحكم الزيارة: سعر خدمة الدليل المكتوب أقل، والخصم على
     الفاتورة — بسببٍ مكتوب، ولغير المدير حتى `billing.max_discount_percent`. */
  const authority = checkInvoiceAuthority({ requireInvoiceManualReason:true,
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
      patientId,...(parsed.visitId!==undefined?{visitId:parsed.visitId}:{}), baseCurrency: base, existingPlanId, discountMinor, note, createdBy: session.username, actorRole: session.role, items,...(parsed.labRetirements !== undefined ? {labRetirements:parsed.labRetirements} : {}),
      templates: effectiveTemplates(settings["plans.specialty_templates"]).templates,
      idempotencyKey,
      ...(parsed.template ? { templateAuthority: { source, fingerprint: invoiceCommandFingerprint(parsed), session } }
        : { catalogueAuthority: { source, fingerprint: invoiceCommandFingerprint(parsed), session } }),
      requestHash: idempotencyKey ? parsed.template ? invoiceTemplateRequestFingerprint(source, session)
        : catalogIntent ? invoiceCatalogRequestFingerprint(source, session) : invoiceCommandFingerprint(parsed) : null,
      auditDetails: {
        ...(parsed.template ? { قالب_العلاج: parsed.template.templateId, نسخة_القالب: parsed.template.version } : {}),
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
      { ...result.invoice, clinical: { planId: result.planId, links: result.links },...(result.labWork ? {labWork:result.labWork} : {}),...(result.visitId!==undefined?{visitId:result.visitId}:{}),
        ...(Object.hasOwn(source,"repaymentTerms") ? {repayment:await invoiceDebtRepaymentReceipt(patientId,result.invoice.id)} : {}), replayed: result.replayed },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (error) {
    if (error instanceof LabWorkIntentError) return NextResponse.json({code:error.code,message:error.message},{status:error.status});
    if (error instanceof DebtRepaymentError) return NextResponse.json({code:error.code,message:error.message},{status:error.code==="unauthorized"?401:error.code==="invalid"?400:409});
    if (error instanceof InvoiceTemplateAuthorizationError) return NextResponse.json({ code: error.code, message: error.message }, { status: 401 });
    if (error instanceof InvoiceTemplateAuthorityError || error instanceof InvoiceTemplateBusyError) return NextResponse.json({ code: error.code, message: error.message }, { status: 409 });
    return NextResponse.json({ message: "تعذّر إنشاء الفاتورة. أعد المحاولة." }, { status: 500 });
  }
}
