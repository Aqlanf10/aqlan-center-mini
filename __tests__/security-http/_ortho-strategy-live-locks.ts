import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect } from "vitest";
import type { StrategyFixture } from "./_ortho-strategy-live-fixture";

/** Test-only observation/fault seams. Never wraps, mocks, or replaces the writer,
 * session reader, pool, COMMIT, or canonical mutation SQL. The built HTTP server
 * executes all subjects. Only the CI-owned disposable database is eligible.
 * Generated objects are disarmed and retained for inherited harness teardown;
 * no DROP, DELETE, TRUNCATE, disabled constraint, or production change is used. */
export async function openStrategyControl(f: StrategyFixture) {
  await f.assertDatabaseIdentity();
  const db = new Client({ connectionString: f.dbUrl, ssl: false,
    application_name: `strategy_control_${randomUUID().replaceAll("-", "")}` });
  await db.connect();
  try {
    const { rows: [identity] } = await db.query<{ name: string; oid: string; owner: string }>(
      "SELECT datname AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=current_database()");
    const { rows: [expected] } = await f.db.query<typeof identity>(
      "SELECT datname AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=current_database()");
    if (JSON.stringify(identity) !== JSON.stringify(expected) || identity.name !== "aqlan_sec_http") {
      throw new Error("Strategy control connection identity does not match its owned fixture.");
    }
    return db;
  } catch (error) { await db.end(); throw error; }
}

export type LockEdge = { pid: number; query: string; blockers: number[]; wait_event_type: string; state: string };
/** Polling delay is only backoff. Passing requires a server-observed exact
 * blocker PID edge and the actual subject statement in the same database. */
export async function observeStrategyWait(
  f: StrategyFixture, blocker: number, statement: string, pendingOperation?: Promise<unknown>,
): Promise<LockEdge> {
  // Attach before the first await: a rejected competing SQL/HTTP operation must
  // fail with its original error, never become an unhandled rejection while we
  // poll for a lock it cannot acquire. The caller still awaits/drains the same
  // original promise after releasing its gate.
  let operation: { state: "pending" } | { state: "fulfilled" } | { state: "rejected"; error: unknown } = { state: "pending" };
  void pendingOperation?.then(
    () => { operation = { state: "fulfilled" }; },
    error => { operation = { state: "rejected", error }; },
  );
  const assertPending = () => {
    if (operation.state === "rejected") throw operation.error;
    if (operation.state === "fulfilled") throw new Error(`Operation completed before its observed lock edge for ${statement}`);
  };
  const deadline = Date.now() + 15_000;
  do {
    assertPending();
    const { rows } = await f.db.query<LockEdge>(`SELECT pid,query,pg_blocking_pids(pid) AS blockers,wait_event_type,state
      FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND $1=ANY(pg_blocking_pids(pid))`, [blocker]);
    assertPending();
    const edge = rows.find(row => row.query.includes(statement));
    if (edge) {
      expect(edge.blockers).toContain(blocker); expect(edge.wait_event_type).toBe("Lock");
      expect(edge.state).toBe("active");
      console.info("[strategy-live-lock-edge]", JSON.stringify({ ...edge, blocker }));
      return edge;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assertPending();
  throw new Error(`No observed pg_blocking_pids edge for ${statement} behind PID ${blocker}`);
}

type Target = "strategy-audit" | "item-update" | "item-delete" | "ortho-owner-update";
type Fault = "wait" | "audit-failure" | "commit-failure";

/** Private trigger runs only for this fixture's exact object identity. A held
 * advisory key arms it; append-only history/constraints stay intact. A deferred
 * trigger failure is a real rejected COMMIT, not a simulated acknowledgement. */
export async function installStrategyFault(f: StrategyFixture, target: Target, mode: Fault = "wait") {
  await f.assertDatabaseIdentity();
  if (mode !== "wait" && target !== "strategy-audit") throw new Error("Failure seam must target owned strategy audit only.");
  const suffix = randomUUID().replaceAll("-", "");
  const name = `strategy_test_${suffix}`;
  const table = target === "strategy-audit" ? "audit_log" : target === "ortho-owner-update" ? "ortho_cases" : "plan_items";
  const event = target === "item-delete" ? "DELETE" : target === "strategy-audit" ? "INSERT" : "UPDATE";
  const own = target === "strategy-audit"
    ? `NEW.action = 'ortho.strategy_revision' AND NEW.entity_id = '${f.patientId}' AND NEW.details->>'orthoCaseId' = '${f.orthoCaseId}'`
    : target === "ortho-owner-update"
      ? `OLD.id = ${f.orthoCaseId} AND OLD.patient_id = ${f.patientId} AND NEW.patient_id <> OLD.patient_id`
      : `OLD.id = ${f.itemId} AND OLD.plan_id = ${f.planId}`;
  const returnRow = event === "DELETE" ? "OLD" : "NEW";
  // Safe integers originate solely in the fixture and never in request content.
  for (const id of [f.patientId, f.orthoCaseId, f.itemId, f.planId]) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid private fixture identity.");
  }
  const control = await openStrategyControl(f);
  const key = f.orthoCaseId; // Unique database-assigned owner; never a shared key.
  let released = false;
  try {
    const { rows: [backend] } = await control.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const { rows: [armed] } = await control.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::int,$2::int) AS acquired", [1095857230, key]);
    if (!armed.acquired) throw new Error("Private strategy arming key is already held; fixture collision refused.");
    const action = mode === "wait"
      ? `PERFORM pg_advisory_xact_lock(1095857230, ${key});`
      : "RAISE EXCEPTION 'Synthetic owned strategy fault' USING ERRCODE='P0001';";
    await f.db.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $fixture$
      BEGIN
        IF ${own} THEN
          IF NOT pg_try_advisory_xact_lock(1095857230, ${key}) THEN ${action} END IF;
        END IF;
        RETURN ${returnRow};
      END;
      $fixture$`);
    await f.db.query(mode === "commit-failure"
      ? `CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT ON ${table} DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION ${name}()`
      : `CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    const release = async () => {
      if (released) return;
      const { rows: [result] } = await control.query<{ unlocked: boolean }>(
        "SELECT pg_advisory_unlock($1::int,$2::int) AS unlocked", [1095857230, key]);
      if (!result.unlocked) throw new Error("Strategy fault arming key was not released by its owner.");
      released = true;
    };
    return { blockerPid: backend.pid, release,
      close: async () => { try { await release(); } finally { await control.end(); } } };
  } catch (error) {
    await control.end(); // Session closure releases the only arming key.
    throw error;
  }
}

export async function strategyRowsAndAudit(f: StrategyFixture) {
  return { history: await f.history(), audit: await f.audit() };
}
