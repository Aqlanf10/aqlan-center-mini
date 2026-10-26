import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { validatePostgresTestTarget } from "./_safe-target";
import { readLeadershipPulse } from "../../lib/leadership-pulse-db";

assertRealPostgresUrl();
const target = validatePostgresTestTarget({ ...process.env }, { allowDatabaseUrlFallback: true });
stubPostgresEnv();
const db = await import("../../lib/db");
const q = async (sql: string, params: unknown[] = []) => (await db.getPool().query(sql, params)).rows;
const read = (page = 0) => readLeadershipPulse(db.getPool(), { view: "care", page, day: "2026-10-26" }, "Asia/Aden", { role: "admin", userId: 1 });
let patient: number;
beforeAll(async () => { await dropPublicSchema(target.testUrl.toString()); await db.ensureSchema(); });
beforeEach(async () => {
  await q("TRUNCATE treatment_plans,patients RESTART IDENTITY CASCADE");
  patient = Number((await q("INSERT INTO patients(patient_number,full_name) VALUES ('SYN-CARE','Synthetic care patient') RETURNING id"))[0].id);
});
afterAll(async () => { await db.resetPoolForTesting(); });

it("counts all current active work across dates even with a booked appointment; excludes done/cancelled items and closed/stopped plans", async () => {
  const plans = await q("INSERT INTO treatment_plans(patient_id,title,total_minor,status,start_date) VALUES ($1,'Old active',0,'active','2000-01-01'),($1,'Completed',0,'completed','2000-01-01'),($1,'Stopped',0,'stopped','2000-01-01'),($1,'Active no pending',0,'active','2026-10-26') RETURNING id", [patient]);
  const [active, completed, stopped, noPending] = plans.map(row => row.id);
  await q("INSERT INTO plan_items(plan_id,service_name,status) VALUES ($1,'Pending','planned'),($1,'Started','in_progress'),($1,'Done','done'),($1,'Cancelled','cancelled'),($2,'Closed pending','planned'),($3,'Stopped pending','planned'),($4,'Already done','done')", [active, completed, stopped, noPending]);
  await q("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status) VALUES ($1,'2199-01-01','14:00','booked')", [patient]);
  const result = await read();
  expect(result.counts).toEqual({ activePlans: 2, pendingPlans: 1, patients: 1, pendingItems: 2, plannedItems: 1, inProgressItems: 1, withoutPendingItems: 1 });
  expect(result.items.map(row => row.title)).toEqual(["Old active", "Active no pending"]);
  expect(result.items[0]).toMatchObject({ patientName: "Synthetic care patient", startDate: "2000-01-01", pendingItems: 2, plannedItems: 1, inProgressItems: 1, doctorName: null, assignee: null, dueAt: null, latestAction: null });
});
it("keeps exact whole-population totals and stable ten-row pages beyond 300 plans", async () => {
  await q("INSERT INTO treatment_plans(patient_id,title,total_minor,status,start_date) SELECT $1,'Synthetic plan '||n,0,'active','2000-01-01' FROM generate_series(1,321) n", [patient]);
  await q("INSERT INTO plan_items(plan_id,service_name,status) SELECT id,'Synthetic pending','planned' FROM treatment_plans");
  const first = await read(); const last = await read(999);
  expect(first.total).toBe(321); expect(first.counts.pendingItems).toBe(321); expect(first.items).toHaveLength(10);
  expect(last.page).toBe(32); expect(last.items).toHaveLength(1); expect(last.hasMore).toBe(false); expect(last.items[0].id).toBe(321);
});
it("makes one read statement with bounded enrichment at scale and leaves clinical records untouched", async () => {
  await q("INSERT INTO treatment_plans(patient_id,title,total_minor,status,start_date) SELECT $1,'Synthetic plan '||n,0,'active','2000-01-01' FROM generate_series(1,20000) n", [patient]);
  await q("INSERT INTO plan_items(plan_id,service_name,status) SELECT t.id,'Synthetic pending','planned' FROM treatment_plans t CROSS JOIN generate_series(1,5) n");
  const snapshot = async () => Promise.all(["treatment_plans", "plan_items", "appointments", "audit_log"].map(table => q(`SELECT COUNT(*)::int AS n FROM ${table}`)));
  const before = await snapshot(), spy = vi.spyOn(db.getPool(), "query"), start = performance.now();
  const result = await read(); const elapsedMs = performance.now() - start, queries = spy.mock.calls.length;
  spy.mockRestore();
  expect(result.total).toBe(20000); expect(result.counts.pendingItems).toBe(100000); expect(result.items).toHaveLength(10);
  expect(queries).toBe(1); expect(elapsedMs).toBeLessThan(5000); expect(await snapshot()).toEqual(before);
  console.log(JSON.stringify({ fixture: "leadership-care-scale", plans: 20000, items: 100000, returned: 10, queries, elapsedMs: Math.round(elapsedMs) }));
});
