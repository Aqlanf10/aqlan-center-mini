import "server-only";
import {
  createServiceWith, fillProvisionalServicePricesOn, getPool, getServiceWith, getSettingsWith, insertAuditRow, listServicesWith,
  priceServiceBatchOn, updateServiceWith, type DbClient, type Service, type ServiceUpdateInput,
} from "./db";
import { SERVICE_AUDIT_FIELDS, auditChanges, auditSnapshot } from "./audit-diff";
import { invoicePriceQuote } from "./invoice-price-quote";
import { CLINIC_BASE_CURRENCY, parseAmount } from "./money";
import { provisionalFills } from "./provisionalPrices";
import { readForeignPrices } from "./service-foreign-prices";
import { catalogPricesByCurrency, foreignRatesFromSettings } from "./service-pricing";
import { readPriceBatch } from "./servicePricing";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationIdentity, withStaffOperation, type StaffOperationHandle } from "./staff-operation-runtime";

/**
 * Canonical service catalogue, prices and service materials (M2 slice 96; Group 4
 * contract section 15; owner decision G4-3, 6648682456).
 *
 * Reads (one owning snapshot each; role labels and `permissions.canViewServicePrices`
 * decide nothing):
 * - GET /api/services: `finance.service-prices.view`. Same body as legacy (services with
 *   `priceIn`); `invoiceQuotes` (the invoice FX snapshot quotes legacy gave the money labels)
 *   only with `finance.invoices.create` as well. Without the price grant: refused, never a
 *   list with prices blanked.
 * - GET /api/services?catalogue=1 (G4-3): the price-free clinical catalogue for
 *   `clinical.visits.document` — active services only, through an allowlist of
 *   `id, name, category, sortOrder`. No price, cost, configured/provisional flag or FX field;
 *   it grants no financial or price-editing authority.
 * - GET /api/service-materials: `finance.cost-prices.view` (the map).
 *
 * Writes (one admitted transaction each; the audit commits with the write):
 * - POST /api/services, PATCH /api/services/[id], POST /api/services/prices and
 *   POST /api/services/provisional under `finance.service-prices.edit` (the map; the catalogue
 *   dependency makes every editor a price viewer, so the legacy response bodies are kept).
 *   PATCH locks the service row before reading the audit's "before". The batch locks every
 *   named row in id order and audits the prices it actually replaced, read under that lock.
 *   The provisional fill computes its fills from the locked catalogue and audits only the rows
 *   it wrote. (Legacy read "before" prices outside the transaction and audited after commit.)
 * - POST and DELETE /api/service-materials under `settings.operational.edit`: the service and
 *   the item are held FOR SHARE while the link is written, so a link never lands on a service
 *   or item deactivated concurrently.
 */
export class CanonicalServiceRefusal extends Error {
  constructor(readonly code: "invalid_service" | "service_not_found" | "service_material_not_found" | "nothing_to_fill",
    readonly status: 400 | 404, message: string, readonly field?: string) {
    super(message);
    this.name = "CanonicalServiceRefusal";
  }
}
const invalid = (message: string, field?: string) => new CanonicalServiceRefusal("invalid_service", 400, message, field);
const EDIT = "finance.service-prices.edit" as const;
const MATERIALS = "settings.operational.edit" as const;
const MAX_BYTES = 2 * 1024 * 1024;
const QUOTE_CURRENCIES = ["YER", "SAR", "USD"] as const;

function positiveId(raw: unknown, message: string, field = "id"): number {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && /^[1-9][0-9]{0,9}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw invalid(message, field);
  return value;
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function readCanonicalServices(session: VerifiedDurableSession, params: URLSearchParams) {
  const includeInactive = params.get("all") === "1";
  return runCanonicalReadSnapshot(session, "finance.service-prices.view", async (query, scope) => {
    const services = await listServicesWith(query, includeInactive);
    const rates = foreignRatesFromSettings(await getSettingsWith(query));
    // Legacy: invoice quotes for the money labels only. Canonical: the invoice-creation grant.
    const quoteRates = scope.granted("finance.invoices.create")
      ? foreignRatesFromSettings(await getSettingsWith(query, { requireStoredExchangeRates: true })) : null;
    return services.map((service) => ({
      ...service,
      priceIn: catalogPricesByCurrency(service, rates),
      ...(quoteRates ? { invoiceQuotes: Object.fromEntries(QUOTE_CURRENCIES.map((currency) => [currency, invoicePriceQuote(service, currency, quoteRates)])) } : {}),
    }));
  }, { errorPrefix: "STAFF_READ", maxBytes: MAX_BYTES });
}

/** The price-free clinical catalogue (G4-3): an allowlist, never a stripped priced row. */
export interface ClinicalCatalogueService { id: number; name: string; category: string | null; sortOrder: number }
export async function readCanonicalServiceCatalogue(session: VerifiedDurableSession): Promise<ClinicalCatalogueService[]> {
  return runCanonicalReadSnapshot(session, "clinical.visits.document", async (query) =>
    (await listServicesWith(query, false)).map((service) => ({ id: service.id, name: service.name, category: service.category, sortOrder: service.sortOrder })),
  { errorPrefix: "STAFF_READ", maxBytes: MAX_BYTES });
}

export interface ServiceMaterialRow { id: number; serviceId: number; serviceName: string; itemId: number; itemName: string; unit: string; qtyPerUnit: number; note: string | null; createdBy: string }
export async function readCanonicalServiceMaterials(session: VerifiedDurableSession, params: URLSearchParams): Promise<ServiceMaterialRow[]> {
  const raw = Number(params.get("serviceId"));
  const serviceId = Number.isInteger(raw) && raw > 0 && raw <= 2147483647 ? raw : null;
  return runCanonicalReadSnapshot(session, "finance.cost-prices.view", async (query) => {
    const { rows } = await query.query<{ id: number; service_id: number; service_name: string; item_id: number; item_name: string; unit: string; qty_per_unit: string; note: string | null; created_by: string }>(
      `SELECT m.id, m.service_id, s.name AS service_name, m.item_id, i.name AS item_name, i.unit, m.qty_per_unit, m.note, m.created_by
         FROM service_materials m
         JOIN services s ON s.id = m.service_id
         JOIN inventory_items i ON i.id = m.item_id
        ${serviceId ? "WHERE m.service_id = $1" : ""}
        ORDER BY s.name, i.name`, serviceId ? [serviceId] : []);
    return rows.map((row) => ({ id: row.id, serviceId: row.service_id, serviceName: row.service_name, itemId: row.item_id, itemName: row.item_name,
      unit: row.unit, qtyPerUnit: Number(row.qty_per_unit), note: row.note, createdBy: row.created_by }));
  }, { errorPrefix: "STAFF_READ", maxBytes: MAX_BYTES });
}

// ─── Catalogue and price writes ─────────────────────────────────────────────

async function actor(client: DbClient, handle: StaffOperationHandle) {
  const identity = await staffOperationIdentity(client, handle, EDIT);
  return { actor: identity.username, actorRole: identity.role };
}

/** The legacy POST validation, unchanged (name, base-currency price, category, foreign prices). */
function createInput(body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 120) throw invalid("اكتب اسم الخدمة.", "name");
  const priceMinor = parseAmount(String(body.price ?? ""), CLINIC_BASE_CURRENCY);
  if (priceMinor === null) throw invalid("اكتب سعرًا صحيحًا.", "price");
  const category = typeof body.category === "string" && body.category.trim() ? body.category.trim().slice(0, 60) : null;
  const foreign = readForeignPrices(body);
  if (!foreign.ok) throw invalid(foreign.message);
  return { name, category, priceMinor, ...foreign.patch };
}

export async function commandCanonicalServiceCreate(session: VerifiedDurableSession, body: Record<string, unknown>, pool = getPool()): Promise<Service> {
  const input = createInput(body);
  return withStaffOperation(pool, session, EDIT, async (client, handle) => {
    const who = await actor(client, handle);
    const service = await createServiceWith(client, input);
    await insertAuditRow(client, {
      action: "service.create", entity: "service", entityId: service.id, entityLabel: service.name,
      details: auditSnapshot(service as unknown as Record<string, unknown>, SERVICE_AUDIT_FIELDS), ...who,
    });
    return service;
  });
}

/** The legacy PATCH validation, unchanged. */
function updateInput(body: Record<string, unknown>): ServiceUpdateInput {
  const patch: ServiceUpdateInput = {};
  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name || name.length > 120) throw invalid("اكتب اسم الخدمة.", "name");
    patch.name = name;
  }
  if (typeof body.category === "string") patch.category = body.category.trim().slice(0, 60) || null;
  if (body.price !== undefined) {
    const priceMinor = parseAmount(String(body.price), CLINIC_BASE_CURRENCY);
    if (priceMinor === null) throw invalid("اكتب سعرًا صحيحًا.", "price");
    patch.priceMinor = priceMinor;
  }
  if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
  const foreign = readForeignPrices(body);
  if (!foreign.ok) throw invalid(foreign.message);
  Object.assign(patch, foreign.patch);
  if (Object.keys(patch).length === 0) throw invalid("لا يوجد ما يُحدَّث.");
  return patch;
}

export async function commandCanonicalServiceUpdate(session: VerifiedDurableSession, rawId: string, body: Record<string, unknown>, pool = getPool()): Promise<Service> {
  const id = positiveId(rawId, "رقم الخدمة غير صالح.");
  const patch = updateInput(body);
  return withStaffOperation(pool, session, EDIT, async (client, handle) => {
    const { rows: [locked] } = await client.query<{ id: number }>("SELECT id FROM services WHERE id = $1 FOR UPDATE", [id]);
    if (!locked) throw new CanonicalServiceRefusal("service_not_found", 404, "الخدمة غير موجودة.");
    const before = await getServiceWith(client, id);
    const who = await actor(client, handle);
    const updated = await updateServiceWith(client, id, patch);
    if (!before || !updated) throw new CanonicalServiceRefusal("service_not_found", 404, "الخدمة غير موجودة.");
    const changes = auditChanges(before as unknown as Record<string, unknown>, updated as unknown as Record<string, unknown>, SERVICE_AUDIT_FIELDS);
    if (Object.keys(changes).length > 0) {
      await insertAuditRow(client, { action: "service.update", entity: "service", entityId: id, entityLabel: updated.name, details: changes, ...who });
    }
    return updated;
  });
}

export async function commandCanonicalServicePriceBatch(session: VerifiedDurableSession, body: Record<string, unknown>, pool = getPool()): Promise<{ updated: number }> {
  const entries = body.entries;
  if (!Array.isArray(entries)) throw invalid("لا أسعار في الطلب.", "entries");
  return withStaffOperation(pool, session, EDIT, async (client, handle) => {
    const names = new Map((await listServicesWith(client, true)).map((service) => [service.id, service.name]));
    const batch = readPriceBatch(entries, (input) => parseAmount(input, CLINIC_BASE_CURRENCY), (id) => names.get(id) ?? null);
    if (!batch.ok) throw invalid(batch.message, "entries");
    const result = await priceServiceBatchOn(client, batch.prices);
    if (!result.ok) throw invalid(result.message, "entries");
    const who = await actor(client, handle);
    const previous = new Map(result.previous.map((row) => [row.id, row]));
    await insertAuditRow(client, {
      action: "services.price_batch", entity: "services", entityId: 0, entityLabel: "تسعير دفعة واحدة",
      details: { عدد_الخدمات: batch.prices.length }, ...who,
    });
    await insertAuditRow(client, {
      action: "service.prices.batch", entity: "service", entityLabel: `${batch.prices.length} خدمة`,
      details: {
        الأسعار: batch.prices.map((price) => ({
          الخدمة: previous.get(price.id)?.name ?? null, رقم: price.id, قبل: previous.get(price.id)?.priceMinor ?? null, بعد: price.priceMinor,
        })),
      }, ...who,
    });
    return { updated: result.updated };
  });
}

export async function commandCanonicalServiceProvisional(session: VerifiedDurableSession, pool = getPool()): Promise<{ filled: number }> {
  return withStaffOperation(pool, session, EDIT, async (client, handle) => {
    // The whole catalogue locked in id order: the fills are computed from rows no price
    // decision can change before this transaction commits.
    await client.query("SELECT id FROM services ORDER BY id FOR UPDATE");
    const services = await listServicesWith(client, true);
    const fills = provisionalFills(services.map((service) => ({ id: service.id, category: service.category, priceConfigured: service.priceConfigured, isActive: service.isActive })));
    if (fills.length === 0) throw new CanonicalServiceRefusal("nothing_to_fill", 400, "لا خدمات نشطة بلا سعر تناسب التخميني — كل النشط مسعّر أصلًا.");
    const applied = await fillProvisionalServicePricesOn(client, fills);
    const who = await actor(client, handle);
    const nameOf = new Map(services.map((service) => [service.id, service.name]));
    await insertAuditRow(client, {
      action: "services.provisional", entity: "services", entityId: 0, entityLabel: "أسعار تخمينية موسومة",
      details: { عدد_الخدمات: applied.length }, ...who,
    });
    await insertAuditRow(client, {
      action: "service.prices.provisional", entity: "service", entityLabel: `${applied.length} خدمة`,
      details: { الأسعار: applied.map((fill) => ({ الخدمة: nameOf.get(fill.id) ?? null, رقم: fill.id, السعر: fill.priceMinor })) }, ...who,
    });
    return { filled: applied.length };
  });
}

// ─── Service materials writes ───────────────────────────────────────────────

export async function commandCanonicalServiceMaterialSet(session: VerifiedDurableSession, body: Record<string, unknown>, pool = getPool()): Promise<{ id: number }> {
  const serviceId = Number(body.serviceId);
  const itemId = Number(body.itemId);
  const qty = Number(body.qtyPerUnit);
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 200) : null;
  if (!Number.isInteger(serviceId) || serviceId <= 0 || serviceId > 2147483647) throw invalid("اختر الخدمة من الدليل.", "serviceId");
  if (!Number.isInteger(itemId) || itemId <= 0 || itemId > 2147483647) throw invalid("اختر المادة من المخزون.", "itemId");
  if (!Number.isFinite(qty) || qty <= 0) throw invalid("الكمية لكل وحدة يجب أن تكون أكبر من صفر.", "qtyPerUnit");
  return withStaffOperation(pool, session, MATERIALS, async (client, handle) => {
    // Both must be active, and stay so until the link commits.
    const { rows: [service] } = await client.query<{ id: number }>("SELECT id FROM services WHERE id = $1 AND is_active FOR SHARE", [serviceId]);
    if (!service) throw invalid("الخدمة غير موجودة أو موقوفة.", "serviceId");
    const { rows: [item] } = await client.query<{ id: number }>("SELECT id FROM inventory_items WHERE id = $1 AND is_active FOR SHARE", [itemId]);
    if (!item) throw invalid("المادة غير موجودة أو موقوفة.", "itemId");
    const identity = await staffOperationIdentity(client, handle, MATERIALS);
    const { rows: [link] } = await client.query<{ id: number }>(
      `INSERT INTO service_materials (service_id, item_id, qty_per_unit, note, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (service_id, item_id) DO UPDATE
         SET qty_per_unit = EXCLUDED.qty_per_unit, note = EXCLUDED.note
       RETURNING id`, [serviceId, itemId, qty, note, identity.username]);
    await insertAuditRow(client, {
      action: "service_material.set", entity: "service_materials", entityId: link.id,
      details: { الخدمة: serviceId, المادة: itemId, الكمية_للوحدة: qty, ...(note ? { الملاحظة: note } : {}) },
      actor: identity.username, actorRole: identity.role,
    });
    return { id: link.id };
  });
}

export async function commandCanonicalServiceMaterialRemove(session: VerifiedDurableSession, rawId: string | null, pool = getPool()): Promise<{ ok: true }> {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) throw invalid("رقم الربط غير صالح.", "id");
  return withStaffOperation(pool, session, MATERIALS, async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, MATERIALS);
    const { rows: [removed] } = await client.query<{ service_id: number; item_id: number; qty_per_unit: string }>(
      "DELETE FROM service_materials WHERE id = $1 RETURNING service_id, item_id, qty_per_unit::text", [id]);
    if (!removed) throw new CanonicalServiceRefusal("service_material_not_found", 404, "الربط غير موجود.");
    await insertAuditRow(client, {
      action: "service_material.remove", entity: "service_materials", entityId: id,
      details: { الخدمة: removed.service_id, المادة: removed.item_id, الكمية_للوحدة: removed.qty_per_unit },
      actor: identity.username, actorRole: identity.role,
    });
    return { ok: true as const };
  });
}
