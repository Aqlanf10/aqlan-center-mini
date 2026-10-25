import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { validatePostgresTestTarget } from "./_safe-target";
import { LAB_BACKLOG_SQL, readLabBacklog } from "../../lib/lab-backlog-db";
import { LAB_READINESS_STATUSES } from "../../lib/lab-readiness";
const original = { ...process.env }; assertRealPostgresUrl();
const target = validatePostgresTestTarget(original, { allowDatabaseUrlFallback: true }); stubPostgresEnv();
const db = await import("../../lib/db");
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let userId: number;
beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString()); await db.ensureSchema();
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES ('synthetic-backlog-load','Synthetic load reader','unused','admin') RETURNING id"); userId = user.id;
  const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES ('SYN-BACKLOG-LOAD','Synthetic performance patient') RETURNING id");
  await q(`INSERT INTO lab_orders(patient_id,lab_name,work_type,status,sent_date,due_date,received_at)
    SELECT $1,'Synthetic lab','Synthetic crown',CASE WHEN n%5=0 THEN 'received' ELSE 'sent' END,'2000-01-01','2000-01-10',
      CASE WHEN n%5=0 THEN '2000-01-11T12:00:00Z'::timestamptz ELSE NULL END
    FROM generate_series(1,20000) n`, [patient.id]);
  await q(`INSERT INTO hr_tasks(title,owner_user_id,owner_display_name,created_by,due_at)
    SELECT 'Synthetic follow-up '||n,$1,'Synthetic owner','synthetic','2026-01-01T12:00:00Z' FROM generate_series(1,100000) n`, [userId]);
  await q(`INSERT INTO hr_task_links(task_id,link_kind,link_id,linked_by)
    SELECT id,'lab_order',1+((id-1)%20000),'synthetic' FROM hr_tasks WHERE owner_user_id=$1`, [userId]);
  await q("ANALYZE lab_orders"); await q("ANALYZE hr_tasks"); await q("ANALYZE hr_task_links");
}, 60000);
afterAll(async () => { vi.restoreAllMocks(); await db.resetPoolForTesting(); });
type Plan = { "Node Type": string; "Relation Name"?: string; "Actual Loops"?: number; "Actual Rows"?: number; Plans?: Plan[] };
function nodes(plan: Plan): Plan[] { return [plan, ...(plan.Plans ?? []).flatMap(nodes)]; }
it("enriches at most 20 rows and does not repeat an unindexed HR-link scan per order (synthetic 20k orders/100k tasks)", async () => {
  const [{ "QUERY PLAN": explain }] = await q(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${LAB_BACKLOG_SQL}`,
    ["Asia/Aden", [...LAB_READINESS_STATUSES], "all", 0, 20, userId]);
  const tree = nodes(explain[0].Plan as Plan);
  const sequentialLinkScans = tree.filter(node => node["Relation Name"] === "hr_task_links" && node["Node Type"] === "Seq Scan");
  expect(sequentialLinkScans.every(node => (node["Actual Loops"] ?? 0) <= 1)).toBe(true);
  const elapsed: number[] = [];
  const queryCounts: number[] = [], querySpy = vi.spyOn(db.getPool(), "query");
  for (let i = 0; i < 20; i++) {
    const before = querySpy.mock.calls.length;
    const start = performance.now();
    const result = await readLabBacklog(db.getPool(), { filter: "all", page: 0 }, "Asia/Aden", { userId, role: "admin" });
    elapsed.push(performance.now() - start);
    queryCounts.push(querySpy.mock.calls.length - before);
    expect(queryCounts.at(-1)).toBe(1);
    expect(result.items).toHaveLength(20); expect(result.counts.orders).toBe(20000); expect(result.counts.patients).toBe(1);
    expect(result.items.every(item => item.tasks.length <= 3 && item.visibleTaskCount === 5)).toBe(true);
  }
  elapsed.sort((a, b) => a - b);
  console.info(JSON.stringify({ syntheticRows: { orders: 20000, tasks: 100000, links: 100000 }, queryCountPerRead: Math.max(...queryCounts),
    samples: elapsed.length, p95Ms: Math.round(elapsed[18] * 10) / 10, maxMs: Math.round(elapsed[19] * 10) / 10,
    explainExecutionMs: explain[0]["Execution Time"], sharedHitBlocks: explain[0].Plan["Shared Hit Blocks"],
    sharedReadBlocks: explain[0].Plan["Shared Read Blocks"], sequentialLinkScans: sequentialLinkScans.map(node => ({ rows: node["Actual Rows"], loops: node["Actual Loops"] })) }));
}, 60000);
