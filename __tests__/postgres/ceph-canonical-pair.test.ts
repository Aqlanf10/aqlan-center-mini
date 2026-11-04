import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalCephComparison } from "../fixtures/canonical-ceph-comparison";
import { seedCanonicalCeph } from "../fixtures/canonical-ceph";
import type { CanonicalSnapshotQuery } from "../../lib/canonical-read-snapshot";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-ceph-pair-secret-0123456789");
const db = await import("../../lib/db"), reads = await import("../../lib/canonical-ceph-pair-reads"), snapshots = await import("../../lib/canonical-read-snapshot");
const VIEW = { "clinical.xrays.view": true }, MODES = ["compare", "superimpose"] as const;
const ACCOUNTS = {
  owner: { username: "SYN-CP-OWNER", role: "admin" },
  own: { username: "SYN-CP-OWN", role: "doctor", doctor: true, patientScope: "own", grants: VIEW },
  all: { username: "SYN-CP-ALL", role: "reception", patientScope: "all", grants: VIEW },
  none: { username: "SYN-CP-NONE", role: "admin", patientScope: "none", grants: VIEW },
  unlinked: { username: "SYN-CP-UNLINKED", role: "doctor", patientScope: "own", grants: VIEW },
  adjacent: { username: "SYN-CP-ADJACENT", role: "admin", patientScope: "all", grants: { "clinical.ortho.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, ids: Awaited<ReturnType<typeof seedCanonicalCephComparison>>, outside: Awaited<ReturnType<typeof seedCanonicalCephComparison>>, discarded = 0;
const read = async (key: Key, mode: typeof MODES[number] = "compare", first = ids.before, second = ids.after) => reads.readCanonicalCephPair(await fx.session(key), mode, first, second);
beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 3 });
  const ownPatient = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-CP-OWN-P','SYN own pair',$1) RETURNING id", [fx.parties.own])).rows[0].id;
  const outsidePatient = (await fx.pool.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-CP-OUT-P','SYN outside pair') RETURNING id")).rows[0].id;
  ids = await seedCanonicalCephComparison(fx.pool, ownPatient); outside = await seedCanonicalCephComparison(fx.pool, outsidePatient);
  discarded = (await seedCanonicalCeph(fx.pool, { patientId: ownPatient, status: "discarded" })).id;
}, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
it.each(MODES)("registers the independent imaging record grant for %s", async mode => {
  const { CANONICAL_RECORD_READS } = await import("../../lib/canonical-record-reads"); expect(CANONICAL_RECORD_READS[`read:ceph.${mode}`]).toEqual({ record: "patient", need: ["clinical.xrays.view"], anyOf: [] });
});
it.each(["owner", "own", "all"] as const)("%s reads exact saved values and geometry, without private image/financial/diagnosis fields", async key => {
  const comparison = await read(key); expect(comparison.projection).toBe("ceph-saved-comparison");
  if (comparison.projection !== "ceph-saved-comparison") throw Error("wrong projection");
  expect(Object.keys(comparison).sort()).toEqual(["after", "before", "normSource", "onlyAfter", "onlyBefore", "patientId", "projection", "rows"]);
  expect(comparison.before.id).toBe(ids.before); expect(comparison.after.id).toBe(ids.after);
  expect(comparison.rows).toContainEqual({ code: "ANB", before: 4.125, after: 2.25, delta: -1.875 });
  expect(comparison.rows).toContainEqual({ code: "SYN_OLD_MEASURE", before: 10.125, after: 12.125, delta: 2 });
  expect(comparison.onlyBefore).toEqual(["SYN_ONLY_BEFORE"]); expect(comparison.onlyAfter).toEqual(["SYN_ONLY_AFTER"]);
  const geometry = await read(key, "superimpose"); expect(geometry).toMatchObject({ projection: "ceph-saved-superimposition", cranialBaseBefore: 10, cranialBaseAfter: 20, rotationDegrees: 0 });
  for (const result of [comparison, geometry]) expect(JSON.stringify(result)).not.toMatch(/SYN saved clinical note|SYN machine|SYN recorder|private.png|documentId|storage_key|diagnosis|phone|invoice|price|improved|worsened|gapBefore/);
});
it.each(MODES)("%s preserves imaging-date order even when request and registration dates are reversed", async mode => { expect(await read("own", mode, ids.after, ids.before)).toEqual(await read("own", mode)); });
it.each(["none", "unlinked", "adjacent"] as const)("denies %s on both contracts without role or scope expansion", async key => { for (const mode of MODES) await expect(read(key, mode)).rejects.toThrow(/CAPABILITY_DENIED|RECORD_SCOPE_DENIED|PROVIDER/); });
it.each(MODES)("%s hides foreign, absent and discarded records on either side consistently", async mode => {
  const errors = [];
  for (const hidden of [outside.before, discarded, 2147483647]) for (const [first, second] of [[ids.before, hidden], [hidden, ids.after]]) {
    try { await read("own", mode, first, second); throw Error("unexpected admission"); } catch (error) { errors.push({ code: (error as { code: string }).code, message: (error as Error).message }); }
  }
  expect(errors[0].code).toBe("patient_not_found"); for (const error of errors) expect(error).toEqual(errors[0]);
});
it.each(MODES)("%s rejects different patients after both records are individually authorized", async mode => { await expect(read("all", mode, ids.before, outside.after)).rejects.toMatchObject({ code: "ceph_pair_patient_mismatch" }); });
it("rejects foreign document ownership without exposing one half of the pair", async () => {
  await fx.pool.query("UPDATE ceph_analyses SET document_id=$1 WHERE id=$2", [outside.document, ids.before]);
  try { for (const mode of MODES) await expect(read("owner", mode)).rejects.toMatchObject({ code: "ceph_reference_unavailable" }); }
  finally { await fx.pool.query("UPDATE ceph_analyses SET document_id=$1 WHERE id=$2", [ids.document, ids.before]); }
});
it("retains saved draft values as explicitly unapproved and never calls a current compute engine", async () => {
  const engine = await import("../../lib/ceph"), compute = vi.spyOn(engine, "computeAll").mockImplementation(() => { throw new Error("must not compute"); });
  await fx.pool.query("UPDATE ceph_analyses SET status='draft' WHERE id=$1", [ids.before]);
  try { for (const mode of MODES) { const result = await read("own", mode); expect(result.before).toMatchObject({ status: "draft", measurementsState: "saved-unapproved" }); } expect(compute).not.toHaveBeenCalled(); }
  finally { compute.mockRestore(); await fx.pool.query("UPDATE ceph_analyses SET status='completed' WHERE id=$1", [ids.before]); }
});
it("does not substitute computed values for an approved study with no saved measurements", async () => {
  const empty = await seedCanonicalCeph(fx.pool, { patientId: ids.patientId }); await fx.pool.query("DELETE FROM ceph_measurements WHERE analysis_id=$1", [empty.id]);
  const result = await read("own", "compare", ids.before, empty.id); if (result.projection !== "ceph-saved-comparison") throw Error("wrong projection");
  expect(result.rows).toEqual([]); expect(result.onlyBefore.length + result.onlyAfter.length).toBe(5);
});
it.each(["landmarks", "measurements"] as const)("bounds %s on the second study before publishing a pair", async table => {
  const over = await seedCanonicalCeph(fx.pool, { patientId: ids.patientId });
  if (table === "measurements") await fx.pool.query("INSERT INTO ceph_measurements(analysis_id,code,value) SELECT $1,'SYN'||n,1 FROM generate_series(1,257) n", [over.id]);
  else await fx.pool.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,confirmed_by) SELECT $1,'SYN'||n,1,1,'SYN' FROM generate_series(1,257) n", [over.id]);
  for (const mode of MODES) await expect(read("owner", mode, ids.before, over.id)).rejects.toMatchObject({ code: "ceph_read_limit" });
});
it("retains the per-study 2 MiB admission boundary without truncating or repairing stored notes", async () => {
  const over = await seedCanonicalCeph(fx.pool, { patientId: ids.patientId }); await fx.pool.query("UPDATE ceph_analyses SET note=repeat('x',2100000) WHERE id=$1", [over.id]);
  await expect(read("owner", "compare", ids.before, over.id)).rejects.toMatchObject({ code: "ceph_read_limit" });
  expect((await fx.pool.query("SELECT length(note) n FROM ceph_analyses WHERE id=$1", [over.id])).rows[0].n).toBe(2100000);
});
it("refuses nonfinite derived deltas rather than serializing Infinity as null", async () => {
  await fx.pool.query("UPDATE ceph_measurements SET value=CASE WHEN analysis_id=$1 THEN '1e308'::double precision ELSE '-1e308'::double precision END WHERE analysis_id=ANY($2::bigint[]) AND code='ANB'", [ids.before, [ids.before, ids.after]]);
  try { await expect(read("own")).rejects.toMatchObject({ code: "ceph_pair_invalid" }); }
  finally { await fx.pool.query("UPDATE ceph_measurements SET value=CASE WHEN analysis_id=$1 THEN 4.125 ELSE 2.25 END WHERE analysis_id=ANY($2::bigint[]) AND code='ANB'", [ids.before, [ids.before, ids.after]]); }
});
it.each(["missing-anchor", "zero-baseline", "missing-calibration", "overflow"])("refuses unavailable geometry: %s", async kind => {
  const saved = await seedCanonicalCephComparison(fx.pool, ids.patientId);
  if (kind === "missing-anchor") await fx.pool.query("DELETE FROM ceph_landmarks WHERE analysis_id=$1 AND code='S'", [saved.after]);
  if (kind === "zero-baseline") await fx.pool.query("UPDATE ceph_landmarks SET x=200,y=50 WHERE analysis_id=$1 AND code='N'", [saved.after]);
  if (kind === "missing-calibration") await fx.pool.query("UPDATE ceph_analyses SET mm_per_pixel=NULL WHERE id=$1", [saved.after]);
  if (kind === "overflow") await fx.pool.query("UPDATE ceph_analyses SET mm_per_pixel='1e308' WHERE id=$1", [saved.after]);
  await expect(read("own", "superimpose", saved.before, saved.after)).rejects.toMatchObject({ code: kind === "overflow" ? "ceph_pair_invalid" : "ceph_pair_geometry_unavailable" });
});
function instrument(wrap: (q: CanonicalSnapshotQuery) => CanonicalSnapshotQuery) {
  const original = snapshots.runCanonicalReadSnapshot;
  return vi.spyOn(snapshots, "runCanonicalReadSnapshot").mockImplementationOnce((session, action, reader, options) => original(session, action, (q, scope) => reader(wrap(q), scope), options));
}
it.each(MODES)("%s uses one RR READ ONLY lease, no pool/schema/current reference/finance reader or audit mutation", async mode => {
  const session = await fx.session("own"), before = (await fx.pool.query("SELECT count(*)::int n FROM audit_log")).rows;
  const pool = db.getPool(), connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), ensure = vi.spyOn(db, "ensureSchema"), sql: string[] = [];
  const hook = instrument(q => ({ query: async (text, args) => { sql.push(text); expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read"); expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on"); return q.query(text, args); } }));
  try { await reads.readCanonicalCephPair(session, mode, ids.before, ids.after); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); expect(sql.join("\n")).not.toMatch(/ceph_ref_|\b(invoices|payments|settings)\b/); }
  finally { hook.mockRestore(); connect.mockRestore(); query.mockRestore(); ensure.mockRestore(); }
  expect((await fx.pool.query("SELECT count(*)::int n FROM audit_log")).rows).toEqual(before);
});
it("pins both studies to one snapshot across a concurrent commit", async () => {
  let changed = false; const hook = instrument(q => ({ query: async (text, args) => {
    if (!changed) { changed = true; await side.query("UPDATE ceph_measurements SET value=CASE WHEN analysis_id=$1 THEN 10 ELSE 20 END WHERE analysis_id=ANY($2::bigint[]) AND code='ANB'", [ids.before, [ids.before, ids.after]]); }
    return q.query(text, args);
  } }));
  try { const old = await read("own"); expect(old.projection === "ceph-saved-comparison" && old.rows.find(r => r.code === "ANB")).toEqual({ code: "ANB", before: 4.125, after: 2.25, delta: -1.875 }); hook.mockRestore(); const fresh = await read("own"); expect(fresh.projection === "ceph-saved-comparison" && fresh.rows.find(r => r.code === "ANB")).toEqual({ code: "ANB", before: 10, after: 20, delta: 10 }); }
  finally { hook.mockRestore(); await side.query("UPDATE ceph_measurements SET value=CASE WHEN analysis_id=$1 THEN 4.125 ELSE 2.25 END WHERE analysis_id=ANY($2::bigint[]) AND code='ANB'", [ids.before, [ids.before, ids.after]]); }
});
it.each(MODES)("%s re-proves authority after waiting behind permission withdrawal", async mode => {
  const session = await fx.session("all"), holder = await side.connect();
  try { await holder.query("BEGIN"); const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid; await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    await holder.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: {}, patientScope: "all" }, 2)), fx.ids.all]);
    const pending = reads.readCanonicalCephPair(session, mode, ids.before, ids.after); pending.catch(() => undefined); try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); } finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(/STALE/); await expect(read("all", mode)).rejects.toThrow(/CAPABILITY_DENIED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); await fx.setGrants("all", VIEW, { patientScope: "all" }); }
});
it("rejects expiry after fence wait and a retired credential without legacy fallback", async () => {
  const session = await fx.session("own", 1500), holder = await side.connect();
  try { await holder.query("BEGIN"); const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid; await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    const pending = reads.readCanonicalCephPair(session, "compare", ids.before, ids.after); pending.catch(() => undefined); try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); await new Promise(resolve => setTimeout(resolve, 1700)); } finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); }
  const old = await fx.session("all"), password = (await fx.pool.query("SELECT password_hash FROM users WHERE id=$1", [fx.ids.all])).rows[0].password_hash;
  await fx.pool.query("UPDATE users SET password_hash='SYN retired pair hash' WHERE id=$1", [fx.ids.all]);
  try { await expect(reads.readCanonicalCephPair(old, "superimpose", ids.before, ids.after)).rejects.toThrow(/STALE/); }
  finally { await fx.pool.query("UPDATE users SET password_hash=$1 WHERE id=$2", [password, fx.ids.all]); }
});
it("query failure publishes neither half and does not poison the next lease", async () => {
  const hook = instrument(() => ({ query: async () => { throw new Error("SYN private pair SQL"); } }));
  try { await expect(read("own")).rejects.toThrow(); } finally { hook.mockRestore(); }
  expect((await read("own")).before.id).toBe(ids.before);
});
