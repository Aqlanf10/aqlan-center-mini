import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { backupSelectColumns, insertStatement } from "../../lib/backup";
import { backupSqlLines } from "../../lib/db";
import type { OrthoStrategyReadResult, OrthoStrategyWriteResult } from "../../lib/ortho-treatment-strategy-store";
import type { StrategyCommand } from "../../lib/ortho-treatment-strategy";
import { authedGet, authedMutation, baseUrl, harness, loginStaff } from "./_server";
import { assertStrategyCiBoundary, createStrategyFixture, type StrategyFixture, type StrategySession } from "./_ortho-strategy-live-fixture";

/** Real built Next HTTP routes, proxy, signed login cookies and PostgreSQL.
 * No vi.mock, route.fulfill, synthetic HTTP response, or direct strategy-writer
 * invocation. Raw SQL only creates UUID-owned fixtures, changes an explicitly
 * owned authority/reference, reads witnesses, or seeds labelled malformed JSON.
 * Authored source is not evidence that these tests have run. */
let h: Awaited<ReturnType<typeof harness>>;
const opened: StrategyFixture[] = [];
beforeAll(async () => { assertStrategyCiBoundary(); h = await harness(); });
afterEach(async () => { await Promise.all(opened.splice(0).map(fixture => fixture.close())); });
async function fixture(label: string, options: Parameters<typeof createStrategyFixture>[2] = {}) {
  const value = await createStrategyFixture(h, label, options); opened.push(value); return value;
}
type ReadSuccess = Extract<OrthoStrategyReadResult, { ok: true }>;
type WriteSuccess = Extract<OrthoStrategyWriteResult, { ok: true }>;
async function read(f: StrategyFixture, revisionId?: number, as?: StrategySession): Promise<ReadSuccess> {
  const response = await f.read(revisionId, as);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const body = await response.json() as ReadSuccess; expect(body.ok).toBe(true); return body;
}
async function write(f: StrategyFixture, command: StrategyCommand, status = 201, as?: StrategySession): Promise<WriteSuccess> {
  const response = await f.post(command, as); expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const body = await response.json() as WriteSuccess;
  expect(body.ok).toBe(true); expect(body.replayed).toBe(status === 200); return body;
}
async function refusal(response: Response, status: number, code?: string) {
  expect(response.status).toBe(status);
  const body = await response.json() as Record<string, unknown>;
  expect(typeof body.message).toBe("string");
  if (code) expect(body.code).toBe(code);
  expect(body).not.toHaveProperty("revision"); expect(body).not.toHaveProperty("history");
  return body;
}
const unlinked = (f: StrategyFixture, overrides: Partial<StrategyCommand> = {}) => f.command({
  rows: [{ problemId: f.problemId, objective: "Explicit objective", strategy: "Explicit strategy",
    planItemIds: [], rationale: null }], ...overrides,
});
async function proof(f: StrategyFixture) {
  return { unrelated: await f.snapshot(), history: await f.history(), audit: await f.audit() };
}
async function unchanged(f: StrategyFixture, before: Awaited<ReturnType<typeof proof>>) {
  expect(await f.snapshot()).toEqual(before.unrelated);
  expect(await f.history()).toEqual(before.history);
  expect(await f.audit()).toEqual(before.audit);
}
async function expectCommitted(f: StrategyFixture, count: number) {
  expect(await f.counts()).toEqual({ revisions: count, audits: count });
  const rows = await f.history(), audits = await f.audit();
  expect(rows.map(row => row.version)).toEqual(Array.from({ length: count }, (_, index) => index + 1));
  for (const [index, row] of rows.entries()) {
    expect(row.supersedes_revision_id).toBe(index ? rows[index - 1].id : null);
    expect(audits[index]).toMatchObject({ action: "ortho.strategy_revision", entity: "patient",
      entity_id: String(row.patient_id), actor: row.created_by,
      details: { revisionId: row.id, orthoCaseId: f.orthoCaseId, clinicalCaseId: f.clinicalCaseId,
        actorUserId: row.actor_user_id, reason: row.reason, version: index + 1,
        supersedesRevisionId: row.supersedes_revision_id, recordedPatientId: row.recorded_patient_id } });
  }
}

/** Match all canonical doctorOwnsPatient witness families. The merge refusal
 * below is only meaningful when no positive current-owner witness survives. */
async function ownershipWitnesses(f: StrategyFixture, patientId: number) {
  return (await f.db.query<{ witness: string }>(
    `SELECT 'patient' AS witness FROM patients WHERE id=$1 AND primary_doctor_id=$2
     UNION ALL SELECT 'plan' FROM treatment_plans WHERE patient_id=$1 AND primary_doctor_id=$2 AND status='active'
     UNION ALL SELECT 'visit' FROM visits WHERE patient_id=$1 AND doctor_id=$2
     UNION ALL SELECT 'planned_visit' FROM planned_visits WHERE patient_id=$1 AND doctor_id=$2
     UNION ALL SELECT 'appointment' FROM appointments WHERE patient_id=$1 AND doctor_id=$2
     UNION ALL SELECT 'referral' FROM patient_referrals WHERE patient_id=$1 AND kind='internal' AND to_party_id=$2
       AND workflow_state NOT IN ('declined','cancelled') ORDER BY witness`, [patientId, f.partyId])).rows;
}

describe("orthodontic strategy over the built security-HTTP server", () => {
  it("enforces signed-session role and patient BOLA boundaries on reads and writes", async () => {
    const a = await fixture("role-A"), b = await fixture("role-B"), assistant = await fixture("assistant");
    await assistant.db.query("UPDATE users SET role='assistant' WHERE id=$1 AND username=$2", [assistant.userId, assistant.username]);
    const assistantSession = await loginStaff(assistant.username, assistant.password);
    const first = await write(a, a.command()); await write(b, b.command());
    const before = await proof(a), otherBefore = await proof(b);
    for (const as of [h.sessions.cashier, h.sessions.accountant, assistantSession]) {
      await refusal(await a.read(undefined, as), 403);
      await refusal(await a.post(a.command(), as), 403);
    }
    for (const as of [h.sessions.portalA, h.sessions.portalB]) {
      await refusal(await a.read(undefined, as), 401);
      await refusal(await a.post(a.command(), as), 401);
    }
    await refusal(await fetch(`${baseUrl}${a.path}`, { redirect: "manual" }), 401);
    await refusal(await fetch(`${baseUrl}${a.path}`, { method: "POST", redirect: "manual",
      headers: { Origin: baseUrl, "Content-Type": "application/json" }, body: JSON.stringify(a.command()) }), 401);
    for (const [target, as, marker] of [[b, a.session, b.marker], [a, b.session, a.marker]] as const) {
      for (const response of [await target.read(undefined, as), await target.post(target.command(), as)]) {
        expect(JSON.stringify(await refusal(response, 403))).not.toContain(marker);
      }
    }
    expect(await read(a, undefined, h.sessions.reception)).toMatchObject({ clinicalWritable: false, canRevise: false });
    expect(await read(a, undefined, h.sessions.admin)).toMatchObject({ clinicalWritable: true, canRevise: true });
    await refusal(await a.post(a.command(), h.sessions.reception), 403);
    await unchanged(a, before); await unchanged(b, otherBefore);
    await write(a, a.command({ expectedRevisionId: first.revision.revisionId }), 201, h.sessions.admin);
    expect(await a.snapshot()).toEqual(before.unrelated);
    await expectCommitted(a, 2); await expectCommitted(b, 1);
  });

  it("rejects malformed selectors and client-supplied owner/actor fields without writing", async () => {
    const f = await fixture("strict"); const before = await proof(f);
    for (const suffix of ["?revisionId=0", "?revisionId=1e2", "?revisionId=-1", "?revisionId=1&revisionId=2",
      "?revisionId=9007199254740992", `?patientId=${f.patientId}`]) {
      await refusal(await authedGet(`${f.path}${suffix}`, f.session), 400);
    }
    await refusal(await f.read(2147483646), 404, "revision_not_found");
    await refusal(await f.post({ ...f.command(), patientId: f.patientId, createdBy: "forged actor" }), 400, "invalid_command");
    await refusal(await f.post(f.command({ reason: "   " })), 400, "reason_required");
    await refusal(await f.post(f.command({ rows: [] })), 400, "invalid_rows");
    await unchanged(f, before); expect(await f.counts()).toEqual({ revisions: 0, audits: 0 });
  });

  it("reports a missing bridge and never creates a bridge from GET or POST", async () => {
    const f = await fixture("no-bridge");
    await f.db.query("UPDATE clinical_cases SET ortho_case_id=NULL WHERE id=$1 AND patient_id=$2", [f.clinicalCaseId, f.patientId]);
    const before = await proof(f);
    expect(await read(f)).toMatchObject({ state: "bridge_missing", clinicalCaseId: null,
      canRevise: false, history: [], revision: null, choices: { problems: [], planItems: [] } });
    await refusal(await f.post(f.command()), 409, "bridge_missing");
    await unchanged(f, before); expect(await f.counts()).toEqual({ revisions: 0, audits: 0 });
  });

  it.each(["canViewPlans", "canEditPlans"] as const)(
    "rechecks revoked %s for new, retained, removed and replayed links after a prior successful read", async permission => {
      const f = await fixture(`revoke-${permission}`);
      const initial = unlinked(f); const first = await write(f, initial);
      const linked = f.command({ expectedRevisionId: first.revision.revisionId });
      const second = await write(f, linked);
      expect(await read(f)).toMatchObject({ canRevise: true, planVisible: true, planLinksWritable: true });
      await f.setPermissions({ [permission]: false });
      const before = await proof(f);
      const current = await read(f), historical = await read(f, first.revision.revisionId);
      expect(current.canRevise).toBe(false); expect(historical.canRevise).toBe(false);
      expect(current.planLinksWritable).toBe(false);
      if (permission === "canViewPlans") {
        expect(current.planVisible).toBe(false); expect(current.choices.planItems).toEqual([]);
        expect(current.revision!.rows[0].planLinks).toEqual({ state: "restricted" });
        expect(JSON.stringify(current)).not.toContain(`${f.marker}_ITEM`);
      } else {
        expect(current.planVisible).toBe(true);
        expect(current.revision!.rows[0].planLinks).toMatchObject({ state: "allowed", items: [{ id: f.itemId }] });
      }
      for (const command of [linked, f.command({ expectedRevisionId: second.revision.revisionId }),
        unlinked(f, { expectedRevisionId: second.revision.revisionId })]) {
        await refusal(await f.post(command), 403, "plan_links_unavailable");
      }
      // Replay uses that exact original command's authority, not a later head.
      expect((await write(f, initial, 200)).revision.revisionId).toBe(first.revision.revisionId);
      await unchanged(f, before); await expectCommitted(f, 2);
      const empty = await fixture(`new-links-${permission}`, { permissions: { [permission]: false } });
      const emptyBefore = await proof(empty);
      await refusal(await empty.post(empty.command()), 403, "plan_links_unavailable");
      await unchanged(empty, emptyBefore); expect(await empty.counts()).toEqual({ revisions: 0, audits: 0 });
    },
  );

  it("requires predecessor link authority when replaying a removal even after later link-free revisions", async () => {
    const f = await fixture("removal-replay"); const linked = f.command(); const one = await write(f, linked);
    const removal = unlinked(f, { expectedRevisionId: one.revision.revisionId }); const two = await write(f, removal);
    const third = unlinked(f, { expectedRevisionId: two.revision.revisionId }); const three = await write(f, third);
    await f.setPermissions({ canViewPlans: false, canEditPlans: false });
    const before = await proof(f);
    expect((await read(f)).canRevise).toBe(true);
    expect((await read(f, one.revision.revisionId)).canRevise).toBe(false);
    await refusal(await f.post(removal), 403, "plan_links_unavailable");
    await refusal(await f.post(linked), 403, "plan_links_unavailable");
    expect((await write(f, third, 200)).revision.revisionId).toBe(three.revision.revisionId);
    await unchanged(f, before); await expectCommitted(f, 3);
    const four = await write(f, unlinked(f, { expectedRevisionId: three.revision.revisionId }));
    expect(four.revision.version).toBe(4); expect(await f.snapshot()).toEqual(before.unrelated);
    await expectCommitted(f, 4);
  });

  it("returns the original committed revision on replay after head advancement, and rejects stale/conflicting commands", async () => {
    const f = await fixture("replay"); const firstCommand = f.command(); const one = await write(f, firstCommand);
    const secondCommand = f.command({ expectedRevisionId: one.revision.revisionId, reason: "Explicit second correction" });
    const two = await write(f, secondCommand); const before = await proof(f);
    expect((await write(f, firstCommand, 200)).revision).toEqual(one.revision);
    expect((await write(f, secondCommand, 200)).revision).toEqual(two.revision);
    await refusal(await f.post({ ...firstCommand, reason: "Different payload with reused command" }), 409, "command_conflict");
    await refusal(await f.post(f.command({ expectedRevisionId: one.revision.revisionId })), 409, "stale_revision");
    await refusal(await f.post(f.command()), 409, "stale_revision");
    expect((await read(f)).history.map(row => row.revisionId)).toEqual([two.revision.revisionId, one.revision.revisionId]);
    expect((await read(f, one.revision.revisionId)).revision).toEqual(one.revision);
    await unchanged(f, before); await expectCommitted(f, 2);
  });

  it.each(["identical", "different-command", "same-command-different-payload"] as const)(
    "serializes concurrent %s requests to one history row and one audit", async mode => {
      const f = await fixture(`concurrent-${mode}`), before = await f.snapshot();
      const first = f.command();
      const second = mode === "identical" ? first : mode === "different-command" ? f.command()
        : { ...first, reason: "Concurrent conflicting correction" };
      const responses = await Promise.all([f.post(first), f.post(second)]);
      expect(responses.map(response => response.status).sort()).toEqual(mode === "identical" ? [200, 201] : [201, 409]);
      const bodies = await Promise.all(responses.map(response => response.json())) as Array<Record<string, unknown>>;
      if (mode === "identical") {
        expect(bodies[0].revision).toEqual(bodies[1].revision);
        expect(bodies.map(body => body.replayed).sort()).toEqual([false, true]);
      } else {
        expect(bodies[responses.findIndex(response => response.status === 409)].code)
          .toBe(mode === "different-command" ? "stale_revision" : "command_conflict");
      }
      expect(await f.snapshot()).toEqual(before); await expectCommitted(f, 1);
      const saved = await f.history();
      expect([first.commandId, second.commandId]).toContain(saved[0].command_id);
      expect([first.reason, second.reason]).toContain(saved[0].reason);
    },
  );

  it.each(["completed", "discontinued"] as const)(
    "appends retrospective %s corrections without reopening or rewriting the first revision", async status => {
      const f = await fixture(`historical-${status}`, { status }); const before = await f.snapshot();
      const first = await write(f, f.command({ reason: "Historical documented correction" }));
      expect(first.revision.recordingContext).toBe("retrospective");
      expect(await f.snapshot()).toEqual(before);
      const original = (await f.history())[0], firstAudit = (await f.audit())[0];
      // A later canonical label/status change must not rewrite a saved snapshot.
      await f.db.query(`UPDATE patient_problems SET label='New current label',status='resolved',resolved_at=clock_timestamp()
        WHERE id=$1 AND patient_id=$2`, [f.problemId, f.patientId]);
      await f.db.query("UPDATE plan_items SET service_name='New current item',status='done' WHERE id=$1 AND plan_id=$2", [f.itemId, f.planId]);
      const afterFixtureChange = await f.snapshot();
      const historical = (await read(f, first.revision.revisionId)).revision!;
      expect(historical.rows[0]).toMatchObject({ problem: { label: `${f.marker}_PROBLEM` },
        currentProblem: { state: "available", status: "resolved" },
        planLinks: { state: "allowed", items: [{ serviceName: `${f.marker}_ITEM`, current: { state: "available", status: "done" } }] } });
      const second = await write(f, f.command({ expectedRevisionId: first.revision.revisionId, reason: "Later explicit historical correction" }));
      expect(second.revision).toMatchObject({ recordingContext: "retrospective", version: 2,
        rows: [{ problem: { label: "New current label" }, planLinks: { state: "allowed", items: [{ serviceName: "New current item" }] } }] });
      expect((await f.history())[0]).toEqual(original); expect((await f.audit())[0]).toEqual(firstAudit);
      expect(await f.snapshot()).toEqual(afterFixtureChange); await expectCommitted(f, 2);
    },
  );

  it("refuses same-patient cross-case and other-patient reference IDs and exact revision selectors", async () => {
    const f = await fixture("scope-A"), foreign = await fixture("scope-B");
    const otherOrtho = (await f.db.query<{ id: number }>(
      "INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,$2,'completed') RETURNING id",
      [f.patientId, f.username])).rows[0].id;
    const otherClinical = (await f.db.query<{ id: number }>(
      `INSERT INTO clinical_cases(patient_id,specialty,title,created_by,ortho_case_id)
       VALUES($1,'orthodontics','Separate synthetic case',$2,$3) RETURNING id`, [f.patientId, f.username, otherOrtho])).rows[0].id;
    const otherProblem = (await f.db.query<{ id: number }>(
      `INSERT INTO patient_problems(patient_id,label,case_id,noted_by)
       VALUES($1,'Separate synthetic problem',$2,$3) RETURNING id`, [f.patientId, otherClinical, f.username])).rows[0].id;
    const otherItem = (await f.db.query<{ id: number }>(
      "INSERT INTO plan_items(plan_id,case_id,service_name) VALUES($1,$2,'Separate item') RETURNING id",
      [f.planId, otherClinical])).rows[0].id;
    const otherCommand = f.command();
    otherCommand.rows[0] = { ...otherCommand.rows[0], problemId: otherProblem, planItemIds: [otherItem] };
    const otherSavedResponse = await authedMutation(`/api/ortho/${otherOrtho}/strategy`, f.session, "POST", JSON.stringify(otherCommand));
    expect(otherSavedResponse.status).toBe(201);
    const otherSaved = await otherSavedResponse.json() as WriteSuccess;
    expect(otherSaved).toMatchObject({ ok: true, replayed: false, revision: { patientId: f.patientId, orthoCaseId: otherOrtho } });
    const otherHistory = async () => (await f.db.query("SELECT to_jsonb(r) AS row FROM ortho_strategy_revisions r WHERE ortho_case_id=$1 ORDER BY version", [otherOrtho])).rows;
    const otherAudit = async () => (await f.db.query("SELECT to_jsonb(a) AS row FROM audit_log a WHERE action='ortho.strategy_revision' AND details->>'orthoCaseId'=$1 ORDER BY id", [String(otherOrtho)])).rows;
    const otherHistoryBefore = await otherHistory(), otherAuditBefore = await otherAudit();
    expect(otherHistoryBefore).toHaveLength(1); expect(otherAuditBefore).toHaveLength(1);
    const foreignRevision = await write(foreign, foreign.command());
    const before = await proof(f), foreignBefore = await proof(foreign);
    for (const problemId of [otherProblem, foreign.problemId]) {
      const command = f.command(); command.rows[0].problemId = problemId;
      expect(JSON.stringify(await refusal(await f.post(command), 409, "problem_scope_mismatch"))).not.toContain(foreign.marker);
    }
    for (const itemId of [otherItem, foreign.itemId]) {
      const command = f.command(); command.rows[0].planItemIds = [itemId];
      expect(JSON.stringify(await refusal(await f.post(command), 409, "item_scope_mismatch"))).not.toContain(foreign.marker);
    }
    for (const revisionId of [otherSaved.revision.revisionId, foreignRevision.revision.revisionId]) {
      await refusal(await f.read(revisionId), 404, "revision_not_found");
      await refusal(await f.post(f.command({ expectedRevisionId: revisionId })), 409, "stale_revision");
    }
    await unchanged(f, before); await unchanged(foreign, foreignBefore);
    expect(await otherHistory()).toEqual(otherHistoryBefore); expect(await otherAudit()).toEqual(otherAuditBefore);
    expect(await f.counts()).toEqual({ revisions: 0, audits: 0 }); await expectCommitted(foreign, 1);
  });

  it("fails closed for a malformed stored predecessor even when its newest revision is well formed", async () => {
    const f = await fixture("corrupt-json"); const firstCommand = f.command(); const first = await write(f, firstCommand);
    // Deliberate owned corruption fixture: schema allows a JSON array of one
    // object, but the strict stored document decoder rejects that object's
    // missing clinical fields. Do not disable immutability or lineage triggers.
    const malformed = (await f.db.query<{ id: number }>(`INSERT INTO ortho_strategy_revisions
      (patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,version,supersedes_revision_id,
       actor_user_id,created_by,reason,recording_context,command_id,request_fingerprint,rows)
      VALUES($1,$1,$2,$3,2,$4,$5,$6,'Explicit malformed JSON fixture','current',$7,$8,'[{}]'::jsonb) RETURNING id`,
      [f.patientId, f.orthoCaseId, f.clinicalCaseId, first.revision.revisionId, f.userId,
        `Synthetic clinician ${f.uuid}`, `malformed_${f.uuid}`, "a".repeat(64)])).rows[0].id;
    const original = (await f.history())[0];
    const head = (await f.db.query<{ id: number }>(`INSERT INTO ortho_strategy_revisions
      (patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,version,supersedes_revision_id,
       actor_user_id,created_by,reason,recording_context,command_id,request_fingerprint,rows)
      VALUES($1,$1,$2,$3,3,$4,$5,$6,'Well-formed head above corrupt predecessor','current',$7,$8,$9::jsonb) RETURNING id`,
      [f.patientId, f.orthoCaseId, f.clinicalCaseId, malformed, f.userId,
        `Synthetic clinician ${f.uuid}`, `valid_head_${f.uuid}`, "b".repeat(64), JSON.stringify(original.rows)])).rows[0].id;
    const before = await proof(f);
    for (const revisionId of [undefined, first.revision.revisionId, head]) await refusal(await f.read(revisionId), 500, "invalid_stored_revision");
    await refusal(await f.post(firstCommand), 500, "invalid_stored_revision");
    await refusal(await f.post(f.command({ expectedRevisionId: head })), 500, "invalid_stored_revision");
    await unchanged(f, before);
    // Only the first row was written through the application and has an audit.
    expect(await f.counts()).toEqual({ revisions: 3, audits: 1 });
  });
});

/** Exercise the real read-only backup path using explicit fixture connection;
 * no ensureSchema, file export, restore, or remote upload is invoked here. */
async function assertBackupContainsExactHistory(f: StrategyFixture) {
  await f.assertDatabaseIdentity();
  const columns = (await f.db.query<{ column_name: string; data_type: string }>(
    `SELECT column_name,data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name='ortho_strategy_revisions' ORDER BY ordinal_position`)).rows;
  const rows = (await f.db.query<Record<string, unknown>>(
    `SELECT ${backupSelectColumns(columns)} FROM ortho_strategy_revisions WHERE ortho_case_id=$1 ORDER BY version`, [f.orthoCaseId])).rows;
  expect(rows.length).toBeGreaterThan(0);
  const columnNames = columns.map(column => column.column_name), types = new Map(columns.map(column => [column.column_name, column.data_type]));
  const expected = rows.map(row => `${insertStatement("ortho_strategy_revisions", columnNames, row, types)}\n`);
  const actual: string[] = [];
  for await (const line of backupSqlLines(f.db)) {
    if (line.startsWith("INSERT INTO ortho_strategy_revisions ")) actual.push(line);
  }
  for (const line of expected) expect(actual.filter(candidate => candidate === line)).toHaveLength(1);
  expect(columnNames).toEqual(expect.arrayContaining(["patient_id", "recorded_patient_id", "actor_user_id", "created_by",
    "created_at", "reason", "command_id", "request_fingerprint", "version", "supersedes_revision_id", "rows"]));
  return rows;
}

describe("actual HTTP-created strategy history through merge and backup", () => {
  it("preserves complete history and original provenance while access/replay follow the new canonical owner", async () => {
    const source = await fixture("merge-source", { status: "completed" }), target = await fixture("merge-target");
    const firstCommand = source.command(); const one = await write(source, firstCommand);
    const secondCommand = source.command({ expectedRevisionId: one.revision.revisionId,
      reason: "Quoted clinician correction: 'preserve this' and Arabic سبب" });
    const two = await write(source, secondCommand);
    expect(await ownershipWitnesses(source, source.patientId)).toEqual([{ witness: "patient" }]);
    expect(await ownershipWitnesses(source, target.patientId)).toEqual([]);
    const before = await proof(source);
    const backupBefore = await assertBackupContainsExactHistory(source);
    await unchanged(source, before); await expectCommitted(source, 2);
    const merged = await authedMutation(`/api/patients/${target.patientId}/merge`, h.sessions.admin, "POST", JSON.stringify({
      duplicatePatientNumber: source.patientNumber, confirmDuplicateNumber: source.patientNumber,
      reason: "Explicit synthetic duplicate merge for strategy regression",
    }));
    expect(merged.status).toBe(200);
    expect(await merged.json()).toMatchObject({ patient: { id: target.patientId },
      moved: { "ortho_strategy_revisions.patient_id": 2, "ortho_cases.patient_id": 1, "clinical_cases.patient_id": 1 } });
    expect((await source.db.query("SELECT id FROM patients WHERE id=$1", [source.patientId])).rows).toEqual([]);
    await refusal(await authedGet(`/api/patients/${source.patientId}`, h.sessions.admin), 404);
    expect(await ownershipWitnesses(source, target.patientId)).toEqual([]);
    expect(await ownershipWitnesses(target, target.patientId)).toEqual([{ witness: "patient" }]);
    expect(source.permissions.canViewAllPatients).toBe(false);
    expect((await source.db.query("SELECT primary_doctor_id FROM patients WHERE id=$1", [target.patientId])).rows)
      .toEqual([{ primary_doctor_id: target.partyId }]);
    const movedRows = await source.history();
    expect(movedRows).toEqual(before.history.map(row => ({ ...row, patient_id: target.patientId })));
    expect(await source.audit()).toEqual(before.audit);
    const afterMerge = await source.snapshot();
    // The canonical merge may only transfer the owned patient's references;
    // all unrelated case/financial/procedure rows retain every field.
    for (const [table, raw] of Object.entries(before.unrelated)) {
      const expected = (raw as Array<Record<string, unknown>>).filter(row => table !== "patients" || row.id !== source.patientId)
        .map(row => table !== "patients" && row.patient_id === source.patientId ? { ...row, patient_id: target.patientId } : row);
      expect(afterMerge[table]).toHaveLength(expected.length);
      expect(afterMerge[table]).toEqual(expect.arrayContaining(expected));
    }
    const stable = await proof(source);
    await refusal(await source.read(), 403);
    await refusal(await source.post(firstCommand), 403);
    await refusal(await source.read(undefined, h.sessions.doctorA), 403);
    await refusal(await source.post(firstCommand, h.sessions.doctorA), 403);
    const currentOwner = await read(source, undefined, target.session);
    expect(currentOwner).toMatchObject({ patientId: target.patientId, revision: {
      revisionId: two.revision.revisionId, recordedPatientId: source.patientId, patientId: target.patientId } });
    expect(currentOwner.history.map(row => row.recordedPatientId)).toEqual([source.patientId, source.patientId]);
    // Stable actor id can replay only after a current, explicit target-patient
    // grant. The historical recordedPatientId alone must never grant access.
    await source.setPermissions({ canViewAllPatients: true });
    expect((await write(source, firstCommand, 200)).revision).toEqual({ ...one.revision, patientId: target.patientId });
    expect((await write(source, secondCommand, 200)).revision).toEqual({ ...two.revision, patientId: target.patientId });
    const backupAfter = await assertBackupContainsExactHistory(source);
    expect(backupAfter).toEqual(backupBefore.map(row => ({ ...row, patient_id: target.patientId })));
    await unchanged(source, stable); expect(await source.counts()).toEqual({ revisions: 2, audits: 2 });
    expect((await source.db.query("SELECT id FROM audit_log WHERE action='patient.merge' AND entity_id=$1", [String(target.patientId)])).rows).toHaveLength(1);
    const three = await write(source, source.command({ expectedRevisionId: two.revision.revisionId,
      reason: "Explicit correction under the current patient identity" }), 201, target.session);
    expect(three.revision).toMatchObject({ version: 3, patientId: target.patientId, recordedPatientId: target.patientId });
    expect((await source.history()).slice(0, 2)).toEqual(movedRows);
    expect((await source.audit()).slice(0, 2)).toEqual(before.audit);
    expect((await source.audit())[2]).toMatchObject({ entity_id: String(target.patientId),
      actor: `Synthetic clinician ${target.uuid}`, actor_role: "doctor",
      details: { revisionId: three.revision.revisionId, version: 3, supersedesRevisionId: two.revision.revisionId,
        recordedPatientId: target.patientId, actorUserId: target.userId, reason: three.revision.reason } });
    expect(await source.snapshot()).toEqual(afterMerge);
    expect(await source.counts()).toEqual({ revisions: 3, audits: 3 });
  });
});
