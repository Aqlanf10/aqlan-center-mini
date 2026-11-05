/** Transaction-owned authority for template invoices. No process settings cache or second connection. */
import { getSettingsInTransaction, type DbClient, type Service } from "./db";
import type { LabWorkRetirement } from "./lab-work-intent-contract";
import type { LinkedInvoiceLineInput } from "./invoice-linkage-db";
import { invoiceCommandFingerprint, invoiceTemplateRequestFingerprint, parseInvoiceCommand, hasInvoiceCatalogQuote, invoiceCatalogRequestFingerprint } from "./invoice-template";
import { checkInvoiceAuthority } from "./invoice-pricing";
import { foreignRatesFromSettings } from "./service-pricing";
import type { SessionPayload } from "./auth";
import type { PriceGrants } from "./price-authority";
import type { CanonicalLabActor, LabActorSource } from "./lab-work-intent-db";
import type { CanonicalDebtActor, DebtActorSource } from "./debt-installments-db";
import { revalidateSessionInTransaction } from "./session";
import { canHandleMoney } from "./roles";
import { invoicePricingAudit } from "./invoice-price-settings-db";

/**
 * The canonical actor of an invoice write (M2 slice 93b, owner decision G4-1). Minted only by
 * the canonical operation after it proved `finance.invoices.create` and the patient scope;
 * branded by a module-private symbol, so no JSON value passes as one. Wherever the legacy
 * writer revalidated its session, `recheck` re-proves the live operation on the same client
 * and returns the grants that decide there: the create grant, lab work
 * (`clinical.visits.document`) and the price controls. `lab` and `debt` are the slice-87 and
 * slice-91 actors for the writers this one calls (absent when their grant is not held).
 */
const CANONICAL_INVOICE_ACTOR = Symbol("canonical-invoice-actor");
export interface InvoiceActorGrants { readonly create: boolean; readonly labWork: boolean; readonly price: PriceGrants }
export interface CanonicalInvoiceActor {
  readonly [CANONICAL_INVOICE_ACTOR]: true; readonly userId: number; readonly username: string; readonly role: string;
  readonly recheck: (client: DbClient) => Promise<InvoiceActorGrants>;
  readonly lab: CanonicalLabActor | null; readonly debt: CanonicalDebtActor | null;
}
export type InvoiceActorSource = SessionPayload | CanonicalInvoiceActor;
export function canonicalInvoiceActor(identity: { userId: number; username: string; role: string },
  recheck: (client: DbClient) => Promise<InvoiceActorGrants>, related: { lab: CanonicalLabActor | null; debt: CanonicalDebtActor | null }): CanonicalInvoiceActor {
  return Object.freeze({ [CANONICAL_INVOICE_ACTOR]: true as const, userId: identity.userId, username: identity.username, role: identity.role,
    recheck, lab: related.lab, debt: related.debt });
}
export const isCanonicalInvoiceActor = (source: InvoiceActorSource | undefined): source is CanonicalInvoiceActor =>
  typeof source === "object" && source !== null && (source as Partial<CanonicalInvoiceActor>)[CANONICAL_INVOICE_ACTOR] === true;
/** The lab writer's actor for this invoice actor (a canonical actor without the lab grant has none). */
export function labActorOf(source: InvoiceActorSource): LabActorSource {
  if (!isCanonicalInvoiceActor(source)) return source;
  if (!source.lab) throw new InvoiceTemplateAuthorizationError();
  return source.lab;
}
/** The debt writer's actor for this invoice actor (a canonical actor without the collect grant has none). */
export function debtActorOf(source: InvoiceActorSource): DebtActorSource {
  if (!isCanonicalInvoiceActor(source)) return source;
  if (!source.debt) throw new InvoiceTemplateAuthorizationError();
  return source.debt;
}

export type InvoiceTemplateAuthority = { source: Record<string, unknown>; fingerprint: string; session: InvoiceActorSource };
export class InvoiceTemplateAuthorizationError extends Error {
  readonly code = "INVOICE_SESSION_REVOKED";
  constructor() { super("انتهت صلاحية الجلسة أثناء انتظار الطلب؛ سجّل الدخول قبل استعادة نتيجته."); }
}
/** Only an already admitted signed payload from the route, never client JSON. */
export async function assertInvoiceTemplateSession(client: DbClient, session: InvoiceActorSource | undefined,
  actor: { createdBy: string; actorRole: string | null }): Promise<void> {
  if (!session) throw new InvoiceTemplateAuthorizationError();
  if (isCanonicalInvoiceActor(session)) {
    if (!(await session.recheck(client)).create || session.username !== actor.createdBy || session.role !== actor.actorRole) throw new InvoiceTemplateAuthorizationError();
    return;
  }
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
    ...(item.labWork ? [{ labWork: item.labWork }] : []),
  ]));
}

/** Call after patient/replay handling, before any invoice/plan writes; caller owns transaction lifetime. */
export async function validateInvoiceTemplateInTransaction(client: DbClient, input: {
  templateAuthority?: InvoiceTemplateAuthority; catalogueAuthority?: InvoiceTemplateAuthority; items: LinkedInvoiceLineInput[]; actorRole: string | null;
  idempotencyKey: string | null; requestHash: string | null; labRetirements?: LabWorkRetirement[];
  patientId: number;visitId?:number; baseCurrency: string; existingPlanId?: number | null; discountMinor: number; note: string | null;
  createdBy: string; auditDetails?: Record<string, unknown>;
}): Promise<void> {
  if ((input.items.some(item=>item.labWork) || input.labRetirements !== undefined) && !input.templateAuthority && !input.catalogueAuthority) throw new InvoiceTemplateAuthorizationError();
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
  const canonicalGrants = isCanonicalInvoiceActor(authority.session) ? await authority.session.recheck(client) : null;
  if ((input.items.some(item=>item.labWork) || input.labRetirements !== undefined)
    && (canonicalGrants ? !canonicalGrants.labWork : authority.session.role !== "admin" && authority.session.role !== "doctor")) throw new InvoiceTemplateAuthorizationError();
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
    || JSON.stringify(current.labRetirements) !== JSON.stringify(input.labRetirements)
    || itemsFingerprint(current.items) !== itemsFingerprint(input.items)) throw new InvoiceTemplateAuthorityError();
  const pricing = checkInvoiceAuthority({ requireInvoiceManualReason:true,
    lines: current.authorityLines, currency: current.baseCurrency, rates: foreignRatesFromSettings(settings),
    role: input.actorRole ?? "", ...(canonicalGrants ? { grants: canonicalGrants.price } : {}), maxDiscountPercent: Number(settings["billing.max_discount_percent"]),
    totalMinor: current.items.reduce((sum, item) => sum + item.quantity * item.unitPriceMinor, 0),
    discountMinor: current.discountMinor,
    discountReason: typeof authority.source.discountReason === "string" ? authority.source.discountReason : null,
  });
  if (!pricing.ok) throw new InvoiceTemplateAuthorityError();
  if (input.auditDetails) input.auditDetails.invoicePriceSnapshots = invoicePricingAudit(current.pricingSnapshots);
}
