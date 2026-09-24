import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, baseUrl, harness } from "./_server";

/**
 * (P1-3) إقفال الوردية على HTTP الحقيقي — التطبيق المبني نفسه.
 *
 * الجرد الأعمى: الخادم يحسب المتوقَّع لحظة الإقفال، فإن خالفه المعدود رفض برسالةٍ
 * عربية تكشف الفرق وتطلب سببه؛ ومع السبب يُقفَل ويُدقَّق بالمتوقَّع والفرق والسبب.
 * وتقرير الإقفال (Z) يُطبع للإدارة والاستقبال ولا يُفتح للطبيب.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let shiftId = 0;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  await db.query(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
     SELECT 'p13-http', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`,
  );
  const { rows: [open] } = await db.query<{ id: number }>(`SELECT id FROM cashier_shifts WHERE status = 'open'`);
  shiftId = open.id;
}, 240_000);

afterAll(async () => {
  // تبقى وردية مفتوحة لبقية ملفات الأمن.
  await db?.query(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
     SELECT 'p13-http-reopen', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`,
  );
  await db?.end();
});

const close = (body: unknown) => authedMutation("/api/shifts", h.sessions.reception, "PATCH", JSON.stringify(body));

describe("إقفال الوردية — جردٌ أعمى وفرقٌ لا يُقفَل بلا سبب", () => {
  it("GET يعرض الدرج بالقاعدة الواحدة (نقدٌ فقط)", async () => {
    const response = await fetch(`${baseUrl}/api/shifts`, { headers: { cookie: h.sessions.reception.cookie } });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.drawer?.expected).toBeTruthy();
  });

  it("معدودٌ مخالف بلا سبب ⇒ 409 برسالة تكشف الفرق وتطلب سببه، والوردية تبقى مفتوحة", async () => {
    const { rows: [before] } = await db.query<{ expected: string }>(
      `SELECT (opening_yer
         + COALESCE((SELECT SUM(CASE WHEN kind = 'refund' THEN -amount_minor ELSE amount_minor END)
                       FROM payments WHERE shift_id = $1 AND currency = 'YER' AND method = 'cash'), 0)
         - COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE shift_id = $1 AND currency = 'YER'), 0))::text AS expected
         FROM cashier_shifts WHERE id = $1`,
      [shiftId],
    );
    const wrong = String(Number(before.expected) + 777);
    const response = await close({ id: shiftId, counted: { YER: wrong, SAR: "0", USD: "0" } });
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.code).toBe("difference_reason_required");
    expect(payload.message).toContain("زيادة");
    const { rows: [row] } = await db.query<{ status: string }>(`SELECT status FROM cashier_shifts WHERE id = $1`, [shiftId]);
    expect(row.status).toBe("open");
  });

  it("مع السبب ⇒ يُقفَل، ويُدقَّق بالمعدود والمتوقَّع والفرق والسبب", async () => {
    const { rows: [shift] } = await db.query<{ expected: string }>(
      `SELECT (opening_yer
         + COALESCE((SELECT SUM(CASE WHEN kind = 'refund' THEN -amount_minor ELSE amount_minor END)
                       FROM payments WHERE shift_id = $1 AND currency = 'YER' AND method = 'cash'), 0)
         - COALESCE((SELECT SUM(amount_minor) FROM expenses WHERE shift_id = $1 AND currency = 'YER'), 0))::text AS expected
         FROM cashier_shifts WHERE id = $1`,
      [shiftId],
    );
    const response = await close({
      id: shiftId, counted: { YER: String(Number(shift.expected) + 777), SAR: "0", USD: "0" },
      differenceReason: "مبلغ زائد تركه مريض للتسوية غدًا",
    });
    expect(response.status).toBe(200);
    const closed = await response.json();
    expect(closed.difference.YER).toBe(777);
    expect(closed.differenceReason).toBe("مبلغ زائد تركه مريض للتسوية غدًا");
    const { rows: [audit] } = await db.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action = 'shift.close' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [String(shiftId)],
    );
    expect(audit.details["سبب_الفرق"]).toBe("مبلغ زائد تركه مريض للتسوية غدًا");
    expect((audit.details["الفرق"] as Record<string, number>).YER).toBe(777);
  });

  it("تقرير الإقفال (Z) يُطبع للاستقبال ولا يُفتح للطبيب", async () => {
    const ok = await fetch(`${baseUrl}/print/shift/${shiftId}`, { headers: { cookie: h.sessions.reception.cookie } });
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("تقرير إقفال الوردية");
    expect(html).toContain("مبلغ زائد تركه مريض");
    const denied = await fetch(`${baseUrl}/print/shift/${shiftId}`, { headers: { cookie: h.sessions.doctorA.cookie } });
    expect(denied.status).toBe(404);
  });
});
