/** M2 slice 92: invoice reads on the canonical runtime, real PostgreSQL, synthetic data only.
 * finance.invoices.view inside the patient scope; the legacy bodies from the same readers;
 * the ledger grant never substitutes; an invoice outside the scope reads like a missing one;
 * revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-invoice-reads-secret-92");
const db = await import("../../lib/db");
const reads = await import("../../lib/canonical-invoice-reads");
const archive = await import("../../lib/invoice-archive-db");

const VIEW = { "finance.invoices.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-IR-OWNER", role: "admin" },
  viewer: { username: "SYN-IR-VIEW", role: "accountant", patientScope: "all", grants: VIEW },
  ledger: { username: "SYN-IR-LEDGER", role: "accountant", patientScope: "all", grants: { "finance.patient-ledger.view": true } },
  doctor: { username: "SYN-IR-DR", role: "doctor", doctor: true, patientScope: "own", grants: VIEW },
  clinician: { username: "SYN-IR-CLIN", role: "doctor", doctor: true, patientScope: "all", grants: { "clinical.visits.document": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; message?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };
const ids = { mine: 0, other: 0, mineInvoice: 0, otherInvoice: 0 };
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,$2,$3) RETURNING id", [number, `SYN IR ${number}`, doctor]))[0].id as number;
  ids.mine = await patient("SYN-IR-1", fx.parties.doctor!);
  ids.other = await patient("SYN-IR-2", null);
  const invoice = async (patientId: number, number: string) =>
    (await q("INSERT INTO invoices(invoice_number,patient_id,base_currency,total_minor,discount_minor,created_by) VALUES($1,$2,'YER',42000,0,'SYN') RETURNING id", [number, patientId]))[0].id as number;
  ids.mineInvoice = await invoice(ids.mine, "SYN-IR-INV-1");
  ids.otherInvoice = await invoice(ids.other, "SYN-IR-INV-2");
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("invoice reads", () => {
  it("the bodies equal the legacy readers over the same rows", async () => {
    const viewer = await fx.session("viewer");
    expect(json(await reads.readCanonicalPatientInvoices(viewer, ids.mine))).toEqual(json(await db.listPatientInvoices(ids.mine)));
    expect(json(await reads.readCanonicalInvoice(viewer, ids.otherInvoice))).toEqual(json(await db.getInvoice(ids.otherInvoice)));
    const client = await fx.pool.connect();
    try {
      expect(json(await reads.readCanonicalInvoiceArchiveList(viewer, ids.mine))).toEqual(json(await archive.listInvoiceArchiveWith(client as never, ids.mine)));
      expect(json(await reads.readCanonicalInvoiceArchive(viewer, ids.mineInvoice)))
        .toEqual(json(await archive.invoiceArchiveViewWith(client as never, (await db.getInvoice(ids.mineInvoice))!)));
    } finally { client.release(); }
  });

  it("refused without finance.invoices.view: the ledger grant and clinical grants never substitute", async () => {
    for (const key of ["ledger", "clinician"] as const) {
      const session = await fx.session(key);
      for (const read of [
        () => reads.readCanonicalPatientInvoices(session, ids.mine), () => reads.readCanonicalInvoice(session, ids.mineInvoice),
        () => reads.readCanonicalInvoiceArchiveList(session, ids.mine), () => reads.readCanonicalInvoiceArchive(session, ids.mineInvoice),
      ]) expect(await refusal(read())).toMatchObject(denied);
    }
  });

  it("an own-scoped actor reads only its patients' invoices; outside and missing read alike; revocation", async () => {
    const doctor = await fx.session("doctor");
    expect(await reads.readCanonicalInvoice(doctor, ids.mineInvoice)).toMatchObject({ id: ids.mineInvoice, totalMinor: 42000 });
    for (const read of [
      () => reads.readCanonicalInvoice(doctor, ids.otherInvoice), () => reads.readCanonicalInvoiceArchive(doctor, ids.otherInvoice),
      () => reads.readCanonicalPatientInvoices(doctor, ids.other), () => reads.readCanonicalInvoiceArchiveList(doctor, ids.other),
      () => reads.readCanonicalInvoice(doctor, 2147483000),
    ]) expect(await refusal(read())).toMatchObject({ code: "patient_not_found" });
    await fx.setGrants("viewer", { "finance.patient-ledger.view": true }, { patientScope: "all" });
    try {
      expect(await refusal(reads.readCanonicalInvoice(await fx.session("viewer"), ids.mineInvoice))).toMatchObject(denied);
    } finally { await fx.setGrants("viewer", VIEW, { patientScope: "all" }); }
  });
});
