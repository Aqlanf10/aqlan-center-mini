import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "../lib/auth";
import type { DbClient } from "../lib/db";
import type { StrategyCommand } from "../lib/ortho-treatment-strategy";

const boundary = vi.hoisted(() => ({
  ensureSchema: vi.fn(), getPool: vi.fn(), findUserByUsername: vi.fn(), insertAuditRow: vi.fn(),
  requireSession: vi.fn(), canAccessPatient: vi.fn(),
}));
vi.mock("../lib/db", () => boundary);
vi.mock("../lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: boundary.canAccessPatient }));
import { appendOrthoTreatmentStrategy, getOrthoTreatmentStrategy } from "../lib/ortho-treatment-strategy-store";

// Transaction fixtures only: no DB engine, server, filesystem, network or app
// execution. These tests do not substitute for PostgreSQL concurrency evidence.
interface ProblemRow { id: number; patient_id: number; case_id: number | null; label: string; site: string | null; status: string | null }
interface ItemRow {
  id: number; patient_id: number; case_id: number | null; service_name: string; tooth_code: number | null;
  case_site: string | null; status: string | null; price?: number;
}
interface RevisionRow {
  id: number; patient_id: number; recorded_patient_id: number; ortho_case_id: number; clinical_case_id: number; version: number;
  supersedes_revision_id: number | null; schema_version: number; actor_user_id: number; created_by: string;
  created_at: Date; command_id: string; request_fingerprint: string; reason: string; recording_context: string; rows: unknown;
}
const session = (): SessionPayload => ({ userId: 41, username: "synthetic-doctor", role: "doctor", expiresAt: Date.now() + 60_000 });
const command = (): StrategyCommand => ({ schemaVersion: 1, commandId: "synthetic-command-0001", expectedRevisionId: null,
  reason: "Synthetic review", rows: [{ problemId: 4, objective: "Authored objective", strategy: "Authored strategy",
    planItemIds: [5], rationale: null }] });
const clone = <T,>(value: T): T => structuredClone(value);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const immutableBytes = (row: RevisionRow) => JSON.stringify({ ...row, patient_id: undefined });

class FixtureDatabase {
  events: string[] = [];
  queries: { sql: string; values: unknown[] }[] = [];
  revisions: RevisionRow[] = [];
  audits: unknown[] = [];
  problems: ProblemRow[] = [{ id: 4, patient_id: 1, case_id: 3, label: "Recorded problem", site: "Recorded site", status: "active" }];
  items: ItemRow[] = [{ id: 5, patient_id: 1, case_id: 3, service_name: "Recorded service", tooth_code: 16,
    case_site: "Recorded case site", status: "in_progress", price: 987654 }];
  patientExists = true;
  patients = new Set([1, 9]);
  ortho: { id: number; patient_id: number; status: string } | null = { id: 2, patient_id: 1, status: "active" };
  bridge: { id: number; patient_id: number; ortho_case_id: number } | null = { id: 3, patient_id: 1, ortho_case_id: 2 };
  liveSession: SessionPayload | null = session();
  liveUser = { id: 41, username: "synthetic-doctor", role: "doctor", displayName: "Recorded clinician", isActive: true };
  patientAllowed = true;
  allowedPatientIds = new Set([1, 9]);
  planVisible = true;
  planEditable = true;
  auditFails = false;
  commitUncertain = false;
  beforePatientLock?: (patientId: number) => void;
  afterProblemLock?: () => void;
  afterItemLock?: () => void | Promise<void>;
  afterAudit?: () => void;
  afterHistoryRead?: () => void;
  releases = 0;
  nextId = 100;
  private patientQueue = Promise.resolve();

  async patientLock(): Promise<() => void> {
    const previous = this.patientQueue;
    let release!: () => void;
    this.patientQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    return release;
  }

  /** A serialized fixture for the existing merge's ownership-only effect.
   * This does not execute mergeDuplicatePatient or establish its SQL safety. */
  async simulateCanonicalMerge(sourceId: number, targetId: number, pause?: { locked: () => void; resume: Promise<void> }): Promise<void> {
    this.events.push("SIMULATED merge awaiting patient locks");
    const unlock = await this.patientLock();
    try {
      this.events.push("SIMULATED merge patient locks");
      pause?.locked(); if (pause) await pause.resume;
      if (!this.patients.has(sourceId) || !this.patients.has(targetId)) throw new Error("Missing simulated merge owner");
      if (this.ortho?.patient_id === sourceId) this.ortho.patient_id = targetId;
      if (this.bridge?.patient_id === sourceId) this.bridge.patient_id = targetId;
      for (const problem of this.problems) if (problem.patient_id === sourceId) problem.patient_id = targetId;
      for (const item of this.items) if (item.patient_id === sourceId) item.patient_id = targetId;
      for (const revision of this.revisions) if (revision.patient_id === sourceId) revision.patient_id = targetId;
      this.patients.delete(sourceId);
      this.events.push("SIMULATED merge commit");
    } finally { unlock(); }
  }

  connect(): DbClient {
    let inserts: RevisionRow[] = [];
    let audits: unknown[] = [];
    let unlock: (() => void) | undefined;
    const close = () => { unlock?.(); unlock = undefined; };
    return {
      release: () => { this.releases += 1; close(); },
      query: async <T = unknown>(raw: string, values: unknown[] = []): Promise<{ rows: T[] }> => {
        const sql = raw.replace(/\s+/g, " ").trim();
        this.queries.push({ sql, values: clone(values) });
        this.events.push(sql);
        const result = (rows: unknown[] = []) => ({ rows: clone(rows) as T[] });
        if (sql === "BEGIN") return result();
        if (sql === "ROLLBACK") { inserts = []; audits = []; close(); return result(); }
        if (sql === "COMMIT") {
          this.revisions.push(...inserts); this.audits.push(...audits); inserts = []; audits = []; close();
          if (this.commitUncertain) { this.commitUncertain = false; throw new Error("Synthetic lost commit response"); }
          return result();
        }
        if (sql.startsWith("SELECT id FROM patients WHERE")) {
          // Conservative fixture serialization for both SHARE and write locks.
          // Real PostgreSQL reader/writer lock semantics remain a separate gate.
          this.beforePatientLock?.(values[0] as number);
          unlock = await this.patientLock();
          return result(this.patientExists && this.patients.has(values[0] as number) ? [{ id: values[0] }] : []);
        }
        if (sql.startsWith("SELECT id, patient_id, status FROM ortho_cases")) {
          return result(this.ortho && this.ortho.id === values[0] && this.ortho.patient_id === values[1] ? [this.ortho] : []);
        }
        if (sql.startsWith("SELECT id, patient_id, ortho_case_id FROM clinical_cases")) {
          return result(this.bridge && this.bridge.ortho_case_id === values[0] ? [this.bridge] : []);
        }
        if (sql.includes("FROM ortho_strategy_revisions")) {
          if (sql.includes("actor_user_id = $2")) return result(this.revisions.filter(row => row.ortho_case_id === values[0]
            && row.actor_user_id === values[1] && row.command_id === values[2]));
          if (sql.includes("AND id = $2")) return result(this.revisions.filter(row => row.ortho_case_id === values[0] && row.id === values[1]));
          if (sql.includes("LIMIT 1")) return result(this.revisions.filter(row => row.ortho_case_id === values[0]).sort((a, b) => b.version - a.version).slice(0, 1));
          const rows = this.revisions.filter(row => row.ortho_case_id === values[0]).sort((a, b) => b.version - a.version);
          this.afterHistoryRead?.();
          return result(rows);
        }
        if (sql.startsWith("SELECT p.id FROM patient_problems p")) {
          this.afterProblemLock?.();
          return result(this.problems.filter(row => row.patient_id === values[0] && (values[1] as number[]).includes(row.id)).map(row => ({ id: row.id })));
        }
        if (sql.startsWith("SELECT i.id FROM plan_items i") && sql.includes("FOR UPDATE OF i")) {
          await this.afterItemLock?.();
          return result(this.items.filter(row => row.patient_id === values[0] && (values[1] as number[]).includes(row.id)).map(row => ({ id: row.id })));
        }
        if (sql.startsWith("SELECT p.id, p.patient_id")) return result(this.problems.filter(row => row.patient_id === values[0]
          && (row.case_id === values[1] || (values[2] as number[]).includes(row.id))));
        if (sql.startsWith("SELECT id FROM patient_problems WHERE")) return result(this.problems.filter(row =>
          (values[0] as number[]).includes(row.id) && row.patient_id !== values[1]).map(row => ({ id: row.id })));
        if (sql.startsWith("SELECT i.id, t.patient_id")) return result(this.items.filter(row => row.patient_id === values[0]
          && (row.case_id === values[1] || (values[2] as number[]).includes(row.id))));
        if (sql.startsWith("SELECT i.id FROM plan_items i") && sql.includes("t.patient_id <> $2")) {
          return result(this.items.filter(row => (values[0] as number[]).includes(row.id) && row.patient_id !== values[1]).map(row => ({ id: row.id })));
        }
        if (sql.startsWith("SELECT nextval")) return result([{ id: this.nextId++, created_at: new Date("2026-10-10T06:00:00.000Z") }]);
        if (sql.startsWith("INSERT INTO ortho_strategy_revisions")) {
          const [id, patient_id, recorded_patient_id, ortho_case_id, clinical_case_id, version, supersedes_revision_id, schema_version,
            actor_user_id, created_by, created_at, command_id, request_fingerprint, reason, recording_context, rows] = values;
          inserts.push({ id, patient_id, recorded_patient_id, ortho_case_id, clinical_case_id, version, supersedes_revision_id, schema_version,
            actor_user_id, created_by, created_at: new Date(created_at as string), command_id, request_fingerprint,
            reason, recording_context, rows: JSON.parse(rows as string) } as RevisionRow);
          return result();
        }
        if (sql === "INSERT INTO audit_log fixture") {
          if (this.auditFails) throw new Error("Synthetic audit failure");
          audits.push(values[0]); this.afterAudit?.(); return result();
        }
        throw new Error(`Unrecognized fixture query: ${sql}`);
      },
    };
  }
}

let db: FixtureDatabase;
const input = (patientId = 1) => ({ session: clone(db.liveSession ?? session()), patientId, orthoCaseId: 2 });
const save = (draft: unknown = command(), patientId = 1) => appendOrthoTreatmentStrategy({ ...input(patientId), command: draft });
const read = (revisionId?: number, patientId = 1) => getOrthoTreatmentStrategy({ ...input(patientId), ...(revisionId === undefined ? {} : { revisionId }) });
function expectNoAppend() { expect(db.revisions).toHaveLength(0); expect(db.audits).toHaveLength(0); }
function expectOnlyAppendMutations() {
  const mutations = db.queries.filter(({ sql }) => /^(INSERT|UPDATE|DELETE)/.test(sql));
  expect(mutations.every(({ sql }) => sql.startsWith("INSERT INTO ortho_strategy_revisions") || sql === "INSERT INTO audit_log fixture")).toBe(true);
}

beforeEach(() => {
  vi.resetAllMocks(); db = new FixtureDatabase();
  boundary.ensureSchema.mockResolvedValue(undefined);
  boundary.getPool.mockReturnValue({ connect: async () => db.connect() });
  boundary.requireSession.mockImplementation(async (client: DbClient) => {
    expect(client).toBeDefined(); db.events.push("AUTH session"); return clone(db.liveSession);
  });
  boundary.findUserByUsername.mockImplementation(async (_username: string, client: DbClient) => {
    expect(client).toBeDefined(); db.events.push("AUTH user"); return clone(db.liveUser);
  });
  boundary.canAccessPatient.mockImplementation(async (_session: SessionPayload, patientId: number, permission: string | undefined, client: DbClient) => {
    expect(client).toBeDefined(); db.events.push(`AUTH ${permission ?? "patient"}`);
    if (!db.patientAllowed || !db.allowedPatientIds.has(patientId)) return false;
    return permission === "canViewPlans" ? db.planVisible : permission === "canEditPlans" ? db.planEditable : true;
  });
  boundary.insertAuditRow.mockImplementation(async (client: DbClient, audit: unknown) => client.query("INSERT INTO audit_log fixture", [audit]));
});

describe("orthodontic strategy append transaction", () => {
  it("appends one decoded clinical snapshot and audit, using server actor identity and ordered locks", async () => {
    const result = await save();
    expect(result).toMatchObject({ ok: true, replayed: false, revision: { revisionId: 100, version: 1, recordingContext: "current",
      createdBy: "Recorded clinician", rows: [{ problem: { label: "Recorded problem" }, planLinks: { state: "allowed" } }] } });
    expect(db.revisions).toHaveLength(1); expect(db.audits).toHaveLength(1);
    expect(db.revisions[0]).toMatchObject({ actor_user_id: 41, command_id: command().commandId, version: 1,
      patient_id: 1, recorded_patient_id: 1 });
    expect(db.revisions[0].request_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const index = (part: string) => db.events.findIndex(event => event.includes(part));
    expect(index("FROM patients")).toBeLessThan(index("AUTH patient"));
    expect(index("AUTH canEditPlans")).toBeLessThan(index("FROM ortho_cases"));
    expect(index("FROM ortho_cases")).toBeLessThan(index("FROM clinical_cases"));
    expect(index("FROM clinical_cases")).toBeLessThan(index("FOR UPDATE OF p"));
    expect(index("FOR UPDATE OF p")).toBeLessThan(index("FOR UPDATE OF i"));
    expect(db.events.slice(index("FOR UPDATE OF i") + 1).some(event => event.startsWith("AUTH"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("987654"); expect(JSON.stringify(db.audits)).not.toContain("Authored strategy");
    expectOnlyAppendMutations(); expect(db.releases).toBe(1);
  });

  it("allows unlinked clinical text without plan permissions", async () => {
    db.planVisible = false; db.planEditable = false;
    const draft = command(); draft.rows[0].planItemIds = [];
    expect(await save(draft)).toMatchObject({ ok: true, revision: { rows: [{ planLinks: { state: "restricted" } }] } });
    expect(db.revisions).toHaveLength(1);
    expect(db.queries.some(({ sql }) => sql.includes("FROM plan_items"))).toBe(false);
  });

  it.each(["reception", "assistant", "cashier", "accountant"])("denies clinical writes from %s", async role => {
    db.liveSession!.role = role; db.liveUser.role = role;
    expect(await save()).toMatchObject({ ok: false, status: 403, code: "clinical_edit_denied" });
    expectNoAppend(); expect(db.queries.some(({ sql }) => sql.includes("FROM ortho_strategy_revisions"))).toBe(false);
  });

  it.each(["inactive", "changed_identity", "role_changed", "missing_session", "expired_session"])("denies %s before history/replay", async cause => {
    const request = { ...input(), command: command() };
    if (cause === "inactive") db.liveUser.isActive = false;
    if (cause === "changed_identity") db.liveUser.id = 99;
    if (cause === "role_changed") db.liveUser.role = "reception";
    if (cause === "missing_session") db.liveSession = null;
    if (cause === "expired_session") db.liveSession!.expiresAt = Date.now() - 1;
    expect(await appendOrthoTreatmentStrategy(request)).toMatchObject({ ok: false, status: 401, code: "session_expired" });
    expectNoAppend(); expect(db.queries.some(({ sql }) => sql.includes("FROM ortho_strategy_revisions"))).toBe(false);
  });

  it("denies current patient scope even for an already accepted command", async () => {
    expect((await save()).ok).toBe(true); db.queries = []; db.patientAllowed = false;
    expect(await save()).toMatchObject({ ok: false, status: 403, code: "patient_access_denied" });
    expect(db.revisions).toHaveLength(1); expect(db.audits).toHaveLength(1);
    expect(db.queries.some(({ sql }) => sql.includes("FROM ortho_strategy_revisions"))).toBe(false);
  });

  it.each(["view", "edit"])("requires current plan %s permission when removing prior links", async permission => {
    const first = await save(); if (!first.ok) throw new Error(first.code);
    const draft = command(); draft.commandId = "synthetic-command-0002"; draft.expectedRevisionId = first.revision.revisionId;
    draft.rows[0].planItemIds = [];
    if (permission === "view") db.planVisible = false; else db.planEditable = false;
    expect(await save(draft)).toMatchObject({ ok: false, status: 403, code: "plan_links_unavailable" });
    expect(db.revisions).toHaveLength(1); expect(db.audits).toHaveLength(1);
  });

  it("serializes two same-head fixture transactions; only one appends", async () => {
    const first = command(); const second = command(); second.commandId = "synthetic-command-0002";
    const results = await Promise.all([save(first), save(second)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.find(result => !result.ok)).toMatchObject({ ok: false, status: 409, code: "stale_revision" });
    expect(db.revisions).toHaveLength(1); expect(db.audits).toHaveLength(1);
  });

  it("rolls the revision back when audit fails", async () => {
    db.auditFails = true;
    await expect(save()).rejects.toThrow("Synthetic audit failure");
    expectNoAppend(); expect(db.events).toContain("ROLLBACK"); expect(db.events).not.toContain("COMMIT");
  });

  it("rolls back if the session expires during audit, without reacquiring plan locks", async () => {
    const now = vi.spyOn(Date, "now"); const start = Date.now();
    now.mockReturnValue(start); db.afterAudit = () => now.mockReturnValue(start + 120_000);
    try {
      expect(await save()).toMatchObject({ ok: false, status: 401, code: "session_expired" });
      expectNoAppend(); expect(boundary.canAccessPatient).toHaveBeenCalledTimes(3);
    } finally { now.mockRestore(); }
  });

  it.each(["completed", "discontinued"])("appends retrospective documentation to %s without changing lifecycle", async status => {
    db.ortho!.status = status;
    expect(await save()).toMatchObject({ ok: true, revision: { recordingContext: "retrospective" } });
    expect(db.revisions[0].recording_context).toBe("retrospective"); expect(db.ortho!.status).toBe(status);
    expectOnlyAppendMutations();
  });

  it.each(["active", "retention"])("records current documentation for %s", async status => {
    db.ortho!.status = status;
    expect(await save()).toMatchObject({ ok: true, revision: { recordingContext: "current" } });
  });

  it("rejects client-supplied provenance/context/author fields before creating a record", async () => {
    expect(await save({ ...command(), recordedPatientId: 9, recordingContext: "retrospective", createdBy: "forged" })).toMatchObject({ ok: false, status: 400 });
    expectNoAppend();
  });
});

describe("idempotent strategy commands", () => {
  it("replays normalized text under stable user ID without resnapshotting historical labels or context", async () => {
    const first = await save(); if (!first.ok) throw new Error(first.code);
    const historical = clone(db.revisions[0]);
    db.problems[0].label = "Changed current problem"; db.items[0].service_name = "Changed current service";
    db.liveUser.displayName = "Changed clinician name"; db.ortho!.status = "completed";
    const retry = command(); retry.reason = `  ${retry.reason}  `; retry.rows[0].strategy = ` ${retry.rows[0].strategy} `;
    expect(await save(retry)).toEqual({ ...first, replayed: true });
    expect(db.revisions).toEqual([historical]); expect(db.audits).toHaveLength(1);
  });

  it("conflicts on changed content under the same command ID", async () => {
    expect((await save()).ok).toBe(true);
    const retry = command(); retry.rows[0].strategy = "Different content";
    expect(await save(retry)).toMatchObject({ ok: false, status: 409, code: "command_conflict" });
    expect(db.revisions).toHaveLength(1); expect(db.audits).toHaveLength(1);
  });

  it("keeps the idempotency namespace when the same active user has a newly valid role", async () => {
    expect((await save()).ok).toBe(true);
    db.liveSession!.role = "admin"; db.liveUser.role = "admin";
    expect(await save()).toMatchObject({ ok: true, replayed: true, revision: { revisionId: 100 } });
    expect(db.revisions).toHaveLength(1);
  });

  it("does not replay for a different stable actor using the same key", async () => {
    expect((await save()).ok).toBe(true);
    db.liveSession!.userId = 42; db.liveUser.id = 42;
    expect(await save()).toMatchObject({ ok: false, status: 409, code: "stale_revision" });
    expect(db.revisions).toHaveLength(1);
  });

  it("reauthorizes the original linked predecessor when replaying an accepted link removal", async () => {
    const first = await save(); if (!first.ok) throw new Error(first.code);
    const removal = command(); removal.commandId = "synthetic-command-0002"; removal.expectedRevisionId = first.revision.revisionId;
    removal.rows[0].planItemIds = [];
    expect((await save(removal)).ok).toBe(true); db.planVisible = false;
    expect(await save(removal)).toMatchObject({ ok: false, status: 403, code: "plan_links_unavailable" });
    expect(db.revisions).toHaveLength(2); expect(db.audits).toHaveLength(2);
  });

  it("reports an ambiguous commit and reconciles by the original command without duplicating", async () => {
    db.commitUncertain = true;
    expect(await save()).toMatchObject({ ok: false, status: 503, code: "write_unconfirmed" });
    expect(db.revisions).toHaveLength(1);
    expect(await save()).toMatchObject({ ok: true, replayed: true, revision: { revisionId: 100 } });
    expect(db.revisions).toHaveLength(1); expect(db.audits).toHaveLength(1);
  });
});

describe("reference scope and fresh membership", () => {
  it.each(["foreign_ortho", "foreign_bridge", "missing_bridge", "missing_patient"])("refuses %s without scaffolding", async cause => {
    if (cause === "foreign_ortho") db.ortho!.patient_id = 9;
    if (cause === "foreign_bridge") db.bridge!.patient_id = 9;
    if (cause === "missing_bridge") db.bridge = null;
    if (cause === "missing_patient") db.patientExists = false;
    expect((await save()).ok).toBe(false); expectNoAppend(); expectOnlyAppendMutations();
  });

  it.each(["foreign_patient", "other_case", "unlinked", "missing"])("rejects a %s problem", async cause => {
    if (cause === "foreign_patient") db.problems[0].patient_id = 9;
    if (cause === "other_case") db.problems[0].case_id = 8;
    if (cause === "unlinked") db.problems[0].case_id = null;
    if (cause === "missing") db.problems = [];
    expect(await save()).toMatchObject({ ok: false, status: 409, code: "problem_scope_mismatch" }); expectNoAppend();
  });

  it.each(["foreign_patient", "other_case", "funding_only", "missing"])("rejects a %s item rather than dropping it", async cause => {
    if (cause === "foreign_patient") db.items[0].patient_id = 9;
    if (cause === "other_case") db.items[0].case_id = 8;
    if (cause === "funding_only") db.items[0].case_id = null;
    if (cause === "missing") db.items = [];
    expect(await save()).toMatchObject({ ok: false, status: 409, code: "item_scope_mismatch" }); expectNoAppend();
  });

  it("locks unique referenced IDs in sorted order while preserving authored row/link order", async () => {
    db.problems.push({ ...db.problems[0], id: 7 }); db.items.push({ ...db.items[0], id: 6 });
    const draft = command(); draft.rows = [{ ...draft.rows[0], problemId: 7, planItemIds: [6, 5] }, draft.rows[0]];
    const result = await save(draft); expect(result.ok).toBe(true);
    expect(db.queries.find(({ sql }) => sql.includes("FOR UPDATE OF p"))?.values).toEqual([1, [4, 7]]);
    expect(db.queries.find(({ sql }) => sql.includes("FOR UPDATE OF i"))?.values).toEqual([1, [5, 6]]);
    if (result.ok) expect(result.revision.rows.map(row => row.problem.id)).toEqual([7, 4]);
  });

  it.each(["move_problem", "move_item", "delete_item"])("rechecks %s after the simulated lock wait", async change => {
    if (change === "move_problem") db.afterProblemLock = () => { db.problems[0].case_id = 9; };
    if (change === "move_item") db.afterItemLock = () => { db.items[0].case_id = 9; };
    if (change === "delete_item") db.afterItemLock = () => { db.items = []; };
    expect((await save()).ok).toBe(false); expectNoAppend();
  });

  it("strictly decodes newly assembled snapshots before inserting invalid source labels", async () => {
    db.items[0].service_name = " ";
    expect(await save()).toMatchObject({ ok: false, status: 500, code: "invalid_stored_revision" });
    expectNoAppend(); expect(db.queries.some(({ sql }) => sql.startsWith("INSERT"))).toBe(false);
  });

  it("rejects an aggregate snapshot over one MiB without truncating valid individual text", async () => {
    db.problems[0].label = "س".repeat(2000); db.problems[0].site = "س".repeat(1000);
    const item = db.items[0];
    db.items = Array.from({ length: 8 }, (_, index) => ({ ...item, id: 5 + index,
      service_name: "س".repeat(2000), case_site: "س".repeat(1000) }));
    const draft = command();
    draft.rows = Array.from({ length: 30 }, () => ({ problemId: 4, objective: "س".repeat(1000),
      strategy: "س".repeat(2000), rationale: "س".repeat(1000), planItemIds: db.items.map(value => value.id) }));
    expect(await save(draft)).toMatchObject({ ok: false, status: 413, code: "revision_too_large" });
    expectNoAppend(); expect(db.queries.some(({ sql }) => sql.startsWith("INSERT"))).toBe(false);
  });
});

describe("exact strategy history and authorized projection", () => {
  it("distinguishes no saved revision from missing bridge and never creates one on read", async () => {
    expect(await read()).toMatchObject({ ok: true, state: "ready", revision: null, history: [], clinicalCaseId: 3 });
    db.bridge = null;
    expect(await read()).toMatchObject({ ok: true, state: "bridge_missing", revision: null, history: [], clinicalCaseId: null,
      choices: { problems: [], planItems: [] } });
    expect(db.queries.some(({ sql }) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
  });

  it("does not hide existing history behind bridge_missing when its bridge disappears", async () => {
    expect((await save()).ok).toBe(true); db.bridge = null;
    expect(await read()).toMatchObject({ ok: false, status: 409, code: "revision_scope_mismatch" });
    expect(await save()).toMatchObject({ ok: false, status: 409, code: "revision_scope_mismatch" });
    expect(db.revisions).toHaveLength(1); expect(db.audits).toHaveLength(1);
  });

  it("returns selected history exactly and never falls back for an unknown revision", async () => {
    const first = await save(); if (!first.ok) throw new Error(first.code);
    const second = command(); second.commandId = "synthetic-command-0002"; second.expectedRevisionId = first.revision.revisionId;
    second.rows[0].objective = "Second objective"; expect((await save(second)).ok).toBe(true);
    expect(await read(first.revision.revisionId)).toMatchObject({ ok: true, revision: first.revision,
      history: [{ revisionId: 101, version: 2, supersedesRevisionId: 100 }, { revisionId: 100, version: 1 }] });
    expect(await read(999)).toMatchObject({ ok: false, status: 404, code: "revision_not_found" });
  });

  it("redacts all historic plan IDs/names/tooth/site and current choices without plan view", async () => {
    expect((await save()).ok).toBe(true); db.planVisible = false; db.queries = [];
    const result = await read();
    expect(result).toMatchObject({ ok: true, planVisible: false, choices: { planItems: [] },
      revision: { rows: [{ objective: "Authored objective", planLinks: { state: "restricted" } }] } });
    expect(JSON.stringify(result)).not.toContain("Recorded service"); expect(JSON.stringify(result)).not.toContain("toothCode");
    expect(JSON.stringify(result)).not.toContain("Recorded case site");
    expect(db.queries.some(({ sql }) => sql.includes("FROM plan_items"))).toBe(false);
  });

  it.each(["missing", "moved", "unavailable"])("keeps historical item snapshot while current state is %s", async state => {
    expect((await save()).ok).toBe(true);
    if (state === "missing") db.items = [];
    if (state === "moved") db.items[0].case_id = 9;
    if (state === "unavailable") { db.items[0].patient_id = 9; db.items[0].service_name = "Foreign private service"; }
    const result = await read();
    expect(result).toMatchObject({ ok: true, choices: { planItems: [] }, revision: { rows: [{ planLinks: { state: "allowed",
      items: [{ id: 5, serviceName: "Recorded service", current: { state, status: null } }] } }] } });
    expect(JSON.stringify(result)).not.toContain("Foreign private service");
  });

  it("keeps current status unaltered rather than deriving completed/normal findings", async () => {
    db.problems[0].status = "inactive"; db.items[0].status = "cancelled";
    expect((await save()).ok).toBe(true);
    expect(await read()).toMatchObject({ ok: true, revision: { rows: [{ currentProblem: { state: "available", status: "inactive" },
      planLinks: { items: [{ current: { state: "available", status: "cancelled" } }] } }] } });
  });

  it.each(["extra_finance", "wrong_scope", "wrong_bridge", "bad_recorded_identity", "unsupported_schema", "wrong_context", "bad_date", "bad_metadata"])("fails closed on %s stored data", async corruption => {
    expect((await save()).ok).toBe(true);
    if (corruption === "extra_finance") (db.revisions[0].rows as Record<string, unknown>[])[0].price = 99;
    if (corruption === "wrong_scope") db.revisions[0].patient_id = 9;
    if (corruption === "wrong_bridge") db.revisions[0].clinical_case_id = 9;
    if (corruption === "bad_recorded_identity") db.revisions[0].recorded_patient_id = 0;
    if (corruption === "unsupported_schema") db.revisions[0].schema_version = 9;
    if (corruption === "wrong_context") db.revisions[0].recording_context = "normal";
    if (corruption === "bad_date") db.revisions[0].created_at = new Date(Number.NaN);
    if (corruption === "bad_metadata") db.revisions[0].request_fingerprint = "invalid";
    // Replay selects by the stable key then decodes scope as well as content.
    expect(await save()).toMatchObject({ ok: false, status: 500, code: "invalid_stored_revision" });
    expect(await read()).toMatchObject({ ok: false, status: 500, code: "invalid_stored_revision" });
    expect(db.revisions).toHaveLength(1); expect(db.audits).toHaveLength(1);
  });

  it("does not allow a corrupt older revision to become an empty-success history", async () => {
    const first = await save(); if (!first.ok) throw new Error(first.code);
    const second = command(); second.commandId = "synthetic-command-0002"; second.expectedRevisionId = first.revision.revisionId;
    expect((await save(second)).ok).toBe(true); db.revisions[0].rows = [];
    expect(await read()).toMatchObject({ ok: false, status: 500, code: "invalid_stored_revision" });
  });

  it("refuses broken saved lineage instead of inventing a predecessor", async () => {
    const first = await save(); if (!first.ok) throw new Error(first.code);
    const second = command(); second.commandId = "synthetic-command-0002"; second.expectedRevisionId = first.revision.revisionId;
    expect((await save(second)).ok).toBe(true); db.revisions[1].supersedes_revision_id = 999;
    expect(await read()).toMatchObject({ ok: false, status: 500, code: "invalid_stored_revision" });
    expect(await save(second)).toMatchObject({ ok: false, status: 500, code: "invalid_stored_revision" });
  });

  it.each(["missing_ancestor", "skipped_ancestor", "cycle", "duplicate_version"])("validates complete %s lineage before new append or replay", async corruption => {
    let expected: number | null = null;
    for (let index = 1; index <= 3; index += 1) {
      const draft = command(); draft.commandId = `synthetic-command-000${index}`; draft.expectedRevisionId = expected;
      const result = await save(draft); if (!result.ok) throw new Error(result.code);
      expected = result.revision.revisionId;
    }
    if (corruption === "missing_ancestor") db.revisions[1].supersedes_revision_id = 999;
    if (corruption === "skipped_ancestor") db.revisions[2].supersedes_revision_id = db.revisions[0].id;
    if (corruption === "cycle") db.revisions[1].supersedes_revision_id = db.revisions[2].id;
    if (corruption === "duplicate_version") db.revisions[1].version = 3;
    db.queries = [];
    const next = command(); next.commandId = "synthetic-command-0004"; next.expectedRevisionId = expected;
    expect(await save(next)).toMatchObject({ ok: false, status: 500, code: "invalid_stored_revision" });
    expect(await save(command())).toMatchObject({ ok: false, status: 500, code: "invalid_stored_revision" });
    expect(await read()).toMatchObject({ ok: false, status: 500, code: "invalid_stored_revision" });
    expect(db.revisions).toHaveLength(3); expect(db.audits).toHaveLength(3);
    expect(db.queries.some(({ sql }) => sql.startsWith("INSERT") || sql.startsWith("SELECT nextval"))).toBe(false);
  });

  it.each(["assistant", "cashier", "accountant"])("does not expand CLINIC visibility for an internal %s reader", async role => {
    db.liveUser.role = role; db.liveSession!.role = role;
    expect(await read()).toMatchObject({ ok: false, status: 403, code: "clinical_read_denied" });
    expect(db.queries.some(({ sql }) => sql.includes("FROM ortho_strategy_revisions"))).toBe(false);
    expectNoAppend();
  });
});

describe("patient-merge-compatible strategy provenance (simulated sequencing)", () => {
  it("derives canRevise from both selected history and the current linked head", async () => {
    const unlinked = command(); unlinked.rows[0].planItemIds = [];
    const first = await save(unlinked); if (!first.ok) throw new Error(first.code);
    const linked = command(); linked.commandId = "synthetic-command-0002"; linked.expectedRevisionId = first.revision.revisionId;
    const second = await save(linked); if (!second.ok) throw new Error(second.code);
    db.planVisible = false; db.planEditable = false;
    expect(await read(first.revision.revisionId)).toMatchObject({ ok: true, canRevise: false,
      revision: { revisionId: first.revision.revisionId, rows: [{ planLinks: { state: "restricted" } }] } });
    expect(await read()).toMatchObject({ ok: true, canRevise: false });
    const replacement = { ...unlinked, commandId: "synthetic-command-0003", expectedRevisionId: second.revision.revisionId };
    expect(await save(replacement)).toMatchObject({ ok: false, status: 403, code: "plan_links_unavailable" });
  });
  it("allows unlinked current clinical correction without plan permissions but protects selected linked history", async () => {
    const first = await save(); if (!first.ok) throw new Error(first.code);
    const unlinked = command(); unlinked.commandId = "synthetic-command-0002"; unlinked.expectedRevisionId = first.revision.revisionId; unlinked.rows[0].planItemIds = [];
    expect((await save(unlinked)).ok).toBe(true);
    db.planVisible = false; db.planEditable = false;
    expect(await read()).toMatchObject({ ok: true, canRevise: true, planVisible: false, planLinksWritable: false });
    expect(await read(first.revision.revisionId)).toMatchObject({ ok: true, canRevise: false });
    db.liveUser.role = "reception"; db.liveSession!.role = "reception";
    expect(await read()).toMatchObject({ ok: true, canRevise: false, clinicalWritable: false });
  });
  it("reads and replays unchanged historical content for the authorized target, retaining recorded source identity", async () => {
    const first = await save(); if (!first.ok) throw new Error(first.code);
    const bytesBefore = immutableBytes(db.revisions[0]);
    await db.simulateCanonicalMerge(1, 9);
    expect(immutableBytes(db.revisions[0])).toBe(bytesBefore);
    expect(db.revisions[0]).toMatchObject({ patient_id: 9, recorded_patient_id: 1, ortho_case_id: 2, clinical_case_id: 3 });
    const projected = { ...first.revision, patientId: 9, recordedPatientId: 1 };
    expect(await read(first.revision.revisionId, 9)).toMatchObject({ ok: true, patientId: 9, revision: projected,
      history: [{ recordedPatientId: 1, revisionId: first.revision.revisionId }],
      choices: { problems: [{ patientId: 9, caseId: 3 }], planItems: [{ patientId: 9, caseId: 3 }] } });
    expect(await save(command(), 9)).toEqual({ ok: true, replayed: true, revision: projected });
    expect(immutableBytes(db.revisions[0])).toBe(bytesBefore);
    expect(db.revisions).toHaveLength(1); expect(db.audits).toHaveLength(1);
    expectOnlyAppendMutations();
  });

  it("fails source requests and never grants target access from the historical scalar", async () => {
    expect((await save()).ok).toBe(true); await db.simulateCanonicalMerge(1, 9);
    db.queries = [];
    expect(await read()).toMatchObject({ ok: false, status: 404, code: "patient_not_found" });
    expect(await save()).toMatchObject({ ok: false, status: 404, code: "patient_not_found" });
    db.allowedPatientIds = new Set([1]);
    expect(await read(undefined, 9)).toMatchObject({ ok: false, status: 403, code: "patient_access_denied" });
    expect(await save(command(), 9)).toMatchObject({ ok: false, status: 403, code: "patient_access_denied" });
    expect(db.queries.some(({ sql }) => sql.includes("FROM ortho_strategy_revisions"))).toBe(false);
    expect(db.revisions).toHaveLength(1); expect(db.audits).toHaveLength(1);
  });

  it("requires both live canonical case owners to agree after ownership changes", async () => {
    expect((await save()).ok).toBe(true); await db.simulateCanonicalMerge(1, 9);
    db.bridge!.patient_id = 1;
    expect(await read(undefined, 9)).toMatchObject({ ok: false, status: 409, code: "scope_mismatch" });
    expect(await save(command(), 9)).toMatchObject({ ok: false, status: 409, code: "scope_mismatch" });
    expect(db.revisions).toHaveLength(1);
  });

  it("does not conceal or repair a revision whose live owner disagrees with the merged cases", async () => {
    expect((await save()).ok).toBe(true); await db.simulateCanonicalMerge(1, 9);
    db.revisions[0].patient_id = 1;
    expect(await read(undefined, 9)).toMatchObject({ ok: false, status: 500, code: "invalid_stored_revision" });
    expect(await save(command(), 9)).toMatchObject({ ok: false, status: 500, code: "invalid_stored_revision" });
    expect(db.revisions[0].patient_id).toBe(1); expect(db.revisions).toHaveLength(1);
  });

  it("records the target for a new correction on the same lineage while old immutable bytes stay unchanged", async () => {
    const first = await save(); if (!first.ok) throw new Error(first.code);
    const bytesBefore = immutableBytes(db.revisions[0]); await db.simulateCanonicalMerge(1, 9);
    const correction = command(); correction.commandId = "synthetic-command-0002"; correction.expectedRevisionId = first.revision.revisionId;
    correction.reason = "Correction following canonical patient merge"; correction.rows[0].objective = "Explicit correction";
    expect(await save(correction, 9)).toMatchObject({ ok: true, replayed: false, revision: { patientId: 9, recordedPatientId: 9,
      revisionId: 101, version: 2, supersedesRevisionId: first.revision.revisionId } });
    expect(immutableBytes(db.revisions[0])).toBe(bytesBefore);
    expect(db.revisions[1]).toMatchObject({ patient_id: 9, recorded_patient_id: 9, ortho_case_id: 2, clinical_case_id: 3 });
    expect(await read(undefined, 9)).toMatchObject({ ok: true, history: [
      { version: 2, recordedPatientId: 9 }, { version: 1, recordedPatientId: 1 },
    ] });
    expectOnlyAppendMutations();
  });

  it.each(["view", "edit"])("preserves current plan %s authorization on post-merge replay and link removal", async permission => {
    const first = await save(); if (!first.ok) throw new Error(first.code);
    await db.simulateCanonicalMerge(1, 9);
    if (permission === "view") db.planVisible = false; else db.planEditable = false;
    expect(await save(command(), 9)).toMatchObject({ ok: false, status: 403, code: "plan_links_unavailable" });
    const removal = command(); removal.commandId = "synthetic-command-0002"; removal.expectedRevisionId = first.revision.revisionId;
    removal.rows[0].planItemIds = [];
    expect(await save(removal, 9)).toMatchObject({ ok: false, status: 403, code: "plan_links_unavailable" });
    if (permission === "view") expect(await read(undefined, 9)).toMatchObject({ ok: true, choices: { planItems: [] },
      revision: { recordedPatientId: 1, rows: [{ planLinks: { state: "restricted" } }] } });
    expect(db.revisions).toHaveLength(1); expect(db.audits).toHaveLength(1);
  });

  it("rechecks original linked predecessor permissions for an accepted removal replayed after merge", async () => {
    const first = await save(); if (!first.ok) throw new Error(first.code);
    const removal = command(); removal.commandId = "synthetic-command-0002"; removal.expectedRevisionId = first.revision.revisionId;
    removal.rows[0].planItemIds = []; expect((await save(removal)).ok).toBe(true);
    const bytesBefore = db.revisions.map(immutableBytes); await db.simulateCanonicalMerge(1, 9); db.planEditable = false;
    expect(await save(removal, 9)).toMatchObject({ ok: false, status: 403, code: "plan_links_unavailable" });
    expect(db.revisions.map(immutableBytes)).toEqual(bytesBefore); expect(db.audits).toHaveLength(2);
  });

  it("uses current target membership rather than recorded source identity to resolve historical links", async () => {
    const first = await save(); if (!first.ok) throw new Error(first.code);
    await db.simulateCanonicalMerge(1, 9);
    db.items[0].patient_id = 8; db.items[0].service_name = "Other patient's current private service";
    const result = await read(undefined, 9);
    expect(result).toMatchObject({ ok: true, choices: { planItems: [] }, revision: { recordedPatientId: 1, rows: [{
      planLinks: { items: [{ serviceName: "Recorded service", current: { state: "unavailable", status: null } }] },
    }] } });
    expect(JSON.stringify(result)).not.toContain("Other patient's current private service");
    const next = command(); next.commandId = "synthetic-command-0002"; next.expectedRevisionId = first.revision.revisionId;
    expect(await save(next, 9)).toMatchObject({ ok: false, status: 409, code: "item_scope_mismatch" });
    expect(db.revisions).toHaveLength(1); expect(db.audits).toHaveLength(1);
  });

  it("simulates merge-first sequencing: a waiting source save cannot append after ownership retires", async () => {
    expect((await save()).ok).toBe(true);
    const locked = deferred(); const resume = deferred(); const sourceWaiting = deferred();
    const merging = db.simulateCanonicalMerge(1, 9, { locked: locked.resolve, resume: resume.promise });
    await locked.promise;
    db.beforePatientLock = patientId => { if (patientId === 1) sourceWaiting.resolve(); };
    const waitingSource = save();
    await sourceWaiting.promise;
    resume.resolve(); await merging;
    expect(await waitingSource).toMatchObject({ ok: false, status: 404, code: "patient_not_found" });
    expect(await save(command(), 9)).toMatchObject({ ok: true, replayed: true,
      revision: { patientId: 9, recordedPatientId: 1 } });
    expect(db.revisions).toHaveLength(1); expect(db.audits).toHaveLength(1);
  });

  it("simulates append-first sequencing: merge waits, then changes only the completed row's live owner", async () => {
    const locked = deferred(); const resume = deferred();
    db.afterItemLock = async () => { locked.resolve(); await resume.promise; };
    const appending = save(); await locked.promise;
    const merging = db.simulateCanonicalMerge(1, 9);
    expect(db.events).toContain("SIMULATED merge awaiting patient locks");
    expect(db.ortho!.patient_id).toBe(1); expect(db.revisions).toHaveLength(0);
    resume.resolve();
    expect(await appending).toMatchObject({ ok: true, replayed: false,
      revision: { patientId: 1, recordedPatientId: 1, revisionId: 100 } });
    await merging;
    expect(db.revisions[0]).toMatchObject({ patient_id: 9, recorded_patient_id: 1, id: 100 });
    expect(await read(undefined, 9)).toMatchObject({ ok: true, revision: { patientId: 9, recordedPatientId: 1 } });
    expect(db.revisions).toHaveLength(1); expect(db.audits).toHaveLength(1);
  });
});
