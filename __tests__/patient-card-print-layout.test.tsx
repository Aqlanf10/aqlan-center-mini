import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import PostOpPrintPage from "../app/print/post-op/[id]/page";
import PatientCardPage from "../app/print/patient-card/[id]/page";
import { SETTING_DEFAULTS } from "../lib/settings";

vi.mock("@/lib/session", () => ({ requireSession: async () => ({ role: "admin" }) }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: async () => true }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  getSettingsSafe: async () => SETTING_DEFAULTS,
  getPatient: async () => ({ id: 1, patientNumber: "SYN-CARD-001", fullName: "Synthetic card patient", phone: "777000123", createdAt: "2031-01-04T09:00:00Z" }),
  patientAppointmentsFrom: async () => [{ id: 1, scheduledDate: "2031-01-04", scheduledTime: "09:30", status: "booked" }],
}));

describe("native A6 patient card keeps the original compact metadata flow", () => {
  it("retains two plain metadata lines and all card contents without a padded metadata box", async () => {
    const html = renderToStaticMarkup(await PatientCardPage({ params: Promise.resolve({ id: "1" }) }));
    expect(html).toContain('class="sheet sheet-a6 patient-card-sheet"');
    expect(html).not.toContain("print-metadata");
    for (const value of ["SYN-CARD-001", "Synthetic card patient", "777000123", "الهاتف", "تاريخ التسجيل", "04/01/2031", "9:30", "مواعيدك القادمة", "طُبعت في", "print-contact-footer", SETTING_DEFAULTS["clinic.phone"]]) expect(html).toContain(value);
    expect(html.match(/class="line"/g)).toHaveLength(3); // phone, registration, appointment
  });
});


it("isolates the existing emergency phone as LTR without changing its value", async () => {
  const html = renderToStaticMarkup(await PostOpPrintPage({ params: Promise.resolve({ id: "1" }), searchParams: Promise.resolve({}) }));
  expect(html).toContain("طوارئ واستفسارات المركز");
  expect(html).toContain(`<bdi dir="ltr">${SETTING_DEFAULTS["clinic.phone"]}</bdi>`);
  expect(html.match(new RegExp(SETTING_DEFAULTS["clinic.phone"], "g"))).toHaveLength(2);
});
