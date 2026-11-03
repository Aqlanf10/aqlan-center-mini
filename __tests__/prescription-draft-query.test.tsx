import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/prescription-print-access", () => ({ canPrintSavedPrescription: async () => true }));
vi.mock("@/lib/prescription-prescriber", () => ({ prescriptionPrescriberOptions: async () => ({ issuerId: 1, canChooseAnyDoctor: false, doctors: [{ id: 1, name: "Dr Test" }] }) }));
vi.mock("@/lib/db", () => ({
  getPatient: async () => ({ fullName: "Synthetic Patient", patientNumber: "SYNTHETIC", birthYear: 2000, gender: "male" }),
  getPrescription: async () => null,
  getPrescriptionPrintSettings: async () => ({}),
}));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: async () => true }));
vi.mock("@/lib/patient", () => ({ ageFromBirthYear: () => 26, ageText: () => "26", GENDER_LABEL: { male: "male" } }));
vi.mock("@/lib/reminders", () => ({ friendlyDateLong: (x: string) => x }));
vi.mock("@/components/PrintHeader", () => ({ PrintHeader: () => null, PrintFooter: () => null }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ role: "doctor", username: "synthetic" }) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));

import PrescriptionPrintPage from "../app/print/prescription/[id]/page";

async function renderDraft(dose: string, instructions: string) {
  const original = [{ name: "Chlorhexidine", dose, form: "rinse", frequency: "twice daily", duration: "7 days",
    instructions, instructionsEn: "See https://example.test/a%2Fb",
    selection: { id: "manual", amount: "10 mL", confirmed: true } }];
  const url = new URLSearchParams({ draft: "1", doctorPartyId: "1", items: JSON.stringify(original) });
  // Next's searchParams value has already undergone the one URL decoding pass.
  const searchParams = Object.fromEntries(new URLSearchParams(url.toString()));
  const node = await PrescriptionPrintPage({ params: Promise.resolve({ id: "123" }), searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(node);
}

describe("draft query decoding", () => {
  it.each(["0.2%", "0.2%20", "0.2%2F"])("preserves dose %s after one decode", async (dose) => {
    const html = await renderDraft(dose, "تعليمات عربية 0.2%");
    expect(html).toContain(dose);
    expect(html).toContain("تعليمات عربية 0.2%");
    expect(html).toContain("https://example.test/a%2Fb");
    expect(html).toContain("10 mL");
    expect(html).toContain("مسودة للمراجعة");
  });
  it("keeps review validation in force", async () => {
    const invalid = [{ name: "Chlorhexidine", dose: "0.2%", form: "rinse", frequency: "twice daily", duration: "7 days",
      selection: { id: "manual", amount: "10 mL", confirmed: false } }];
    const params = Object.fromEntries(new URLSearchParams({ draft: "1", items: JSON.stringify(invalid) }));
    await expect(PrescriptionPrintPage({ params: Promise.resolve({ id: "123" }), searchParams: Promise.resolve(params) })).rejects.toThrow("NOT_FOUND");
  });
  it("rejects invalid JSON rather than displaying a blank prescription", async () => {
    await expect(PrescriptionPrintPage({ params: Promise.resolve({ id: "123" }), searchParams: Promise.resolve({ draft: "1", items: "{" }) })).rejects.toThrow("NOT_FOUND");
  });
});
