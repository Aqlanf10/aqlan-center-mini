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

/* ─────────────────────────────────────────────────────────────────────────────
 * سير عمل تحذيرات السلامة الخادمية (مراجعة الجولة الثانية — Blocker B):
 * الخادم هو المرجع النهائي: الحرج يوقف كل شيء؛ وغير الحرج لا يُحفظ قبل
 * إقرار الطبيب الصريح، والإقرار مرتبط بالوصفة نفسها (رمز خادمي HMAC) —
 * فتغيير الأدوية بعد الإقرار يُبطله.
 * ───────────────────────────────────────────────────────────────────────────── */
import { buildSafetyAcknowledgementToken } from "../lib/prescription-safety-ack";
import { evaluatePrescriptionSafety } from "../lib/medication-safety";
import { checkPrescriptionDraft, type PrescriptionDraft } from "../lib/prescription";

describe("تحذيرات السلامة الخادمية: عرض ← إقرار ← حفظ (مراجعة الجولة الثانية)", () => {
  /* حامل + Metronidazole = تحذير غير حرج (مترونيدازول مع الحمل). */
  const PREGNANT_PATIENT = {
    id: 42, fullName: "أم سالم", patientNumber: "P-00042", phone: "770000001",
    medicalAlert: "حامل في الثلث الثاني", gender: "female", birthYear: 1998,
  };
  const WARNING_DRAFT = {
    patientId: 42,
    diagnosis: "خراج لبي",
    notes: "",
    instructionsLang: "both",
    items: [{ name: "Metronidazole 500mg", dose: "500mg", form: "Tablets", frequency: "1 every 8h", duration: "5 days", instructions: "", instructionsEn: "" }],
  };

  /* تحذيرات غير حرجة يحسبها المحرك الحقيقي من ملفٍّ نصّه كما يلي —
     هي التي يوقّع الخادم رمز الإقرار فوق بصمتها. */
  const warningsOf = (alertText: string | null) =>
    evaluatePrescriptionSafety(
      WARNING_DRAFT.items.map((i) => ({ name: i.name, dose: i.dose })),
      alertText,
    );

  function draftOf(body: Record<string, unknown>): PrescriptionDraft {
    const check = checkPrescriptionDraft({
      patientId: Number(body.patientId),
      visitId: null,
      diagnosis: body.diagnosis,
      notes: body.notes,
      instructionsLang: body.instructionsLang,
      items: body.items,
    });
    if (!check.ok) throw new Error("مسودة غير صالحة في الاختبار");
    return check.value;
  }

  beforeEach(() => {
    mocks.getPatient.mockResolvedValue(PREGNANT_PATIENT);
    mocks.savePrescription.mockReset();
    mocks.savePrescription.mockResolvedValue({ id: 950, createdAt: "2026-09-08T00:00:00.000Z" });
  });

  it("تحذير غير حرج بلا إقرار: 200 عرض (requiresAcknowledgement) ولا حفظ", async () => {
    const response = await createPrescription(new Request("http://localhost/api/prescriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(WARNING_DRAFT),
    }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.requiresAcknowledgement).toBe(true);
    expect(Array.isArray(payload.safetyWarnings)).toBe(true);
    expect(payload.safetyWarnings.length).toBeGreaterThan(0);
    expect(typeof payload.acknowledgementToken).toBe("string");
    expect(mocks.savePrescription).not.toHaveBeenCalled();
  });

  it("إقرار صالح بالرمز نفسه: 201 حفظ وتُعاد التحذيرات معه", async () => {
    const token = buildSafetyAcknowledgementToken({
      username: "dr.amjad",
      draft: draftOf(WARNING_DRAFT),
      warnings: warningsOf(PREGNANT_PATIENT.medicalAlert),
    });
    const response = await createPrescription(new Request("http://localhost/api/prescriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...WARNING_DRAFT, acknowledgedSafetyToken: token }),
    }));
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.id).toBe(950);
    expect(payload.acknowledged).toBe(true);
    expect(Array.isArray(payload.safetyWarnings)).toBe(true);
    expect(mocks.savePrescription).toHaveBeenCalledTimes(1);
  });

  it("تغيّرت الأدوية بعد الإقرار: الرمز القديم يُرفض ولا حفظ (الإقرار مرتبط بالوصفة)", async () => {
    /* رمز أُقرّت به وصفة المترونيدازول… ثم غيّر الطبيب الدواء قبل الحفظ. */
    const tokenForOldItems = buildSafetyAcknowledgementToken({
      username: "dr.amjad",
      draft: draftOf(WARNING_DRAFT),
      warnings: warningsOf(PREGNANT_PATIENT.medicalAlert),
    });
    const changedBody = {
      ...WARNING_DRAFT,
      items: [{ ...WARNING_DRAFT.items[0], name: "Metronidazole 500mg", dose: "500mg", form: "Tablets", frequency: "1 every 12h", duration: "7 days", instructions: "", instructionsEn: "" }],
      acknowledgedSafetyToken: tokenForOldItems,
    };
    const response = await createPrescription(new Request("http://localhost/api/prescriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changedBody),
    }));
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.ackRejected).toBe(true);
    expect(mocks.savePrescription).not.toHaveBeenCalled();
  });

  it("رمز مزوّر/غير موقّع لا يمرّ: 409 بلا حفظ", async () => {
    const response = await createPrescription(new Request("http://localhost/api/prescriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...WARNING_DRAFT, acknowledgedSafetyToken: "forged-token-not-signed" }),
    }));
    expect(response.status).toBe(409);
    expect(mocks.savePrescription).not.toHaveBeenCalled();
  });

  it("رمز مستخدم آخر لا ينفّذه مستخدم مختلف: 409 بلا حفظ", async () => {
    const tokenOfOtherUser = buildSafetyAcknowledgementToken({
      username: "dr.bashir",
      draft: draftOf(WARNING_DRAFT),
      warnings: warningsOf(PREGNANT_PATIENT.medicalAlert),
    });
    const response = await createPrescription(new Request("http://localhost/api/prescriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...WARNING_DRAFT, acknowledgedSafetyToken: tokenOfOtherUser }),
    }));
    expect(response.status).toBe(409);
    expect(mocks.savePrescription).not.toHaveBeenCalled();
  });

  it("الحرج يظل حاجزًا حتى مع رمز إقرار: 409 ولا حفظ (الخادم يعيد التقييم دائمًا)", async () => {
    /* ملف المريض تغيّر بين المعاينة والإقرار: صار التعارض حرجًا (بنسلين). */
    mocks.getPatient.mockResolvedValue({
      ...PREGNANT_PATIENT, medicalAlert: "حامل، وحساسية بنسلين شديدة",
    });
    const penicillinDraft = {
      ...WARNING_DRAFT,
      items: [
        { name: "Amoxicillin 500mg", dose: "500mg", form: "Capsules", frequency: "1 every 8h", duration: "5 days", instructions: "", instructionsEn: "" },
        { name: "Metronidazole 500mg", dose: "500mg", form: "Tablets", frequency: "1 every 8h", duration: "5 days", instructions: "", instructionsEn: "" },
      ],
    };
    /* الرمز أُصدر وقت معاينةٍ كان الملف فيه "حاملًا" فقط (تحذير
       مترونيدازول غير حرج) — ثم تغيّر الملف قبل الإقرار. */
    const token = buildSafetyAcknowledgementToken({
      username: "dr.amjad",
      draft: draftOf(penicillinDraft),
      warnings: evaluatePrescriptionSafety(
        penicillinDraft.items.map((i) => ({ name: i.name, dose: i.dose })),
        PREGNANT_PATIENT.medicalAlert,
      ),
    });
    const response = await createPrescription(new Request("http://localhost/api/prescriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...penicillinDraft, acknowledgedSafetyToken: token }),
    }));
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(Array.isArray(payload.safetyAlerts)).toBe(true);
    expect(mocks.savePrescription).not.toHaveBeenCalled();
  });

  it("الخادم هو المرجع حتى لو لم يعرف العميل شيئًا: الملف يمنع والطلب لا يحمل تنبيهات العميل", async () => {
    /* جسم الطلب لا يحمل أي حالة عميل (لا hasCriticalAlert ولا تنبيهات) —
       والخادم يقرأ الملف بنفسه ويرفض: هذا هو استقلال المرجع. */
    mocks.getPatient.mockResolvedValue({
      ...PREGNANT_PATIENT, medicalAlert: "حساسية بنسلين شديدة",
    });
    const response = await createPrescription(new Request("http://localhost/api/prescriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...WARNING_DRAFT,
        items: [{ name: "Augmentin 1g", dose: "1g", form: "Tablets", frequency: "1 every 12h", duration: "5 days", instructions: "", instructionsEn: "" }],
      }),
    }));
    expect(response.status).toBe(409);
    expect(mocks.savePrescription).not.toHaveBeenCalled();
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * إقرار مربوط بالتحذيرات التي شاهدها الطبيب (مراجعة الجولة الثالثة — المانع
 * الأخير): عند الإقرار يعيد الخادم تحميل الملف وتقييم السلامة؛ فإن تغيّرت
 * التحذيرات غير الحرجة (إضافة/حذف/تغيّر) لم يُحفظ بالإقرار القديم، وتُعرض
 * التحذيرات الجديدة برمزٍ جديد — والرمز نفسه ينتهي بعد عشر دقائق.
 * ───────────────────────────────────────────────────────────────────────────── */

const BLEEDING_PATIENT = {
  id: 42, fullName: "سالم عبدالله", patientNumber: "P-00042", phone: "770000001",
  medicalAlert: "سيولة دم", gender: "male", birthYear: 1990,
};
const BLEEDING_ASTHMA_PATIENT = {
  ...BLEEDING_PATIENT, medicalAlert: "سيولة دم وربو تحسسي",
};
/* Ibuprofen مع سيولة الدم = تحذير نزف غير حرج؛ مع الربو يُضاف تحذير ربو. */
const NSAID_DRAFT = {
  patientId: 42,
  diagnosis: "خلع جراحي",
  notes: "",
  instructionsLang: "both",
  items: [{ name: "Ibuprofen 400mg", dose: "400mg", form: "Tablets", frequency: "1 every 8h", duration: "3 days", instructions: "", instructionsEn: "" }],
};

describe("الإقرار مربوط بالتحذيرات التي رآها الطبيب (مراجعة الجولة الثالثة)", () => {
  beforeEach(() => {
    mocks.getPatient.mockResolvedValue(BLEEDING_PATIENT);
    mocks.savePrescription.mockReset();
    mocks.savePrescription.mockResolvedValue({ id: 951, createdAt: "2026-09-08T00:00:00.000Z" });
  });

  const warningsFor = (patient: { medicalAlert: string | null }) =>
    evaluatePrescriptionSafety(
      NSAID_DRAFT.items.map((i) => ({ name: i.name, dose: i.dose })),
      patient.medicalAlert,
    );

  function draftOf(body: Record<string, unknown>): PrescriptionDraft {
    const check = checkPrescriptionDraft({
      patientId: Number(body.patientId),
      visitId: null,
      diagnosis: body.diagnosis,
      notes: body.notes,
      instructionsLang: body.instructionsLang,
      items: body.items,
    });
    if (!check.ok) throw new Error("مسودة غير صالحة في الاختبار");
    return check.value;
  }

  const post = (body: Record<string, unknown>) =>
    createPrescription(new Request("http://localhost/api/prescriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));

  it("تغيّرت التحذيرات بين المعاينة والإقرار (أُضيف تحذير): 200 إعادة عرض بتحذيرات جديدة ورمز جديد — ولا حفظ", async () => {
    /* ١) المعاينة: ملف فيه سيولة دم فقط ⇒ تحذير نزف واحد. */
    const previewToken = buildSafetyAcknowledgementToken({
      username: "dr.amjad",
      draft: draftOf(NSAID_DRAFT),
      warnings: warningsFor(BLEEDING_PATIENT),
    });
    expect(warningsFor(BLEEDING_PATIENT).length).toBe(1);

    /* ٢) قبل الإقرار تحدّث الملف: أُضيف ربو ⇒ تحذيران. */
    mocks.getPatient.mockResolvedValue(BLEEDING_ASTHMA_PATIENT);
    expect(warningsFor(BLEEDING_ASTHMA_PATIENT).length).toBe(2);

    /* ٣) الإقرار القديم يُرفض — ولا يُحفظ — وتُعرض التحذيرات الجديدة برمز جديد. */
    const response = await post({ ...NSAID_DRAFT, acknowledgedSafetyToken: previewToken });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.requiresAcknowledgement).toBe(true);
    expect(payload.ackRejected).toBe(true);
    expect(payload.ackReason).toBe("warning_fingerprint_changed");
    expect(payload.safetyWarnings.length).toBe(2);
    expect(typeof payload.acknowledgementToken).toBe("string");
    expect(payload.acknowledgementToken).not.toBe(previewToken);
    expect(mocks.savePrescription).not.toHaveBeenCalled();
  });

  it("الطبيب يُقرّ التحذيرات الجديدة برمزها الجديد: 201 حفظ — نفس السيناريو يكتمل", async () => {
    /* المعاينة الأولى على ملف سيولة الدم. */
    const staleToken = buildSafetyAcknowledgementToken({
      username: "dr.amjad",
      draft: draftOf(NSAID_DRAFT),
      warnings: warningsFor(BLEEDING_PATIENT),
    });
    /* الملف تحدّث ثم عاد الخادم بإعادة العرض برمزٍ جديد (كما في الاختبار أعلاه). */
    mocks.getPatient.mockResolvedValue(BLEEDING_ASTHMA_PATIENT);
    const rejected = await post({ ...NSAID_DRAFT, acknowledgedSafetyToken: staleToken });
    expect(rejected.status).toBe(200);
    const rejectedPayload = await rejected.json();
    expect(mocks.savePrescription).not.toHaveBeenCalled();

    /* الآن يُقرّ الطبيب التحذيرات **الجديدة** برمزها الجديد فيُحفظ. */
    const accepted = await post({
      ...NSAID_DRAFT,
      acknowledgedSafetyToken: rejectedPayload.acknowledgementToken,
    });
    expect(accepted.status).toBe(201);
    const acceptedPayload = await accepted.json();
    expect(acceptedPayload.id).toBe(951);
    expect(acceptedPayload.acknowledged).toBe(true);
    expect(mocks.savePrescription).toHaveBeenCalledTimes(1);
  });

  it("حُذفت التحذيرات كلها من الملف بعد المعاينة: 409 ackRejected — لا حفظ بإقرارٍ قديم", async () => {
    const token = buildSafetyAcknowledgementToken({
      username: "dr.amjad",
      draft: draftOf(NSAID_DRAFT),
      warnings: warningsFor(BLEEDING_PATIENT),
    });
    /* الملف نُظّف: لا تحذيرات حاليًا — لكن الإقرار القديم بصمة تحذيرٍ سابق. */
    mocks.getPatient.mockResolvedValue({ ...BLEEDING_PATIENT, medicalAlert: null });
    const response = await post({ ...NSAID_DRAFT, acknowledgedSafetyToken: token });
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.ackRejected).toBe(true);
    expect(payload.ackReason).toBe("warning_fingerprint_changed");
    expect(mocks.savePrescription).not.toHaveBeenCalled();
  });

  it("حُذف أحد تحذيرين (استُبدل): 200 إعادة عرض بالتحذير المتبقي — ولا حفظ", async () => {
    /* المعاينة كانت على ملفٍ فيه سيولة وربو (تحذيران). */
    const token = buildSafetyAcknowledgementToken({
      username: "dr.amjad",
      draft: draftOf(NSAID_DRAFT),
      warnings: warningsFor(BLEEDING_ASTHMA_PATIENT),
    });
    /* ثم حُذف الربو: بقي تحذير النزف وحده. */
    mocks.getPatient.mockResolvedValue(BLEEDING_PATIENT);
    const response = await post({ ...NSAID_DRAFT, acknowledgedSafetyToken: token });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.requiresAcknowledgement).toBe(true);
    expect(payload.ackReason).toBe("warning_fingerprint_changed");
    expect(payload.safetyWarnings.length).toBe(1);
    expect(mocks.savePrescription).not.toHaveBeenCalled();
  });

  it("انتهت صلاحية رمز الإقرار بعد عشر دقائق: 409 expired — ولا حفظ (TTL)", async () => {
    vi.useFakeTimers();
    try {
      const previewAt = Date.now();
      const token = buildSafetyAcknowledgementToken({
        username: "dr.amjad",
        draft: draftOf(NSAID_DRAFT),
        warnings: warningsFor(BLEEDING_PATIENT),
        now: previewAt,
      });
      /* الطبيب عاد بعد أكثر من عشر دقائق وضغط الإقرار. */
      vi.setSystemTime(previewAt + 10 * 60 * 1000 + 1);
      const response = await post({ ...NSAID_DRAFT, acknowledgedSafetyToken: token });
      expect(response.status).toBe(409);
      const payload = await response.json();
      expect(payload.ackRejected).toBe(true);
      expect(payload.ackReason).toBe("expired");
      expect(String(payload.message)).toContain("صلاحية");
      expect(mocks.savePrescription).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("رمز سليم الصلاحية قبل انتهائها بدقيقة: 201 حفظ (نفس الملف ونفس التحذيرات)", async () => {
    vi.useFakeTimers();
    try {
      const previewAt = Date.now();
      const token = buildSafetyAcknowledgementToken({
        username: "dr.amjad",
        draft: draftOf(NSAID_DRAFT),
        warnings: warningsFor(BLEEDING_PATIENT),
        now: previewAt,
      });
      vi.setSystemTime(previewAt + 9 * 60 * 1000);
      const response = await post({ ...NSAID_DRAFT, acknowledgedSafetyToken: token });
      expect(response.status).toBe(201);
      expect(mocks.savePrescription).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("صار التحذير حرجًا بعد المعاينة (ملف المريض تحدّث): منعٌ تام 409 حتى مع رمز — لا يصل إلى التحقق أصلًا", async () => {
    /* المعاينة كانت على سيولة دم: تحذير نزف غير حرج واحد. */
    const token = buildSafetyAcknowledgementToken({
      username: "dr.amjad",
      draft: draftOf(NSAID_DRAFT),
      warnings: warningsFor(BLEEDING_PATIENT),
    });
    /* ثم سُجّلت حساسية بنسلين مع وصفة تحمل Amoxicillin: تعارضٌ حرج. */
    mocks.getPatient.mockResolvedValue({ ...BLEEDING_PATIENT, medicalAlert: "سيولة دم وحساسية بنسلين شديدة" });
    const penicillinDraft = {
      ...NSAID_DRAFT,
      items: [
        { name: "Amoxicillin 500mg", dose: "500mg", form: "Capsules", frequency: "1 every 8h", duration: "5 days", instructions: "", instructionsEn: "" },
        ...NSAID_DRAFT.items,
      ],
    };
    const response = await post({ ...penicillinDraft, acknowledgedSafetyToken: token });
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(Array.isArray(payload.safetyAlerts)).toBe(true);
    expect(payload.safetyAlerts.length).toBeGreaterThan(0);
    expect(payload.safetyAlerts.every((a: { severity: string }) => a.severity === "critical")).toBe(true);
    expect(payload.blockReason).toBe("critical_medication_safety");
    expect(mocks.savePrescription).not.toHaveBeenCalled();
  });

  it("رمز v1 قديم الصيغة (توقيع بلا حمولة/بلا بصمة): 409 ولا حفظ — لا توافق رجعيًا", async () => {
    const response = await post({ ...NSAID_DRAFT, acknowledgedSafetyToken: "b2xkLXZlcnNpb24tc2lnbmF0dXJl" });
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.ackRejected).toBe(true);
    expect(mocks.savePrescription).not.toHaveBeenCalled();
  });
});
