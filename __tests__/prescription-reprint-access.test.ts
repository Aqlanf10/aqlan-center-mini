import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDoctorPermissions } from "../lib/doctor-permissions";
const m = vi.hoisted(() => ({ session: vi.fn(), user: vi.fn(), access: vi.fn(), patient: vi.fn(), visit: vi.fn(), list: vi.fn(), rx: vi.fn(), print: vi.fn(), audit: vi.fn(), settings: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: m.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: m.access }));
vi.mock("@/lib/db", () => ({ findUserByUsername: m.user, getPatient: m.patient, getClinicalVisit: m.visit, listSavedPrescriptionPrints: m.list, getPrescription: m.rx, recordPrint: m.print, recordAudit: m.audit, getPrescriptionPrintSettings: m.settings }));
vi.mock("@/lib/prescription-prescriber", () => ({ prescriptionPrescriberOptions: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
import { GET } from "../app/api/patients/[id]/prescriptions/saved/route";
import { POST } from "../app/api/print-log/route";
import Page from "../app/print/prescription/[id]/page";
const session = { userId: 3, username: "synthetic-reception", role: "reception" };
const rx = { id: 81, patientId: 7, visitId: 9, status: "active", createdAt: "2026-10-30T10:00:00Z", prescribingDoctorName: "طبيب أصلي / Original Doctor", prescribingDoctorPartyId: 5, doctorPartyId: 5, createdBy: "original-actor", diagnosis: "private diagnosis", notes: "private notes", items: [{ name: "SyntheticRx" }], instructionsLang: "both" };
const list = (query = "") => GET(new Request(`http://localhost/api/patients/7/prescriptions/saved${query}`), { params: Promise.resolve({ id: "7" }) });
const log = (body: object = { docType: "prescription", docId: 81, patientId: 7 }) => POST(new Request("http://localhost/api/print-log", { method: "POST", body: JSON.stringify(body) }));
const page = (query: object = { rx: "81" }) => Page({ params: Promise.resolve({ id: "7" }), searchParams: Promise.resolve(query) });
beforeEach(() => {
  vi.clearAllMocks(); m.session.mockResolvedValue(session); m.user.mockResolvedValue({ ...session, id: 3, isActive: true, permissions: { canPrintSavedPrescriptions: true } });
  m.access.mockResolvedValue(true); m.patient.mockResolvedValue({ id: 7, fullName: "Synthetic", patientNumber: "S-7", birthYear: 2000, gender: "male" });
  m.visit.mockResolvedValue({ id: 9, patientId: 7 }); m.list.mockImplementation(async (_patientId: number, visitId: number | null) => visitId === null || visitId === 9 ? [{ id: rx.id, visitId: rx.visitId, createdAt: rx.createdAt, prescribingDoctorName: rx.prescribingDoctorName }] : []); m.rx.mockResolvedValue(rx); m.print.mockResolvedValue(0); m.settings.mockResolvedValue({});
});
describe("saved prescription reprint access", () => {
  it("is opt-in for reception using existing permission parsing", () => {
    expect(parseDoctorPermissions(null, "reception").canPrintSavedPrescriptions).toBe(false);
    expect(parseDoctorPermissions({ canPrintSavedPrescriptions: true }, "reception").canPrintSavedPrescriptions).toBe(true);
    expect(parseDoctorPermissions({ canPrintSavedPrescriptions: "true" }, "reception").canPrintSavedPrescriptions).toBe(false);
  });
  it("returns only active minimal metadata and filters the actual visit", async () => {
    const response = await list("?visitId=9"); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ prescriptions: [{ id: 81, visitId: 9, createdAt: rx.createdAt, prescribingDoctorName: rx.prescribingDoctorName }] });
    expect(m.access).toHaveBeenCalledWith(session, 7);
    expect(m.list).toHaveBeenCalledWith(7, 9);
    expect(await (await list("?visitId=10")).json()).toEqual({ prescriptions: [] });
  });
  it.each([false, undefined, "true"])("rejects reception without explicit true grant (%s)", async grant => {
    m.user.mockResolvedValue({ ...session, id: 3, isActive: true, permissions: { canPrintSavedPrescriptions: grant } });
    expect((await list()).status).toBe(403); expect((await log()).status).toBe(403); await expect(page()).rejects.toThrow("NOT_FOUND"); expect(m.print).not.toHaveBeenCalled();
  });
  it("fails closed on fresh account revocation", async () => { m.user.mockResolvedValue({ ...session, id: 3, isActive: false, permissions: { canPrintSavedPrescriptions: true } }); expect((await log()).status).toBe(403); });
  it("checks actual patient scope and visit ownership", async () => {
    m.access.mockResolvedValue(false); expect((await list()).status).toBe(403); expect((await log()).status).toBe(403); await expect(page()).rejects.toThrow("NOT_FOUND");
    m.access.mockResolvedValue(true); m.visit.mockResolvedValue({ patientId: 8 }); expect((await list("?visitId=9")).status).toBe(404);
  });
  it.each(["0", "-1", "bad", "1.5"])("rejects invalid visit %s", async value => { expect((await list(`?visitId=${value}`)).status).toBe(400); });
  it.each([{ docType: "prescription", docId: "bad", patientId: 7 }, { docType: "prescription", docId: 81 }, { docType: "prescription", docId: 81, patientId: 0 }])("rejects malformed log identity %j", async body => { expect((await log(body)).status).toBe(400); expect(m.print).not.toHaveBeenCalled(); });
  it.each([null, { ...rx, patientId: 8 }, { ...rx, status: "void" }])("rejects missing, mismatched or void stored Rx", async record => {
    m.rx.mockResolvedValue(record); expect((await log()).status).toBe(404); await expect(page()).rejects.toThrow("NOT_FOUND"); expect(m.print).not.toHaveBeenCalled();
  });
  it.each([{ draft: "1", items: "[]" }, {}, { rx: "81", draft: "1" }])("reception never receives a draft or query-only print", async query => { await expect(page(query)).rejects.toThrow("NOT_FOUND"); });
  it("records the printing actor without recreating or changing the prescribing snapshot", async () => {
    m.print.mockResolvedValue(1); expect((await log()).status).toBe(200);
    expect(m.print).toHaveBeenCalledWith({ docType: "prescription", docId: "81", printedBy: session.username });
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ actor: session.username, action: "document.reprint" }));
    await expect(page()).resolves.toBeTruthy(); expect(rx.prescribingDoctorName).toBe("طبيب أصلي / Original Doctor");
  });
  it("reports logging failure without successful-print response", async () => { m.print.mockRejectedValue(new Error("offline")); expect((await log()).status).toBe(500); });
});
