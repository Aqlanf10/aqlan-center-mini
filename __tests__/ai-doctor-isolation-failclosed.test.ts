import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * إثبات Red -> Green لإغلاق مسارات Fail-Open وBOLA وخلط المعرّفات في أدوات المساعد الذكي (بيانات اصطناعية بحتة):
 *  1) الطبيب المقيد غير المربوط بجهة طبيب (doctorPartyId: null) يُحجب Fail-Closed في:
 *     resolvePatientForTool, search_patient, get_today_appointments, get_ortho_followups_due, get_clinic_statistics.
 *  2) منع خلط users.id مع parties.id في generate_internal_report(reportType="doctor") وإصلاح رابط الطباعة.
 *  3) فرض canAccessPatient المباشر في generatePostOpCareAction وأدوات صياغة النماذج، ومنع رابط /print/lab/<patientId>،
 *     وفرض صلاحية canViewXrays في get_cephalometric_summary.
 */

const mocks = vi.hoisted(() => ({
  searchPatients: vi.fn(),
  getPatient: vi.fn(),
  getPatientFile: vi.fn(),
  findUserByUsername: vi.fn(),
  doctorOwnsPatient: vi.fn(),
  doctorOwnedPatientIds: vi.fn(),
  listAppointmentsByDate: vi.fn(),
  orthoFollowupBoard: vi.fn(),
  listPatientCephAnalyses: vi.fn(),
  getPool: vi.fn(),
  buildReport: vi.fn(),
  parseFilters: vi.fn(),
  dbTodayISO: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    searchPatients: mocks.searchPatients,
    getPatient: mocks.getPatient,
    getPatientFile: mocks.getPatientFile,
    findUserByUsername: mocks.findUserByUsername,
    doctorOwnsPatient: mocks.doctorOwnsPatient,
    doctorOwnedPatientIds: mocks.doctorOwnedPatientIds,
    listAppointmentsByDate: mocks.listAppointmentsByDate,
    orthoFollowupBoard: mocks.orthoFollowupBoard,
    listPatientCephAnalyses: mocks.listPatientCephAnalyses,
    getPool: mocks.getPool,
    recordAudit: mocks.recordAudit,
  };
});

vi.mock("@/lib/reports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/reports")>();
  return {
    ...actual,
    buildReport: mocks.buildReport,
    parseFilters: mocks.parseFilters,
    dbTodayISO: mocks.dbTodayISO,
  };
});

import { executeAiTool } from "../lib/ai-tools/registry";
import { resolvePatientForTool } from "../lib/ai-tools/authorization";
import { generateInternalReport } from "../lib/ai-tools/finance-tools";
import { generatePostOpCareAction } from "../lib/ai-tools/clinical-action-tools";
import {
  draftConsentFormAction,
  draftTreatmentPlanFormAction,
  draftLabOrderFormAction,
  draftMedicalReportFormAction,
} from "../lib/ai-tools/form-drafting-tools";
import type { AiToolContext } from "../lib/ai-tools/types";

const UNLINKED_DOCTOR: AiToolContext = {
  userId: 2, // يتصادم رقميًا مع Party #2 لطبيب زميل!
  username: "dr.unlinked",
  role: "doctor",
  doctorPartyId: null,
  permissions: {
    canViewAllPatients: false,
    canViewAllAppointments: false,
    canViewOwnCommissions: true,
    canViewXrays: true,
  },
  canViewAllPatients: false,
  canViewClinicFinance: false,
  canViewOwnCommissions: true,
  isDbConnected: true,
  todayISO: "2030-09-08",
};

const DOCTOR_A: AiToolContext = {
  userId: 11,
  username: "dr.amjad",
  role: "doctor",
  doctorPartyId: 5,
  permissions: {
    canViewAllPatients: false,
    canViewAllAppointments: false,
    canViewOwnCommissions: true,
    canViewXrays: true,
  },
  canViewAllPatients: false,
  canViewClinicFinance: false,
  canViewOwnCommissions: true,
  isDbConnected: true,
  todayISO: "2030-09-08",
};

const PATIENT_OWN = {
  id: 42,
  fullName: "SYNTHETIC-OWN-PATIENT",
  patientNumber: "P-90042",
  phone: "770000042",
  birthYear: 1990,
  medicalAlert: null,
};

const PATIENT_COLLEAGUE = {
  id: 77,
  fullName: "SYNTHETIC-COLLEAGUE-PATIENT",
  patientNumber: "P-90077",
  phone: "770000077",
  birthYear: 1988,
  medicalAlert: "SYNTHETIC-SECRET-ALERT",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dbTodayISO.mockResolvedValue("2030-09-08");
  mocks.parseFilters.mockImplementation((sp: URLSearchParams) => ({
    from: "2030-09-01",
    to: "2030-09-08",
    doctorId: sp.get("doctor") ? Number(sp.get("doctor")) : null,
  }));
  mocks.buildReport.mockResolvedValue({
    title: "تقرير عمولات صناعي",
    periodLabel: "سبتمبر 2030",
    currencyLabel: "YER",
    kpis: [],
    tables: [],
  });
  mocks.doctorOwnsPatient.mockImplementation(
    async (partyId: number, patientId: number) => partyId === 5 && patientId === 42,
  );
  mocks.doctorOwnedPatientIds.mockImplementation(async (partyId: number, ids: number[]) =>
    new Set(ids.filter((id) => partyId === 5 && id === 42)),
  );
  mocks.findUserByUsername.mockImplementation(async (username: string) => {
    if (username === "dr.unlinked") {
      return {
        id: 2,
        username,
        role: "doctor",
        isActive: true,
        partyId: null,
        permissions: { canViewAllPatients: false, canViewXrays: true },
      };
    }
    if (username === "dr.no.xray") {
      return {
        id: 15,
        username,
        role: "doctor",
        isActive: true,
        partyId: 5,
        permissions: { canViewAllPatients: false, canViewXrays: false },
      };
    }
    return {
      id: 11,
      username,
      role: "doctor",
      isActive: true,
      partyId: 5,
      permissions: { canViewAllPatients: false, canViewXrays: true },
    };
  });
  mocks.getPatient.mockImplementation(async (id: number) =>
    id === 42 ? PATIENT_OWN : id === 77 ? PATIENT_COLLEAGUE : null,
  );
  mocks.getPatientFile.mockImplementation(async (id: number) => ({
    patient: id === 42 ? PATIENT_OWN : id === 77 ? PATIENT_COLLEAGUE : null,
    visits: [],
    plans: [],
    invoices: [],
    payments: [],
    documents: [],
  }));
  mocks.searchPatients.mockResolvedValue([PATIENT_COLLEAGUE]);
  mocks.listAppointmentsByDate.mockResolvedValue([
    {
      id: 501,
      patientId: 77,
      patientName: PATIENT_COLLEAGUE.fullName,
      doctorId: 2,
      scheduledDate: "2030-09-08",
      scheduledTime: "10:00",
      durationMinutes: 30,
      appointmentType: "checkup",
      status: "booked",
    },
  ]);
  mocks.orthoFollowupBoard.mockResolvedValue([
    {
      caseId: 301,
      patientId: 77,
      patientName: PATIENT_COLLEAGUE.fullName,
      patientPhone: PATIENT_COLLEAGUE.phone,
      startedOn: "2030-01-01",
      lastAdjustmentDate: "2030-06-01",
      nextAppointment: null,
    },
  ]);
  mocks.getPool.mockReturnValue({
    query: vi.fn().mockResolvedValue({ rows: [{ count: 999 }] }),
  });
  mocks.listPatientCephAnalyses.mockResolvedValue([]);
});

describe("DEF-02a: إغلاق مسارات Fail-Open للطبيب المقيد غير المربوط بجهة طبيب", () => {
  it("يرفض resolvePatientForTool وsearch_patient للطبيب بلا doctorPartyId دون استعلام مرضى الزملاء", async () => {
    const res = await resolvePatientForTool({ patientName: "SYNTHETIC" }, UNLINKED_DOCTOR);
    expect(res.kind).toBe("denied");
    expect(mocks.searchPatients).not.toHaveBeenCalled();

    const searchRes = await executeAiTool("search_patient", { term: "SYNTHETIC" }, UNLINKED_DOCTOR);
    expect(searchRes.success).toBe(false);
    expect(searchRes.textSummary).not.toContain(PATIENT_COLLEAGUE.fullName);
    expect(searchRes.textSummary).not.toContain(PATIENT_COLLEAGUE.phone);
    expect(mocks.searchPatients).not.toHaveBeenCalled();

    const idSearchRes = await executeAiTool("search_patient", { term: "77" }, DOCTOR_A);
    expect(idSearchRes.success).toBe(false);
    expect(idSearchRes.textSummary).toContain("ليس لديك صلاحية");
    expect(idSearchRes.textSummary).not.toContain("77");
    expect(idSearchRes.textSummary).not.toContain(PATIENT_COLLEAGUE.fullName);
    expect(mocks.getPatientFile).not.toHaveBeenCalledWith(77);
  });

  it("لا يسرب مواعيد اليوم أو لوحة التقويم أو إحصائيات المركز للطبيب المقيد غير المربوط بجهة طبيب", async () => {
    const appts = await executeAiTool("get_today_appointments", {}, UNLINKED_DOCTOR);
    expect(appts.success).toBe(false);
    expect(appts.textSummary).not.toContain(PATIENT_COLLEAGUE.fullName);
    expect(mocks.listAppointmentsByDate).not.toHaveBeenCalled();

    const ortho = await executeAiTool("get_ortho_followups_due", {}, UNLINKED_DOCTOR);
    expect(ortho.success).toBe(false);
    expect(ortho.textSummary).not.toContain(PATIENT_COLLEAGUE.fullName);
    expect(mocks.orthoFollowupBoard).not.toHaveBeenCalled();

    const stats = await executeAiTool("get_clinic_statistics", {}, UNLINKED_DOCTOR);
    expect(stats.success).toBe(false);
    expect(stats.textSummary).not.toContain("999");
  });
});

describe("DEF-02b: منع خلط users.id مع parties.id في تقرير عمولة الطبيب وإصلاح رابط الطباعة", () => {
  it("يرفض طلب تقرير عمولة طبيب حين يكون doctorPartyId فارغًا ولا يستخدم userId كمعرّف جهة طبيب", async () => {
    const deniedViaTool = await executeAiTool(
      "get_doctor_commission",
      {},
      UNLINKED_DOCTOR,
    );
    expect(deniedViaTool.success).toBe(false);
    expect(mocks.buildReport).not.toHaveBeenCalled();

    const deniedDirect = await generateInternalReport(
      { reportType: "doctor" },
      UNLINKED_DOCTOR,
    );
    expect(deniedDirect.success).toBe(false);
    expect(mocks.buildReport).not.toHaveBeenCalled();

    const allowed = await executeAiTool(
      "get_doctor_commission",
      {},
      DOCTOR_A,
    );
    expect(allowed.success).toBe(true);
    expect(mocks.parseFilters).toHaveBeenCalled();
    const passedSearchParams = mocks.parseFilters.mock.calls[0]?.[0] as URLSearchParams;
    expect(passedSearchParams.get("doctorId")).toBe("5");
    const printAction = allowed.actions?.find((a) => a.actionType === "print");
    expect(printAction?.href).toContain("/print/report?");
    expect(printAction?.href).toContain("report=doctor");
    expect(printAction?.href).not.toContain("/print/report/doctor");
  });
});

describe("DEF-02c: فحص canAccessPatient المباشر في أدوات الرعاية وصياغة النماذج وصلاحية الأشعة في السيفالومتري", () => {
  it("يرفض تمرير patientId لمريض زميل في generatePostOpCareAction وأدوات الصياغة دون قراءة getPatient(77)", async () => {
    const postOp = await generatePostOpCareAction(
      { patientId: 77, procedureType: "خلع جراحي" },
      DOCTOR_A,
    );
    expect(postOp.success).toBe(false);
    expect(mocks.getPatient).not.toHaveBeenCalledWith(77);

    const consent = await draftConsentFormAction(
      { patientId: 77, procedureType: "خلع جراحي" },
      DOCTOR_A,
    );
    expect(consent.success).toBe(false);
    expect(mocks.getPatient).not.toHaveBeenCalledWith(77);

    const plan = await draftTreatmentPlanFormAction(
      { patientId: 77, totalCost: 200000, downPayment: 50000 },
      DOCTOR_A,
    );
    expect(plan.success).toBe(false);
    expect(mocks.getPatient).not.toHaveBeenCalledWith(77);

    const lab = await draftLabOrderFormAction(
      { patientId: 77, toothCode: "16", shade: "A2" },
      DOCTOR_A,
    );
    expect(lab.success).toBe(false);
    expect(mocks.getPatient).not.toHaveBeenCalledWith(77);

    const report = await draftMedicalReportFormAction(
      { patientId: 77, diagnosis: "التهاب لبي" },
      DOCTOR_A,
    );
    expect(report.success).toBe(false);
    expect(mocks.getPatient).not.toHaveBeenCalledWith(77);
  });

  it("لا يولّد رابط /print/lab/<patientId> خاطئ لمسودة أمر معمل غير محفوظ، ويفرض canViewXrays في السيفالومتري", async () => {
    const labOwn = await draftLabOrderFormAction(
      { patientId: 42, toothCode: "16", shade: "A2" },
      DOCTOR_A,
    );
    expect(labOwn.success).toBe(true);
    expect(labOwn.actions?.some((a) => a.href === "/print/lab/42")).toBe(false);

    const noXrayDoctor: AiToolContext = {
      ...DOCTOR_A,
      userId: 15,
      username: "dr.no.xray",
      permissions: { canViewAllPatients: false, canViewXrays: false },
    };
    const cephDenied = await executeAiTool(
      "get_cephalometric_summary",
      { patientId: 42 },
      noXrayDoctor,
    );
    expect(cephDenied.success).toBe(false);
    expect(mocks.listPatientCephAnalyses).not.toHaveBeenCalled();
  });
});
