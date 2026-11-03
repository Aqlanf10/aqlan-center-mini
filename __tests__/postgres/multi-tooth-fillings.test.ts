import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import type { LinkedInvoiceLineInput } from "../../lib/invoice-linkage-db";

// Synthetic data only, in a database this file creates and owns. Never reset an
// ambient database or reuse a deployment connection for a regression fixture.
if (!process.env.TEST_DATABASE_URL?.trim()) throw new Error("Explicit local TEST_DATABASE_URL is required for filling fixtures.");
if (process.env.DATABASE_ENVIRONMENT === "production" || process.env.RAILWAY_PROJECT_ID) throw new Error("Production is not a filling test target.");
const originalUrl = assertRealPostgresUrl();
const target = new URL(originalUrl);
if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
  || !/^\/aqlan_(?:p1_test|test|ci)(?:_[a-z0-9]+)*$/i.test(target.pathname)) {
  throw new Error("Filling fixtures require isolated loopback PostgreSQL.");
}
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousTestDatabaseUrl = process.env.TEST_DATABASE_URL;
stubPostgresEnv();
const databaseName = `aqlan_fillings_test_${randomUUID().replaceAll("-", "")}`;
const isolatedUrl = new URL(originalUrl);
isolatedUrl.pathname = `/${databaseName}`;
let createdDatabase = false;
let db: typeof import("../../lib/db");
let linkage: typeof import("../../lib/invoice-linkage-db");
let serviceId: number;
let doctorId: number;
let otherDoctorId: number;
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await db.getPool().query(sql, values)).rows as T[];

beforeAll(async () => {
  const admin = new Client({ connectionString: originalUrl, ssl: false });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    createdDatabase = true;
  } finally { await admin.end(); }
  process.env.DATABASE_URL = isolatedUrl.toString();
  process.env.TEST_DATABASE_URL = isolatedUrl.toString();
  db = await import("../../lib/db");
  linkage = await import("../../lib/invoice-linkage-db");
  expect((await q<{ database: string }>("SELECT current_database() AS database"))[0].database).toBe(databaseName);
  await db.ensureSchema();
  serviceId = (await q<{ id: number }>(`INSERT INTO services(name,category,price_minor,price_configured,is_active)
    VALUES('Synthetic multi-tooth composite filling','filling',25000,TRUE,TRUE) RETURNING id`))[0].id;
  [doctorId, otherDoctorId] = (await q<{ id: number }>(`INSERT INTO parties(name,kind)
    VALUES('Synthetic filling doctor A','doctor'),('Synthetic filling doctor B','doctor') RETURNING id`)).map(row => row.id);
}, 180_000);

afterAll(async () => {
  try {
    if (db) await db.resetPoolForTesting();
    if (createdDatabase) {
      if (!/^aqlan_fillings_test_[a-f0-9]{32}$/.test(databaseName) || isolatedUrl.pathname !== `/${databaseName}`
        || isolatedUrl.pathname === target.pathname) throw new Error("Refusing cleanup outside the owned filling fixture.");
      const admin = new Client({ connectionString: originalUrl, ssl: false });
      await admin.connect();
      try { await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); }
      finally { await admin.end(); }
    }
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousTestDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL; else process.env.TEST_DATABASE_URL = previousTestDatabaseUrl;
  }
});

const patient = async () => (await q<{ id: number }>(`INSERT INTO patients(patient_number,full_name)
  VALUES($1,'Synthetic multi-tooth filling patient') RETURNING id`, [`FILL-${randomUUID()}`]))[0].id;
const line = (toothCode: number, surfaces: string, patch: Partial<LinkedInvoiceLineInput> = {}): LinkedInvoiceLineInput => ({
  serviceId, category: "filling", description: "Synthetic multi-tooth composite filling", doctorId,
  toothCode, surfaces, quantity: 1, unitPriceMinor: 25000, caseId: null, sessions: 1, ...patch,
});
const create = (patientId: number, items: LinkedInvoiceLineInput[], extra: Partial<Parameters<typeof linkage.createLinkedInvoice>[0]> = {}) =>
  linkage.createLinkedInvoice({ patientId, items, baseCurrency: "YER", discountMinor: 0, note: null,
    createdBy: "synthetic-filling-admin", actorRole: "admin", templates: DEFAULT_SPECIALTY_TEMPLATES,
    idempotencyKey: null, requestHash: null, auditDetails: {}, ...extra });
const snapshot = async (patientId: number) => ({
  invoices: await q("SELECT id,total_minor::text,discount_minor::text,status FROM invoices WHERE patient_id=$1 ORDER BY id", [patientId]),
  plans: await q("SELECT id,total_minor::text,consent_at FROM treatment_plans WHERE patient_id=$1 ORDER BY id", [patientId]),
  items: await q(`SELECT pi.id,pi.tooth_code,pi.surfaces,pi.case_id,pi.status,pi.billing_status,pi.billed_invoice_id
    FROM plan_items pi JOIN treatment_plans p ON p.id=pi.plan_id WHERE p.patient_id=$1 ORDER BY pi.id`, [patientId]),
  cases: await q("SELECT id FROM clinical_cases WHERE patient_id=$1 ORDER BY id", [patientId]),
  payments: await q("SELECT id FROM payments WHERE patient_id=$1 ORDER BY id", [patientId]),
});

describe("multiple fillings retain independent clinical work and native amounts", () => {
  it("previews, saves and reads three tooth/surface identities; no bridge case or collection is invented", async () => {
    const patientId = await patient();
    const items = [line(16, "om"), line(26, "db", { doctorId: otherDoctorId, unitPriceMinor: 30000 }), line(36, "l")];
    const before = await snapshot(patientId);
    const preview = await linkage.previewInvoiceLinkage({ patientId, baseCurrency: "YER", items });
    expect(preview).toHaveLength(3);
    for (const item of preview) expect(item).toMatchObject({ kind: "clinical", specialty: "restorative",
      item: { mode: "new" }, case: { mode: "none" }, refusal: null });
    expect(await snapshot(patientId)).toEqual(before);
    const saved = await create(patientId, items, { discountMinor: 5000 });
    if (!saved.ok) throw new Error(saved.reason);
    expect(new Set(saved.links.map(item => item.planItemId)).size).toBe(3);
    expect(saved.links.every(item => item.caseId === null && item.caseCreated === false && item.planItemCreated)).toBe(true);
    const reread = await db.getInvoice(saved.invoice.id);
    expect(reread).toMatchObject({ status: "open", baseCurrency: "YER", totalMinor: 80000, discountMinor: 5000 });
    expect(reread?.items.map(item => ({ tooth: item.toothCode, surfaces: item.surfaces, price: item.unitPriceMinor,
      quantity: item.quantity, doctor: item.doctorId, caseId: item.caseId }))).toEqual([
      { tooth: 16, surfaces: "MO", price: 25000, quantity: 1, doctor: doctorId, caseId: null },
      { tooth: 26, surfaces: "DB", price: 30000, quantity: 1, doctor: otherDoctorId, caseId: null },
      { tooth: 36, surfaces: "L", price: 25000, quantity: 1, doctor: doctorId, caseId: null },
    ]);
    const plans = await db.listPatientPlans(patientId, "2026-10-26");
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ id: saved.planId, totalMinor: 80000, consentAt: null, debtSource: "invoice",
      invoiceFinancial: { kind: "invoice_backed", remainingMinor: 75000, paidMinor: 0 },
      progress: { totalMinor: 75000, remainingMinor: 75000, paidMinor: 0 } });
    expect(plans[0].items.map(item => [item.toothCode, item.surfaces, item.status, item.billingStatus]))
      .toEqual([[16, "MO", "planned", "billed"], [26, "DB", "planned", "billed"], [36, "L", "planned", "billed"]]);
    expect((await snapshot(patientId)).cases).toEqual([]);
    expect((await snapshot(patientId)).payments).toEqual([]);
  });

  it("identical retries preserve all child identities; a second request cannot bill those teeth again", async () => {
    const patientId = await patient();
    const items = [line(26, "MO"), line(36, "DL")];
    const extra = { idempotencyKey: `fillings:${randomUUID()}`, requestHash: "synthetic-exact-filling-request" };
    const first = await create(patientId, items, extra);
    if (!first.ok) throw new Error(first.reason);
    const before = await snapshot(patientId);
    const retry = await create(patientId, items, extra);
    expect(retry).toMatchObject({ ok: true, replayed: true, invoice: { id: first.invoice.id }, links: first.links.map(item =>
      expect.objectContaining({ planItemId: item.planItemId, caseId: null })) });
    expect(await create(patientId, items)).toEqual({ ok: false, reason: "already_billed", line: 0 });
    expect((await linkage.previewInvoiceLinkage({ patientId, baseCurrency: "YER", items })).map(item => item.refusal))
      .toEqual(["already_billed", "already_billed"]);
    expect(await snapshot(patientId)).toEqual(before);
  });

  it("two rows for the same tooth remain a visible refusal even when their surfaces differ", async () => {
    const patientId = await patient();
    const items = [line(26, "MO"), line(26, "D")];
    expect((await linkage.previewInvoiceLinkage({ patientId, baseCurrency: "YER", items }))[1].refusal).toBe("existing_work");
    expect(await create(patientId, items)).toEqual({ ok: false, reason: "existing_work", line: 1 });
    expect(await snapshot(patientId)).toEqual({ invoices: [], plans: [], items: [], cases: [], payments: [] });
  });

  it.each([
    [{ toothCode: null }, "tooth_required"],
    [{ toothCode: 19 }, "bad_tooth"],
    [{ surfaces: "MX" }, "bad_surfaces"],
    [{ scope: "full_mouth" }, "bad_scope"],
    [{ episodeTeeth: [26, 36] }, "episode_split_required"],
    [{ episodeTeeth: [36] }, "episode_split_required"],
  ] as const)("refuses malformed clinical work %j before any partial invoice is retained", async (patch, reason) => {
    const patientId = await patient();
    const mutablePatch: Partial<LinkedInvoiceLineInput> = "episodeTeeth" in patch ? { episodeTeeth: [...patch.episodeTeeth] } : patch;
    const items = [line(16, "MO"), line(26, "DB", mutablePatch)];
    expect((await linkage.previewInvoiceLinkage({ patientId, baseCurrency: "YER", items }))[1].refusal).toBe(reason);
    expect(await create(patientId, items)).toEqual({ ok: false, reason, line: 1 });
    expect(await snapshot(patientId)).toEqual({ invoices: [], plans: [], items: [], cases: [], payments: [] });
  });

  it("existing plan work requires each tooth's own surfaces and reuses both exact identities", async () => {
    const patientId = await patient();
    const agreed = await db.createPlanV2({ patientId, title: "Synthetic agreed fillings", specialty: null,
      primaryDoctorId: doctorId, billingMode: "per_procedure", baseCurrency: "YER", startDate: "2026-10-26",
      note: null, createdBy: "synthetic-doctor", installments: [], items: [line(26, "MO"), line(36, "DB")].map(item => ({
        serviceId, serviceName: item.description, category: "filling", toothCode: item.toothCode, surfaces: item.surfaces ?? null,
        quantity: 1, unitPriceMinor: 25000, billingRule: "on_completion" as const, sessionCount: 1, note: null,
      })) });
    if (!agreed.ok) throw new Error(agreed.message);
    expect(await db.recordPlanConsent({ planId: agreed.planId, actor: "synthetic-doctor", note: null })).toMatchObject({ ok: true });
    const before = await snapshot(patientId);
    const wrong = [line(26, "DB"), line(36, "MO")];
    expect((await linkage.previewInvoiceLinkage({ patientId, baseCurrency: "YER", items: wrong })).map(item => item.refusal))
      .toEqual(["shape_mismatch", "shape_mismatch"]);
    expect(await create(patientId, wrong)).toEqual({ ok: false, reason: "shape_mismatch", line: 0 });
    expect(await snapshot(patientId)).toEqual(before);
    const saved = await create(patientId, [line(26, "MO"), line(36, "DB")]);
    if (!saved.ok) throw new Error(saved.reason);
    expect(saved.links.map(item => item.planItemId)).toEqual(before.items.map(item => item.id));
    expect(saved.links.every(item => !item.planItemCreated && item.caseId === null)).toBe(true);
    expect((await snapshot(patientId)).items).toHaveLength(2);
  });
});
