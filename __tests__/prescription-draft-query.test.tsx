import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const state = vi.hoisted(() => ({ role: "doctor", allowed: true, patientAccess: true, recordPatient: 123, status: "active", exists: true }));
vi.mock("@/lib/prescription-print-access", () => ({ canPrintSavedPrescription: async () => state.allowed }));
vi.mock("@/lib/db", () => ({
  getPatient: vi.fn(async () => ({ fullName: "Synthetic Patient", patientNumber: "TEST", birthYear: 2000, gender: "male" })),
  getPrescription: vi.fn(async () => state.exists ? ({
    id: 42, patientId: state.recordPatient, status: state.status, voidReason: "synthetic reason",
    items: [{ name: "Saved Medicine", dose: "0.2%", selection: { amount: "10 mL" }, frequency: "twice daily" }],
    createdAt: "2026-11-03T12:00:00Z", instructionsLang: "both", diagnosis: "Saved diagnosis",
    notes: "Saved notes", prescribingDoctorName: "Saved Doctor",
  }) : null),
  getPrescriptionPrintSettings: vi.fn(async () => ({})),
}));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: async () => state.patientAccess }));
vi.mock("@/lib/patient", () => ({ ageFromBirthYear: () => 26, ageText: () => "26", GENDER_LABEL: { male: "male" } }));
vi.mock("@/lib/reminders", () => ({ friendlyDateLong: (x: string) => x }));
vi.mock("@/components/PrintHeader", () => ({ PrintHeader: () => null, PrintFooter: () => null }));
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ role: state.role, username: "synthetic" }) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
import { getPatient, getPrescription } from "@/lib/db";
import PrescriptionPrintPage from "../app/print/prescription/[id]/page";
const page = (q: Record<string, string | string[] | undefined>, id = "123") =>
  PrescriptionPrintPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(q) });

beforeEach(() => {
  Object.assign(state, { role: "doctor", allowed: true, patientAccess: true, recordPatient: 123, status: "active", exists: true });
  vi.clearAllMocks();
});
describe("saved-only prescription print page", () => {
  it("renders the saved record and ignores unrelated historical identity/date/language metadata", async () => {
    const html = renderToStaticMarkup(await page({ rx: "42", doctorName: "FAKE DOCTOR", date: "1900-01-01", lang: "ar" }));
    for (const expected of ["Saved Doctor", "Saved Medicine", "0.2%", "10 mL", "Saved diagnosis", "Saved notes", "Rx #42"]) expect(html).toContain(expected);
    expect(html).not.toContain("FAKE DOCTOR");
    expect(html).not.toContain("1900-01-01");
  });
  it.each(["draft", "items", "diagnosis", "notes"])("rejects legacy %s alone and with a valid rx without reflecting content", async (key) => {
    for (const q of [{ [key]: "PRIVATE_SENTINEL" }, { rx: "42", [key]: "PRIVATE_SENTINEL" }, { rx: "42", [key]: "" }]) {
      await expect(page(q)).rejects.toThrow("NOT_FOUND");
    }
    expect(getPatient).not.toHaveBeenCalled();
    expect(getPrescription).not.toHaveBeenCalled();
  });
  it.each(["doctor", "admin", "reception"])("rejects legacy draft/items for role %s", async role => {
    state.role = role;
    await expect(page({ draft: "1", items: "PRIVATE_SENTINEL" })).rejects.toThrow("NOT_FOUND");
    await expect(page({ rx: "42", draft: "1", items: "PRIVATE_SENTINEL" })).rejects.toThrow("NOT_FOUND");
    expect(getPatient).not.toHaveBeenCalled();
    expect(getPrescription).not.toHaveBeenCalled();
  });
  it.each([{}, { rx: "" }, { rx: ["42", "43"] }, { rx: "1e2" }, { rx: "0" }, { rx: "9007199254740992" }])("rejects invalid saved ID %j", async q => {
    await expect(page(q)).rejects.toThrow("NOT_FOUND");
    expect(getPrescription).not.toHaveBeenCalled();
  });
  it("requires role and patient scope and matches the record to its patient", async () => {
    state.allowed = false;
    await expect(page({ rx: "42" })).rejects.toThrow("NOT_FOUND");
    state.allowed = true;
    state.patientAccess = false;
    await expect(page({ rx: "42" })).rejects.toThrow("NOT_FOUND");
    state.patientAccess = true;
    state.recordPatient = 999;
    await expect(page({ rx: "42" })).rejects.toThrow("NOT_FOUND");
  });
  it("allows reception active records but denies void records, preserving clinical void display", async () => {
    state.role = "reception";
    expect(renderToStaticMarkup(await page({ rx: "42" }))).toContain("Saved Medicine");
    state.status = "void";
    await expect(page({ rx: "42" })).rejects.toThrow("NOT_FOUND");
    state.role = "doctor";
    expect(renderToStaticMarkup(await page({ rx: "42" }))).toContain("VOIDED");
  });
  it("rejects a nonexistent stored record", async () => {
    state.exists = false;
    await expect(page({ rx: "42" })).rejects.toThrow("NOT_FOUND");
  });
});
