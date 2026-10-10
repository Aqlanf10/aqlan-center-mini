import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import { invoiceRequestFingerprint } from "../../lib/invoice-clinical-linkage";

assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const linkage = await import("../../lib/invoice-linkage-db");
const { listTreatmentFinancialReferences } = await import("../../lib/treatment-financial-context-db");
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await db.getPool().query(sql, params)).rows as T[];
let serviceId = 0;
let doctorId = 0;
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  doctorId = (await q<{ id: number }>("INSERT INTO parties (kind, name) VALUES ('doctor', 'Reference doctor') RETURNING id"))[0].id;
  serviceId = (await q<{ id: number }>(`INSERT INTO services (name, category, price_minor, is_active, price_configured)
    VALUES ('Reference restoration', 'filling', 10000, true, true) RETURNING id`))[0].id;
  await db.openShift({ openedBy: "reference-test", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180000);
afterAll(async () => { await db.resetPoolForTesting(); });
const patient = async (tag: string) => (await q<{ id: number }>(
  "INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id", [tag]))[0].id;
async function plan(patientId: number, toothCode: number) {
  const result = await db.createPlanV2({
    patientId, title: "Explicit plan", specialty: null, primaryDoctorId: doctorId, billingMode: "per_procedure",
    baseCurrency: "YER", startDate: "2026-10-01", note: null, createdBy: "reference-test", installments: [],
    items: [{ serviceId, serviceName: "Reference restoration", category: "filling", toothCode, surfaces: null,
      quantity: 1, unitPriceMinor: 10000, billingRule: "on_completion", sessionCount: 1, note: null }],
  });
  if (!result.ok) throw new Error(result.message);
  const [item] = await q<{ id: number }>("SELECT id FROM plan_items WHERE plan_id = $1 ORDER BY id", [result.planId]);
  return { id: result.planId, itemId: item.id };
}
function request(patientId: number, toothCode: number, existingPlanId: number | null = null, planItemId: number | null = null, key: string | null = null) {
  const items = [{ serviceId, category: "filling", doctorId, description: "Reference restoration", quantity: 1,
    unitPriceMinor: 10000, toothCode, caseId: null, sessions: 1, planItemId }];
  return {
    patientId, existingPlanId, baseCurrency: "YER" as const, discountMinor: 0, note: null,
    createdBy: "reference-test", actorRole: "admin", templates: DEFAULT_SPECIALTY_TEMPLATES, items,
    idempotencyKey: key, requestHash: key ? invoiceRequestFingerprint({
      patientId, existingPlanId, currency: "YER", discountMinor: 0, items,
    }) : null, auditDetails: {},
  };
}
const counts = async (patientId: number) => (await q<{ invoices: number; items: number; payments: number }>(`
  SELECT (SELECT COUNT(*)::int FROM invoices WHERE patient_id = $1) AS invoices,
    (SELECT COUNT(*)::int FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1) AS items,
    (SELECT COUNT(*)::int FROM payments WHERE patient_id = $1) AS payments`, [patientId]))[0];

describe("canonical explicit plan/item selection with actual writers", () => {
  it("keeps omitted selection ambiguous and adds fresh work only to the explicitly compatible plan", async () => {
    const id = await patient("EXPLICIT-MULTI");
    const a = await plan(id, 11); const b = await plan(id, 12);
    expect(await linkage.createLinkedInvoice(request(id, 21))).toMatchObject({ ok: false, reason: "incompatible_plan" });
    const choices = await linkage.invoicePlanChoices(db.getPool(), id, "YER");
    expect(choices).toEqual([{ id: a.id, compatible: true }, { id: b.id, compatible: true }]);
    const input = request(id, 21, a.id, null, "explicit-fresh-0001");
    const preview = await linkage.previewInvoiceLinkage(input);
    expect(preview[0].refusal).toBeNull();
    const created = await linkage.createLinkedInvoice(input);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.reason);
    expect(created.planId).toBe(a.id);
    expect((await q<{ plan_id: number }>("SELECT plan_id FROM plan_items WHERE id = $1", [created.links[0].planItemId]))[0].plan_id).toBe(a.id);
    expect(await counts(id)).toEqual({ invoices: 1, items: 3, payments: 0 });
    const replay = await linkage.createLinkedInvoice(input);
    expect(replay.ok && replay.replayed && replay.invoice.id === created.invoice.id).toBe(true);
    expect(await linkage.createLinkedInvoice(request(id, 21, b.id, null, input.idempotencyKey))).toMatchObject({ ok: false, reason: "idempotency_conflict" });
  });
  it("chooses an exact duplicate candidate without weakening financial lineage fences", async () => {
    const id = await patient("EXPLICIT-ITEM");
    const a = await plan(id, 36); const b = await plan(id, 36);
    const ambiguous = await linkage.previewInvoiceLinkage(request(id, 36));
    expect(ambiguous[0].refusal).toBe("ambiguous_item");
    expect(ambiguous[0].itemCandidates?.map((item) => item.id)).toEqual([a.itemId, b.itemId]);
    expect(await linkage.createLinkedInvoice(request(id, 36, a.id))).toMatchObject({ ok: false, reason: "ambiguous_item" });
    const input = request(id, 36, b.id, b.itemId, "explicit-item-0001");
    const results = await Promise.all([linkage.createLinkedInvoice(input), linkage.createLinkedInvoice(input)]);
    expect(results.every((result) => result.ok)).toBe(true);
    const invoiceIds = results.flatMap((result) => result.ok ? [result.invoice.id] : []);
    expect(new Set(invoiceIds).size).toBe(1);
    expect(results.some((result) => result.ok && result.replayed)).toBe(true);
    expect(await counts(id)).toEqual({ invoices: 1, items: 2, payments: 0 });
    // Selecting the other duplicate after billing cannot bypass the first item's lineage.
    expect(await linkage.createLinkedInvoice(request(id, 36, a.id, a.itemId))).toMatchObject({ ok: false, reason: "already_billed" });
  });
  it("refuses wrong-patient, stale, wrong-tooth and incompatible plan/item combinations without writes", async () => {
    const id = await patient("EXPLICIT-INVALID");
    const other = await patient("EXPLICIT-FOREIGN");
    const a = await plan(id, 11); const foreign = await plan(other, 12);
    const before = await counts(id);
    for (const input of [
      request(id, 21, foreign.id), request(id, 11, null, foreign.itemId),
      request(id, 12, a.id, a.itemId), request(id, 11, a.id, 2147483647),
    ]) {
      expect((await linkage.previewInvoiceLinkage(input))[0].refusal).not.toBeNull();
      expect((await linkage.createLinkedInvoice(input)).ok).toBe(false);
      expect(await counts(id)).toEqual(before);
    }
    expect(await db.setPlanStatus(a.id, "cancelled", { actor: "reference-test", actorRole: "admin", reason: "Synthetic closure" })).toBe("ok");
    expect(await linkage.createLinkedInvoice(request(id, 21, a.id))).toMatchObject({ ok: false, reason: "incompatible_plan" });
    expect(await counts(id)).toEqual(before);
  });
  it("rechecks a compatible preview after a real concurrent plan closure", async () => {
    const id = await patient("EXPLICIT-CLOSURE-RACE"); const a = await plan(id, 11);
    const input = request(id, 21, a.id);
    expect((await linkage.previewInvoiceLinkage(input))[0].refusal).toBeNull();
    const gate = await db.getPool().connect();
    let pending: ReturnType<typeof linkage.createLinkedInvoice> | undefined;
    let closing: ReturnType<typeof db.setPlanStatus> | undefined;
    try {
      await gate.query("BEGIN");
      const gatePid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await gate.query("SELECT id FROM treatment_plans WHERE id = $1 FOR UPDATE", [a.id]);
      // Queue the canonical closure first; the gate is only a synchronization lock, never a data writer.
      closing = db.setPlanStatus(a.id, "cancelled", { actor: "reference-test", actorRole: "admin", reason: "Synthetic concurrent closure" });
      void closing.catch(() => undefined); // Consume rejection immediately; assert outcome and drain below.
      const closureLockStatement = "SELECT status, title FROM treatment_plans WHERE id = $1 FOR UPDATE";
      const observedClosure = () => q<{ pid: number }>(
        `SELECT a.pid FROM pg_stat_activity a WHERE a.datname = current_database()
          AND a.state = 'active' AND a.wait_event_type = 'Lock' AND a.query = $2
          AND $1 = ANY(pg_blocking_pids(a.pid))`, [gatePid, closureLockStatement]);
      await expect.poll(async () => (await observedClosure()).length, { timeout: 5000, interval: 20 }).toBe(1);
      const closurePid = (await observedClosure())[0].pid;
      pending = linkage.createLinkedInvoice(input);
      void pending.catch(() => undefined);
      const writerLockStatement = "SELECT id FROM treatment_plans WHERE patient_id = $1 ORDER BY id FOR UPDATE";
      const observedWriters = () => q<{ pid: number; query: string; blockers: number[] }>(
        `SELECT a.pid, a.query, pg_blocking_pids(a.pid) AS blockers FROM pg_stat_activity a
         WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
           AND a.state = 'active' AND a.wait_event_type = 'Lock'
           AND a.query = $2 AND $1 = ANY(pg_blocking_pids(a.pid))`, [closurePid, writerLockStatement]);
      await expect.poll(async () => (await observedWriters()).length, { timeout: 5000, interval: 20 }).toBe(1);
      const [blockedWriter] = await observedWriters();
      expect(blockedWriter.pid).not.toBe(closurePid);
      expect(blockedWriter.query).toBe(writerLockStatement);
      expect(blockedWriter.blockers).toContain(closurePid);
      expect((await q<{ blocked: boolean }>(
        "SELECT $2 = ANY(pg_blocking_pids($1)) AS blocked", [blockedWriter.pid, closurePid]))[0].blocked).toBe(true);
      await gate.query("COMMIT");
      expect(await closing).toBe("ok");
      expect(await pending).toMatchObject({ ok: false, reason: "incompatible_plan" });
      expect(await counts(id)).toEqual({ invoices: 0, items: 1, payments: 0 });
    } finally {
      await gate.query("ROLLBACK"); gate.release();
      await Promise.allSettled([closing, pending]);
    }
  });
  it("reads invoice/payment/correction identity using actual writers and never posts while projecting", async () => {
    const id = await patient("REFERENCE-WRITERS");
    const issued = await linkage.createLinkedInvoice(request(id, 26));
    if (!issued.ok) throw new Error(issued.reason);
    const paid = await db.recordPayment({ patientId: id, invoiceId: issued.invoice.id, kind: "payment",
      amountMinor: 3000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      method: "cash", note: null, createdBy: "reference-test", idempotencyKey: "reference-receipt-0001" });
    expect(paid.payment).not.toBeNull();
    const original = await db.getInvoice(issued.invoice.id);
    if (!original) throw new Error("Missing invoice");
    const corrected = await db.correctInvoice({ invoiceId: original.id,
      lines: [{ itemId: original.items[0].id, quantity: 1, unitPriceMinor: 5000 }],
      reason: "Synthetic reviewed price correction", actor: "reference-test", actorRole: "admin" });
    expect(corrected.ok).toBe(true);
    const before = await counts(id);
    const result = await listTreatmentFinancialReferences(id);
    expect(result?.references[0].invoiceIds).toHaveLength(2);
    expect(result?.documents.find((document) => document.invoiceId === original.id)).toMatchObject({
      status: "cancelled", directlyLinkedSettledMinor: 3000, allocatedRemainingMinor: null,
    });
    expect(result?.accountPositions.YER.dueMinor).toBe(2000);
    expect(await counts(id)).toEqual(before);
    const ledger = await db.patientLedger(id);
    expect(result?.accountPositions).toEqual(db.ledgerBalancesByCurrency(id, ledger, new Map()));
  });
});
