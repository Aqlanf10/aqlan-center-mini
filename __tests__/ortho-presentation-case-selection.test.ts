import { NextRequest, NextResponse } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ docs: vi.fn(), download: vi.fn(), files: vi.fn(), load: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: () => ({ username: "synthetic", role: "doctor" }) }));
vi.mock("@/lib/ortho-privacy-server", () => ({
  NO_STORE_HEADERS: { "Cache-Control": "private, no-store" },
  orthoForbiddenResponse: (message: string) => NextResponse.json({ message }, { status: 403 }),
  evaluateOrthoPermission: () => ({
    allowed: true, access: { permissions: { "reports.export": true, "photos.view": true }, fields: { previousPhotos: true } },
  }),
}));
vi.mock("@/lib/ortho-workspace-store", () => ({
  loadOrthoWorkspaceRecord: m.load, filterWorkspaceByPrivacy: (filtered: unknown) => ({ filtered }),
}));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  getDocumentForDownload: m.download,
  getPatient: async () => ({ fullName: "Synthetic Patient", patientNumber: "P-11111" }),
  getSettingsSafe: async () => ({ "clinic.name": "Synthetic Clinic" }),
  listPatientDocuments: m.docs,
  listPatientOrthoCases: async () => [
    { id: 21, status: "active", adjustments: [] },
    { id: 22, status: "closed", adjustments: [{ id: 90, doneOn: "2026-11-11", photos: [{ id: 902 }] }] },
  ],
  recordAudit: vi.fn(),
}));
vi.mock("@/lib/files", () => ({ readFileByKey: m.files }));

import { POST } from "@/app/api/ortho/presentation/[patientId]/route";
import { createDefaultOrthoWorkspace } from "@/lib/ortho-workspace-types";

const context = { params: Promise.resolve({ patientId: "11" }) };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jux8AAAAASUVORK5CYII=", "base64");
const doc = (id: number, orthoCaseId: number, adjustmentId: number | null = null) => ({
  id, patientId: 11, isImage: true, removedAt: null, orthoCaseId, adjustmentId,
  photoStage: "T0", photoView: "intraoral_frontal", title: `Synthetic ${id}`, kind: "photo",
});
const documents = [doc(900,21), doc(901,22), doc(902,22,90)];
async function exportCase(input: Record<string, unknown>) {
  return POST(new NextRequest("http://test.local/api/ortho/presentation/11", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ format: "pptx", lang: "en", ...input }),
  }), context);
}
async function embeddedMedia(response: Response): Promise<string[]> {
  expect(response.status).toBe(200);
  const f = Buffer.from(await response.arrayBuffer());
  const end = f.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(0);
  let offset = f.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let i = 0; i < f.readUInt16LE(end + 10); i++) {
    expect(f.readUInt32LE(offset)).toBe(0x02014b50);
    const size = f.readUInt16LE(offset + 28);
    names.push(f.subarray(offset + 46, offset + 46 + size).toString("utf8"));
    offset += 46 + size + f.readUInt16LE(offset + 30) + f.readUInt16LE(offset + 32);
  }
  return names.filter(name => /^ppt\/media\/[^/]+$/.test(name));
}

beforeEach(() => {
  vi.clearAllMocks();
  m.docs.mockResolvedValue(documents);
  m.download.mockImplementation(async (id: number) => ({ document: documents.find(d => d.id === id), storageKey: String(id) }));
  m.files.mockResolvedValue(png);
  m.load.mockImplementation(async (patientId: number, scope: number) => {
    const ws = createDefaultOrthoWorkspace(patientId, scope);
    ws.orthoCoreCase = { media: [{ id: "selected-photo", originalUrl: "/api/documents/901", derivedUrl: "/api/documents/900" }] };
    return ws;
  });
});

it("exports no media or overlay when the doctor clears the selection", async () => {
  const result = await exportCase({ orthoCaseId: 22, selectedMediaIds: [], tracedOverlays: { ceph: `data:image/png;base64,${png.toString("base64")}` } });
  expect(await embeddedMedia(result)).toEqual([]);
  expect(m.load).toHaveBeenCalledWith(11,22);
  expect(m.docs).not.toHaveBeenCalled();
  expect(m.files).not.toHaveBeenCalled();
});

it("exports one chosen photo from the selected historical case without other session photos or derived files from another case", async () => {
  const result = await exportCase({ orthoCaseId: 22, selectedMediaIds: ["selected-photo"] });
  expect(await embeddedMedia(result)).toHaveLength(1);
  expect(m.files.mock.calls).toEqual([["901"]]);
});

it("does not substitute an active case for an unknown requested one or interpret a malformed selection as all", async () => {
  expect((await exportCase({ orthoCaseId: 999, selectedMediaIds: [] })).status).toBe(404);
  expect((await exportCase({ orthoCaseId: 22, selectedMediaIds: "all" })).status).toBe(400);
  expect(m.load).not.toHaveBeenCalled();
});

it("preserves the educational-consent decision on the selected case", async () => {
  const response = await exportCase({ orthoCaseId: 22, selectedMediaIds: [], anonymize: true });
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe("EDUCATIONAL_CONSENT_REQUIRED");
});
