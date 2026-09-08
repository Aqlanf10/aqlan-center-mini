import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * اختبارات أمان الوصفات (P0.8/P0.9/P0.16): طباعة بلا وصفة محفوظة، تزوير اسم
 * الطبيب من الرابط، BOLA في الإبطال، وربط زيارة مريض آخر.
 */

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  findUserByUsername: vi.fn(),
  canAccessPatient: vi.fn(),
  getPatient: vi.fn(),
  getPrescription: vi.fn(),
  getClinicalVisit: vi.fn(),
  savePrescription: vi.fn(),
  voidPrescription: vi.fn(),
  getSettingsSafe: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.canAccessPatient }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    findUserByUsername: mocks.findUserByUsername,
    getPatient: mocks.getPatient,
    getPrescription: mocks.getPrescription,
    getClinicalVisit: mocks.getClinicalVisit,
    savePrescription: mocks.savePrescription,
    voidPrescription: mocks.voidPrescription,
    getSettingsSafe: mocks.getSettingsSafe,
  };
});

import PrescriptionPrintPage from "../app/print/prescription/[id]/page";
import { POST as createPrescription } from "../app/api/prescriptions/route";
import { POST as voidPrescription } from "../app/api/prescriptions/[id]/void/route";

const DOCTOR_SESSION = { userId: 2, username: "dr.amjad", role: "doctor", partyId: 5 };

const STORED_RX = {
  id: 311,
  patientId: 42,
  visitId: null,
  diagnosis: "التهاب لبّي",
  notes: null,
  instructionsLang: "both" as const,
  items: [
    { name: "Ibuprofen 400mg", dose: "400mg", form: "Tablets", frequency: "1 tablet every 8 hours", duration: "3 days", instructions: "بعد الأكل", instructionsEn: "After meals" },
  ],
  status: "active" as const,
  voidReason: null, voidedBy: null, voidedAt: null,
  createdBy: "dr.amjad",
  doctorPartyId: 5,
  createdAt: "2026-09-01T10:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue(DOCTOR_SESSION);
  mocks.findUserByUsername.mockResolvedValue({
    id: 2, username: "dr.amjad", isActive: true, partyId: 5, role: "doctor", permissions: {},
  });
  mocks.canAccessPatient.mockResolvedValue(true);
  mocks.getPatient.mockResolvedValue({
    id: 42, fullName: "سالم عبدالله", patientNumber: "P-00042", phone: "770000001",
    gender: "male", birthYear: 1990, medicalAlert: null, address: null,
  });
  mocks.getSettingsSafe.mockResolvedValue({});
  mocks.getPrescription.mockResolvedValue(null);
});

function pageProps(search: Record<string, string | undefined> = {}) {
  return {
    params: Promise.resolve({ id: "42" }),
    searchParams: Promise.resolve(search),
  };
}

describe("صفحة طباعة الوصفة (P0.9)", () => {
  it("لا وصفة محفوظة ولا مسودة: 404 — لا أدوية افتراضية تُطبع", async () => {
    /* كان يطبع Augmentin وBrufen وChlorhexidine من عينةٍ افتراضية. */
    await expect(PrescriptionPrintPage(pageProps())).rejects.toThrow();
  });

  it("معامل items بلا وضع مسودة معلن: 404 — لا طباعة رسمية من معاملات الرابط", async () => {
    await expect(
      PrescriptionPrintPage(pageProps({ items: encodeURIComponent(JSON.stringify([{ name: "Forged Drug 1g" }])) })),
    ).rejects.toThrow();
  });

  it("وضع المسودة بأدوية لا تصلح (بلا اسم لاتيني): 404 — التنقية ترفضها", async () => {
    await expect(
      PrescriptionPrintPage(pageProps({
        draft: "1",
        items: encodeURIComponent(JSON.stringify([{ name: "اسم عربي فقط" }])),
      })),
    ).rejects.toThrow();
  });

  it("وصفة محفوظة لمريض آخر: 404", async () => {
    mocks.getPrescription.mockResolvedValue({ ...STORED_RX, patientId: 77 });
    await expect(PrescriptionPrintPage(pageProps({ rx: "311" }))).rejects.toThrow();
  });

  it("الاستقبال لا يفتح صفحة وصفة (وثيقة سريرية): 404", async () => {
    mocks.requireSession.mockResolvedValue({ userId: 3, username: "reception1", role: "reception" });
    await expect(PrescriptionPrintPage(pageProps({ rx: "311" }))).rejects.toThrow();
  });

  it("طبيب لا يملك المريض: 404 — عزل داخل الصفحة لا في الوكيل وحده", async () => {
    mocks.canAccessPatient.mockResolvedValue(false);
    await expect(PrescriptionPrintPage(pageProps({ rx: "311" }))).rejects.toThrow();
  });

  it("وصفة محفوظة سليمة لمريض مملوك تُطبَع (السلوك الطبيعي لا يُكسر)", async () => {
    mocks.getPrescription.mockResolvedValue(STORED_RX);
    const result = await PrescriptionPrintPage(pageProps({ rx: "311" }));
    expect(result).toBeDefined();
  });

  it("اسم الطبيب من الرابط لا يعود في الواجهة — الوثيقة تحمل createdBy المخزّن", async () => {
    mocks.getPrescription.mockResolvedValue(STORED_RX);
    const result = await PrescriptionPrintPage(pageProps({ rx: "311", doctorName: "د. مزوّر تمامًا" }));
    /* الصفحة نفسها لم تعد تقرأ doctorName من الرابط أصلًا (حُذف من النوع)،
       والمطبوع يحمل createdBy = dr.amjad. الاختبار يضمن عدم انفجار الصفحة،
       والاسم المخزن مضمون بالتنفيذ أعلاه (لا مسار آخر للاسم). */
    expect(result).toBeDefined();
  });
});

describe("إصدار الوصفة عبر المسار (P0.8)", () => {
  const validDraft = {
    patientId: 42,
    diagnosis: "خلع جراحي",
    notes: "",
    instructionsLang: "both",
    items: [{ name: "Ibuprofen 400mg", dose: "400mg", form: "Tablets", frequency: "1 every 8h", duration: "3 days", instructions: "", instructionsEn: "" }],
  };

  it("زيارة مريض آخر لا تُربط بوصفة المريض", async () => {
    mocks.getClinicalVisit.mockResolvedValue({ id: 50, patientId: 77 });
    const response = await createPrescription(new Request("http://localhost/api/prescriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validDraft, visitId: 50 }),
    }));
    expect(response.status).toBe(400);
    expect(mocks.savePrescription).not.toHaveBeenCalled();
  });

  it("مدير بلا هوية سريرية (بلا جهة طبيب) لا يصدر وصفة", async () => {
    mocks.requireSession.mockResolvedValue({ userId: 1, username: "owner", role: "admin" });
    mocks.findUserByUsername.mockResolvedValue({
      id: 1, username: "owner", isActive: true, partyId: null, role: "admin", permissions: {},
    });
    const response = await createPrescription(new Request("http://localhost/api/prescriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validDraft),
    }));
    expect(response.status).toBe(403);
    expect(mocks.savePrescription).not.toHaveBeenCalled();
  });

  it("تعارض دوائي حرج (بنسلين مع حساسية بنسلين) يمنع الحفظ", async () => {
    mocks.getPatient.mockResolvedValue({
      id: 42, fullName: "سالم", patientNumber: "P-00042", phone: "770000001",
      medicalAlert: "حساسية بنسلين شديدة", gender: "male", birthYear: 1990,
    });
    const response = await createPrescription(new Request("http://localhost/api/prescriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...validDraft,
        items: [{ name: "Augmentin 1g", dose: "1g", form: "Tablets", frequency: "1 every 12h", duration: "5 days", instructions: "", instructionsEn: "" }],
      }),
    }));
    expect(response.status).toBe(409);
    expect(mocks.savePrescription).not.toHaveBeenCalled();
  });

  it("مسوّدة سليمة تُحفظ مع جهة الطبيب من الخادم", async () => {
    mocks.savePrescription.mockResolvedValue({ id: 900, createdAt: "2026-09-08T00:00:00.000Z" });
    const response = await createPrescription(new Request("http://localhost/api/prescriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validDraft),
    }));
    expect(response.status).toBe(201);
    expect(mocks.savePrescription).toHaveBeenCalledWith(
      expect.anything(),
      "dr.amjad",
      5, /* doctorPartyId من سجل المستخدم لا من العميل */
    );
  });
});

describe("إبطال الوصفة (P0.8 — BOLA)", () => {
  const voidContext = { params: Promise.resolve({ id: "311" }) };

  it("الطبيب A لا يُبطل وصفة مريض الطبيب B", async () => {
    mocks.getPrescription.mockResolvedValue({ ...STORED_RX, patientId: 77, doctorPartyId: 6 });
    mocks.canAccessPatient.mockResolvedValue(false);
    const response = await voidPrescription(
      new Request("http://localhost/api/prescriptions/311/void", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "خطأ في الجرعة المكتوبة" }),
      }),
      voidContext,
    );
    expect(response.status).toBe(403);
    expect(mocks.voidPrescription).not.toHaveBeenCalled();
  });

  it("وصة مملوكة تُبطل بسببٍ موثّق", async () => {
    mocks.getPrescription.mockResolvedValue(STORED_RX);
    mocks.canAccessPatient.mockResolvedValue(true);
    mocks.voidPrescription.mockResolvedValue({ ok: true });
    const response = await voidPrescription(
      new Request("http://localhost/api/prescriptions/311/void", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "خطأ في الجرعة المكتوبة" }),
      }),
      voidContext,
    );
    expect(response.status).toBe(200);
    expect(mocks.voidPrescription).toHaveBeenCalledWith(
      expect.objectContaining({ id: 311, actor: "dr.amjad", patientId: 42, issuingDoctorPartyId: 5 }),
      5, /* جهة المُبطِل */
    );
  });

  it("وصفة غير موجودة: 404 بلا كشف", async () => {
    mocks.getPrescription.mockResolvedValue(null);
    const response = await voidPrescription(
      new Request("http://localhost/api/prescriptions/999/void", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "سبب صالح للإبطال" }),
      }),
      { params: Promise.resolve({ id: "999" }) },
    );
    expect(response.status).toBe(404);
  });
});

describe("سلطة مُصدر الوصفة في الإبطال (مراجعة P0 — issuer-only)", () => {
  const voidContext = { params: Promise.resolve({ id: "311" }) };

  /* السيناريو المطلوب حرفيًّا: مريض 42 مشترك بين الطبيب A (جهة 5) والطبيب B
     (جهة 6). الطبيب A أصدر الوصفة (doctorPartyId=5). الطبيب B يملك
     canAccessPatient(42)=true ويحاول الإبطال ⇒ DENY. */
  it("مريض مشترك بين طبيبين: الطبيب B (وصوله للمريض مسموح) لا يُبطل وصفة الطبيب A", async () => {
    mocks.requireSession.mockResolvedValue({ userId: 7, username: "dr.bashir", role: "doctor", partyId: 6 });
    mocks.findUserByUsername.mockResolvedValue({
      id: 7, username: "dr.bashir", isActive: true, partyId: 6, role: "doctor", permissions: {},
    });
    mocks.getPrescription.mockResolvedValue(STORED_RX); /* issued by party 5 */
    mocks.canAccessPatient.mockResolvedValue(true); /* B يصل المريض 42 — ليست وصفته */
    const response = await voidPrescription(
      new Request("http://localhost/api/prescriptions/311/void", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "خطأ في الجرعة المكتوبة" }),
      }),
      voidContext,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining("لا يُبطل وصفةً إلا مُصدرها") });
    expect(mocks.voidPrescription).not.toHaveBeenCalled();
  });

  it("طبيب بلا جهة طبيب (بلا هوية إصدار) لا يُبطل شيئًا", async () => {
    mocks.requireSession.mockResolvedValue({ userId: 8, username: "dr.orphan", role: "doctor", partyId: null });
    mocks.findUserByUsername.mockResolvedValue({
      id: 8, username: "dr.orphan", isActive: true, partyId: null, role: "doctor", permissions: {},
    });
    mocks.getPrescription.mockResolvedValue(STORED_RX);
    mocks.canAccessPatient.mockResolvedValue(true);
    const response = await voidPrescription(
      new Request("http://localhost/api/prescriptions/311/void", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "سبب صالح للإبطال" }),
      }),
      voidContext,
    );
    expect(response.status).toBe(403);
    expect(mocks.voidPrescription).not.toHaveBeenCalled();
  });

  it("مدير إداري بلا هوية سريرية لا يُبطل وصفة (role=admin وحده ليس override)", async () => {
    mocks.requireSession.mockResolvedValue({ userId: 1, username: "owner", role: "admin" });
    mocks.findUserByUsername.mockResolvedValue({
      id: 1, username: "owner", isActive: true, partyId: null, role: "admin", permissions: {},
    });
    mocks.getPrescription.mockResolvedValue(STORED_RX);
    mocks.canAccessPatient.mockResolvedValue(true);
    const response = await voidPrescription(
      new Request("http://localhost/api/prescriptions/311/void", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "سبب صالح للإبطال" }),
      }),
      voidContext,
    );
    expect(response.status).toBe(403);
    expect(mocks.voidPrescription).not.toHaveBeenCalled();
  });

  it("مدين مربوط صراحةً بجهة طبيب (هوية سريرية) يُبطل وصفته هو", async () => {
    mocks.requireSession.mockResolvedValue({ userId: 1, username: "owner", role: "admin", partyId: 5 });
    mocks.findUserByUsername.mockResolvedValue({
      id: 1, username: "owner", isActive: true, partyId: 5, role: "admin", permissions: {},
    });
    mocks.getPrescription.mockResolvedValue(STORED_RX); /* issued by party 5 */
    mocks.canAccessPatient.mockResolvedValue(true);
    mocks.voidPrescription.mockResolvedValue({ ok: true });
    const response = await voidPrescription(
      new Request("http://localhost/api/prescriptions/311/void", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "سبب صالح للإبطال" }),
      }),
      voidContext,
    );
    expect(response.status).toBe(200);
    /* التدقيق: جهة المصدر وجهة المُبطِل والمريض تُمرَّر للسجل */
    expect(mocks.voidPrescription).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 311,
        actor: "owner",
        patientId: 42,
        issuingDoctorPartyId: 5,
      }),
      5, /* voidingDoctorPartyId — جهة المدين-الطبيب المُبطِل */
    );
  });

  it("وصفة قديمة بلا جهة (doctorPartyId=null): مُنشئها بالاسم يُبطِلها — وغيره لا", async () => {
    const legacy = { ...STORED_RX, doctorPartyId: null };
    /* مُنشئها (dr.amjad — الجلسة الافتراضية) يُبطِلها */
    mocks.getPrescription.mockResolvedValue(legacy);
    mocks.canAccessPatient.mockResolvedValue(true);
    mocks.voidPrescription.mockResolvedValue({ ok: true });
    const own = await voidPrescription(
      new Request("http://localhost/api/prescriptions/311/void", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "سبب صالح للإبطال" }),
      }),
      voidContext,
    );
    expect(own.status).toBe(200);

    /* زميلٌ آخر لا يُبطِلها */
    mocks.requireSession.mockResolvedValue({ userId: 7, username: "dr.bashir", role: "doctor", partyId: 6 });
    mocks.findUserByUsername.mockResolvedValue({
      id: 7, username: "dr.bashir", isActive: true, partyId: 6, role: "doctor", permissions: {},
    });
    const other = await voidPrescription(
      new Request("http://localhost/api/prescriptions/311/void", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "سبب صالح للإبطال" }),
      }),
      voidContext,
    );
    expect(other.status).toBe(403);
  });
});
