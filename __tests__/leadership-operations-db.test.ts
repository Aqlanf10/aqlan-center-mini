import { expect, it, vi } from "vitest";
import { readOperationalOverview } from "../lib/leadership-operations-db";
const input = { day: "2026-10-22", lane: "all" as const, appointmentPage: 0, referralPage: 0 };
const ready = { rows: [{ as_of: new Date("2026-10-22T07:00:00Z"), total: 0, page: 0, items: [] }] };
it("isolates failure of either operational source from the other and never substitutes zero", async () => {
  for (const fail of ["appointments", "referrals"]) {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes(fail === "appointments" ? "WITH RECURSIVE" : "FROM patient_referrals")) throw new Error("private DB detail");
      return ready;
    });
    const result = await readOperationalOverview({ query }, input, "Asia/Aden");
    expect(result.sections.find(section => section.source === fail)).toMatchObject({ status: "error", total: null, asOf: null });
    expect(result.sections.find(section => section.source !== fail)).toMatchObject({ status: "ready", total: 0, asOf: "2026-10-22T07:00:00.000Z" });
    expect(JSON.stringify(result)).not.toContain("private DB detail");
  }
});
it.each(["reception", "doctor"] as const)("queries only the selected %s action lane", async lane => {
  const query = vi.fn().mockResolvedValue(ready);
  const result = await readOperationalOverview({ query }, { ...input, lane }, "America/Havana");
  expect(query).toHaveBeenCalledTimes(1); expect(result.sections).toHaveLength(1);
  expect(query.mock.calls[0][1]).toEqual([input.day, "America/Havana", 0, 10]);
  expect(result.sections[0].source).toBe(lane === "reception" ? "appointments" : "referrals");
});
it("reports true source total and pagination without inferring totals from a capped page", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ ...ready.rows[0], total: 21, page: 1, items: [] }] });
  const result = await readOperationalOverview({ query }, { ...input, appointmentPage: 1 }, "Asia/Aden");
  expect(result.sections[0]).toMatchObject({ total: 21, page: 1, hasMore: true });
});
