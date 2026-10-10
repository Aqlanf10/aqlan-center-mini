import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { REQUIRED_LANDMARKS } from "../../lib/ceph";

/**
 * (ORTHO-ID-2) «تصحيح هذه الدراسة» يحمل رابط أصله `corrects_analysis_id` — غير «إضافة دراسة متابعة» — على PostgreSQL 18.
 * الأصل المعتمد لا يتغير أبدًا؛ التصحيح مسودة بهوية الأصل؛ والرابط لا ذاتي ولا دوري ولا عابر للمرضى في القاعدة نفسها.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, createOrthoCase, createCephAnalysis, updateCephCalibration,
  completeCephAnalysis, duplicateCephAnalysis, discardCephAnalysis, listPatientCephAnalyses, getCephStudy,
} = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}
let fixture = 0;
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

const newPatient = async (label: string) => (await q<{ id: number }>(
  `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`,
  [`SYN-LIN-${++fixture}`, `Synthetic ${label}`]))[0].id;

async function approved(patientId: number, over: { phase: "pretreatment" | "during" | "posttreatment" | "followup"; orthoCaseId?: number | null; xrayDate?: string | null }) {
  const [document] = await q<{ id: number }>(
    `INSERT INTO patient_documents (patient_id, kind, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
     VALUES ($1, 'imaging', 'Synthetic image', 'image/jpeg', 1, $2, $3, 'lineage-test') RETURNING id`,
    [patientId, `sha-lin-${Math.random()}`, `synthetic/lin-${Math.random()}.jpg`]);
  const created = await createCephAnalysis({
    patientId, documentId: document.id, createdBy: "lineage-test", orthoCaseId: over.orthoCaseId ?? null,
    phase: over.phase, xrayDate: over.xrayDate ?? "2026-03-14", device: "Synthetic device", refSet: "builtin_default",
  });
  if (!created.ok) throw new Error(created.message);
  const calibrated = await updateCephCalibration(created.id, { x1: 0, y1: 0, x2: 100, y2: 0, mm: 50 }, "lineage-test");
  if (!calibrated.ok) throw new Error(calibrated.message);
  for (const [index, code] of REQUIRED_LANDMARKS.entries()) {
    await q(`INSERT INTO ceph_landmarks (analysis_id, code, x, y, source, confirmed_by) VALUES ($1, $2, $3, $4, 'manual', 'lineage-test')`,
      [created.id, code, 40 + (index * 37) % 400, 30 + (index * 53) % 380]);
  }
  const completed = await completeCephAnalysis(created.id, "lineage-test");
  if (!completed.ok) throw new Error(completed.message);
  return Number(created.id);
}
const row = async (id: number) => (await q<Record<string, unknown>>(`SELECT to_jsonb(a) - 'corrects_analysis_id' AS rest, corrects_analysis_id::int AS corrects FROM ceph_analyses a WHERE id = $1`, [id]))[0] as
  { rest: Record<string, unknown>; corrects: number | null };
const count = async (patientId: number) => (await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ceph_analyses WHERE patient_id = $1`, [patientId]))[0].n;

describe("(ORTHO-ID-2) correction keeps a structural link to its origin", () => {
  it("a correction points at its approved origin; the origin, its measurements and its history stay untouched", async () => {
    const patientId = await newPatient("correction");
    const origin = await approved(patientId, { phase: "posttreatment" });
    const before = await row(origin);
    const measurements = await q(`SELECT code, value FROM ceph_measurements WHERE analysis_id = $1 ORDER BY code`, [origin]);

    const copy = await duplicateCephAnalysis(origin, "dr-lineage");
    if (!copy.ok) throw new Error(copy.message);
    expect(copy.replayed).toBe(false);
    expect((await row(copy.id)).corrects).toBe(origin);
    expect((await row(origin))).toEqual(before);
    expect(await q(`SELECT code, value FROM ceph_measurements WHERE analysis_id = $1 ORDER BY code`, [origin])).toEqual(measurements);
    expect(await q(`SELECT 1 FROM ceph_measurements WHERE analysis_id = $1`, [copy.id])).toHaveLength(0); // measurements are re-stamped only on approval

    const listed = await listPatientCephAnalyses(patientId);
    expect(listed.find((a) => Number(a.id) === copy.id)).toMatchObject({ correctsAnalysisId: origin, correctedBy: [], phase: "posttreatment" });
    expect(listed.find((a) => Number(a.id) === origin)).toMatchObject({ correctsAnalysisId: null, correctedBy: [copy.id], status: "completed" });
    const study = await getCephStudy(origin);
    expect(study?.analysis).toMatchObject({ correctsAnalysisId: null, correctedBy: [copy.id] });
    expect((await getCephStudy(copy.id))?.analysis.correctsAnalysisId).toBe(origin);
  });

  it("a follow-up study is a new study with its own stage and date and never claims an origin", async () => {
    const patientId = await newPatient("follow-up");
    const origin = await approved(patientId, { phase: "pretreatment", xrayDate: "2025-11-20" });
    const [document] = await q<{ id: number }>(
      `INSERT INTO patient_documents (patient_id, kind, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
       VALUES ($1, 'imaging', 'Synthetic follow-up', 'image/jpeg', 1, $2, $3, 'lineage-test') RETURNING id`,
      [patientId, `sha-fu-${Math.random()}`, `synthetic/fu-${Math.random()}.jpg`]);
    const followUp = await createCephAnalysis({ patientId, documentId: document.id, createdBy: "lineage-test", phase: "followup", xrayDate: "2026-09-01" });
    if (!followUp.ok) throw new Error(followUp.message);
    expect(await row(Number(followUp.id))).toMatchObject({ corrects: null, rest: expect.objectContaining({ phase: "followup", xray_date: "2026-09-01" }) });
    expect((await row(origin)).corrects).toBeNull();
  });

  it("double click and two tabs return the same draft — one new row, one audit row", async () => {
    const patientId = await newPatient("double click");
    const origin = await approved(patientId, { phase: "during" });
    const before = await count(patientId);
    const results = await Promise.all(Array.from({ length: 4 }, () => duplicateCephAnalysis(origin, "dr-lineage")));
    const ok = results.map((r) => { if (!r.ok) throw new Error(r.message); return r; });
    expect(new Set(ok.map((r) => r.id)).size).toBe(1);
    expect(ok.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await count(patientId)).toBe(before + 1);
    expect(await q(`SELECT 1 FROM audit_log WHERE action = 'ceph.create' AND entity_id = $1::text`, [String(ok[0].id)])).toHaveLength(1);
    expect(await q(`SELECT COUNT(*)::int AS n FROM ceph_landmarks WHERE analysis_id = $1`, [ok[0].id])).toEqual([{ n: REQUIRED_LANDMARKS.length }]);
  });

  it("a different origin is refused while a correction draft is open; after discarding, the same origin may be corrected again", async () => {
    const patientId = await newPatient("two origins");
    const first = await approved(patientId, { phase: "pretreatment" });
    const second = await approved(patientId, { phase: "during" });
    const open = await duplicateCephAnalysis(first, "dr-lineage");
    if (!open.ok) throw new Error(open.message);
    expect(await duplicateCephAnalysis(second, "dr-lineage")).toEqual({ ok: false, message: expect.stringMatching(/[؀-ۿ]/) });
    expect(await discardCephAnalysis(open.id, "dr-lineage", "synthetic discard")).toEqual({ ok: true });
    const again = await duplicateCephAnalysis(first, "dr-lineage");
    if (!again.ok) throw new Error(again.message);
    expect(again.id).not.toBe(open.id);
    expect(again.replayed).toBe(false);
    const listed = await listPatientCephAnalyses(patientId);
    expect(listed.find((a) => Number(a.id) === first)?.correctedBy).toEqual([again.id]); // a discarded draft is not shown as a correction
    expect((await row(open.id)).corrects).toBe(first); // …but its lineage is kept in the row
  });

  it("only an approved study can be corrected", async () => {
    const patientId = await newPatient("draft source");
    const [document] = await q<{ id: number }>(
      `INSERT INTO patient_documents (patient_id, kind, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
       VALUES ($1, 'imaging', 'Synthetic', 'image/jpeg', 1, $2, $3, 'lineage-test') RETURNING id`,
      [patientId, `sha-d-${Math.random()}`, `synthetic/d-${Math.random()}.jpg`]);
    const draft = await createCephAnalysis({ patientId, documentId: document.id, createdBy: "lineage-test", phase: "during" });
    if (!draft.ok) throw new Error(draft.message);
    expect(await duplicateCephAnalysis(Number(draft.id), "dr-lineage")).toMatchObject({ ok: false });
    expect(await duplicateCephAnalysis(999_999, "dr-lineage")).toMatchObject({ ok: false });
  });

  it("an audit failure rolls the whole correction back: no row, no landmarks, origin untouched", async () => {
    const patientId = await newPatient("audit failure");
    const origin = await approved(patientId, { phase: "posttreatment" });
    const before = await row(origin);
    const rowsBefore = await count(patientId);
    const landmarksBefore = (await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ceph_landmarks`))[0].n;
    await q(`CREATE OR REPLACE FUNCTION ceph_lineage_fail_audit() RETURNS TRIGGER AS $f$
             BEGIN IF NEW.action = 'ceph.create' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $f$ LANGUAGE plpgsql`);
    await q(`CREATE TRIGGER ceph_lineage_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ceph_lineage_fail_audit()`);
    try {
      await expect(duplicateCephAnalysis(origin, "dr-lineage")).rejects.toThrow(/synthetic audit failure/);
    } finally {
      await q(`DROP TRIGGER ceph_lineage_fail_audit ON audit_log`);
      await q(`DROP FUNCTION ceph_lineage_fail_audit()`);
    }
    expect(await count(patientId)).toBe(rowsBefore);
    expect((await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ceph_landmarks`))[0].n).toBe(landmarksBefore);
    expect(await row(origin)).toEqual(before);
    const retry = await duplicateCephAnalysis(origin, "dr-lineage");
    expect(retry.ok).toBe(true);
  });
});

describe("(ORTHO-ID-2) the database itself refuses a self-link, a cycle and a cross-patient origin", () => {
  it("rejects each bad pointer and accepts only an older origin of the same patient", async () => {
    const mine = await newPatient("constraints mine");
    const other = await newPatient("constraints other");
    const older = await approved(mine, { phase: "pretreatment" });
    const foreign = await approved(other, { phase: "pretreatment" });
    const newer = await approved(mine, { phase: "during" });

    await expect(q(`UPDATE ceph_analyses SET corrects_analysis_id = id WHERE id = $1`, [older])).rejects.toThrow(/ceph_analyses_corrects_older_chk/);
    await expect(q(`UPDATE ceph_analyses SET corrects_analysis_id = $2 WHERE id = $1`, [older, newer])).rejects.toThrow(/ceph_analyses_corrects_older_chk/); // forward pointer = cycle risk
    await expect(q(`UPDATE ceph_analyses SET corrects_analysis_id = $2 WHERE id = $1`, [newer, foreign])).rejects.toThrow(/ceph_analyses_corrects_same_patient_fk|ceph_analyses_corrects_older_chk/);
    await expect(q(`UPDATE ceph_analyses SET corrects_analysis_id = 99999999 WHERE id = $1`, [newer])).rejects.toThrow();
    await q(`UPDATE ceph_analyses SET corrects_analysis_id = $2 WHERE id = $1`, [newer, older]);
    expect((await row(newer)).corrects).toBe(older);
  });

  it("deleting a patient with a correction chain still works (both rows go in one statement)", async () => {
    const patientId = await newPatient("purge");
    const origin = await approved(patientId, { phase: "posttreatment" });
    const copy = await duplicateCephAnalysis(origin, "dr-lineage");
    if (!copy.ok) throw new Error(copy.message);
    await q(`DELETE FROM ceph_analyses WHERE patient_id = $1`, [patientId]);
    expect(await count(patientId)).toBe(0);
  });

  it("a case-linked correction keeps its case (createOrthoCase + correction)", async () => {
    const patientId = await newPatient("case kept");
    const ortho = await createOrthoCase({
      patientId, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null, startDate: "2026-01-10",
      plannedMonths: 12, planId: null, note: null, createdBy: "lineage-test",
    });
    if (!ortho.ok) throw new Error(ortho.message);
    const origin = await approved(patientId, { phase: "during", orthoCaseId: ortho.id });
    const copy = await duplicateCephAnalysis(origin, "dr-lineage");
    if (!copy.ok) throw new Error(copy.message);
    expect((await listPatientCephAnalyses(patientId)).find((a) => Number(a.id) === copy.id)).toMatchObject({ orthoCaseId: ortho.id, correctsAnalysisId: origin });
  });
});
