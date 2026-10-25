import { afterAll, beforeAll, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, baseUrl, harness } from "./_server";
import { decodeLabBacklog, type LabBacklogSnapshot } from "../../lib/lab-backlog";

let h: Awaited<ReturnType<typeof harness>>, db: Client, patientId: number, baseline: LabBacklogSnapshot;
const stamp = Date.now();
beforeAll(async () => {
  h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  baseline = await (await authedGet("/api/lab/backlog", h.sessions.admin)).json();
  expect(decodeLabBacklog(baseline, "all")).not.toBeNull();
  patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES ($1,'مريض متابعة معمل اصطناعي') RETURNING id", [`SYN-BACKLOG-HTTP-${stamp}`])).rows[0].id;
  await db.query(`INSERT INTO lab_orders(patient_id,lab_name,work_type,status,sent_date,due_date,received_at)
    SELECT $1,'معمل اصطناعي','عمل معمل اصطناعي',status,'2000-01-01','2000-01-10',NULL
    FROM unnest(ARRAY['needed','sent','in_progress','remake','received','delivered','cancelled']) status`, [patientId]);
  await db.query(`INSERT INTO lab_orders(patient_id,lab_name,work_type,status,sent_date,due_date)
    SELECT $1,'معمل اصطناعي','عمل معمل اصطناعي','needed','2000-01-01','2000-01-10' FROM generate_series(1,20)`, [patientId]);
});
afterAll(async () => { await db?.end(); });
it("serves the built admin route with full all-date counts, bounded pages, and no write effects", async () => {
  const snapshot = async () => {
    const result: Record<string, unknown> = {};
    for (const table of ["lab_orders", "lab_order_tracking", "hr_tasks", "hr_task_links", "payables", "expenses"])
      result[table] = (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    return result;
  };
  const before = await snapshot();
  const response = await authedGet("/api/lab/backlog", h.sessions.admin);
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toContain("no-store");
  const body = await response.json() as LabBacklogSnapshot;
  expect(decodeLabBacklog(body, "all")).not.toBeNull();
  expect(body.counts).toEqual({ orders: baseline.counts.orders + 25, patients: baseline.counts.patients + 1,
    preparing: baseline.counts.preparing + 21, withLab: baseline.counts.withLab + 3,
    overdue: baseline.counts.overdue + 3, awaitingFitting: baseline.counts.awaitingFitting + 1 });
  expect(body.items).toHaveLength(20); expect(body.hasMore).toBe(true);
  const second = await (await authedGet("/api/lab/backlog?page=1", h.sessions.admin)).json() as LabBacklogSnapshot;
  expect(decodeLabBacklog(second, "all")).not.toBeNull();
  expect(second.items.every(item => !body.items.some(first => first.id === item.id))).toBe(true);
  expect(JSON.stringify(body)).not.toMatch(/costMinor|costCurrency|payableId|commission/);
  const workflow = await authedGet(`/api/patients/${patientId}/workflow`, h.sessions.admin);
  expect(workflow.status).toBe(200); expect((await workflow.json()).counts.openLabOrders).toBe(25);
  expect((await authedGet("/api/lab/backlog?day=2098-01-01", h.sessions.admin)).status).toBe(400);
  expect(await snapshot()).toEqual(before);
});
it("refuses anonymous and every non-admin role through real HTTP without disclosing rows", async () => {
  expect((await fetch(`${baseUrl}/api/lab/backlog`)).status).toBe(401);
  for (const role of ["doctorA", "doctorB", "reception", "accountant", "cashier", "portalA", "portalB"] as const) {
    const response = await authedGet("/api/lab/backlog", h.sessions[role]);
    expect([401, 403]).toContain(response.status);
    const text = await response.text(); expect(text).not.toContain("مريض متابعة معمل اصطناعي"); expect(text).not.toContain('"items"');
  }
});
