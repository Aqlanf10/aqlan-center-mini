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

it("baseline: two identical unkeyed HTTP collections create two receipts", async () => {
  const { rows: [patient] } = await db.query(`INSERT INTO patients (patient_number, full_name)
    VALUES ('SYN-UNKEYED', 'Synthetic unkeyed collection') RETURNING id`);
  const body = JSON.stringify({ patientId: patient.id, amount: "205000", currency: "YER", kind: "payment", method: "cash" });
  const first = await authedMutation("/api/payments", h.sessions.reception, "POST", body);
  const second = await authedMutation("/api/payments", h.sessions.reception, "POST", body);
  expect([first.status, second.status]).toEqual([201, 201]);
  const receipts = await Promise.all([first.json(), second.json()]);
  expect(receipts[0].id).not.toBe(receipts[1].id);
  expect(receipts[0].receiptNumber).not.toBe(receipts[1].receiptNumber);
  const { rows } = await db.query(`SELECT amount_minor::text, idempotency_key FROM payments WHERE patient_id = $1 ORDER BY id`, [patient.id]);
  expect(rows).toEqual([{ amount_minor: "205000", idempotency_key: null }, { amount_minor: "205000", idempotency_key: null }]);
});
