import { describe, expect, it } from "vitest";

/**
 * اختبارات سير عمل السلامة الدوائية وقوالب الإجراءات
 * (مراجعة P0 المستقلة — الجولة الثانية، Blockers A وB).
 *
 * ١) المنطق النقي الذي تستهلكه واجهة الوصفة (interpretPrescriptionSaveResponse):
 *    الحرج ⇒ توقّف تام بلا طباعة رسمية وبلا سقوط تلقائي للمسودة؛ التحذيرات
 *    غير الحرجة ⇒ انتظار الإقرار؛ الإقرار المرفوض ⇒ إعادة العرض؛ النظيف ⇒
 *    الطباعة الرسمية الطبيعية؛ والخادم هو المرجع لا فحص العميل.
 * ٢) قوالب الإجراءات والتشخيصات: لا دواء ولا جرعة في أي قالب، ولكل قالب
 *    قائمة تحقق سريرية — لا regimen جاهز بضغطة واحدة.
 */

import { interpretPrescriptionSaveResponse } from "../lib/prescription-save-workflow";
import { PROCEDURE_TEMPLATES } from "../lib/prescription-procedure-templates";
import {
  buildSafetyAcknowledgementToken,
  verifySafetyAcknowledgementToken,
} from "../lib/prescription-safety-ack";
import { checkPrescriptionDraft, type PrescriptionDraft } from "../lib/prescription";

const DRAFT_BODY = {
  patientId: 42,
  diagnosis: "خراج لبي",
  notes: "",
  instructionsLang: "both",
  items: [{ name: "Metronidazole 500mg", dose: "500mg", form: "Tablets", frequency: "1 every 8h", duration: "5 days", instructions: "", instructionsEn: "" }],
};

function draftOf(body: Record<string, unknown> = DRAFT_BODY): PrescriptionDraft {
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

describe("سير عمل حفظ الوصفة — الخادم هو المرجع (Blocker B)", () => {
  it("حرج (409 + safetyAlerts): توقّف تام — لا officialPrint ولا draftFallback", () => {
    const outcome = interpretPrescriptionSaveResponse(409, {
      message: "تعارض دوائي حرج",
      safetyAlerts: [{ id: "x", medicationName: "Augmentin 1g", severity: "critical", title: "خطر", message: "…" }],
      blockReason: "critical_medication_safety",
    });
    expect(outcome.kind).toBe("criticalBlock");
    /* لا officialPrint ولا draftFallback: المنع الحرج لا يسقط تلقائيًا لمسودة. */
    expect(outcome.kind).not.toBe("officialPrint");
    expect(outcome.kind).not.toBe("draftFallback");
  });

  it("تحذير غير حرج (200 + requiresAcknowledgement): لا طباعة رسمية قبل الإقرار", () => {
    const outcome = interpretPrescriptionSaveResponse(200, {
      requiresAcknowledgement: true,
      safetyWarnings: [{ id: "w", medicationName: "Metronidazole 500mg", severity: "warning", title: "تنبيه", message: "…" }],
      acknowledgementToken: "server-issued-token",
    });
    expect(outcome.kind).toBe("awaitAcknowledgement");
    if (outcome.kind === "awaitAcknowledgement") {
      expect(outcome.acknowledgementToken).toBe("server-issued-token");
      expect(outcome.safetyWarnings.length).toBe(1);
    }
  });

  it("إقرار مرفوض (409 + ackRejected): إبطال الإقرار القديم بعد تغيّر الأدوية", () => {
    const outcome = interpretPrescriptionSaveResponse(409, {
      message: "الوصفة تغيّرت بعد الإقرار",
      ackRejected: true,
    });
    expect(outcome.kind).toBe("acknowledgementRejected");
  });

  it("ناجح نظيف (201 + id): الطباعة الرسمية الطبيعية كما كانت", () => {
    const outcome = interpretPrescriptionSaveResponse(201, { id: 311, createdAt: "2026-09-08" });
    expect(outcome.kind).toBe("officialPrint");
    if (outcome.kind === "officialPrint") {
      expect(outcome.prescriptionId).toBe(311);
      expect(outcome.safetyWarnings).toEqual([]);
    }
  });

  it("ناجح بعد إقرار (201 + safetyWarnings): رسمية مع التحذيرات المُقرّة", () => {
    const outcome = interpretPrescriptionSaveResponse(201, {
      id: 312,
      safetyWarnings: [{ id: "w", medicationName: "Metronidazole 500mg", severity: "warning", title: "تنبيه", message: "…" }],
      acknowledged: true,
    });
    expect(outcome.kind).toBe("officialPrint");
    if (outcome.kind === "officialPrint") {
      expect(outcome.safetyWarnings.length).toBe(1);
    }
  });

  it("فشل غير حرج (500/شبكة): draftFallback معلن — وليس بديلاً بعد منعٍ حرج", () => {
    expect(interpretPrescriptionSaveResponse(500, { message: "تعذّر الحفظ" }).kind).toBe("draftFallback");
    expect(interpretPrescriptionSaveResponse(500, null).kind).toBe("draftFallback");
    expect(interpretPrescriptionSaveResponse(0, null).kind).toBe("draftFallback");
  });

  it("رد 200 بلا id ولا متطلب إقرار (عميل قديم): fallback لا رسمية", () => {
    expect(interpretPrescriptionSaveResponse(200, { message: "…" }).kind).toBe("draftFallback");
  });

  it("الخادم هو المرجع: ردّه الحرج يوقف الطباعة حتى لو كان العميل يظنّ لا تنبيه", () => {
    /* العميل لا يُرسل حالته أصلًا — الترجمة تقرأ الردّ الخادمي وحده. */
    const outcome = interpretPrescriptionSaveResponse(409, {
      message: "تعارض دوائي حرج مع التنبيهات الطبية المسجلة",
      safetyAlerts: [
        { id: "a", medicationName: "Augmentin 1g", severity: "critical", title: "خطر تحسسي حرج", message: "…" },
      ],
    });
    expect(outcome.kind).toBe("criticalBlock");
  });
});

describe("ربط الإقرار بالوصفة نفسها (Safety Ack Binding)", () => {
  it("الرمز يُصادق نفس الوصفة ونفس المستخدم", () => {
    const token = buildSafetyAcknowledgementToken({ username: "dr.amjad", draft: draftOf() });
    expect(verifySafetyAcknowledgementToken(token, { username: "dr.amjad", draft: draftOf() })).toBe(true);
  });

  it("تغيير دواء واحد بعد الإقرار يُبطل الرمز (dose/frequency/duration)", () => {
    const token = buildSafetyAcknowledgementToken({ username: "dr.amjad", draft: draftOf() });
    const changed = draftOf();
    changed.items[0].dose = "250mg";
    expect(verifySafetyAcknowledgementToken(token, { username: "dr.amjad", draft: changed })).toBe(false);

    const changedFreq = draftOf();
    changedFreq.items[0].frequency = "1 every 12h";
    expect(verifySafetyAcknowledgementToken(token, { username: "dr.amjad", draft: changedFreq })).toBe(false);
  });

  it("إضافة/حذف دواء بعد الإقرار تُبطل الرمز", () => {
    const token = buildSafetyAcknowledgementToken({ username: "dr.amjad", draft: draftOf() });
    const added = draftOf();
    added.items.push({ name: "Ibuprofen 400mg", dose: "400mg", form: "Tablets", frequency: "1 every 8h", duration: "3 days", instructions: "", instructionsEn: "" });
    expect(verifySafetyAcknowledgementToken(token, { username: "dr.amjad", draft: added })).toBe(false);

    const removed = draftOf();
    removed.items = [];
    expect(verifySafetyAcknowledgementToken(token, { username: "dr.amjad", draft: removed })).toBe(false);
  });

  it("رمز مستخدمٍ لا يصادق مستخدمًا آخر (نفس الوصفة حرفيًا)", () => {
    const token = buildSafetyAcknowledgementToken({ username: "dr.amjad", draft: draftOf() });
    expect(verifySafetyAcknowledgementToken(token, { username: "dr.bashir", draft: draftOf() })).toBe(false);
  });

  it("الرموز غير الصالحة/المزوّرة تُرفض جملةً", () => {
    expect(verifySafetyAcknowledgementToken(null, { username: "dr.amjad", draft: draftOf() })).toBe(false);
    expect(verifySafetyAcknowledgementToken("", { username: "dr.amjad", draft: draftOf() })).toBe(false);
    expect(verifySafetyAcknowledgementToken("not-a-real-token", { username: "dr.amjad", draft: draftOf() })).toBe(false);
    expect(verifySafetyAcknowledgementToken(12345, { username: "dr.amjad", draft: draftOf() })).toBe(false);
  });

  it("مريض آخر أو تشخيص آخر: رمزٌ مختلف (لا يعاد استخدامه عبر المرضى)", () => {
    const token = buildSafetyAcknowledgementToken({ username: "dr.amjad", draft: draftOf() });
    const otherPatient = draftOf({ ...DRAFT_BODY, patientId: 43 });
    expect(verifySafetyAcknowledgementToken(token, { username: "dr.amjad", draft: otherPatient })).toBe(false);
    const otherDiagnosis = draftOf({ ...DRAFT_BODY, diagnosis: "تشخيص مختلف" });
    expect(verifySafetyAcknowledgementToken(token, { username: "dr.amjad", draft: otherDiagnosis })).toBe(false);
  });
});

describe("قوالب الإجراءات والتشخيصات — لا أدوية (Blocker A)", () => {
  it("لا قالب يحمل دواءً أو جرعة: الحقول الدوائية غير موجودة أصلًا في النوع", () => {
    for (const template of PROCEDURE_TEMPLATES) {
      const record = template as unknown as Record<string, unknown>;
      expect(record.items, `${template.title}: قالب يحمل أدوية!`).toBeUndefined();
      expect(record.drugs, `${template.title}: قالب يحمل أدوية!`).toBeUndefined();
      expect(record.medications, `${template.title}: قالب يحمل أدوية!`).toBeUndefined();
    }
  });

  it("نصوص القوالب لا تحمل أسماء المضادات/المسكنات الشائعة — لا regimen جاهز", () => {
    const forbidden = [
      /* «بنسلين» مذكورة في قوائم التحقق كحساسيةٍ يجب سؤال المريض عنها — ذلك
       * تذكيرٌ سريري مشروع لا وصفة؛ لذا لا تُدرج هنا. المحظور هو الأدوية
       * ذاتها (أسماء عالمات تجارية ومسميات دوائية) كـregimen جاهز. */
      "amoxicillin", "augmentin", "metronidazole", "flagyl", "spiramycin", "rodogyl",
      "ibuprofen", "brufen", "diclofenac", "cataflam", "dexketoprofen", "keral",
      "paracetamol", "panadol", "adol", "clindamycin", "azithromycin", "chlorhexidine",
      "kenalog", "triamcinolone", "sensodyne",
      "أوجمنتين", "اوغمنتين", "أموكسيسيلين", "اموكسيسيلين", "مترونيدازول", "فلاجيل",
      "بروفين", "كتافلام", "فولتارين",
    ];
    const haystacks = PROCEDURE_TEMPLATES.map((t) =>
      `${t.title}\n${t.diagnosis}\n${t.notes}\n${t.contextChecklist.join("\n")}`,
    );
    for (const forbidden_ of forbidden) {
      for (let i = 0; i < haystacks.length; i++) {
        expect(
          haystacks[i].toLowerCase().includes(forbidden_.toLowerCase()),
          `القالب «${PROCEDURE_TEMPLATES[i].title}» يذكر دواءً محظورًا: ${forbidden_}`,
        ).toBe(false);
      }
    }
  });

  it("كل قالب له تشخيص وملاحظات وقائمة تحقق سريرية غير فارغة", () => {
    expect(PROCEDURE_TEMPLATES.length).toBeGreaterThanOrEqual(8);
    for (const template of PROCEDURE_TEMPLATES) {
      expect(template.title.trim().length).toBeGreaterThan(3);
      expect(template.diagnosis.trim().length).toBeGreaterThan(3);
      expect(template.notes.trim().length).toBeGreaterThan(20);
      expect(template.contextChecklist.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("قوالب الحالات الشائعة موجودة (خلع/خراج/زراعة/أطفال/لثة) لكن بلا أدوية", () => {
    const titles = PROCEDURE_TEMPLATES.map((t) => `${t.title} ${t.diagnosis}`).join(" | ");
    expect(titles).toContain("خلع جراحي");
    expect(titles).toContain("خراج");
    expect(titles).toContain("زراعة");
    expect(titles).toContain("أطفال");
    expect(titles).toContain("دواعم");
  });

  it("قوالب الأطفال والخلع تشترط الوزن والعمر في قائمة التحقق قبل أي دواء وزني", () => {
    const pediatric = PROCEDURE_TEMPLATES.find((t) => t.title.includes("أطفال"));
    expect(pediatric).toBeDefined();
    expect(pediatric!.contextChecklist.some((c) => c.includes("الوزن"))).toBe(true);

    const extraction = PROCEDURE_TEMPLATES.find((t) => t.title.includes("خلع"));
    expect(extraction).toBeDefined();
    expect(extraction!.contextChecklist.some((c) => c.includes("الوزن") || c.includes("العمر"))).toBe(true);
  });

  it("قوالب العدوى تذكّر بالاستطباب الميكروبي وضبط المصدر — لا مضاد افتراضي", () => {
    const infectionTemplates = PROCEDURE_TEMPLATES.filter((t) =>
      t.title.includes("خلع") || t.title.includes("خراج") || t.title.includes("دواعم") || t.diagnosis.toLowerCase().includes("infection"),
    );
    expect(infectionTemplates.length).toBeGreaterThanOrEqual(3);
    for (const template of infectionTemplates) {
      const checklist = template.contextChecklist.join(" ");
      expect(
        checklist.includes("الاستطباب") || checklist.includes("ضبط المصدر") || checklist.includes("مضاد حيوي"),
        `${template.title}: لا ذكر للاستطباب الميكروبي/ضبط المصدر`,
      ).toBe(true);
    }
  });

  it("«لا تنبيه مسجل ≠ سليم»: القوالب لا تدّعي خلوّ المريض من الموانع", () => {
    const all = PROCEDURE_TEMPLATES.map((t) => `${t.title}\n${t.notes}\n${t.contextChecklist.join("\n")}`).join("\n");
    expect(all).not.toContain("مريض سليم");
    expect(all).not.toContain("لا موانع");
  });
});
