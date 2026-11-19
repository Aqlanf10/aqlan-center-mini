import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** OC-1 treatment card print (contract ortho-treatment-card-followup-gaps v1.1). Synthetic data only. */
const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), orthoCase: vi.fn(), patient: vi.fn(), appointments: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.access }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  getOrthoCase: mocks.orthoCase,
  getPatient: mocks.patient,
  patientAppointmentsFrom: mocks.appointments,
  getSettingsSafe: async () => ({
    "clinic.name": "SYN مركز اصطناعي", "clinic.lead_doctor": "SYN-LEAD", "clinic.lead_doctor_title": "SYN-TITLE",
    "clinic.lead_doctor_credentials": "SYN-CRED", "clinic.address": "SYN-ADDRESS", "clinic.phone": "000-000",
  }),
}));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));
import Page from "../app/print/ortho-card/[caseId]/page";

const adj = (id: number, doneOn: string, upperWire: string | null, lowerWire: string | null, extra: Record<string, unknown> = {}) => ({
  id, visitId: null, visitSigned: false, doneOn, phase: null, upperWire, lowerWire, elastics: "none", elasticNote: null,
  done: "SYN-DONE-PRIVATE", nextWeeks: 4, note: "SYN-NOTE-PRIVATE", recordedBy: "syn", photos: [], ...extra,
});
const baseCase = {
  id: 7, patientId: 5, patientName: "SYN Patient", appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: "SYN-MBT",
  status: "active", phase: "working", startDate: "2026-01-04", plannedMonths: 18, upperWire: null, lowerWire: "014 NiTi",
  planId: 99, retainer: null, retainerOn: null, note: "SYN-CASE-NOTE-PRIVATE", closedAt: null, closedBy: null, closedNote: null,
  baselineKind: null, baselineRecordedAt: null, elastics: null, responsibleDoctorId: 3, responsibleDoctorName: "SYN-RESPONSIBLE",
  legacyFinancialMode: "installments", remainingObjectives: "SYN-OBJECTIVES-PRIVATE",
  adjustments: [
    adj(3, "2026-03-01", null, "014 NiTi", { elastics: "class_ii", elasticNote: "3/16" }),
    adj(2, "2026-02-01", null, null),
    adj(1, "2026-01-04", "016 NiTi", "014 NiTi", { phase: "aligning" }),
  ],
  documentedWireRemovals: [{ adjustmentId: 3, arch: "upper" }],
  progress: { monthsElapsed: 2, monthsPlanned: 18, monthsRemaining: 16, percent: 11, overdue: false, adjustments: 3, lastAdjustment: "2026-03-01", daysSinceLast: 10 },
};
const render = async (caseId = "7") => renderToStaticMarkup(await Page({ params: Promise.resolve({ caseId }) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ username: "syn", role: "doctor" });
  mocks.access.mockResolvedValue(true);
  mocks.orthoCase.mockResolvedValue(structuredClone(baseCase));
  mocks.patient.mockResolvedValue({ id: 5, fullName: "SYN Patient", patientNumber: "SYN-001", phone: "777-PRIVATE" });
  mocks.appointments.mockResolvedValue([
    { id: 41, patientId: 5, scheduledDate: "2099-04-01", scheduledTime: "10:30", status: "booked", appointmentType: "ortho", note: "SYN-APPT-NOTE" },
  ]);
});

describe("/print/ortho-card/[caseId] (OC-1)", () => {
  it("prints identity, case facts, progress, responsible doctor and the next booked appointment", async () => {
    const html = await render();
    for (const text of ["SYN مركز اصطناعي", "SYN-LEAD", "SYN-CRED", "SYN-ADDRESS", "بطاقة علاج التقويم", "SYN Patient", "SYN-001",
      "SYN-MBT", "SYN-RESPONSIBLE", "18 شهرًا", "11%"]) expect(html).toContain(text);
    expect(html).toContain('<bdi dir="ltr">2026-01-04</bdi>');
    expect(html).toContain("الموعد القادم");
    expect(html).toContain('<bdi dir="ltr">2099-04-01</bdi>');
    expect(html).toContain("توقيع الطبيب المعالج");
  });

  it("never prints money, private notes, the phone or appointment notes", async () => {
    const html = await render();
    for (const secret of ["SYN-DONE-PRIVATE", "SYN-NOTE-PRIVATE", "SYN-CASE-NOTE-PRIVATE", "SYN-OBJECTIVES-PRIVATE", "777-PRIVATE",
      "SYN-APPT-NOTE", "installments", "أقساط", "ريال", "رصيد", "فاتورة"]) expect(html).not.toContain(secret);
  });

  it("prints the wire sessions with the approved semantics, newest first", async () => {
    const html = await render();
    const body = html.split("<tbody>")[1].split("</tbody>")[0];
    const rows = body.split("</tr>").filter(Boolean);
    expect(rows.map(row => row.match(/\d{4}-\d{2}-\d{2}/)?.[0])).toEqual(["2026-03-01", "2026-02-01", "2026-01-04"]);
    expect(rows[0]).toContain("إزالة موثّقة");
    expect(rows[0]).toContain("بلا تغيير · سُجّل مجددًا");
    expect(rows[1].match(/بلا تغيير/g)).toHaveLength(3);
    expect(rows[1]).not.toContain("NiTi");
    expect(rows[2]).toContain("أول تسجيل");
    expect(html).toContain("<thead");
    expect(html).toContain("بلا سلك — إزالة موثّقة");
    expect(html).not.toMatch(/اقتراح|السلك التالي|تاريخ التركيب/);
  });

  it("an appliance without archwires prints without the wire section", async () => {
    mocks.orthoCase.mockResolvedValue({ ...structuredClone(baseCase), appliance: "aligners" });
    const html = await render();
    expect(html).toContain("هذا الجهاز لا يستخدم أسلاكًا.");
    expect(html).not.toContain("<tbody>");
  });

  it("no booked appointment says so; past or cancelled ones are not shown", async () => {
    mocks.appointments.mockResolvedValue([{ id: 42, patientId: 5, scheduledDate: "2099-04-01", scheduledTime: "10:30", status: "cancelled" }]);
    const html = await render();
    expect(html).toContain("لا موعد محجوز قادم");
    expect(html).not.toContain("2099-04-01");
  });

  it("no session: Arabic message, nothing loaded", async () => {
    mocks.session.mockResolvedValue(null);
    expect(await render()).toContain("انتهت الجلسة. سجّل الدخول من جديد.");
    expect(mocks.orthoCase).not.toHaveBeenCalled();
  });

  it("missing case or patient outside access is the same not-found, before any other read", async () => {
    mocks.orthoCase.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    mocks.orthoCase.mockResolvedValue(structuredClone(baseCase));
    mocks.access.mockResolvedValue(false);
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.patient).not.toHaveBeenCalled();
    expect(mocks.appointments).not.toHaveBeenCalled();
    await expect(render("07")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("entry point (OC-1)", () => {
  it("the ortho case header links to the card without touching the session form", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../components/PatientOrtho.tsx", import.meta.url), "utf8");
    expect(source).toContain('href={`/print/ortho-card/${row.id}`} target="_blank" rel="noopener" data-testid="ortho-treatment-card-link"');
    expect(source.match(/\/print\/ortho-card\//g)).toHaveLength(1);
    const form = source.slice(source.indexOf("export function AdjustmentForm"));
    expect(form).not.toContain("/print/ortho-card/");
  });
});
