import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { friendlyDateLong } from "../lib/reminders";
import { checkEndoVisitDraft, summarizeEndo } from "../lib/endodontics";
import { CLINIC_BASE_CURRENCY, formatMoney } from "../lib/money";
import type { EndoTreatmentView, EndoVisitView } from "../lib/endodontics-db";

const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), patient: vi.fn(), chart: vi.fn(),
  ledger: vi.fn(), planCurrencies: vi.fn(), settings: vi.fn(), endo: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.access }));
vi.mock("@/lib/db", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/db")>(),
  getPatientFile: mocks.patient, patientChart: mocks.chart, patientLedger: mocks.ledger,
  patientPlanCurrencies: mocks.planCurrencies, getSettingsSafe: mocks.settings }));
vi.mock("@/lib/endodontics-db", () => ({ listPatientEndo: mocks.endo }));
vi.mock("@/components/PrintHeader", () => ({ PrintHeader: ({ title }: { title: string }) => createElement("h1", null, title) }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));
import DossierPage from "../app/print/dossier/[id]/page";
import { PatientDossierEndo, projectDossierEndo } from "../components/PatientDossierEndo";

function visit(body: Record<string, unknown> = { note: "Original clinical record", mobilityGrade: 0 }): EndoVisitView {
  const checked = checkEndoVisitDraft({ stage: "assessment", ...body });
  if (!checked.ok) throw new Error(checked.message);
  return { ...checked.value, id: 101, treatmentId: 8, visitId: 51, doctorId: 3, doctorName: "Synthetic doctor",
    signed: true, recordedAt: "2026-09-20T10:00:00Z", recordedBy: "synthetic-author", version: 1, updatedAt: null,
    addenda: [{ id: 9, body: "Append-only clinical correction", author: "synthetic-addendum-author", createdAt: "2026-09-21T10:00:00Z" }] };
}
function treatment(visits = [visit()]): EndoTreatmentView {
  return { id: 8, patientId: 17, caseId: 4, caseTitle: "Synthetic endo case", toothCode: 36, toothName: "Synthetic molar",
    kind: "initial", status: "in_progress", completedAt: null, outcome: null, restorativeStatus: "none", crownRequired: true,
    crownPlanItem: { id: 999, name: "PRIVATE PLAN PRICE", status: "PRIVATE PLAN STATUS" }, version: 1,
    createdBy: "synthetic", createdAt: "2026-09-20T10:00:00Z", visits,
    summary: summarizeEndo(visits, new Map(visits.map((v) => [v.id, v.canals]))), crown: "planned_done", nextAction: "PRIVATE DERIVED PLAN" };
}
const params = { params: Promise.resolve({ id: "17" }) };
const html = async () => renderToStaticMarkup(await DossierPage(params));
const incompleteFinance = "تعذّر تحميل الملخص المالي؛ هذا القسم غير مكتمل";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ role: "doctor", username: "synthetic", userId: 1 });
  mocks.access.mockImplementation(async (_session, _id, permission) => !permission);
  mocks.patient.mockResolvedValue({ patient: { id: 17, fullName: "Synthetic patient", patientNumber: "SYN-17", gender: "male",
    birthYear: 1990, phone: null, address: null, medicalAlert: null, createdAt: "2026-01-01T00:00:00Z" }, visits: [], appointments: [] });
  mocks.chart.mockResolvedValue({ records: [], summary: { charted: 0, caries: 0, planned: 0, completed: 0, absent: 0 } });
  mocks.ledger.mockResolvedValue({ invoices: [], payments: [], openings: [] });
  mocks.planCurrencies.mockResolvedValue(new Map());
  mocks.settings.mockResolvedValue({});
  mocks.endo.mockResolvedValue([treatment()]);
});

describe("existing clinical dossier endodontics integration", () => {
  it("states its limited clinical scope without claiming a complete patient or financial record", async () => {
    const output = await html();
    for (const text of ["ملخص الملف السريري للمريض (Clinical Summary)",
      "لا يشمل جميع سجلات التخصصات أو المستندات أو تفاصيل الخطة العلاجية",
      "الملخص المالي، إن ظهر، يخضع للصلاحيات ولا يغني عن كشف الحساب المالي"]) expect(output).toContain(text);
    expect(output).not.toContain("الملف الطبي السريري الشامل للمريض");
    expect(output).not.toContain("وثيقة طبية رسمية");
  });

  it("prints the canonical signed record and append-only correction with case/tooth/visit context", async () => {
    const output = await html();
    expect(mocks.endo).toHaveBeenCalledWith(17);
    for (const text of ["SYN-17", "Synthetic endo case", "الحالة #4", "السن 36", "زيارة #51", "زيارة موقّعة",
      "Original clinical record", "Append-only clinical correction", "synthetic-addendum-author", "سجل الجلسة السريري #101",
      "ملحق #9 للسجل السريري الموقّع #101"]) expect(output).toContain(text);
    expect(output.indexOf("Original clinical record")).toBeLessThan(output.indexOf("Append-only clinical correction"));
  });

  it("allows clinical printing without reading finance or exposing plan identity/progress", async () => {
    const output = await html();
    expect(output).not.toContain("PRIVATE");
    expect(output).not.toContain("999");
    expect(output).not.toContain("الرصيد المتبقي");
    expect(output).not.toContain(incompleteFinance);
    expect(mocks.ledger).not.toHaveBeenCalled();
    expect(mocks.planCurrencies).not.toHaveBeenCalled();
    expect(mocks.access).toHaveBeenCalledWith(expect.anything(), 17, "canViewPatientPayments");
  });

  it.each(["ledger", "planCurrencies"] as const)("marks an authorized failed %s read as incomplete without fallback amounts", async (source) => {
    mocks.access.mockResolvedValue(true);
    mocks[source].mockRejectedValue(new Error("SENSITIVE FINANCE FAILURE"));
    const output = await html();
    expect(output).toContain(incompleteFinance);
    expect(output).not.toContain("SENSITIVE FINANCE FAILURE");
    for (const label of ["إجمالي الفواتير:", "إجمالي المسدد:", "الرصيد المتبقي (الذمة):"]) expect(output).not.toContain(label);
    expect(output).toContain("Original clinical record");
  });

  it("marks failed authorized balance derivation as incomplete without exposing invalid references or amounts", async () => {
    mocks.access.mockResolvedValue(true);
    mocks.ledger.mockResolvedValue({ invoices: [], openings: [], payments: [{
      amountMinor: 100, currency: "SAR", exchangeRate: 425, baseAmountMinor: 425,
      kind: "payment", invoiceId: null, planId: 9123, openingCurrency: null,
    }] });
    const output = await html();
    expect(output).toContain(incompleteFinance);
    for (const hidden of ["9123", "مرجع غير محلول", "سلامة العملة المالية", "إجمالي الفواتير:", "إجمالي المسدد:", "الرصيد المتبقي (الذمة):"]) expect(output).not.toContain(hidden);
  });

  it("prints valid authorized zero balances instead of treating them as an unavailable summary", async () => {
    mocks.access.mockResolvedValue(true);
    const output = await html();
    const zero = formatMoney(0, CLINIC_BASE_CURRENCY);
    expect(output).not.toContain(incompleteFinance);
    expect(output).toContain(`إجمالي الفواتير: <strong>${zero}</strong>`);
    expect(output).toContain(`إجمالي المسدد: <strong>${zero}</strong>`);
    expect(output).toContain(`الرصيد المتبقي (الذمة): ${zero}`);
  });

  it("blocks unauthorized patient access before reading clinical or financial records", async () => {
    mocks.access.mockResolvedValue(false);
    await expect(DossierPage(params)).rejects.toThrow();
    expect(mocks.endo).not.toHaveBeenCalled();
    expect(mocks.patient).not.toHaveBeenCalled();
    expect(mocks.ledger).not.toHaveBeenCalled();
  });

  it("does not turn a failed ENDO read into an empty clinical history", async () => {
    mocks.endo.mockRejectedValue(new Error("SENSITIVE DATABASE DETAILS"));
    const output = await html();
    expect(output).toContain("هذا القسم غير مكتمل");
    expect(output).not.toContain("SENSITIVE DATABASE DETAILS");
    expect(output).not.toContain("لا توجد سجلات جلسات علاج جذور");
  });

  it("labels failed chart reads as incomplete without zero counters or false no-record claims", async () => {
    mocks.chart.mockRejectedValue(new Error("SENSITIVE CHART DETAILS"));
    const output = await html();
    expect(output).toContain("تعذّر تحميل مخطط الأسنان؛ هذا القسم غير مكتمل");
    expect(output).not.toContain("الأسنان الموثقة:");
    expect(output).not.toContain("لا توجد إجراءات مسجلة على المخطط السني");
    expect(output).not.toContain("SENSITIVE CHART DETAILS");
    expect(output).toContain("Original clinical record");
  });

  it("shows the clinic-local visit day and does not invent an examination for an empty note", async () => {
    const file = await mocks.patient();
    file.visits = [{ id: 301, arrivedAt: "2026-09-20T22:30:00Z", status: "done", chair: 1, note: null }];
    mocks.patient.mockResolvedValue(file);
    const output = await html();
    const visitHistory = output.slice(output.indexOf("أحدث الزيارات السريرية"), output.indexOf('aria-label="سجل علاج الجذور"'));
    expect(visitHistory).toContain(friendlyDateLong("2026-09-21"));
    expect(visitHistory).not.toContain(friendlyDateLong("2026-09-20"));
    expect(visitHistory).toContain("لا توجد ملاحظة مسجّلة");
    expect(visitHistory).not.toContain("كشف ومعاينة سريرية");
  });

  it("prints all loaded visits/chart rows and discloses the upstream latest-50 limit", async () => {
    const file = await mocks.patient();
    file.visits = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, arrivedAt: "2026-09-20T10:00:00Z", status: "done", chair: 1, note: `Synthetic history ${index + 1}` }));
    mocks.patient.mockResolvedValue(file);
    mocks.chart.mockResolvedValue({ records: Array.from({ length: 12 }, (_, index) => ({ id: index + 1, toothCode: 36, condition: "caries", stage: "existing", surfaces: null, recordedAt: "2026-09-20T22:30:00Z", visitId: 301, note: `Synthetic chart ${index + 1}` })),
      summary: { charted: 1, caries: 1, planned: 0, completed: 0, absent: 0 } });
    const output = await html();
    expect(output).toContain("Synthetic history 8");
    expect(output).toContain("Synthetic chart 1<");
    expect(output).toContain("Synthetic chart 12");
    expect(output).toContain("ملخص المخطط الحالي وسجل حالات الأسنان");
    expect(output).toContain("زيارة #301");
    expect(output).toContain("سُجل:");
    expect(output).toContain("أحدث 50 زيارة كحد أقصى");
  });
});

describe("clinical-only ENDO print projection", () => {
  it("labels each addendum and its signed clinical record with their own distinct identifiers", () => {
    const first = visit();
    const second = { ...visit(), id: 202, visitId: 72, addenda: [{
      id: 10, body: "Second signed record correction", author: "second-author", createdAt: "2026-09-22T10:00:00Z",
    }] };
    const output = renderToStaticMarkup(createElement(PatientDossierEndo, { patientId: 17, treatments: [treatment([first, second])] }));
    for (const text of ["سجل الجلسة السريري #101", "زيارة #51", "ملحق #9 للسجل السريري الموقّع #101",
      "سجل الجلسة السريري #202", "زيارة #72", "ملحق #10 للسجل السريري الموقّع #202"]) expect(output).toContain(text);
    for (const wrong of ["ملحق للسجل الموقّع #9", "ملحق #9 للسجل السريري الموقّع #202",
      "ملحق #10 للسجل السريري الموقّع #101", "ملحق #9 للسجل السريري الموقّع #51"]) expect(output).not.toContain(wrong);
  });

  it("filters empty defaults, retains a meaningful unsigned draft and labels it honestly", () => {
    const empty = { ...visit({}), id: 102, visitId: 52, signed: false, addenda: [] };
    const draft = { ...visit({ note: "Clinical draft only" }), id: 103, visitId: 53, signed: false, addenda: [] };
    const output = renderToStaticMarkup(createElement(PatientDossierEndo, { patientId: 17, treatments: [treatment([empty, draft])] }));
    expect(output).not.toContain("زيارة #52");
    expect(output).toContain("زيارة #53");
    expect(output).toContain("مسودة غير موقّعة");
    expect(output).not.toContain("زيارة موقّعة");
  });

  it("keeps valid zero clinical findings and measured canal provenance without any plan fields", () => {
    const record = visit({ mobilityGrade: 0, canals: [{ label: "MB", workingLengthMm: 20.5, referencePoint: "cusp_tip", measurementMethod: "apex_locator", masterApicalSize: 25, taperPercent: 4, obturated: true, note: "Canal note" }] });
    const projected = projectDossierEndo(17, [treatment([record])]);
    expect(projected[0].visits[0].details).toContainEqual({ label: "درجة الحركة", value: "0" });
    expect(projected[0].visits[0].canals[0]).toMatchObject({ label: "MB", workingLengthMm: 20.5, obturated: true });
    const serialized = JSON.stringify(projected);
    for (const field of ["crownPlanItem", "crownRequired", "planned_done", "PRIVATE", "nextAction", "summary"]) expect(serialized).not.toContain(field);
  });

  it("does not carry another patient's treatment or mismatched treatment visit into the print", () => {
    expect(projectDossierEndo(17, [{ ...treatment(), patientId: 18 }])).toEqual([]);
    expect(projectDossierEndo(17, [treatment([{ ...visit(), treatmentId: 9 }])])).toEqual([]);
  });

  it("keeps a signed append-only correction even if its original legacy record is empty", () => {
    expect(projectDossierEndo(17, [treatment([visit({})])])[0].visits[0].addenda[0].body).toBe("Append-only clinical correction");
  });
});
