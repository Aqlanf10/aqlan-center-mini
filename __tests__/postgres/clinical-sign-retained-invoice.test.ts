import { afterAll, beforeAll, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, rawPool, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl(); stubPostgresEnv();
const db = await import("../../lib/db");
const q = (sql: string, values: unknown[] = []) => db.getPool().query(sql, values);
const actor = { actor: "synthetic-sign-manager", actorRole: "admin" };
let sequence = 0, doctorId = 0, freeServiceId = 0;
let observer: ReturnType<typeof rawPool>;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  expect(["localhost", "127.0.0.1"]).toContain(url.hostname);
  expect(url.pathname).toBe("/aqlan_p1_test");
  observer = rawPool(url.toString(), 1);
  await dropPublicSchema(url.toString()); await db.ensureSchema();
  await db.openShift({ openedBy: actor.actor, opening: { YER: 0, SAR: 0, USD: 0 } });
  doctorId = (await q(`INSERT INTO parties (kind, name) VALUES ('doctor', 'طبيب اختبار حفظ الرابط') RETURNING id`)).rows[0].id;
  freeServiceId = (await q(`INSERT INTO services (name, category, price_minor, price_configured)
    VALUES ('توثيق مجاني اصطناعي', 'other', 0, TRUE) RETURNING id`)).rows[0].id;
}, 180_000);
afterAll(async () => { try { await observer?.end(); } finally { await db.resetPoolForTesting(); } });

async function fixture(currency: "YER" | "SAR" | "USD" = "YER", linked = true) {
  const patientId = (await q(`INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض اختبار توقيع المدير') RETURNING id`,
    [`SIGN-RETAIN-${++sequence}`])).rows[0].id as number;
  const invoice = await db.createInvoice({ patientId, baseCurrency: currency, discountMinor: 0, note: null,
    createdBy: actor.actor, items: [{ serviceId: null, doctorId, description: "فاتورة قائمة مستقلة عن التوقيع", quantity: 1, unitPriceMinor: 100000 }] });
  expect(invoice).not.toBeNull();
  const visit = await db.addVisit({ patientId, patientName: "مريض اختبار توقيع المدير", patientPhone: null, note: null, doctorId });
  // Explicit valid synthetic starting association; the invoice creation API is not changed or guessed.
  if (linked) await q(`UPDATE visits SET invoice_id = $2 WHERE id = $1`, [visit.id, invoice!.id]);
  await db.finishVisit(visit.id, actor);
  await q(`UPDATE visits SET diagnosis = 'تشخيص موثق', treatment_done = 'توثيق دون رسوم إضافية' WHERE id = $1`, [visit.id]);
  return { patientId, visitId: visit.id, invoiceId: invoice!.id, currency };
}
async function money(patientId: number) {
  const invoices = (await q(`SELECT to_jsonb(i) AS row FROM invoices i WHERE patient_id = $1 ORDER BY id`, [patientId])).rows;
  const items = (await q(`SELECT to_jsonb(ii) AS row FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.patient_id = $1 ORDER BY ii.id`, [patientId])).rows;
  const receipts = (await q(`SELECT to_jsonb(p) AS row FROM payments p WHERE patient_id = $1 ORDER BY id`, [patientId])).rows;
  return { invoices, items, receipts };
}
const sign = (visitId: number) => db.signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: actor.actor, signerRole: "admin" });

it.each(["YER", "SAR", "USD"] as const)("manager no-charge signature retains the exact existing %s invoice and original receipts", async currency => {
  const f = await fixture(currency);
  const receipt = await db.recordPayment({ patientId: f.patientId, invoiceId: f.invoiceId, kind: "payment", amountMinor: 10000,
    currency, baseCurrency: currency, exchangeRate: 1, method: "cash", note: "سند أصلي اصطناعي", createdBy: actor.actor });
  expect(receipt.reason).toBeNull();
  const before = await money(f.patientId);
  const result = await sign(f.visitId);
  expect(result.reason).toBeNull(); expect(result.invoiceId).toBeNull(); expect(result.duesMinor).toBe(0);
  expect(result.invoiceCurrency).toBe(currency);
  expect((await q(`SELECT invoice_id, doctor_id, signed_by, signed_at FROM visits WHERE id = $1`, [f.visitId])).rows[0])
    .toMatchObject({ invoice_id: f.invoiceId, doctor_id: doctorId, signed_by: actor.actor, signed_at: expect.any(Date) });
  expect(result.visit?.invoiceId).toBe(f.invoiceId);
  expect(await money(f.patientId)).toEqual(before);
  const signedAt = (await q(`SELECT signed_at FROM visits WHERE id = $1`, [f.visitId])).rows[0].signed_at;
  expect((await sign(f.visitId)).reason).toBe("already_signed");
  expect((await q(`SELECT invoice_id, signed_at FROM visits WHERE id = $1`, [f.visitId])).rows[0])
    .toEqual({ invoice_id: f.invoiceId, signed_at: signedAt });
  expect(await money(f.patientId)).toEqual(before);
});

it("an explicitly zero-priced clinical procedure creates no second invoice and keeps the old link", async () => {
  const f = await fixture();
  await db.setVisitProcedures({ visitId: f.visitId, procedures: [{ serviceId: freeServiceId, toothCode: null, surfaces: null,
    quantity: 1, unitPriceMinor: 0, priceReason: null, doctorId, note: null, planItemId: null }] });
  const before = await money(f.patientId), result = await sign(f.visitId);
  expect(result.reason).toBeNull(); expect(result.invoiceId).toBeNull(); expect(result.duesMinor).toBe(0);
  expect(result.visit?.invoiceId).toBe(f.invoiceId); expect(await money(f.patientId)).toEqual(before);
});

it("a forged cross-patient invoice link refuses signing without changing money or the treating doctor", async () => {
  const f = await fixture(), other = await fixture();
  await q(`UPDATE visits SET invoice_id = $2 WHERE id = $1`, [f.visitId, other.invoiceId]);
  const before = [await money(f.patientId), await money(other.patientId)];
  await expect(sign(f.visitId)).rejects.toBeInstanceOf(db.ClinicalPlanConflict);
  expect((await q(`SELECT signed_at, signed_by, doctor_id, invoice_id FROM visits WHERE id = $1`, [f.visitId])).rows[0])
    .toEqual({ signed_at: null, signed_by: null, doctor_id: doctorId, invoice_id: other.invoiceId });
  expect([await money(f.patientId), await money(other.patientId)]).toEqual(before);
});

it("an unlinked visit never guesses an unrelated invoice belonging to the same patient", async () => {
  const f = await fixture("YER", false), before = await money(f.patientId);
  const result = await sign(f.visitId);
  expect(result.reason).toBeNull(); expect(result.invoiceId).toBeNull(); expect(result.visit?.invoiceId).toBeNull();
  expect(await money(f.patientId)).toEqual(before);
});

it("no-charge signing preserves an explicitly cancelled owned reference rather than choosing a replacement", async () => {
  const f = await fixture();
  // Cancellation state is fixture setup; signing does not perform cancellation or unlinking.
  await q(`UPDATE invoices SET status = 'cancelled' WHERE id = $1`, [f.invoiceId]);
  const before = await money(f.patientId), result = await sign(f.visitId);
  expect(result.reason).toBeNull(); expect(result.invoiceId).toBeNull(); expect(result.visit?.invoiceId).toBe(f.invoiceId);
  expect(await money(f.patientId)).toEqual(before);
});

type Observed<T> = { settled: () => boolean; outcome: Promise<{ ok: true; value: T } | { ok: false; error: unknown }> };
function observe<T>(promise: Promise<T>): Observed<T> {
  let settled = false;
  return { settled: () => settled, outcome: promise.then(value => { settled = true; return { ok: true as const, value }; },
    error => { settled = true; return { ok: false as const, error }; }) };
}
async function unwrap<T>(writer: Observed<T>): Promise<T> {
  const result = await writer.outcome; if (!result.ok) throw result.error; return result.value;
}
async function blocked(gatePid: number, tableNames: string[], writers: { settled: () => boolean }[]) {
  let rows: { pid: number; query: string; blockers: number[] }[] = [];
  await expect.poll(async () => {
    rows = (await observer.query<{ pid: number; query: string; blockers: number[] }>(`WITH RECURSIVE blocked(pid) AS
      (SELECT $1::int UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid)))
      SELECT a.pid, a.query, pg_blocking_pids(a.pid) AS blockers FROM pg_stat_activity a JOIN blocked b ON a.pid = b.pid
      WHERE a.pid <> $1 AND a.datname = current_database() AND a.wait_event_type = 'Lock'`, [gatePid])).rows;
    return { pending: writers.filter(w => !w.settled()).length, distinct: new Set(rows.map(r => r.pid)).size,
      tables: rows.map(r => /FROM\s+(patients|visits|invoices)\b/i.exec(r.query)?.[1]).sort() };
  }, { timeout: 10_000 }).toEqual({ pending: writers.length, distinct: tableNames.length, tables: tableNames.sort() });
  const pids = new Set([gatePid, ...rows.map(r => r.pid)]);
  for (const row of rows) expect(row.blockers.some(pid => pids.has(pid))).toBe(true);
}

it("two signatures behind a real patient barrier preserve one signature, the original invoice and receipts", async () => {
  const f = await fixture(), before = await money(f.patientId), gate = await db.getPool().connect();
  const writers: Observed<Awaited<ReturnType<typeof sign>>>[] = [];
  try {
    await gate.query("BEGIN"); const pid = (await gate.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number;
    await gate.query(`SELECT id FROM patients WHERE id = $1 FOR UPDATE`, [f.patientId]);
    writers.push(observe(sign(f.visitId)), observe(sign(f.visitId)));
    await blocked(pid, ["patients", "patients"], writers);
    await gate.query("COMMIT");
    const results = await Promise.all(writers.map(unwrap));
    expect(results.map(r => r.reason).sort()).toEqual([null, "already_signed"].sort());
    expect((await q(`SELECT invoice_id, signed_by, doctor_id FROM visits WHERE id = $1`, [f.visitId])).rows[0])
      .toEqual({ invoice_id: f.invoiceId, signed_by: actor.actor, doctor_id: doctorId });
    expect(await money(f.patientId)).toEqual(before);
  } finally { await gate.query("ROLLBACK").catch(() => {}); gate.release(); await Promise.all(writers.map(w => w.outcome)); }
});

it.each(["visit-link", "invoice-owner"] as const)("refuses a changed %s after an actual blocked read without guessing a replacement", async drift => {
  const f = await fixture(), other = await fixture(), gate = await db.getPool().connect();
  let writer: Observed<Awaited<ReturnType<typeof sign>>> | undefined;
  const before = [await money(f.patientId), await money(other.patientId)];
  try {
    await gate.query("BEGIN"); const pid = (await gate.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number;
    await gate.query(drift === "visit-link" ? `SELECT id FROM visits WHERE id = $1 FOR UPDATE` : `SELECT id FROM invoices WHERE id = $1 FOR UPDATE`,
      [drift === "visit-link" ? f.visitId : f.invoiceId]);
    writer = observe(sign(f.visitId));
    await blocked(pid, [drift === "visit-link" ? "visits" : "invoices"], [writer]);
    if (drift === "visit-link") await gate.query(`UPDATE visits SET invoice_id = $2 WHERE id = $1`, [f.visitId, other.invoiceId]);
    else await gate.query(`UPDATE invoices SET patient_id = $2 WHERE id = $1`, [f.invoiceId, other.patientId]);
    await gate.query("COMMIT");
    const outcome = await writer.outcome;
    expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error).toBeInstanceOf(db.ClinicalPlanConflict);
    expect((await q(`SELECT signed_at, signed_by, doctor_id, invoice_id FROM visits WHERE id = $1`, [f.visitId])).rows[0])
      .toEqual({ signed_at: null, signed_by: null, doctor_id: doctorId, invoice_id: drift === "visit-link" ? other.invoiceId : f.invoiceId });
    if (drift === "visit-link") expect([await money(f.patientId), await money(other.patientId)]).toEqual(before);
    else {
      const after = [await money(f.patientId), await money(other.patientId)];
      // The barrier deliberately changed ownership; signing may make no additional money writes.
      expect(after[0].invoices).toHaveLength(0);
      const transferred = structuredClone(before[0].invoices[0]); transferred.row.patient_id = other.patientId;
      expect(after[1].invoices).toEqual([transferred, ...before[1].invoices].sort((a, b) => a.row.id - b.row.id));
      expect(after[0].receipts).toEqual(before[0].receipts); expect(after[1].receipts).toEqual(before[1].receipts);
      expect(after[1].items).toEqual([...before[0].items, ...before[1].items].sort((a, b) => a.row.id - b.row.id));
    }
  } finally { await gate.query("ROLLBACK").catch(() => {}); gate.release(); await writer?.outcome; }
});

it.each(["signature", "correction"] as const)("serializes %s first with the existing audited correction without unlinking or another invoice", async first => {
  const f = await fixture(), before = await money(f.patientId), gate = await db.getPool().connect();
  let signature: Observed<Awaited<ReturnType<typeof sign>>> | undefined;
  let correction: Observed<Awaited<ReturnType<typeof db.correctInvoice>>> | undefined;
  const itemId = before.items[0].row.id as number;
  try {
    await gate.query("BEGIN"); const pid = (await gate.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number;
    await gate.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE`, [f.invoiceId]);
    const startCorrection = () => observe(db.correctInvoice({ invoiceId: f.invoiceId,
      lines: [{ itemId, quantity: 1, unitPriceMinor: 99000 }], reason: "تصحيح معتمد اصطناعي", actor: actor.actor, actorRole: "admin" }));
    if (first === "signature") { signature = observe(sign(f.visitId)); await blocked(pid, ["invoices"], [signature]); correction = startCorrection(); }
    else { correction = startCorrection(); await blocked(pid, ["invoices"], [correction]); signature = observe(sign(f.visitId)); }
    await blocked(pid, ["invoices", "patients"], [signature, correction]);
    await gate.query("COMMIT");
    expect(await unwrap(correction)).toMatchObject({ ok: true });
    expect(await unwrap(signature)).toMatchObject({ reason: null, invoiceId: null, duesMinor: 0 });
    const after = await money(f.patientId), stored = (await q(`SELECT invoice_id, signed_by, doctor_id FROM visits WHERE id = $1`, [f.visitId])).rows[0];
    expect(after.invoices).toHaveLength(before.invoices.length + 1); expect(after.receipts).toEqual(before.receipts);
    expect(stored.invoice_id).not.toBe(f.invoiceId); expect(stored).toMatchObject({ signed_by: actor.actor, doctor_id: doctorId });
    expect(after.invoices.find(r => r.row.id === f.invoiceId)?.row.status).toBe("cancelled");
    expect(after.invoices.find(r => r.row.id === stored.invoice_id)?.row.patient_id).toBe(f.patientId);
    expect((await q(`SELECT details FROM audit_log WHERE action = 'invoice.correct' AND entity_id = $1`, [String(f.invoiceId)])).rows).toHaveLength(1);
  } finally { await gate.query("ROLLBACK").catch(() => {}); gate.release(); await Promise.all([signature?.outcome, correction?.outcome]); }
});
