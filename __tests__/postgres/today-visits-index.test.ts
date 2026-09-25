import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * «زيارات اليوم» تقرأ الفهرس لا الجدول كله — على PostgreSQL 18 الحقيقي.
 *
 * العيب: `(arrived_at AT TIME ZONE $1)::date = …` يحوّل كل صفٍّ قبل المقارنة، فلا
 * يُستعمل فهرس visits_arrived_at_idx ويُقرأ تاريخ الزيارات كله في كل استطلاع (كل
 * عشرين ثانية من كل شاشة). الاختبار يلتقط الاستعلام الذي تُرسله الدالة فعلًا ويشرح
 * خطته — فهو يعمل على الشيفرة القديمة والجديدة بلا تعديل.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  ensureSchema, getPool, resetPoolForTesting, listTodayVisits, listVisitsByDate, listVisitsBetween, CLINIC_TIME_ZONE,
} = await import("../../lib/db");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

/** يلتقط أول استعلامٍ على visits تُرسله الدالة — نصَّه ومعاملاته. */
async function captureVisitsQuery(run: () => Promise<unknown>): Promise<{ text: string; values: unknown[] }> {
  const pool = getPool();
  const original = pool.query.bind(pool);
  let captured: { text: string; values: unknown[] } | null = null;
  (pool as unknown as { query: unknown }).query = (text: unknown, values?: unknown[]) => {
    if (!captured && typeof text === "string" && /FROM visits/.test(text)) captured = { text, values: values ?? [] };
    return (original as (t: unknown, v?: unknown[]) => Promise<unknown>)(text, values);
  };
  try {
    await run();
  } finally {
    (pool as unknown as { query: unknown }).query = original;
  }
  if (!captured) throw new Error("no visits query captured");
  return captured;
}

function planNodes(plan: Record<string, unknown>): string[] {
  const nodes = [String(plan["Node Type"])];
  for (const child of (plan.Plans as Record<string, unknown>[] | undefined) ?? []) nodes.push(...planNodes(child));
  return nodes;
}

let today = "";

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  [{ today }] = await q<{ today: string }>(`SELECT ((NOW() AT TIME ZONE $1)::date)::text AS today`, [CLINIC_TIME_ZONE]);
  // تاريخٌ طويل: ٣٠٠ يوم × ١٠٠ زيارة — حجم سنةٍ في عيادةٍ مزدحمة.
  await q(
    `INSERT INTO visits (patient_name, status, arrived_at)
     SELECT 'تاريخ', 'done', NOW() - (g % 300 + 1) * INTERVAL '1 day' - (g % 600) * INTERVAL '1 minute'
       FROM generate_series(1, 30000) g`,
  );
  // حدود اليوم بتوقيت العيادة: آخر دقيقة أمس، أول وآخر دقيقة اليوم، أول دقيقة غدًا.
  await q(
    `INSERT INTO visits (patient_name, status, arrived_at) VALUES
       ('أمس 23:59',  'done',    (($1::date - 1)::timestamp + TIME '23:59') AT TIME ZONE $2),
       ('اليوم 00:01', 'waiting', ($1::date::timestamp + TIME '00:01') AT TIME ZONE $2),
       ('اليوم 23:59', 'waiting', ($1::date::timestamp + TIME '23:59') AT TIME ZONE $2),
       ('غدًا 00:01',  'waiting', (($1::date + 1)::timestamp + TIME '00:01') AT TIME ZONE $2)`,
    [today, CLINIC_TIME_ZONE],
  );
  await q(`ANALYZE visits`);
}, 180_000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("زيارات اليوم", () => {
  it("حدود اليوم بتوقيت العيادة صحيحة: من منتصف الليل إلى منتصف الليل", async () => {
    const names = (await listTodayVisits()).map((visit) => visit.patientName).filter((name) => name !== "تاريخ");
    expect(names).toEqual(["اليوم 00:01", "اليوم 23:59"]);
    const byDate = (await listVisitsByDate(today)).map((visit) => visit.patientName).filter((name) => name !== "تاريخ");
    expect(byDate).toEqual(["اليوم 00:01", "اليوم 23:59"]);
  });

  it("المدى شاملٌ لطرفيه ولا يتجاوزهما", async () => {
    const [{ yesterday, tomorrow }] = await q<{ yesterday: string; tomorrow: string }>(
      `SELECT ($1::date - 1)::text AS yesterday, ($1::date + 1)::text AS tomorrow`, [today],
    );
    const range = (await listVisitsBetween(yesterday, today)).map((visit) => visit.patientName);
    expect(range).toContain("أمس 23:59");
    expect(range).toContain("اليوم 23:59");
    expect(range).not.toContain("غدًا 00:01");
    expect((await listVisitsBetween(tomorrow, tomorrow)).map((visit) => visit.patientName)).toEqual(["غدًا 00:01"]);
  });

  it("الاستطلاع يقرأ الفهرس لا الجدول كله", async () => {
    const { text, values } = await captureVisitsQuery(() => listTodayVisits());
    const [row] = await q<{ "QUERY PLAN": [{ Plan: Record<string, unknown> }] }>(`EXPLAIN (FORMAT JSON) ${text}`, values);
    const nodes = planNodes(row["QUERY PLAN"][0].Plan);
    expect(nodes).not.toContain("Seq Scan");
    expect(nodes.some((node) => /Index/.test(node))).toBe(true);
  });
});
