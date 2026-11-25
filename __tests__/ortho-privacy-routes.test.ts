import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDefaultOrthoPrivacyPolicy, type OrthoPrivacyPolicyDocument } from "@/lib/ortho-privacy";
import type { OrthoCase, PatientDocument } from "@/lib/db";

let activePolicy: OrthoPrivacyPolicyDocument = buildDefaultOrthoPrivacyPolicy(1);

vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/files", () => ({
  readFileByKey: vi.fn(),
  putFile: vi.fn(),
  storageStatus: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  DocumentAssociationError: class DocumentAssociationError extends Error {},
  ensureSchema: vi.fn(async () => undefined),
  getPool: vi.fn(() => ({
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM users WHERE role = 'admin'")) return { rows: [{ id: 1 }] };
      if (sql.includes("FROM settings WHERE key = $1")) return { rows: [{ value: JSON.stringify(activePolicy) }] };
      return { rows: [] };
    }),
  })),
  findUserByUsername: vi.fn(),
  doctorOwnsPatient: vi.fn(),
  patientHasVisitToday: vi.fn(),
  listOrthoCases: vi.fn(),
  listPatientOrthoCases: vi.fn(),
  getOrthoCase: vi.fn(),
  getDocumentForDownload: vi.fn(),
  listPatientDocuments: vi.fn(),
  validateDocumentAssociations: vi.fn(async () => undefined),
  recordDocument: vi.fn(),
  recordAudit: vi.fn(async () => undefined),
  getSettings: vi.fn(async () => ({ "documents.max_megabytes": "20" })),
}));

import { GET as getOrthoList } from "@/app/api/ortho/route";
import { GET as getOrthoDetail } from "@/app/api/ortho/[id]/route";
import { GET as getDocument } from "@/app/api/documents/[id]/route";
import { GET as getPatientDocs, POST as postPatientDoc } from "@/app/api/patients/[id]/documents/route";
import { GET as getMyPerms } from "@/app/api/ortho/my-permissions/route";
import { requireSession } from "@/lib/session";
import {
  doctorOwnsPatient,
  findUserByUsername,
  getDocumentForDownload,
  getOrthoCase,
  listOrthoCases,
  listPatientDocuments,
  listPatientOrthoCases,
  patientHasVisitToday,
  recordDocument,
} from "@/lib/db";
import { putFile, readFileByKey, storageStatus } from "@/lib/files";

const SAMPLE_CASE = {
  id: 11,
  patientId: 101,
  patientName: "Synthetic Ortho Patient",
  responsibleDoctorId: 7,
  adjustments: [
    {
      id: 1011,
      photos: [{ id: 2011, patientId: 101, orthoCaseId: 11, adjustmentId: 1011, photoStage: "progress", title: "Synthetic" } as PatientDocument],
    },
  ],
} as unknown as OrthoCase;

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

beforeEach(() => {
  vi.clearAllMocks();
  activePolicy = buildDefaultOrthoPrivacyPolicy(1);
  vi.mocked(listOrthoCases).mockResolvedValue([SAMPLE_CASE]);
  vi.mocked(listPatientOrthoCases).mockResolvedValue([SAMPLE_CASE]);
  vi.mocked(getOrthoCase).mockResolvedValue(SAMPLE_CASE);
  vi.mocked(doctorOwnsPatient).mockResolvedValue(true);
  vi.mocked(patientHasVisitToday).mockResolvedValue(true);
  vi.mocked(storageStatus).mockResolvedValue({ ready: true, message: null } as never);
  vi.mocked(readFileByKey).mockResolvedValue(PNG_BYTES);
  vi.mocked(putFile).mockResolvedValue({ key: "k-1", sha256: "abc", sizeBytes: PNG_BYTES.length, deduplicated: false });
  vi.mocked(recordDocument).mockResolvedValue({
    id: 3001,
    patientId: 101,
    orthoCaseId: 11,
    adjustmentId: 1011,
    photoStage: "progress",
    photoView: "intraoral_frontal",
    title: "صورة شدّة",
  } as PatientDocument);
});

describe("ortho-privacy HTTP route enforcement", () => {
  it("blocks a doctor from ortho API and direct ortho photo download when module.visible is denied", async () => {
    activePolicy = {
      ...buildDefaultOrthoPrivacyPolicy(1),
      rules: [
        {
          id: "deny-dr-10",
          effect: "deny",
          target: { userIds: [10] },
          permissions: ["module.visible"],
        },
      ],
    };

    vi.mocked(requireSession).mockResolvedValue({
      userId: 10,
      username: "dr-blocked",
      role: "doctor",
      partyId: 7,
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(findUserByUsername).mockResolvedValue({
      id: 10,
      username: "dr-blocked",
      role: "doctor",
      isActive: true,
      partyId: 7,
      permissions: { canViewXrays: true, canUploadXrays: true, canViewAllPatients: true },
    } as never);
    vi.mocked(getDocumentForDownload).mockResolvedValue({
      storageKey: "k-1",
      document: {
        id: 2011,
        patientId: 101,
        orthoCaseId: 11,
        adjustmentId: 1011,
        photoStage: "progress",
        title: "Ortho Photo",
        mimeType: "image/png",
        removedAt: null,
      } as PatientDocument,
    });

    const listRes = await getOrthoList(new Request("https://synthetic.invalid/api/ortho"));
    expect(listRes.status).toBe(403);
    expect(listRes.headers.get("cache-control")).toContain("no-store");

    const detailRes = await getOrthoDetail(new Request("https://synthetic.invalid/api/ortho/11"), {
      params: Promise.resolve({ id: "11" }),
    });
    expect(detailRes.status).toBe(403);

    const docRes = await getDocument(new Request("https://synthetic.invalid/api/documents/2011"), {
      params: Promise.resolve({ id: "2011" }),
    });
    expect(docRes.status).toBe(403);

    const permsRes = await getMyPerms(new Request("https://synthetic.invalid/api/ortho/my-permissions"));
    expect(permsRes.status).toBe(200);
    expect((await permsRes.json()).moduleVisible).toBe(false);
  });

  it("allows blind ortho photo upload for assistant while blocking viewing prior photos and direct image downloads", async () => {
    vi.mocked(requireSession).mockResolvedValue({
      userId: 11,
      username: "asst-blind",
      role: "assistant",
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(findUserByUsername).mockResolvedValue({
      id: 11,
      username: "asst-blind",
      role: "assistant",
      isActive: true,
      partyId: null,
      permissions: null,
    } as never);
    vi.mocked(getDocumentForDownload).mockResolvedValue({
      storageKey: "k-1",
      document: {
        id: 2011,
        patientId: 101,
        orthoCaseId: 11,
        adjustmentId: 1011,
        photoStage: "progress",
        title: "Prior Ortho Photo",
        mimeType: "image/png",
        removedAt: null,
      } as PatientDocument,
    });
    vi.mocked(listPatientDocuments).mockResolvedValue([
      { id: 2011, patientId: 101, orthoCaseId: 11, photoStage: "progress", title: "Prior" } as PatientDocument,
    ]);

    // Blind upload succeeds and returns blindReceipt without exposing historical data
    const fd = new FormData();
    fd.append("file", new File([PNG_BYTES], "capture.png", { type: "image/png" }));
    fd.append("kind", "photo");
    fd.append("title", "صورة شدّة");
    fd.append("orthoCaseId", "11");
    fd.append("adjustmentId", "1011");
    fd.append("photoStage", "progress");
    fd.append("photoView", "intraoral_frontal");

    const uploadRes = await postPatientDoc(
      new Request("https://synthetic.invalid/api/patients/101/documents", { method: "POST", body: fd }),
      { params: Promise.resolve({ id: "101" }) },
    );
    expect(uploadRes.status).toBe(201);
    const receipt = await uploadRes.json();
    expect(receipt.blindReceipt).toBe(true);
    expect(receipt.id).toBe(3001);

    // Direct GET of ortho list, prior documents list, and image download are ALL blocked (403)
    expect((await getOrthoList(new Request("https://synthetic.invalid/api/ortho?patientId=101"))).status).toBe(403);
    expect(
      (
        await getPatientDocs(new Request("https://synthetic.invalid/api/patients/101/documents"), {
          params: Promise.resolve({ id: "101" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await getDocument(new Request("https://synthetic.invalid/api/documents/2011"), {
          params: Promise.resolve({ id: "2011" }),
        })
      ).status,
    ).toBe(403);
  });

  it("separates photos.view from photos.download when download=1 is requested", async () => {
    activePolicy = {
      ...buildDefaultOrthoPrivacyPolicy(1),
      rules: [
        {
          id: "deny-download-dr",
          effect: "deny",
          target: { userIds: [10] },
          permissions: ["photos.download"],
        },
      ],
    };

    vi.mocked(requireSession).mockResolvedValue({
      userId: 10,
      username: "dr-view-only",
      role: "doctor",
      partyId: 7,
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(findUserByUsername).mockResolvedValue({
      id: 10,
      username: "dr-view-only",
      role: "doctor",
      isActive: true,
      partyId: 7,
      permissions: { canViewXrays: true, canViewAllPatients: true },
    } as never);
    vi.mocked(getDocumentForDownload).mockResolvedValue({
      storageKey: "k-1",
      document: {
        id: 2011,
        patientId: 101,
        orthoCaseId: 11,
        photoStage: "progress",
        title: "Ortho Photo",
        mimeType: "image/png",
        removedAt: null,
      } as PatientDocument,
    });

    const viewRes = await getDocument(new Request("https://synthetic.invalid/api/documents/2011"), {
      params: Promise.resolve({ id: "2011" }),
    });
    expect(viewRes.status).toBe(200);

    const dlRes = await getDocument(new Request("https://synthetic.invalid/api/documents/2011?download=1"), {
      params: Promise.resolve({ id: "2011" }),
    });
    expect(dlRes.status).toBe(403);
  });
});
