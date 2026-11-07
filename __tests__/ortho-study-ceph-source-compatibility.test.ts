import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "../lib/db";
import type { JourneyAuthority, JourneyOwner } from "../lib/ortho-case-journey-authority";
import type { CephCompletionWitness } from "../lib/ceph-completion-provenance";
import { captureStudyInventorySources, captureStudySources, readCurrentStudyCephProvenance, type StudyExternalSources } from "../lib/ortho-case-study-sources";
import { requireCurrentStudyRead } from "../lib/ortho-case-study-access";
import { createStudyAssessmentAccess } from "../lib/ortho-case-study-assessment-access";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import type { StudySavedContent } from "../lib/ortho-case-study-capture";
import { syntheticStudyCommand } from "./fixtures/ortho-case-study";
import { syntheticSourceBoundStudyCephCapture, syntheticWitnessedStudyCephCapture } from "./fixtures/ortho-study-ceph-witness";

// The actual provenance reader must use this transaction client. A pool read is
// never a replacement for the already locked document/analysis/case graph.
vi.mock("../lib/db", () => ({ getPool: () => { throw new Error("unexpected_pool_fallback"); } }));
const owner: JourneyOwner = { patientId: 11, orthoCaseId: 31, clinicalCaseId: 41, status: "active", planId: null, recordingContext: "current" };
const authority: JourneyAuthority = { userId: 9, name: "Synthetic", canWrite: true, canViewPlans: true, canEditPlans: true, canViewImages: true,
  session: { userId: 9, username: "synthetic-doctor", role: "doctor", expiresAt: Number.MAX_SAFE_INTEGER } };
function fixture(version: 1 | 2) {
  const payload = version === 1 ? syntheticWitnessedStudyCephCapture() : syntheticSourceBoundStudyCephCapture();
  const w: CephCompletionWitness = payload.completion.witness, s = w.snapshot, dx = s.diagnosis!;
  const row: Record<string, unknown> = { id: w.analysisId, patient_id: owner.patientId, ortho_case_id: owner.orthoCaseId,
    document_id: w.image.documentId, status: "completed", phase: payload.phase, xray_date: payload.acquisitionDate, device: payload.device,
    ref_set: s.refSet, study_kind: payload.studyKind, note: payload.note, created_at: new Date(payload.createdAt), created_by: payload.createdBy,
    completed_at: new Date(w.sealedAt), completed_by: w.actor.username, cal_x1: s.calibration!.x1, cal_y1: s.calibration!.y1,
    cal_x2: s.calibration!.x2, cal_y2: s.calibration!.y2, cal_mm: s.calibration!.mm, mm_per_pixel: s.mmPerPixel, corrects_analysis_id: null };
  const document = { id: w.image.documentId, patient_id: owner.patientId, ortho_case_id: owner.orthoCaseId as number | null, removed_at: null as Date | null,
    sha256: w.image.sha256, width: w.image.width, height: w.image.height };
  const measurementRows = w.measurements.map(({ code, value }) => ({ code, value }));
  const diagnosisRows = [{ skeletal: dx.skeletal, dental: dx.dental, soft_tissue: dx.softTissue, note: dx.note, final_dx: dx.finalDx,
    created_by: w.actor.username, created_at: new Date(w.sealedAt), updated_at: new Date(w.sealedAt) }];
  const stored = { witness: w, schema_version: w.schemaVersion, witness_sha256: payload.completion.witnessSha256,
    actor_user_id: w.actor.userId, sealed_by: w.actor.username, sealed_at: new Date(w.sealedAt), completed_by: w.actor.username,
    completed_at: new Date(w.sealedAt), status: "completed" };
  const state = { witnessed: true, scoped: true };
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes("FROM ceph_measurements")) return { rows: measurementRows };
    if (sql.includes("FROM ceph_diagnoses")) return { rows: diagnosisRows };
    if (sql.startsWith("SELECT code,x,y,source FROM ceph_landmarks")) return { rows: s.landmarks };
    if (sql.includes("FROM ceph_landmarks")) return { rows: w.landmarkReviews };
    if (sql.includes("FROM ceph_completion_provenance")) return { rows: state.witnessed ? [stored] : [] };
    if (sql.startsWith("SELECT sha256,patient_id,removed_at,width,height")) return { rows: [document] };
    if (sql.startsWith("SELECT c.* FROM ceph_analyses")) {
      const correctCase = !sql.includes("d.ortho_case_id") || document.ortho_case_id === null || document.ortho_case_id === owner.orthoCaseId;
      return { rows: state.scoped && correctCase && document.removed_at === null ? [row] : [] };
    }
    throw new Error(`Unexpected transaction query: ${sql}`);
  });
  const client = { query } as unknown as DbClient;
  const access = () => {
    const cache = createStudyAssessmentAccess();
    cache.current = Object.assign(new Map(), { historicallyReadable: new Set([`ceph_study:${w.analysisId}`, `document:${w.image.documentId}`]) });
    return cache;
  };
  const external: StudyExternalSources = { documents: new Map([[document.id, document]]), ceph: new Map([[w.analysisId, row]]), plans: new Map(), visits: new Map() };
  const content = syntheticStudyCommand().content;
  content.sources = [{ key: "ceph", kind: "ceph_study", id: w.analysisId, version: null, contentHash: journeyContentHash(payload) }];
  const capture = () => captureStudySources(client, owner, authority, content, external, createStudyAssessmentAccess());
  const inventory = () => captureStudyInventorySources(client, owner, authority, content, external, createStudyAssessmentAccess());
  const saved = (): StudySavedContent => ({ schemaVersion: 1, capturedAt: "2026-11-05T12:10:00.000Z", recordedPatientId: owner.patientId,
    orthoCaseId: owner.orthoCaseId, clinicalCaseId: owner.clinicalCaseId, caseStatusAtCapture: owner.status, authored: content,
    sources: [{ selection: content.sources[0], state: "available", unavailableReason: null, access: { images: true, plans: false }, payload }] });
  return { payload, row, document, measurementRows, diagnosisRows, stored, state, client, query, external, content, capture, inventory, saved, access };
}

describe("transaction-local saved study ceph source compatibility", () => {
  it.each([1, 2] as const)("maps valid witness%s to its exact capture representation without a current-engine lookup", async version => {
    const f = fixture(version);
    expect((await readCurrentStudyCephProvenance(f.client, 7, f.row)).provenance).toMatchObject({ state: "versioned", witness: { schemaVersion: version } });
    const [offer] = await f.inventory();
    expect(offer).toMatchObject({ state: "available", payload: f.payload, selection: { contentHash: journeyContentHash(f.payload) } });
    expect(await f.capture()).toEqual([offer]);
    expect(f.query.mock.calls.some(([sql]) => /getPool|ceph_reference_values|ceph_reference_sets/.test(sql))).toBe(false);
  });
  it.each([1, 2] as const)("retains an old pending legacy payload hash for valid witness%s without promoting its assurance", async version => {
    const f = fixture(version);
    f.state.witnessed = false;
    const [legacy] = await f.inventory();
    expect(legacy.payload).not.toHaveProperty("captureVersion");
    f.content.sources = [legacy.selection]; f.state.witnessed = true;
    expect(await f.capture()).toEqual([legacy]);
    expect((await f.inventory())[0]).toMatchObject({ payload: { captureVersion: version + 1 } });
    expect(f.content.sources[0].contentHash).toBe(legacy.selection.contentHash);
  });
  it.each([1, 2] as const)("never falls back to an old pending legacy hash when the current witness%s is corrupt", async version => {
    const f = fixture(version); f.state.witnessed = false;
    const [legacy] = await f.inventory(); f.content.sources = [legacy.selection]; f.state.witnessed = true;
    f.stored.witness_sha256 = "0".repeat(64);
    await expect(f.capture()).rejects.toMatchObject({ code: "study_ceph_source_changed" });
    expect((await f.inventory())[0]).toMatchObject({ state: "unavailable", payload: null, unavailableReason: "ceph_review_projection_unavailable" });
  });
  it("does not manufacture the old capture2 hash from a valid schema2 witness", async () => {
    const f = fixture(2); f.content.sources[0].contentHash = journeyContentHash(syntheticWitnessedStudyCephCapture());
    await expect(f.capture()).rejects.toMatchObject({ code: "study_source_version_changed" });
  });
  it.each([1, 2] as const)("uses fresh proof for saved capture of witness%s and denies revoked image access", async version => {
    const f = fixture(version), saved = f.saved();
    await expect(requireCurrentStudyRead(f.client, owner, authority, saved, f.access())).resolves.toBeUndefined();
    await expect(requireCurrentStudyRead(f.client, owner, { ...authority, canViewImages: false }, saved, f.access()))
      .rejects.toMatchObject({ code: "study_section_restricted" });
    f.state.scoped = false;
    await expect(requireCurrentStudyRead(f.client, owner, authority, saved, f.access()))
      .rejects.toMatchObject({ code: "study_ceph_source_restricted" });
  });
  it.each([1, 2] as const)("requires the locked source union for witness%s and rejects another same-patient backing-document case", async version => {
    const f = fixture(version), saved = f.saved();
    await expect(requireCurrentStudyRead(f.client, owner, authority, saved, createStudyAssessmentAccess()))
      .rejects.toMatchObject({ code: "study_ceph_source_restricted" });
    const omitted = f.access(); omitted.current!.historicallyReadable = new Set();
    await expect(requireCurrentStudyRead(f.client, owner, authority, saved, omitted))
      .rejects.toMatchObject({ code: "study_ceph_source_restricted" });
    f.document.ortho_case_id = 32;
    await expect(requireCurrentStudyRead(f.client, owner, authority, saved, f.access()))
      .rejects.toMatchObject({ code: "study_ceph_source_restricted" });
    f.document.ortho_case_id = null;
    await expect(requireCurrentStudyRead(f.client, owner, authority, saved, f.access())).resolves.toBeUndefined();
  });
  it("preserves discarded legacy historical reads without manufacturing completion assurance", async () => {
    const f = fixture(1); f.state.witnessed = false;
    const [legacy] = await f.inventory(), saved = f.saved(); saved.sources = [legacy]; saved.authored.sources = [legacy.selection];
    const before = JSON.stringify(saved); f.row.status = "discarded"; f.query.mockClear();
    await expect(requireCurrentStudyRead(f.client, owner, authority, saved, f.access())).resolves.toBeUndefined();
    expect(JSON.stringify(saved)).toBe(before);
    expect(f.query.mock.calls).toHaveLength(1);
    expect(legacy.payload).not.toHaveProperty("completion");
    f.document.removed_at = new Date();
    await expect(requireCurrentStudyRead(f.client, owner, authority, saved, f.access()))
      .rejects.toMatchObject({ code: "study_ceph_source_restricted" });
  });
  it("permits legal current ownership changes without rewriting recorded witness identity", async () => {
    const f = fixture(2), saved = f.saved(), before = JSON.stringify(saved);
    f.row.patient_id = 99; f.document.patient_id = 99;
    await expect(requireCurrentStudyRead(f.client, { ...owner, patientId: 99 }, authority, saved, f.access())).resolves.toBeUndefined();
    expect(JSON.stringify(saved)).toBe(before);
    expect(f.query.mock.calls.find(([sql]) => sql.startsWith("SELECT c.*"))?.[1]).toEqual([7, 99, 31]);
  });
  it.each(["hash", "image", "measurement", "status", "missing"] as const)("withholds schema2 source proof after current %s drift", async kind => {
    const f = fixture(2), saved = f.saved();
    if (kind === "hash") f.stored.witness_sha256 = "0".repeat(64);
    if (kind === "image") f.document.sha256 = "0".repeat(64);
    if (kind === "measurement") f.measurementRows[0].value++;
    if (kind === "status") f.row.status = "draft";
    if (kind === "missing") f.state.witnessed = false;
    await expect(requireCurrentStudyRead(f.client, owner, authority, saved, f.access()))
      .rejects.toMatchObject({ code: "study_ceph_source_restricted" });
  });
});
