import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_NOTE_MAX_BYTES, createConsentDocumentMetadata } from "../lib/consent-document";
const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), status: vi.fn(), settings: vi.fn(),
  put: vi.fn(), record: vi.fn(), audit: vi.fn(), associations: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.access }));
vi.mock("@/lib/files", () => ({ putFile: mocks.put, storageStatus: mocks.status }));
vi.mock("@/lib/imageSize", () => ({ imageSize: () => null }));
vi.mock("@/lib/db", () => ({ getSettings: mocks.settings, recordDocument: mocks.record, recordAudit: mocks.audit,
  listPatientDocuments: vi.fn(), validateDocumentAssociations: mocks.associations,
  DocumentAssociationError: class extends Error {} }));
import { POST } from "../app/api/patients/[id]/documents/route";
const context = { patientId: 91, visitId: null, orthoCaseId: null, adjustmentId: null, takenOn: "2026-10-03" };
function metadata() {
  const result = createConsentDocumentMetadata({ ...context, patientName: "Synthetic patient at signing", templateId: "root_canal", signatoryName: "Synthetic adult", signatoryRelation: "self", guardianRelation: null });
  if (!result.ok) throw new Error(result.message);
  return result;
}
// Synthetic one-pixel PNG, not a human signature. Real magic-byte checks stay enabled.
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jboAAAAAASUVORK5CYII=", "base64"));
function post(options: { note?: string; kind?: string; mime?: string; bytes?: Uint8Array; fields?: Record<string, string> } = {}) {
  const form = new FormData();
  form.set("file", new File([Uint8Array.from(options.bytes ?? png)], "synthetic.png", { type: options.mime ?? "image/png" }));
  form.set("kind", options.kind ?? "consent"); form.set("note", options.note ?? metadata().note);
  form.set("title", "Synthetic consent document"); form.set("takenOn", context.takenOn);
  for (const [key, value] of Object.entries(options.fields ?? {})) form.set(key, value);
  return POST(new Request("http://synthetic/api/patients/91/documents", { method: "POST", body: form }), { params: Promise.resolve({ id: "91" }) });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ username: "synthetic-uploader", role: "doctor" }); mocks.access.mockResolvedValue(true);
  mocks.status.mockResolvedValue({ ready: true }); mocks.settings.mockResolvedValue({}); mocks.associations.mockResolvedValue(undefined);
  mocks.put.mockImplementation(async (bytes: Buffer) => ({ key: "synthetic-key", sha256: "synthetic-hash", sizeBytes: bytes.length }));
  mocks.record.mockImplementation(async (value) => ({ ...value, id: 801, removedAt: null })); mocks.audit.mockResolvedValue(undefined);
});
describe("generated consent upload through canonical document route", () => {
  it("saves the entire validated snapshot and retains canonical context", async () => {
    const { note } = metadata(); const response = await post({ note });
    expect(response.status).toBe(201);
    expect((await response.json()).note).toBe(note);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ ...context, note, kind: "consent", mimeType: "image/png" }));
    expect(mocks.associations).toHaveBeenCalledWith({ patientId: 91, visitId: null, orthoCaseId: null, adjustmentId: null });
    expect(mocks.access).toHaveBeenCalledWith(expect.any(Object), 91, "canUploadXrays");
  });
  it.each(["patientId", "visitId", "orthoCaseId", "adjustmentId", "takenOn"])("rejects mismatching %s before putFile", async (key) => {
    const value = metadata().metadata;
    const note = JSON.stringify({ ...value, [key]: key === "takenOn" ? "2026-10-04" : 92 });
    expect((await post({ note })).status).toBe(400); expect(mocks.put).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
  });
  it("rejects stale displayed clauses with a review-required 409 before storage", async () => {
    const value = metadata().metadata; value.content.terms[0] = "Earlier displayed terms";
    const response = await post({ note: JSON.stringify(value) });
    expect(response.status).toBe(409); expect(mocks.put).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
  });
  it.each(["truncated", "oversized", "unknown-template", "no-content"])("rejects %s generated metadata before any storage mutation", async (reason) => {
    const value = metadata();
    const note = reason === "truncated" ? value.note.slice(0, 300) : reason === "oversized" ? "x".repeat(CONSENT_NOTE_MAX_BYTES + 1)
      : JSON.stringify({ ...value.metadata, ...(reason === "unknown-template" ? { templateId: "unknown" } : { content: null }) });
    expect((await post({ note })).status).toBe(400); expect(mocks.put).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
  });
  it("keeps generic scans and unversioned clients as originals without inventing a snapshot", async () => {
    for (const note of ["", "Ordinary scanned consent", JSON.stringify({ templateId: "root_canal", signatoryName: "x".repeat(350) })]) {
      const response = await post({ note, mime: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4 synthetic\n%%EOF") });
      expect(response.status).toBe(201); expect((await response.json()).note).toBe(note || null);
    }
  });
  it("retains the 300-character contract for other document notes", async () => {
    const response = await post({ kind: "report", note: "x".repeat(450) });
    expect(response.status).toBe(201); expect((await response.json()).note).toBe("x".repeat(300));
  });
  it("requires the generated PNG signature format, leaving scanned PDFs supported separately", async () => {
    expect((await post({ mime: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4 synthetic\n%%EOF") })).status).toBe(400);
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it("retains the content signature check and never stores spoofed PNG bytes", async () => {
    expect((await post({ bytes: new TextEncoder().encode("not an image") })).status).toBe(400);
    expect(mocks.put).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "document.upload.rejected_signature" }));
  });
  it("retains session, upload authorization, and storage readiness boundaries", async () => {
    mocks.session.mockResolvedValue(null); expect((await post()).status).toBe(401); expect(mocks.access).not.toHaveBeenCalled();
    mocks.session.mockResolvedValue({ role: "doctor", username: "synthetic" }); mocks.access.mockResolvedValue(false);
    expect((await post()).status).toBe(403); expect(mocks.status).not.toHaveBeenCalled();
    mocks.access.mockResolvedValue(true); mocks.status.mockResolvedValue({ ready: false, message: "Storage unavailable" });
    expect((await post()).status).toBe(503); expect(mocks.put).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
  });
});
