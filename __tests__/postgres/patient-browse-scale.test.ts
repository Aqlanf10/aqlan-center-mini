import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (PAT-1 review) مرشّح «عليهم مبالغ» لا يُقصّ: تقرير الديون يعرض أول ٥٠٠ صفّ، والقائمة كانت
 * تبني مرشّحها منه فتُسقط كل مدينٍ بعد الخمسمئة. هنا ٥٢٠ مدينًا — يجب أن يظهروا كلهم.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const { getPool, resetPoolForTesting, ensureSchema, browsePatients } = await import("../../lib/db");

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();
  await pool.query(
    `INSERT INTO patients (patient_number, full_name)
     SELECT 'SC-' || n, 'مدين ' || n FROM generate_series(1, 520) AS n`);
  await pool.query(
    `INSERT INTO patient_opening_balances (patient_id, amount_minor, as_of_date, created_by, currency)
     SELECT id, 1000, '2026-01-01', 'scale', 'YER' FROM patients`);
}, 120_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("(PAT-1 review) debt filter over more than 500 debtors", () => {
  it("counts every debtor and shows balances on every page", async () => {
    const first = await browsePatients({ offset: 0, limit: 25, filter: "debt", sort: "name", doctorPartyId: null, today: "2026-09-26" });
    expect(first.total).toBe(520);
    const last = await browsePatients({ offset: 500, limit: 25, filter: "debt", sort: "name", doctorPartyId: null, today: "2026-09-26" });
    expect(last.rows).toHaveLength(20);
    expect(last.rows.every((row) => row.balances.length === 1 && row.balances[0].dueMinor === 1000)).toBe(true);
    const plain = await browsePatients({ offset: 510, limit: 25, filter: "all", sort: "name", doctorPartyId: null, today: "2026-09-26" });
    expect(plain.rows.every((row) => row.balances[0]?.dueMinor === 1000)).toBe(true);
  });
});
