import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import type { CreateTaskInput } from "../../lib/hr";

assertRealPostgresUrl();
stubPostgresEnv();
const { ensureSchema, getPool, resetPoolForTesting } = await import("../../lib/db");
const { createStaff, createTask, getTaskForSession, updateTask } = await import("../../lib/hr");
const admin = { userId: 0, username: "task-replay-admin", role: "admin", expiresAt: Date.now() + 3_600_000 } as SessionPayload;
const doctor = { userId: 0, username: "task-replay-doctor", role: "doctor", expiresAt: Date.now() + 3_600_000 } as SessionPayload;
const other = { userId: 0, username: "task-replay-other", role: "doctor", expiresAt: Date.now() + 3_600_000 } as SessionPayload;
let assigneeId = 0;
const input = (key: string | null) => ({ title: "Synthetic private replay canary", description: "Synthetic confidential task detail",
  isPrivate: true, priority: "normal" as const, dueAt: null, plannedFor: null, assigneeStaffId: null, clientRequestId: key });
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string; status: number }): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const taskCount = async (key: string) => Number((await getPool().query("SELECT count(*)::int AS n FROM hr_tasks WHERE client_request_id=$1", [key])).rows[0].n);
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!); await ensureSchema();
  for (const actor of [admin, doctor, other]) {
    actor.userId = Number((await getPool().query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$1,'synthetic',$2) RETURNING id", [actor.username, actor.role])).rows[0].id);
  }
  assigneeId = (await createStaff({ fullName: "Synthetic assignee", jobTitle: "Synthetic", department: "other",
    hireDate: null, workStatus: "active", endDate: null, contractKind: "commission", payTerms: null, phone: null, note: null }, admin)).id;
});
afterAll(async () => { await resetPoolForTesting(); });

describe("task creation replay: immutable intent, current owner and atomic evidence", () => {
  it("concurrent identical requests and a lost-response replay create one task, event and audit", async () => {
    const body = input("task-parallel-identical-001");
    const results = await Promise.all([createTask(body, doctor), createTask(body, doctor)]);
    const first = unwrap(results[0]); expect(unwrap(results[1]).id).toBe(first.id);
    expect(unwrap(await createTask(body, doctor)).id).toBe(first.id);
    expect(await taskCount(body.clientRequestId!)).toBe(1);
    expect((await getPool().query("SELECT count(*)::int AS n FROM hr_task_events WHERE task_id=$1", [first.id])).rows[0].n).toBe(1);
    const events = (await getTaskForSession(doctor, first.id))!.events;
    expect(events).toHaveLength(1); expect(events[0].oldValue).toBeNull();
    const audit = (await getPool().query("SELECT * FROM audit_log WHERE action='task.create' AND entity='hr_task' AND entity_id=$1", [String(first.id)])).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(body.title); expect(JSON.stringify(audit)).not.toContain(body.description);
  });

  it.each(["admin", "other"] as const)("rejects another %s actor's known private key without returning task fields", async (role) => {
    const body = input(`task-private-key-${role}-001`); const first = unwrap(await createTask(body, doctor));
    const refused = await createTask(body, role === "admin" ? admin : other);
    expect(refused).toEqual({ ok: false, status: 409, error: "تعذّر تأكيد طلب الإنشاء بهذا المفتاح. راجع مهامك قبل إنشاء طلب آخر." });
    expect(JSON.stringify(refused)).not.toContain(body.title); expect(JSON.stringify(refused)).not.toContain(body.description);
    expect(await taskCount(body.clientRequestId!)).toBe(1);
    expect((await getPool().query("SELECT owner_user_id FROM hr_tasks WHERE id=$1", [first.id])).rows[0].owner_user_id).toBe(doctor.userId);
  });

  it.each(["title", "description", "isPrivate", "priority", "dueAt", "plannedFor", "assigneeStaffId"] as const)("rejects a changed %s under the same actor/key", async (field) => {
    const body = { ...input(`task-field-${field}-001`), isPrivate: false };
    const original = unwrap(await createTask(body, admin));
    const replacements: Required<Pick<CreateTaskInput, "title" | "description" | "isPrivate" | "priority" | "dueAt" | "plannedFor" | "assigneeStaffId">> = { title: "Changed title", description: "Changed detail", isPrivate: true, priority: "urgent",
      dueAt: "2026-10-15T09:00:00.000Z", plannedFor: "2026-10-16", assigneeStaffId: assigneeId };
    const denied = await createTask({ ...body, [field]: replacements[field] }, admin);
    expect(denied).toMatchObject({ ok: false, status: 409 });
    expect(unwrap(await createTask(body, admin)).id).toBe(original.id);
    expect(await taskCount(body.clientRequestId!)).toBe(1);
  });

  it("checks original immutable intent after a legitimate task edit instead of matching the current mutable title", async () => {
    const body = input("task-edited-original-001"); const original = unwrap(await createTask(body, doctor));
    expect((await updateTask(original.id, { title: "Legitimate later edit" }, doctor)).ok).toBe(true);
    expect(unwrap(await createTask(body, doctor))).toMatchObject({ id: original.id, title: "Legitimate later edit" });
    expect(await createTask({ ...body, title: "Legitimate later edit" }, doctor)).toMatchObject({ ok: false, status: 409 });
  });

  it("fails closed for a historical keyed row without original evidence and preserves null-key creation", async () => {
    const old = input("task-legacy-keyed-001");
    await getPool().query("INSERT INTO hr_tasks(title,description,is_private,owner_user_id,owner_display_name,created_by,client_request_id) VALUES($1,$2,true,$3,'Synthetic',$4,$5)", [old.title, old.description, doctor.userId, doctor.username, old.clientRequestId]);
    expect(await createTask(old, doctor)).toMatchObject({ ok: false, status: 409 });
    expect(await taskCount(old.clientRequestId!)).toBe(1);
    const first = unwrap(await createTask(input(null), doctor)), second = unwrap(await createTask(input(null), doctor));
    expect(first.id).not.toBe(second.id);
    expect((await getPool().query("SELECT client_request_id FROM hr_tasks WHERE id=ANY($1::int[])", [[first.id, second.id]])).rows).toEqual([{ client_request_id: null }, { client_request_id: null }]);
  });

  it("rolls the task and create event back when its atomic audit insert fails", async () => {
    const body = input("task-audit-rollback-001");
    await getPool().query(`CREATE FUNCTION task_replay_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='task.create' AND NEW.actor='task-replay-doctor' THEN RAISE EXCEPTION 'synthetic task audit failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER task_replay_test_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION task_replay_test_audit_failure()`);
    try {
      const before = (await getPool().query("SELECT count(*)::int AS n FROM hr_task_events")).rows[0].n;
      await expect(createTask(body, doctor)).rejects.toThrow("synthetic task audit failure");
      expect(await taskCount(body.clientRequestId!)).toBe(0);
      expect((await getPool().query("SELECT count(*)::int AS n FROM hr_task_events")).rows[0].n).toBe(before);
    } finally { await getPool().query("DROP TRIGGER task_replay_test_audit_failure ON audit_log; DROP FUNCTION task_replay_test_audit_failure()"); }
    expect(unwrap(await createTask(body, doctor)).title).toBe(body.title);
  });

  it("reads assignee active state after its row-lock wait, without saving a stale assignment", async () => {
    const blocker = await getPool().connect(); let pending: ReturnType<typeof createTask> | undefined;
    const body = { ...input("task-assignee-wait-001"), isPrivate: false, assigneeStaffId: assigneeId };
    try {
      await blocker.query("BEGIN"); const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await blocker.query("SELECT id FROM hr_staff WHERE id=$1 FOR UPDATE", [assigneeId]);
      pending = createTask(body, admin);
      await expect.poll(async () => Number((await getPool().query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid])).rows[0].n)).toBeGreaterThan(0);
      await blocker.query("UPDATE hr_staff SET work_status='suspended' WHERE id=$1", [assigneeId]); await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ ok: false, status: 400 }); expect(await taskCount(body.clientRequestId!)).toBe(0);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; await getPool().query("UPDATE hr_staff SET work_status='active' WHERE id=$1", [assigneeId]); }
  });
  it("expires while awaiting an assignee lock without leaving a task, event or audit", async () => {
    const session = { ...admin }, blocker = await getPool().connect();
    const body = { ...input("task-expired-wait-001"), isPrivate: false, assigneeStaffId: assigneeId };
    let pending: ReturnType<typeof createTask> | undefined;
    try {
      await blocker.query("BEGIN"); const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await blocker.query("SELECT id FROM hr_staff WHERE id=$1 FOR UPDATE", [assigneeId]);
      pending = createTask(body, session);
      await expect.poll(async () => Number((await getPool().query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid])).rows[0].n)).toBeGreaterThan(0);
      session.expiresAt = Date.now() - 1; await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ ok: false, status: 401 }); expect(await taskCount(body.clientRequestId!)).toBe(0);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
  });

  it("records the current assignee link, label and actor display name after a key-lock wait", async () => {
    const blocker = await getPool().connect();
    const body = { ...input("task-current-assignment-001"), isPrivate: false, assigneeStaffId: assigneeId };
    let pending: ReturnType<typeof createTask> | undefined;
    try {
      await blocker.query("BEGIN"); const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`hr-task-create:${body.clientRequestId}`]);
      pending = createTask(body, admin);
      await expect.poll(async () => Number((await getPool().query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid])).rows[0].n)).toBeGreaterThan(0);
      await getPool().query("UPDATE hr_staff SET user_id=$1,full_name='Synthetic current assignee' WHERE id=$2", [other.userId, assigneeId]);
      await getPool().query("UPDATE users SET display_name='Synthetic current actor' WHERE id=$1", [admin.userId]);
      await blocker.query("COMMIT"); const created = unwrap(await pending);
      expect((await getPool().query("SELECT assignee_user_id,assignee_label,owner_display_name FROM hr_tasks WHERE id=$1", [created.id])).rows[0])
        .toEqual({ assignee_user_id: other.userId, assignee_label: "Synthetic current assignee", owner_display_name: "Synthetic current actor" });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
  });

});
