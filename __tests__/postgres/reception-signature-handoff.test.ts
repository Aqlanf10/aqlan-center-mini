import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const { listReceptionHandoffs } = await import("../../lib/reception-handoff-db");
let doctorId = 0, sequence = 0;
const q = (sql: string, values: unknown[] = []) => db.getPool().query(sql, values);
async function fixture(done = true) {
  const patientId = (await q(`INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض تسليم اصطناعي') RETURNING id`, [`RH-${++sequence}`])).rows[0].id as number;
  const visit = await db.addVisit({ patientId, patientName: "مريض تسليم اصطناعي", patientPhone: null, note: null, doctorId });
  await q(`UPDATE visits SET status = $2, arrived_at = NOW() - INTERVAL '5 days', treatment_done = 'عمل موثق بلا فاتورة جديدة' WHERE id = $1`, [visit.id, done ? "done" : "waiting"]);
  return { patientId, visitId: visit.id };
}
const sign = (visitId: number) => db.signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "synthetic-doctor", signerDoctorPartyId: doctorId });
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  expect(["127.0.0.1", "localhost"]).toContain(url.hostname);
  expect(url.pathname).toBe("/aqlan_p1_test");
  await dropPublicSchema(url.toString());
  await db.ensureSchema();
  doctorId = (await q(`INSERT INTO parties (kind, name) VALUES ('doctor', 'طبيب التسليم الاصطناعي') RETURNING id`)).rows[0].id;
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

describe("signature discovery from committed canonical visits", () => {
  it("observes done→signed and an old arrival without generating any invoice or clearing opening debt", async () => {
    const { patientId, visitId } = await fixture();
    await db.setPatientOpeningBalance({ patientId, currency: "YER", amountMinor: 180_000, asOfDate: "2026-01-01", note: null, createdBy: "synthetic", reason: null });
    expect((await listReceptionHandoffs()).items.some(row => row.visitId === visitId)).toBe(false);
    expect(await sign(visitId)).toMatchObject({ reason: null, invoiceId: null });
    const items = (await listReceptionHandoffs()).items.filter(row => row.visitId === visitId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ patientId, patientNumber: `RH-${sequence}` });
    expect((await q(`SELECT status FROM visits WHERE id = $1`, [visitId])).rows[0].status).toBe("done");
    expect((await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).rows).toHaveLength(0);
    expect((await db.visitWalkout(visitId))?.balances).toContainEqual({ currency: "YER", balanceMinor: 180_000 });
  });
  it("discovers one logical entry after concurrent sign/retry, including a lost response", async () => {
    const { visitId } = await fixture();
    const results = await Promise.all([sign(visitId), sign(visitId)]);
    expect(results.filter(result => result.reason === null)).toHaveLength(1);
    expect(results.filter(result => result.reason === "already_signed")).toHaveLength(1);
    // A separate reception read recovers the result, with no delivery retry/writer needed.
    expect((await listReceptionHandoffs()).items.filter(row => row.visitId === visitId)).toHaveLength(1);
    expect((await sign(visitId)).reason).toBe("already_signed");
    expect((await listReceptionHandoffs()).items.filter(row => row.visitId === visitId)).toHaveLength(1);
  });
  it("discovers an adjustment-only signature without inventing another charge", async () => {
    const { patientId, visitId } = await fixture();
    await q(`UPDATE visits SET treatment_done = NULL, arrived_at = NOW(), status = 'waiting' WHERE id = $1`, [visitId]);
    const caseId = (await q(`INSERT INTO ortho_cases (patient_id, created_by, baseline_kind, baseline_recorded_at, legacy_financial_mode, responsible_doctor_id)
      VALUES ($1, 'synthetic', 'legacy', NOW(), 'opening_balance', $2) RETURNING id`, [patientId, doctorId])).rows[0].id as number;
    await db.setPatientOpeningBalance({ patientId, currency: "YER", amountMinor: 180_000, asOfDate: "2026-01-01", note: null, createdBy: "synthetic", reason: null });
    const { clinicDateString } = await import("../../lib/schedule");
    expect(await db.recordAdjustment({ caseId, visitId, doneOn: clinicDateString(new Date(), db.CLINIC_TIME_ZONE), phase: null,
      upperWire: "017x025 NiTi", lowerWire: null, elastics: "none", elasticNote: null, done: "شدّة دورية", nextWeeks: 4, note: null,
      recordedBy: "synthetic-doctor", actorRole: "doctor" })).toMatchObject({ ok: true });
    await q(`UPDATE visits SET status = 'done' WHERE id = $1`, [visitId]);
    expect(await sign(visitId)).toMatchObject({ reason: null, invoiceId: null, orthoBillingClass: "LEGACY_INCLUDED" });
    expect((await listReceptionHandoffs()).items.filter(row => row.visitId === visitId)).toHaveLength(1);
    expect((await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).rows).toHaveLength(0);
  });
  it("does not expose failed signing, uncommitted signatures, or a rolled-back signature", async () => {
    const { visitId } = await fixture();
    await q(`UPDATE visits SET treatment_done = NULL WHERE id = $1`, [visitId]);
    expect((await sign(visitId)).reason).toBe("empty");
    const writer = await db.getPool().connect();
    try {
      await writer.query("BEGIN");
      await writer.query(`UPDATE visits SET signed_at = NOW() WHERE id = $1`, [visitId]);
      expect((await listReceptionHandoffs()).items.some(row => row.visitId === visitId)).toBe(false);
      await writer.query("ROLLBACK");
    } finally { writer.release(); }
    expect((await listReceptionHandoffs()).items.some(row => row.visitId === visitId)).toBe(false);
  });
  it("uses signing-day clinic boundaries and makes older windows explicitly retrievable", async () => {
    const before = await fixture(), at = await fixture(), end = await fixture(), older = await fixture();
    for (const [id, stamp] of [[before.visitId, "2026-10-08T20:59:59Z"], [at.visitId, "2026-10-08T21:00:00Z"], [end.visitId, "2026-10-10T21:00:00Z"], [older.visitId, "2026-09-01T09:00:00Z"]]) {
      await q(`UPDATE visits SET signed_at = $2::timestamptz WHERE id = $1`, [id, stamp]);
    }
    expect(db.CLINIC_TIME_ZONE).toBe("Asia/Aden");
    const window = await listReceptionHandoffs("2026-10-10");
    expect(window).toMatchObject({ fromDate: "2026-10-09", toDate: "2026-10-10" });
    const ids = window.items.map(row => row.visitId);
    expect(ids).toContain(at.visitId); expect(ids).not.toContain(before.visitId); expect(ids).not.toContain(end.visitId);
    expect((await listReceptionHandoffs("2026-09-01")).items.map(row => row.visitId)).toContain(older.visitId);
  });
});
