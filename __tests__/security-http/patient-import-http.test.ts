import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";

/**
 * (P1-5) استيراد مرضى المركز القديم — عبر المسار الحقيقي: للمدير وحده، والمعاينة
 * لا تكتب، والحفظ يطلب بصمة المعاينة، والملف لا يُستورد مرتين.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
const stamp = Date.now();
const csv = `الاسم,الهاتف,الرصيد\nمستورد اختبار ${stamp},77${String(stamp).slice(-7)},"2,500"\nمستورد ثانٍ ${stamp},,\n`;

const post = (session: Parameters<typeof authedMutation>[1], body: Record<string, unknown>) =>
  authedMutation("/api/patients/import", session, "POST", JSON.stringify(body));

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
}, 120_000);
afterAll(async () => { await db?.end(); });

describe("POST /api/patients/import", () => {
  it("is admin-only", async () => {
    for (const session of [h.sessions.reception, h.sessions.doctorA]) {
      const response = await post(session, { mode: "preview", csv, fileName: "x.csv" });
      expect(response.status).toBe(403);
      expect((await response.json() as { message: string }).message).toBe("استيراد المرضى للمدير وحده.");
    }
    // المحاسب يُردّ من الباب نفسه (قائمة سماح دوره) قبل المسار — برسالة عربية.
    const accountant = await post(h.sessions.accountant, { mode: "preview", csv, fileName: "x.csv" });
    expect(accountant.status).toBe(403);
    expect((await accountant.json() as { message: string }).message).toMatch(/[\u0600-\u06FF]/);
  });

  it("rejects text decoded from a legacy code page with Arabic guidance", async () => {
    const response = await post(h.sessions.admin, { mode: "preview", csv: "��\n�", fileName: "x.csv" });
    expect(response.status).toBe(400);
    expect((await response.json() as { message: string }).message).toContain("CSV UTF-8");
  });

  it("previews without writing, commits with the previewed hash, and refuses a second import", async () => {
    const preview = await post(h.sessions.admin, { mode: "preview", csv, fileName: "old.csv" });
    expect(preview.status).toBe(200);
    const body = await preview.json() as { fileSha256: string; summary: { new: number }; alreadyImported: unknown };
    expect(body.summary.new).toBe(2);
    expect(body.alreadyImported).toBeNull();
    expect((await db.query(`SELECT 1 FROM patients WHERE full_name LIKE $1`, [`%${stamp}`])).rowCount).toBe(0);

    const stale = await post(h.sessions.admin, { mode: "commit", csv: `${csv}زائد ${stamp}\n`, fileName: "old.csv", fileSha256: body.fileSha256 });
    expect(stale.status).toBe(409);
    expect((await stale.json() as { message: string }).message).toContain("تغيّر الملف");

    const commit = await post(h.sessions.admin, { mode: "commit", csv, fileName: "old.csv", fileSha256: body.fileSha256 });
    expect(commit.status).toBe(201);
    const created = await commit.json() as { created: { id: number }[] };
    expect(created.created).toHaveLength(2);
    const { rows: [balance] } = await db.query<{ amount_minor: string }>(
      `SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id = $1`, [created.created[0].id]);
    expect(balance.amount_minor).toBe("2500");

    const again = await post(h.sessions.admin, { mode: "commit", csv, fileName: "old.csv", fileSha256: body.fileSha256 });
    expect(again.status).toBe(409);
    expect((await again.json() as { message: string }).message).toContain("استُورد من قبل");
    const repreview = await post(h.sessions.admin, { mode: "preview", csv, fileName: "old.csv" });
    expect((await repreview.json() as { alreadyImported: unknown }).alreadyImported).not.toBeNull();
  });
});
