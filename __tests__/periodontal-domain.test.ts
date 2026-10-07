import { describe, expect, it, vi } from "vitest";
import type { AuditInput, DbClient, DbPool, QueryResult } from "../lib/db";
import { createPeriodontalDomain, periodontalHistoryCount } from "../lib/periodontal-db";
import { emptyPeriodontalSites, type PeriodontalSite } from "../lib/periodontal";

/** Protocol double only: does NOT execute SQL or prove PostgreSQL constraints/locks. */
interface Stored {
  id: number; patient_id: number; tooth_code: number; prior_record_id: number | null;
  request_key: string; request_fingerprint: string; recorded_by: string; recorded_at: Date;
  sites: PeriodontalSite[];
}
function fixture() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const patients = new Set([1, 2]);
  let records: Stored[] = []; let audits: AuditInput[] = []; let nextId = 1;
  let saved: { records: Stored[]; audits: AuditInput[] } | null = null;
  let failAudit = false; let failRead = false; let failCommit = false; let duplicateRace = false;
  const principal: { username: string; role: string } = { username: "synthetic-doctor", role: "doctor" };
  const authorizePatient = vi.fn(async (_client: DbClient, _patientId: number): Promise<typeof principal | null> => principal);
  const release = vi.fn();
  const query = async <T>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> => {
    calls.push({ sql, values: structuredClone(values) });
    const output = (rows: unknown[]): QueryResult<T> => ({ rows: rows as T[] });
    if (sql === "BEGIN") { saved = structuredClone({ records, audits }); return output([]); }
    if (sql === "COMMIT") { if (failCommit) throw new Error("commit refused"); saved = null; return output([]); }
    if (sql === "ROLLBACK") { if (saved) { records = saved.records; audits = saved.audits; saved = null; } return output([]); }
    if (sql.startsWith("SELECT id FROM patients")) return output(patients.has(values[0] as number) ? [{ id: values[0] }] : []);
    if (sql.startsWith("SELECT COUNT(*)")) return output([{ count: records.filter((r) => r.patient_id === values[0]).length }]);
    if (sql.includes("WHERE recorded_by = $1 AND request_key = $2")) {
      return output(records.filter((r) => r.recorded_by === values[0] && r.request_key === values[1]));
    }
    if (sql.startsWith("SELECT id FROM periodontal_records")) {
      return output(records.filter((r) => r.patient_id === values[0] && r.tooth_code === values[1]).sort((a, b) => b.id - a.id).slice(0, 1));
    }
    if (sql.startsWith("INSERT INTO periodontal_records")) {
      if (duplicateRace) throw Object.assign(new Error("duplicate"), { code: "23505", constraint: "periodontal_records_one_request" });
      const [patientId, toothCode, prior, key, hash, actor] = values;
      const row: Stored = { id: nextId++, patient_id: patientId as number, tooth_code: toothCode as number,
        prior_record_id: prior as number | null, request_key: key as string, request_fingerprint: hash as string,
        recorded_by: actor as string, recorded_at: new Date("2026-10-06T00:00:00Z"), sites: [] };
      records.push(row); return output([{ id: row.id }]);
    }
    if (sql.startsWith("INSERT INTO periodontal_sites")) {
      const row = records.find((r) => r.id === values[0])!;
      row.sites.push({ surface: values[1] as PeriodontalSite["surface"], position: values[2] as PeriodontalSite["position"],
        depthMm: values[3] as string | null, bleeding: values[4] as boolean | null });
      return output([]);
    }
    if (sql.startsWith("SELECT r.id")) {
      if (failRead) return output([{ ...records[0], sites: [] }]);
      if (sql.includes("WHERE r.id = $1")) return output(structuredClone(records.filter((r) => r.id === values[0] && r.patient_id === values[1])));
      let rows = records.filter((r) => r.patient_id === values[0]);
      if (sql.includes("LIMIT 51")) rows = rows.filter((r) => r.tooth_code === values[1] && (values[2] === null || r.id < (values[2] as number))).sort((a, b) => b.id - a.id).slice(0, 51);
      else rows = rows.filter((r) => !rows.some((later) => later.tooth_code === r.tooth_code && later.id > r.id)).sort((a, b) => a.tooth_code - b.tooth_code);
      return output(structuredClone(rows));
    }
    throw new Error(`Unrecognized protocol SQL: ${sql}`);
  };
  const client: DbClient = { query, release };
  const connect = vi.fn(async () => client);
  const pool: DbPool = { query, connect };
  const insertAudit = vi.fn(async (executor: DbClient, audit: AuditInput) => {
    expect(executor).toBe(client);
    if (failAudit) throw new Error("audit refused");
    audits.push(structuredClone(audit));
  });
  return { domain: createPeriodontalDomain({ pool, authorizePatient, insertAudit }), calls, patients, principal,
    authorizePatient, release, connect, client, insertAudit,
    records: () => records, audits: () => audits,
    failAudit: () => { failAudit = true; }, failRead: () => { failRead = true; },
    failCommit: () => { failCommit = true; }, duplicateRace: () => { duplicateRace = true; } };
}
const command = (key = "perio:request-001", expectedHeadId: number | null = null, toothCode = 16) => {
  const sites = emptyPeriodontalSites(); sites[0].depthMm = "3.50"; sites[1].bleeding = false;
  return { toothCode, expectedHeadId, requestKey: key, sites };
};

function pausedFixture(stage: "connect" | "authorization") {
  const f = fixture(); let open!: () => void; let entered!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  if (stage === "connect") f.connect.mockImplementationOnce(async () => { entered(); await wait; return f.client; });
  else f.authorizePatient.mockImplementationOnce(async () => { entered(); await wait; return f.principal; });
  return { ...f, waiting, open };
}

describe("unregistered periodontal domain protocol, with no SQL execution", () => {
  it("writes one detached six-site revision and audit inside the existing transaction helper", async () => {
    const f = fixture(); const result = await f.domain.save(1, command());
    expect(result).toMatchObject({ ok: true, replayed: false, record: { id: 1, patientId: 1, toothCode: 16, priorRecordId: null, recordedBy: "synthetic-doctor" } });
    expect(f.records()).toHaveLength(1); expect(f.records()[0].sites).toHaveLength(6);
    expect(f.records()[0].sites[0].depthMm).toBe("3.5");
    expect(f.records()[0].sites[1].bleeding).toBe(false); expect(f.records()[0].sites[2].bleeding).toBeNull();
    expect(f.audits()).toEqual([expect.objectContaining({ action: "perio.record", actorRole: "doctor", entityId: 1,
      details: { recordId: 1, toothCode: 16, priorRecordId: null, depthSites: 1, bleedingSitesRecorded: 1 } })]);
    expect(f.calls[0].sql).toBe("BEGIN"); expect(f.calls[1].sql).toContain("patients WHERE id = $1 FOR UPDATE");
    expect(f.calls.at(-1)?.sql).toBe("COMMIT"); expect(f.release).toHaveBeenCalledOnce();
    expect(f.authorizePatient).toHaveBeenCalledExactlyOnceWith(f.client, 1);
  });
  it.each(["reception", "assistant", "cashier", "accountant", "portal", "other"])("refuses %s before validation details, missing-patient disclosure or mutation", async (role) => {
    const f = fixture(); f.principal.role = role;
    expect(await f.domain.save(3, null)).toMatchObject({ ok: false, reason: "denied" });
    expect(f.authorizePatient).toHaveBeenCalledExactlyOnceWith(f.client, 3);
    expect(f.records()).toEqual([]); expect(f.audits()).toEqual([]);
    expect(f.calls.map((call) => call.sql)).toEqual(["BEGIN", "SELECT id FROM patients WHERE id = $1 FOR UPDATE", "COMMIT"]);
  });
  it("rechecks current access before reads, writes and old replay keys", async () => {
    const f = fixture(); await f.domain.save(1, command()); f.authorizePatient.mockResolvedValue(null);
    expect(await f.domain.save(1, command())).toMatchObject({ reason: "denied" });
    expect(await f.domain.read(1)).toMatchObject({ reason: "denied" });
    expect(f.authorizePatient).toHaveBeenCalledTimes(3); expect(f.records()).toHaveLength(1);
  });
  it("authorizes on the active client after locking but before any replay or observation query", async () => {
    const f = fixture();
    f.authorizePatient.mockImplementation(async (client, patientId) => {
      expect(client).toBe(f.client); expect(patientId).toBe(1);
      expect(f.calls.at(-1)?.sql).toMatch(/FROM patients .*FOR (UPDATE|KEY SHARE)$/);
      return f.principal;
    });
    await f.domain.save(1, command()); await f.domain.save(1, command()); await f.domain.read(1);
    expect(f.authorizePatient).toHaveBeenCalledTimes(3); expect(f.audits()).toHaveLength(1);
  });
  it("fails closed on authorization error with no observation or audit", async () => {
    const f = fixture(); f.authorizePatient.mockRejectedValue(new Error("authorization lock failed"));
    await expect(f.domain.save(1, command())).rejects.toThrow("authorization lock failed");
    expect(f.records()).toEqual([]); expect(f.audits()).toEqual([]);
    expect(f.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
  it("allows an admin without pretending that the author is a treating doctor", async () => {
    const f = fixture(); f.principal.role = "admin"; f.principal.username = "synthetic-admin";
    expect(await f.domain.save(1, command())).toMatchObject({ ok: true, record: { recordedBy: "synthetic-admin" } });
    expect(f.audits()[0].actorRole).toBe("admin");
  });
  it("refuses invalid identities before connecting and validates payload only after locked admission", async () => {
    const f = fixture();
    expect(await f.domain.save(0, command())).toMatchObject({ reason: "invalid" });
    expect(await f.domain.save(1, { ...command(), visitId: 4 })).toMatchObject({ reason: "invalid" });
    expect(await f.domain.read(1, { toothCode: 99, beforeId: null })).toMatchObject({ reason: "invalid" });
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.authorizePatient).toHaveBeenCalledTimes(2);
    expect(f.records()).toEqual([]); expect(f.audits()).toEqual([]);
  });
  it("keeps a missing patient distinct from a successfully empty chart", async () => {
    const f = fixture();
    expect(await f.domain.read(1)).toEqual({ ok: true, records: [], nextBeforeId: null });
    expect(await f.domain.read(3)).toMatchObject({ reason: "not_found" });
    expect(await f.domain.save(3, command())).toMatchObject({ reason: "not_found" });
    expect(f.records()).toHaveLength(0);
  });
  it("replays exactly once, including after a newer head and canonical spelling/order", async () => {
    const f = fixture(); const first = command(); await f.domain.save(1, first);
    await f.domain.save(1, command("perio:request-002", 1));
    const replay = command(); replay.sites[0].depthMm = "3.5"; replay.sites.reverse();
    expect(await f.domain.save(1, replay)).toMatchObject({ ok: true, replayed: true, record: { id: 1 } });
    expect(f.records()).toHaveLength(2); expect(f.audits()).toHaveLength(2);
  });
  it("does not deduplicate a new observation merely because its measurements match", async () => {
    const f = fixture(); await f.domain.save(1, command());
    expect(await f.domain.save(1, command("perio:new-examination", 1))).toMatchObject({ ok: true, replayed: false, record: { id: 2, priorRecordId: 1 } });
  });
  it("refuses changed content, patient, tooth or prior head under the same request key", async () => {
    const f = fixture(); await f.domain.save(1, command());
    const changed = command(); changed.sites[0].depthMm = "4";
    for (const [patient, body] of [[1, changed], [2, command()], [1, command(undefined, null, 17)], [1, command(undefined, 1)]] as const) {
      expect(await f.domain.save(patient, body)).toMatchObject({ reason: "request_conflict" });
    }
    expect(f.records()).toHaveLength(1); expect(f.audits()).toHaveLength(1);
  });
  it("refuses stale first and later expected heads without overwriting existing measurements", async () => {
    const f = fixture(); await f.domain.save(1, command()); const before = structuredClone(f.records());
    for (const head of [null, 2]) expect(await f.domain.save(1, command("perio:stale-request", head))).toMatchObject({ reason: "head_conflict" });
    expect(f.records()).toEqual(before); expect(f.audits()).toHaveLength(1);
  });
  it.each(["failAudit", "failRead", "failCommit"] as const)("rolls back protocol state and releases on %s", async (fail) => {
    const f = fixture(); f[fail]();
    await expect(f.domain.save(1, command())).rejects.toThrow();
    expect(f.records()).toEqual([]); expect(f.audits()).toEqual([]);
    expect(f.calls.at(-1)?.sql).toBe("ROLLBACK"); expect(f.release).toHaveBeenCalledOnce();
  });
  it("maps only the named cross-patient replay uniqueness failure to a conflict", async () => {
    const f = fixture(); f.duplicateRace();
    expect(await f.domain.save(1, command())).toMatchObject({ reason: "request_conflict" });
    expect(f.calls.at(-1)?.sql).toBe("ROLLBACK"); expect(f.records()).toEqual([]);
  });
  it("reads latest per tooth without filling missing sites from older snapshots", async () => {
    const f = fixture(); await f.domain.save(1, command());
    const next = command("perio:next-0002", 1); next.sites[0].depthMm = null; next.sites[5].depthMm = "6";
    await f.domain.save(1, next); await f.domain.save(1, command("perio:other-tooth", null, 17));
    const result = await f.domain.read(1); expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.records.map((r) => r.id)).toEqual([2, 3]);
    expect(result.records[0].sites[0].depthMm).toBeNull(); expect(result.records[0].sites[5].depthMm).toBe("6");
    expect((await f.domain.read(2))).toEqual({ ok: true, records: [], nextBeforeId: null });
  });
  it("bounds history with a patient/tooth-scoped stable cursor", async () => {
    const f = fixture();
    for (let i = 0; i < 52; i++) await f.domain.save(1, command(`perio:history-${i}`, i || null));
    const first = await f.domain.read(1, { toothCode: 16, beforeId: null });
    expect(first.ok).toBe(true); if (!first.ok) throw new Error(first.message);
    expect(first.records).toHaveLength(50); expect(first.nextBeforeId).toBe(3);
    const next = await f.domain.read(1, { toothCode: 16, beforeId: first.nextBeforeId });
    expect(next).toMatchObject({ ok: true, nextBeforeId: null });
    if (next.ok) expect(next.records.map((r) => r.id)).toEqual([2, 1]);
  });
  it("refuses corrupt saved data rather than producing an empty or normal chart", async () => {
    const f = fixture(); await f.domain.save(1, command()); f.failRead();
    await expect(f.domain.read(1)).rejects.toThrow("تعذّر التحقق");
  });
  it("preserves both histories after a simulated canonical patient-only merge and refuses retargeted replay", async () => {
    const f = fixture(); await f.domain.save(1, command()); await f.domain.save(2, command("perio:target-0001"));
    const before = structuredClone(f.records());
    for (const row of f.records()) if (row.patient_id === 1) row.patient_id = 2;
    f.patients.delete(1);
    expect(await f.domain.save(1, command())).toMatchObject({ reason: "not_found" });
    expect(await f.domain.save(2, command())).toMatchObject({ reason: "request_conflict" });
    const result = await f.domain.read(2, { toothCode: 16, beforeId: null });
    if (!result.ok) throw new Error(result.message);
    expect(result.records.map((r) => r.id)).toEqual([2, 1]);
    expect(f.records().map((r) => ({ ...r, patient_id: 0 }))).toEqual(before.map((r) => ({ ...r, patient_id: 0 })));
  });
  it.each(["connect", "authorization"] as const)("captures nested save intent before the %s wait", async (stage) => {
    const f = pausedFixture(stage); const input = command(); const original = structuredClone(input);
    const pending = f.domain.save(1, input);
    try {
      await f.waiting;
      input.toothCode = 17; input.expectedHeadId = 123; input.requestKey = "perio:mutated-key";
      input.sites[0].depthMm = "8"; input.sites[1].bleeding = true; input.sites.reverse();
    } finally { f.open(); }
    expect(await pending).toMatchObject({ ok: true, record: { toothCode: 16, priorRecordId: null } });
    expect(f.records()[0]).toMatchObject({ tooth_code: 16, request_key: original.requestKey, prior_record_id: null });
    expect(f.records()[0].sites[0].depthMm).toBe("3.5"); expect(f.records()[0].sites[1].bleeding).toBe(false);
    expect(await f.domain.save(1, original)).toMatchObject({ ok: true, replayed: true });
    expect(f.records()).toHaveLength(1); expect(f.audits()).toHaveLength(1);
  });
  it.each(["connect", "authorization"] as const)("captures history tooth and cursor before the %s wait", async (stage) => {
    const f = fixture(); await f.domain.save(1, command()); await f.domain.save(1, command("perio:other-0001", null, 17));
    let open!: () => void; let entered!: () => void;
    const wait = new Promise<void>((resolve) => { open = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    if (stage === "connect") f.connect.mockImplementationOnce(async () => { entered(); await wait; return f.client; });
    else f.authorizePatient.mockImplementationOnce(async () => { entered(); await wait; return f.principal; });
    const history = { toothCode: 16, beforeId: 2 as number | null }; const pending = f.domain.read(1, history);
    try { await waiting; history.toothCode = 17; history.beforeId = 1; } finally { open(); }
    const result = await pending; expect(result).toMatchObject({ ok: true, nextBeforeId: null });
    if (!result.ok) throw new Error(result.message);
    expect(result.records.map((r) => [r.id, r.toothCode])).toEqual([[1, 16]]);
  });
  it("retains an invalid invocation even when the save input becomes valid during admission", async () => {
    const f = pausedFixture("authorization"); const input = command(); input.toothCode = 99;
    const pending = f.domain.save(1, input);
    try { await f.waiting; input.toothCode = 16; } finally { f.open(); }
    expect(await pending).toMatchObject({ reason: "invalid" }); expect(f.records()).toEqual([]); expect(f.audits()).toEqual([]);
  });
  it("retains an invalid history invocation even when its cursor becomes valid during admission", async () => {
    const f = pausedFixture("authorization"); const history = { toothCode: 16, beforeId: -1 };
    const pending = f.domain.read(1, history);
    try { await f.waiting; history.beforeId = 1; } finally { f.open(); }
    expect(await pending).toMatchObject({ reason: "invalid" });
  });
  it("returns denial for invalid and throwing command capture without validation or existence disclosure", async () => {
    const f = fixture(); f.authorizePatient.mockResolvedValue(null);
    const throwing = Object.defineProperty(command(), "toothCode", { get() { throw new Error("private getter detail"); } });
    expect(await f.domain.save(3, null)).toMatchObject({ reason: "denied" });
    expect(await f.domain.save(3, throwing)).toMatchObject({ reason: "denied" });
    expect(f.records()).toEqual([]); expect(f.audits()).toEqual([]);
  });
  it("returns denial for throwing history capture without validation or existence disclosure", async () => {
    const f = fixture(); f.authorizePatient.mockResolvedValue(null);
    const history = Object.defineProperty({ toothCode: 16, beforeId: null }, "beforeId", { get() { throw new Error("private cursor detail"); } });
    expect(await f.domain.read(3, history)).toMatchObject({ reason: "denied" });
  });
  it("returns only a generic invalid result for capture errors after authorized admission", async () => {
    const f = fixture(); const throwing = Object.defineProperty(command(), "toothCode", { get() { throw new Error("private getter detail"); } });
    const result = await f.domain.save(1, throwing); expect(result).toMatchObject({ reason: "invalid" });
    expect(JSON.stringify(result)).not.toContain("private getter detail"); expect(f.audits()).toEqual([]);
  });
  it("supplies a fail-closed history count for the existing deletion owner", async () => {
    const f = fixture(); expect(await periodontalHistoryCount(f.client, 1)).toBe(0);
    await f.domain.save(1, command()); expect(await periodontalHistoryCount(f.client, 1)).toBe(1);
    await expect(periodontalHistoryCount(f.client, 0)).rejects.toThrow();
    expect(await periodontalHistoryCount(f.client, 2)).toBe(0);
  });
});
