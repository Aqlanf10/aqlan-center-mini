/** 0137 + step 3: a NEW canonical completion writes one sealed record in the same transaction; reviewed sources are
 * compared; a same-actor retry returns the original receipt; sealed rows and witnessed inputs are immutable; reset is
 * refused. Synthetic data only, on the owned disposable database. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { waitForBlockedBy } from "./_canonical-ready-fixture";
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
let fx: CanonicalInventoryDatabase<Key>, side: Pool, seq = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 4 }); }, 180000);
afterAll(async () => { await side?.end(); await fx?.close(); });

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
  // The fixture's completion predates 0137: historical.
  expect((await reads.readCanonicalCephStudy(await fx.session("owner"), historical.id)).provenance).toEqual({ state: "unversioned", reason: "completed_before_provenance" });
  // A NEW approval through the legacy session path writes no record and is reported as such, never as historical.
  const legacy = await scenario();
  expect(await db.completeCephAnalysis(legacy.id, "SYN legacy approver")).toMatchObject({ ok: true });
  expect(await provenance(legacy)).toEqual([]);
  expect((await observe(legacy)).provenance).toEqual({ state: "unversioned", reason: "completed_without_seal" });
  const s = await scenario(), seen = await observe(s);
  await complete("own", s, { expectedVersion: seen.discardVersion });
  await fx.pool.query("ALTER TABLE ceph_measurements DISABLE TRIGGER ceph_witnessed_measurements_immutable");
  try { await fx.pool.query("UPDATE ceph_measurements SET value=value+1 WHERE analysis_id=$1 AND code='ANB'", [s.id]); }
  finally { await fx.pool.query("ALTER TABLE ceph_measurements ENABLE TRIGGER ceph_witnessed_measurements_immutable"); }
  expect((await observe(s)).provenance).toEqual({ state: "integrity-unavailable", reason: "stored_values_differ_from_witness" });
});


// ── Owner review 6967509327: tampering, concurrency, atomicity, retry re-checks ──
const tamper = async (table: string, trigger: string, sql: string, values: unknown[]) => {
  await fx.pool.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  try { await fx.pool.query(sql, values); } finally { await fx.pool.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`); }
};
async function sealed() { const s = await scenario(); await complete("own", s, { expectedVersion: (await observe(s)).discardVersion }); return s; }

it.each([
  ["landmark", "ceph_landmarks", "ceph_witnessed_landmarks_immutable", "UPDATE ceph_landmarks SET x=x+0.5 WHERE analysis_id=$1 AND code='S'", "stored_inputs_differ_from_witness"],
  ["calibration", "ceph_analyses", "ceph_witnessed_analysis_immutable", "UPDATE ceph_analyses SET mm_per_pixel=mm_per_pixel*1.01 WHERE id=$1", "stored_inputs_differ_from_witness"],
  ["diagnosis", "ceph_diagnoses", "ceph_witnessed_diagnoses_immutable", "UPDATE ceph_diagnoses SET final_dx='SYN altered' WHERE analysis_id=$1", "stored_inputs_differ_from_witness"],
  ["witness value", "ceph_completion_provenance", "ceph_completion_provenance_immutable", "UPDATE ceph_completion_provenance SET witness=jsonb_set(witness,'{measurements,0,value}','1') WHERE analysis_id=$1", "invalid_completion_witness"],
  ["witness reference", "ceph_completion_provenance", "ceph_completion_provenance_immutable", "UPDATE ceph_completion_provenance SET witness=jsonb_set(witness,'{sourceIdentity,referenceSetKey}','\"other\"') WHERE analysis_id=$1", "invalid_completion_witness"],
  ["witness engine", "ceph_completion_provenance", "ceph_completion_provenance_immutable", "UPDATE ceph_completion_provenance SET witness=jsonb_set(witness,'{sourceIdentity,engineVersion}','\"0000\"') WHERE analysis_id=$1", "invalid_completion_witness"],
  ["image", "patient_documents", "USER", "UPDATE patient_documents SET sha256=repeat('e',64) WHERE id=(SELECT document_id FROM ceph_analyses WHERE id=$1)", "source_image_changed"],
] as const)("tampering with the %s is detected on read and never recomputed", async (_name, table, trigger, sql, reason) => {
  const s = await sealed();
  const before = (await provenance(s))[0].witness_sha256;
  await tamper(table, trigger, sql, [s.id]);
  expect((await observe(s)).provenance).toEqual({ state: "integrity-unavailable", reason });
  expect((await observe(s)).provenance).toEqual({ state: "integrity-unavailable", reason }); // stable on re-read
  if (table !== "ceph_completion_provenance") expect((await provenance(s))[0].witness_sha256).toBe(before);
});

it("a later reference-catalogue change does not alter a sealed record or its state", async () => {
  const s = await sealed(), was = (await observe(s)).provenance;
  await fx.pool.query("INSERT INTO ceph_reference_sets(key,name,version,created_by) VALUES('builtin_default','SYN','syn-late','SYN') ON CONFLICT (key) DO UPDATE SET version='syn-late'");
  expect((await observe(s)).provenance).toEqual(was);
});

it("a reference change committed while the completion waits for the catalogue lock is refused, never sealed with stale sources", async () => {
  const s = await scenario(), seen = await observe(s), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try {
    await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await gate.query("INSERT INTO ceph_reference_sets(key,name,version,created_by) VALUES('builtin_default','SYN','syn-race','SYN') ON CONFLICT (key) DO UPDATE SET version='syn-race'");
    pending = complete("own", s, { expectedVersion: seen.discardVersion, expectedSources: seen.completionSources }); void pending.catch(() => undefined);
    await waitForBlockedBy(side, pid, 8000);
    await gate.query("COMMIT");
    await expect(pending).rejects.toMatchObject({ code: expect.stringMatching(/^ceph_complete_(sources_changed|conflict)$/) });
    expect(await provenance(s)).toEqual([]); expect(await audits(s)).toEqual([]);
    expect((await fx.pool.query("SELECT status FROM ceph_analyses WHERE id=$1", [s.id])).rows[0].status).toBe("draft");
  } finally { await gate.query("ROLLBACK").catch(() => undefined); gate.release(); await pending?.catch(() => undefined); }
});

it("a failing audit rolls back completion, measurements and the sealed record together", async () => {
  const s = await scenario(), seen = await observe(s);
  await fx.pool.query("CREATE FUNCTION syn_cpv_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ceph.complete' THEN RAISE EXCEPTION 'SYN audit refused'; END IF; RETURN NEW; END $$; CREATE TRIGGER syn_cpv_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_cpv_audit()");
  try { await expect(complete("own", s, { expectedVersion: seen.discardVersion })).rejects.toThrow(/SYN audit refused/); }
  finally { await fx.pool.query("DROP TRIGGER syn_cpv_audit ON audit_log; DROP FUNCTION syn_cpv_audit()"); }
  expect(await provenance(s)).toEqual([]);
  expect((await fx.pool.query("SELECT status FROM ceph_analyses WHERE id=$1", [s.id])).rows[0].status).toBe("draft");
});

it("a retry re-checks the actor's scope: after the patient leaves the doctor's list the receipt is refused", async () => {
  const s = await scenario(), seen = await observe(s), body = { expectedVersion: seen.discardVersion };
  await complete("own", s, body);
  await fx.pool.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [s.patientId]);
  await expect(complete("own", s, body)).rejects.toMatchObject({ code: "ceph_complete_not_found" });
  expect(await audits(s)).toHaveLength(1); expect(await provenance(s)).toHaveLength(1);
});

// ── Owner review 6968168056 ──
it("a retry with different or missing reviewed sources is a different request: refused, never a replay", async () => {
  const s = await scenario(), seen = await observe(s), body = { expectedVersion: seen.discardVersion, expectedSources: seen.completionSources };
  await complete("own", s, body);
  await expect(complete("own", s, { expectedVersion: seen.discardVersion })).rejects.toMatchObject({ code: "ceph_complete_conflict" });
  await expect(complete("own", s, { expectedVersion: seen.discardVersion, expectedSources: { ...seen.completionSources, imageSha256: "d".repeat(64) } })).rejects.toMatchObject({ code: "ceph_complete_conflict" });
  expect(await complete("own", s, body)).toEqual({ ok: true, studyId: s.id, status: "completed" });
  const unseen = await scenario(), seenU = await observe(unseen);
  await complete("own", unseen, { expectedVersion: seenU.discardVersion });
  await expect(complete("own", unseen, { expectedVersion: seenU.discardVersion, expectedSources: seenU.completionSources })).rejects.toMatchObject({ code: "ceph_complete_conflict" });
  expect(await audits(s)).toHaveLength(1); expect(await audits(unseen)).toHaveLength(1);
});

it.each([
  ["an added measurement row", "ceph_measurements", "ceph_witnessed_measurements_immutable", "INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,'SYN_ADDED',1)", "stored_values_differ_from_witness"],
  ["a removed retained measurement", "ceph_measurements", "ceph_witnessed_measurements_immutable", "DELETE FROM ceph_measurements WHERE analysis_id=$1 AND code=(SELECT min(code) FROM ceph_measurements WHERE analysis_id=$1)", "stored_values_differ_from_witness"],
  ["an added unknown landmark", "ceph_landmarks", "ceph_witnessed_landmarks_immutable", "INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,'SYN_EXTRA',1,1,'manual','SYN')", "landmark_reviews_differ_from_witness"],
  ["a changed review author", "ceph_landmarks", "ceph_witnessed_landmarks_immutable", "UPDATE ceph_landmarks SET confirmed_by='SYN other' WHERE analysis_id=$1 AND code='S'", "landmark_reviews_differ_from_witness"],
  ["a changed review time", "ceph_landmarks", "ceph_witnessed_landmarks_immutable", "UPDATE ceph_landmarks SET confirmed_at=confirmed_at+interval '1 second' WHERE analysis_id=$1 AND code='S'", "landmark_reviews_differ_from_witness"],
  ["a changed retained landmark", "ceph_landmarks", "ceph_witnessed_landmarks_immutable", "UPDATE ceph_landmarks SET x=x+1 WHERE analysis_id=$1 AND code='SYN_OLD_CODE'", "landmark_reviews_differ_from_witness"],
] as const)("the reader checks the full stored set: %s is detected without relying on triggers", async (_name, table, trigger, sql, reason) => {
  const s = await sealed();
  await tamper(table, trigger, sql, [s.id]);
  expect((await observe(s)).provenance).toEqual({ state: "integrity-unavailable", reason });
});

it("two concurrent completions of one draft seal exactly once", async () => {
  const s = await scenario(), seen = await observe(s), body = { expectedVersion: seen.discardVersion, expectedSources: seen.completionSources };
  const results = await Promise.allSettled([complete("own", s, body), complete("all", s, body)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "ceph_complete_conflict" } });
  expect(await provenance(s)).toHaveLength(1); expect(await audits(s)).toHaveLength(1);
});

it("a failure injected after the seal, at commit time, rolls everything back", async () => {
  const s = await scenario(), seen = await observe(s);
  await fx.pool.query(`CREATE FUNCTION syn_cpv_commit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYN commit-time failure'; END $$;
    CREATE CONSTRAINT TRIGGER syn_cpv_commit_fail AFTER INSERT ON ceph_completion_provenance DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION syn_cpv_commit_fail()`);
  try { await expect(complete("own", s, { expectedVersion: seen.discardVersion })).rejects.toThrow(); }
  finally { await fx.pool.query("DROP TRIGGER syn_cpv_commit_fail ON ceph_completion_provenance; DROP FUNCTION syn_cpv_commit_fail()"); }
  expect(await provenance(s)).toEqual([]); expect(await audits(s)).toEqual([]);
  expect((await fx.pool.query("SELECT status FROM ceph_analyses WHERE id=$1", [s.id])).rows[0].status).toBe("draft");
  expect((await fx.pool.query("SELECT count(*)::int n FROM ceph_measurements WHERE analysis_id=$1", [s.id])).rows[0].n).toBe(0);
});

it("clinic reset is refused once a sealed record exists, before any backup", async () => {
  const backup = vi.fn(async () => ({ ok: true as const, backupId: "must-not-run" }));
  await expect(db.resetClinicData({ actor: "synthetic", actorRole: "admin" }, backup)).rejects.toBeInstanceOf(ProtectedCephProvenanceHistoryError);
  expect(backup).not.toHaveBeenCalled();
});
