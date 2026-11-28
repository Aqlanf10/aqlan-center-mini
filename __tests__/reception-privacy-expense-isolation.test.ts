import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=",
  "base64",
);

const mocks = vi.hoisted(() => ({
  session: {
    userId: 7,
    username: "reception_demo",
    role: "reception" as string,
    expiresAt: Date.now() + 3_600_000,
  },
  envelope: { kind: "legacy" as const },
  openShift: {
    id: 42,
    status: "open",
    openedBy: "reception_demo",
    openedAt: "2026-11-27T06:00:00Z",
    opening: { YER: 50000, SAR: 0, USD: 0 },
  },
  docToDownload: {
    document: {
      id: 9,
      patientId: 2,
      title: "intraoral.png",
      mimeType: "image/png",
      removedAt: null,
      orthoCaseId: 5 as number | null,
      adjustmentId: null as number | null,
      photoStage: "pretreatment" as string | null,
    },
    storageKey: "ab/cd",
  },
  patientDocs: [
    {
      id: 9,
      patientId: 2,
      kind: "photo",
      title: "ortho-t0.png",
      mimeType: "image/png",
      sizeBytes: 68,
      isImage: true,
      orthoCaseId: 5,
      adjustmentId: null,
      photoStage: "initial",
      photoView: "extraoral_profile",
    },
    {
      id: 10,
      patientId: 2,
      kind: "consent",
      title: "إقرار موافقة رقمي",
      mimeType: "image/png",
      sizeBytes: 68,
      isImage: true,
      orthoCaseId: null,
      adjustmentId: null,
      photoStage: null,
      photoView: null,
    },
  ],
  shiftPayments: [
    {
      id: 501,
      patientId: 2,
      patientName: "Synthetic Patient",
      receiptNumber: "RC-501",
      amountMinor: 15000,
      currency: "YER",
      exchangeRate: 1,
      baseAmountMinor: 15000,
      method: "cash",
      kind: "payment",
      createdAt: "2026-11-27T07:00:00Z",
    },
  ],
}));

vi.mock("@/lib/session", () => ({
  requireSession: vi.fn(async () => mocks.session),
}));
vi.mock("@/lib/staff-session-admission", () => ({
  selectRequestStaffEnvelope: vi.fn(async () => mocks.envelope),
}));
vi.mock("@/lib/patient-access", () => ({
  canAccessPatient: vi.fn(async () => true),
}));
vi.mock("@/lib/files", () => ({
  readFileByKey: vi.fn(async () => PNG_1X1),
  putFile: vi.fn(async () => ({ key: "syn/file.png", sha256: "a".repeat(64), sizeBytes: PNG_1X1.length })),
  storageStatus: vi.fn(async () => ({ ready: true, message: null })),
}));
vi.mock("@/lib/receipt-provenance-db", () => ({
  readReceiptProvenance: vi.fn(async () => ({ 501: { status: "active" } })),
}));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    CLINIC_TIME_ZONE: "Asia/Aden",
    getOpenShift: vi.fn(async () => mocks.openShift),
    listOpeningReviews: vi.fn(async () => []),
    pendingOpeningReviewCount: vi.fn(async () => 0),
    listShiftPayments: vi.fn(async () => mocks.shiftPayments),
    listShiftExpenses: vi.fn(async () => []),
    shiftDrawerBreakdown: vi.fn(async () => ({
      cashIn: { YER: 15000, SAR: 0, USD: 0 },
      cashRefunds: { YER: 0, SAR: 0, USD: 0 },
      nonCashIn: { YER: 0, SAR: 0, USD: 0 },
      nonCashRefunds: { YER: 0, SAR: 0, USD: 0 },
      spent: { YER: 0, SAR: 0, USD: 0 },
      expected: { YER: 65000, SAR: 0, USD: 0 },
    })),
    listShiftsForViewer: vi.fn(async () => [{ id: 41, status: "closed", sealed: true, counted: null }]),
    listLabAccountingMappings: vi.fn(async () => []),
    getDocumentForDownload: vi.fn(async () => mocks.docToDownload),
    listPatientDocuments: vi.fn(async () => mocks.patientDocs),
    getSettings: vi.fn(async () => ({})),
    validateDocumentAssociations: vi.fn(async () => undefined),
    recordDocument: vi.fn(async () => ({
      id: 999,
      patientId: 2,
      title: "secret-filename.png",
      mimeType: "image/png",
      sizeBytes: PNG_1X1.length,
    })),
    recordAudit: vi.fn(async () => undefined),
  };
});

import { canAccessUnifiedReport } from "@/lib/report-access";
import { buildDefaultOrthoPrivacyPolicy, resolveOrthoAccess } from "@/lib/ortho-privacy";
import { buildOrthoCorePatientCase, buildPreviousCasesMedia } from "@/components/ortho/orthocore/utils/caseAdapter";
import { createDefaultOrthoWorkspace } from "@/lib/ortho-workspace-types";
import { GET as readShiftReconciliation } from "@/app/api/finance/reconciliation/route";
import { GET as readLabAccounting } from "@/app/api/finance/lab-accounting/route";
import DossierPage from "@/app/print/dossier/[id]/page";
import { GET as getDocumentById } from "@/app/api/documents/[id]/route";
import { GET as getPatientDocuments, POST as postPatientDocument } from "@/app/api/patients/[id]/documents/route";
import { GET as getShifts } from "@/app/api/shifts/route";

describe("DOT-approved Reception financial, clinical print, orthodontic media & shift history boundaries", () => {
  beforeEach(() => {
    mocks.session = {
      userId: 7,
      username: "reception_demo",
      role: "reception",
      expiresAt: Date.now() + 3_600_000,
    };
    mocks.envelope = { kind: "legacy" };
    mocks.docToDownload = {
      document: {
        id: 9,
        patientId: 2,
        title: "intraoral.png",
        mimeType: "image/png",
        removedAt: null,
        orthoCaseId: 5,
        adjustmentId: null,
        photoStage: "pretreatment",
      },
      storageKey: "ab/cd",
    };
  });

  it("isolates clinic financial reconciliation and laboratory accounting from Reception (#611)", async () => {
    const recRes = await readShiftReconciliation(new NextRequest("http://localhost/api/finance/reconciliation"));
    expect(recRes.status).toBe(403);

    const labRes = await readLabAccounting();
    expect(labRes.status).toBe(403);

    for (const blockedReport of [
      "daily",
      "monthly",
      "annual",
      "doctor-commission",
      "commission-detail",
      "daily-outflow",
      "expense-payees",
      "lab",
      "suppliers",
    ]) {
      expect(canAccessUnifiedReport("reception", blockedReport)).toBe(false);
    }
    expect(canAccessUnifiedReport("reception", "appointments")).toBe(true);
    expect(canAccessUnifiedReport("reception", "patient-statement")).toBe(true);
  });

  it("restricts clinical dossier print (/print/dossier/[id]) from Reception (#612)", async () => {
    await expect(DossierPage({ params: Promise.resolve({ id: "2" }) })).rejects.toThrow();
  });

  it("blocks Reception from orthodontic clinical media even under explicit allow rules, allows non-ortho consent signatures, and returns { ok: true } only on upload", async () => {
    // 1. Even an explicit allow policy rule cannot grant photos.view/download/previousPhotos to reception
    const policy = buildDefaultOrthoPrivacyPolicy(1);
    policy.rules.push({
      id: "explicit-rec-allow",
      effect: "allow",
      target: { userIds: [7], roles: ["reception"] },
      permissions: ["photos.view", "photos.download", "photos.edit"],
      sections: ["media", "photo_analysis"],
      fields: ["previousPhotos"],
    });
    const resolved = resolveOrthoAccess(policy, {
      userId: 7,
      username: "reception_demo",
      role: "reception",
      isActive: true,
      isOwner: false,
    });
    expect(resolved.permissions["photos.view"]).toBe(false);
    expect(resolved.permissions["photos.download"]).toBe(false);
    expect(resolved.permissions["photos.edit"]).toBe(false);
    expect(resolved.sections.media).toBe(false);
    expect(resolved.sections.photo_analysis).toBe(false);
    expect(resolved.fields.previousPhotos).toBe(false);

    // 2. GET /api/documents/[id] blocks orthodontic clinical media (403)
    const orthoDocRes = await getDocumentById(new Request("http://localhost/api/documents/9"), {
      params: Promise.resolve({ id: "9" }),
    });
    expect(orthoDocRes.status).toBe(403);

    // 3. GET /api/documents/[id] allows non-ortho patient consent signature documents
    mocks.docToDownload = {
      document: {
        id: 10,
        patientId: 2,
        title: "consent-signature.png",
        mimeType: "image/png",
        removedAt: null,
        orthoCaseId: null,
        adjustmentId: null,
        photoStage: null,
      },
      storageKey: "ef/gh",
    };
    const consentDocRes = await getDocumentById(new Request("http://localhost/api/documents/10"), {
      params: Promise.resolve({ id: "10" }),
    });
    expect(consentDocRes.status).toBe(200);

    // 4. GET /api/patients/[id]/documents strips ortho media for Reception while retaining consent documents
    const listRes = await getPatientDocuments(new Request("http://localhost/api/patients/2/documents"), {
      params: Promise.resolve({ id: "2" }),
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.documents.map((d: { id: number }) => d.id)).toEqual([10]);

    // 5. POST /api/patients/[id]/documents returns confirmation-only { ok: true } with zero id/filename/metadata
    const form = new FormData();
    form.set("file", new File([PNG_1X1], "secret-ortho.png", { type: "image/png" }));
    form.set("kind", "photo");
    form.set("orthoCaseId", "5");
    form.set("photoStage", "T1");
    const postRes = await postPatientDocument(
      new Request("http://localhost/api/patients/2/documents", { method: "POST", body: form }),
      { params: Promise.resolve({ id: "2" }) },
    );
    expect(postRes.status).toBe(201);
    expect(await postRes.json()).toEqual({ ok: true });
  });

  it("strictly separates orthodontic photos per case and exposes previous cases in a separate read-only archive", () => {
    const docs = [
      { id: 101, orthoCaseId: 11, kind: "photo", title: "Old Case Photo", takenOn: "2025-01-10", photoStage: "initial", photoView: "extraoral_profile", adjustmentId: null },
      { id: 102, orthoCaseId: 22, kind: "photo", title: "Current Case Photo", takenOn: "2026-10-05", photoStage: "progress", photoView: "intraoral_frontal", adjustmentId: null },
      { id: 103, orthoCaseId: null, kind: "xray", title: "Unassigned Xray", takenOn: "2026-09-01", photoStage: null, photoView: null, adjustmentId: null },
    ];
    const current = buildOrthoCorePatientCase({
      patientId: 2,
      patientName: "Synthetic Patient",
      patientCode: "P-002",
      record: createDefaultOrthoWorkspace(2, 22),
      liveDocs: docs,
      liveCase: { id: 22, status: "active", startDate: "2026-10-01" },
      canViewPhotos: true,
    });
    expect(current.media.map((m) => m.id)).toEqual(["doc-102"]);

    const archive = buildPreviousCasesMedia({
      liveDocs: docs,
      liveCases: [
        { id: 22, status: "active", startDate: "2026-10-01" },
        { id: 11, status: "completed", startDate: "2025-01-01" },
      ],
      activeCaseId: 22,
      canViewPhotos: true,
    });
    expect(archive).toHaveLength(1);
    expect(archive[0].orthoCaseId).toBe(11);
    expect(archive[0].media.map((m) => m.id)).toEqual(["doc-101"]);
  });

  it("preserves recent sealed shift history, payments, and receiptProvenance on GET /api/shifts", async () => {
    const resShift = await getShifts();
    expect(resShift.status).toBe(200);
    const body = await resShift.json();
    expect(body.recent).toEqual([{ id: 41, status: "closed", sealed: true, counted: null }]);
    expect(body.payments).toHaveLength(1);
    expect(body.receiptProvenance).toEqual({ 501: { status: "active" } });
  });
});
