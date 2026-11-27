import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrthoCase, PatientDocument } from "@/lib/db";
import { createDefaultOrthoWorkspace } from "@/lib/ortho-workspace-types";
import { buildOrthoCorePatientCase } from "@/components/ortho/orthocore/utils/caseAdapter";
import { api, setActiveOrthoCorePatientId } from "@/components/ortho/orthocore/services/api";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  access: vi.fn(),
  getCase: vi.fn(),
  setPhase: vi.fn(),
  setRetainer: vi.fn(),
  closeCase: vi.fn(),
  recordAdjustment: vi.fn(),
  linkPlan: vi.fn(),
  findUser: vi.fn(),
  getSettings: vi.fn(),
  recordDocument: vi.fn(),
  listDocs: vi.fn(),
  validateDocAssoc: vi.fn(),
  recordAudit: vi.fn(),
  poolQuery: vi.fn(),
  putFile: vi.fn(),
  storageStatus: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.access }));
vi.mock("@/lib/files", () => ({
  putFile: mocks.putFile,
  storageStatus: mocks.storageStatus,
}));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  getOrthoCase: mocks.getCase,
  setOrthoPhase: mocks.setPhase,
  setRetainer: mocks.setRetainer,
  closeOrthoCase: mocks.closeCase,
  recordAdjustment: mocks.recordAdjustment,
  linkOrthoCasePlan: mocks.linkPlan,
  findUserByUsername: mocks.findUser,
  getSettings: mocks.getSettings,
  recordDocument: mocks.recordDocument,
  listPatientDocuments: mocks.listDocs,
  validateDocumentAssociations: mocks.validateDocAssoc,
  recordAudit: mocks.recordAudit,
  DocumentAssociationError: class DocumentAssociationError extends Error {
    constructor() { super("ارتباط المستند غير صالح."); }
  },
  ensureSchema: vi.fn(async () => undefined),
  getPool: () => ({ query: mocks.poolQuery }),
}));

import { GET as getOrthoCaseRoute, PATCH as patchOrthoCaseRoute, POST as postAdjustmentRoute } from "@/app/api/ortho/[id]/route";
import { GET as getDocsRoute, POST as postDocRoute } from "@/app/api/patients/[id]/documents/route";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=",
  "base64",
);

const BASE_CASE = {
  id: 41,
  patientId: 101,
  patientName: "Synthetic Ortho Patient",
  appliance: "fixed_metal",
  arches: "both",
  slot: "022",
  status: "active",
  phase: "aligning",
  responsibleDoctorId: 7,
  adjustments: [
    {
      id: 1401,
      visitId: null,
      visitSigned: false,
      doneOn: "2026-10-01",
      phase: "aligning",
      upperWire: "014 NiTi",
      lowerWire: "014 NiTi",
      elastics: "none",
      elasticNote: null,
      done: "Synthetic tightening",
      nextWeeks: 4,
      note: null,
      recordedBy: "dr.ortho",
      photos: [{ id: 2401, patientId: 101, title: "Private photo", note: "Secret note" } as PatientDocument],
    },
  ],
} as unknown as OrthoCase;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue(true);
  mocks.getCase.mockResolvedValue(BASE_CASE);
  mocks.setPhase.mockResolvedValue(true);
  mocks.setRetainer.mockResolvedValue(true);
  mocks.closeCase.mockResolvedValue({ ok: true });
  mocks.recordAdjustment.mockResolvedValue({ ok: true, id: 1500, created: true, visitId: null, attachedToToday: false });
  mocks.getSettings.mockResolvedValue({});
  mocks.storageStatus.mockResolvedValue({ ready: true, message: null });
  mocks.putFile.mockResolvedValue("synthetic/sha256.png");
  mocks.validateDocAssoc.mockResolvedValue(undefined);
  // Default DB policy query: no custom policy row saved
  mocks.poolQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
    if (sql.includes("FROM settings")) return { rows: [] };
    return { rows: [] };
  });
});

describe("DOT Ortho Review: Fail-Closed Reception Photos, Lifecycle Permissions & Photo Metadata Persistence", () => {
  it("keeps reception photos denied when policy load fails or returns corrupt JSON (never fails open)", async () => {
    mocks.session.mockResolvedValue({
      userId: 3, username: "reception-syn", role: "reception", expiresAt: Date.now() + 60_000,
    });
    mocks.findUser.mockResolvedValue({
      id: 3, username: "reception-syn", role: "reception", isActive: true, partyId: null,
    });

    // 1. Policy query throws DB error => fail closed
    mocks.poolQuery.mockRejectedValueOnce(new Error("Synthetic DB outage"));
    const outageRes = await getOrthoCaseRoute(new Request("https://synthetic.invalid/api/ortho/41"), {
      params: Promise.resolve({ id: "41" }),
    });
    expect(outageRes.status).toBe(403);

    // 2. Policy query returns corrupt JSON => fail closed
    mocks.poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      if (sql.includes("FROM settings")) return { rows: [{ value: "{broken-json" }] };
      return { rows: [] };
    });
    const corruptRes = await getOrthoCaseRoute(new Request("https://synthetic.invalid/api/ortho/41"), {
      params: Promise.resolve({ id: "41" }),
    });
    expect(corruptRes.status).toBe(403);
  });

  it.each(["reception", "assistant", "cashier", "accountant"] as const)(
    "blocks %s from changing ortho phase, delivering retainer, or closing case before any DB write",
    async (role) => {
      mocks.session.mockResolvedValue({
        userId: 12, username: `syn-${role}`, role, expiresAt: Date.now() + 60_000,
      });
      mocks.findUser.mockResolvedValue({
        id: 12, username: `syn-${role}`, role, isActive: true, partyId: null,
      });

      for (const payload of [
        { phase: "working" },
        { retainer: "essix", retainerOn: "2026-11-10" },
        { status: "completed", note: "done" },
        { status: "discontinued", note: "stop" },
      ]) {
        const res = await patchOrthoCaseRoute(
          new Request("https://synthetic.invalid/api/ortho/41", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }),
          { params: Promise.resolve({ id: "41" }) },
        );
        expect(res.status).toBe(403);
      }

      expect(mocks.setPhase).not.toHaveBeenCalled();
      expect(mocks.setRetainer).not.toHaveBeenCalled();
      expect(mocks.closeCase).not.toHaveBeenCalled();
    },
  );

  it("allows owning doctor to change phase, deliver retainer, close case, and record tightening unchanged", async () => {
    mocks.session.mockResolvedValue({
      userId: 7, username: "dr.ortho", role: "doctor", partyId: 7, expiresAt: Date.now() + 60_000,
    });
    mocks.findUser.mockResolvedValue({
      id: 7, username: "dr.ortho", role: "doctor", isActive: true, partyId: 7,
    });

    const phaseRes = await patchOrthoCaseRoute(
      new Request("https://synthetic.invalid/api/ortho/41", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase: "working" }),
      }),
      { params: Promise.resolve({ id: "41" }) },
    );
    expect(phaseRes.status).toBe(200);
    expect(mocks.setPhase).toHaveBeenCalledWith(41, "working");

    const retainerRes = await patchOrthoCaseRoute(
      new Request("https://synthetic.invalid/api/ortho/41", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retainer: "hawley", retainerOn: "2026-11-15" }),
      }),
      { params: Promise.resolve({ id: "41" }) },
    );
    expect(retainerRes.status).toBe(200);
    expect(mocks.setRetainer).toHaveBeenCalledWith({
      id: 41, retainer: "hawley", deliveredOn: "2026-11-15", preserveExistingDeliveryDate: false,
    });

    const closeRes = await patchOrthoCaseRoute(
      new Request("https://synthetic.invalid/api/ortho/41", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed", note: "Debond complete" }),
      }),
      { params: Promise.resolve({ id: "41" }) },
    );
    expect(closeRes.status).toBe(200);
    expect(mocks.closeCase).toHaveBeenCalledWith({
      id: 41, status: "completed", actor: "dr.ortho", note: "Debond complete",
    });

    // Tightening POST path remains intact
    const adjRes = await postAdjustmentRoute(
      new Request("https://synthetic.invalid/api/ortho/41", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doneOn: "2026-11-15", upperWire: "019x025 SS", lowerWire: "017x025 NiTi", nextWeeks: 4 }),
      }),
      { params: Promise.resolve({ id: "41" }) },
    );
    expect(adjRes.status).toBe(201);
  });

  it("persists chosen capture date, stage, and view on upload and restores them after reopening the case", async () => {
    mocks.session.mockResolvedValue({
      userId: 7, username: "dr.ortho", role: "doctor", partyId: 7, expiresAt: Date.now() + 60_000,
    });
    mocks.findUser.mockResolvedValue({
      id: 7, username: "dr.ortho", role: "doctor", isActive: true, partyId: 7,
    });

    let storedDoc: PatientDocument | null = null;
    mocks.recordDocument.mockImplementation(async (input: Record<string, unknown>) => {
      storedDoc = {
        id: 8801,
        patientId: Number(input.patientId),
        visitId: null,
        kind: String(input.kind),
        title: String(input.title),
        mimeType: String(input.mimeType),
        sizeBytes: Number(input.sizeBytes),
        isImage: true,
        note: (input.note as string | null) ?? null,
        takenOn: (input.takenOn as string | null) ?? null,
        uploadedBy: String(input.uploadedBy),
        uploadedAt: "2026-11-27T18:00:00Z",
        removedAt: null,
        orthoCaseId: (input.orthoCaseId as number | null) ?? null,
        adjustmentId: null,
        photoStage: (input.photoStage as string | null) ?? null,
        photoView: (input.photoView as string | null) ?? null,
      } as unknown as PatientDocument;
      return storedDoc;
    });
    mocks.listDocs.mockImplementation(async () => (storedDoc ? [storedDoc] : []));

    // Route client upload through api.uploadFile -> real POST /api/patients/[id]/documents handler
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/patients/101/documents" && init?.method === "POST") {
        return postDocRoute(
          new Request("https://synthetic.invalid/api/patients/101/documents", {
            method: "POST",
            body: init.body as BodyInit,
          }),
          { params: Promise.resolve({ id: "101" }) },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    try {
      setActiveOrthoCorePatientId(101, 41);
      const file = new File([PNG_1X1], "profile-debond.png", { type: "image/png" });
      const uploadResult = await api.uploadFile(file, {
        title: "صورة بروفايل جانبي (T2)",
        kind: "photo",
        takenOn: "2026-04-12",
        photoStage: "T2",
        photoView: "extraoral_profile",
        note: "كاميرا العيادة",
      });

      expect(uploadResult.docId).toBe(8801);
      expect(mocks.recordDocument).toHaveBeenCalledOnce();
      expect(storedDoc).toMatchObject({
        patientId: 101,
        orthoCaseId: 41,
        takenOn: "2026-04-12",
        photoStage: "debond",
        photoView: "extraoral_profile",
      });

      // Simulate reopening the patient case from scratch (fresh workspace + GET /api/patients/101/documents)
      const docsGetRes = await getDocsRoute(
        new Request("https://synthetic.invalid/api/patients/101/documents"),
        { params: Promise.resolve({ id: "101" }) },
      );
      expect(docsGetRes.status).toBe(200);
      const { documents } = (await docsGetRes.json()) as { documents: PatientDocument[] };
      expect(documents).toHaveLength(1);

      const reopenedCase = buildOrthoCorePatientCase({
        patientId: 101,
        patientName: "Synthetic Ortho Patient",
        patientCode: "P-07001",
        record: createDefaultOrthoWorkspace(101),
        liveDocs: documents,
        liveCase: { id: 41, status: "active" },
        canViewPhotos: true,
      });

      expect(reopenedCase.media).toHaveLength(1);
      expect(reopenedCase.media[0]).toMatchObject({
        id: "doc-8801",
        captureDate: "2026-04-12",
        stage: "T2",
        viewType: "extraoral_profile",
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
