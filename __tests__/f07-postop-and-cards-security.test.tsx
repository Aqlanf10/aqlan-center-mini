import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST_OP_TEMPLATES } from "../lib/post-op-care";

/**
 * إثبات Red -> Green لبنود الطباعة F-07 (بيانات اصطناعية بحتة):
 *  1) /print/post-op/[id]: منع تمرير أو عرض ملاحظات/تاريخ/طبيب من رابط URL،
 *     وفصل مصدر التعليمات السريرية المحفوظة عن حساب الموظف الذي طبع الورقة،
 *     ورفض القوالب المجهولة أو الزيارات غير المربوطة بالمريض.
 *  2) PostOpModal: عدم حقن ?notes=... في رابط الطباعة مطلقًا.
 *  3) /print/card/[id]: عدم تصنيف بطاقة الموعد ككشف حساب مالي (docType="statement").
 *  4) /print/patient-card/[id]: إزالة توجيه الدخول القديم بالملف والهاتف المعطّل وفحص الصلاحية قبل القراءة.
 */

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  canAccessPatient: vi.fn(),
  getPatient: vi.fn(),
  getSettingsSafe: vi.fn(),
  getAppointment: vi.fn(),
  patientAppointmentsFrom: vi.fn(),
  getVisitPostOpContext: vi.fn(),
  printButtonProps: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("@/lib/session", () => ({
  requireSession: mocks.requireSession,
}));

vi.mock("@/lib/patient-access", () => ({
  canAccessPatient: mocks.canAccessPatient,
}));

vi.mock("@/components/PrintButton", () => ({
  PrintButton: (props: Record<string, unknown>) => {
    mocks.printButtonProps(props);
    return React.createElement("div", {
      "data-testid": "print-button",
      "data-doc-type": props?.docType ? String(props.docType) : "",
    });
  },
  ReprintMark: () => null,
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    getPatient: mocks.getPatient,
    getSettingsSafe: mocks.getSettingsSafe,
    getAppointment: mocks.getAppointment,
    patientAppointmentsFrom: mocks.patientAppointmentsFrom,
    getVisitPostOpContext: mocks.getVisitPostOpContext,
  };
});

import PostOpPrintPage from "../app/print/post-op/[id]/page";
import AppointmentCardPage from "../app/print/card/[id]/page";
import PatientCardPage from "../app/print/patient-card/[id]/page";
import { PostOpModal } from "../components/PostOpModal";

const SYNTHETIC_PATIENT = {
  id: 99001,
  patientNumber: "P-99001",
  fullName: "SYNTHETIC-PATIENT-F07",
  phone: "770009901",
  altPhone: null,
  gender: "female" as const,
  birthYear: 1996,
  birthDate: "1996-05-10",
  address: null,
  medicalAlert: null,
  note: null,
  createdAt: "2030-01-10T08:00:00.000Z",
};

const SYNTHETIC_SETTINGS = {
  "clinic.name": "مركز اختبار صناعي",
  "clinic.phone": "+967700000000",
  "clinic.address": "عنوان صناعي",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue({
    userId: 31,
    username: "reception1",
    role: "reception",
    expiresAt: Date.now() + 3_600_000,
  });
  mocks.canAccessPatient.mockResolvedValue(true);
  mocks.getPatient.mockResolvedValue(SYNTHETIC_PATIENT);
  mocks.getSettingsSafe.mockResolvedValue(SYNTHETIC_SETTINGS);
  mocks.getAppointment.mockResolvedValue({
    id: 8801,
    patientId: 99001,
    patientName: SYNTHETIC_PATIENT.fullName,
    scheduledDate: "2030-06-15",
    scheduledTime: "10:30",
    durationMinutes: 30,
    appointmentType: "checkup",
    status: "booked",
    note: "موعد فحص صناعي",
  });
  mocks.patientAppointmentsFrom.mockResolvedValue([]);
  mocks.getVisitPostOpContext.mockResolvedValue(null);
});

describe("F-07a: /print/post-op/[id] — منع تزوير التعليمات عبر الرابط وفصل الطبيب عن الطابع", () => {
  it("يتجاهل تمامًا notes وdate وdoctor المعدّلة في الرابط ولا يضع لقب د. قبل حساب الاستقبال", async () => {
    const html = renderToStaticMarkup(
      await PostOpPrintPage({
        params: Promise.resolve({ id: "99001" }),
        searchParams: Promise.resolve({
          templateId: POST_OP_TEMPLATES[0].id,
          notes: "SYNTHETIC-TAMPERED-URL-NOTE-DO-NOT-RENDER",
          date: "2099-12-31",
          doctor: "د. منتحل من الرابط",
        } as Record<string, string>),
      }),
    );

    expect(html).not.toContain("SYNTHETIC-TAMPERED-URL-NOTE-DO-NOT-RENDER");
    expect(html).not.toContain("توجيه خاص من الطبيب المعالج");
    expect(html).not.toContain("2099");
    expect(html).not.toContain("د. منتحل من الرابط");
    expect(html).not.toContain("د. reception1");
    expect(html).toContain("طُبعت بواسطة");
    expect(html).toContain("reception1");
    expect(html).toContain("قالب إرشادات قياسي معتمد من المركز");
  });

  it("عند ربط الطباعة بزيارة موثّقة يعرض الملاحظة المحفوظة في القاعدة واسم الطبيب الفعلي منفصلًا عن موظف الطباعة", async () => {
    mocks.getVisitPostOpContext.mockResolvedValue({
      id: 501,
      patientId: 99001,
      arrivedAt: "2030-06-10T09:15:00.000Z",
      signedAt: "2030-06-10T09:45:00.000Z",
      signedBy: "dr.amjad",
      doctorId: 5,
      doctorName: "د. أمجد الكامل",
      nextPlan: "SYNTHETIC-SAVED-DB-FOLLOWUP-NOTE",
      addendum: null,
    });

    const html = renderToStaticMarkup(
      await PostOpPrintPage({
        params: Promise.resolve({ id: "99001" }),
        searchParams: Promise.resolve({
          templateId: POST_OP_TEMPLATES[0].id,
          visitId: "501",
          notes: "SYNTHETIC-URL-OVERRIDE-ATTEMPT",
        } as Record<string, string>),
      }),
    );

    expect(html).toContain("SYNTHETIC-SAVED-DB-FOLLOWUP-NOTE");
    expect(html).not.toContain("SYNTHETIC-URL-OVERRIDE-ATTEMPT");
    expect(html).toContain("د. أمجد الكامل");
    expect(html).toContain("طُبعت بواسطة");
    expect(html).toContain("reception1");
    expect(html).not.toContain("د. reception1");
  });

  it("يرفض بـ 404 تمرير templateId غير معتمد بدل استبداله صامتًا بقالب آخر", async () => {
    await expect(
      PostOpPrintPage({
        params: Promise.resolve({ id: "99001" }),
        searchParams: Promise.resolve({ templateId: "unapproved_custom_template" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("يرفض بـ 404 تمرير visitId يخص مريضًا آخر أو غير موجود", async () => {
    mocks.getVisitPostOpContext.mockResolvedValue({
      id: 999,
      patientId: 77777, // مريض آخر
      arrivedAt: "2030-06-10T09:15:00.000Z",
      signedAt: "2030-06-10T09:45:00.000Z",
      signedBy: "dr.other",
      doctorId: 8,
      doctorName: "د. زميل آخر",
      nextPlan: "ملاحظة سرية لمريض آخر",
      addendum: null,
    });

    await expect(
      PostOpPrintPage({
        params: Promise.resolve({ id: "99001" }),
        searchParams: Promise.resolve({
          templateId: POST_OP_TEMPLATES[0].id,
          visitId: "999",
        } as Record<string, string>),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("يتحقق من صلاحية الوصول للمريض قبل قراءة بياناته من القاعدة", async () => {
    mocks.canAccessPatient.mockResolvedValue(false);
    await expect(
      PostOpPrintPage({
        params: Promise.resolve({ id: "99001" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.getPatient).not.toHaveBeenCalled();
  });

  it("نافذة PostOpModal لا تعرض حقل حقن نص غير محفوظ في رابط الطباعة", () => {
    const html = renderToStaticMarkup(
      React.createElement(PostOpModal, {
        isOpen: true,
        onClose: () => {},
        patientId: 99001,
        patientName: SYNTHETIC_PATIENT.fullName,
        patientPhone: SYNTHETIC_PATIENT.phone,
        initialTreatmentText: "خلع جراحي",
      }),
    );

    expect(html).not.toContain("ستُضاف لرسالة الواتساب والطباعة");
  });
});

describe("F-07b: بطاقة الموعد وبطاقة المريض — تصحيح تصنيف الطباعة وتوجيه البوابة", () => {
  it("/print/card/[id] لا يصنّف بطاقة الموعد ككشف حساب مالي (statement)", async () => {
    const html = renderToStaticMarkup(
      await AppointmentCardPage({
        params: Promise.resolve({ id: "8801" }),
      }),
    );

    expect(html).toContain("بطاقة موعد");
    expect(mocks.printButtonProps).toHaveBeenCalledTimes(1);
    const passedProps = mocks.printButtonProps.mock.calls[0]?.[0] ?? {};
    expect(passedProps.docType).toBeUndefined();
    expect(passedProps.docId).toBeUndefined();
  });

  it("/print/patient-card/[id] يفحص صلاحية المريض قبل القراءة ولا يطبع توجيه الدخول القديم المعطّل بالملف والهاتف", async () => {
    const html = renderToStaticMarkup(
      await PatientCardPage({
        params: Promise.resolve({ id: "99001" }),
      }),
    );

    expect(html).toContain("بطاقة المريض");
    expect(html).not.toContain("برقم ملفّك أعلاه");
    expect(html).not.toContain("ورقم جوّالك المسجَّل لدينا");

    mocks.getPatient.mockClear();
    mocks.canAccessPatient.mockResolvedValue(false);
    await expect(
      PatientCardPage({
        params: Promise.resolve({ id: "99001" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.getPatient).not.toHaveBeenCalled();
  });
});
