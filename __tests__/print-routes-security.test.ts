import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SETTING_DEFAULTS } from "../lib/settings";

/**
 * اختبارات أمن مسارات الطباعة (P0.11/P0.12/P0.16):
 * الطبيب A يفتح بطاقة/سيفالو/معمل مريض الطبيب B بمعرفة الرقم → 404.
 */

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  canAccessPatient: vi.fn(),
  getPatient: vi.fn(),
  getSettingsSafe: vi.fn(),
  getAppointment: vi.fn(),
  getLabOrderById: vi.fn(),
  patientAppointmentsFrom: vi.fn(),
  getCephStudy: vi.fn(),
  getCephReferenceSet: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.canAccessPatient }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getPatient: mocks.getPatient,
    getSettingsSafe: mocks.getSettingsSafe,
    getAppointment: mocks.getAppointment,
    getLabOrderById: mocks.getLabOrderById,
    patientAppointmentsFrom: mocks.patientAppointmentsFrom,
    getCephStudy: mocks.getCephStudy,
    getCephReferenceSet: mocks.getCephReferenceSet,
  };
});

import PatientCardPage from "../app/print/patient-card/[id]/page";
import CephPrintPage from "../app/print/ceph/[id]/page";
import LabPrintPage from "../app/print/lab/[id]/page";

const DOCTOR_A = { userId: 2, username: "dr.amjad", role: "doctor", partyId: 5 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue(DOCTOR_A);
  mocks.canAccessPatient.mockResolvedValue(true);
  mocks.getPatient.mockResolvedValue({
    id: 77, fullName: "مريض الطبيب B", patientNumber: "P-00077", phone: "770000002",
    gender: "male", birthYear: 1985, medicalAlert: null, address: null,
    createdAt: "2026-01-15T08:00:00.000Z", note: null, altPhone: null,
  });
  mocks.getSettingsSafe.mockResolvedValue(SETTING_DEFAULTS);
  mocks.patientAppointmentsFrom.mockResolvedValue([]);
});

describe("بطاقة المريض A6 (P0.11)", () => {
  it.each(["77.0", "7.7e1", "0x4d", "+77", "077", "9007199254740993", "P-07000", "", "-77"])(
    "معرّف رابط بطاقة غير قياسي %s: رفض قبل التفويض أو قراءة بيانات المريض",
    async (invalidId) => {
      await expect(
        PatientCardPage({ params: Promise.resolve({ id: invalidId }) }),
      ).rejects.toThrow();
      expect(mocks.canAccessPatient).not.toHaveBeenCalled();
      expect(mocks.getPatient).not.toHaveBeenCalled();
      expect(mocks.patientAppointmentsFrom).not.toHaveBeenCalled();
    },
  );

  it("الجلسة الغائبة لا تُظهر الرقم أو الاسم ولا تطلب أي بيانات", async () => {
    mocks.requireSession.mockResolvedValue(null);
    await expect(PatientCardPage({ params: Promise.resolve({ id: "77" }) })).rejects.toThrow();
    expect(mocks.canAccessPatient).not.toHaveBeenCalled();
    expect(mocks.getPatient).not.toHaveBeenCalled();
    expect(mocks.getSettingsSafe).not.toHaveBeenCalled();
  });

  it("طبيب لا يملك المريض يفتح البطاقة بالرقم: 404 قبل قراءة الهوية أو المواعيد", async () => {
    mocks.canAccessPatient.mockResolvedValue(false);
    await expect(
      PatientCardPage({ params: Promise.resolve({ id: "77" }) }),
    ).rejects.toThrow();
    expect(mocks.getPatient).not.toHaveBeenCalled();
    expect(mocks.getSettingsSafe).not.toHaveBeenCalled();
    expect(mocks.patientAppointmentsFrom).not.toHaveBeenCalled();
  });

  it("فشل التحقق من النطاق لا يفتح قراءة الملف في مسار بطاقة الطباعة", async () => {
    mocks.canAccessPatient.mockRejectedValue(new Error("synthetic scope lookup failure"));
    await expect(
      PatientCardPage({ params: Promise.resolve({ id: "77" }) }),
    ).rejects.toThrow();
    expect(mocks.getPatient).not.toHaveBeenCalled();
    expect(mocks.patientAppointmentsFrom).not.toHaveBeenCalled();
  });

  it.each(["P-00042", "P-07000", "P-07001"])(
    "بطاقة الأرشفة تطبع رقم الملف الأصلي كما في القاعدة دون قصّ أو إعادة ترقيم: %s",
    async (patientNumber) => {
      mocks.getPatient.mockResolvedValue({
        id: 77, fullName: "SYNTHETIC PRINT FILE", patientNumber, phone: "700000000",
        createdAt: "2026-11-22T08:00:00.000Z", medicalAlert: null,
      });
      const page = await PatientCardPage({ params: Promise.resolve({ id: "77" }) });
      const html = renderToStaticMarkup(page);
      expect(html).toContain(`>${patientNumber}</p>`);
      expect(html).not.toContain("undefined");
    },
  );

  it("البطاقة الإدارية لا تدعو لاستخدام بوابة المرضى قبل اعتمادها", async () => {
    const card = await PatientCardPage({ params: Promise.resolve({ id: "77" }) });
    const html = renderToStaticMarkup(card);
    expect(html).toContain("P-00077");
    expect(html).toContain("وقدّم رقم الملف للاستقبال");
    expect(html).not.toContain("بوّابة المرضى");
    expect(html).not.toContain("بوابة المرضى");
  });

  it("الاستقبال يفتح بطاقة أي مريض (سياسة المركز) — السلوك الطبيعي", async () => {
    mocks.requireSession.mockResolvedValue({ userId: 3, username: "reception1", role: "reception" });
    const result = await PatientCardPage({ params: Promise.resolve({ id: "77" }) });
    expect(result).toBeDefined();
  });

  it("الطبيب المالك يفتح بطاقة مريضه: تعمل", async () => {
    const result = await PatientCardPage({ params: Promise.resolve({ id: "77" }) });
    expect(result).toBeDefined();
  });
});

describe("طباعة السيفالو (P0.12 — canViewXrays كمسارات API)", () => {
  it("طبيب بلا صلاحية أشعة: 404", async () => {
    mocks.canAccessPatient.mockResolvedValue(false); /* canViewXrays داخل الحرس */
    await expect(
      CephPrintPage({ params: Promise.resolve({ id: "12" }) }),
    ).rejects.toThrow();
  });

  it("تحليل موجود لمريض مملوك وصلاحية أشعة: تعمل", async () => {
    mocks.getCephStudy.mockResolvedValue({
      analysis: {
        id: 12, patientId: 77, refSet: "steiner", status: "draft",
        mmPerPixel: 0.2, landmarks: [], measurements: [],
      },
      landmarks: [],
      measurements: [],
    });
    mocks.getCephReferenceSet.mockResolvedValue(null);
    const result = await CephPrintPage({ params: Promise.resolve({ id: "12" }) });
    expect(result).toBeDefined();
  });
});

describe("طباعة أمر المعمل (P0.12)", () => {
  it("طبيب لا يملك مريض الأمر: 404", async () => {
    mocks.canAccessPatient.mockResolvedValue(false);
    mocks.getLabOrderById.mockResolvedValue({
      id: 321, patientId: 77, patientName: "مريض الطبيب B", patientNumber: "P-00077",
      patientBirthYear: 1985, workType: "تاج زيركون", shade: "A2", labName: "المعمل",
      sentDate: "2026-09-01", dueDate: "2026-09-06", priority: "normal",
      toothNumbers: "16", status: "sent",
    });
    await expect(
      LabPrintPage({ params: Promise.resolve({ id: "321" }) }),
    ).rejects.toThrow();
  });

  it("أمر معمل مملوك المريض: تعمل", async () => {
    mocks.getLabOrderById.mockResolvedValue({
      id: 321, patientId: 77, patientName: "مريض الطبيب B", patientNumber: "P-00077",
      patientBirthYear: 1985, workType: "تاج زيركون", shade: "A2", labName: "المعمل",
      sentDate: "2026-09-01", dueDate: "2026-09-06", priority: "normal",
      toothNumbers: "16", status: "sent",
    });
    const result = await LabPrintPage({ params: Promise.resolve({ id: "321" }) });
    expect(result).toBeDefined();
  });
});
