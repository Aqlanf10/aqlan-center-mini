import "server-only";
import {
  CLINIC_TIME_ZONE, createLabPricingRuleWith, createLabServiceWith, deleteLabPricingRuleWith, deleteLabServiceWith, getLabServiceWith,
  getPool, insertAuditRow, listLabPricingRulesWith, listLabServicesWith, resolveLabOrderPriceWith, seedLabServicesCatalogWith,
  updateLabPricingRuleWith, updateLabServiceWith, type DbClient,
} from "./db";
import type { LabPricingRule, LabService, LabServiceCategory, LabToothScope } from "./lab";
import { isCurrency, parseAmount, type Currency } from "./money";
import { clinicDateString } from "./schedule";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationCapabilities, staffOperationIdentity, withStaffOperation, type StaffOperationHandle } from "./staff-operation-runtime";

/**
 * Canonical lab pricing and services-catalogue writes (M2 slice 70b).
 *
 * OWNER DECISION (2026-11-03, #483 comment 6615071565): lab cost prices are seen only
 * with `finance.cost-prices.view`; entering the lab module or holding clinical.lab.view
 * is not enough. Enforced in the server for every response that carries a price:
 * - GET /api/lab/pricing (list and `resolve`): clinical.lab.view AND
 *   finance.cost-prices.view, else refused (403) — never a list with prices blanked.
 * - Pricing writes (POST, PUT/DELETE /api/lab/pricing/[id]): the independent
 *   `finance.lab-prices.edit` (unchanged, no new grant); the response carries amounts only
 *   with finance.cost-prices.view, so an editor without it never reads a stored price back.
 *   One transaction each under an advisory lock on the (lab, service) pair: closing the
 *   previous rule and creating the new one commit together (the legacy route ran them as
 *   separate statements). Amounts are whole minor units; a currency change restates the
 *   amount (the legacy route reinterpreted the stored amount in the new currency); the
 *   effective dates are validated against the stored rule. The audit row (with amounts,
 *   for financial accountability) commits with the write.
 * - Services catalogue writes (POST incl. seed_defaults, PATCH/DELETE /api/lab/services/[id])
 *   under finance.lab-prices.edit (the map), audit with the write; delete keeps the legacy
 *   rule (a service with orders or pricing rules is deactivated). The catalogue has no prices.
 */
export class CanonicalLabPricingRefusal extends Error {
  constructor(readonly code: "invalid_lab_pricing" | "lab_pricing_not_found" | "lab_service_code_taken", readonly status: 400 | 404 | 409, message: string, readonly field?: string) {
    super(message);
    this.name = "CanonicalLabPricingRefusal";
  }
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const invalid = (message: string, field?: string) => new CanonicalLabPricingRefusal("invalid_lab_pricing", 400, message, field);
const notFound = (message = "قاعدة التسعير غير موجودة.") => new CanonicalLabPricingRefusal("lab_pricing_not_found", 404, message);

function positiveId(raw: unknown, field: string, message: string): number {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw invalid(message, field);
  return value;
}
function realDate(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !DATE.test(raw.trim())) throw invalid("تاريخ غير صالح (الصيغة: YYYY-MM-DD).", field);
  const value = raw.trim();
  if (new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw invalid("تاريخ غير صالح.", field);
  return value;
}
/** Whole minor units: `costMinor` as an integer, or `cost` as text in the rule's currency. */
function amount(body: Record<string, unknown>, currency: Currency): number {
  const value = body.costMinor !== undefined ? (typeof body.costMinor === "number" ? body.costMinor : NaN) : parseAmount(String(body.cost ?? ""), currency);
  if (value === null || !Number.isSafeInteger(value) || value < 0) throw invalid("يرجى إدخال مبلغ صالح للخدمة.", "cost");
  return value;
}

type RulePublic = Omit<LabPricingRule, "costMinor" | "costCurrency">;
function projectRule(rule: LabPricingRule, costs: boolean): LabPricingRule | RulePublic {
  if (costs) return rule;
  const { costMinor: _amount, costCurrency: _currency, ...rest } = rule;
  return rest;
}
async function seesCosts(client: DbClient, handle: StaffOperationHandle): Promise<boolean> {
  return (await staffOperationCapabilities(client, handle, "finance.lab-prices.edit", ["finance.cost-prices.view"] as const)).has("finance.cost-prices.view");
}
async function lockPair(client: DbClient, partyId: number, labServiceId: number) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('lab-pricing:' || $1::text || ':' || $2::text))", [partyId, labServiceId]);
}
async function ruleById(client: Pick<DbClient, "query">, id: number, partyId: number, labServiceId: number): Promise<LabPricingRule | null> {
  return (await listLabPricingRulesWith(client, partyId, labServiceId)).find(rule => rule.id === id) ?? null;
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function readCanonicalLabPricing(session: VerifiedDurableSession, params: URLSearchParams) {
  const partyId = params.get("partyId") ? positiveId(params.get("partyId"), "partyId", "المختبر غير صالح.") : undefined;
  const labServiceId = params.get("labServiceId") ? positiveId(params.get("labServiceId"), "labServiceId", "الخدمة غير صالحة.") : undefined;
  const resolve = params.get("resolve") === "1" || params.get("resolve") === "true";
  const date = params.get("date");
  return runCanonicalReadSnapshot(session, "clinical.lab.view", async (query, scope) => {
    // The owner's decision: a cost price needs its own capability, in the server.
    if (!scope.granted("finance.cost-prices.view")) throw new Error("STAFF_READ_CAPABILITY_DENIED");
    if (resolve && partyId && labServiceId) {
      const target = date && DATE.test(date) ? date : clinicDateString(new Date(), CLINIC_TIME_ZONE);
      return { resolved: await resolveLabOrderPriceWith(query, partyId, labServiceId, target) };
    }
    return { rules: await listLabPricingRulesWith(query, partyId, labServiceId) };
  }, { errorPrefix: "STAFF_READ", maxBytes: 1024 * 1024 });
}

// ─── Pricing writes ─────────────────────────────────────────────────────────

export async function commandCanonicalLabPricingCreate(session: VerifiedDurableSession, body: Record<string, unknown>, pool = getPool()) {
  const partyId = positiveId(body.partyId, "partyId", "يرجى اختيار المختبر أولًا.");
  const labServiceId = positiveId(body.labServiceId, "labServiceId", "يرجى اختيار خدمة المختبر من الدليل.");
  const costCurrency: Currency = body.costCurrency === undefined ? "YER" : isCurrency(body.costCurrency) ? body.costCurrency : (() => { throw invalid("العملة غير صالحة.", "costCurrency"); })();
  const costMinor = amount(body, costCurrency);
  const effectiveFrom = body.effectiveFrom === undefined ? clinicDateString(new Date(), CLINIC_TIME_ZONE) : realDate(body.effectiveFrom, "effectiveFrom");
  const effectiveTo = body.effectiveTo === undefined || body.effectiveTo === null || body.effectiveTo === "" ? null : realDate(body.effectiveTo, "effectiveTo");
  if (effectiveTo !== null && effectiveTo < effectiveFrom) throw invalid("تاريخ انتهاء السريان يجب ألا يسبق تاريخ التفعيل.", "effectiveTo");
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 300) : null;
  const closePrevious = body.closePreviousRule === true;
  return withStaffOperation(pool, session, "finance.lab-prices.edit", async (client, handle) => {
    await lockPair(client, partyId, labServiceId);
    const { rows: [lab] } = await client.query<{ name: string }>("SELECT name FROM parties WHERE id = $1 AND kind = 'lab' FOR SHARE", [partyId]);
    if (!lab) throw notFound("المختبر المحدد غير موجود.");
    const service = await getLabServiceWith(client, labServiceId);
    if (!service) throw notFound("خدمة المختبر المحددة غير موجودة في الدليل.");
    const identity = await staffOperationIdentity(client, handle, "finance.lab-prices.edit");
    // Closing the previous rule and creating the new one commit together.
    const closed = closePrevious ? (await client.query<{ id: number }>(
      `UPDATE lab_pricing_rules SET effective_to = ($3::date - INTERVAL '1 day')
        WHERE party_id = $1 AND lab_service_id = $2 AND effective_from < $3::date
          AND (effective_to IS NULL OR effective_to >= $3::date) RETURNING id`,
      [partyId, labServiceId, effectiveFrom])).rows.map(row => row.id) : [];
    const created = await createLabPricingRuleWith(client, { partyId, labServiceId, costMinor, costCurrency, effectiveFrom, effectiveTo, note, createdBy: identity.username });
    await insertAuditRow(client, {
      action: "lab_pricing.create", entity: "lab_pricing_rule", entityId: created.id,
      entityLabel: `${lab.name} — ${service.name}`,
      details: { id: created.id, partyId, labName: lab.name, labServiceId, serviceName: service.name, costMinor, costCurrency, effectiveFrom, effectiveTo, note, closedRules: closed },
      actor: identity.username, actorRole: identity.role,
    });
    return { rule: projectRule(created, await seesCosts(client, handle)), closedRules: closed };
  });
}

export async function commandCanonicalLabPricingUpdate(session: VerifiedDurableSession, rawId: string, body: Record<string, unknown>, pool = getPool()) {
  const id = positiveId(rawId, "id", "معرّف قاعدة التسعير غير صالح.");
  if (body.costCurrency !== undefined && body.cost === undefined && body.costMinor === undefined) {
    throw invalid("تغيير العملة يتطلب إعادة كتابة المبلغ بالعملة الجديدة.", "cost");
  }
  return withStaffOperation(pool, session, "finance.lab-prices.edit", async (client, handle) => {
    const { rows: [row] } = await client.query<{ party_id: number; lab_service_id: number; cost_currency: string; effective_from: string; effective_to: string | null }>(
      "SELECT party_id, lab_service_id, cost_currency, effective_from::text, effective_to::text FROM lab_pricing_rules WHERE id = $1", [id]);
    if (!row) throw notFound();
    await lockPair(client, row.party_id, row.lab_service_id);
    const before = await ruleById(client, id, row.party_id, row.lab_service_id);
    if (!before) throw notFound();
    await client.query("SELECT id FROM lab_pricing_rules WHERE id = $1 FOR UPDATE", [id]);
    const patch: Parameters<typeof updateLabPricingRuleWith>[2] = {};
    if (body.costCurrency !== undefined) {
      if (!isCurrency(body.costCurrency)) throw invalid("العملة غير صالحة.", "costCurrency");
      patch.costCurrency = body.costCurrency;
    }
    if (body.cost !== undefined || body.costMinor !== undefined) patch.costMinor = amount(body, (patch.costCurrency ?? row.cost_currency) as Currency);
    if (body.effectiveFrom !== undefined) patch.effectiveFrom = realDate(body.effectiveFrom, "effectiveFrom");
    if (body.effectiveTo !== undefined) patch.effectiveTo = body.effectiveTo === null || body.effectiveTo === "" ? null : realDate(body.effectiveTo, "effectiveTo");
    if (body.note !== undefined) patch.note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 300) : null;
    const from = patch.effectiveFrom ?? row.effective_from;
    const to = patch.effectiveTo !== undefined ? patch.effectiveTo : row.effective_to;
    if (to !== null && to < from) throw invalid("تاريخ انتهاء السريان يجب ألا يسبق تاريخ التفعيل.", "effectiveTo");
    const identity = await staffOperationIdentity(client, handle, "finance.lab-prices.edit");
    const updated = await updateLabPricingRuleWith(client, id, patch);
    if (!updated) throw notFound();
    await insertAuditRow(client, {
      action: "lab_pricing.update", entity: "lab_pricing_rule", entityId: id,
      entityLabel: `${updated.partyName ?? ""} — ${updated.serviceName ?? ""}`,
      details: { id, before: { costMinor: before.costMinor, costCurrency: before.costCurrency, effectiveFrom: before.effectiveFrom, effectiveTo: before.effectiveTo, note: before.note }, changes: patch },
      actor: identity.username, actorRole: identity.role,
    });
    return { rule: projectRule(updated, await seesCosts(client, handle)) };
  });
}

export async function commandCanonicalLabPricingDelete(session: VerifiedDurableSession, rawId: string, pool = getPool()) {
  const id = positiveId(rawId, "id", "معرّف قاعدة التسعير غير صالح.");
  return withStaffOperation(pool, session, "finance.lab-prices.edit", async (client, handle) => {
    const { rows: [row] } = await client.query<{ party_id: number; lab_service_id: number }>("SELECT party_id, lab_service_id FROM lab_pricing_rules WHERE id = $1", [id]);
    if (!row) throw notFound();
    await lockPair(client, row.party_id, row.lab_service_id);
    const before = await ruleById(client, id, row.party_id, row.lab_service_id);
    const identity = await staffOperationIdentity(client, handle, "finance.lab-prices.edit");
    if (!before || !await deleteLabPricingRuleWith(client, id)) throw notFound();
    await insertAuditRow(client, {
      action: "lab_pricing.delete", entity: "lab_pricing_rule", entityId: id,
      entityLabel: `${before.partyName ?? ""} — ${before.serviceName ?? ""}`,
      details: { id, partyId: before.partyId, labServiceId: before.labServiceId, costMinor: before.costMinor, costCurrency: before.costCurrency, effectiveFrom: before.effectiveFrom, effectiveTo: before.effectiveTo },
      actor: identity.username, actorRole: identity.role,
    });
    return { ok: true as const };
  });
}

// ─── Services catalogue writes ──────────────────────────────────────────────

const CATEGORIES: LabServiceCategory[] = ["prostho", "ortho", "implant", "restorative", "appliance", "other"];
const SCOPES: LabToothScope[] = ["single_tooth", "multi_teeth_bridge", "full_arch", "general"];
function serviceFields(body: Record<string, unknown>, creating: boolean) {
  const input: Partial<{ name: string; code: string | null; category: LabService["category"]; toothScope: LabService["toothScope"]; requiresShade: boolean;
    defaultDays: number; description: string | null; sortOrder: number; isActive: boolean }> = {};
  if (creating || body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 150) throw invalid("يرجى كتابة اسم خدمة المختبر (أقل من 150 حرف).", "name");
    input.name = name;
  }
  if (body.code !== undefined) input.code = typeof body.code === "string" && body.code.trim() ? body.code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 30) || null : null;
  if (body.category !== undefined) {
    if (!CATEGORIES.includes(body.category as LabServiceCategory)) throw invalid("تصنيف الخدمة غير صالح.", "category");
    input.category = body.category as LabServiceCategory;
  }
  if (body.toothScope !== undefined) {
    if (!SCOPES.includes(body.toothScope as LabToothScope)) throw invalid("نطاق الأسنان غير صالح.", "toothScope");
    input.toothScope = body.toothScope as LabToothScope;
  }
  if (body.requiresShade !== undefined) input.requiresShade = body.requiresShade !== false;
  if (body.defaultDays !== undefined) {
    const days = Number(body.defaultDays);
    if (!Number.isInteger(days) || days < 1 || days > 60) throw invalid("المدة الافتراضية بين يوم و60 يومًا.", "defaultDays");
    input.defaultDays = days;
  }
  if (body.description !== undefined) input.description = typeof body.description === "string" && body.description.trim() ? body.description.trim().slice(0, 500) : null;
  if (body.sortOrder !== undefined) {
    const sort = Number(body.sortOrder);
    if (!Number.isInteger(sort)) throw invalid("ترتيب العرض غير صالح.", "sortOrder");
    input.sortOrder = sort;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") throw invalid("حالة التفعيل غير صالحة.", "isActive");
    input.isActive = body.isActive;
  }
  return input;
}
const codeTaken = (error: unknown) => (error as { code?: string }).code === "23505"
  ? new CanonicalLabPricingRefusal("lab_service_code_taken", 409, "رمز الخدمة مستخدم مسبقًا، يرجى اختيار رمز فريد.", "code") : null;

export async function commandCanonicalLabServiceCreate(session: VerifiedDurableSession, body: Record<string, unknown>, pool = getPool()) {
  const seed = body.action === "seed_defaults";
  const input = seed ? null : serviceFields(body, true);
  try {
    return await withStaffOperation(pool, session, "finance.lab-prices.edit", async (client, handle) => {
      const identity = await staffOperationIdentity(client, handle, "finance.lab-prices.edit");
      if (seed) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('lab-services-seed'))");
        const result = await seedLabServicesCatalogWith(client);
        await insertAuditRow(client, { action: "lab_services.seed", entityLabel: `تحديث وبذر دليل خدمات المختبر القياسي (${result.count} خدمة)`,
          details: { count: result.count }, actor: identity.username, actorRole: identity.role });
        return { message: `تم تحديث وبذر دليل خدمات المختبر بنجاح (${result.count} خدمة).`, services: await listLabServicesWith(client, true) };
      }
      const created = await createLabServiceWith(client, { ...input!, name: input!.name! });
      await insertAuditRow(client, { action: "lab_service.create", entity: "lab_service", entityId: created.id, entityLabel: created.name,
        details: { id: created.id, name: created.name, code: created.code, category: created.category, toothScope: created.toothScope },
        actor: identity.username, actorRole: identity.role });
      return { service: created };
    });
  } catch (error) { throw codeTaken(error) ?? error; }
}

export async function commandCanonicalLabServiceUpdate(session: VerifiedDurableSession, rawId: string, body: Record<string, unknown>, pool = getPool()) {
  const id = positiveId(rawId, "id", "معرّف الخدمة غير صالح.");
  const input = serviceFields(body, false);
  try {
    return await withStaffOperation(pool, session, "finance.lab-prices.edit", async (client, handle) => {
      const { rows: [row] } = await client.query("SELECT id FROM lab_services WHERE id = $1 FOR UPDATE", [id]);
      if (!row) throw notFound("خدمة المختبر غير موجودة.");
      const identity = await staffOperationIdentity(client, handle, "finance.lab-prices.edit");
      const updated = await updateLabServiceWith(client, id, input);
      if (!updated) throw notFound("خدمة المختبر غير موجودة.");
      await insertAuditRow(client, { action: "lab_service.update", entity: "lab_service", entityId: id, entityLabel: updated.name,
        details: { id, changes: input }, actor: identity.username, actorRole: identity.role });
      return { service: updated };
    });
  } catch (error) { throw codeTaken(error) ?? error; }
}

export async function commandCanonicalLabServiceDelete(session: VerifiedDurableSession, rawId: string, pool = getPool()) {
  const id = positiveId(rawId, "id", "معرّف الخدمة غير صالح.");
  return withStaffOperation(pool, session, "finance.lab-prices.edit", async (client, handle) => {
    const { rows: [row] } = await client.query<{ name: string }>("SELECT name FROM lab_services WHERE id = $1 FOR UPDATE", [id]);
    if (!row) throw notFound("خدمة المختبر غير موجودة.");
    const identity = await staffOperationIdentity(client, handle, "finance.lab-prices.edit");
    const result = await deleteLabServiceWith(client, id);
    await insertAuditRow(client, { action: result.deactivated ? "lab_service.deactivate" : "lab_service.delete", entity: "lab_service", entityId: id, entityLabel: row.name,
      details: { id, deleted: result.deleted, deactivated: result.deactivated }, actor: identity.username, actorRole: identity.role });
    return result;
  });
}
