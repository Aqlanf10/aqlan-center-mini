import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  session: vi.fn(), access: vi.fn(), list: vi.fn(), lookup: vi.fn(),
  bytes: vi.fn(), storage: vi.fn(), put: vi.fn(), save: vi.fn(),
  settings: vi.fn(), association: vi.fn(), audit: vi.fn(), form: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: m.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: m.access }));
vi.mock("@/lib/db", () => ({
  DocumentAssociationError: class extends Error {},
  getSettings: m.settings, listPatientDocuments: m.list,
  recordAudit: m.audit, recordDocument: m.save, validateDocumentAssociations: m.association,
  getDocumentForDownload: m.lookup, removeDocument: vi.fn(),
}));
vi.mock("@/lib/files", () => ({
  readFileByKey: m.bytes, storageStatus: m.storage, putFile: m.put,
}));
vi.mock("@/lib/http-body", () => ({
  bodyErrorResponse: vi.fn(), readBoundedFormData: m.form, readJsonBody: vi.fn(),
}));
import { GET as list, POST as upload } from "../app/api/patients/[id]/documents/route";
import { GET as download } from "../app/api/documents/[id]/route";

const context = { params: Promise.resolve({ id: "42" }) };
const request = new Request("http://localhost/api/documents/42?download=1");
const saved = { id: 73, patientId: 42, title: "SYNTHETIC CLINICAL REPORT", sizeBytes: 15, storageKey: "synthetic-key" };

beforeEach(() => {
  vi.resetAllMocks();
  m.session.mockResolvedValue({ role: "reception", username: "synthetic" });
  m.access.mockResolvedValue(true); // Legacy broad guard cannot bypass route boundary.
  m.storage.mockResolvedValue({ ready: true });
  m.list.mockResolvedValue([saved]);
  m.lookup.mockResolvedValue({ document: { ...saved, mimeType: "application/pdf" }, storageKey: "synthetic-key" });
  m.bytes.mockResolvedValue(Buffer.from("synthetic"));
  m.settings.mockResolvedValue({});
  m.association.mockResolvedValue(undefined);
  m.audit.mockResolvedValue(undefined);
  m.put.mockResolvedValue({ sizeBytes: 15, sha256: "synthetic-digest", key: "synthetic-key" });
  m.save.mockResolvedValue(saved);
  const form = new FormData();
  form.set("file", new File(["%PDF-1.4\n%%EOF"], "synthetic.pdf", { type: "application/pdf" }));
  form.set("kind", "report");
  m.form.mockResolvedValue(form);
});

describe("clinical document transport (synthetic only)", () => {
  it.each(["reception", "assistant", "cashier", "accountant"])("denies %s list and direct download before any metadata lookup", async role => {
    m.session.mockResolvedValue({ role, username: "synthetic" });
    for (const response of [await list(request, context), await download(request, context)]) {
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(JSON.stringify(await response.json())).not.toContain(saved.title);
    }
    for (const read of [m.list, m.lookup, m.bytes, m.storage, m.access]) expect(read).not.toHaveBeenCalled();
  });
  it("retains the authorized clinician list and download, with no-store", async () => {
    m.session.mockResolvedValue({ role: "doctor", username: "synthetic" });
    const response = await list(request, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await response.json()).documents).toEqual([saved]);
    expect((await download(request, context)).status).toBe(200);
    expect(m.access).toHaveBeenCalledWith(expect.anything(), 42, "canViewXrays");
  });
  it("does not return bytes or lists to a doctor outside the patient scope", async () => {
    m.session.mockResolvedValue({ role: "doctor", username: "synthetic" });
    m.access.mockResolvedValue(false);
    expect((await list(request, context)).status).toBe(403);
    expect((await download(request, context)).status).toBe(403);
    expect(m.list).not.toHaveBeenCalled();
    expect(m.bytes).not.toHaveBeenCalled();
  });
  it.each(["reception", "doctor"])("saves a synthetic external PDF and projects the correct receipt for %s", async role => {
    m.session.mockResolvedValue({ role, username: "synthetic" });
    const response = await upload(new Request("http://localhost/api/patients/42/documents", { method: "POST" }), context);
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(role === "reception" ? { uploaded: true } : saved);
    expect(m.save).toHaveBeenCalledTimes(1);
    expect(m.access).toHaveBeenCalledWith(expect.anything(), 42, "canUploadXrays");
    expect(m.list).not.toHaveBeenCalled();
    expect(m.lookup).not.toHaveBeenCalled();
  });
});
