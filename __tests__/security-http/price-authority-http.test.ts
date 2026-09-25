import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";

/**
 * (P1-6) سلطة سعر الإجراء على التطبيق المبني — مسار حفظ الزيارة نفسه الذي تستعمله الشاشة.
 *
 * العيب (تدقيق الجاهزية): طبيبٌ حفظ إجراءً سعره في الدليل ١٥٬٠٠٠ بسعر ١ فخُزّن ١.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let visitId = 0;
let priced = 0;
let unpriced = 0;
const stamp = Date.now();

async function saveProcedure(session: "admin" | "doctorA", serviceId: number, unitPriceMinor: number, priceReason?: string) {
  return authedMutation(`/api/visits/${visitId}/clinical`, h.sessions[session], "POST", JSON.stringify({
    action: "save",
    procedures: [{ serviceId, quantity: 1, unitPriceMinor, ...(priceReason ? { priceReason } : {}) }],
  }));
}

async function storedPrice(): Promise<number | null> {
  const { rows } = await db.query<{ price: string }>(
    `SELECT unit_price_minor::text AS price FROM visit_procedures WHERE visit_id = $1 ORDER BY id DESC LIMIT 1`, [visitId],
  );
  return rows[0] ? Number(rows[0].price) : null;
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  await db.query(`INSERT INTO settings (key, value) VALUES ('billing.max_discount_percent', '10')
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  ({ rows: [{ id: priced }] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, category, price_minor, price_configured, is_active)
     VALUES ($1, 'filling', 15000, TRUE, TRUE) RETURNING id`, [`حشوة سلطة ${stamp}`]));
  ({ rows: [{ id: unpriced }] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, category, price_minor, price_configured, is_active)
     VALUES ($1, 'filling', 0, FALSE, TRUE) RETURNING id`, [`خدمة بلا سعر ${stamp}`]));
  const { rows: [doctor] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  ({ rows: [{ id: visitId }] } = await db.query<{ id: number }>(
    `INSERT INTO visits (patient_name, patient_id, doctor_id, status) VALUES ('سلطة السعر', $1, $2, 'seated') RETURNING id`,
    [h.seeded.patientAId, doctor?.party_id ?? null]));
}, 120_000);
afterAll(async () => {
  await db?.query(`DELETE FROM settings WHERE key = 'billing.max_discount_percent'`);
  await db?.end();
});

describe("P1-6 — the catalog owns the procedure price", () => {
  it("audit repro: a doctor cannot bill a 15,000 procedure at 1", async () => {
    const response = await saveProcedure("doctorA", priced, 1, "مريض قريب");
    expect(response.status).toBe(409);
    const body = await response.json() as { message: string; code: string };
    expect(body.code).toBe("price_authority");
    expect(body.message).toContain("يتجاوز الحد المسموح");
  });

  it("a doctor cannot raise the price above the catalog", async () => {
    expect((await saveProcedure("doctorA", priced, 20000, "حالة صعبة")).status).toBe(409);
  });

  it("the catalog price is saved as is", async () => {
    expect((await saveProcedure("doctorA", priced, 15000)).status).toBe(200);
    expect(await storedPrice()).toBe(15000);
  });

  it("a doctor's discount within the configured 10% needs a reason and is audited", async () => {
    expect((await saveProcedure("doctorA", priced, 13500)).status).toBe(409);
    expect((await saveProcedure("doctorA", priced, 13500, "خصم عائلي")).status).toBe(200);
    expect(await storedPrice()).toBe(13500);
    const { rows } = await db.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action = 'visit.price_override' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [String(visitId)],
    );
    expect(rows[0]?.details).toMatchObject({ سعر_الدليل: 15000, السعر_المعتمد: 13500, السبب: "خصم عائلي" });
  });

  it("the admin may waive the price with a reason", async () => {
    expect((await saveProcedure("admin", priced, 1)).status).toBe(409);
    expect((await saveProcedure("admin", priced, 1, "إعفاء بقرار المدير")).status).toBe(200);
    expect(await storedPrice()).toBe(1);
  });

  it("an unpriced service keeps the typed price and is flagged in the audit", async () => {
    expect((await saveProcedure("doctorA", unpriced, 7000)).status).toBe(200);
    expect(await storedPrice()).toBe(7000);
    const { rows } = await db.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action = 'visit.price_override' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [String(visitId)],
    );
    expect(rows[0]?.details).toMatchObject({ النوع: "سعر يدوي لخدمة غير مسعّرة", السعر_المعتمد: 7000 });
  });
});
