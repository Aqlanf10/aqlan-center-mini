import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signerDoctorPartyId } from "./_signer";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (INV-AUDIT) فحص المخزن على PostgreSQL 18 — عيوبٌ وُجدت بالتدقيق، كلٌّ باختبارٍ يسقط أولًا:
 *  ١) تسوية نقصٍ أكبر من الرصيد كانت تُقبل فيصير الرصيد سالبًا.
 *  ٢) شطب دفعةٍ منتهية بتسوية نقص لا يُسقطها من تنبيه «منتهية الصلاحية» أبدًا.
 *  ٣) مهلة «يقارب الانتهاء» من الإعدادات لا تُحترم فوق ٣٠ يومًا.
 *  ٤) توقيع زيارةٍ مادتُها المربوطة لا تكفي كان يسقط بخطأ عام — والآن خطأٌ مسمّى بالمادة.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool, resetPoolForTesting, ensureSchema, createInventoryItem, createInventoryMovement, inventoryAlerts,
  saveSettings, setVisitProcedures, signClinicalVisit, InventoryShortage,
} = await import("../../lib/db");
const { CLINIC_BASE_CURRENCY } = await import("../../lib/money");

const TODAY = "2026-09-27";
const addDays = (days: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

const newItem = async (name: string) =>
  createInventoryItem({ name, category: "other", unit: "علبة", minLevel: 0, note: null, createdBy: "audit" });

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("(INV-AUDIT) stocktake adjustments", () => {
  it("refuses a shortage adjustment larger than what is on the shelf, in Arabic", async () => {
    const item = await newItem("قفازات");
    await createInventoryMovement({ itemId: item.id, kind: "in", qty: 5, createdBy: "audit" });
    const result = await createInventoryMovement({ itemId: item.id, kind: "adjust", qty: -8, reason: "جرد", createdBy: "audit" });
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/[؀-ۿ]/) });
    const ok = await createInventoryMovement({ itemId: item.id, kind: "adjust", qty: -5, reason: "تلف", createdBy: "audit" });
    expect(ok).toMatchObject({ ok: true, balance: 0 });
  });
});

describe("(INV-AUDIT) expiry alerts", () => {
  it("writing off an expired batch with a shortage adjustment clears its expired alert", async () => {
    const item = await newItem("بنج منتهي");
    await createInventoryMovement({ itemId: item.id, kind: "in", qty: 10, expiryDate: addDays(-5), createdBy: "audit" });
    await createInventoryMovement({ itemId: item.id, kind: "in", qty: 4, expiryDate: addDays(200), createdBy: "audit" });
    let alerts = await inventoryAlerts(TODAY);
    expect(alerts.expired.filter((alert) => alert.itemId === item.id).map((alert) => alert.remaining)).toEqual([10]);
    await createInventoryMovement({ itemId: item.id, kind: "adjust", qty: -10, reason: "إتلاف دفعة منتهية", createdBy: "audit" });
    alerts = await inventoryAlerts(TODAY);
    expect(alerts.expired.filter((alert) => alert.itemId === item.id)).toEqual([]);
  });

  it("honours an «expiring soon» window longer than 30 days from the settings", async () => {
    await saveSettings({ "inventory.expiry_soon_days": "60" });
    const item = await newItem("كمبوزيت");
    await createInventoryMovement({ itemId: item.id, kind: "in", qty: 3, expiryDate: addDays(45), createdBy: "audit" });
    const alerts = await inventoryAlerts(TODAY);
    expect(alerts.soon.filter((alert) => alert.itemId === item.id).map((alert) => alert.expiryDate)).toEqual([addDays(45)]);
  });
});

describe("(INV-AUDIT) automatic deduction on visit sign", () => {
  it("a shortage in a linked material stops the sign with a named, typed error — nothing is written", async () => {
    const pool = getPool();
    const item = await newItem("مادة حشو");
    await createInventoryMovement({ itemId: item.id, kind: "in", qty: 1, createdBy: "audit" });
    const { rows: [service] } = await pool.query<{ id: number }>(
      `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ('حشوة', 10000, TRUE, TRUE, 'filling') RETURNING id`);
    await pool.query(`INSERT INTO service_materials (service_id, item_id, qty_per_unit, created_by) VALUES ($1, $2, 2, 'audit')`, [service.id, item.id]);
    const { rows: [patient] } = await pool.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ('INV-1', 'مريض المخزن') RETURNING id`);
    const { rows: [visit] } = await pool.query<{ id: number }>(
      `INSERT INTO visits (patient_name, status, patient_id, arrived_at) VALUES ('مريض المخزن', 'seated', $1, NOW()) RETURNING id`, [patient.id]);
    await setVisitProcedures({
      visitId: visit.id,
      procedures: [{ serviceId: service.id, toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: 10000, priceReason: null, doctorId: null, note: null, planItemId: null }],
      authority: { role: "admin", maxDiscountPercent: 10 }, overrides: [], billingCurrency: "YER", rates: { SAR: 140, USD: 530 },
    });
    const attempt = signClinicalVisit({ visitId: visit.id, baseCurrency: CLINIC_BASE_CURRENCY, signedBy: "doctor", signerDoctorPartyId: await signerDoctorPartyId() });
    await expect(attempt).rejects.toBeInstanceOf(InventoryShortage);
    await expect(signClinicalVisit({ visitId: visit.id, baseCurrency: CLINIC_BASE_CURRENCY, signedBy: "doctor", signerDoctorPartyId: await signerDoctorPartyId() }))
      .rejects.toThrow("مادة حشو");
    const { rows: [state] } = await pool.query<{ signed_at: Date | null }>(`SELECT signed_at FROM visits WHERE id = $1`, [visit.id]);
    expect(state.signed_at).toBeNull();
  });
});
