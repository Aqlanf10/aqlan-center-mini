/** M2 slice 96: the canonical service catalogue, prices and service materials on real
 * PostgreSQL, synthetic data only. Owner decision G4-3 (6648682456): a price-free clinical
 * catalogue for clinical.visits.document; prices only with finance.service-prices.view;
 * writes under finance.service-prices.edit / settings.operational.edit (the map), each with
 * its audit in the same transaction; role labels decide nothing. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolConfig } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { waitForBlockedBy } from "./_canonical-ready-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-services-2026-xyz");
const db = await import("../../lib/db");
const services = await import("../../lib/canonical-services");

const PRICES = { "finance.service-prices.view": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-SV6-OWNER", role: "admin" },
  // A legacy money label with no canonical grant: decides nothing.
  label: { username: "SYN-SV6-LABEL", role: "admin", grants: { "settings.view": true } },
  viewer: { username: "SYN-SV6-VIEW", role: "accountant", grants: { ...PRICES } },
  invoicer: { username: "SYN-SV6-INV", role: "reception", grants: { ...PRICES, "finance.invoices.create": true } },
  editor: { username: "SYN-SV6-EDIT", role: "reception", grants: { ...PRICES, "finance.service-prices.edit": true } },
  documenter: { username: "SYN-SV6-DOC", role: "doctor", grants: { "clinical.visits.document": true } },
  cost: { username: "SYN-SV6-COST", role: "accountant", grants: { "finance.cost-prices.view": true } },
  materials: { username: "SYN-SV6-MAT", role: "reception", grants: { "settings.view": true, "settings.operational.edit": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const params = (value: Record<string, string> = {}) => new URLSearchParams(value);
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; field?: string; message?: string }) => error);
const ctx = { priced: 0, unpriced: 0, inactive: 0, item: 0, inactiveItem: 0 };
const audits = async (action: string) => q("SELECT actor, details FROM audit_log WHERE action = $1 ORDER BY id", [action]);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  ctx.priced = (await q("INSERT INTO services(name,category,price_minor,price_configured,sort_order) VALUES('SYN SV6 cleaning','cleaning',9100,TRUE,9001) RETURNING id"))[0].id;
  ctx.unpriced = (await q("INSERT INTO services(name,category,price_minor,price_configured,sort_order) VALUES('SYN SV6 filling','filling',0,FALSE,9002) RETURNING id"))[0].id;
  ctx.inactive = (await q("INSERT INTO services(name,category,price_minor,price_configured,is_active,sort_order) VALUES('SYN SV6 retired','crown',7300,TRUE,FALSE,9003) RETURNING id"))[0].id;
  ctx.item = (await q("INSERT INTO inventory_items(name,unit,created_by) VALUES('SYN SV6 gloves','box','synthetic') RETURNING id"))[0].id;
  ctx.inactiveItem = (await q("INSERT INTO inventory_items(name,unit,is_active,created_by) VALUES('SYN SV6 old item','box',FALSE,'synthetic') RETURNING id"))[0].id;
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("reads: prices by grant, the price-free catalogue (G4-3)", () => {
  it("the price grant reads the priced list; invoice quotes only with finance.invoices.create; inactive only with all=1", async () => {
    const list = await services.readCanonicalServices(await fx.session("viewer"), params()) as { id: number; priceMinor: number; priceIn: unknown; invoiceQuotes?: unknown }[];
    const priced = list.find(row => row.id === ctx.priced)!;
    expect(priced).toMatchObject({ priceMinor: 9100, priceIn: { YER: expect.anything() } });
    expect(priced).not.toHaveProperty("invoiceQuotes");
    expect(list.some(row => row.id === ctx.inactive)).toBe(false);
    expect((await services.readCanonicalServices(await fx.session("viewer"), params({ all: "1" })) as { id: number }[]).some(row => row.id === ctx.inactive)).toBe(true);
    const quoted = (await services.readCanonicalServices(await fx.session("invoicer"), params()) as { id: number; invoiceQuotes?: Record<string, unknown> }[]).find(row => row.id === ctx.priced)!;
    expect(Object.keys(quoted.invoiceQuotes ?? {})).toEqual(["YER", "SAR", "USD"]);
  });
  it("without the price grant the priced list is refused — never blanked — for the documenter, the cost grant and a money label", async () => {
    for (const key of ["documenter", "cost", "label", "materials"] as const) {
      await expect(services.readCanonicalServices(await fx.session(key), params())).rejects.toThrow("CAPABILITY_DENIED");
    }
  });
  it("the documenter's catalogue is an allowlist of active services with no price, cost, flag or FX field", async () => {
    const catalogue = await services.readCanonicalServiceCatalogue(await fx.session("documenter"));
    const mine = catalogue.find(row => row.id === ctx.priced)!;
    expect(mine).toEqual({ id: ctx.priced, name: "SYN SV6 cleaning", category: "cleaning", sortOrder: 9001 });
    for (const row of catalogue) expect(Object.keys(row).sort()).toEqual(["category", "id", "name", "sortOrder"]);
    expect(catalogue.some(row => row.id === ctx.inactive)).toBe(false);
    const text = JSON.stringify(catalogue);
    expect(text).not.toMatch(/price|Price|cost|Quote|7300|9100/);
    // The catalogue is the clinical grant's, not a back door for the price grant or a label.
    for (const key of ["viewer", "label", "cost"] as const) {
      await expect(services.readCanonicalServiceCatalogue(await fx.session(key))).rejects.toThrow("CAPABILITY_DENIED");
    }
  });
  it("revoking the price grant refuses a session issued before the revocation", async () => {
    const issued = await fx.session("viewer");
    expect(Array.isArray(await services.readCanonicalServices(issued, params()))).toBe(true);
    await fx.setGrants("viewer", { "settings.view": true });
    try {
      await expect(services.readCanonicalServices(issued, params())).rejects.toThrow(/CREDENTIAL_OR_ACCOUNT/);
      await expect(services.readCanonicalServices(await fx.session("viewer"), params())).rejects.toThrow("CAPABILITY_DENIED");
    } finally { await fx.setGrants("viewer", { ...PRICES }); }
  });
});

describe("catalogue and price writes (finance.service-prices.edit)", () => {
  it("create and update audit by the actor in the same transaction; read grants, labels and the documenter never write", async () => {
    const editor = await fx.session("editor");
    const created = await services.commandCanonicalServiceCreate(editor, { name: "SYN SV6 scaling", category: "perio", price: "15000" });
    expect(created).toMatchObject({ name: "SYN SV6 scaling", priceMinor: 15000, priceConfigured: true });
    const updated = await services.commandCanonicalServiceUpdate(editor, String(created.id), { price: "16000", isActive: false });
    expect(updated).toMatchObject({ priceMinor: 16000, isActive: false });
    expect((await q("SELECT action, actor FROM audit_log WHERE entity='service' AND entity_id=$1::text ORDER BY id", [created.id])))
      .toEqual([{ action: "service.create", actor: "SYN-SV6-EDIT" }, { action: "service.update", actor: "SYN-SV6-EDIT" }]);
    const before = (await q("SELECT count(*)::int AS n FROM services"))[0].n;
    for (const key of ["viewer", "invoicer", "documenter", "label", "materials"] as const) {
      await expect(services.commandCanonicalServiceCreate(await fx.session(key), { name: "SYN SV6 denied", price: "1" })).rejects.toThrow("CAPABILITY_DENIED");
      await expect(services.commandCanonicalServiceUpdate(await fx.session(key), String(ctx.priced), { price: "1" })).rejects.toThrow("CAPABILITY_DENIED");
    }
    expect(await refusal(services.commandCanonicalServiceCreate(editor, { name: "", price: "1" }))).toMatchObject({ code: "invalid_service", field: "name" });
    expect(await refusal(services.commandCanonicalServiceCreate(editor, { name: "SYN SV6 bad", price: "abc" }))).toMatchObject({ code: "invalid_service", field: "price" });
    expect(await refusal(services.commandCanonicalServiceUpdate(editor, String(ctx.priced), {}))).toMatchObject({ code: "invalid_service" });
    expect(await refusal(services.commandCanonicalServiceUpdate(editor, "999999", { price: "1" }))).toMatchObject({ code: "service_not_found", status: 404 });
    expect((await q("SELECT count(*)::int AS n FROM services"))[0].n).toBe(before);
    expect((await q("SELECT price_minor::int AS p FROM services WHERE id=$1", [ctx.priced]))[0].p).toBe(9100);
  });
  it("a failing audit rolls the write back completely", async () => {
    await fx.pool.query("CREATE FUNCTION syn_sv6_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('service.update','service.prices.batch','service_material.set') THEN RAISE EXCEPTION 'SYN service audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER syn_sv6_refuse_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_sv6_refuse_audit()");
    try {
      const editor = await fx.session("editor");
      await expect(services.commandCanonicalServiceUpdate(editor, String(ctx.priced), { price: "1" })).rejects.toThrow();
      await expect(services.commandCanonicalServicePriceBatch(editor, { entries: [{ id: ctx.priced, price: "2" }] })).rejects.toThrow();
      await expect(services.commandCanonicalServiceMaterialSet(await fx.session("materials"), { serviceId: ctx.priced, itemId: ctx.item, qtyPerUnit: 1 })).rejects.toThrow();
      expect((await q("SELECT price_minor::int AS p FROM services WHERE id=$1", [ctx.priced]))[0].p).toBe(9100);
      expect(await q("SELECT id FROM service_materials WHERE service_id=$1", [ctx.priced])).toEqual([]);
      expect(await q("SELECT id FROM audit_log WHERE action='services.price_batch'")).toEqual([]);
    } finally { await fx.pool.query("DROP TRIGGER syn_sv6_refuse_audit ON audit_log; DROP FUNCTION syn_sv6_refuse_audit()"); }
  });
  it("the batch is all or nothing and audits the prices it replaced, read under its row locks", async () => {
    const editor = await fx.session("editor");
    expect(await refusal(services.commandCanonicalServicePriceBatch(editor, { entries: [{ id: ctx.priced, price: "9500" }, { id: 999999, price: "1" }] }))).toMatchObject({ code: "invalid_service" });
    expect(await refusal(services.commandCanonicalServicePriceBatch(editor, { entries: [{ id: ctx.priced, price: "1" }, { id: ctx.priced, price: "2" }] }))).toMatchObject({ code: "invalid_service" });
    expect(await refusal(services.commandCanonicalServicePriceBatch(editor, { entries: [{ id: ctx.priced, price: "0" }] }))).toMatchObject({ code: "invalid_service" });
    expect((await q("SELECT price_minor::int AS p FROM services WHERE id=$1", [ctx.priced]))[0].p).toBe(9100);
    // Race: another transaction holds the row and changes the price; the batch waits on the
    // row lock and its audit's "before" is the price that transaction committed (legacy read
    // "before" outside the transaction and would record the stale 9100).
    const side = new Pool({ ...(fx.pool as unknown as { options: PoolConfig }).options, max: 3 });
    const holder = await side.connect();
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      await holder.query("UPDATE services SET price_minor = 9300 WHERE id = $1", [ctx.priced]);
      const pending = services.commandCanonicalServicePriceBatch(editor, { entries: [{ id: ctx.priced, price: "9900" }] });
      pending.catch(() => undefined);
      try { expect((await waitForBlockedBy(side, pid, 10_000)).length).toBeGreaterThan(0); }
      finally { await holder.query("COMMIT"); }
      expect(await pending).toEqual({ updated: 1 });
    } finally { holder.release(); await side.end(); }
    const batch = await audits("service.prices.batch");
    expect(batch.at(-1)).toMatchObject({ actor: "SYN-SV6-EDIT", details: { الأسعار: [{ رقم: ctx.priced, قبل: 9300, بعد: 9900 }] } });
    expect((await audits("services.price_batch")).at(-1)).toMatchObject({ actor: "SYN-SV6-EDIT" });
    expect((await q("SELECT price_minor::int AS p, price_configured AS c FROM services WHERE id=$1", [ctx.priced]))[0]).toEqual({ p: 9900, c: true });
  });
  it("the provisional fill writes only unpriced active services from the locked catalogue and audits exactly those", async () => {
    const editor = await fx.session("editor");
    const result = await services.commandCanonicalServiceProvisional(editor);
    const written = await q("SELECT id, price_minor::int AS p FROM services WHERE price_provisional ORDER BY id");
    expect(result.filled).toBe(written.length);
    expect(written).toContainEqual({ id: ctx.unpriced, p: 12000 });
    expect(written.some(row => row.id === ctx.priced || row.id === ctx.inactive)).toBe(false);
    const audit = (await audits("service.prices.provisional")).at(-1)!;
    expect(audit.actor).toBe("SYN-SV6-EDIT");
    expect((audit.details as { الأسعار: { رقم: number }[] }).الأسعار.map(row => row.رقم).sort((a, b) => a - b)).toEqual(written.map(row => row.id));
    // As legacy, a provisional (still unconfigured) row is refilled with the same estimate.
    expect((await services.commandCanonicalServiceProvisional(editor)).filled).toBe(written.length);
    // Nothing unconfigured left: refused, nothing audited.
    await q("UPDATE services SET price_configured = TRUE, price_minor = GREATEST(price_minor, 1) WHERE is_active");
    const count = (await audits("service.prices.provisional")).length;
    expect(await refusal(services.commandCanonicalServiceProvisional(editor))).toMatchObject({ code: "nothing_to_fill", status: 400 });
    expect((await audits("service.prices.provisional")).length).toBe(count);
    await expect(services.commandCanonicalServiceProvisional(await fx.session("viewer"))).rejects.toThrow("CAPABILITY_DENIED");
  });
});

describe("legacy provisional fill (shared writer fix)", () => {
  it("counts and returns only the rows actually written; a service priced meanwhile is not reported as filled", async () => {
    const id = (await q("INSERT INTO services(name,category,price_minor,price_configured,sort_order) VALUES('SYN SV6 legacy','consultation',0,FALSE,9004) RETURNING id"))[0].id;
    // The caller's list said both were unpriced; one was priced by hand before the write.
    const result = await db.fillProvisionalServicePrices([{ id, priceMinor: 4000 }, { id: ctx.priced, priceMinor: 8000 }], "SYN-SV6-LEGACY");
    expect(result).toMatchObject({ ok: true, filled: 1 });
    expect((result as { applied?: unknown }).applied).toEqual([{ id, priceMinor: 4000 }]);
    expect((await q("SELECT price_minor::int AS p, price_provisional AS v FROM services WHERE id=$1", [ctx.priced]))[0]).toEqual({ p: 9900, v: false });
  });
});

describe("service materials", () => {
  it("finance.cost-prices.view reads; settings.operational.edit sets and removes with audits; others refused", async () => {
    const materials = await fx.session("materials");
    const set = await services.commandCanonicalServiceMaterialSet(materials, { serviceId: ctx.priced, itemId: ctx.item, qtyPerUnit: 2, note: "SYN two pairs" });
    const rows = await services.readCanonicalServiceMaterials(await fx.session("cost"), params({ serviceId: String(ctx.priced) }));
    expect(rows).toEqual([expect.objectContaining({ id: set.id, serviceId: ctx.priced, itemId: ctx.item, qtyPerUnit: 2, note: "SYN two pairs", createdBy: "SYN-SV6-MAT" })]);
    for (const key of ["materials", "viewer", "documenter", "label"] as const) {
      await expect(services.readCanonicalServiceMaterials(await fx.session(key), params())).rejects.toThrow("CAPABILITY_DENIED");
    }
    for (const key of ["cost", "editor", "label"] as const) {
      await expect(services.commandCanonicalServiceMaterialSet(await fx.session(key), { serviceId: ctx.priced, itemId: ctx.item, qtyPerUnit: 1 })).rejects.toThrow("CAPABILITY_DENIED");
      await expect(services.commandCanonicalServiceMaterialRemove(await fx.session(key), String(set.id))).rejects.toThrow("CAPABILITY_DENIED");
    }
    expect(await refusal(services.commandCanonicalServiceMaterialSet(materials, { serviceId: ctx.inactive, itemId: ctx.item, qtyPerUnit: 1 }))).toMatchObject({ field: "serviceId" });
    expect(await refusal(services.commandCanonicalServiceMaterialSet(materials, { serviceId: ctx.priced, itemId: ctx.inactiveItem, qtyPerUnit: 1 }))).toMatchObject({ field: "itemId" });
    expect(await refusal(services.commandCanonicalServiceMaterialSet(materials, { serviceId: ctx.priced, itemId: ctx.item, qtyPerUnit: 0 }))).toMatchObject({ field: "qtyPerUnit" });
    expect(await services.commandCanonicalServiceMaterialRemove(materials, String(set.id))).toEqual({ ok: true });
    expect(await refusal(services.commandCanonicalServiceMaterialRemove(materials, String(set.id)))).toMatchObject({ code: "service_material_not_found", status: 404 });
    expect((await q("SELECT action, actor FROM audit_log WHERE entity='service_materials' AND entity_id=$1::text ORDER BY id", [set.id])))
      .toEqual([{ action: "service_material.set", actor: "SYN-SV6-MAT" }, { action: "service_material.remove", actor: "SYN-SV6-MAT" }]);
  });
  it("a link never lands on a service deactivated while the link waited for it", async () => {
    const id = (await q("INSERT INTO services(name,category,price_minor,price_configured,sort_order) VALUES('SYN SV6 racing','surgery',15000,TRUE,9005) RETURNING id"))[0].id;
    const side = new Pool({ ...(fx.pool as unknown as { options: PoolConfig }).options, max: 3 });
    const holder = await side.connect();
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      await holder.query("UPDATE services SET is_active = FALSE WHERE id = $1", [id]);
      const pending = refusal(services.commandCanonicalServiceMaterialSet(await fx.session("materials"), { serviceId: id, itemId: ctx.item, qtyPerUnit: 1 }));
      try { expect((await waitForBlockedBy(side, pid, 10_000)).length).toBeGreaterThan(0); }
      finally { await holder.query("COMMIT"); }
      expect(await pending).toMatchObject({ code: "invalid_service", field: "serviceId" });
    } finally { holder.release(); await side.end(); }
    expect(await q("SELECT id FROM service_materials WHERE service_id=$1", [id])).toEqual([]);
  });
});
