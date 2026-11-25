import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTighteningPhotoNote,
  computeAnatomicalSafeCropRect,
  DEFAULT_SAFE_PHOTO_EDITS,
  isNonDestructiveEditChanged,
  parseTighteningPhotoMeta,
  pendingPhotosForRetry,
  type RetryableSessionPhoto,
} from "@/lib/ortho-tightening-media";

describe("ortho tightening media pure logic (Package 2)", () => {
  it("preserves exact anatomical aspect ratio during rotation and crop without distortion", () => {
    const geom = computeAnatomicalSafeCropRect(1600, 1200, {
      rotationDeg: 90,
      crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      brightness: 112,
      contrast: 105,
    });
    // 90° rotation swaps width & height: 1200x1600
    expect(geom.rotatedWidth).toBe(1200);
    expect(geom.rotatedHeight).toBe(1600);
    expect(geom.sx).toBe(120);
    expect(geom.sy).toBe(160);
    expect(geom.sw).toBe(960);
    expect(geom.sh).toBe(1280);
    // Clamped lighting values
    expect(geom.brightness).toBe(112);
    expect(geom.contrast).toBe(105);
  });

  it("detects when non-destructive edits require creating a derived copy alongside the original", () => {
    expect(isNonDestructiveEditChanged(DEFAULT_SAFE_PHOTO_EDITS)).toBe(false);
    expect(
      isNonDestructiveEditChanged({ ...DEFAULT_SAFE_PHOTO_EDITS, rotationDeg: 90 }),
    ).toBe(true);
    expect(
      isNonDestructiveEditChanged({ ...DEFAULT_SAFE_PHOTO_EDITS, brightness: 115 }),
    ).toBe(true);
  });

  it("formats and round-trips before/after timing, derived badge, and independent note within 300 chars", () => {
    const note = buildTighteningPhotoNote({
      timing: "after",
      isDerived: true,
      derivedFromDocId: 405,
      note: "إغلاق الفراغ الأمامي بعد وضع سلسلة مطاطية",
    });
    expect(note.length).toBeLessThanOrEqual(300);
    const parsed = parseTighteningPhotoMeta(note);
    expect(parsed.timing).toBe("after");
    expect(parsed.isDerived).toBe(true);
    expect(parsed.cleanNote).toBe("إغلاق الفراغ الأمامي بعد وضع سلسلة مطاطية");
  });

  it("retains only failed/pending photos for network retry so uploaded photos are never duplicated", () => {
    const items = [
      { localId: "1", status: "uploaded" },
      { localId: "2", status: "failed" },
      { localId: "3", status: "queued" },
    ] as RetryableSessionPhoto[];
    const pending = pendingPhotosForRetry(items);
    expect(pending.map((p) => p.localId)).toEqual(["2", "3"]);
  });
});

// Server idempotent deduplication test for adjustment photo retries
const duplicateRow = {
  id: 777,
  patient_id: 101,
  kind: "photo",
  title: "صورة جلسة",
  mime_type: "image/png",
  size_bytes: 24,
  note: "[بعد الإجراء] ملاحظة",
  taken_on: "2026-11-25",
  uploaded_by: "dr-ali",
  uploaded_at: "2026-11-25T10:00:00Z",
  ortho_case_id: 11,
  adjustment_id: 1011,
  photo_stage: "progress",
  photo_view: "intraoral_frontal",
};

vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/files", () => ({
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
      if (sql.includes("FROM settings WHERE key = $1")) return { rows: [] };
      if (sql.includes("FROM patient_documents") && sql.includes("adjustment_id = $2")) {
        return { rows: [duplicateRow] };
      }
      return { rows: [] };
    }),
  })),
  findUserByUsername: vi.fn(),
  doctorOwnsPatient: vi.fn(async () => true),
  patientHasVisitToday: vi.fn(async () => true),
  validateDocumentAssociations: vi.fn(async () => undefined),
  recordDocument: vi.fn(),
  recordAudit: vi.fn(async () => undefined),
  getSettings: vi.fn(async () => ({ "documents.max_megabytes": "20" })),
  listPatientDocuments: vi.fn(async () => []),
}));

import { POST as uploadDoc } from "@/app/api/patients/[id]/documents/route";
import { requireSession } from "@/lib/session";
import { findUserByUsername, recordDocument } from "@/lib/db";
import { putFile, storageStatus } from "@/lib/files";

const VALID_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

describe("idempotent tightening photo retry on POST /api/patients/[id]/documents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireSession).mockResolvedValue({
      userId: 1,
      username: "owner",
      role: "admin",
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(findUserByUsername).mockResolvedValue({
      id: 1,
      username: "owner",
      role: "admin",
      isActive: true,
      partyId: null,
      permissions: null,
    } as never);
    vi.mocked(storageStatus).mockResolvedValue({ ready: true, message: null } as never);
    vi.mocked(putFile).mockResolvedValue({ key: "k-same", sha256: "same-hash", sizeBytes: VALID_PNG.length, deduplicated: true });
  });

  it("returns existing document (200, existing=true) without creating duplicate row on retry", async () => {
    const fd = new FormData();
    fd.append("file", new File([VALID_PNG], "retry.png", { type: "image/png" }));
    fd.append("kind", "photo");
    fd.append("title", "صورة جلسة");
    fd.append("orthoCaseId", "11");
    fd.append("adjustmentId", "1011");
    fd.append("photoStage", "progress");
    fd.append("photoView", "intraoral_frontal");

    const res = await uploadDoc(
      new Request("https://synthetic.invalid/api/patients/101/documents", { method: "POST", body: fd }),
      { params: Promise.resolve({ id: "101" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(777);
    expect(body.existing).toBe(true);
    expect(recordDocument).not.toHaveBeenCalled();
  });
});
