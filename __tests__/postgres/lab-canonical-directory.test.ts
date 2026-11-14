/** M2 slice 70a: canonical laboratory directory (GET/POST /api/laboratories,
 * GET/PATCH/DELETE /api/laboratories/[id], GET /api/lab/services(/[id]),
 * GET /api/lab/work-intents/capability) on real PostgreSQL, synthetic data only.
 * The accounting group is read only with finance.payables.record and never written
 * here; writes are one clinical.laboratories.manage transaction with an atomic audit. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-lab-directory-2026");
const db = await import("../../lib/db");
const dir = await import("../../lib/canonical-lab-directory");

const ACCOUNTS = {
  owner: { username: "SYN-LD-OWNER", role: "admin" },
  viewer: { username: "SYN-LD-VIEW", role: "reception", grants: { "clinical.lab.view": true } },
  finance: { username: "SYN-LD-FIN", role: "accountant", grants: { "clinical.lab.view": true, "finance.payables.record": true } },
  manager: { username: "SYN-LD-MGR", role: "reception", grants: { "clinical.lab.view": true, "clinical.laboratories.manage": true } },
  orderer: { username: "SYN-LD-ORDER", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true, "clinical.lab.order": true } },
  none: { username: "SYN-LD-NONE", role: "reception", grants: {} },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const ctx = { withOrders: 0, empty: 0, service: 0, inactiveService: 0 };
const ACCOUNTING = ["currency", "expenseAccountCode", "payableAccountCode", "autoPostJournal", "customAccountName"];
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; field?: string }) => error);
const audits = async (id: number) => (await q("SELECT actor, details->>'operation' AS operation FROM audit_log WHERE action='settings.update' AND entity='laboratory' AND entity_id=$1::text ORDER BY id", [id]));

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  ctx.withOrders = (await q("INSERT INTO parties(name,kind,currency,expense_account_code,payable_account_code,custom_account_name) VALUES('SYN Dir Lab','lab','USD','5199','2199','SYN custom') RETURNING id"))[0].id;
  ctx.empty = (await q("INSERT INTO parties(name,kind,currency) VALUES('SYN Empty Lab','lab','YER') RETURNING id"))[0].id;
  const patient = (await q("INSERT INTO patients(patient_number,full_name,phone) VALUES ('SYN-LD-1','SYN Dir patient','0500000980') RETURNING id"))[0].id;
  await q("INSERT INTO lab_orders(patient_id,party_id,lab_name,work_type,status,sent_date,due_date,exchange_rate) VALUES ($1,$2,'SYN Dir Lab','Synthetic crown','sent','2031-01-01','2031-01-08',1)", [patient, ctx.withOrders]);
  ctx.service = (await q("INSERT INTO lab_services(name,code,category,tooth_scope) VALUES('SYN Dir crown','SYN-LD-CROWN','prostho','single_tooth') RETURNING id"))[0].id;
  ctx.inactiveService = (await q("INSERT INTO lab_services(name,code,category,tooth_scope,is_active) VALUES('SYN Dir old','SYN-LD-OLD','prostho','single_tooth',FALSE) RETURNING id"))[0].id;
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("reads", () => {
  it("the accounting group only with finance.payables.record; the order counts for every viewer", async () => {
    const plain = await dir.readCanonicalLaboratories(await fx.session("viewer")) as { laboratories: Record<string, unknown>[]; projection: { accounting: boolean } };
    expect(plain.projection.accounting).toBe(false);
    const lab = plain.laboratories.find(row => row.id === ctx.withOrders)!;
    expect(lab).toMatchObject({ name: "SYN Dir Lab", activeOrdersCount: 1 });
    for (const key of ACCOUNTING) expect(lab).not.toHaveProperty(key);
    const finance = await dir.readCanonicalLaboratories(await fx.session("finance"), String(ctx.withOrders)) as { laboratory: Record<string, unknown> };
    expect(finance.laboratory).toMatchObject({ currency: "USD", expenseAccountCode: "5199", payableAccountCode: "2199", customAccountName: "SYN custom" });
    expect(await refusal(dir.readCanonicalLaboratories(await fx.session("viewer"), "999999"))).toMatchObject({ code: "laboratory_not_found", status: 404 });
    await expect(dir.readCanonicalLaboratories(await fx.session("none"))).rejects.toThrow("CAPABILITY_DENIED");
  });
  it("services: active by default, all on request, one by id; the capability check needs clinical.lab.order", async () => {
    const viewer = await fx.session("viewer");
    const active = (await dir.readCanonicalLabServices(viewer, { includeInactive: false })) as { services: { id: number }[] };
    const all = (await dir.readCanonicalLabServices(viewer, { includeInactive: true })) as { services: { id: number }[] };
    expect(active.services.map(row => row.id)).toContain(ctx.service);
    expect(active.services.map(row => row.id)).not.toContain(ctx.inactiveService);
    expect(all.services.map(row => row.id)).toContain(ctx.inactiveService);
    expect(await dir.readCanonicalLabServices(viewer, { includeInactive: true, rawId: String(ctx.service) })).toMatchObject({ service: { id: ctx.service, name: "SYN Dir crown" } });
    expect(await dir.readCanonicalLabWorkIntentCapability(await fx.session("orderer"))).toEqual({ supported: expect.any(Boolean) });
    await expect(dir.readCanonicalLabWorkIntentCapability(viewer)).rejects.toThrow("CAPABILITY_DENIED");
  });
});

describe("writes", () => {
  it("creates a lab with the legacy accounting defaults and an atomic audit; accounting fields are refused", async () => {
    const manager = await fx.session("manager");
    const created = await dir.commandCanonicalLaboratoryCreate(manager, { name: "SYN New Lab", phone: "0500000981", deliveryDays: 5 }) as { laboratory: { id: number } };
    expect(created.laboratory).not.toHaveProperty("expenseAccountCode");
    expect((await q("SELECT currency, expense_account_code, payable_account_code, auto_post_journal, delivery_days FROM parties WHERE id=$1", [created.laboratory.id]))[0])
      .toEqual({ currency: "YER", expense_account_code: "5101", payable_account_code: "2101", auto_post_journal: true, delivery_days: 5 });
    expect(await audits(created.laboratory.id)).toEqual([{ actor: "SYN-LD-MGR", operation: "create" }]);
    const before = (await q("SELECT count(*)::int AS n FROM parties WHERE kind='lab'"))[0].n;
    for (const field of ACCOUNTING) {
      expect(await refusal(dir.commandCanonicalLaboratoryCreate(manager, { name: "SYN Money Lab", [field]: field === "autoPostJournal" ? false : "X" })))
        .toMatchObject({ code: "lab_money_not_canonical", field, status: 409 });
    }
    expect((await q("SELECT count(*)::int AS n FROM parties WHERE kind='lab'"))[0].n).toBe(before);
    await expect(dir.commandCanonicalLaboratoryCreate(await fx.session("viewer"), { name: "SYN Denied Lab" })).rejects.toThrow("CAPABILITY_DENIED");
    expect(await refusal(dir.commandCanonicalLaboratoryCreate(manager, { name: " " }))).toMatchObject({ field: "name" });
  });
  it("updates contact and clinical fields only, the accounting group untouched; two concurrent changes both land, each audited", async () => {
    const manager = await fx.session("manager");
    await dir.commandCanonicalLaboratoryUpdate(manager, String(ctx.withOrders), { phone: "0500000982", note: "SYN note" });
    expect((await q("SELECT phone, note, currency, expense_account_code FROM parties WHERE id=$1", [ctx.withOrders]))[0])
      .toEqual({ phone: "0500000982", note: "SYN note", currency: "USD", expense_account_code: "5199" });
    expect(await refusal(dir.commandCanonicalLaboratoryUpdate(manager, String(ctx.withOrders), { payableAccountCode: "2100" }))).toMatchObject({ code: "lab_money_not_canonical" });
    expect(await refusal(dir.commandCanonicalLaboratoryUpdate(manager, String(ctx.withOrders), { deliveryDays: 0 }))).toMatchObject({ field: "deliveryDays" });
    expect(await refusal(dir.commandCanonicalLaboratoryUpdate(manager, "999999", { note: "x" }))).toMatchObject({ code: "laboratory_not_found" });
    await Promise.all([
      dir.commandCanonicalLaboratoryUpdate(manager, String(ctx.withOrders), { deliveryDays: 9 }),
      dir.commandCanonicalLaboratoryUpdate(await fx.session("owner"), String(ctx.withOrders), { contactPerson: "SYN contact" }),
    ]);
    expect((await q("SELECT delivery_days, contact_person FROM parties WHERE id=$1", [ctx.withOrders]))[0]).toEqual({ delivery_days: 9, contact_person: "SYN contact" });
    expect((await audits(ctx.withOrders)).map(row => row.operation)).toEqual(["update", "update", "update"]);
  });
  it("delete keeps the legacy rule: a lab with orders is deactivated, an empty one removed; both audited", async () => {
    const manager = await fx.session("manager");
    expect(await dir.commandCanonicalLaboratoryDelete(manager, String(ctx.withOrders))).toEqual({ ok: true, deactivated: true });
    expect((await q("SELECT is_active FROM parties WHERE id=$1", [ctx.withOrders]))[0].is_active).toBe(false);
    expect(await dir.commandCanonicalLaboratoryDelete(manager, String(ctx.empty))).toEqual({ ok: true, deactivated: false });
    expect(await q("SELECT id FROM parties WHERE id=$1", [ctx.empty])).toEqual([]);
    expect((await audits(ctx.empty)).map(row => row.operation)).toEqual(["delete"]);
    expect((await audits(ctx.withOrders)).at(-1)).toEqual({ actor: "SYN-LD-MGR", operation: "deactivate" });
    expect(await refusal(dir.commandCanonicalLaboratoryDelete(manager, String(ctx.empty)))).toMatchObject({ code: "laboratory_not_found" });
  });
});
