import "server-only";
import { doctorOwnsPatient, getInvoice, getPool, getSettingsInTransaction, listServicesWith, patientInDoctorScopeWith, type DbClient } from "./db";
import { canonicalDebtActor, invoiceDebtRepaymentReceipt } from "./debt-installments-db";
import { INVOICE_IDEMPOTENCY_PATTERN, INVOICE_LINKAGE_MESSAGE, linkageRefusalStatus, type InvoiceLinkageRefusal } from "./invoice-clinical-linkage";
import { createLinkedInvoiceInTransaction, invoicePlanChoices, InvoiceLinkageError, previewInvoiceLinkage, recoverLinkedInvoiceOn } from "./invoice-linkage-db";
import { checkInvoiceAuthority, formatPriceOverrides } from "./invoice-pricing";
import { hasInvoiceCatalogQuote, hasInvoiceLabWork, invoiceCatalogRequestFingerprint, invoiceCommandFingerprint, invoiceTemplateRequestFingerprint, parseInvoiceCommand } from "./invoice-template";
import { canonicalInvoiceActor, type InvoiceActorGrants } from "./invoice-template-db";
import { canonicalLabActor, labWorkIntentSupported, readLabWorkForPlanItems } from "./lab-work-intent-db";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { foreignRatesFromSettings } from "./service-pricing";
import { effectiveTemplates } from "./specialty-templates";
import { staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation, type StaffOperationHandle } from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * Creating an invoice on the canonical runtime (M2 slice 93b; owner decisions G4-1, G4-8;
 * the contract is section 7 of docs/review/financial-group4-contract-design-20261104.md).
 *  - `finance.invoices.create`; lab-work lines also `clinical.visits.document`; repayment terms
 *    also `finance.payments.collect` (they create a debt arrangement). A read grant never writes.
 *  - the price controls by grants (`checkInvoiceAuthority` with `grants`), re-checked inside the
 *    transaction under the catalogue locks by the same grants (the branded invoice actor).
 *  - one admitted operation on the legacy writer (`createLinkedInvoiceInTransaction`): its locks,
 *    key, fingerprints, catalogue/template revalidation, lab-work and repayment writers and
 *    `invoice.create` audit unchanged; the lost-acknowledgement recovery first, as legacy.
 *  - the patient scope decided right after the writer's patient row lock (`admit`, an ownership
 *    witness FOR SHARE NOWAIT for `own`), after an early unlocked look; outside = missing 404.
 */
export class CanonicalInvoiceCreateRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409, message: string) { super(message); this.name = "CanonicalInvoiceCreateRefusal"; }
}
const PATIENT_MISSING = "المريض غير موجود.";
const linkageRefusal = (reason: InvoiceLinkageRefusal | "no_patient", line: number | null) => reason === "no_patient"
  ? new CanonicalInvoiceCreateRefusal("patient_not_found", 404, PATIENT_MISSING)
  : new CanonicalInvoiceCreateRefusal(reason, linkageRefusalStatus(reason), (line !== null ? `البند ${line + 1}: ` : "") + INVOICE_LINKAGE_MESSAGE[reason]);

const PRICE = ["finance.discounts.apply", "finance.discounts.override", "finance.price-increases.apply"] as const;
async function invoiceGrants(client: DbClient, handle: StaffOperationHandle): Promise<InvoiceActorGrants & { collect: boolean }> {
  const held = await staffOperationCapabilities(client, handle, "finance.invoices.create",
    ["finance.invoices.create", "clinical.visits.document", "finance.payments.collect", ...PRICE] as const);
  return { create: held.has("finance.invoices.create"), labWork: held.has("clinical.visits.document"), collect: held.has("finance.payments.collect"),
    price: { discount: held.has("finance.discounts.apply"), discountOverride: held.has("finance.discounts.override"), increase: held.has("finance.price-increases.apply") } };
}

function patientAdmission(client: DbClient, handle: StaffOperationHandle, patientId: number) {
  return async () => {
    const scope = await staffOperationPatientScope(client, handle, "finance.invoices.create");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if (scope.kind === "all") return;
    let inside: boolean;
    try { inside = await doctorOwnsPatient(scope.clinicianPartyId, patientId, client, "nowait"); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "55P03") {
        throw new CanonicalInvoiceCreateRefusal("patient_scope_conflict", 409, "تعذّر تثبيت نطاق المريض. احتفظ بالطلب نفسه وأعد المحاولة.");
      }
      throw error;
    }
    if (!inside) throw new CanonicalInvoiceCreateRefusal("patient_not_found", 404, PATIENT_MISSING);
  };
}

export async function commandCanonicalInvoiceCreate(session: VerifiedDurableSession, body: unknown, pool = getPool()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CanonicalInvoiceCreateRefusal("invalid_invoice_input", 400, "طلب غير صالح.");
  const source = body as Record<string, unknown>;
  return withStaffOperation(pool, session, "finance.invoices.create", async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, "finance.invoices.create");
    const grants = await invoiceGrants(client, handle);
    if (hasInvoiceLabWork(source) && !grants.labWork) throw new CanonicalInvoiceCreateRefusal("lab_work_not_allowed", 403, "وصفة المختبر السريرية تحتاج صلاحية توثيق الزيارة.");
    const repayment = Object.hasOwn(source, "repaymentTerms");
    if (repayment && !grants.collect) throw new CanonicalInvoiceCreateRefusal("repayment_not_allowed", 403, "طريقة السداد تُنشئ ترتيب دين — تحتاج صلاحية التحصيل.");
    const patientId = Number(source.patientId);
    if (Number.isSafeInteger(patientId) && patientId > 0) {
      const early = await staffOperationPatientScope(client, handle, "finance.invoices.create");
      if (early.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      if (early.kind === "own" && !await patientInDoctorScopeWith(client, early.clinicianPartyId, patientId)) {
        throw new CanonicalInvoiceCreateRefusal("patient_not_found", 404, PATIENT_MISSING);
      }
    }
    const actor = canonicalInvoiceActor(identity, async current => {
      if (current !== client) throw new CanonicalInvoiceCreateRefusal("invalid_invoice_input", 403, "تغيّر اتصال العملية.");
      return invoiceGrants(current, handle);
    }, {
      lab: canonicalLabActor(identity),
      debt: grants.collect ? canonicalDebtActor(identity, async current => current === client && (await invoiceGrants(current, handle)).collect) : null,
    });
    const actorIdentity = { username: identity.username, role: identity.role, userId: identity.userId };
    const respond = async (written: { invoiceId: number; invoice?: unknown; planId: number | null; links: unknown; labWork?: unknown; visitId?: number }, replayed: boolean) => {
      const invoice = written.invoice ?? await getInvoice(written.invoiceId, client);
      return { ...(invoice as object), clinical: { planId: written.planId, links: written.links }, ...(written.labWork ? { labWork: written.labWork } : {}),
        ...(typeof source.visitId === "number" && written.visitId !== undefined ? { visitId: written.visitId } : {}),
        ...(repayment ? { repayment: await invoiceDebtRepaymentReceipt(patientId, written.invoiceId, client) } : {}), replayed };
    };
    const admit = patientAdmission(client, handle, patientId);

    // A lost acknowledgement stays recoverable after a catalogue or template edit (legacy order).
    const templateIntent = source.templateSelection !== null && typeof source.templateSelection === "object" && !Array.isArray(source.templateSelection);
    const catalogIntent = hasInvoiceCatalogQuote(source);
    if ((templateIntent || catalogIntent) && typeof source.idempotencyKey === "string" && INVOICE_IDEMPOTENCY_PATTERN.test(source.idempotencyKey.trim())
      && Number.isSafeInteger(patientId) && patientId > 0) {
      let recovered;
      try {
        recovered = await recoverLinkedInvoiceOn(client, { patientId, idempotencyKey: source.idempotencyKey.trim(),
          requestHash: templateIntent ? invoiceTemplateRequestFingerprint(source, actorIdentity) : invoiceCatalogRequestFingerprint(source, actorIdentity),
          createdBy: identity.username, session: actor, ...(typeof source.visitId === "number" ? { visitId: source.visitId } : {}) }, admit);
      } catch (error) {
        if (error instanceof InvoiceLinkageError) throw linkageRefusal(error.reason, error.line);
        throw error;
      }
      if (recovered && !recovered.ok) throw linkageRefusal(recovered.reason, recovered.line);
      if (recovered?.ok) return respond({ invoiceId: recovered.invoice.id, invoice: recovered.invoice, planId: recovered.planId, links: recovered.links,
        ...(recovered.labWork ? { labWork: recovered.labWork } : {}), ...(recovered.visitId !== undefined ? { visitId: recovered.visitId } : {}) }, true);
    }

    const services = new Map((await listServicesWith(client, true)).map(service => [service.id, service]));
    const doctors = new Set((await client.query<{ id: number }>("SELECT id FROM parties WHERE kind = 'doctor'")).rows.map(row => row.id));
    const settings = await getSettingsInTransaction(client, { requireStoredExchangeRates: true });
    const parsed = parseInvoiceCommand(source, services, doctors, settings, true);
    if (!parsed.ok) throw new CanonicalInvoiceCreateRefusal(parsed.code ?? "invalid_invoice_input", (parsed.status ?? 400) as 400 | 409, parsed.message);
    const authority = checkInvoiceAuthority({ requireInvoiceManualReason: true, lines: parsed.authorityLines, currency: parsed.baseCurrency,
      rates: foreignRatesFromSettings(settings), role: identity.role, grants: grants.price, maxDiscountPercent: Number(settings["billing.max_discount_percent"]),
      totalMinor: parsed.items.reduce((sum, item) => sum + item.quantity * item.unitPriceMinor, 0), discountMinor: parsed.discountMinor,
      discountReason: typeof source.discountReason === "string" ? source.discountReason : null });
    if (!authority.ok) throw new CanonicalInvoiceCreateRefusal("price_authority", 400, authority.message);
    const fingerprint = invoiceCommandFingerprint(parsed);
    try {
      const written = await createLinkedInvoiceInTransaction(client, {
        patientId: parsed.patientId, ...(parsed.visitId !== undefined ? { visitId: parsed.visitId } : {}), baseCurrency: parsed.baseCurrency,
        existingPlanId: parsed.existingPlanId, discountMinor: parsed.discountMinor, note: parsed.note, createdBy: identity.username, actorRole: identity.role,
        items: parsed.items, ...(parsed.labRetirements !== undefined ? { labRetirements: parsed.labRetirements } : {}),
        templates: effectiveTemplates(settings["plans.specialty_templates"]).templates, idempotencyKey: parsed.idempotencyKey,
        ...(parsed.template ? { templateAuthority: { source, fingerprint, session: actor } } : { catalogueAuthority: { source, fingerprint, session: actor } }),
        requestHash: parsed.idempotencyKey ? parsed.template ? invoiceTemplateRequestFingerprint(source, actorIdentity)
          : catalogIntent ? invoiceCatalogRequestFingerprint(source, actorIdentity) : fingerprint : null,
        auditDetails: {
          ...(parsed.template ? { قالب_العلاج: parsed.template.templateId, نسخة_القالب: parsed.template.version } : {}),
          ...(authority.discount ? { سبب_الخصم: authority.discount.reason, نسبة_الخصم: authority.discount.percent } : {}),
          ...(authority.overrides.length ? { أسعار_معدلة: formatPriceOverrides(authority.overrides) } : {}),
        },
        admit,
      });
      return respond(written, written.replayed);
    } catch (error) {
      if (error instanceof InvoiceLinkageError) throw linkageRefusal(error.reason, error.line);
      if ((error as { code?: string; constraint?: string }).code === "23505" && (error as { constraint?: string }).constraint === "invoices_idempotency_key_uniq") {
        throw linkageRefusal("idempotency_conflict", null);
      }
      throw error;
    }
  });
}

/** `POST /api/invoices/clinical-preview` on the canonical runtime (M2 slice 93b): read only, one
 * snapshot, `finance.invoices.create` inside the patient scope (outside = missing 404); lab work
 * by `clinical.visits.document`; the creation parser and the price controls by the same grants,
 * so the preview never promises a price the save would refuse. The legacy body. */
export async function readCanonicalInvoicePreview(session: VerifiedDurableSession, body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CanonicalInvoiceCreateRefusal("invalid_invoice_input", 400, "طلب غير صالح.");
  const source = body as Record<string, unknown>;
  return runCanonicalReadSnapshot(session, "read:invoices.preview", async (query, scope) => {
    const client = query as DbClient;
    const has = (capability: Parameters<typeof scope.granted>[0]) => scope.isProtectedOwner() || scope.granted(capability);
    const patientScope = scope.patientScope;
    const patientId = Number(source.patientId);
    if (patientScope.kind === "none") throw new CanonicalInvoiceCreateRefusal("patient_not_found", 404, PATIENT_MISSING);
    if (Number.isSafeInteger(patientId) && patientId > 0 && patientScope.kind === "own"
      && !await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, patientId)) throw new CanonicalInvoiceCreateRefusal("patient_not_found", 404, PATIENT_MISSING);
    if (hasInvoiceLabWork(source) && !has("clinical.visits.document")) throw new CanonicalInvoiceCreateRefusal("lab_work_not_allowed", 403, "وصفة المختبر السريرية تحتاج صلاحية توثيق الزيارة.");
    const services = new Map((await listServicesWith(client, true)).map(service => [service.id, service]));
    const doctors = new Set((await client.query<{ id: number }>("SELECT id FROM parties WHERE kind = 'doctor'")).rows.map(row => row.id));
    const settings = await getSettingsInTransaction(client, { requireStoredExchangeRates: true });
    const parsed = parseInvoiceCommand(source, services, doctors, settings, false);
    if (!parsed.ok) throw new CanonicalInvoiceCreateRefusal(parsed.code ?? "invalid_invoice_input", (parsed.status ?? 400) as 400 | 409, parsed.message);
    if (parsed.patientId !== patientId) throw new CanonicalInvoiceCreateRefusal("invalid_invoice_input", 400, "طلب غير صالح.");
    const authority = checkInvoiceAuthority({ requireInvoiceManualReason: true, lines: parsed.authorityLines, currency: parsed.baseCurrency,
      rates: foreignRatesFromSettings(settings), role: "", grants: { discount: has("finance.discounts.apply"), discountOverride: has("finance.discounts.override"),
        increase: has("finance.price-increases.apply") }, maxDiscountPercent: Number(settings["billing.max_discount_percent"]),
      totalMinor: parsed.items.reduce((sum, item) => sum + item.quantity * item.unitPriceMinor, 0), discountMinor: parsed.discountMinor,
      discountReason: typeof source.discountReason === "string" ? source.discountReason : null });
    if (!authority.ok) throw new CanonicalInvoiceCreateRefusal("price_authority", 400, authority.message);
    const lines = await previewInvoiceLinkage({ patientId: parsed.patientId, baseCurrency: parsed.baseCurrency, existingPlanId: parsed.existingPlanId, items: parsed.items }, client);
    const planChoices = await invoicePlanChoices(client, parsed.patientId, parsed.baseCurrency);
    const supported = await labWorkIntentSupported(client);
    const labByPlan = supported ? await readLabWorkForPlanItems(client, parsed.patientId, parsed.items.flatMap(item => item.planItemId ? [item.planItemId] : [])) : new Map();
    return { labWorkIntentSupported: supported, template: parsed.template, existingPlanId: parsed.existingPlanId, planChoices, lines: lines.map((line, index) => ({ ...line,
      ...(parsed.items[index]?.planItemId && !line.refusal && line.item?.mode === "existing" && line.item.id === parsed.items[index].planItemId ? labByPlan.get(parsed.items[index].planItemId!) ?? {} : {}),
      refusalMessage: line.refusal ? INVOICE_LINKAGE_MESSAGE[line.refusal] : null,
    })) };
  }, { errorPrefix: "STAFF_READ", maxBytes: 2 * 1024 * 1024 });
}
