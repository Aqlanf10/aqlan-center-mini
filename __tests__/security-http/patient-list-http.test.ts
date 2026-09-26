import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, harness } from "./_server";

/** (PAT-1) قائمة المرضى والبحث عبر المسار الحقيقي: مرشّح على الخادم، وبحث عربي متسامح، وإسقاط مالي للأدوار المالية. */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
const stamp = Date.now();

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  await db.query(`INSERT INTO patients (patient_number, full_name, phone, medical_alert) VALUES ($1, $2, '967779990001', 'حساسية لاتكس')`,
    [`PL-${stamp}`, `إبراهيم الأهدل ${stamp}`]);
}, 120_000);
afterAll(async () => { await db?.end(); });

type Row = { fullName: string; medicalAlert?: string | null; balances?: unknown[] };

describe("(PAT-1) /api/patients", () => {
  it("filters on the server over all patients and reports the filtered total", async () => {
    const response = await authedGet("/api/patients?filter=alert&sort=name", h.sessions.reception);
    expect(response.status).toBe(200);
    const page = await response.json() as { rows: Row[]; total: number; filter: string; sort: string };
    expect(page).toMatchObject({ filter: "alert", sort: "name" });
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((row) => Boolean(row.medicalAlert))).toBe(true);
    expect(page.total).toBeGreaterThanOrEqual(page.rows.length);
    // مرشّحٌ مجهول يعود «الكل» بلا خطأ.
    expect((await (await authedGet("/api/patients?filter=bogus", h.sessions.reception)).json() as { filter: string }).filter).toBe("all");
  });

  it("finds «إبراهيم الأهدل» typed as «ابراهيم الاهدل» in reverse order", async () => {
    const rows = await (await authedGet(`/api/patients?q=${encodeURIComponent(`الاهدل ابراهيم ${stamp}`)}`, h.sessions.reception)).json() as Row[];
    expect(rows.map((row) => row.fullName)).toContain(`إبراهيم الأهدل ${stamp}`);
  });

  it("finance roles get balances but never clinical fields", async () => {
    const page = await (await authedGet("/api/patients?filter=all", h.sessions.accountant)).json() as { rows: Row[] };
    expect(page.rows.length).toBeGreaterThan(0);
    for (const row of page.rows) {
      expect(row).not.toHaveProperty("medicalAlert");
      expect(Array.isArray(row.balances)).toBe(true);
    }
  });
});
