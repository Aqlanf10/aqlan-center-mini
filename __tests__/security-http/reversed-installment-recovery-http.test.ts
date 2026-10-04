import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let sequence = 0;
beforeAll(async () => {
  h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  await db.query(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
    SELECT 'recovery-http', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`);
}, 120_000);
afterAll(async () => { await db?.end(); });

async function fixture() {
  sequence += 1;
  const { rows: [patient] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'Synthetic recovery HTTP') RETURNING id`, [`RECOVERY-HTTP-${Date.now()}-${sequence}`]);
  const { rows: [plan] } = await db.query<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, billing_mode, consent_at)
     VALUES ($1, 'Synthetic recovery agreement', 14000, 'YER', 'active', 'installments', NOW()) RETURNING id`, [patient.id]);
  await db.query(`INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
    VALUES ($1, 1, '2026-01-01', 7000), ($1, 2, '2026-02-01', 7000)`, [plan.id]);
  const issued = await authedMutation("/api/payments", h.sessions.reception, "POST",
    JSON.stringify({ patientId: patient.id, planId: plan.id, amount: "7000", currency: "YER", method: "cash" }),
    { "Idempotency-Key": `recovery-http-origin-${sequence}` });
  expect(issued.status).toBe(201);
  const origin = await issued.json() as { id: number; invoiceId: number; planId: number };
  const reversed = await authedMutation(`/api/payments/${origin.id}/correct`, h.sessions.admin, "POST",
    JSON.stringify({ mode: "void", reason: "Synthetic full reversal" }), { "Idempotency-Key": `recovery-http-void-${sequence}` });
  expect(reversed.status).toBe(201);
  return { patientId: patient.id, planId: plan.id, invoiceId: origin.invoiceId, originId: origin.id };
}
function body(target: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) {
  return { purpose: "reversed-installment-recovery", patientId: target.patientId, invoiceId: target.invoiceId,
    amount: "7000", currency: "YER", method: "cash", ...extra };
}
async function counts(patientId: number) {
  const { rows: [row] } = await db.query<{ invoices: number; payments: number }>(
    `SELECT (SELECT COUNT(*)::int FROM invoices WHERE patient_id = $1) AS invoices,
      (SELECT COUNT(*)::int FROM payments WHERE patient_id = $1) AS payments`, [patientId]);
  return row;
}

describe("backend-first explicit installment recovery through the real proxy and routes", () => {
  it("legacy plan, invoice and bare-account requests fail safely; explicit recovery reuses the original invoice/plan", async () => {
    const target = await fixture(); const before = await counts(target.patientId);
    const attempts = [
      { path: "/api/payments", payload: { patientId: target.patientId, planId: target.planId, amount: "7000", currency: "YER" } },
      { path: `/api/plans/${target.planId}`, payload: { amount: "7000", currency: "YER" } },
      { path: "/api/payments", payload: { patientId: target.patientId, invoiceId: target.invoiceId, amount: "7000", currency: "YER" } },
      { path: "/api/payments", payload: { patientId: target.patientId, amount: "7000", currency: "YER" } },
    ];
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      const response = await authedMutation(attempt.path, h.sessions.reception, "POST", JSON.stringify(attempt.payload),
        { "Idempotency-Key": `recovery-http-legacy-${sequence}-${index}` });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason: "issued_installment_recovery_required" });
    }
    expect(await counts(target.patientId)).toEqual(before);
    const ledger = await authedGet(`/api/patients/${target.patientId}/ledger`, h.sessions.reception);
    expect(ledger.status).toBe(200);
    expect(await ledger.json()).toMatchObject({ installmentRecovery: { recoveries: [expect.objectContaining({ invoiceId: target.invoiceId, planId: target.planId, remainingMinor: 7000 })] } });
    const key = { "Idempotency-Key": `recovery-http-explicit-${sequence}` };
    const recovered = await authedMutation("/api/payments", h.sessions.reception, "POST", JSON.stringify(body(target)), key);
    expect(recovered.status).toBe(201);
    const receipt = await recovered.json() as { id: number; invoiceId: number; planId: number };
    expect(receipt).toMatchObject({ invoiceId: target.invoiceId, planId: target.planId });
    expect(await counts(target.patientId)).toEqual({ invoices: 1, payments: 3 });
    const repeated = await authedMutation("/api/payments", h.sessions.reception, "POST", JSON.stringify(body(target)), key);
    expect(repeated.status).toBe(200); expect((await repeated.json() as { id: number }).id).toBe(receipt.id);
    const { rows: [audit] } = await db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM audit_log
      WHERE action = 'payment.recover_installment' AND entity_id = $1`, [String(receipt.id)]);
    expect(audit.count).toBe(1);
  });

  it("keeps unauthorized and fabricated recovery requests out before any financial write", async () => {
    const target = await fixture(); const before = await counts(target.patientId);
    const anon = await fetch(`${baseUrl}/api/payments`, { method: "POST", headers: { "Content-Type": "application/json", Origin: baseUrl,
      "Sec-Fetch-Site": "same-origin", "Idempotency-Key": "recovery-http-anonymous" }, body: JSON.stringify(body(target)), redirect: "manual" });
    expect(anon.status).toBe(401);
    const doctor = await authedMutation("/api/payments", h.sessions.doctorA, "POST", JSON.stringify(body(target)), { "Idempotency-Key": "recovery-http-doctor" });
    expect(doctor.status).toBe(403);
    const fabricated = await authedMutation("/api/payments", h.sessions.reception, "POST", JSON.stringify(body(target, { planId: target.planId })), { "Idempotency-Key": "recovery-http-fabricated" });
    expect(fabricated.status).toBe(400);
    const missingKey = await authedMutation("/api/payments", h.sessions.reception, "POST", JSON.stringify(body(target)));
    expect(missingKey.status).toBe(400); expect(await counts(target.patientId)).toEqual(before);
  });

  it("five real HTTP retries commit one receipt/audit and bind the key to exact intent", async () => {
    const target = await fixture(); const key = { "Idempotency-Key": `recovery-http-burst-${sequence}` };
    const responses = await Promise.all(Array.from({ length: 5 }, () =>
      authedMutation("/api/payments", h.sessions.reception, "POST", JSON.stringify(body(target)), key)));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(4);
    const receipts = await Promise.all(responses.map((response) => response.json())) as { id: number }[];
    expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(1);
    const changed = await authedMutation("/api/payments", h.sessions.reception, "POST", JSON.stringify(body(target, { amount: "6999" })), key);
    expect(changed.status).toBe(409); expect(await changed.json()).toMatchObject({ reason: "idempotency_conflict" });
    expect(await counts(target.patientId)).toEqual({ invoices: 1, payments: 3 });
  });

  it("ordinary unaffected invoice and account payments retain their accepted legacy path", async () => {
    const { rows: [patient] } = await db.query<{ id: number }>(`INSERT INTO patients (patient_number, full_name)
      VALUES ($1, 'Synthetic unaffected ordinary collection') RETURNING id`, [`RECOVERY-ORDINARY-${Date.now()}`]);
    const { rows: [invoice] } = await db.query<{ id: number }>(`INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by)
      VALUES ($1, $2, 1000, 0, 'YER', 'synthetic') RETURNING id`, [`RECOVERY-ORDINARY-INV-${Date.now()}`, patient.id]);
    for (const invoiceId of [invoice.id, undefined]) {
      const response = await authedMutation("/api/payments", h.sessions.reception, "POST",
        JSON.stringify({ patientId: patient.id, invoiceId, amount: "1000", currency: "YER", method: "cash" }));
      expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ planId: null });
    }
  });
});
