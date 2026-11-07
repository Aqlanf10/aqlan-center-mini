import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ session: vi.fn(), allowed: vi.fn(), access: vi.fn(), rx: vi.fn(), print: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: m.session }));
vi.mock("@/lib/prescription-print-access", () => ({ canPrintSavedPrescription: m.allowed }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: m.access }));
vi.mock("@/lib/db", () => ({ getPrescription: m.rx, recordPrint: m.print, recordAudit: m.audit }));
import { POST } from "../app/api/print-log/route";
const actor = { role: "reception", username: "synthetic-reprinter", userId: 3 };
const saved = { id: 81, patientId: 7, status: "active", prescribingDoctorName: "Original Doctor" };
const log = (body: object = { docType: "prescription", docId: 81, patientId: 7 }) => POST(new Request("http://localhost/api/print-log", { method: "POST", body: JSON.stringify(body) }));
beforeEach(() => {
  vi.resetAllMocks(); m.session.mockResolvedValue(actor); m.allowed.mockResolvedValue(true);
  m.access.mockResolvedValue(true); m.rx.mockResolvedValue(saved); m.print.mockResolvedValue(0);
});
it("requires an authenticated and authorized printing actor", async () => {
  m.session.mockResolvedValue(null); expect((await log()).status).toBe(401);
  m.session.mockResolvedValue(actor); m.allowed.mockResolvedValue(false); expect((await log()).status).toBe(403);
  expect(m.print).not.toHaveBeenCalled();
});
it.each([{ docType: "prescription", docId: "bad", patientId: 7 }, { docType: "prescription", docId: 81 }, { docType: "prescription", docId: 81, patientId: 0 }])("rejects malformed identity %j", async body => {
  expect((await log(body)).status).toBe(400); expect(m.print).not.toHaveBeenCalled();
});
it.each([null, { ...saved, patientId: 8 }, { ...saved, status: "void" }])("rejects missing, mismatched and void records %j", async record => {
  m.rx.mockResolvedValue(record); expect((await log()).status).toBe(404); expect(m.print).not.toHaveBeenCalled();
});
it("fails closed when patient scope is denied or unavailable", async () => {
  m.access.mockResolvedValue(false); expect((await log()).status).toBe(403);
  m.access.mockRejectedValue(new Error("offline")); expect((await log()).status).toBe(403);
  expect(m.print).not.toHaveBeenCalled();
});
it("records only the printing actor without rewriting the saved clinician", async () => {
  const before = structuredClone(saved); m.print.mockResolvedValue(1);
  const response = await log(); expect(response.status).toBe(200); expect(await response.json()).toEqual({ previous: 1, reprint: true });
  expect(m.print).toHaveBeenCalledWith({ docType: "prescription", docId: "81", printedBy: actor.username });
  expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ actor: actor.username, action: "document.reprint" }));
  expect(saved).toEqual(before);
});
it("fails closed for prescription logging errors while retaining financial fallback", async () => {
  m.print.mockRejectedValue(new Error("offline")); expect((await log()).status).toBe(500);
  const receipt = await log({ docType: "receipt", docId: 81 });
  expect(receipt.status).toBe(200); expect(await receipt.json()).toEqual({ reprint: false, previous: 0 });
});
