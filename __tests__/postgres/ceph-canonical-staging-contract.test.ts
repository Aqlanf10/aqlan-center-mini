import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { REQUIRED_LANDMARKS } from "../../lib/ceph";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv(); vi.stubEnv("SESSION_SECRET", "synthetic-ceph-canonical-contract-secret-0123456789");
const db = await import("../../lib/db");
const reads = await import("../../lib/canonical-ceph-reads");
const projection = await import("../../lib/canonical-ceph-projection");
const complete = await import("../../lib/canonical-ceph-complete-command");
const edit = await import("../../lib/canonical-ceph-edit-command");
const discard = await import("../../lib/canonical-ceph-discard-command");
const copy = await import("../../lib/canonical-ceph-copy-command");
const create = await import("../../lib/canonical-ceph-create-command");

/**
 * The canonical (staff-cutover) ceph writers now run staging's protected writers inside the
 * admitted staff operation: the same snapshot, source identity, provenance witness, correction
 * token, lock order and audit as the legacy route. Synthetic data only.
 */
const ANALYZE = { "clinical.xrays.view": true, "clinical.ceph.analyze": true, "clinical.xrays.upload": true };
const ACCOUNTS = {
  owner: { username: "SYN-CCS-OWNER", role: "admin" },
  own: { username: "SYN-CCS-OWN", role: "doctor", doctor: true, patientScope: "own", grants: ANALYZE },
  all: { username: "SYN-CCS-ALL", role: "reception", patientScope: "all", grants: ANALYZE },
  none: { username: "SYN-CCS-NONE", role: "doctor", doctor: true, patientScope: "none", grants: ANALYZE },
  read: { username: "SYN-CCS-READ", role: "admin", patientScope: "all", grants: { "clinical.xrays.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, seq = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); }, 180000);
afterAll(async () => { await fx?.close(); });

async function draft(own = true) {
  const q = fx.pool;
  const patientId = (await q.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-CCS-${++seq}`, own ? fx.parties.own : null])).rows[0].id as number;
  const documentId = (await q.query("INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,'imaging','SYN ceph image','image/png',1,$2,$3,'SYN') RETURNING id", [patientId, "c".repeat(64), `SYN/ccs-${seq}.png`])).rows[0].id as number;
  const id = (await q.query("INSERT INTO ceph_analyses(patient_id,document_id,status,created_by,cal_x1,cal_y1,cal_x2,cal_y2,cal_mm,mm_per_pixel) VALUES($1,$2,'draft','SYN',0,0,100,0,50,0.5) RETURNING id", [patientId, documentId])).rows[0].id as number;
  for (const [i, code] of REQUIRED_LANDMARKS.entries()) await q.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,$2,$3,$4,'manual','SYN')", [id, code, 40 + (i * 37) % 400, 30 + (i * 53) % 380]);
  await q.query("INSERT INTO ceph_diagnoses(analysis_id,final_dx,created_by) VALUES($1,'SYN draft conclusion','SYN')", [id]);
  return { id, patientId, documentId };
}
type Study = Awaited<ReturnType<typeof draft>>;
const observe = async (s: Study, key: Key = "owner") => reads.readCanonicalCephStudy(await fx.session(key), s.id);
const state = async (s: Study) => (await fx.pool.query(`SELECT
  (SELECT to_jsonb(a) - 'updated_at' FROM ceph_analyses a WHERE id=$1) study,
  (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM ceph_landmarks l WHERE analysis_id=$1) landmarks,
  (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM ceph_measurements m WHERE analysis_id=$1) measurements,
  (SELECT to_jsonb(d) FROM ceph_diagnoses d WHERE analysis_id=$1) diagnosis,
  (SELECT count(*)::int FROM ceph_completion_provenance WHERE analysis_id=$1) witnesses,
  (SELECT count(*)::int FROM ceph_analyses WHERE patient_id=(SELECT patient_id FROM ceph_analyses WHERE id=$1)) studies,
  (SELECT count(*)::int FROM audit_log WHERE entity='ceph_analysis' AND entity_id=$1::text) audits`, [s.id])).rows[0];

it("completes the reviewed snapshot with staging's witness, for own, all and the owner", async () => {
  for (const key of ["own", "all", "owner"] as const) {
    const s = await draft(), feed = await observe(s, key), request = projection.cephCompletionRequestFromStudy(feed);
    expect(request).not.toBeNull();
    const result = await complete.commandCanonicalCephComplete(await fx.session(key), String(s.id), request);
    expect(result).toMatchObject({ ok: true, measurements: expect.any(Array) });
    const after = await state(s);
    expect(after.study).toMatchObject({ status: "completed", completed_by: ACCOUNTS[key].username });
    expect(after.witnesses).toBe(1);
    expect((await fx.pool.query("SELECT actor FROM audit_log WHERE action='ceph.complete' AND entity_id=$1", [String(s.id)])).rows).toEqual([{ actor: ACCOUNTS[key].username }]);
  }
});

it("refuses a stale snapshot, a changed image or reference source, out-of-scope and read-only actors without any effect", async () => {
  const cases: [string, Key, (s: Study) => Promise<void>, number | RegExp][] = [
    ["landmark moved after review", "own", async s => { await fx.pool.query("UPDATE ceph_landmarks SET x=x+1 WHERE analysis_id=$1 AND code='S'", [s.id]); }, 409],
    ["image bytes replaced after review", "own", async s => { await fx.pool.query("UPDATE patient_documents SET sha256=$2 WHERE id=$1", [s.documentId, "d".repeat(64)]); }, 409],
    ["reference value changed after review", "own", async () => { await fx.pool.query("UPDATE ceph_reference_values SET mean=mean+0.5 WHERE id=(SELECT v.id FROM ceph_reference_values v JOIN ceph_reference_sets r ON r.id=v.set_id WHERE r.key='builtin_default' ORDER BY v.id LIMIT 1)"); }, 409],
    ["no patient scope", "none", async () => undefined, /STAFF_OPERATION_RECORD_SCOPE_DENIED/],
    ["patient outside own scope", "own", async s => { await fx.pool.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [s.patientId]); }, 404],
    ["capability not granted", "read", async () => undefined, /STAFF/],
  ];
  for (const [label, key, change, outcome] of cases) {
    const s = await draft(), request = projection.cephCompletionRequestFromStudy(await observe(s));
    await change(s);
    const before = await state(s);
    const attempt = complete.commandCanonicalCephComplete(await fx.session(key), String(s.id), request);
    if (typeof outcome === "number") await expect(attempt, label).rejects.toMatchObject({ status: outcome });
    else await expect(attempt, label).rejects.toThrow(outcome);
    expect(await state(s), label).toEqual(before);
  }
  // Restore the shared synthetic reference set for later tests.
  await fx.pool.query("UPDATE ceph_reference_values SET mean=mean-0.5 WHERE id=(SELECT v.id FROM ceph_reference_values v JOIN ceph_reference_sets r ON r.id=v.set_id WHERE r.key='builtin_default' ORDER BY v.id LIMIT 1)");
});

it("an audit failure inside the writer rolls back the witness, measurements and approval together", async () => {
  const s = await draft(), request = projection.cephCompletionRequestFromStudy(await observe(s)), before = await state(s);
  await fx.pool.query(`CREATE FUNCTION syn_ccs_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ceph.complete' THEN RAISE EXCEPTION 'SYN completion audit refused'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER syn_ccs_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_ccs_audit()`);
  try {
    await expect(complete.commandCanonicalCephComplete(await fx.session("own"), String(s.id), request)).rejects.toThrow(/SYN completion audit refused/);
    expect(await state(s)).toEqual(before);
  } finally { await fx.pool.query("DROP TRIGGER syn_ccs_audit ON audit_log; DROP FUNCTION syn_ccs_audit()"); }
});

it("edits the diagnosis only against its observed prior value", async () => {
  const s = await draft(), feed = await observe(s), prior = feed.diagnosis!;
  const observed = { skeletal: prior.skeletal, dental: prior.dental, softTissue: prior.softTissue, note: prior.note, finalDx: prior.finalDx };
  const next = { skeletal: "SYN class II", dental: null, softTissue: null, note: null, finalDx: "SYN revised conclusion" };
  expect(await edit.commandCanonicalCephEdit(await fx.session("own"), String(s.id), { diagnosis: next, expectedDiagnosis: observed }))
    .toMatchObject({ ok: true, diagnosis: { finalDx: "SYN revised conclusion" } });
  const before = await state(s);
  await expect(edit.commandCanonicalCephEdit(await fx.session("own"), String(s.id), { diagnosis: { ...next, finalDx: "SYN third" }, expectedDiagnosis: observed }))
    .rejects.toMatchObject({ status: 409 });
  expect(await state(s)).toEqual(before);
  await expect(edit.commandCanonicalCephEdit(await fx.session("none"), String(s.id), { diagnosis: next, expectedDiagnosis: next })).rejects.toThrow(/STAFF_OPERATION_RECORD_SCOPE_DENIED/);
  await expect(edit.commandCanonicalCephEdit(await fx.session("own"), String(s.id), { diagnosis: next, landmarks: [] })).rejects.toMatchObject({ status: 400 });
});

it("discards a draft once, never a completed study", async () => {
  const s = await draft();
  expect(await discard.commandCanonicalCephDiscard(await fx.session("all"), String(s.id), { note: "SYN wrong image" })).toEqual({ ok: true });
  expect((await fx.pool.query("SELECT status FROM ceph_analyses WHERE id=$1", [s.id])).rows[0].status).toBe("discarded");
  await expect(discard.commandCanonicalCephDiscard(await fx.session("all"), String(s.id), {})).rejects.toMatchObject({ status: 404 });
  const done = await draft();
  await complete.commandCanonicalCephComplete(await fx.session("own"), String(done.id), projection.cephCompletionRequestFromStudy(await observe(done)));
  const before = await state(done);
  await expect(discard.commandCanonicalCephDiscard(await fx.session("all"), String(done.id), {})).rejects.toMatchObject({ status: 409 });
  expect(await state(done)).toEqual(before);
});

it("opens a correction copy only from the observed correction token", async () => {
  const s = await draft();
  await complete.commandCanonicalCephComplete(await fx.session("own"), String(s.id), projection.cephCompletionRequestFromStudy(await observe(s)));
  const feed = await observe(s);
  expect(feed.correctionSource?.state).toBe("available");
  const token = feed.correctionSource!.state === "available" ? feed.correctionSource!.token : null;
  await expect(copy.commandCanonicalCephCopy(await fx.session("own"), String(s.id), { schemaVersion: 1, expectedCorrectionSource: { ...token!, analysisId: s.id + 100000 } }))
    .rejects.toMatchObject({ status: 400 });
  const created = await copy.commandCanonicalCephCopy(await fx.session("own"), String(s.id), { schemaVersion: 1, expectedCorrectionSource: token });
  expect(created.id).toBeGreaterThan(s.id);
  expect((await fx.pool.query("SELECT status,patient_id FROM ceph_analyses WHERE id=$1", [created.id])).rows[0]).toEqual({ status: "draft", patient_id: s.patientId });
  await expect(copy.commandCanonicalCephCopy(await fx.session("none"), String(s.id), { schemaVersion: 1, expectedCorrectionSource: token })).rejects.toThrow(/STAFF_OPERATION_RECORD_SCOPE_DENIED/);
});

it("creates a draft on the patient's own image, and refuses another patient's image or scope", async () => {
  const s = await draft();
  await discard.commandCanonicalCephDiscard(await fx.session("own"), String(s.id), {});
  const created = await create.commandCanonicalCephCreate(await fx.session("own"), String(s.patientId), { documentId: s.documentId, phase: "pretreatment" });
  expect(created).toMatchObject({ id: expect.any(Number), duplicateWarning: null });
  const other = await draft();
  const before = (await fx.pool.query("SELECT count(*)::int n FROM ceph_analyses")).rows[0].n;
  await expect(create.commandCanonicalCephCreate(await fx.session("own"), String(s.patientId), { documentId: other.documentId })).rejects.toMatchObject({ status: 409 });
  await expect(create.commandCanonicalCephCreate(await fx.session("none"), String(s.patientId), { documentId: s.documentId })).rejects.toThrow(/STAFF_OPERATION_RECORD_SCOPE_DENIED/);
  expect((await fx.pool.query("SELECT count(*)::int n FROM ceph_analyses")).rows[0].n).toBe(before);
});
