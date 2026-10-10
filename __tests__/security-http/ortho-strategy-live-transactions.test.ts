import { beforeAll, describe, expect, it } from "vitest";
import type { StrategyProjection } from "../../lib/ortho-treatment-strategy";
import { authedMutation, harness } from "./_server";
import { assertStrategyCiBoundary, createStrategyFixture, type StrategyFixture } from "./_ortho-strategy-live-fixture";
import { installStrategyFault, observeStrategyWait, openStrategyControl, strategyRowsAndAudit } from "./_ortho-strategy-live-locks";

// UNRUN source. Real built HTTP -> route -> authentic cookie/session -> actual
// strategy writer and PostgreSQL transaction. No vi.mock, recreated writer SQL,
// synthetic HTTP replies, runtime hooks, or disabled production constraints.
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => { assertStrategyCiBoundary(); h = await harness(); }, 240_000);

async function successful(response: Response, status = 201) {
  expect(response.status).toBe(status);
  return await response.json() as { ok: true; replayed: boolean; revision: StrategyProjection };
}
async function rejected(response: Response, status: number, code: string) {
  expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ code });
}
async function oneRevision(f: StrategyFixture, id: number) {
  expect(await f.counts()).toEqual({ revisions: 1, audits: 1 });
  expect((await f.history())[0]).toMatchObject({ id, version: 1, supersedes_revision_id: null,
    patient_id: f.patientId, recorded_patient_id: f.patientId, actor_user_id: f.userId });
  expect((await f.audit())[0]).toMatchObject({ action: "ortho.strategy_revision", entity_id: String(f.patientId),
    details: { revisionId: id, version: 1, actorUserId: f.userId, orthoCaseId: f.orthoCaseId } });
}
async function withFixture(label: string, body: (f: StrategyFixture) => Promise<void>) {
  const f = await createStrategyFixture(h, label);
  try { await body(f); } finally { await f.close(); }
}
async function assertEditablePrivatePlan(f: StrategyFixture) {
  expect((await f.db.query("SELECT id,patient_id,status,consent_at FROM treatment_plans WHERE id=$1", [f.planId])).rows)
    .toEqual([{ id: f.planId, patient_id: f.patientId, status: "active", consent_at: null }]);
}
async function closeGate(gate: Awaited<ReturnType<typeof installStrategyFault>>, pending: readonly (Promise<unknown> | undefined)[]) {
  // Even a failed disarm must close its connection (inside gate.close) and let
  // in-flight real requests settle; cleanup failure remains a test failure.
  try { await gate.close(); } finally { await Promise.allSettled(pending); }
}
async function closeTransaction(control: Awaited<ReturnType<typeof openStrategyControl>>, request?: Promise<Response>) {
  try { await control.query("ROLLBACK"); }
  finally { try { await control.end(); } finally { await Promise.allSettled([request]); } }
}
function revokePlanPermission(control: Awaited<ReturnType<typeof openStrategyControl>>, f: StrategyFixture) {
  // Canonical users.permissions is JSON serialized into TEXT, not a jsonb column.
  // Change only the owned account and preserve every other permission key.
  return control.query<{ permissions: Record<string, unknown> }>(
    `UPDATE users SET permissions=jsonb_set(permissions::jsonb,'{canEditPlans}','false'::jsonb)::text
      WHERE id=$1 AND username=$2 RETURNING permissions::jsonb AS permissions`, [f.userId, f.username]);
}
async function assertOwnedPermissions(f: StrategyFixture, canEditPlans: boolean) {
  expect((await f.db.query(
    "SELECT pg_typeof(permissions)::text AS storage_type, permissions::jsonb AS permissions FROM users WHERE id=$1 AND username=$2",
    [f.userId, f.username])).rows).toEqual([{ storage_type: "text", permissions: { ...f.permissions, canEditPlans } }]);
}
function assertPermissionRevoked(f: StrategyFixture, result: Awaited<ReturnType<typeof revokePlanPermission>>) {
  expect(result.rowCount).toBe(1);
  expect(result.rows).toEqual([{ permissions: { ...f.permissions, canEditPlans: false } }]);
}

const assignAway = (f: StrategyFixture) => authedMutation(`/api/plan-items/${f.itemId}/case`, f.session,
  "PUT", JSON.stringify({ caseId: null, priority: null }));
const removeItem = (f: StrategyFixture) => authedMutation(`/api/plans/${f.planId}/items?itemId=${f.itemId}`, f.session, "DELETE");
const mergeInto = (f: StrategyFixture, target: StrategyFixture) => authedMutation(`/api/patients/${target.patientId}/merge`, h.sessions.admin,
  "POST", JSON.stringify({ duplicatePatientNumber: f.patientNumber,
    confirmDuplicateNumber: f.patientNumber, reason: "Synthetic strategy serialization probe" }));

describe("actual strategy writer transaction serialization on disposable CI PostgreSQL", () => {
  it("reports the exact background SQL rejection instead of an unhandled rejection or lock-poll timeout", async () => {
    await withFixture("observer-sql-rejection", async f => {
      const control = await openStrategyControl(f); let operation: Promise<unknown> | undefined;
      try {
        const pid = (await control.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        // A deliberate read-only PG error exercises the observer itself. It is
        // not a substitute for the real writer/blocker proofs below.
        operation = control.query("SELECT 1 / 0 AS strategy_observer_error");
        const [observed, original] = await Promise.allSettled([
          observeStrategyWait(f, pid, "SELECT 1 / 0 AS strategy_observer_error", operation), operation,
        ]);
        if (observed.status !== "rejected" || original.status !== "rejected") {
          throw new Error("Both the SQL operation and its lock observer must reject.");
        }
        expect(original.reason).toMatchObject({ code: "22012" });
        expect(observed.reason).toBe(original.reason);
        expect(await f.counts()).toEqual({ revisions: 0, audits: 0 });
      } finally { try { await Promise.allSettled([operation]); } finally { await control.end(); } }
    });
  }, 60_000);

  it.each(["replay", "stale", "command-conflict"] as const)("serializes two live HTTP appends: %s", async mode => {
    await withFixture(`concurrent-${mode}`, async f => {
      const before = await f.snapshot(), first = f.command();
      const second = mode === "replay" ? first : mode === "stale" ? f.command()
        : { ...first, reason: "Different payload with the same command identity" };
      const gate = await installStrategyFault(f, "strategy-audit");
      const pending: Promise<Response>[] = [];
      try {
        pending.push(f.post(first));
        const writer = await observeStrategyWait(f, gate.blockerPid, "INSERT INTO audit_log", pending[0]);
        pending.push(f.post(second));
        const waiter = await observeStrategyWait(f, writer.pid, "SELECT id FROM patients", pending[1]);
        expect(waiter.pid).not.toBe(writer.pid);
        await gate.release();
        const saved = await successful(await pending[0]); expect(saved.replayed).toBe(false);
        if (mode === "replay") {
          const replay = await successful(await pending[1], 200);
          expect(replay.replayed).toBe(true); expect(replay.revision).toEqual(saved.revision);
        } else await rejected(await pending[1], 409, mode === "stale" ? "stale_revision" : "command_conflict");
        await oneRevision(f, saved.revision.revisionId); expect(await f.snapshot()).toEqual(before);
      } finally { await closeGate(gate, pending); }
    });
  }, 60_000);

  it.each(["assignment", "deletion"] as const)("commits its historical link before the actual %s writer proceeds", async mutation => {
    await withFixture(`writer-before-${mutation}`, async f => {
      await assertEditablePrivatePlan(f);
      const gate = await installStrategyFault(f, "strategy-audit");
      const pending: Promise<Response>[] = [];
      try {
        pending.push(f.post());
        const writer = await observeStrategyWait(f, gate.blockerPid, "INSERT INTO audit_log", pending[0]);
        pending.push(mutation === "assignment" ? assignAway(f) : removeItem(f));
        // Both canonical paths lock the patient first (removePlanItem -> lockPlan).
        await observeStrategyWait(f, writer.pid, "SELECT id FROM patients", pending[1]);
        await gate.release();
        const saved = await successful(await pending[0]); expect((await pending[1]).status).toBe(200);
        await oneRevision(f, saved.revision.revisionId);
        expect((await f.history())[0]).toMatchObject({ rows: [{ planItems: [{ id: f.itemId, serviceName: `${f.marker}_ITEM` }] }] });
        const currentResponse = await f.read(); expect(currentResponse.status).toBe(200);
        const current = await currentResponse.json();
        expect(current.revision.rows[0].planLinks.items[0]).toMatchObject({ id: f.itemId,
          serviceName: `${f.marker}_ITEM`, current: { state: mutation === "assignment" ? "moved" : "missing", status: null } });
        expect((await f.db.query("SELECT id,case_id FROM plan_items WHERE id=$1", [f.itemId])).rows)
          .toEqual(mutation === "deletion" ? [] : [{ id: f.itemId, case_id: null }]);
      } finally { await closeGate(gate, pending); }
    });
  }, 60_000);

  it.each(["assignment", "deletion"] as const)("rechecks membership after the actual %s wins the lock", async mutation => {
    await withFixture(`${mutation}-before-writer`, async f => {
      await assertEditablePrivatePlan(f);
      const gate = await installStrategyFault(f, mutation === "assignment" ? "item-update" : "item-delete");
      const pending: Promise<Response>[] = [];
      try {
        pending.push(mutation === "assignment" ? assignAway(f) : removeItem(f));
        const changer = await observeStrategyWait(f, gate.blockerPid,
          mutation === "assignment" ? "UPDATE plan_items SET case_id" : "DELETE FROM plan_items", pending[0]);
        pending.push(f.post());
        await observeStrategyWait(f, changer.pid, "SELECT id FROM patients", pending[1]);
        await gate.release();
        expect((await pending[0]).status).toBe(200);
        await rejected(await pending[1], 409, "item_scope_mismatch");
        expect(await f.counts()).toEqual({ revisions: 0, audits: 0 });
      } finally { await closeGate(gate, pending); }
    });
  }, 60_000);

  it.each(["problem", "item"] as const)("refuses a %s moved by a competing PG transaction after waiting on that exact reference row", async reference => {
    // There is no canonical problem-reassignment HTTP endpoint in pinned main.
    // The competing fixture UPDATE is deliberate; the subject writer is real.
    await withFixture(`${reference}-external-reassignment`, async f => {
      const control = await openStrategyControl(f); let request: Promise<Response> | undefined;
      try {
        await control.query("BEGIN");
        if (reference === "problem") await control.query("UPDATE patient_problems SET case_id=NULL WHERE id=$1 AND patient_id=$2", [f.problemId, f.patientId]);
        else await control.query("UPDATE plan_items SET case_id=NULL WHERE id=$1 AND plan_id=$2", [f.itemId, f.planId]);
        const pid = (await control.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        request = f.post(); await observeStrategyWait(f, pid,
          reference === "problem" ? "SELECT p.id FROM patient_problems" : "SELECT i.id FROM plan_items", request);
        await control.query("COMMIT");
        await rejected(await request, 409, reference === "problem" ? "problem_scope_mismatch" : "item_scope_mismatch");
        expect(await f.counts()).toEqual({ revisions: 0, audits: 0 });
      } finally { await closeTransaction(control, request); }
    });
  }, 60_000);

  it.each(["permission", "credential", "inactive", "role"] as const)("revalidates %s revocation inside the blocked transaction", async kind => {
    await withFixture(`revoke-before-${kind}`, async f => {
      const before = await f.snapshot();
      const control = await openStrategyControl(f); let request: Promise<Response> | undefined;
      try {
        await control.query("BEGIN");
        // Only this test's synthetic account is changed. Outer route reads see
        // its previous committed state; the store's users FOR SHARE must wait.
        if (kind === "permission") {
          await assertOwnedPermissions(f, true);
          assertPermissionRevoked(f, await revokePlanPermission(control, f));
        } else if (kind === "credential") await control.query("UPDATE users SET password_hash=password_hash || '-synthetic-revoked' WHERE id=$1", [f.userId]);
        else if (kind === "role") await control.query("UPDATE users SET role='reception' WHERE id=$1", [f.userId]);
        else await control.query("UPDATE users SET is_active=false WHERE id=$1", [f.userId]);
        const pid = (await control.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        request = f.post();
        const waiting = await observeStrategyWait(f, pid, "FROM users WHERE LOWER(username)", request);
        expect(waiting.query).toContain("FOR SHARE");
        await control.query("COMMIT");
        if (kind === "permission") await assertOwnedPermissions(f, false);
        await rejected(await request, kind === "permission" ? 403 : 401,
          kind === "permission" ? "plan_links_unavailable" : "session_expired");
        expect(await f.counts()).toEqual({ revisions: 0, audits: 0 }); expect(await f.snapshot()).toEqual(before);
      } finally { await closeTransaction(control, request); }
    });
  }, 60_000);

  it("keeps its locked authority until commit and applies a waiting permission revocation to the next append", async () => {
    await withFixture("revoke-after-lock", async f => {
      const gate = await installStrategyFault(f, "strategy-audit"), control = await openStrategyControl(f);
      let request: Promise<Response> | undefined, revoke: ReturnType<typeof revokePlanPermission> | undefined;
      try {
        await assertOwnedPermissions(f, true);
        request = f.post(); const writer = await observeStrategyWait(f, gate.blockerPid, "INSERT INTO audit_log", request);
        revoke = revokePlanPermission(control, f);
        await observeStrategyWait(f, writer.pid, "UPDATE users SET permissions", revoke);
        await assertOwnedPermissions(f, true);
        await gate.release(); const saved = await successful(await request);
        assertPermissionRevoked(f, await revoke); await assertOwnedPermissions(f, false);
        await rejected(await f.post(f.command({ expectedRevisionId: saved.revision.revisionId })), 403, "plan_links_unavailable");
        await oneRevision(f, saved.revision.revisionId);
      } finally { try { await closeGate(gate, [request, revoke]); } finally { await control.end(); } }
    });
  }, 60_000);

  it("serializes actual patient merge after the real writer and preserves committed provenance", async () => {
    await withFixture("writer-before-merge", async f => {
      const target = await createStrategyFixture(h, "merge-target", { status: "completed" });
      const gate = await installStrategyFault(f, "strategy-audit");
      const pending: Promise<Response>[] = [];
      try {
        pending.push(f.post()); const writer = await observeStrategyWait(f, gate.blockerPid, "INSERT INTO audit_log", pending[0]);
        pending.push(mergeInto(f, target)); await observeStrategyWait(f, writer.pid, "WHERE id = ANY", pending[1]);
        await gate.release(); const saved = await successful(await pending[0]);
        expect((await pending[1]).status).toBe(200);
        expect(await f.counts()).toEqual({ revisions: 1, audits: 1 });
        expect((await f.history())[0]).toMatchObject({ id: saved.revision.revisionId, version: 1,
          patient_id: target.patientId, recorded_patient_id: f.patientId, ortho_case_id: f.orthoCaseId,
          clinical_case_id: f.clinicalCaseId, command_id: expect.any(String), reason: saved.revision.reason });
        expect((await f.db.query("SELECT id FROM patients WHERE id=$1", [f.patientId])).rows).toEqual([]);
        const read = await f.read(undefined, h.sessions.admin); expect(read.status).toBe(200);
        expect((await read.json()).revision).toMatchObject({ revisionId: saved.revision.revisionId,
          patientId: target.patientId, recordedPatientId: f.patientId, rows: saved.revision.rows });
      } finally { try { await closeGate(gate, pending); } finally { await target.close(); } }
    });
  }, 60_000);

  it("fails the pre-merge owner request when actual merge wins before the strategy patient lock", async () => {
    await withFixture("merge-before-writer", async f => {
      const target = await createStrategyFixture(h, "merge-first-target", { status: "completed" });
      const gate = await installStrategyFault(f, "ortho-owner-update");
      const pending: Promise<Response>[] = [];
      try {
        pending.push(mergeInto(f, target));
        const merger = await observeStrategyWait(f, gate.blockerPid, "UPDATE ortho_cases SET patient_id", pending[0]);
        pending.push(f.post(f.command(), h.sessions.admin));
        await observeStrategyWait(f, merger.pid, "SELECT id FROM patients", pending[1]);
        await gate.release(); expect((await pending[0]).status).toBe(200);
        await rejected(await pending[1], 404, "patient_not_found");
        expect(await f.counts()).toEqual({ revisions: 0, audits: 0 });
      } finally { try { await closeGate(gate, pending); } finally { await target.close(); } }
    });
  }, 60_000);

  it.each(["audit-failure", "commit-failure"] as const)("rolls back revision plus audit on injected %s and safely retries the same command", async mode => {
    await withFixture(mode, async f => {
      const before = await f.snapshot(), command = f.command();
      const fault = await installStrategyFault(f, "strategy-audit", mode);
      try {
        await rejected(await f.post(command), mode === "commit-failure" ? 503 : 500,
          mode === "commit-failure" ? "write_unconfirmed" : "strategy_result_unknown");
        expect(await strategyRowsAndAudit(f)).toEqual({ history: [], audit: [] });
        expect(await f.snapshot()).toEqual(before);
        await fault.release();
        const saved = await successful(await f.post(command)); expect(saved.replayed).toBe(false);
        await oneRevision(f, saved.revision.revisionId);
        const exact = await strategyRowsAndAudit(f);
        const replay = await successful(await f.post(command), 200);
        expect(replay.revision).toEqual(saved.revision); expect(replay.replayed).toBe(true);
        expect(await strategyRowsAndAudit(f)).toEqual(exact); expect(await f.snapshot()).toEqual(before);
      } finally { await fault.close(); }
    });
  }, 60_000);
});
