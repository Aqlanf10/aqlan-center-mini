import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { REQUIRED_LANDMARKS } from "../../lib/ceph";

/**
 * (ORTHO-ID-2) ربط دراسة Ceph سابقة بحالة التقويم باختيار الطبيب الصريح — على PostgreSQL 18، ببيانات اصطناعية.
 *
 * الدراسة T1 التي سبقت إنشاء الحالة لا تُربط تلقائيًا بأي حالة: إنشاء الحالة لا يمسّها، والربط فعلٌ مستقل يؤكده
 * الطبيب على دراسةٍ بعينها وحالةٍ بعينها. الربط يلمس مؤشر الحالة وحده (لا قياسات ولا اعتماد ولا تاريخ)،
 * ويُدقَّق في المعاملة نفسها، ويتحمّل الضغط المزدوج والتبويبين دون تكرار أو ازدواج.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, createOrthoCase, createCephAnalysis, updateCephCalibration,
  completeCephAnalysis, linkCephStudyToCase,
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
  [`SYN-LINK-${++fixture}`, `Synthetic ${label}`]))[0].id;

async function study(patientId: number, over: {
  phase: "pretreatment" | "during" | "posttreatment" | "followup"; xrayDate: string | null; approve: boolean;
}) {
  const [document] = await q<{ id: number }>(
    `INSERT INTO patient_documents (patient_id, kind, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
     VALUES ($1, 'imaging', 'Synthetic image', 'image/jpeg', 1, $2, $3, 'link-test') RETURNING id`,
    [patientId, `sha-link-${fixture}-${over.phase}-${Math.random()}`, `synthetic/link-${fixture}-${over.phase}-${Math.random()}.jpg`]);
  const created = await createCephAnalysis({
    patientId, documentId: document.id, createdBy: "link-test", orthoCaseId: null, phase: over.phase, xrayDate: over.xrayDate,
  });
  if (!created.ok) throw new Error(created.message);
  if (over.approve) {
    const calibrated = await updateCephCalibration(created.id, { x1: 0, y1: 0, x2: 100, y2: 0, mm: 50 }, "link-test");
    if (!calibrated.ok) throw new Error(calibrated.message);
    for (const [index, code] of REQUIRED_LANDMARKS.entries()) {
      await q(`INSERT INTO ceph_landmarks (analysis_id, code, x, y, source, confirmed_by) VALUES ($1, $2, $3, $4, 'manual', 'link-test')`,
        [created.id, code, 40 + (index * 37) % 400, 30 + (index * 53) % 380]);
    }
    const completed = await completeCephAnalysis(created.id, "link-test");
    if (!completed.ok) throw new Error(completed.message);
  }
  return created.id;
}
const newCase = async (patientId: number) => {
  const created = await createOrthoCase({
    patientId, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null, startDate: "2026-02-01",
    plannedMonths: 18, planId: null, note: null, createdBy: "link-test",
  });
  if (!created.ok) throw new Error(created.message);
  return created.id;
};
const studyRow = async (id: number) => (await q(
  `SELECT to_jsonb(a) - 'ortho_case_id' AS rest, ortho_case_id FROM ceph_analyses a WHERE id = $1`, [id]))[0] as
  { rest: Record<string, unknown>; ortho_case_id: number | null };
const measurementsOf = async (id: number) => q(`SELECT code, value FROM ceph_measurements WHERE analysis_id = $1 ORDER BY code`, [id]);
const linkAudits = async (analysisId: number) => q(
  `SELECT actor, details FROM audit_log WHERE action = 'ceph.link' AND entity_id = $1::text`, [analysisId]);
const expected = (phase: string, xrayDate: string | null, status: string) => ({ phase, xrayDate, status });
const actor = { actor: "dr-link", actorRole: "doctor" };

describe("(ORTHO-ID-2) explicit link of an earlier study to the case", () => {
  it("creating the case never links an earlier study by itself", async () => {
    const patientId = await newPatient("no silent link");
    const older = await study(patientId, { phase: "pretreatment", xrayDate: "2025-11-20", approve: true });
    await newCase(patientId);
    expect((await studyRow(older)).ortho_case_id).toBeNull();
  });

  it("links the chosen approved T1 to the case, touching only the case pointer, with one audit row in the same transaction", async () => {
    const patientId = await newPatient("link approved T1");
    const older = await study(patientId, { phase: "pretreatment", xrayDate: "2025-11-20", approve: true });
    const decoy = await study(patientId, { phase: "pretreatment", xrayDate: "2025-10-01", approve: false });
    const caseId = await newCase(patientId);
    const before = await studyRow(older);
    const measurements = await measurementsOf(older);

    const result = await linkCephStudyToCase({
      analysisId: older, orthoCaseId: caseId, expected: expected("pretreatment", "2025-11-20", "completed"), ...actor,
    });
    expect(result).toEqual({ ok: true, changed: true });

    const after = await studyRow(older);
    expect(after.ortho_case_id).toBe(caseId);
    expect(after.rest).toEqual(before.rest); // status, completed_by/at, calibration, phase, date, device, ref_set: untouched
    expect(await measurementsOf(older)).toEqual(measurements);
    expect((await studyRow(decoy)).ortho_case_id).toBeNull(); // the other earlier study is never picked for the doctor
    const audits = await linkAudits(older);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: "dr-link", details: expect.objectContaining({ الدراسة: older, الحالة: caseId }) });
  });

  it("an unknown study date and an unapproved draft are linkable only with the same stated context", async () => {
    const patientId = await newPatient("unknown date");
    const draft = await study(patientId, { phase: "pretreatment", xrayDate: null, approve: false });
    const caseId = await newCase(patientId);
    expect(await linkCephStudyToCase({ analysisId: draft, orthoCaseId: caseId, expected: expected("pretreatment", "2025-01-01", "draft"), ...actor }))
      .toMatchObject({ ok: false, status: 409 });
    expect(await linkCephStudyToCase({ analysisId: draft, orthoCaseId: caseId, expected: expected("pretreatment", null, "draft"), ...actor }))
      .toEqual({ ok: true, changed: true });
  });

  it("refuses a stale preview: the study changed after the doctor saw it — nothing written", async () => {
    const patientId = await newPatient("stale preview");
    const older = await study(patientId, { phase: "pretreatment", xrayDate: "2025-11-20", approve: false });
    const caseId = await newCase(patientId);
    await q(`UPDATE ceph_analyses SET phase = 'followup' WHERE id = $1`, [older]);
    const result = await linkCephStudyToCase({
      analysisId: older, orthoCaseId: caseId, expected: expected("pretreatment", "2025-11-20", "draft"), ...actor,
    });
    expect(result).toMatchObject({ ok: false, status: 409, message: expect.stringMatching(/[؀-ۿ]/) });
    expect((await studyRow(older)).ortho_case_id).toBeNull();
    expect(await linkAudits(older)).toHaveLength(0);
  });

  it("refuses another patient's case and another patient's study with the same answer as a missing record", async () => {
    const mine = await newPatient("mine");
    const other = await newPatient("other");
    const mineStudy = await study(mine, { phase: "pretreatment", xrayDate: "2025-11-20", approve: false });
    const otherStudy = await study(other, { phase: "pretreatment", xrayDate: "2025-11-21", approve: false });
    const mineCase = await newCase(mine);
    const otherCase = await newCase(other);
    const ctx = expected("pretreatment", "2025-11-20", "draft");

    const crossCase = await linkCephStudyToCase({ analysisId: mineStudy, orthoCaseId: otherCase, expected: ctx, ...actor });
    const crossStudy = await linkCephStudyToCase({ analysisId: otherStudy, orthoCaseId: mineCase, expected: expected("pretreatment", "2025-11-21", "draft"), ...actor });
    const missing = await linkCephStudyToCase({ analysisId: 999_999, orthoCaseId: mineCase, expected: ctx, ...actor });
    expect(crossCase).toEqual({ ok: false, status: 404, message: expect.any(String) });
    expect(crossStudy).toEqual(crossCase);
    expect(missing).toEqual(crossCase);
    expect((await studyRow(mineStudy)).ortho_case_id).toBeNull();
    expect((await studyRow(otherStudy)).ortho_case_id).toBeNull();
  });

  it("refuses a discarded study and a closed case", async () => {
    const patientId = await newPatient("discarded and closed");
    const discarded = await study(patientId, { phase: "pretreatment", xrayDate: "2025-11-20", approve: false });
    await q(`UPDATE ceph_analyses SET status = 'discarded' WHERE id = $1`, [discarded]);
    const caseId = await newCase(patientId);
    expect(await linkCephStudyToCase({ analysisId: discarded, orthoCaseId: caseId, expected: expected("pretreatment", "2025-11-20", "discarded"), ...actor }))
      .toMatchObject({ ok: false, status: 409 });

    const live = await study(patientId, { phase: "during", xrayDate: "2026-04-01", approve: false });
    await q(`UPDATE ortho_cases SET status = 'completed', closed_at = NOW() WHERE id = $1`, [caseId]);
    expect(await linkCephStudyToCase({ analysisId: live, orthoCaseId: caseId, expected: expected("during", "2026-04-01", "draft"), ...actor }))
      .toMatchObject({ ok: false, status: 409 });
    expect((await studyRow(live)).ortho_case_id).toBeNull();
  });

  it("a study already on a case is never moved silently; repeating the same link is a replay with one audit row", async () => {
    const patientId = await newPatient("already linked");
    const older = await study(patientId, { phase: "pretreatment", xrayDate: "2025-11-20", approve: false });
    const first = await newCase(patientId);
    const ctx = expected("pretreatment", "2025-11-20", "draft");
    expect(await linkCephStudyToCase({ analysisId: older, orthoCaseId: first, expected: ctx, ...actor })).toEqual({ ok: true, changed: true });
    expect(await linkCephStudyToCase({ analysisId: older, orthoCaseId: first, expected: ctx, ...actor })).toEqual({ ok: true, changed: false });
    expect(await linkAudits(older)).toHaveLength(1);

    await q(`UPDATE ortho_cases SET status = 'completed', closed_at = NOW() WHERE id = $1`, [first]);
    const second = await newCase(patientId);
    expect(await linkCephStudyToCase({ analysisId: older, orthoCaseId: second, expected: ctx, ...actor }))
      .toMatchObject({ ok: false, status: 409, message: expect.stringMatching(/[؀-ۿ]/) });
    expect((await studyRow(older)).ortho_case_id).toBe(first);
  });

  it("double click and two tabs at once produce one change and one audit row", async () => {
    const patientId = await newPatient("double click");
    const older = await study(patientId, { phase: "pretreatment", xrayDate: "2025-11-20", approve: true });
    const caseId = await newCase(patientId);
    const ctx = expected("pretreatment", "2025-11-20", "completed");
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      linkCephStudyToCase({ analysisId: older, orthoCaseId: caseId, expected: ctx, ...actor })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.changed)).toHaveLength(1);
    expect(await linkAudits(older)).toHaveLength(1);
    expect((await studyRow(older)).ortho_case_id).toBe(caseId);
  });

  it("an audit failure rolls the link back completely", async () => {
    const patientId = await newPatient("audit failure");
    const older = await study(patientId, { phase: "pretreatment", xrayDate: "2025-11-20", approve: true });
    const caseId = await newCase(patientId);
    await q(`CREATE OR REPLACE FUNCTION ceph_link_fail_audit() RETURNS TRIGGER AS $f$
             BEGIN IF NEW.action = 'ceph.link' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $f$ LANGUAGE plpgsql`);
    await q(`CREATE TRIGGER ceph_link_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ceph_link_fail_audit()`);
    try {
      await expect(linkCephStudyToCase({
        analysisId: older, orthoCaseId: caseId, expected: expected("pretreatment", "2025-11-20", "completed"), ...actor,
      })).rejects.toThrow(/synthetic audit failure/);
    } finally {
      await q(`DROP TRIGGER ceph_link_fail_audit ON audit_log`);
      await q(`DROP FUNCTION ceph_link_fail_audit()`);
    }
    expect((await studyRow(older)).ortho_case_id).toBeNull();
    expect(await linkAudits(older)).toHaveLength(0);
    expect(await linkCephStudyToCase({
      analysisId: older, orthoCaseId: caseId, expected: expected("pretreatment", "2025-11-20", "completed"), ...actor,
    })).toEqual({ ok: true, changed: true });
  });

  it("changes no money, plan, visit, consent or case row", async () => {
    const patientId = await newPatient("no side effects");
    const older = await study(patientId, { phase: "pretreatment", xrayDate: "2025-11-20", approve: true });
    const caseId = await newCase(patientId);
    const snapshot = async () => (await q(
      `SELECT (SELECT COUNT(*)::int FROM invoices WHERE patient_id = $1) AS invoices,
              (SELECT COUNT(*)::int FROM payments WHERE patient_id = $1) AS payments,
              (SELECT COUNT(*)::int FROM treatment_plans WHERE patient_id = $1) AS plans,
              (SELECT COUNT(*)::int FROM visits WHERE patient_id = $1) AS visits,
              (SELECT COUNT(*)::int FROM clinical_cases WHERE patient_id = $1) AS cases,
              (SELECT to_jsonb(c) FROM ortho_cases c WHERE c.id = $2) AS ortho_case`, [patientId, caseId]))[0];
    const before = await snapshot();
    await linkCephStudyToCase({ analysisId: older, orthoCaseId: caseId, expected: expected("pretreatment", "2025-11-20", "completed"), ...actor });
    expect(await snapshot()).toEqual(before);
  });
});
