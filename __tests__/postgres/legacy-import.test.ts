import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (P1-5c) Old-system treatments and payments on PostgreSQL 18 — synthetic fixtures:
 * a read-only archive per patient, remaining balances as openings in their own
 * currency, owner assignments for unmatched rows, never twice, never over an
 * existing opening.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  ensureSchema, getPool, resetPoolForTesting, commitLegacyImport, patientLegacyHistory, patientLedger,
  setPatientOpeningBalance,
} = await import("../../lib/db");
const { readFirstSheet } = await import("../../lib/xlsx-reader");
const { parseLegacySessions, parseLegacyTreatments } = await import("../../lib/legacy-import");

const read = async (name: string) => readFirstSheet(
  new Uint8Array(readFileSync(`__tests__/fixtures/${name}`)), async (bytes) => new Uint8Array(inflateRawSync(bytes)));

let salem = 0;
let mona = 0;
let other = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const insert = async (number: string, name: string, phone: string | null) => (await getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, phone) VALUES ($1, $2, $3) RETURNING id`, [number, name, phone])).rows[0].id;
  salem = await insert("P-00001", "سالم تجربة احمد", "967771000001");
  mona = await insert("P-00002", "منى تجربة سعيد", null);
  other = await insert("P-00003", "مراد تجربة", null);
  // مُنى لها رصيدٌ يمنيٌّ مسجَّل سلفًا — الاستيراد لا يكتب فوقه.
  await setPatientOpeningBalance({ patientId: mona, amountMinor: 999, asOfDate: "2026-09-01", note: null, createdBy: "t" });
}, 120_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("commitLegacyImport", () => {
  it("archives treatments and payments, and opens balances in their own currency", async () => {
    const treatments = parseLegacyTreatments(await read("old-treatments.xlsx")).records;
    const sessions = parseLegacySessions(await read("old-sessions.xlsx")).records;
    const result = await commitLegacyImport({
      treatments, sessions, assignments: { 4: other }, fileSha256: "a".repeat(64), fileNames: "old.xlsx",
      asOfDate: "2026-09-25", actor: "admin", actorRole: "admin",
    });
    expect(result).toMatchObject({ ok: true, treatments: 5, sessions: 2, skippedTreatments: 0 });
    if (!result.ok) return;
    expect(result.conflicts).toEqual([{ patientId: mona, currency: "YER", amountMinor: 1250 }]);

    const { openings } = await patientLedger(salem);
    expect(openings.map((row) => [row.currency, row.amountMinor])).toEqual([["SAR", 167122], ["USD", 10000]]);
    expect(openings[0].note).toContain("#1");

    const monaOpenings = (await patientLedger(mona)).openings;
    expect(monaOpenings.map((row) => row.amountMinor)).toEqual([999]);

    const history = await patientLegacyHistory(salem);
    expect(history.treatments.map((row) => row.legacyNumber)).toEqual([1, 3, 5]);
    expect(history.treatments[0]).toMatchObject({ currency: "SAR", priceMinor: 200000, rate: 425, remainingMinor: 150000 });
    expect(history.treatments[0].payments).toEqual([expect.objectContaining({ legacyNumber: 1, amountMinor: 50000, currency: "SAR" })]);
    expect((await patientLegacyHistory(other)).treatments.map((row) => row.legacyNumber)).toEqual([4]);

    // لا شيء في الصندوق: الأرشيف لا يمسّ الدفعات ولا الفواتير.
    const { rows } = await getPool().query(`SELECT (SELECT COUNT(*) FROM payments)::int AS p, (SELECT COUNT(*) FROM invoices)::int AS i`);
    expect(rows[0]).toEqual({ p: 0, i: 0 });
  });

  it("refuses the same files twice", async () => {
    const treatments = parseLegacyTreatments(await read("old-treatments.xlsx")).records;
    const again = await commitLegacyImport({
      treatments, sessions: [], assignments: {}, fileSha256: "a".repeat(64), fileNames: "old.xlsx",
      asOfDate: "2026-09-25", actor: "admin", actorRole: "admin",
    });
    expect(again).toMatchObject({ ok: false, reason: "already_imported" });
  });

  it("a patient with old-system history is protected from deletion like financial history", async () => {
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT (SELECT COUNT(*) FROM legacy_treatments WHERE patient_id = $1)::text AS n`, [other]);
    expect(rows[0].n).toBe("1");
    await expect(getPool().query(`DELETE FROM patients WHERE id = $1`, [other])).rejects.toThrow(/legacy_treatments/);
  });
});
