/** M2 slice 70b: canonical lab pricing and services-catalogue writes on real PostgreSQL,
 * synthetic data only. OWNER DECISION (#483, 6615071565): lab cost prices only with
 * finance.cost-prices.view — every price-bearing response, revocation included; the
 * independent finance.lab-prices.edit writes without reading stored prices back. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolConfig } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { waitForBlockedBy } from "./_canonical-ready-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-lab-pricing-2026-xyz");
const db = await import("../../lib/db");
const pricing = await import("../../lib/canonical-lab-pricing");

const VIEW = { "clinical.lab.view": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-LP2-OWNER", role: "admin" },
  labViewer: { username: "SYN-LP2-LAB", role: "reception", grants: { ...VIEW } },
  costViewer: { username: "SYN-LP2-COST", role: "accountant", grants: { ...VIEW, "finance.cost-prices.view": true } },
  editor: { username: "SYN-LP2-EDIT", role: "reception", grants: { ...VIEW, "finance.lab-prices.edit": true } },
  editorCost: { username: "SYN-LP2-EDITC", role: "accountant", grants: { ...VIEW, "finance.lab-prices.edit": true, "finance.cost-prices.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const ctx = { lab: 0, service: 0, service2: 0 };
const params = (value: Record<string, string> = {}) => new URLSearchParams(value);
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; field?: string; message?: string }) => error);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  ctx.lab = (await q("INSERT INTO parties(name,kind,currency) VALUES('SYN Price Lab','lab','YER') RETURNING id"))[0].id;
  ctx.service = (await q("INSERT INTO lab_services(name,code,category,tooth_scope) VALUES('SYN Price crown','SYN-LP2-CROWN','prostho','single_tooth') RETURNING id"))[0].id;
  ctx.service2 = (await q("INSERT INTO lab_services(name,code,category,tooth_scope) VALUES('SYN Price bridge','SYN-LP2-BRIDGE','prostho','multi_teeth_bridge') RETURNING id"))[0].id;
  await q("INSERT INTO lab_pricing_rules(party_id,lab_service_id,cost_minor,cost_currency,effective_from,created_by) VALUES($1,$2,45000,'YER','2031-01-01','synthetic')", [ctx.lab, ctx.service]);
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("reading prices (owner decision)", () => {
  it("clinical.lab.view alone is refused for the list and for resolve; the cost capability reads both", async () => {
    const viewer = await fx.session("labViewer");
    await expect(pricing.readCanonicalLabPricing(viewer, params())).rejects.toThrow("CAPABILITY_DENIED");
    await expect(pricing.readCanonicalLabPricing(viewer, params({ resolve: "1", partyId: String(ctx.lab), labServiceId: String(ctx.service), date: "2031-02-01" }))).rejects.toThrow("CAPABILITY_DENIED");
    // An editor without the cost capability cannot read the table either.
    await expect(pricing.readCanonicalLabPricing(await fx.session("editor"), params())).rejects.toThrow("CAPABILITY_DENIED");
    const cost = await fx.session("costViewer");
    expect((await pricing.readCanonicalLabPricing(cost, params({ partyId: String(ctx.lab) })) as { rules: { costMinor: number }[] }).rules[0]).toMatchObject({ costMinor: 45000 });
    expect(await pricing.readCanonicalLabPricing(cost, params({ resolve: "1", partyId: String(ctx.lab), labServiceId: String(ctx.service), date: "2031-02-01" })))
      .toEqual({ resolved: { ruleId: expect.any(Number), costMinor: 45000, costCurrency: "YER" } });
  });
  it("revoking the cost capability refuses a session issued before the revocation", async () => {
    const issued = await fx.session("costViewer");
    expect(await pricing.readCanonicalLabPricing(issued, params())).toHaveProperty("rules");
    await fx.setGrants("costViewer", { ...VIEW });
    try {
      // The permission revision changed: the whole earlier session is refused.
      await expect(pricing.readCanonicalLabPricing(issued, params())).rejects.toThrow(/CREDENTIAL_OR_ACCOUNT/);
      await expect(pricing.readCanonicalLabPricing(await fx.session("costViewer"), params())).rejects.toThrow("CAPABILITY_DENIED");
    } finally { await fx.setGrants("costViewer", { ...VIEW, "finance.cost-prices.view": true }); }
    expect(await pricing.readCanonicalLabPricing(await fx.session("costViewer"), params())).toHaveProperty("rules");
  });
});

describe("writing prices", () => {
  it("an editor without the cost capability writes, but never reads a stored price back; with it the amounts return", async () => {
    const editor = await fx.session("editor");
    const created = await pricing.commandCanonicalLabPricingCreate(editor, { partyId: ctx.lab, labServiceId: ctx.service2, costMinor: 90000, effectiveFrom: "2031-01-01" });
    expect(created.rule).not.toHaveProperty("costMinor");
    expect(created.rule).not.toHaveProperty("costCurrency");
    expect(JSON.stringify(created)).not.toContain("90000");
    expect((await q("SELECT cost_minor::int AS c FROM lab_pricing_rules WHERE id=$1", [created.rule.id]))[0].c).toBe(90000);
    const updated = await pricing.commandCanonicalLabPricingUpdate(editor, String(created.rule.id), { note: "SYN note" });
    expect(JSON.stringify(updated)).not.toContain("90000");
    const withCost = await pricing.commandCanonicalLabPricingUpdate(await fx.session("editorCost"), String(created.rule.id), { costMinor: 95000 });
    expect(withCost.rule).toMatchObject({ costMinor: 95000, costCurrency: "YER", note: "SYN note" });
    expect((await q("SELECT action, actor FROM audit_log WHERE entity='lab_pricing_rule' AND entity_id=$1::text ORDER BY id", [created.rule.id])))
      .toEqual([{ action: "lab_pricing.create", actor: "SYN-LP2-EDIT" }, { action: "lab_pricing.update", actor: "SYN-LP2-EDIT" }, { action: "lab_pricing.update", actor: "SYN-LP2-EDITC" }]);
    await expect(pricing.commandCanonicalLabPricingCreate(await fx.session("costViewer"), { partyId: ctx.lab, labServiceId: ctx.service, costMinor: 1 })).rejects.toThrow("CAPABILITY_DENIED");
  });
  it("closing the previous rule and creating the new one commit together; validation refuses without writing", async () => {
    const editor = await fx.session("editorCost");
    const before = await q("SELECT id FROM lab_pricing_rules WHERE party_id=$1 AND lab_service_id=$2 AND effective_to IS NULL", [ctx.lab, ctx.service]);
    const created = await pricing.commandCanonicalLabPricingCreate(editor, { partyId: ctx.lab, labServiceId: ctx.service, costMinor: 50000, effectiveFrom: "2031-06-01", closePreviousRule: true });
    expect(created.closedRules).toEqual(before.map(row => row.id));
    expect((await q("SELECT effective_to::text AS t FROM lab_pricing_rules WHERE id=$1", [before[0].id]))[0].t).toBe("2031-05-31");
    const count = (await q("SELECT count(*)::int AS n FROM lab_pricing_rules"))[0].n;
    expect(await refusal(pricing.commandCanonicalLabPricingCreate(editor, { partyId: ctx.lab, labServiceId: ctx.service, costMinor: 1.5 }))).toMatchObject({ code: "invalid_lab_pricing", field: "cost" });
    expect(await refusal(pricing.commandCanonicalLabPricingCreate(editor, { partyId: ctx.lab, labServiceId: ctx.service, costMinor: 1, effectiveFrom: "2031-06-01", effectiveTo: "2031-05-01" }))).toMatchObject({ field: "effectiveTo" });
    expect(await refusal(pricing.commandCanonicalLabPricingCreate(editor, { partyId: 999999, labServiceId: ctx.service, costMinor: 1 }))).toMatchObject({ code: "lab_pricing_not_found" });
    expect(await refusal(pricing.commandCanonicalLabPricingUpdate(editor, String(created.rule.id), { costCurrency: "USD" }))).toMatchObject({ field: "cost" });
    expect(await refusal(pricing.commandCanonicalLabPricingUpdate(editor, String(created.rule.id), { effectiveTo: "2031-01-01" }))).toMatchObject({ field: "effectiveTo" });
    expect((await q("SELECT count(*)::int AS n FROM lab_pricing_rules"))[0].n).toBe(count);
    expect(await pricing.commandCanonicalLabPricingDelete(editor, String(created.rule.id))).toEqual({ ok: true });
    expect(await q("SELECT id FROM lab_pricing_rules WHERE id=$1", [created.rule.id])).toEqual([]);
  });
  it("a write waits on the (lab, service) lock held by another price change", async () => {
    const side = new Pool({ ...(fx.pool as unknown as { options: PoolConfig }).options, max: 3 });
    const holder = await side.connect();
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('lab-pricing:' || $1::text || ':' || $2::text))", [ctx.lab, ctx.service2]);
      const pending = pricing.commandCanonicalLabPricingCreate(await fx.session("editorCost"), { partyId: ctx.lab, labServiceId: ctx.service2, costMinor: 1000, effectiveFrom: "2032-01-01" });
      pending.catch(() => undefined);
      try { expect((await waitForBlockedBy(side, pid, 10_000)).length).toBeGreaterThan(0); }
      finally { await holder.query("COMMIT"); }
      expect((await pending).rule).toMatchObject({ costMinor: 1000 });
    } finally { holder.release(); await side.end(); }
  });
  it("the legacy create returns the rule it created, even when an older rule starts later (shared fix)", async () => {
    await q("INSERT INTO lab_pricing_rules(party_id,lab_service_id,cost_minor,cost_currency,effective_from,created_by) VALUES($1,$2,7,'YER','2040-01-01','synthetic')", [ctx.lab, ctx.service2]);
    const created = await db.createLabPricingRule({ partyId: ctx.lab, labServiceId: ctx.service2, costMinor: 8, costCurrency: "YER", effectiveFrom: "2033-01-01", createdBy: "synthetic" });
    expect(created).toMatchObject({ costMinor: 8, effectiveFrom: "2033-01-01" });
  });
});

describe("services catalogue writes", () => {
  it("create, a taken code, update, deactivate when priced, seed — each audited; no grant, no write", async () => {
    const editor = await fx.session("editor");
    const created = await pricing.commandCanonicalLabServiceCreate(editor, { name: "SYN Night guard", code: "syn-lp2-ng", category: "appliance", toothScope: "full_arch" }) as { service: { id: number; code: string } };
    expect(created.service.code).toBe("SYN-LP2-NG");
    expect(await refusal(pricing.commandCanonicalLabServiceCreate(editor, { name: "SYN Twin", code: "SYN-LP2-NG" }))).toMatchObject({ code: "lab_service_code_taken", status: 409 });
    expect(await pricing.commandCanonicalLabServiceUpdate(editor, String(created.service.id), { defaultDays: 10 })).toMatchObject({ service: { defaultDays: 10 } });
    expect(await refusal(pricing.commandCanonicalLabServiceUpdate(editor, String(created.service.id), { category: "nonsense" }))).toMatchObject({ field: "category" });
    expect(await pricing.commandCanonicalLabServiceDelete(editor, String(ctx.service))).toMatchObject({ deleted: false, deactivated: true });
    expect(await pricing.commandCanonicalLabServiceDelete(editor, String(created.service.id))).toMatchObject({ deleted: true });
    expect((await q("SELECT action FROM audit_log WHERE entity='lab_service' AND entity_id IN ($1::text,$2::text) ORDER BY id", [created.service.id, ctx.service])).map(row => row.action))
      .toEqual(["lab_service.create", "lab_service.update", "lab_service.deactivate", "lab_service.delete"]);
    expect(await pricing.commandCanonicalLabServiceCreate(editor, { action: "seed_defaults" })).toMatchObject({ services: expect.any(Array) });
    await expect(pricing.commandCanonicalLabServiceCreate(await fx.session("labViewer"), { name: "SYN Denied" })).rejects.toThrow("CAPABILITY_DENIED");
  });
});
