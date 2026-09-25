import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (P3-8ب) من أين جاء المريض — يُحفظ من ملفه، ويُدقَّق، ويظهر في تقرير المرضى الجدد.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
const stamp = Date.now();

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [row] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`,
    [`SRC-${stamp}`, `مريض مصدر ${stamp}`],
  );
  patientId = row.id;
}, 120_000);

afterAll(async () => {
  await db?.end();
});

describe("P3-8ب — مصدر المريض", () => {
  it("الاستقبال يحفظ المصدر ومن أحاله، والتعديل يُدقَّق بتسميته العربية", async () => {
    const response = await authedMutation(`/api/patients/${patientId}`, h.sessions.reception, "PATCH",
      JSON.stringify({ referralSource: "توصية مريض", referredBy: "أم خالد" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ referralSource: "توصية مريض", referredBy: "أم خالد" });
    const { rows } = await db.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action = 'patient.update' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [String(patientId)],
    );
    expect(JSON.stringify(rows[0]?.details)).toContain("مصدر_المريض");
  });

  it("تعديل حقلٍ آخر لا يمحو المصدر", async () => {
    const response = await authedMutation(`/api/patients/${patientId}`, h.sessions.reception, "PATCH",
      JSON.stringify({ note: "ملاحظة" }));
    expect(await response.json()).toMatchObject({ referralSource: "توصية مريض" });
  });

  it("تقرير المرضى الجدد يعرض المصدر ويعدّ المرضى بحسبه", async () => {
    const response = await authedGet("/api/reports?report=patients&preset=this_month", h.sessions.admin);
    expect(response.status).toBe(200);
    const body = await response.json() as { rows: { patientId: number; sourceLabel: string }[]; notes: string[] };
    expect(body.rows.find((row) => row.patientId === patientId)?.sourceLabel).toBe("توصية مريض (أم خالد)");
    expect(body.notes.join(" ")).toMatch(/من أين جاؤوا: .*توصية مريض: \d+/);
  });
});
