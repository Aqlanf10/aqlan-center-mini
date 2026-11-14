import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalCephReferences } from "../fixtures/canonical-ceph-reference";
import type { CanonicalSnapshotQuery } from "../../lib/canonical-read-snapshot";

vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-ceph-reference-secret-0123456789");
const db = await import("../../lib/db"), reads = await import("../../lib/canonical-ceph-references"), snapshots = await import("../../lib/canonical-read-snapshot");
const patientReads = await import("../../lib/canonical-ceph-reads");
const { staffRuntimeActions } = await import("../../lib/staff-operation-runtime");
const VIEW = { "clinical.xrays.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-CR-OWNER", role: "admin" },
  own: { username: "SYN-CR-OWN", role: "doctor", doctor: true, patientScope: "own", grants: VIEW },
  all: { username: "SYN-CR-ALL", role: "reception", patientScope: "all", grants: VIEW },
  none: { username: "SYN-CR-NONE", role: "reception", patientScope: "none", grants: VIEW },
  unlinked: { username: "SYN-CR-UNLINKED", role: "doctor", patientScope: "own", grants: VIEW },
  denied: { username: "SYN-CR-DENIED", role: "admin", patientScope: "all", grants: { "clinical.ortho.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, setId: string;
const read = async (key: Key = "none") => reads.readCanonicalCephReferences(await fx.session(key));
beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  side = new Pool({ connectionString: fx.pool.options.connectionString, max: 3 });
  setId = await seedCanonicalCephReferences(fx.pool);
}, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });

it("registers the existing imaging capability exactly without changing its patient record constraints", () => {
  expect(staffRuntimeActions().filter(action => action === "clinical.xrays.view")).toHaveLength(1);
});
it.each(["owner", "own", "all", "none", "unlinked"] as const)("%s reads non-patient catalogue facts with stored precision and no patient grant", async key => {
  const body = await read(key);
  expect(body).toEqual({ projection: "ceph-reference-catalog", sets: [{ key: "SYN-reference", name: "مرجع تجريبي حالي", population: "مجموعة اصطناعية",
    ageMin: 10, ageMax: 18, sex: "female", version: "SYN-v2", values: { ANB: { mean: 2.125, sd: 1.75 }, SYN_OLD_CODE: { mean: 123.123456, sd: 0.125 } } }] });
  expect(JSON.stringify(body)).not.toMatch(/patient|createdBy|created_by|private author|inactive|invoice|document|storage/);
});
it("a role or adjacent clinical grant cannot replace imaging permission; catalogue permission cannot open a patient", async () => {
  await expect(read("denied")).rejects.toThrow(/CAPABILITY_DENIED/);
  await expect(patientReads.readCanonicalCephList(await fx.session("none"), 1)).rejects.toThrow(/RECORD_SCOPE_DENIED/);
});
function intercept(wrap: (q: CanonicalSnapshotQuery) => CanonicalSnapshotQuery) {
  const original = snapshots.runCanonicalReadSnapshot;
  return vi.spyOn(snapshots, "runCanonicalReadSnapshot").mockImplementationOnce((session, action, reader, options) => original(session, action, (q, scope) => reader(wrap(q), scope), options));
}
it("uses one RR read-only lease without schema initialization, patient/financial queries or writes", async () => {
  const session = await fx.session("none"), pool = db.getPool(), connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), ensure = vi.spyOn(db, "ensureSchema");
  const before = (await fx.pool.query("SELECT (SELECT count(*) FROM audit_log)::int audits,(SELECT count(*) FROM invoices)::int invoices,(SELECT count(*) FROM ceph_reference_sets)::int refs")).rows;
  const hook = intercept(q => ({ query: (async (sql: string, args?: unknown[]) => {
    expect(sql).not.toMatch(/\b(patients|payments|invoices|patient_documents|ceph_analyses)\b/);
    expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
    expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
    return q.query(sql, args);
  }) as typeof q.query }));
  try { await reads.readCanonicalCephReferences(session); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); }
  finally { hook.mockRestore(); connect.mockRestore(); query.mockRestore(); ensure.mockRestore(); }
  expect((await fx.pool.query("SELECT (SELECT count(*) FROM audit_log)::int audits,(SELECT count(*) FROM invoices)::int invoices,(SELECT count(*) FROM ceph_reference_sets)::int refs")).rows).toEqual(before);
});
it("reads set metadata and values in one snapshot across a concurrent revision", async () => {
  let changed = false;
  const hook = intercept(q => ({ query: (async (sql: string, args?: unknown[]) => {
    const result = await q.query(sql, args);
    if (!changed && sql.startsWith("SELECT id::text")) {
      changed = true; const writer = await side.connect();
      try { await writer.query("BEGIN"); await writer.query("UPDATE ceph_reference_sets SET version='SYN-v3' WHERE id=$1", [setId]); await writer.query("UPDATE ceph_reference_values SET mean=99 WHERE set_id=$1 AND code='ANB'", [setId]); await writer.query("COMMIT"); }
      finally { await writer.query("ROLLBACK"); writer.release(); }
    }
    return result;
  }) as typeof q.query }));
  try { expect((await read()).sets[0]).toMatchObject({ version: "SYN-v2", values: { ANB: { mean: 2.125 } } }); hook.mockRestore(); expect((await read()).sets[0]).toMatchObject({ version: "SYN-v3", values: { ANB: { mean: 99 } } }); }
  finally { hook.mockRestore(); await side.query("UPDATE ceph_reference_sets SET version='SYN-v2' WHERE id=$1", [setId]); await side.query("UPDATE ceph_reference_values SET mean=2.125 WHERE set_id=$1 AND code='ANB'", [setId]); }
});
it.each([
  ["ceph_reference_sets", "name", "", "مرجع تجريبي حالي"], ["ceph_reference_sets", "age_min", -1, 10],
  ["ceph_reference_sets", "age_max", 9, 18], ["ceph_reference_sets", "version", " ", "SYN-v2"],
  ["ceph_reference_values", "mean", "NaN", 2.125], ["ceph_reference_values", "mean", "Infinity", 2.125],
  ["ceph_reference_values", "sd", "NaN", 1.75], ["ceph_reference_values", "sd", "Infinity", 1.75],
] as const)("refuses malformed stored %s.%s rather than defaulting", async (table, field, bad, original) => {
  const where = table === "ceph_reference_sets" ? "id=$1" : "set_id=$1 AND code='ANB'";
  await fx.pool.query(`UPDATE ${table} SET ${field}=$2 WHERE ${where}`, [setId, bad]);
  try { await expect(read()).rejects.toMatchObject({ code: "ceph_reference_invalid" }); }
  finally { await fx.pool.query(`UPDATE ${table} SET ${field}=$2 WHERE ${where}`, [setId, original]); }
});
it("rejects excess set, value and byte budgets without silently truncating the catalogue", async () => {
  await fx.pool.query("INSERT INTO ceph_reference_sets(key,name,created_by) SELECT 'SYN-budget-'||n,'SYN','SYN' FROM generate_series(1,200) n");
  try { await expect(read()).rejects.toMatchObject({ code: "ceph_reference_limit" }); }
  finally { await fx.pool.query("DELETE FROM ceph_reference_sets WHERE key LIKE 'SYN-budget-%'"); }
  await fx.pool.query("INSERT INTO ceph_reference_values(set_id,code,mean,sd) SELECT $1,'SYN-budget-'||n,1,1 FROM generate_series(1,255) n", [setId]);
  try { await expect(read()).rejects.toMatchObject({ code: "ceph_reference_limit" }); }
  finally { await fx.pool.query("DELETE FROM ceph_reference_values WHERE set_id=$1 AND code LIKE 'SYN-budget-%'", [setId]); }
  await fx.pool.query("UPDATE ceph_reference_sets SET population=repeat('S',2100000) WHERE id=$1", [setId]);
  try { await expect(read()).rejects.toMatchObject({ code: "ceph_reference_limit" }); }
  finally { await fx.pool.query("UPDATE ceph_reference_sets SET population='مجموعة اصطناعية' WHERE id=$1", [setId]); }
});
it("inactive changes do not leak or block the active catalogue; empty catalogues remain honest", async () => {
  const before = await read();
  await fx.pool.query("UPDATE ceph_reference_sets SET population=repeat('S',2100000) WHERE key='SYN-inactive'");
  expect(await read()).toEqual(before);
  await fx.pool.query("UPDATE ceph_reference_sets SET active=FALSE WHERE id=$1", [setId]);
  try { expect(await read()).toEqual({ projection: "ceph-reference-catalog", sets: [] }); }
  finally { await fx.pool.query("UPDATE ceph_reference_sets SET active=TRUE WHERE id=$1", [setId]); }
});
it("expires while waiting on the actual lifecycle fence", async () => {
  const session = await fx.session("none", 1500), holder = await side.connect();
  try {
    await holder.query("BEGIN"); const pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    const pending = reads.readCanonicalCephReferences(session); pending.catch(() => undefined);
    try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); await new Promise(resolve => setTimeout(resolve, 1700)); }
    finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); }
});
it("reproves removed permission after the fence and refuses both old and fresh sessions", async () => {
  const session = await fx.session("all"), holder = await side.connect();
  try {
    await holder.query("BEGIN"); const pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    await holder.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: {}, patientScope: "all" }, 2)), fx.ids.all]);
    const pending = reads.readCanonicalCephReferences(session); pending.catch(() => undefined);
    try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); } finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(/STALE/); await expect(read("all")).rejects.toThrow(/CAPABILITY_DENIED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); await fx.setGrants("all", VIEW, { patientScope: "all" }); }
});
it("retired credentials invalidate prior catalogue authority without widening a scope", async () => {
  const session = await fx.session("none"); await fx.pool.query("UPDATE users SET password_hash='SYN retired reference hash' WHERE id=$1", [fx.ids.none]);
  await expect(reads.readCanonicalCephReferences(session)).rejects.toThrow(/STALE/);
  expect((await read()).sets).toHaveLength(1);
});
it("query failure discards the partial catalogue and leaves the next lease usable", async () => {
  const hook = intercept(q => ({ query: (async (sql: string, args?: unknown[]) => sql.startsWith("SELECT v.set_id") ? q.query("SELECT 1/0") : q.query(sql, args)) as typeof q.query }));
  try { await expect(read()).rejects.toThrow(); } finally { hook.mockRestore(); }
  expect((await read()).sets[0].values.ANB.mean).toBe(2.125);
});
