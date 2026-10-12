import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REQUIRED_LANDMARKS, type LandmarkMap } from "../../lib/ceph";
import { compareAnalyses } from "../../lib/cephCompare";
import { openPeriodontalFixture } from "./_periodontal-fixture";

let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>>;
const steiner = "STEINER_SN_GOGN_V1", downs = "DOWNS_FH_GOME_V1";
beforeAll(async () => {
  fixture = await openPeriodontalFixture(process.env, { pristine: true });
  await fixture.db.ensureSchema();
});
afterAll(async () => { await fixture?.close(); });

async function draft(precision = false) {
  const token = randomUUID();
  const patient = (await fixture.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic plane fixture') RETURNING id", [token])).rows[0];
  const document = (await fixture.pool.query(`INSERT INTO patient_documents
    (patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,width,height)
    VALUES($1,'imaging','Synthetic coordinates only','image/png',1,$2,$3,'synthetic',500,500) RETURNING id`,
  [patient.id, token, `synthetic/${token}.png`])).rows[0];
  const created = await fixture.db.createCephAnalysis({ patientId: patient.id, documentId: document.id,
    createdBy: "synthetic", phase: "pretreatment", xrayDate: null });
  if (!created.ok) throw new Error(created.message);
  expect(await fixture.db.updateCephCalibration(created.id, { x1: 0, y1: 0, x2: 100, y2: 0, mm: 50 }, "synthetic")).toMatchObject({ ok: true });
  // Owner's independent 45° / 60° fixture translated by (100,100).
  const points: LandmarkMap = { S: { x: 100, y: 100 }, N: { x: 110, y: 100 },
    Po: { x: 100, y: 80 }, Or: { x: 100 + 10 * Math.sqrt(3), y: 90 },
    Go: { x: 100, y: 110 }, Gn: precision ? { x: 101, y: 110 + Math.SQRT2 } : { x: 110, y: 120 },
    Me: { x: 100 + 10 * Math.sqrt(3), y: 100 } };
  const landmarks = [...new Set([...REQUIRED_LANDMARKS, ...Object.keys(points)])].map((code, i) => ({
    code: code as keyof LandmarkMap, ...(points[code as keyof LandmarkMap] ?? { x: 40 + i * 3, y: 40 + (i * 7) % 100 }),
  }));
  expect(await fixture.db.updateCephLandmarks(created.id, landmarks, "synthetic")).toMatchObject({ ok: true });
  return created.id;
}
const snapshot = async (id: number) => ({
  study: await fixture.db.getCephStudy(id),
  audits: (await fixture.pool.query("SELECT * FROM audit_log WHERE entity='ceph_analysis' AND entity_id=$1 ORDER BY id", [String(id)])).rows,
});

describe("versioned planes through real PostgreSQL writers and readers", () => {
  it("seals distinct 45° and 60° identities, keeps null date, and refuses editing a completed study", async () => {
    const id = await draft();
    expect(await fixture.db.completeCephAnalysis(id, "synthetic")).toMatchObject({ ok: true });
    const before = await snapshot(id);
    const rows = before.study!.measurements;
    expect(rows.find(row => row.code === steiner)?.value).toBeCloseTo(45, 10);
    expect(rows.find(row => row.code === downs)?.value).toBeCloseTo(60, 10);
    expect(rows.some(row => row.code === "SNGOGN")).toBe(false);
    expect(before.study!.analysis.xrayDate).toBeNull();
    expect(await fixture.db.updateCephLandmarks(id, [{ code: "Gn", x: 250, y: 300 }], "synthetic")).toMatchObject({ ok: false });
    expect(await fixture.db.completeCephAnalysis(id, "synthetic")).toMatchObject({ ok: false });
    expect(await snapshot(id)).toEqual(before);
    const comparison = await fixture.db.getCephAnalysisForCompare(id);
    expect(comparison!.measurements.find(row => row.code === steiner)).toMatchObject({ mean: null });
    expect((await fixture.pool.query("SELECT code FROM ceph_reference_values WHERE code=ANY($1::text[])", [[steiner, downs]])).rows).toEqual([]);
  });

  it("persists full precision, not display rounding", async () => {
    const id = await draft(true);
    const result = await fixture.db.completeCephAnalysis(id, "synthetic");
    expect(result.ok).toBe(true);
    const value = (await fixture.db.getCephStudy(id))!.measurements.find(row => row.code === steiner)!.value;
    expect(value).toBeCloseTo(54.735610317245346, 10);
    expect(value).not.toBe(54.7);
    expect((await fixture.db.getCephAnalysisForCompare(id))!.measurements.find(row => row.code === steiner)!.value).toBe(value);
  });

  it("preserves imported historic stamps; no successor or cross-method delta is invented", async () => {
    const historical = await draft(), current = await draft();
    // Synthetic import of a legacy seal: deliberately differs from the current landmarks.
    await fixture.pool.query("UPDATE ceph_analyses SET status='completed',completed_by='synthetic archive',completed_at=NOW() WHERE id=$1", [historical]);
    await fixture.pool.query("INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,'SNGOGN',31.678901234)", [historical]);
    const before = await snapshot(historical);
    expect(await fixture.db.completeCephAnalysis(current, "synthetic")).toMatchObject({ ok: true });
    const oldRead = await fixture.db.getCephAnalysisForCompare(historical), newRead = await fixture.db.getCephAnalysisForCompare(current);
    expect(oldRead!.measurements).toEqual([{ code: "SNGOGN", name: expect.any(String), unit: "°", value: 31.678901234, mean: null }]);
    expect(compareAnalyses(oldRead!.measurements, newRead!.measurements).measurements).toEqual([]);
    expect(await snapshot(historical)).toEqual(before);
    const emptySeal = await draft();
    await fixture.pool.query("UPDATE ceph_analyses SET status='completed',completed_by='synthetic archive',completed_at=NOW() WHERE id=$1", [emptySeal]);
    expect((await fixture.db.getCephAnalysisForCompare(emptySeal))!.measurements).toEqual([]);
  });
});

describe("ceph clinical writes and audit succeed or roll back together", () => {
  it("creation: rejected audit cannot leave an open draft or block the next attempt", async () => {
    const prior = await draft();
    const analysis = (await fixture.db.getCephStudy(prior))!.analysis;
    expect(await fixture.db.discardCephAnalysis(prior, "synthetic", "Free the synthetic draft slot")).toMatchObject({ ok: true });
    const create = () => fixture.db.createCephAnalysis({ patientId: analysis.patientId, documentId: analysis.documentId,
      createdBy: "synthetic", phase: "pretreatment", xrayDate: null });
    const before = await fixture.db.listPatientCephAnalyses(analysis.patientId);
    const auditBefore = (await fixture.pool.query("SELECT count(*)::int n FROM audit_log")).rows[0].n;
    await fixture.pool.query(`CREATE FUNCTION synthetic_ceph_create_reject() RETURNS TRIGGER AS $$
      BEGIN IF NEW.action='ceph.create' THEN RAISE EXCEPTION 'synthetic ceph create rejection'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await fixture.pool.query("CREATE TRIGGER synthetic_ceph_create_reject BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_ceph_create_reject()");
    try { await expect(create()).rejects.toThrow(/synthetic ceph create rejection/); }
    finally {
      await fixture.pool.query("DROP TRIGGER synthetic_ceph_create_reject ON audit_log");
      await fixture.pool.query("DROP FUNCTION synthetic_ceph_create_reject()");
    }
    expect(await fixture.db.listPatientCephAnalyses(analysis.patientId)).toEqual(before);
    expect((await fixture.pool.query("SELECT count(*)::int n FROM audit_log")).rows[0].n).toBe(auditBefore);
    expect(await create()).toMatchObject({ ok: true });
    expect((await fixture.pool.query("SELECT count(*)::int n FROM audit_log")).rows[0].n).toBe(auditBefore + 1);
  });
  const actions = [
    ["calibration", (id: number) => fixture.db.updateCephCalibration(id, { x1: 0, y1: 0, x2: 100, y2: 0, mm: 25 }, "synthetic")],
    ["landmarks", (id: number) => fixture.db.updateCephLandmarks(id, [{ code: "Gn", x: 250, y: 300 }], "synthetic")],
    ["diagnosis", (id: number) => fixture.db.updateCephDiagnosis(id, { finalDx: "Synthetic physician-authored assessment" }, "synthetic")],
    ["complete", (id: number) => fixture.db.completeCephAnalysis(id, "synthetic")],
    ["discard", (id: number) => fixture.db.discardCephAnalysis(id, "synthetic", "Synthetic refusal")],
  ] as const;
  it.each(actions)("%s: audit rejection leaves all clinical data unchanged and retry succeeds", async (_name, run) => {
    const id = await draft(), before = await snapshot(id);
    await fixture.pool.query(`CREATE FUNCTION synthetic_ceph_audit_reject() RETURNS TRIGGER AS $$
      BEGIN IF NEW.entity='ceph_analysis' THEN RAISE EXCEPTION 'synthetic ceph audit rejection'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await fixture.pool.query("CREATE TRIGGER synthetic_ceph_audit_reject BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_ceph_audit_reject()");
    try { await expect(run(id)).rejects.toThrow(/synthetic ceph audit rejection/); }
    finally {
      await fixture.pool.query("DROP TRIGGER synthetic_ceph_audit_reject ON audit_log");
      await fixture.pool.query("DROP FUNCTION synthetic_ceph_audit_reject()");
    }
    expect(await snapshot(id)).toEqual(before);
    expect(await run(id)).toMatchObject({ ok: true });
    expect((await snapshot(id)).audits).toHaveLength(before.audits.length + 1);
  });
});
