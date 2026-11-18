/** 0137 + step 3: a NEW canonical completion writes one sealed record in the same transaction; reviewed sources are
 * compared; a same-actor retry returns the original receipt; sealed rows and witnessed inputs are immutable; reset is
 * refused. Synthetic data only, on the owned disposable database. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { REQUIRED_LANDMARKS } from "../../lib/ceph";
import { seedCanonicalCeph } from "../fixtures/canonical-ceph";
import { cephContentHash } from "../../lib/ceph-provenance/canonical-json";
import { decodeCephCompletionWitness } from "../../lib/ceph-provenance/witness";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv(); vi.stubEnv("SESSION_SECRET", "synthetic-ceph-provenance-secret-0123456789");
const db = await import("../../lib/db"), commands = await import("../../lib/canonical-ceph-complete-command"), reads = await import("../../lib/canonical-ceph-reads");
const { ProtectedCephProvenanceHistoryError } = await import("../../lib/clinic-reset");
const ANALYZE = { "clinical.xrays.view": true, "clinical.ceph.analyze": true };
const ACCOUNTS = {
  owner: { username: "SYN-CPV-OWNER", role: "admin" },
  own: { username: "SYN-CPV-OWN", role: "doctor", doctor: true, patientScope: "own", grants: ANALYZE },
  all: { username: "SYN-CPV-ALL", role: "reception", patientScope: "all", grants: ANALYZE },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, seq = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); }, 180000);
afterAll(async () => { await fx?.close(); });

async function scenario() {
  const patientId = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-CPV-${++seq}`, fx.parties.own])).rows[0].id as number;
  const s = await seedCanonicalCeph(fx.pool, { patientId, status: "draft" });
  await fx.pool.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,'SYN_OLD_CODE',1.25,2.75,'manual','SYN original')", [s.id]);
  await fx.pool.query("INSERT INTO ceph_diagnoses(analysis_id,final_dx,created_by) VALUES($1,'SYN draft diagnosis','SYN')", [s.id]);
  await fx.pool.query("UPDATE ceph_analyses SET cal_x1=0,cal_y1=0,cal_x2=100,cal_y2=0,cal_mm=50,mm_per_pixel=0.5 WHERE id=$1", [s.id]);
  for (const [i, code] of REQUIRED_LANDMARKS.entries()) await fx.pool.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,$2,$3,$4,$5,'SYN')", [s.id, code, 40 + (i * 37) % 400, 30 + (i * 53) % 380, i === 0 ? "suggested" : "manual"]);
  return s;
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const observe = async (s: Scenario) => reads.readCanonicalCephStudy(await fx.session("owner"), s.id);
const complete = async (key: Key, s: Scenario, body: unknown) => commands.commandCanonicalCephComplete(await fx.session(key), String(s.id), body);
const provenance = async (s: Scenario) => (await fx.pool.query("SELECT * FROM ceph_completion_provenance WHERE analysis_id=$1", [s.id])).rows;
const audits = async (s: Scenario) => (await fx.pool.query("SELECT id FROM audit_log WHERE action='ceph.complete' AND entity_id=$1", [String(s.id)])).rows;

it("a completion seals one record in the same transaction, bound to the reviewed sources", async () => {
  const s = await scenario(), seen = await observe(s);
  expect(seen.completionSources).toMatchObject({ schemaVersion: 1, documentId: s.documentId, engineId: "aqlan-legacy-ceph" });
  expect(await complete("own", s, { expectedVersion: seen.discardVersion, expectedSources: seen.completionSources })).toEqual({ ok: true, studyId: s.id, status: "completed" });
  const [row] = await provenance(s);
  const { rows: [a] } = await fx.pool.query("SELECT completed_by,completed_at FROM ceph_analyses WHERE id=$1", [s.id]);
  expect(row).toMatchObject({ schema_version: 1, approved_draft_version: seen.discardVersion, sealed_by: ACCOUNTS.own.username, actor_user_id: (await fx.pool.query("SELECT id FROM users WHERE username=$1", [ACCOUNTS.own.username])).rows[0].id });
  expect(row.sealed_at.toISOString()).toBe(a.completed_at.toISOString());
  const witness = decodeCephCompletionWitness(row.witness, row.witness_sha256)!;
  expect(witness).not.toBeNull();
  expect(cephContentHash(row.witness)).toBe(row.witness_sha256);
  expect(witness.sourceIdentityMeaning).toBe("submitted_source_identity_matches_server_capture");
  expect(witness.snapshot.landmarks.map((p) => p.code)).not.toContain("SYN_OLD_CODE");
  expect((await fx.pool.query("SELECT 1 FROM ceph_landmarks WHERE analysis_id=$1 AND code='SYN_OLD_CODE'", [s.id])).rows).toHaveLength(1);
  expect(witness.snapshot.landmarks.find((p) => p.code === REQUIRED_LANDMARKS[0])!.source).toBe("suggested");
  const stored = new Map((await fx.pool.query("SELECT code,value FROM ceph_measurements WHERE analysis_id=$1", [s.id])).rows.map((m: { code: string; value: number }) => [m.code, m.value]));
  for (const m of witness.measurements) expect(stored.get(m.code), m.code).toBe(m.value);
  expect((await observe(s)).provenance).toMatchObject({ state: "versioned", witnessSha256: row.witness_sha256, sealedBy: ACCOUNTS.own.username });
});

it("without reviewed sources the record says so; old clients keep working", async () => {
  const s = await scenario();
  await complete("own", s, { expectedVersion: (await observe(s)).discardVersion });
  const [row] = await provenance(s);
  expect(decodeCephCompletionWitness(row.witness, row.witness_sha256)!.sourceIdentityMeaning).toBe("server_captured_at_completion_not_confirmed_as_viewed");
});

it.each(["image", "reference"] as const)("a %s changed after review refuses completion and writes nothing", async (kind) => {
  const s = await scenario(), seen = await observe(s);
  if (kind === "image") await fx.pool.query("UPDATE patient_documents SET sha256=$2 WHERE id=$1", [s.documentId, "f".repeat(64)]);
  // Change the selected reference set: its version if it exists, otherwise create it (null → stored set).
  let restoreReference = async () => {};
  if (kind === "reference") {
    const { rows: [set] } = await fx.pool.query("SELECT id,version FROM ceph_reference_sets WHERE key='builtin_default'");
    if (set) { await fx.pool.query("UPDATE ceph_reference_sets SET version='syn-changed' WHERE id=$1", [set.id]); restoreReference = async () => { await fx.pool.query("UPDATE ceph_reference_sets SET version=$2 WHERE id=$1", [set.id, set.version]); }; }
    else { await fx.pool.query("INSERT INTO ceph_reference_sets(key,name,version,created_by) VALUES('builtin_default','SYN','syn-v1','SYN')"); restoreReference = async () => { await fx.pool.query("DELETE FROM ceph_reference_sets WHERE key='builtin_default'"); }; }
  }
  await expect(complete("own", s, { expectedVersion: seen.discardVersion, expectedSources: seen.completionSources })).rejects.toMatchObject({ code: "ceph_complete_sources_changed", status: 409 });
  expect((await fx.pool.query("SELECT status FROM ceph_analyses WHERE id=$1", [s.id])).rows[0].status).toBe("draft");
  expect(await provenance(s)).toEqual([]); expect(await audits(s)).toEqual([]);
  await restoreReference();
});

it("a same-actor retry of the approved version returns the original receipt once; another actor or version conflicts", async () => {
  const s = await scenario(), seen = await observe(s), body = { expectedVersion: seen.discardVersion, expectedSources: seen.completionSources };
  expect(await complete("own", s, body)).toEqual({ ok: true, studyId: s.id, status: "completed" });
  expect(await complete("own", s, body)).toEqual({ ok: true, studyId: s.id, status: "completed" });
  expect(await provenance(s)).toHaveLength(1); expect(await audits(s)).toHaveLength(1);
  await expect(complete("all", s, body)).rejects.toMatchObject({ code: "ceph_complete_conflict" });
  await expect(complete("own", s, { expectedVersion: "a".repeat(64) })).rejects.toMatchObject({ code: "ceph_complete_conflict" });
});

it("refuses malformed reviewed sources before any lock", async () => {
  const s = await scenario(), seen = await observe(s);
  await expect(complete("own", s, { expectedVersion: seen.discardVersion, expectedSources: { ...seen.completionSources, engineId: "x" } })).rejects.toMatchObject({ code: "invalid_ceph_complete", status: 400 });
  await expect(complete("own", s, { expectedVersion: seen.discardVersion, extra: 1 })).rejects.toMatchObject({ code: "invalid_ceph_complete" });
});

it("sealed records and witnessed inputs are immutable; a legal patient move is still allowed", async () => {
  const s = await scenario(), seen = await observe(s);
  await complete("own", s, { expectedVersion: seen.discardVersion });
  const refused = (sql: string, values: unknown[] = []) => expect(fx.pool.query(sql, values)).rejects.toMatchObject({ code: "55000" });
  await refused("UPDATE ceph_completion_provenance SET sealed_by='x' WHERE analysis_id=$1", [s.id]);
  await refused("DELETE FROM ceph_completion_provenance WHERE analysis_id=$1", [s.id]);
  await refused("TRUNCATE ceph_completion_provenance CASCADE");
  await refused("UPDATE ceph_analyses SET note='edited' WHERE id=$1", [s.id]);
  await refused("UPDATE ceph_landmarks SET x=x+1 WHERE analysis_id=$1", [s.id]);
  await refused("INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,'SYN_LATE',1)", [s.id]);
  await refused("DELETE FROM ceph_diagnoses WHERE analysis_id=$1", [s.id]);
  const other = (await fx.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,$1) RETURNING id", [`SYN-CPV-MERGE-${seq}`])).rows[0].id;
  await fx.pool.query("UPDATE patient_documents SET patient_id=$2 WHERE id=$1", [s.documentId, other]);
  await fx.pool.query("UPDATE ceph_analyses SET patient_id=$2 WHERE id=$1", [s.id, other]);
  expect((await fx.pool.query("SELECT patient_id FROM ceph_analyses WHERE id=$1", [s.id])).rows[0].patient_id).toBe(other);
});

it("a historical completion without a record reads as unversioned, and a corrupted store as integrity-unavailable", async () => {
  const patientId = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-CPV-H-${++seq}`, fx.parties.own])).rows[0].id;
  const historical = await seedCanonicalCeph(fx.pool, { patientId, status: "completed" });
  expect((await reads.readCanonicalCephStudy(await fx.session("owner"), historical.id)).provenance).toEqual({ state: "unversioned" });
  const s = await scenario(), seen = await observe(s);
  await complete("own", s, { expectedVersion: seen.discardVersion });
  await fx.pool.query("ALTER TABLE ceph_measurements DISABLE TRIGGER ceph_witnessed_measurements_immutable");
  try { await fx.pool.query("UPDATE ceph_measurements SET value=value+1 WHERE analysis_id=$1 AND code='ANB'", [s.id]); }
  finally { await fx.pool.query("ALTER TABLE ceph_measurements ENABLE TRIGGER ceph_witnessed_measurements_immutable"); }
  expect((await observe(s)).provenance).toEqual({ state: "integrity-unavailable", reason: "stored_values_differ_from_witness" });
});

it("clinic reset is refused once a sealed record exists, before any backup", async () => {
  const backup = vi.fn(async () => ({ ok: true as const, backupId: "must-not-run" }));
  await expect(db.resetClinicData({ actor: "synthetic", actorRole: "admin" }, backup)).rejects.toBeInstanceOf(ProtectedCephProvenanceHistoryError);
  expect(backup).not.toHaveBeenCalled();
});
