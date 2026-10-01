import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (P1–P6) الحزمة على التطبيق المبني: سجل الاستمارات بعزل الطبيب، والمواد اليدوية مربوطة بمريض
 * الزيارة نفسه، ومعاينة الاستحقاق قراءةٌ فقط، والخطة السريعة تمر بسلطة التسعير — وكل رفضٍ بالعربية.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let ownedId = 0;    // مريضٌ للطبيب أ
let otherId = 0;    // مريضٌ ليس له
let ownedVisit = 0;
let otherVisit = 0;
let itemId = 0;
let serviceId = 0;
const stamp = Date.now();

type Who = "admin" | "reception" | "doctorA" | "doctorB" | "cashier" | "accountant";
const post = (who: Who, path: string, body: unknown) => authedMutation(path, h.sessions[who], "POST", JSON.stringify(body));
const get = (who: Who, path: string) => authedGet(path, h.sessions[who]);

async function expectArabic(response: Response, status: number) {
  expect(response.status).toBe(status);
  const body = await response.json() as Record<string, unknown>;
  expect(body.message).toMatch(/[؀-ۿ]/);
  expect(String(body.message)).not.toMatch(/error|exception|stack|select|insert/i);
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [doctor] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  const insert = async (suffix: string, primary: number | null) => (await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
    [`UXH-${suffix}-${stamp}`, `مريض ${suffix}`, primary])).rows[0].id;
  ownedId = await insert("A", doctor.party_id);
  otherId = await insert("B", null);
  const visit = async (patientId: number) => (await db.query<{ id: number }>(
    `INSERT INTO visits (patient_id, patient_name, status) VALUES ($1, 'م', 'waiting') RETURNING id`, [patientId])).rows[0].id;
  ownedVisit = await visit(ownedId);
  otherVisit = await visit(otherId);
  itemId = (await db.query<{ id: number }>(
    `INSERT INTO inventory_items (name, category, unit, min_level, created_by) VALUES ($1, 'filling', 'سرنجة', 0, 't') RETURNING id`,
    [`مادة ${stamp}`])).rows[0].id;
  await db.query(`INSERT INTO inventory_movements (item_id, kind, qty, reason, created_by) VALUES ($1, 'in', 3, 'رصيد', 't')`, [itemId]);
  serviceId = (await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 40000, TRUE, TRUE, 'filling') RETURNING id`,
    [`حشوة سريعة ${stamp}`])).rows[0].id;
}, 120_000);

afterAll(async () => { await db?.end(); });

describe("(P1) intake history", () => {
  it("reception records a new version; history is newest first and keeps the earlier one", async () => {
    const first = await post("reception", `/api/patients/${ownedId}/intake-history`, { conditions: ["diabetes"], allergies: "بنسلين" });
    expect(first.status).toBe(201);
    const second = await post("reception", `/api/patients/${ownedId}/intake-history`, { conditions: [], medications: "أسبرين" });
    expect(second.status).toBe(201);
    const response = await get("doctorA", `/api/patients/${ownedId}/intake-history`);
    expect(response.status).toBe(200);
    const { forms } = await response.json() as { forms: { id: number; recordedBy: string | null; answers: { conditions: string[] } }[] };
    expect(forms.length).toBe(2);
    expect(forms[0].id).toBeGreaterThan(forms[1].id);
    expect(forms[1].answers.conditions).toEqual(["diabetes"]);
    expect(forms[0].recordedBy).toBe("secreception");
  });

  it("a doctor cannot read or write another doctor's patient; invalid conditions are refused", async () => {
    await expectArabic(await get("doctorA", `/api/patients/${otherId}/intake-history`), 403);
    await expectArabic(await post("doctorA", `/api/patients/${otherId}/intake-history`, { conditions: [] }), 403);
    await expectArabic(await post("reception", `/api/patients/${ownedId}/intake-history`, { conditions: ["not-a-condition"] }), 400);
  });

  it("cashier and accountant do not reach the clinical intake", async () => {
    expect([401, 403]).toContain((await get("cashier", `/api/patients/${ownedId}/intake-history`)).status);
    expect([401, 403]).toContain((await get("accountant", `/api/patients/${ownedId}/intake-history`)).status);
  });
});

describe("(P4) manual visit materials", () => {
  it("a doctor's manual out-movement is tied to the visit's own patient and listed as manual", async () => {
    const response = await post("doctorA", `/api/inventory/${itemId}/movements`, { kind: "out", qty: 1, visitId: ownedVisit, reason: "استهلاك إضافي في الزيارة" });
    expect(response.status).toBe(201);
    const { rows: [movement] } = await db.query<{ visit_id: number; patient_id: number }>(
      `SELECT visit_id, patient_id FROM inventory_movements WHERE item_id = $1 AND kind = 'out' ORDER BY id DESC LIMIT 1`, [itemId]);
    expect(movement).toEqual({ visit_id: ownedVisit, patient_id: ownedId });
    const list = await get("doctorA", `/api/visits/${ownedVisit}/materials`);
    expect(list.status).toBe(200);
    const body = await list.json() as { lines: { source: string; qty: number }[] };
    expect(body.lines).toEqual([expect.objectContaining({ source: "manual", qty: 1 })]);
  });

  it("refuses a patient that is not the visit's, another doctor's visit, a stock shortage, and the reserved auto tag", async () => {
    await expectArabic(await post("reception", `/api/inventory/${itemId}/movements`, { kind: "out", qty: 1, visitId: ownedVisit, patientId: otherId }), 400);
    await expectArabic(await post("doctorA", `/api/inventory/${itemId}/movements`, { kind: "out", qty: 1, visitId: otherVisit }), 403);
    await expectArabic(await get("doctorA", `/api/visits/${otherVisit}/materials`), 403);
    await expectArabic(await post("doctorA", `/api/inventory/${itemId}/movements`, { kind: "out", qty: 50, visitId: ownedVisit }), 409);
    await expectArabic(await post("doctorA", `/api/inventory/${itemId}/movements`, { kind: "out", qty: 1, visitId: ownedVisit, reason: "خصم تلقائي — مزيف" }), 400);
  });
});

describe("(P6) billing preview is read-only", () => {
  it("returns the per-currency dues and offers no write method", async () => {
    const response = await get("doctorA", `/api/visits/${ownedVisit}/billing-preview`);
    expect(response.status).toBe(200);
    const body = await response.json() as { duesByCurrency: Record<string, number>; zeroReason: string | null };
    expect(body.duesByCurrency).toEqual({});
    expect(body.zeroReason).toBe("زيارة توثيق بلا إجراء مفوتر");
    const forced = await authedMutation(`/api/visits/${ownedVisit}/billing-preview`, h.sessions.doctorA, "POST", JSON.stringify({ forceZero: true }));
    expect(forced.status).toBe(405);
    await expectArabic(await get("doctorA", `/api/visits/${otherVisit}/billing-preview`), 403);
  });
});

describe("(P2) quick plan goes through the V2 engine and its price authority", () => {
  it("the catalog price creates a V2 plan; a lower price from reception without a reason is refused", async () => {
    const plan = (unitPriceMinor: number) => post("reception", "/api/plans", {
      mode: "v2", patientId: ownedId, title: "خطة سريعة", currency: "YER", billingMode: "per_procedure",
      items: [{ serviceId, quantity: 1, toothCode: 16, unitPriceMinor, billingRule: "on_completion", sessionCount: 1 }],
    });
    const created = await plan(40000);
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: number };
    const { rows: [row] } = await db.query<{ total_minor: string; total_from_items: boolean }>(
      `SELECT total_minor::text, total_from_items FROM treatment_plans WHERE id = $1`, [id]);
    expect(row).toEqual({ total_minor: "40000", total_from_items: true });
    await expectArabic(await plan(1000), 400);
  });
});
