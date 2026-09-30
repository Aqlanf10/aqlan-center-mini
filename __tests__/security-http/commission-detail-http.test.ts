import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (COMM-DETAIL-1) تفصيل العمولة وكشفها المطبوع والنسبة الخاصة بالحالة على التطبيق المبني:
 * الطبيب يرى سطوره وحده (ولو طلب غيره)، الإدارة والمحاسب الجميع، الاستقبال والكاشير لا شيء،
 * والنسبة الخاصة للمدير وحده — وكل رفضٍ برسالة عربية بلا تفاصيل داخلية.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let doctorA = 0;
let doctorB = 0;
let caseId = 0;
let originalPermissions = "";
const stamp = Date.now();

type Who = "admin" | "reception" | "doctorA" | "doctorB" | "cashier" | "accountant";
const get = (who: Who, path: string) => authedGet(path, h.sessions[who]);
const post = (who: Who, path: string, body: unknown) => authedMutation(path, h.sessions[who], "POST", JSON.stringify(body));
const messageOf = async (response: Response) => (await response.json() as { message?: string }).message ?? "";
const ARABIC = /[؀-ۿ]/;
const DETAIL = "/api/finance/commissions?detail=1&from=2024-01-01&to=2024-12-31";

async function setDoctorAPermissions(extra: Record<string, boolean>) {
  const permissions = JSON.parse(originalPermissions) as Record<string, boolean>;
  await db.query(`UPDATE users SET permissions = $1 WHERE username = 'secdoctora'`,
    [JSON.stringify({ ...permissions, canViewClinicRevenue: false, canViewClinicFinance: false, canViewOtherDoctorsAccounts: false, ...extra })]);
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [a] } = await db.query<{ party_id: number; permissions: string }>(
    `SELECT party_id, permissions FROM users WHERE username = 'secdoctora'`);
  const { rows: [b] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctorb'`);
  doctorA = a.party_id;
  doctorB = b.party_id;
  originalPermissions = a.permissions;
  const { rows: [patient] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مريض العمولة', $2) RETURNING id`,
    [`CM-${stamp}`, doctorA]);
  const { rows: [invoice] } = await db.query<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
     VALUES ($1, $2, 30000, 0, 'YER', 'test', '2024-06-10 09:00+03') RETURNING id`, [`CM-INV-${stamp}`, patient.id]);
  for (const [doctor, amount] of [[doctorA, 20000], [doctorB, 10000]]) {
    await db.query(`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor, doctor_id)
                    VALUES ($1, 'عمل', 1, $2, $2, $3)`, [invoice.id, amount, doctor]);
  }
  const { rows: [kase] } = await db.query<{ id: number }>(
    `INSERT INTO clinical_cases (patient_id, specialty, title, created_by) VALUES ($1, 'implants', 'زراعة', 'test') RETURNING id`, [patient.id]);
  caseId = kase.id;
}, 120_000);

afterAll(async () => {
  if (originalPermissions) await db.query(`UPDATE users SET permissions = $1 WHERE username = 'secdoctora'`, [originalPermissions]);
  await db?.end();
});

describe("COMM-DETAIL-1 — تفصيل العمولة", () => {
  it("الإدارة والمحاسب يرون سطور الجميع", async () => {
    for (const who of ["admin", "accountant"] as const) {
      const response = await get(who, DETAIL);
      expect(response.status).toBe(200);
      const body = await response.json() as { lines: Array<{ doctorId: number }>; isPersonalOnly: boolean };
      expect(body.isPersonalOnly).toBe(false);
      expect(body.lines.map((line) => line.doctorId)).toEqual(expect.arrayContaining([doctorA, doctorB]));
    }
  });

  it("الطبيب المصرَّح له يرى سطوره وحده — ولو طلب طبيبًا آخر", async () => {
    await setDoctorAPermissions({ canViewOwnCommissions: true });
    const response = await get("doctorA", `${DETAIL}&doctorId=${doctorB}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { lines: Array<{ doctorId: number }>; unallocatedMaterials: unknown[]; isPersonalOnly: boolean };
    expect(body.isPersonalOnly).toBe(true);
    expect(body.lines.length).toBeGreaterThan(0);
    expect(body.lines.every((line) => line.doctorId === doctorA)).toBe(true);
    expect(body.unallocatedMaterials).toEqual([]);
    expect((await get("doctorA", `/print/commission-statement/${doctorA}?from=2024-01-01&to=2024-12-31`)).status).toBe(200);
    expect((await get("doctorA", `/print/commission-statement/${doctorB}?from=2024-01-01&to=2024-12-31`)).status).toBe(404);
  });

  it("طبيبٌ بلا صلاحية، والاستقبال، والكاشير: رفضٌ عربي", async () => {
    await setDoctorAPermissions({ canViewOwnCommissions: false });
    for (const who of ["doctorA", "reception", "cashier"] as const) {
      const response = await get(who, DETAIL);
      expect(response.status).toBe(403);
      expect(await messageOf(response)).toMatch(ARABIC);
    }
    expect((await get("accountant", `/print/commission-statement/${doctorB}?from=2024-01-01&to=2024-12-31`)).status).toBe(200);
    expect((await get("cashier", `/print/commission-statement/${doctorB}`)).status).not.toBe(200);
  });
});

describe("COMM-DETAIL-1 — النسبة الخاصة بالحالة (المدير وحده)", () => {
  const body = () => ({ doctorId: doctorA, caseId, action: "set", percent: 25, reason: "اتفاق خاص للحالة", effectiveDate: "2024-01-01" });

  it("غير المدير يُرفض برسالة عربية", async () => {
    for (const who of ["doctorA", "reception", "accountant", "cashier"] as const) {
      const write = await post(who, "/api/finance/commission-overrides", body());
      expect(write.status).toBe(403);
      expect(await messageOf(write)).toMatch(ARABIC);
      expect((await get(who, "/api/finance/commission-overrides")).status).toBe(403);
    }
  });

  it("المدير: السبب إلزامي، ثم الحفظ مع التدقيق، والرأس القديم 409", async () => {
    const missing = await post("admin", "/api/finance/commission-overrides", { ...body(), reason: "" });
    expect(missing.status).toBe(400);
    expect(await messageOf(missing)).toBe("اكتب سبب النسبة الخاصة.");

    const created = await post("admin", "/api/finance/commission-overrides", body());
    expect(created.status).toBe(201);
    const { override } = await created.json() as { override: { id: number; percent: number; isHead: boolean } };
    expect(override).toMatchObject({ percent: 25, isHead: true });
    const { rows } = await db.query(`SELECT 1 FROM audit_log WHERE action = 'commission.case_override.set' AND entity_id = $1`, [String(override.id)]);
    expect(rows).toHaveLength(1);

    const stale = await post("admin", "/api/finance/commission-overrides", { ...body(), percent: 30 });
    expect(stale.status).toBe(409);
    expect(await messageOf(stale)).toMatch(ARABIC);

    const voided = await post("admin", "/api/finance/commission-overrides",
      { ...body(), action: "void", percent: null, supersedesId: override.id, reason: "انتهى الاتفاق" });
    expect(voided.status).toBe(201);

    const list = await get("admin", `/api/finance/commission-overrides?patientId=0`);
    expect(list.status).toBe(200);
  });
});
