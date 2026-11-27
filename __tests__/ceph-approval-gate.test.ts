import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { REQUIRED_LANDMARKS } from "../lib/ceph";
import { validateOrthoCephApprovalGate } from "../lib/ortho-scientific-analyses";
import { saveOrthoWorkspaceRecord } from "../lib/ortho-workspace-store";

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const {
  completeCephAnalysis,
  createCephAnalysis,
  ensureSchema,
  getPool,
  resetPoolForTesting,
  updateCephCalibration,
  updateCephLandmarks,
} = await import("../lib/db");

describe("Charter §12 & TD-11: Cephalometric Calibration, Manual Confirmation, and 24-Landmark Clinical Approval Gate", () => {
  beforeAll(async () => {
    await ensureSchema();
  }, 60_000);

  afterAll(async () => {
    await resetPoolForTesting();
  });

  it("blocks completing a canonical ceph study when uncalibrated or when any required landmark is still AI-suggested", async () => {
    const { rows: [patient] } = await getPool().query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ('P-CEPH-GATE-1', 'مريض اختبار سيفالو') RETURNING id`,
    );
    const { rows: [doc] } = await getPool().query<{ id: number }>(
      `INSERT INTO patient_documents (patient_id, kind, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
       VALUES ($1, 'imaging', 'Lateral Ceph', 'image/png', 1024, $2, 'synthetic/ceph.png', 'dr.test')
       RETURNING id`,
      [patient.id, "c".repeat(64)],
    );

    const created = await createCephAnalysis({
      patientId: patient.id,
      documentId: doc.id,
      createdBy: "dr.test",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // 1. Uncalibrated study cannot be completed
    const uncalComplete = await completeCephAnalysis(created.id, "dr.test");
    expect(uncalComplete.ok).toBe(false);
    expect(uncalComplete.message).toContain("معايرة");

    // 2. Calibrate 30 mm across 100 px
    const cal = await updateCephCalibration(created.id, { x1: 0, y1: 0, x2: 100, y2: 0, mm: 30 }, "dr.test");
    expect(cal.ok).toBe(true);

    // 3. Submit all REQUIRED_LANDMARKS as AI-suggested => completion MUST be refused!
    const suggestedPts = REQUIRED_LANDMARKS.map((code, idx) => ({
      code,
      x: 50 + idx * 17,
      y: 60 + idx * 19,
      source: "suggested" as const,
    }));
    await updateCephLandmarks(created.id, suggestedPts, "dr.test");

    const suggestedComplete = await completeCephAnalysis(created.id, "dr.test");
    expect(suggestedComplete.ok).toBe(false);
    expect(suggestedComplete.message).toContain("مقترحة آليًا");

    // 4. Manually confirm all REQUIRED_LANDMARKS => completion succeeds!
    const manualPts = REQUIRED_LANDMARKS.map((code, idx) => ({
      code,
      x: 50 + idx * 17,
      y: 60 + idx * 19,
      source: "manual" as const,
    }));
    await updateCephLandmarks(created.id, manualPts, "dr.test");

    const approved = await completeCephAnalysis(created.id, "dr.test");
    expect(approved.ok).toBe(true);
  });

  it("enforces >= 24 calibrated manual landmarks in validateOrthoCephApprovalGate and strips forged approvals on workspace save", async () => {
    const lm20: Record<string, { x: number; y: number }> = {};
    for (let i = 1; i <= 20; i++) lm20[`L${i}`] = { x: i * 10, y: i * 10 };

    expect(
      validateOrthoCephApprovalGate({ calibrationValid: false, pixelsPerMm: null, landmarks: lm20, actorRole: "doctor" }),
    ).toMatchObject({ ok: false, reason: "uncalibrated" });

    expect(
      validateOrthoCephApprovalGate({ calibrationValid: true, pixelsPerMm: 3.2, landmarks: lm20, actorRole: "doctor" }),
    ).toMatchObject({ ok: false, reason: "insufficient_landmarks", confirmedLandmarkCount: 20 });

    const lm24: Record<string, { x: number; y: number }> = { ...lm20 };
    for (let i = 21; i <= 24; i++) lm24[`L${i}`] = { x: i * 10, y: i * 10 };

    expect(
      validateOrthoCephApprovalGate({ calibrationValid: true, pixelsPerMm: 3.2, landmarks: lm24, actorRole: "doctor" }),
    ).toEqual({ ok: true, confirmedLandmarkCount: 24 });

    // Server-side workspace stripping test
    const { rows: [patient] } = await getPool().query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ('P-CEPH-GATE-2', 'مريض فحص بوابة الخادم') RETURNING id`,
    );
    const saved = await saveOrthoWorkspaceRecord(
      patient.id,
      {
        orthoCoreCase: {
          analyses: [
            {
              id: "forged-ceph",
              analysisType: "cephalometric",
              calibrationValid: false,
              landmarks: lm20,
              approvedBy: "dr.forged",
              approvedAt: "2026-11-27T00:00:00Z",
            },
          ],
        },
      },
      "dr.test",
      0,
      { actorRole: "doctor", command: "save_orthocore_draft" },
    );
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      const oc = saved.record.orthoCoreCase as { analyses: Array<Record<string, unknown>> };
      expect(oc.analyses[0].approvedAt).toBeUndefined();
      expect(oc.analyses[0].approvedBy).toBeUndefined();
    }
  });
});
