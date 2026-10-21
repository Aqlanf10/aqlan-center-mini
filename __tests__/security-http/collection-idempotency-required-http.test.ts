import { afterAll, beforeAll, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  await db.query(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
    SELECT 'synthetic-key-check', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`);
});
afterAll(async () => { await db?.end(); });

async function fixture() {
  const { rows: [patient] } = await db.query(`INSERT INTO patients (patient_number, full_name)
    VALUES ($1, 'Synthetic key boundary') RETURNING id`, [`SYN-KEY-${crypto.randomUUID()}`]);
  const { rows: [plan] } = await db.query(`INSERT INTO treatment_plans
    (patient_id, title, total_minor, base_currency, status, billing_mode, consent_at)
    VALUES ($1, 'Synthetic collection plan', 1000000, 'YER', 'active', 'installments', NOW()) RETURNING id`, [patient.id]);
  await db.query(`INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
    VALUES ($1, 1, CURRENT_DATE, 500000), ($1, 2, CURRENT_DATE, 500000)`, [plan.id]);
  const { rows: [invoice] } = await db.query(`INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by)
    VALUES ($1, $2, 1000000, 0, 'YER', 'synthetic') RETURNING id`, [`SYN-INV-${patient.id}`, patient.id]);
  return { patientId: patient.id as number, planId: plan.id as number, invoiceId: invoice.id as number };
}
function body(patientId: number, target: Record<string, unknown> = {}) {
  return JSON.stringify({ patientId, amount: "205000", currency: "YER", kind: "payment", method: "cash", ...target });
}
async function financialSnapshot() {
  const snapshot: Record<string, unknown> = {};
  // Include the drawer and all persisted commission tables, not just receipts and installment rows.
  const { rows: commissionTables } = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE '%commission%' ORDER BY tablename",
  );
  const tables = ["payments", "cashier_shifts", "invoices", "invoice_items", "plan_installments", "treatment_plans", "audit_log", "patient_opening_balances", ...commissionTables.map(row => row.tablename)];
  for (const table of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("Unexpected SQL identifier in snapshot");
    snapshot[table] = (await db.query(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]')) AS digest FROM "${table}" t`)).rows;
  }
  return snapshot;
}

it("rejects repeated missing, blank and malformed keys without any financial row changes on either collection door", async () => {
  const f = await fixture();
  for (const [path, target] of [
    ["/api/payments", {}], ["/api/payments", { invoiceId: f.invoiceId }],
    ["/api/payments", { openingCurrency: "YER" }], ["/api/payments", { planId: f.planId }],
    [`/api/plans/${f.planId}`, {}],
  ] as const) {
    for (const key of [null, "", "   ", "short", "invalid key", "x".repeat(129)]) {
      const before = await financialSnapshot();
      const headers: Record<string, string> = key === null ? {} : { "Idempotency-Key": key };
      const responses = await Promise.all([1, 2].map(() => authedMutation(path, h.sessions.reception, "POST", body(f.patientId, target), headers)));
      expect(responses.map(response => response.status)).toEqual([400, 400]);
      if (key === null || !key.trim()) for (const response of responses) expect(await response.json()).toMatchObject({ reason: "idempotency_key_required" });
      expect(await financialSnapshot()).toEqual(before);
    }
  }
});

it.each(["account", "invoice", "plan", "direct-plan"])("preserves same-key parallel/retry receipts and distinct legitimate payments: %s", async (door) => {
  const f = await fixture();
  const path = door === "direct-plan" ? `/api/plans/${f.planId}` : "/api/payments";
  const requestBody = body(f.patientId, door === "invoice" ? { invoiceId: f.invoiceId } : door === "plan" ? { planId: f.planId } : {});
  const key = { "Idempotency-Key": `synthetic-key-${f.patientId}` };
  const send = (headers: Record<string, string> = key, payload = requestBody) => authedMutation(path, h.sessions.reception, "POST", payload, headers);
  const responses = await Promise.all([send(), send(), send()]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 200, 201]);
  type Receipt = { id: number; receiptNumber: string };
  const receiptOf = async (payload: Receipt & { payment?: Receipt; paymentId?: number }) => {
    if (door !== "direct-plan") return payload.payment ?? payload;
    expect(Number.isSafeInteger(payload.paymentId)).toBe(true);
    const { rows: [receipt] } = await db.query<Receipt>(`SELECT id, receipt_number AS "receiptNumber" FROM payments WHERE id = $1`, [payload.paymentId]);
    expect(receipt).toBeDefined();
    return receipt;
  };
  const receipts: Receipt[] = [];
  for (const response of responses) receipts.push(await receiptOf(await response.json()));
  for (const receipt of receipts) { expect(receipt.id).toBeGreaterThan(0); expect(receipt.receiptNumber).toBeTruthy(); }
  expect(new Set(receipts.map(receipt => receipt.id)).size).toBe(1);
  expect(new Set(receipts.map(receipt => receipt.receiptNumber)).size).toBe(1);
  // Discard the original response; a later client retries the exact serialized command.
  const replay = await send();
  expect(replay.status).toBe(200);
  expect((await receiptOf(await replay.json())).id).toBe(receipts[0].id);
  const beforeConflict = await financialSnapshot();
  const changed = await send(key, requestBody.replace('"205000"', '"205001"'));
  expect(changed.status).toBe(409);
  expect(await financialSnapshot()).toEqual(beforeConflict);
  // A distinct key for the same patient/amount/currency within 24h is an independent payment only
  // after the advisory review: first asked (nothing written), then recorded once confirmed.
  const otherKey = { "Idempotency-Key": `synthetic-other-${f.patientId}` };
  const beforeReview = await financialSnapshot();
  const asked = await send(otherKey);
  expect(asked.status).toBe(409);
  const review = await asked.json() as { reason: string; receipts: { id: number }[] };
  expect(review.reason).toBe("similar_collection_review_required");
  expect(review.receipts.map(receipt => receipt.id)).toEqual([receipts[0].id]);
  expect(await financialSnapshot()).toEqual(beforeReview);
  const independent = await send({ ...otherKey, "x-collection-similarity-review": `ids:${receipts[0].id}` });
  expect(independent.status).toBe(201);
  expect((await receiptOf(await independent.json())).id).not.toBe(receipts[0].id);
  const { rows } = await db.query(`SELECT count(*)::int AS count, sum(amount_minor)::text AS total FROM payments WHERE patient_id = $1`, [f.patientId]);
  expect(rows).toEqual([{ count: 2, total: "410000" }]);
  if (door === "plan" || door === "direct-plan") {
    const { rows: invoices } = await db.query(`SELECT count(*)::int AS count FROM invoices WHERE plan_id = $1`, [f.planId]);
    expect(invoices).toEqual([{ count: 2 }]);
  }
});
