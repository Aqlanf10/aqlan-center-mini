import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalPlanTemplateCatalog, SYNTHETIC_PLAN_TEMPLATES } from "../fixtures/canonical-plan-template-catalog";
import { effectiveTemplates } from "../../lib/specialty-templates";
import type { CanonicalSnapshotQuery } from "../../lib/canonical-read-snapshot";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-plan-template-secret-0123456789");
const db = await import("../../lib/db"), reads = await import("../../lib/canonical-plan-templates"), snapshots = await import("../../lib/canonical-read-snapshot");
const plans = await import("../../lib/canonical-plan-reads");
const VIEW = { "clinical.plans.view": true }, PRICES = { ...VIEW, "finance.service-prices.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-PT-OWNER", role: "admin" },
  own: { username: "SYN-PT-OWN", role: "doctor", doctor: true, patientScope: "own", grants: VIEW },
  all: { username: "SYN-PT-ALL", role: "reception", patientScope: "all", grants: VIEW },
  none: { username: "SYN-PT-NONE", role: "admin", patientScope: "none", grants: VIEW },
  unlinked: { username: "SYN-PT-UNLINKED", role: "doctor", patientScope: "own", grants: VIEW },
  prices: { username: "SYN-PT-PRICES", role: "reception", patientScope: "none", grants: PRICES },
  adjacent: { username: "SYN-PT-ADJACENT", role: "admin", patientScope: "all", grants: { "clinical.xrays.view": true, "finance.service-prices.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, ids: Awaited<ReturnType<typeof seedCanonicalPlanTemplateCatalog>>;
const read = async (key: Key = "none") => reads.readCanonicalPlanTemplates(await fx.session(key));
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 3 }); ids = await seedCanonicalPlanTemplateCatalog(fx.pool); }, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
it("registers exactly the mapped plan capability without granting patient access", async () => {
  const { staffRuntimeActions } = await import("../../lib/staff-operation-runtime"); expect(staffRuntimeActions().filter(a => a === "clinical.plans.view")).toHaveLength(1);
  await expect(plans.readCanonicalClinicalPlans(await fx.session("none"), 1)).rejects.toThrow(/RECORD_SCOPE_DENIED/);
});
it.each(["own", "all", "none", "unlinked"] as const)("%s reads the non-patient clinical catalogue without implicit prices", async key => {
  const result = await read(key); expect(result).toEqual({ projection: "plan-template-catalog", source: "saved", pricesVisible: false,
    templates: SYNTHETIC_PLAN_TEMPLATES, services: [{ id: ids.service, name: "خدمة اصطناعية", category: "SYN-therapy", sortOrder: 1 }] });
  expect(JSON.stringify(result)).not.toMatch(/9900123|8800123|7700123|6600123|SYN private|inactive|patientId|costPrice|canEdit/);
});
it.each(["owner", "prices"] as const)("%s sees precise base-currency catalogue prices under independent authority", async key => {
  const result = await read(key); expect(result.pricesVisible).toBe(true);
  expect(result.services[0].price).toEqual({ currency: "YER", minor: 9900123, configured: true, provisional: true });
  expect(JSON.stringify(result)).not.toMatch(/8800123|7700123|6600123|costPrice|canEdit/);
});
it("adjacent imaging/price grants and an admin label do not replace the clinical catalogue grant", async () => { await expect(read("adjacent")).rejects.toThrow(/CAPABILITY_DENIED/); });
function instrument(wrap: (q: CanonicalSnapshotQuery) => CanonicalSnapshotQuery) {
  const original = snapshots.runCanonicalReadSnapshot;
  return vi.spyOn(snapshots, "runCanonicalReadSnapshot").mockImplementationOnce((session, action, reader, options) => original(session, action, (q, scope) => reader(wrap(q), scope), options));
}
it("clinical-only SQL never selects or budgets prices, nor unrelated settings or patient finance", async () => {
  const sql: string[] = [], hook = instrument(q => ({ query: async (text, args) => { sql.push(text); return q.query(text, args); } }));
  try { await read(); expect(sql.join("\n")).not.toMatch(/price_|\b(patients|invoices|payments|treatment_plans|audit_log)\b/i); expect(sql.filter(s => /FROM settings/.test(s)).every(s => /WHERE key=\$1/.test(s))).toBe(true); }
  finally { hook.mockRestore(); }
});
it("hidden malformed monetary values cannot break the clinical reader, but granted prices refuse unsafe precision", async () => {
  const before = await read(); await fx.pool.query("UPDATE services SET price_minor=9007199254740993 WHERE id=$1", [ids.service]);
  try { expect(await read()).toEqual(before); await expect(read("prices")).rejects.toMatchObject({ code: "plan_template_price_invalid" }); }
  finally { await fx.pool.query("UPDATE services SET price_minor=9900123 WHERE id=$1", [ids.service]); }
});
it("inactive services and unrelated settings cannot change the selected catalogue", async () => {
  const before = await read(); await fx.pool.query("UPDATE services SET name='SYN changed inactive',price_minor=12345 WHERE id=$1", [ids.inactive]); await fx.pool.query("UPDATE settings SET value='SYN changed private' WHERE key='SYN.private.setting'"); expect(await read()).toEqual(before);
});
it.each(["", "{invalid", "[]"])("preserves existing ready-template fallback and discloses its source for %s", async raw => {
  await fx.pool.query("UPDATE settings SET value=$1 WHERE key='plans.specialty_templates'", [raw]);
  try { const result = await read(); expect(result.templates).toEqual(effectiveTemplates(raw).templates); expect(result.source).toBe(raw ? "default-invalid-setting" : "default"); }
  finally { await fx.pool.query("UPDATE settings SET value=$1 WHERE key='plans.specialty_templates'", [JSON.stringify(SYNTHETIC_PLAN_TEMPLATES)]); }
});
it("a missing optional central setting uses the existing defaults without creating a row", async () => {
  await fx.pool.query("DELETE FROM settings WHERE key='plans.specialty_templates'");
  try { expect((await read()).source).toBe("default"); expect((await fx.pool.query("SELECT 1 FROM settings WHERE key='plans.specialty_templates'")).rows).toHaveLength(0); }
  finally { await fx.pool.query("INSERT INTO settings(key,value) VALUES('plans.specialty_templates',$1)", [JSON.stringify(SYNTHETIC_PLAN_TEMPLATES)]); }
});
it("rejects oversized setting text before parsing or substituting defaults", async () => {
  await fx.pool.query("UPDATE settings SET value=repeat('x',2100000) WHERE key='plans.specialty_templates'");
  try { await expect(read()).rejects.toMatchObject({ code: "plan_template_limit" }); }
  finally { await fx.pool.query("UPDATE settings SET value=$1 WHERE key='plans.specialty_templates'", [JSON.stringify(SYNTHETIC_PLAN_TEMPLATES)]); }
});
it("rejects an oversized active catalogue without silently dropping service choices", async () => {
  const extra = (await fx.pool.query("INSERT INTO services(name,category,price_minor,is_active,sort_order) SELECT 'SYN-LIMIT-'||n,'SYN',0,TRUE,3 FROM generate_series(1,2000) n RETURNING id")).rows.map(r => r.id);
  try { await expect(read()).rejects.toMatchObject({ code: "plan_template_limit" }); }
  finally { await fx.pool.query("DELETE FROM services WHERE id=ANY($1::int[])", [extra]); }
});
it("bounds selected service bytes independently of the row-count limit", async () => {
  const extra = (await fx.pool.query("INSERT INTO services(name,category,price_minor,is_active,sort_order) SELECT 'SYN-BYTES-'||n||repeat('x',1500),'SYN',0,TRUE,3 FROM generate_series(1,1500) n RETURNING id")).rows.map(r => r.id);
  try { await expect(read()).rejects.toMatchObject({ code: "plan_template_limit" }); }
  finally { await fx.pool.query("DELETE FROM services WHERE id=ANY($1::int[])", [extra]); }
});
it("uses one owning RR read-only lease without initialization, pool reads, audit or mutation", async () => {
  const before = (await fx.pool.query("SELECT (SELECT count(*) FROM audit_log)::int audits,(SELECT count(*) FROM settings)::int settings,(SELECT count(*) FROM services)::int services")).rows;
  const session = await fx.session("prices"), pool = db.getPool(), connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), ensure = vi.spyOn(db, "ensureSchema");
  const hook = instrument(q => ({ query: async (text, args) => { expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read"); expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on"); return q.query(text, args); } }));
  try { await reads.readCanonicalPlanTemplates(session); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); }
  finally { hook.mockRestore(); connect.mockRestore(); query.mockRestore(); ensure.mockRestore(); }
  expect((await fx.pool.query("SELECT (SELECT count(*) FROM audit_log)::int audits,(SELECT count(*) FROM settings)::int settings,(SELECT count(*) FROM services)::int services")).rows).toEqual(before);
});
it("central templates and service price/name remain in one snapshot across a concurrent commit", async () => {
  let changed = false; const revised = structuredClone(SYNTHETIC_PLAN_TEMPLATES); revised[0].name = "SYN revised template";
  const hook = instrument(q => ({ query: async (text, args) => {
    if (!changed) { changed = true; const writer = await side.connect(); try { await writer.query("BEGIN"); await writer.query("UPDATE settings SET value=$1 WHERE key='plans.specialty_templates'", [JSON.stringify(revised)]); await writer.query("UPDATE services SET name='SYN revised service',price_minor=12345 WHERE id=$1", [ids.service]); await writer.query("COMMIT"); } finally { await writer.query("ROLLBACK"); writer.release(); } }
    return q.query(text, args);
  } }));
  try { const old = await read("prices"); expect(old.templates[0].name).toBe("قالب خطة اصطناعي"); expect(old.services[0].price?.minor).toBe(9900123); hook.mockRestore(); const fresh = await read("prices"); expect(fresh.templates[0].name).toBe("SYN revised template"); expect(fresh.services[0]).toMatchObject({ name: "SYN revised service", price: { minor: 12345 } }); }
  finally { hook.mockRestore(); await side.query("UPDATE settings SET value=$1 WHERE key='plans.specialty_templates'", [JSON.stringify(SYNTHETIC_PLAN_TEMPLATES)]); await side.query("UPDATE services SET name='خدمة اصطناعية',price_minor=9900123 WHERE id=$1", [ids.service]); }
});
it("expires a session after it waits behind the real authority fence", async () => {
  const session = await fx.session("none", 1500), holder = await side.connect();
  try { await holder.query("BEGIN"); const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid; await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    const pending = reads.readCanonicalPlanTemplates(session); pending.catch(() => undefined);
    try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); await new Promise(resolve => setTimeout(resolve, 1700)); } finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); }
});
it("re-proves the independent price grant after waiting behind withdrawal", async () => {
  const session = await fx.session("prices"), holder = await side.connect();
  try { await holder.query("BEGIN"); const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid; await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    await holder.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: VIEW, patientScope: "none" }, 2)), fx.ids.prices]);
    const pending = reads.readCanonicalPlanTemplates(session); pending.catch(() => undefined); try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); } finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(/STALE/); expect((await read("prices")).services[0]).not.toHaveProperty("price");
  } finally { await holder.query("ROLLBACK"); holder.release(); await fx.setGrants("prices", PRICES, { patientScope: "none" }); }
});
it("grant withdrawal and credential retirement refuse old authority without a legacy fallback", async () => {
  const stale = await fx.session("all"); await fx.setGrants("all", {}, { patientScope: "all" });
  try { await expect(reads.readCanonicalPlanTemplates(stale)).rejects.toThrow(/STALE/); await expect(read("all")).rejects.toThrow(/CAPABILITY_DENIED/); }
  finally { await fx.setGrants("all", VIEW, { patientScope: "all" }); }
  const session = await fx.session("none"); await fx.pool.query("UPDATE users SET password_hash='SYN retired catalogue hash' WHERE id=$1", [fx.ids.none]); await expect(reads.readCanonicalPlanTemplates(session)).rejects.toThrow(/STALE/);
});
it("a query failure cannot publish a partial catalogue and leaves the next read usable", async () => {
  const hook = instrument(() => ({ query: async () => { throw new Error("SYN private query failure"); } }));
  try { await expect(read()).rejects.toThrow(); } finally { hook.mockRestore(); }
  expect((await read()).templates).toEqual(SYNTHETIC_PLAN_TEMPLATES);
});
