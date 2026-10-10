import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl(); stubPostgresEnv();
const db = await import("../../lib/db");
const operational = await import("../../lib/operational-checkout-db");
const signed = await import("../../lib/reception-handoff-db");
const actor = { actor: "synthetic-manager", actorRole: "admin" };
const q = (sql: string, values: unknown[] = []) => db.getPool().query(sql, values);
let sequence = 0, doctorId = 0, serviceId = 0;
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  expect(["localhost", "127.0.0.1"]).toContain(url.hostname); expect(url.pathname).toBe("/aqlan_p1_test");
  await dropPublicSchema(url.toString()); await db.ensureSchema();
  await db.openShift({ openedBy: actor.actor, opening: { YER: 0, SAR: 0, USD: 0 } });
  doctorId = (await q(`INSERT INTO parties (kind, name) VALUES ('doctor', 'طبيب اصطناعي') RETURNING id`)).rows[0].id;
  serviceId = (await q(`INSERT INTO services (name, category, price_minor, price_configured) VALUES ('عمل اصطناعي', 'filling', 15000, TRUE) RETURNING id`)).rows[0].id;
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });
async function fixture() {
  const patientId = (await q(`INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض اصطناعي للخروج') RETURNING id`, [`OP-${++sequence}`])).rows[0].id as number;
  const visit = await db.addVisit({ patientId, patientName: "مريض اصطناعي للخروج", patientPhone: null, note: null, doctorId });
  await db.seatVisit(visit.id, 1, actor); await db.finishVisit(visit.id, actor);
  return { patientId, visitId: visit.id };
}
async function decide(visit: Awaited<ReturnType<typeof fixture>>, status: "handled" | "deferred" = "handled") {
  const read = await operational.readOperationalHandoff(visit.visitId, visit.patientId);
  expect(read).not.toBeNull();
  return operational.decideOperationalHandoff({ ...visit, finishVersion: read!.item.finishVersion,
    receivable: read!.receivable, status, reason: "قرار استقبال اصطناعي موثّق" }, actor);
}
async function sign(visitId: number, billed = false) {
  await q(`UPDATE visits SET diagnosis = 'تشخيص اصطناعي', treatment_done = 'عمل سريري موثق' WHERE id = $1`, [visitId]);
  if (billed) await db.setVisitProcedures({ visitId, procedures: [{ serviceId, toothCode: 16, surfaces: null,
    quantity: 1, unitPriceMinor: 15000, priceReason: null, doctorId, note: null, planItemId: null }] });
  const result = await db.signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "synthetic-doctor", signerDoctorPartyId: doctorId });
  expect(result.reason).toBeNull(); return result;
}
const signedItem = async (id: number) => (await signed.listReceptionHandoffs()).items.find(row => row.visitId === id);
const audits = async (id: number) => (await q(`SELECT details FROM audit_log WHERE entity = 'visit' AND entity_id = $1 AND action = $2 ORDER BY id`, [String(id), operational.OPERATIONAL_HANDOFF_ACTION])).rows;
async function payment(patientId: number, invoiceId: number, amountMinor: number, reversalOfId?: number) {
  const result = await db.recordPayment({ patientId, invoiceId, kind: reversalOfId ? "refund" : "payment", amountMinor,
    currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash", note: "سند اصطناعي", createdBy: actor.actor, reversalOfId });
  expect(result.reason).toBeNull(); expect(result.payment).not.toBeNull(); return result.payment!;
}
describe("manager chair finish and independent clinical signature", () => {
  it("the real finish writer frees the chair, exposes a pending operational task and creates neither invoice nor signature", async () => {
    const visit = await fixture();
    const stored = (await q(`SELECT status, signed_at, invoice_id, finished_at FROM visits WHERE id = $1`, [visit.visitId])).rows[0];
    expect(stored).toMatchObject({ status: "done", signed_at: null, invoice_id: null, finished_at: expect.any(Date) });
    expect((await operational.listOperationalHandoffs()).items.filter(row => row.visitId === visit.visitId)).toHaveLength(1);
    expect(await signedItem(visit.visitId)).toBeUndefined();
    const next = await db.addVisit({ patientName: "انتظار اصطناعي", patientPhone: null, note: null });
    expect(await db.seatVisit(next.id, 1, actor)).not.toBeNull(); await db.finishVisit(next.id, actor);
    expect((await q(`SELECT id FROM invoices WHERE patient_id = $1`, [visit.patientId])).rows).toHaveLength(0);
  });
  it.each(["handled", "deferred"] as const)("carries %s across late signing with no new receivable and preserves its original audit", async status => {
    const visit = await fixture(); const before = await db.patientLedger(visit.patientId);
    expect(await decide(visit, status)).toMatchObject({ ok: true, item: { status } });
    expect(await decide(visit, status)).toMatchObject({ ok: true, item: { status } });
    expect(await db.patientLedger(visit.patientId)).toEqual(before); expect(await audits(visit.visitId)).toHaveLength(1);
    const result = await sign(visit.visitId); expect(result.invoiceId).toBeNull();
    expect(await signedItem(visit.visitId)).toMatchObject({ status, handledReason: "قرار استقبال اصطناعي موثّق" });
    const walkout = await db.visitWalkout(visit.visitId);
    expect(await signed.readReceptionHandoff(visit.visitId, walkout!)).toMatchObject({ status });
    expect((await operational.listOperationalHandoffs()).items.some(row => row.visitId === visit.visitId)).toBe(false);
    expect(await operational.readOperationalHandoff(visit.visitId, visit.patientId)).toBeNull();
  });
  it("never associates an unrelated paid account invoice; explicit handling plus no-charge signing causes no second invoice", async () => {
    const visit = await fixture();
    const invoice = await db.createInvoice({ patientId: visit.patientId, baseCurrency: "YER", discountMinor: 0, note: null,
      createdBy: actor.actor, items: [{ serviceId: null, doctorId, description: "فاتورة حساب منفصلة", quantity: 1, unitPriceMinor: 24000 }] });
    await payment(visit.patientId, invoice!.id, 24000);
    expect(await operational.readOperationalHandoff(visit.visitId, visit.patientId)).toMatchObject({ receivable: null, item: { status: "pending" } });
    expect((await q(`SELECT invoice_id FROM visits WHERE id = $1`, [visit.visitId])).rows[0].invoice_id).toBeNull();
    await decide(visit); const result = await sign(visit.visitId);
    expect(result.invoiceId).toBeNull(); expect(await signedItem(visit.visitId)).toMatchObject({ status: "handled" });
    expect((await db.patientLedger(visit.patientId)).invoices.map(row => row.id)).toEqual([invoice!.id]);
  });
  it("new clinical charges reopen deferred review, exact payment collects, and refund reopens without erasing the earlier decision", async () => {
    const visit = await fixture(); await decide(visit, "deferred");
    const result = await sign(visit.visitId, true); expect(result.invoiceId).not.toBeNull();
    expect(await signedItem(visit.visitId)).toMatchObject({ status: "pending", handledReason: expect.stringContaining("القرار السابق") });
    const receipt = await payment(visit.patientId, result.invoiceId!, 15000);
    expect(await signedItem(visit.visitId)).toMatchObject({ status: "collected" });
    await payment(visit.patientId, result.invoiceId!, 1000, receipt.id);
    expect(await signedItem(visit.visitId)).toMatchObject({ status: "pending" });
    expect(await audits(visit.visitId)).toHaveLength(1);
    expect((await db.patientLedger(visit.patientId)).payments).toHaveLength(2);
  });
  it("rejects wrong owner/version/authority and exposes older finishes only in their explicit clinic-day window", async () => {
    const visit = await fixture(), read = (await operational.readOperationalHandoff(visit.visitId, visit.patientId))!;
    const input = { ...visit, finishVersion: read.item.finishVersion, receivable: read.receivable, status: "handled" as const, reason: "قرار اصطناعي" };
    for (const role of ["doctor", "assistant", "accountant", "cashier"]) expect(await operational.decideOperationalHandoff(input, { actor: "synthetic", actorRole: role })).toMatchObject({ ok: false, reason: "forbidden" });
    expect(await operational.decideOperationalHandoff({ ...input, patientId: visit.patientId + 100000 }, actor)).toMatchObject({ ok: false, reason: "stale" });
    expect(await operational.decideOperationalHandoff({ ...input, finishVersion: "finished:2026-01-01T09:00:00.000000Z" }, actor)).toMatchObject({ ok: false, reason: "stale" });
    await q(`UPDATE visits SET finished_at = '2026-09-08T21:00:00Z' WHERE id = $1`, [visit.visitId]);
    expect((await operational.listOperationalHandoffs("2026-09-09")).items.some(row => row.visitId === visit.visitId)).toBe(true);
    expect((await operational.listOperationalHandoffs("2026-09-08")).items.some(row => row.visitId === visit.visitId)).toBe(false);
    expect(await audits(visit.visitId)).toHaveLength(0);
  });
  it("serializes a late signature racing an unsigned decision without manufacturing a second task or financial write", async () => {
    const visit = await fixture();
    await q(`UPDATE visits SET diagnosis = 'تشخيص اصطناعي', treatment_done = 'توثيق اصطناعي' WHERE id = $1`, [visit.visitId]);
    const read = (await operational.readOperationalHandoff(visit.visitId, visit.patientId))!;
    const [decision, signature] = await Promise.all([
      operational.decideOperationalHandoff({ ...visit, finishVersion: read.item.finishVersion, receivable: null, status: "deferred", reason: "تأجيل اصطناعي متزامن" }, actor),
      db.signClinicalVisit({ visitId: visit.visitId, baseCurrency: "YER", signedBy: "synthetic-doctor", signerDoctorPartyId: doctorId }),
    ]);
    expect(signature.reason).toBeNull(); expect(signature.invoiceId).toBeNull();
    expect(await signedItem(visit.visitId)).toMatchObject({ status: decision.ok ? "deferred" : "pending" });
    if (!decision.ok) expect(decision.reason).toBe("stale");
    expect((await operational.listOperationalHandoffs()).items.some(row => row.visitId === visit.visitId)).toBe(false);
    expect(await audits(visit.visitId)).toHaveLength(decision.ok ? 1 : 0);
    expect((await db.patientLedger(visit.patientId)).invoices).toHaveLength(0);
  });
});

type Observed<T> = { settled: () => boolean; outcome: Promise<{ ok: true; value: T } | { ok: false; error: unknown }> };
function observe<T>(promise: Promise<T>): Observed<T> {
  let settled = false;
  const outcome = promise.then(value => { settled = true; return { ok: true as const, value }; },
    error => { settled = true; return { ok: false as const, error }; });
  return { settled: () => settled, outcome };
}
async function result<T>(observed: Observed<T>): Promise<T> {
  const outcome = await observed.outcome; if (!outcome.ok) throw outcome.error; return outcome.value;
}
async function exactBlockedWriters(blockerPid: number, queries: readonly string[], writers: readonly { settled: () => boolean }[]) {
  let witnessed: { pid: number; query: string; blockers: number[] }[] = [];
  const normalized = (query: string) => query.replace(/\s+/g, " ").trim();
  await expect.poll(async () => {
    const { rows } = await q(`WITH RECURSIVE blocked(pid) AS (SELECT $1::int UNION
      SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid)))
      SELECT a.pid, a.query, pg_blocking_pids(a.pid) AS blockers FROM pg_stat_activity a JOIN blocked b ON b.pid = a.pid
      WHERE a.pid <> $1 AND a.datname = current_database() AND a.wait_event_type = 'Lock'`, [blockerPid]);
    witnessed = rows;
    return { settled: writers.filter(writer => writer.settled()).length,
      queries: rows.map(row => normalized(row.query)).sort(), distinct: new Set(rows.map(row => row.pid)).size };
  }, { timeout: 10_000 }).toEqual({ settled: 0, queries: queries.map(normalized).sort(), distinct: queries.length });
  const pids = new Set([blockerPid, ...witnessed.map(row => row.pid)]);
  for (const row of witnessed) expect(row.blockers.some(pid => pids.has(pid))).toBe(true);
  return witnessed.map(row => row.pid);
}

it("two null-invoice decisions waiting on the same visit preserve exactly the first committed reason", async () => {
  const visit = await fixture(), read = (await operational.readOperationalHandoff(visit.visitId, visit.patientId))!;
  const blocker = await db.getPool().connect();
  const pending: Observed<Awaited<ReturnType<typeof operational.decideOperationalHandoff>>>[] = [];
  try {
    await blocker.query("BEGIN");
    const pid = (await blocker.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number;
    await blocker.query(`SELECT id FROM visits WHERE id = $1 FOR UPDATE`, [visit.visitId]);
    for (const reason of ["القرار الاصطناعي الأول", "القرار الاصطناعي الثاني"]) pending.push(observe(operational.decideOperationalHandoff({
      ...visit, finishVersion: read.item.finishVersion, receivable: null, status: "handled", reason,
    }, actor)));
    const pids = await exactBlockedWriters(pid, Array(2).fill("SELECT v.id FROM visits v WHERE v.id = $1 FOR UPDATE OF v"), pending);
    expect(pids).toHaveLength(2);
    await blocker.query("COMMIT");
    const results = await Promise.all(pending.map(result));
    expect(results.every(value => value.ok)).toBe(true);
    const audit = await audits(visit.visitId); expect(audit).toHaveLength(1);
    for (const value of results) expect(value).toMatchObject({ ok: true, item: { handledReason: audit[0].details.reason } });
  } finally {
    await blocker.query("ROLLBACK").catch(() => {}); blocker.release();
    await Promise.all(pending.map(writer => writer.outcome));
  }
});

it.each(["handled", "deferred"] as const)("keeps legacy %s historical, flags missing proof, and reflags refund/correction without clearing account debt", async status => {
  const visit = await fixture(), signedResult = await sign(visit.visitId, true);
  const receipt = await payment(visit.patientId, signedResult.invoiceId!, 15000);
  const identity = (await q(`SELECT signed_at, to_char(signed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version FROM visits WHERE id = $1`, [visit.visitId])).rows[0];
  await db.recordAudit({ action: status === "handled" ? "visit.reception_handoff_completed" : "visit.payment_deferred",
    entity: "visit", entityId: visit.visitId, actor: actor.actor, actorRole: actor.actorRole,
    details: { patientId: visit.patientId, signedAt: identity.signed_at.toISOString(), signatureVersion: identity.version, reason: "قرار تاريخي اصطناعي بلا لقطة" } });
  expect(await signedItem(visit.visitId)).toMatchObject({ status, financialReviewRequired: true, visitInvoiceSettled: true });
  const proof = (await operational.readSignedReceptionVerification(visit.visitId, visit.patientId))!;
  const before = await db.patientLedger(visit.patientId);
  const request = { ...proof, reason: "إعادة تحقق اصطناعية موثّقة" };
  expect(await operational.verifySignedReception(request, actor)).toMatchObject({ ok: true });
  expect(await operational.verifySignedReception(request, actor)).toMatchObject({ ok: true });
  expect(await db.patientLedger(visit.patientId)).toEqual(before);
  expect((await q(`SELECT id FROM audit_log WHERE action = $1 AND entity_id = $2`, [operational.RECEPTION_VERIFICATION_ACTION, String(visit.visitId)])).rows).toHaveLength(1);
  expect(await signedItem(visit.visitId)).toMatchObject({ status, financialReviewRequired: false, visitInvoiceSettled: true });
  await payment(visit.patientId, signedResult.invoiceId!, 2000, receipt.id);
  expect(await signedItem(visit.visitId)).toMatchObject({ status, financialReviewRequired: true, visitInvoiceSettled: false });
  expect((await db.visitWalkout(visit.visitId))!.balances).toContainEqual({ currency: "YER", balanceMinor: 2000 });
  const original = (await db.getInvoice(signedResult.invoiceId!))!;
  const correction = await db.correctInvoice({ invoiceId: original.id,
    lines: original.items.map(item => ({ itemId: item.id, quantity: item.quantity, unitPriceMinor: item.unitPriceMinor + 1000 })),
    reason: "تصحيح اصطناعي بعد قرار تاريخي", actor: actor.actor, actorRole: actor.actorRole });
  expect(correction.ok).toBe(true);
  expect(await signedItem(visit.visitId)).toMatchObject({ status, financialReviewRequired: true });
  expect((await db.visitWalkout(visit.visitId))!.invoice?.id).not.toBe(original.id);
});

it.each(["refund", "correction"] as const)("observes exact invoice-lock writer PIDs for %s against a decision and never commits stale proof", async mutation => {
  const visit = await fixture();
  const invoice = (await db.createInvoice({ patientId: visit.patientId, baseCurrency: "YER", discountMinor: 0, note: null,
    createdBy: actor.actor, items: [{ serviceId: null, doctorId, description: "مرجع اصطناعي مرتبط صراحة", quantity: 1, unitPriceMinor: 10000 }] }))!;
  // An explicit fixture relationship, never an inferred production/account association.
  await q(`UPDATE visits SET invoice_id = $2 WHERE id = $1`, [visit.visitId, invoice.id]);
  const receipt = await payment(visit.patientId, invoice.id, 10000);
  const read = (await operational.readOperationalHandoff(visit.visitId, visit.patientId))!;
  const blocker = await db.getPool().connect();
  const drain: Promise<unknown>[] = [];
  try {
    await blocker.query("BEGIN"); const pid = (await blocker.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number;
    await blocker.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE`, [invoice.id]);
    const decision = observe(operational.decideOperationalHandoff({ ...visit, finishVersion: read.item.finishVersion,
      receivable: read.receivable, status: "handled", reason: "قرار اصطناعي متزامن" }, actor));
    drain.push(decision.outcome);
    const changed = observe<unknown>(mutation === "refund" ? payment(visit.patientId, invoice.id, 1000, receipt.id)
      : db.correctInvoice({ invoiceId: invoice.id, lines: invoice.items.map(item => ({ itemId: item.id, quantity: 1, unitPriceMinor: 11000 })),
        reason: "تصحيح اصطناعي متزامن", actor: actor.actor, actorRole: actor.actorRole }));
    drain.push(changed.outcome);
    await exactBlockedWriters(pid, ["SELECT id FROM invoices WHERE id = $1 FOR UPDATE", mutation === "refund"
      ? "SELECT base_currency, plan_id FROM invoices WHERE id = $1 AND patient_id = $2 FOR SHARE"
      : "SELECT id, invoice_number, patient_id, status, total_minor, discount_minor, base_currency, plan_id, created_at FROM invoices WHERE id = $1 FOR UPDATE"], [decision, changed]);
    await blocker.query("COMMIT");
    const decisionResult = await result(decision), change = await result(changed);
    if (mutation === "correction") expect(change).toMatchObject({ ok: true });
    if (!decisionResult.ok) expect(decisionResult.reason).toBe("stale");
    const after = (await operational.readOperationalHandoff(visit.visitId, visit.patientId))!;
    expect(after.item.status).toBe("pending");
    expect(await audits(visit.visitId)).toHaveLength(decisionResult.ok ? 1 : 0);
    if (mutation === "refund") expect(after.receivable).toMatchObject({ invoiceId: invoice.id, netMinor: 10000, paidMinor: 9000 });
    else expect(after.receivable?.invoiceId).not.toBe(invoice.id);
  } finally {
    await blocker.query("ROLLBACK").catch(() => {}); blocker.release(); await Promise.all(drain);
  }
});
