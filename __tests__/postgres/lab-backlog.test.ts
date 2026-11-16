import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { validatePostgresTestTarget } from "./_safe-target";
import { readLabBacklog } from "../../lib/lab-backlog-db";
import { decodeLabBacklog } from "../../lib/lab-backlog";
const original = { ...process.env };
assertRealPostgresUrl(); const target = validatePostgresTestTarget(original, { allowDatabaseUrlFallback: true }); stubPostgresEnv();
const db = await import("../../lib/db");
const q = async (sql: string, params: unknown[] = []) => (await db.getPool().query(sql, params)).rows;
let adminId: number, otherId: number, patientId: number;
const read = (filter: "all" | "preparing" | "with_lab" | "overdue" | "awaiting_fitting" = "all", page = 0) =>
  readLabBacklog(db.getPool(), { filter, page }, "Asia/Aden", { role: "admin", userId: adminId });
beforeEach(async () => {
  await db.resetPoolForTesting();
  await dropPublicSchema(target.testUrl.toString()); await db.ensureSchema();
  const users = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES ('synthetic-backlog-admin','Synthetic admin','unused','admin'),('synthetic-backlog-other','Synthetic other','unused','admin') RETURNING id");
  [adminId, otherId] = users.map(row => Number(row.id));

  [patientId] = (await q("INSERT INTO patients(patient_number,full_name) VALUES ('SYN-BACKLOG','Synthetic backlog patient') RETURNING id")).map(row => Number(row.id));
});
afterAll(async () => { await db.resetPoolForTesting(); });
async function orders(status: string, n = 1, extra: { receivedAt?: string | null; dueDate?: string; patient?: number } = {}) {
  return q(`INSERT INTO lab_orders(patient_id,lab_name,work_type,status,sent_date,due_date,created_at,received_at,tooth_code)
    SELECT $1,'Synthetic lab','Synthetic crown',$2,'2000-01-01',$4::date,'2000-01-01T00:00:00Z',$5::timestamptz,36
    FROM generate_series(1,$3::int) RETURNING id`, [extra.patient ?? patientId, status, n, extra.dueDate ?? "2000-01-10", extra.receivedAt ?? null]);
}
async function unchangedSnapshot() {
  const out: Record<string, unknown> = {};
  for (const table of ["lab_orders", "lab_order_tracking", "hr_tasks", "hr_task_links", "payables", "expenses", "audit_log"]) out[table] = await q(`SELECT * FROM ${table} ORDER BY id`);
  return out;
}
describe("bounded all-open lab backlog", () => {
  it("covers every existing open stage, excludes terminals and counts distinct patients rather than orders", async () => {
    for (const status of ["needed", "sent", "in_progress", "remake", "received", "delivered", "cancelled"]) await orders(status);
    const result = await read(); expect(result.counts).toEqual({ orders: 5, patients: 1, preparing: 1, withLab: 3, overdue: 3, awaitingFitting: 1 });
    expect(result.total).toBe(5); expect(result.items.map(item => item.status).sort()).toEqual(["in_progress", "needed", "received", "remake", "sent"]);
    expect(decodeLabBacklog(result, "all")).toEqual(result);
    expect((await db.patientWorkflow(patientId, result.today)).counts.openLabOrders).toBe(5);
    expect((await read("with_lab")).items.map(item => item.status).sort()).toEqual(["in_progress", "remake", "sent"]);
    expect((await read("preparing")).total).toBe(1); expect((await read("awaiting_fitting")).total).toBe(1);
  });
  it("retains months-old received rows and unknown arrival without creating dates or inferring fit", async () => {
    const [unknown] = await orders("received"), [known] = await orders("received", 1, { receivedAt: "2001-01-01T12:00:00Z" });
    await orders("sent", 1, { dueDate: "2999-01-01" });
    const result = await read();
    expect(result.items.find(item => item.id === unknown.id)?.receivedAt).toBeNull();
    expect(result.items.find(item => item.id === known.id)?.receivedAt).toContain("2001-01-01");
    expect(result.counts.awaitingFitting).toBe(2); expect(result.counts.overdue).toBe(0);
  });
  it("aggregates more than 500 orders and stable bounded pages without terminal-row displacement", async () => {
    await orders("delivered", 600); await orders("sent", 501); await orders("received");
    const first = await read(), second = await read("all", 1), last = await read("all", 999999);
    expect(first.counts.orders).toBe(502); expect(first.items).toHaveLength(20); expect(first.total).toBe(502); expect(first.hasMore).toBe(true);
    expect(first.items[0].status).toBe("received"); expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(40);
    expect((await read()).items).toEqual(first.items); expect(last.page).toBe(25); expect(last.items).toHaveLength(2); expect(last.hasMore).toBe(false);
    expect((await read("overdue")).total).toBe(501);
  });
  it("returns an honest empty page and performs no writes", async () => {
    const before = await unchangedSnapshot(); const result = await read("all", 999);
    expect(result.counts).toEqual({ orders: 0, patients: 0, preparing: 0, withLab: 0, overdue: 0, awaitingFitting: 0 });
    expect(result.page).toBe(0); expect(result.items).toEqual([]); expect(await unchangedSnapshot()).toEqual(before);
  });
  it("preserves own/private and shared-task policy, caps visible tasks and separates assignee from last actor", async () => {
    const [order] = await orders("received");
    for (let i = 0; i < 6; i++) {
      const isPrivate = i >= 4, ownerId = i === 5 ? otherId : adminId;
      const [task] = await q(`INSERT INTO hr_tasks(title,is_private,owner_user_id,owner_display_name,created_by,due_at)
        VALUES ($1,$2,$3,'Synthetic owner','Synthetic creator',$4::timestamptz) RETURNING id`, [i === 5 ? "HIDDEN PRIVATE TASK" : `Visible ${i}`, isPrivate, ownerId, `2026-01-0${i + 1}T10:00:00Z`]);
      await q("INSERT INTO hr_task_links(task_id,link_kind,link_id,linked_by) VALUES ($1,'lab_order',$2,'Synthetic linker')", [task.id, order.id]);
    }
    await q("INSERT INTO lab_order_tracking(lab_order_id,action,to_status,actor,created_at) VALUES ($1,'status_change','received','Synthetic receiving actor','2026-10-01T12:00:00Z')", [order.id]);
    const before = await unchangedSnapshot(); const result = await read(); const item = result.items[0];
    expect(item.visibleTaskCount).toBe(5); expect(item.tasks).toHaveLength(3); expect(item.tasks.map(task => task.title)).toEqual(["Visible 0", "Visible 1", "Visible 2"]);
    expect(item.tasks.every(task => task.assignee === null)).toBe(true); expect(item.latestAction?.actor).toBe("Synthetic receiving actor");
    expect(JSON.stringify(result)).not.toContain("HIDDEN PRIVATE TASK"); expect(await unchangedSnapshot()).toEqual(before);
    await q("UPDATE hr_tasks SET is_private=TRUE,owner_user_id=$1 WHERE title='Visible 0'", [otherId]);
    const revised = (await read()).items[0]; expect(revised.visibleTaskCount).toBe(4); expect(revised.tasks.map(task => task.title)).not.toContain("Visible 0");
  });
  it("does not read tasks on other orders or expose financial fields", async () => {
    const [order] = await orders("received"); await q("UPDATE lab_orders SET cost_minor=12345,cost_currency='YER',base_amount_minor=12345 WHERE id=$1", [order.id]);
    const result = await read(); expect(result.items[0].teeth).toBe("36");
    expect(JSON.stringify(result)).not.toMatch(/costMinor|costCurrency|baseAmountMinor|payableId|12345/);
  });
  it("denies unapproved readers at the data boundary before any query", async () => {
    const query = vi.fn(); await expect(readLabBacklog({ query }, { filter: "all", page: 0 }, "Asia/Aden", { role: "doctor", userId: adminId })).rejects.toThrow("forbidden"); expect(query).not.toHaveBeenCalled();
  });
});
