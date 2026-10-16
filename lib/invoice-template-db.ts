/** Transaction-owned authority for template invoices. No process settings cache or second connection. */
import { getSettingsInTransaction, type DbClient, type Service } from "./db";
import type { LinkedInvoiceLineInput } from "./invoice-linkage-db";
import { invoiceCommandFingerprint, invoiceTemplateRequestFingerprint, parseInvoiceCommand, hasInvoiceCatalogQuote, invoiceCatalogRequestFingerprint } from "./invoice-template";
import { checkInvoiceAuthority } from "./invoice-pricing";
import { foreignRatesFromSettings } from "./service-pricing";
import type { SessionPayload } from "./auth";
import { revalidateSessionInTransaction } from "./session";
import { canHandleMoney } from "./roles";
import { invoicePricingAudit } from "./invoice-price-settings-db";

export type InvoiceTemplateAuthority = { source: Record<string, unknown>; fingerprint: string; session: SessionPayload };
export class InvoiceTemplateAuthorizationError extends Error {
  readonly code = "INVOICE_SESSION_REVOKED";
  constructor() { super("انتهت صلاحية الجلسة أثناء انتظار الطلب؛ سجّل الدخول قبل استعادة نتيجته."); }
}
/** Only an already admitted signed payload from the route, never client JSON. */
export async function assertInvoiceTemplateSession(client: DbClient, session: SessionPayload | undefined,
  actor: { createdBy: string; actorRole: string | null }): Promise<void> {
  if (!session) throw new InvoiceTemplateAuthorizationError();
  const current = await revalidateSessionInTransaction(session, client);
  if (!current || !canHandleMoney(current.role) || current.username !== actor.createdBy || current.role !== actor.actorRole) throw new InvoiceTemplateAuthorizationError();
}
export class InvoiceTemplateAuthorityError extends Error {
  readonly code = "INVOICE_TEMPLATE_STALE";
  constructor() { super("تغيّر القالب أو دليل الخدمات أو مصدر السعر أو سعر الصرف أو صلاحية السعر أثناء الحفظ؛ حدّث الأسعار والمعاينة قبل المحاولة مجددًا."); }
}
export class InvoiceTemplateBusyError extends Error {
  readonly code = "INVOICE_TEMPLATE_BUSY";
  constructor() { super("دليل الخدمات قيد التعديل الآن؛ احتفظ بالطلب نفسه وأعد المحاولة بعد انتهاء التعديل."); }
}

function itemsFingerprint(items: readonly LinkedInvoiceLineInput[]): string {
  return JSON.stringify(items.map((item) => [item.serviceId, item.category, item.doctorId, item.description,
    item.quantity, item.unitPriceMinor, item.toothCode, item.caseId, item.planItemId ?? null, item.sessions,
    item.surfaces ?? null, item.episodeTeeth ?? null, item.scope ?? null,
    item.templatePlan ? [item.templatePlan.templateId, item.templatePlan.version, item.templatePlan.stepKey,
      item.templatePlan.billingRule, item.templatePlan.sessionPlan.map((session) =>
        [session.title, session.minutes, session.afterDays, session.visitKey, session.visitTitle])] : null,
  ]));
}

/** Call after patient/replay handling, before any invoice/plan writes; caller owns transaction lifetime. */
export async function validateInvoiceTemplateInTransaction(client: DbClient, input: {
  templateAuthority?: InvoiceTemplateAuthority; catalogueAuthority?: InvoiceTemplateAuthority; items: LinkedInvoiceLineInput[]; actorRole: string | null;
  idempotencyKey: string | null; requestHash: string | null;
  patientId: number;visitId?:number; baseCurrency: string; existingPlanId?: number | null; discountMinor: number; note: string | null;
  createdBy: string; auditDetails?: Record<string, unknown>;
}): Promise<void> {
  const usesTemplate = input.items.some((item) => item.templatePlan !== undefined);
  if (!usesTemplate && !input.catalogueAuthority) {
    if (input.templateAuthority) throw new InvoiceTemplateAuthorityError();
    return;
  }
  const authority = usesTemplate ? input.templateAuthority : input.catalogueAuthority;
  if (!authority?.session) throw new InvoiceTemplateAuthorizationError();
  if (usesTemplate && (input.idempotencyKey === null || input.requestHash !== invoiceTemplateRequestFingerprint(authority.source,
    { username: input.createdBy, role: input.actorRole ?? "", userId: authority.session.userId ?? null }))) throw new InvoiceTemplateAuthorityError();
  if (!usesTemplate && input.idempotencyKey !== null && hasInvoiceCatalogQuote(authority.source)
    && input.requestHash !== invoiceCatalogRequestFingerprint(authority.source,
      { username: input.createdBy, role: input.actorRole ?? "", userId: authority.session.userId ?? null })) throw new InvoiceTemplateAuthorityError();
  // SHARE settings covers missing/default keys too. Template service references
  // are explicit, so new catalogue inserts cannot change the selected services.
  // This path performs only same-client DB work and synchronous validation under
  // the locks; no network, schema initialization, cache access or new transaction.
  await client.query("LOCK TABLE settings IN SHARE MODE");
  const settings = await getSettingsInTransaction(client, { requireStoredExchangeRates: true });
  const serviceIds = [...new Set(input.items.flatMap((item) => item.serviceId === null ? [] : [item.serviceId]))].sort((a, b) => a - b);
  type CatalogRow = {
    id: number; name: string; category: string | null; price_minor: string;
    is_active: boolean; sort_order: number; price_configured: boolean; price_provisional: boolean;
    price_sar_minor: string | null; price_usd_minor: string | null;
  };
  let rows: CatalogRow[];
  try {
    ({ rows } = await client.query<CatalogRow>(`SELECT id, name, category, price_minor, is_active, sort_order, price_configured, price_provisional,
      price_sar_minor, price_usd_minor FROM services WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE NOWAIT`, [serviceIds]));
  } catch (error) {
    // Existing batch writers lock rows in caller order. Never wait while holding
    // a partial shared row set: fail closed and let the outer transaction roll back.
    if ((error as { code?: string }).code === "55P03") throw new InvoiceTemplateBusyError();
    throw error;
  }
  await assertInvoiceTemplateSession(client, authority.session, input);
  const minor = (value: string): number => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw new InvoiceTemplateAuthorityError();
    return number;
  };
  const services = new Map<number, Service>(rows.map((row) => [row.id, {
    id: row.id, name: row.name, category: row.category, priceMinor: minor(row.price_minor),
    isActive: row.is_active, sortOrder: row.sort_order, priceConfigured: Boolean(row.price_configured),
    priceProvisional: Boolean(row.price_provisional), priceSarMinor: row.price_sar_minor === null ? null : minor(row.price_sar_minor),
    priceUsdMinor: row.price_usd_minor === null ? null : minor(row.price_usd_minor),
  }]));
  const { rows: doctors } = await client.query<{ id: number }>("SELECT id FROM parties WHERE kind = 'doctor'");
  const current = parseInvoiceCommand(authority.source, services, new Set(doctors.map((doctor) => doctor.id)), settings, true);
  if (!current.ok || Boolean(current.template) !== usesTemplate || invoiceCommandFingerprint(current) !== authority.fingerprint
    || current.patientId !== input.patientId || current.baseCurrency !== input.baseCurrency
    || current.existingPlanId !== (input.existingPlanId ?? null) || (current.visitId??null)!==(input.visitId??null) || current.discountMinor !== input.discountMinor
    || current.note !== input.note || current.idempotencyKey !== input.idempotencyKey
    || itemsFingerprint(current.items) !== itemsFingerprint(input.items)) throw new InvoiceTemplateAuthorityError();
  const pricing = checkInvoiceAuthority({ requireInvoiceManualReason:true,
    lines: current.authorityLines, currency: current.baseCurrency, rates: foreignRatesFromSettings(settings),
    role: input.actorRole ?? "", maxDiscountPercent: Number(settings["billing.max_discount_percent"]),
    totalMinor: current.items.reduce((sum, item) => sum + item.quantity * item.unitPriceMinor, 0),
    discountMinor: current.discountMinor,
    discountReason: typeof authority.source.discountReason === "string" ? authority.source.discountReason : null,
  });
  if (!pricing.ok) throw new InvoiceTemplateAuthorityError();
  if (input.auditDetails) input.auditDetails.invoicePriceSnapshots = invoicePricingAudit(current.pricingSnapshots);
}
