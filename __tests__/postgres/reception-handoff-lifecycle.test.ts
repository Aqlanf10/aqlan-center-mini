import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const { completeReceptionHandoff, listReceptionHandoffs, readReceptionHandoff } = await import("../../lib/reception-handoff-db");
const reception = { actor: "synthetic-reception", actorRole: "reception" };
const action = "visit.reception_handoff_completed";
const q = (sql: string, values: unknown[] = []) => db.getPool().query(sql, values);
let sequence = 0, doctorId = 0, serviceId = 0;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  // This destructive fixture setup may only run against the repository's isolated
  // loopback CI database. Never a Railway or real clinic database.
  expect(["localhost", "127.0.0.1"]).toContain(url.hostname);
  expect(url.pathname).toBe("/aqlan_p1_test");
  await dropPublicSchema(url.toString());
  await db.ensureSchema();
  await db.openShift({ openedBy: "synthetic", opening: { YER: 0, SAR: 0, USD: 0 } });
  doctorId = (await q(`INSERT INTO parties (kind, name) VALUES ('doctor', 'طبيب اختبار اصطناعي') RETURNING id`)).rows[0].id;
  serviceId = (await q(`INSERT INTO services (name, category, price_minor, price_configured)
    VALUES ('حشوة اختبار اصطناعي', 'filling', 15000, TRUE) RETURNING id`)).rows[0].id;
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

async function fixture(options: { patientId?: number; billed?: boolean; unsigned?: boolean } = {}) {
  const patientId: number = options.patientId ?? (await q(`INSERT INTO patients (patient_number, full_name)
    VALUES ($1, 'مريض متابعة اصطناعي') RETURNING id`, [`HANDOFF-${++sequence}`])).rows[0].id;
  const visit = await db.addVisit({ patientId, patientName: "مريض متابعة اصطناعي", patientPhone: null, note: null, doctorId });
  await q(`UPDATE visits SET diagnosis = 'متابعة اصطناعية', treatment_done = 'عمل سريري موثق' WHERE id = $1`, [visit.id]);
  if (options.billed) await db.setVisitProcedures({ visitId: visit.id, procedures: [{ serviceId, toothCode: 16,
    surfaces: null, quantity: 1, unitPriceMinor: 15000, priceReason: null, doctorId, note: null, planItemId: null }] });
  let invoiceId: number | null = null;
  if (!options.unsigned) {
    const result = await db.signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: "synthetic-doctor", signerDoctorPartyId: doctorId });
    expect(result.reason).toBeNull();
    invoiceId = result.invoiceId;
  }
  const walkout = await db.visitWalkout(visit.id);
  return { patientId, visitId: visit.id, invoiceId, signedAt: walkout?.signedAt ?? "2026-10-10T09:00:00.000Z" };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const complete = (visit: Fixture, reason = "تمت مراجعة المهمة؛ متابعة التحصيل لاحقًا") => completeReceptionHandoff({
  visitId: visit.visitId, patientId: visit.patientId, signedAt: visit.signedAt, reason,
}, reception);
const audit = async (visitId: number) => (await q(`SELECT id, actor, actor_role, details FROM audit_log
  WHERE entity = 'visit' AND entity_id = $1 AND action = $2 ORDER BY id`, [String(visitId), action])).rows;
const item = async (visitId: number) => (await listReceptionHandoffs()).items.find(row => row.visitId === visitId);
async function payment(visit: Fixture, amountMinor: number, reversalOfId?: number) {
  const result = await db.recordPayment({ patientId: visit.patientId, invoiceId: visit.invoiceId,
    kind: reversalOfId ? "refund" : "payment", amountMinor, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
    method: "cash", note: "اختبار اصطناعي", createdBy: "synthetic-reception", reversalOfId });
  expect(result.reason).toBeNull();
  expect(result.payment).not.toBeNull();
  return result.payment!;
}
async function financeSnapshot(patientId: number, visitId: number) {
  return {
    invoices: (await q(`SELECT * FROM invoices WHERE patient_id = $1 ORDER BY id`, [patientId])).rows,
    payments: (await q(`SELECT * FROM payments WHERE patient_id = $1 ORDER BY id`, [patientId])).rows,
    ledger: await db.patientLedger(patientId),
    visit: (await q(`SELECT * FROM visits WHERE id = $1`, [visitId])).rows,
  };
}

describe("durable reception task lifecycle on PostgreSQL", () => {
  it("keeps no-invoice signatures pending despite zero balance, then handles without claiming debt clearance", async () => {
    const visit = await fixture();
    expect(visit.invoiceId).toBeNull();
    expect((await db.visitWalkout(visit.visitId))?.balances).toEqual([]);
    expect(await item(visit.visitId)).toMatchObject({ status: "pending", handledReason: null });
    await db.setPatientOpeningBalance({ patientId: visit.patientId, currency: "YER", amountMinor: 180000,
      asOfDate: "2026-01-01", note: null, createdBy: "synthetic", reason: null });
    const before = await financeSnapshot(visit.patientId, visit.visitId);
    expect(await complete(visit)).toMatchObject({ ok: true, status: "handled" });
    expect(await item(visit.visitId)).toMatchObject({ status: "handled", handledReason: "تمت مراجعة المهمة؛ متابعة التحصيل لاحقًا" });
    expect(await financeSnapshot(visit.patientId, visit.visitId)).toEqual(before);
    expect((await db.visitWalkout(visit.visitId))?.balances).toContainEqual({ currency: "YER", balanceMinor: 180000 });
  });
  it("serializes concurrent completion and recovers a lost response without duplicating the audit", async () => {
    const visit = await fixture();
    const results = await Promise.all([complete(visit, "الموظف الأول"), complete(visit, "الموظف الثاني")]);
    expect(results.every(result => result.ok)).toBe(true);
    const rows = await audit(visit.visitId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: reception.actor, actor_role: reception.actorRole,
      details: { patientId: visit.patientId, signedAt: visit.signedAt } });
    const retry = await complete(visit, "إعادة بعد فقدان الاستجابة");
    expect(retry).toMatchObject({ ok: true, handledReason: rows[0].details.reason });
    expect(results).toEqual([retry, retry]);
    expect(await audit(visit.visitId)).toHaveLength(1);
    const walkout = await db.visitWalkout(visit.visitId);
    expect(await readReceptionHandoff(visit.visitId, walkout!)).toMatchObject({ status: "handled", handledReason: rows[0].details.reason });
  });
  it("rolls back a rejected audit insert and permits a clean retry after the failure", async () => {
    const visit = await fixture();
    const before = await financeSnapshot(visit.patientId, visit.visitId);
    await q(`CREATE FUNCTION reject_test_handoff_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'visit.reception_handoff_completed' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
    await q(`CREATE TRIGGER reject_test_handoff BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_test_handoff_audit()`);
    try {
      await expect(complete(visit)).rejects.toThrow("synthetic audit failure");
      expect(await audit(visit.visitId)).toHaveLength(0);
      expect(await item(visit.visitId)).toMatchObject({ status: "pending" });
      expect(await financeSnapshot(visit.patientId, visit.visitId)).toEqual(before);
    } finally {
      await q(`DROP TRIGGER reject_test_handoff ON audit_log`);
      await q(`DROP FUNCTION reject_test_handoff_audit()`);
    }
    expect(await complete(visit)).toMatchObject({ ok: true });
    expect(await audit(visit.visitId)).toHaveLength(1);
  });
  it("keeps partial payment pending, collects only the exact invoice, and reopens on refund", async () => {
    const visit = await fixture({ billed: true });
    expect(visit.invoiceId).not.toBeNull();
    await db.setPatientOpeningBalance({ patientId: visit.patientId, currency: "YER", amountMinor: 180000,
      asOfDate: "2026-01-01", note: null, createdBy: "synthetic", reason: null });
    const first = await payment(visit, 5000);
    expect(await item(visit.visitId)).toMatchObject({ status: "pending" });
    await payment(visit, 10000);
    expect(await item(visit.visitId)).toMatchObject({ status: "collected", handledReason: null });
    expect((await db.visitWalkout(visit.visitId))?.balances).toContainEqual({ currency: "YER", balanceMinor: 180000 });
    await payment(visit, 2000, first.id);
    expect(await item(visit.visitId)).toMatchObject({ status: "pending" });
    expect(await audit(visit.visitId)).toHaveLength(0);
  });
  it.each(["handled", "deferred"] as const)("preserves explicit %s as a historical task decision after refund", async status => {
    const visit = await fixture({ billed: true });
    const receipt = await payment(visit, 15000);
    if (status === "handled") expect(await complete(visit)).toMatchObject({ ok: true });
    else expect(await db.deferVisitPayment(visit.visitId, reception, "المتبقي يُراجع لاحقًا")).toMatchObject({ ok: true });
    await payment(visit, 5000, receipt.id);
    expect(await item(visit.visitId)).toMatchObject({ status });
    expect((await db.visitWalkout(visit.visitId))?.checkout.invoicePaidMinor).toBe(10000);
  });
  it("does not conflate completion of an older visit with the same patient's newer visit", async () => {
    const older = await fixture();
    const newer = await fixture({ patientId: older.patientId });
    expect(await complete(older)).toMatchObject({ ok: true });
    expect(await item(older.visitId)).toMatchObject({ status: "handled" });
    expect(await item(newer.visitId)).toMatchObject({ status: "pending" });
    expect(await audit(newer.visitId)).toHaveLength(0);
  });
  it("never auto-closes a paid invoice with unresolved positive clinical work", async () => {
    const visit = await fixture({ billed: true });
    await payment(visit, 15000);
    expect(await item(visit.visitId)).toMatchObject({ status: "collected" });
    // Synthetic broken source linkage: financial receipts exist but the
    // positive-priced clinical line no longer has evidence of its own billing.
    await q(`UPDATE invoice_items SET source_type = NULL, source_id = NULL WHERE invoice_id = $1`, [visit.invoiceId]);
    expect((await db.visitWalkout(visit.visitId))?.lines).toContainEqual(expect.objectContaining({
      billingClass: "NO_CHARGE", unitPriceMinor: 15000,
    }));
    expect(await item(visit.visitId)).toMatchObject({ status: "pending" });
  });
  it("rejects cross-patient/unsigned/stale-signature targets and never reuses an old signature's completion", async () => {
    const visit = await fixture(), other = await fixture(), unsigned = await fixture({ unsigned: true });
    expect(await complete({ ...visit, patientId: other.patientId })).toEqual({ ok: false, reason: "stale" });
    expect(await complete(unsigned)).toEqual({ ok: false, reason: "not_signed" });
    expect(await audit(visit.visitId)).toHaveLength(0);
    expect(await complete(visit)).toMatchObject({ ok: true });
    await q(`UPDATE visits SET signed_at = signed_at + INTERVAL '1 second' WHERE id = $1`, [visit.visitId]);
    expect(await complete(visit)).toEqual({ ok: false, reason: "stale" });
    expect(await item(visit.visitId)).toMatchObject({ status: "pending" });
    const fresh = await db.visitWalkout(visit.visitId);
    expect(await complete({ ...visit, signedAt: fresh!.signedAt! })).toMatchObject({ ok: true });
    expect(await audit(visit.visitId)).toHaveLength(2);
  });
  it("does not carry an audit across a sub-millisecond signature change", async () => {
    const visit = await fixture();
    await q(`UPDATE visits SET signed_at = date_trunc('milliseconds', signed_at) WHERE id = $1`, [visit.visitId]);
    expect(await complete(visit)).toMatchObject({ ok: true });
    await q(`UPDATE visits SET signed_at = signed_at + INTERVAL '1 microsecond' WHERE id = $1`, [visit.visitId]);
    expect((await db.visitWalkout(visit.visitId))?.signedAt).toBe(visit.signedAt);
    expect(await item(visit.visitId)).toMatchObject({ status: "pending" });
  });
  it("rejects non-front-desk actors directly at the service boundary", async () => {
    const visit = await fixture();
    for (const actorRole of ["doctor", "assistant", "cashier", "accountant", null]) {
      expect(await completeReceptionHandoff({ ...visit, reason: "طلب غير مصرح" }, { actor: "spoof", actorRole }))
        .toEqual({ ok: false, reason: "forbidden" });
    }
    expect(await audit(visit.visitId)).toHaveLength(0);
  });
  it("does not close a zero/cancelled invoice or another patient's settled invoice", async () => {
    const empty = await fixture();
    const zero = (await q(`INSERT INTO invoices (invoice_number, patient_id, total_minor, base_currency)
      VALUES ($1, $2, 0, 'YER') RETURNING id`, [`ZERO-${++sequence}`, empty.patientId])).rows[0].id;
    await q(`UPDATE visits SET invoice_id = $2 WHERE id = $1`, [empty.visitId, zero]);
    expect(await item(empty.visitId)).toMatchObject({ status: "pending" });
    const paid = await fixture({ billed: true });
    await payment(paid, 15000);
    expect(await item(paid.visitId)).toMatchObject({ status: "collected" });
    await q(`UPDATE visits SET invoice_id = $2 WHERE id = $1`, [empty.visitId, paid.invoiceId]);
    expect(await item(empty.visitId)).toMatchObject({ status: "pending" });
    await q(`UPDATE invoices SET status = 'cancelled' WHERE id = $1`, [paid.invoiceId]);
    expect(await item(paid.visitId)).toMatchObject({ status: "pending" });
  });
});
