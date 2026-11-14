import "server-only";
import {
  addPlanItemOn, getPool, getServiceWith, getSettingsWith, insertAuditRow, recordPlanConsentOn, removePlanItemOn, schedulePlanInstallmentsOn,
  updatePlanItemOn, type DbClient,
} from "./db";
import { CanonicalPlanRefusal, lockedAdmission, PLAN_MISSING, planPatient } from "./canonical-plan-writes";
import { agreementPricedService, checkInvoiceAuthority, formatPriceOverrides, type InvoicePriceOverride } from "./invoice-pricing";
import { CLINIC_BASE_CURRENCY, isCurrency, parseAmount, type Currency } from "./money";
import type { BillingRule } from "./plans";
import { foreignRatesFromSettings } from "./service-pricing";
import { staffOperationCapabilities, staffOperationIdentity, withStaffOperation, type StaffOperationHandle } from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * Plan items and consent on the canonical runtime (M2 slice 94c; owner decisions G4-1, G4-8;
 * contract section 11). `clinical.plans.edit`; each legacy writer (`…On`) on the admitted
 * operation's transaction, the scope decided right after its patient and plan row locks; an item
 * price on an agreement-currency plan by the price grants (G4-1); the item audits in the same
 * transaction; the consent and its optional schedule in one operation, a schedule refusal
 * keeping the consent as legacy did.
 */
const ACTION = "clinical.plans.edit" as const;
const PRICE = ["finance.discounts.apply", "finance.discounts.override", "finance.price-increases.apply"] as const;

/** A legacy writer refusal rolls the operation back with the writer's own message. */
function guardRefusal(message: string): CanonicalPlanRefusal {
  return message === PLAN_MISSING ? new CanonicalPlanRefusal("plan_not_found", 404, PLAN_MISSING) : new CanonicalPlanRefusal("plan_refused", 409, message);
}

async function priceGrants(client: DbClient, handle: StaffOperationHandle) {
  const held = await staffOperationCapabilities(client, handle, ACTION, PRICE);
  return { discount: held.has("finance.discounts.apply"), discountOverride: held.has("finance.discounts.override"), increase: held.has("finance.price-increases.apply") };
}

export interface CanonicalPlanItemInput {
  serviceId: number; quantity: number; toothCode: number | null; surfaces: string | null; note: string | null;
  plannedVisitNumber?: number; billingRule: BillingRule; sessionCount?: number; doctorId: number | null;
  price: unknown; priceReason: string | null;
}

/** POST /api/plans/[id]/items. */
export async function commandCanonicalPlanItemAdd(session: VerifiedDurableSession, planId: number, input: CanonicalPlanItemInput, pool = getPool()) {
  return withStaffOperation(pool, session, ACTION, async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, ACTION);
    await planPatient(client, handle, ACTION, planId);
    const service = await getServiceWith(client, input.serviceId);
    if (!service) throw new CanonicalPlanRefusal("service_not_found", 404, "الخدمة غير موجودة في الدليل.");
    const { rows: [plan] } = await client.query<{ base_currency: string }>("SELECT base_currency FROM treatment_plans WHERE id = $1", [planId]);
    if (!plan) throw new CanonicalPlanRefusal("plan_not_found", 404, PLAN_MISSING);
    if (!isCurrency(plan.base_currency)) throw new Error("PLAN_CURRENCY_INTEGRITY");
    const planCurrency: Currency = plan.base_currency;
    let unitPriceMinor: number;
    let overrides: InvoicePriceOverride[] = [];
    if (planCurrency === CLINIC_BASE_CURRENCY) {
      unitPriceMinor = service.priceMinor;
    } else {
      if (input.price === undefined || input.price === null || String(input.price).trim() === "") {
        throw new CanonicalPlanRefusal("price_required", 400, `سعر البند بعملة الخطة (${planCurrency}) إلزامي — سعر الدليل بالعملة الأساسية لا يُنسخ إلى خطة بعملة اتفاق.`);
      }
      const explicit = parseAmount(String(input.price), planCurrency);
      if (explicit === null || explicit <= 0) throw new CanonicalPlanRefusal("price_invalid", 400, `اكتب سعرًا صحيحًا أكبر من صفر بعملة الخطة (${planCurrency}).`);
      unitPriceMinor = explicit;
      const settings = await getSettingsWith(client);
      const authority = checkInvoiceAuthority({
        lines: [{ description: service.name, service: agreementPricedService(service, planCurrency), requestedMinor: explicit, quantity: input.quantity, explicit: true, reason: input.priceReason }],
        currency: planCurrency, rates: foreignRatesFromSettings(settings), role: identity.role, grants: await priceGrants(client, handle),
        maxDiscountPercent: Number(settings["billing.max_discount_percent"]), totalMinor: explicit * input.quantity, discountMinor: 0, discountReason: null,
      });
      if (!authority.ok) throw new CanonicalPlanRefusal("price_authority", 400, authority.message);
      overrides = authority.overrides;
    }
    const result = await addPlanItemOn(client, {
      planId, serviceId: service.id, serviceName: service.name, category: service.category, toothCode: input.toothCode, surfaces: input.surfaces,
      quantity: input.quantity, unitPriceMinor, note: input.note, plannedVisitNumber: input.plannedVisitNumber, billingRule: input.billingRule,
      sessionCount: input.sessionCount, doctorId: input.doctorId,
    }, lockedAdmission(client, handle, ACTION, PLAN_MISSING));
    if (!result.ok) throw guardRefusal(result.message);
    // Both audits in the operation's transaction (legacy wrote them after its commit).
    await insertAuditRow(client, { action: "plan.item_add", entity: "treatment_plan", entityId: planId, entityLabel: service.name,
      details: { الخدمة: service.name, الكمية: input.quantity, سعر_الوحدة: unitPriceMinor, العملة: planCurrency }, actor: identity.username, actorRole: identity.role });
    if (overrides.length > 0) {
      await insertAuditRow(client, { action: "plan.price_override", entity: "treatment_plan", entityId: planId, entityLabel: service.name,
        details: { العملة: planCurrency, أسعار_معدلة: formatPriceOverrides(overrides) }, actor: identity.username, actorRole: identity.role });
    }
    return { totalMinor: result.totalMinor };
  });
}

export interface CanonicalPlanItemUpdate {
  itemId: number; plannedVisitNumber?: number; billingRule?: BillingRule; sessionCount?: number; doctorId?: number | null; note?: string | null;
}

/** PATCH /api/plans/[id]/items: the session layout of an item (not its price, quantity or status). */
export async function commandCanonicalPlanItemUpdate(session: VerifiedDurableSession, planId: number, input: CanonicalPlanItemUpdate, pool = getPool()) {
  return withStaffOperation(pool, session, ACTION, async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, ACTION);
    await planPatient(client, handle, ACTION, planId);
    const result = await updatePlanItemOn(client, { planId, ...input, actor: identity.username, actorRole: identity.role },
      lockedAdmission(client, handle, ACTION, PLAN_MISSING));
    if (!result.ok) throw guardRefusal(result.message);
    return { ok: true as const };
  });
}

/** DELETE /api/plans/[id]/items (before consent only, by the legacy guard). */
export async function commandCanonicalPlanItemRemove(session: VerifiedDurableSession, planId: number, itemId: number, pool = getPool()) {
  return withStaffOperation(pool, session, ACTION, async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, ACTION);
    await planPatient(client, handle, ACTION, planId);
    const result = await removePlanItemOn(client, planId, itemId, { actor: identity.username, actorRole: identity.role },
      lockedAdmission(client, handle, ACTION, PLAN_MISSING));
    if (!result.ok) throw guardRefusal(result.message);
    return { ok: true as const };
  });
}

export interface CanonicalPlanSchedule { count: number; everyDays: number; firstDueDate: string }

/** POST /api/plans/[id]/consent: the consent and its optional schedule in one operation. A
 * schedule refusal keeps the consent (legacy committed it first): the schedule runs under a
 * savepoint and only its own work is undone. */
export async function commandCanonicalPlanConsent(session: VerifiedDurableSession, planId: number, note: string | null, schedule: CanonicalPlanSchedule | null, pool = getPool()) {
  return withStaffOperation(pool, session, ACTION, async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, ACTION);
    await planPatient(client, handle, ACTION, planId);
    const admit = lockedAdmission(client, handle, ACTION, PLAN_MISSING);
    const consent = await recordPlanConsentOn(client, { planId, actor: identity.username, note }, admit);
    if (!consent.ok) throw guardRefusal(consent.message);
    if (!schedule) return { kind: "consented" as const, totalMinor: consent.totalMinor, installments: 0 };
    await client.query("SAVEPOINT plan_consent_schedule");
    const scheduled = await schedulePlanInstallmentsOn(client, { planId, ...schedule }, admit);
    if (!scheduled.ok) {
      await client.query("ROLLBACK TO SAVEPOINT plan_consent_schedule");
      return { kind: "schedule_refused" as const, message: `سُجّلت الموافقة، وتعذّرت الجدولة: ${scheduled.message}` };
    }
    await client.query("RELEASE SAVEPOINT plan_consent_schedule");
    return { kind: "consented" as const, totalMinor: consent.totalMinor, installments: scheduled.count };
  });
}
