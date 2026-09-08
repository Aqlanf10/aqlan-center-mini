import { describe, expect, it } from "vitest";

/**
 * اختبارات ربط إقرار تحذيرات السلامة بالتحذيرات نفسها
 * (مراجعة P0 المستقلة — الجولة الثالثة، المانع الأخير:
 * Prescription Safety Acknowledgement Binding).
 *
 * الحالات العشر الإلزامية حرفيًا كما طلبتها المراجعة:
 *  ١) نفس الوصفة + نفس التحذيرات + صلاحية سارية ⇒ سماح.
 *  ٢) نفس الوصفة + تغيّرت مجموعة التحذيرات غير الحرجة ⇒ رفض.
 *  ٣) نفس الوصفة + أُضيف تحذير ⇒ رفض.
 *  ٤) نفس الوصفة + حُذف تحذير ⇒ رفض.
 *  ٥) تغيّرت خطورة تحذير ⇒ رفض.
 *  ٦) تغيّرت قاعدة السلامة (هوية القاعدة/الخطر) ⇒ رفض.
 *  ٧) انتهت صلاحية الرمز (TTL) ⇒ رفض.
 *  ٨) مستخدم مختلف ⇒ رفض.
 *  ٩) تغيّر دواء/جرعة ⇒ رفض كما هو حاليًا.
 * ١٠) صار التحذير حرجًا بعد المعاينة ⇒ منعٌ تام (في مسار الخادم —
 *     اختبار المسار في prescription-security.test.ts).
 *
 * إضافةً إلى البصمة الكانونية: استقلالها عن ترتيب النتائج.
 */

import {
  SAFETY_ACK_TTL_MS,
  buildSafetyAcknowledgementToken,
  canonicalWarningsForFingerprint,
  verifySafetyAcknowledgementToken,
  warningFingerprint,
} from "../lib/prescription-safety-ack";
import { evaluatePrescriptionSafety, type DrugSafetyAlert } from "../lib/medication-safety";
import { checkPrescriptionDraft, type PrescriptionDraft } from "../lib/prescription";

/* نقطة زمنية ثابتة للساعة المحقونة — لا اعتماد على Date.now(). */
const T0 = 1_800_000_000_000;
const USERNAME = "dr.amjad";

const DRAFT_BODY = {
  patientId: 42,
  diagnosis: "خراج لبي",
  notes: "",
  instructionsLang: "both",
  items: [{ name: "Ibuprofen 400mg", dose: "400mg", form: "Tablets", frequency: "1 every 8h", duration: "3 days", instructions: "", instructionsEn: "" }],
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

/* التحذيرات تُحسب بالمحرك الحقيقي من ملفٍّ افتراضي — لا اختلاق يدوي:
 * «سيولة دم» مع Ibuprofen ⇒ تحذير نزف واحد غير حرج. */
const ALERT_BLEEDING = "سيولة دم";
const ALERT_BLEEDING_ASTHMA = "سيولة دم وربو تحسسي";

const warningsOf = (alertText: string, body: Record<string, unknown> = DRAFT_BODY): DrugSafetyAlert[] =>
  evaluatePrescriptionSafety(
    (body.items as { name: string; dose?: string }[]).map((i) => ({ name: i.name, dose: i.dose })),
    alertText,
  );

describe("البصمة الكانونية للتحذيرات (canonical warning fingerprint)", () => {
  it("TTL الرمز عشر دقائق — ضمن نطاق ٥–١٠ دقائق الذي حدّدته المراجعة", () => {
    expect(SAFETY_ACK_TTL_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(SAFETY_ACK_TTL_MS).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it("البصمة لا تعتمد على ترتيب النتائج: نفس المجموعة بأي ترتيب = نفس البصمة", () => {
    const setA = warningsOf(ALERT_BLEEDING_ASTHMA); /* [نزف، ربو] مرتّبة بالمحرك */
    const shuffled = [...setA].reverse();
    expect(warningFingerprint(shuffled)).toBe(warningFingerprint(setA));
    expect(canonicalWarningsForFingerprint(shuffled)).toBe(canonicalWarningsForFingerprint(setA));
  });

  it("البصمة تتغيّر مع كل عنصر هوية: القاعدة/الخطورة/الدواء/النص", () => {
    const base = warningsOf(ALERT_BLEEDING); /* تحذير نزف Ibuprofen واحد */
    expect(base.length).toBe(1);
    const fp0 = warningFingerprint(base);

    /* تغيّر الخطورة (severity). */
    const sevChanged = base.map((w) => ({ ...w, severity: "info" as const }));
    expect(warningFingerprint(sevChanged)).not.toBe(fp0);

    /* تغيّر هوية القاعدة (id + risk). */
    const ruleChanged = base.map((w) => ({
      ...w,
      id: w.id.replace("bleeding_nsaid_warning", "kidney_nsaid_warning"),
      contraindicatedRiskId: "kidney_liver",
    }));
    expect(warningFingerprint(ruleChanged)).not.toBe(fp0);

    /* تغيّر الدواء. */
    const medChanged = base.map((w) => ({ ...w, medicationName: "Diclofenac 50mg" }));
    expect(warningFingerprint(medChanged)).not.toBe(fp0);

    /* تغيّر النص (title/message) — نص التحذير جزء مما رآه الطبيب. */
    const msgChanged = base.map((w) => ({ ...w, message: `${w.message} (نص محدّث)"` }));
    expect(warningFingerprint(msgChanged)).not.toBe(fp0);
  });

  it("إضافة/حذف تحذير يغيّران البصمة (multiset: التكرار يُحفظ)", () => {
    const one = warningsOf(ALERT_BLEEDING);
    const two = warningsOf(ALERT_BLEEDING_ASTHMA);
    expect(one.length).toBe(1);
    expect(two.length).toBe(2);
    expect(warningFingerprint(two)).not.toBe(warningFingerprint(one));
    expect(warningFingerprint([...one, ...one])).not.toBe(warningFingerprint(one));
  });

  it("المجموعة الفارغة بصمة ثابتة مستقلة عن أي مجموعة غير فارغة", () => {
    expect(warningFingerprint([])).not.toBe(warningFingerprint(warningsOf(ALERT_BLEEDING)));
    expect(warningFingerprint([])).toBe(warningFingerprint([]));
  });
});

describe("ربط رمز الإقرار بالتحذيرات + الصلاحية (الحالات العشر الإلزامية)", () => {
  it("١) نفس الوصفة + نفس التحذيرات + صلاحية سارية ⇒ سماح", () => {
    const draft = draftOf();
    const warnings = warningsOf(ALERT_BLEEDING);
    const token = buildSafetyAcknowledgementToken({ username: USERNAME, draft, warnings, now: T0 });
    /* بعد ٩ دقائق — ما زال داخل العشر دقائق. */
    const verdict = verifySafetyAcknowledgementToken(token, {
      username: USERNAME,
      draft: draftOf(),
      warnings: warningsOf(ALERT_BLEEDING),
      now: T0 + 9 * 60 * 1000,
    });
    expect(verdict.ok).toBe(true);
  });

  it("١-ت) سماح الرمز لا يتأثر بترتيب نفس التحذيرات عند التحقق", () => {
    const draft = draftOf();
    const warnings = warningsOf(ALERT_BLEEDING_ASTHMA);
    const token = buildSafetyAcknowledgementToken({ username: USERNAME, draft, warnings, now: T0 });
    const verdict = verifySafetyAcknowledgementToken(token, {
      username: USERNAME,
      draft: draftOf(),
      warnings: [...warnings].reverse(),
      now: T0 + 60 * 1000,
    });
    expect(verdict.ok).toBe(true);
  });

  it("٢) نفس الوصفة + تغيّرت مجموعة التحذيرات غير الحرجة ⇒ رفض (بصمة مختلفة)", () => {
    const draft = draftOf();
    const token = buildSafetyAcknowledgementToken({
      username: USERNAME,
      draft,
      warnings: warningsOf(ALERT_BLEEDING),
      now: T0,
    });
    /* الملف تغيّر: تحذير النزف استُبدل بتحذير القصور الكلوي. */
    const verdict = verifySafetyAcknowledgementToken(token, {
      username: USERNAME,
      draft: draftOf(),
      warnings: warningsOf("سيولة دم وفشل كلوي"),
      now: T0 + 60 * 1000,
    });
    expect(verdict).toEqual({ ok: false, failure: "warning_fingerprint_changed" });
  });

  it("٣) نفس الوصفة + أُضيف تحذير ⇒ رفض", () => {
    const draft = draftOf();
    const token = buildSafetyAcknowledgementToken({
      username: USERNAME,
      draft,
      warnings: warningsOf(ALERT_BLEEDING),
      now: T0,
    });
    /* أُضيف ربو إلى الملف: تحذير إضافي لم يقرّه الطبيب. */
    const verdict = verifySafetyAcknowledgementToken(token, {
      username: USERNAME,
      draft: draftOf(),
      warnings: warningsOf(ALERT_BLEEDING_ASTHMA),
      now: T0 + 60 * 1000,
    });
    expect(verdict).toEqual({ ok: false, failure: "warning_fingerprint_changed" });
  });

  it("٤) نفس الوصفة + حُذف تحذير (حتى حذفها كلها) ⇒ رفض", () => {
    const draft = draftOf();
    const token = buildSafetyAcknowledgementToken({
      username: USERNAME,
      draft,
      warnings: warningsOf(ALERT_BLEEDING),
      now: T0,
    });
    /* حُذف التحذير الوحيد — الحالة الحالية بلا تحذيرات، لكن الإقرار القديم
     * لا يغطيها: البصمة الموقّعة ≠ بصمة المجموعة الفارغة. */
    const verdict = verifySafetyAcknowledgementToken(token, {
      username: USERNAME,
      draft: draftOf(),
      warnings: [],
      now: T0 + 60 * 1000,
    });
    expect(verdict).toEqual({ ok: false, failure: "warning_fingerprint_changed" });

    /* وحذف أحد تحذيرين كذلك. */
    const token2 = buildSafetyAcknowledgementToken({
      username: USERNAME,
      draft,
      warnings: warningsOf(ALERT_BLEEDING_ASTHMA),
      now: T0,
    });
    const verdict2 = verifySafetyAcknowledgementToken(token2, {
      username: USERNAME,
      draft: draftOf(),
      warnings: warningsOf(ALERT_BLEEDING),
      now: T0 + 60 * 1000,
    });
    expect(verdict2).toEqual({ ok: false, failure: "warning_fingerprint_changed" });
  });

  it("٥) تغيّرت خطورة تحذير (warning→info وwarning→critical) ⇒ رفض", () => {
    const draft = draftOf();
    const warnings = warningsOf(ALERT_BLEEDING);
    const token = buildSafetyAcknowledgementToken({ username: USERNAME, draft, warnings, now: T0 });

    const severityToInfo = warnings.map((w) => ({ ...w, severity: "info" as const }));
    expect(
      verifySafetyAcknowledgementToken(token, { username: USERNAME, draft: draftOf(), warnings: severityToInfo, now: T0 + 60 * 1000 }),
    ).toEqual({ ok: false, failure: "warning_fingerprint_changed" });

    const severityToCritical = warnings.map((w) => ({ ...w, severity: "critical" as const }));
    expect(
      verifySafetyAcknowledgementToken(token, { username: USERNAME, draft: draftOf(), warnings: severityToCritical, now: T0 + 60 * 1000 }),
    ).toEqual({ ok: false, failure: "warning_fingerprint_changed" });
  });

  it("٦) تغيّرت قاعدة السلامة (هوية القاعدة/الخطر المستهدف) ⇒ رفض", () => {
    const draft = draftOf();
    const warnings = warningsOf(ALERT_BLEEDING);
    const token = buildSafetyAcknowledgementToken({ username: USERNAME, draft, warnings, now: T0 });

    const ruleChanged = warnings.map((w) => ({
      ...w,
      id: w.id.replace("bleeding_nsaid_warning", "asthma_nsaid_warning"),
      contraindicatedRiskId: "asthma",
    }));
    expect(
      verifySafetyAcknowledgementToken(token, { username: USERNAME, draft: draftOf(), warnings: ruleChanged, now: T0 + 60 * 1000 }),
    ).toEqual({ ok: false, failure: "warning_fingerprint_changed" });
  });

  it("٧) انتهت صلاحية الرمز (تجاوز TTL) ⇒ رفض — والحدّ الفاصل دقيق", () => {
    const draft = draftOf();
    const warnings = warningsOf(ALERT_BLEEDING);
    const token = buildSafetyAcknowledgementToken({ username: USERNAME, draft, warnings, now: T0 });

    /* عند الحرف الأخير من العمر: داخل الصلاحية. */
    expect(
      verifySafetyAcknowledgementToken(token, { username: USERNAME, draft: draftOf(), warnings, now: T0 + SAFETY_ACK_TTL_MS - 1 }),
    ).toEqual({ ok: true });
    /* بعده مباشرة: منتهٍ. */
    expect(
      verifySafetyAcknowledgementToken(token, { username: USERNAME, draft: draftOf(), warnings, now: T0 + SAFETY_ACK_TTL_MS }),
    ).toEqual({ ok: false, failure: "expired" });
    /* وبعد ربع ساعة كذلك. */
    expect(
      verifySafetyAcknowledgementToken(token, { username: USERNAME, draft: draftOf(), warnings, now: T0 + 15 * 60 * 1000 }),
    ).toEqual({ ok: false, failure: "expired" });
  });

  it("٨) مستخدم مختلف (نفس الوصفة ونفس التحذيرات) ⇒ رفض", () => {
    const draft = draftOf();
    const warnings = warningsOf(ALERT_BLEEDING);
    const token = buildSafetyAcknowledgementToken({ username: USERNAME, draft, warnings, now: T0 });
    expect(
      verifySafetyAcknowledgementToken(token, { username: "dr.bashir", draft: draftOf(), warnings, now: T0 + 60 * 1000 }),
    ).toEqual({ ok: false, failure: "wrong_user" });
  });

  it("٩) تغيّر دواء/جرعة بعد الإقرار ⇒ رفض كما هو حاليًا (توقيع الوصفة)", () => {
    const draft = draftOf();
    const warnings = warningsOf(ALERT_BLEEDING);
    const token = buildSafetyAcknowledgementToken({ username: USERNAME, draft, warnings, now: T0 });

    const doseChanged = draftOf();
    doseChanged.items[0].dose = "200mg";
    expect(
      verifySafetyAcknowledgementToken(token, { username: USERNAME, draft: doseChanged, warnings, now: T0 + 60 * 1000 }),
    ).toEqual({ ok: false, failure: "bad_signature" });

    const medChanged = draftOf({ ...DRAFT_BODY, items: [{ ...DRAFT_BODY.items[0], name: "Diclofenac 50mg" }] });
    expect(
      verifySafetyAcknowledgementToken(token, { username: USERNAME, draft: medChanged, warnings, now: T0 + 60 * 1000 }),
    ).toEqual({ ok: false, failure: "bad_signature" });
  });

  it("٩-ت) رموز غير صالحة/قديمة الصيغة (v1 بلا حمولة)/مزوّرة ⇒ رفض", () => {
    const draft = draftOf();
    const warnings = warningsOf(ALERT_BLEEDING);
    expect(verifySafetyAcknowledgementToken(null, { username: USERNAME, draft, warnings, now: T0 })).toEqual({ ok: false, failure: "malformed" });
    expect(verifySafetyAcknowledgementToken("", { username: USERNAME, draft, warnings, now: T0 })).toEqual({ ok: false, failure: "malformed" });
    expect(verifySafetyAcknowledgementToken(12345, { username: USERNAME, draft, warnings, now: T0 })).toEqual({ ok: false, failure: "malformed" });
    expect(verifySafetyAcknowledgementToken("not-a-token", { username: USERNAME, draft, warnings, now: T0 })).toEqual({ ok: false, failure: "malformed" });
    /* صيغة v1 القديمة: توقيع مجرّد بلا حمولة — لم يكن يربط التحذيرات. */
    expect(verifySafetyAcknowledgementToken("b2xkLXNpZ25hdHVyZQ", { username: USERNAME, draft, warnings, now: T0 })).toEqual({ ok: false, failure: "malformed" });

    /* تلاعب بالحمولة الموقّعة: تمديد الصلاحية يفرّق الفارق عن TTL
       فيرفض في فحص البنية قبل التوقيع أصلاً. */
    const token = buildSafetyAcknowledgementToken({ username: USERNAME, draft, warnings, now: T0 });
    const [body, sig] = token.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    payload.exp = payload.exp + 60 * 60 * 1000; /* محاولة تمديد ساعة. */
    const tampered = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
    expect(
      verifySafetyAcknowledgementToken(tampered, { username: USERNAME, draft: draftOf(), warnings, now: T0 + 60 * 1000 }),
    ).toEqual({ ok: false, failure: "malformed" });

    /* وتلاعب يبقي البنية سليمة (تبديل المستخدم داخلها): يسقطه التوقيع. */
    const payload2 = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    payload2.u = "dr.bashir";
    const tampered2 = `${Buffer.from(JSON.stringify(payload2)).toString("base64url")}.${sig}`;
    expect(
      verifySafetyAcknowledgementToken(tampered2, { username: USERNAME, draft: draftOf(), warnings, now: T0 + 60 * 1000 }),
    ).toEqual({ ok: false, failure: "bad_signature" });
  });

  it("١٠) صار التحذير حرجًا بعد المعاينة ⇒ لا يصل أصلًا إلى التحقق في المسار (منعٌ تام) — والتحذير الحرج لا يُعامل تحذيرًا غير حرج", () => {
    /* في المسار الخادمي تُرشَّح الحرجة قبل التحقق من الرمز فيُمنع الحفظ
       كليًا (مغطّى باختبار مسار كامل في prescription-security.test.ts).
       هنا نثبت الجذر: تحذير حرج ليس ضمن مجموعة التحذيرات غير الحرجة
       المعروضة أصلًا — فلا يمكن أن يُقرّ ضمنها. */
    const allAlerts = evaluatePrescriptionSafety(
      DRAFT_BODY.items.map((i) => ({ name: i.name, dose: i.dose })),
      "سيولة دم وحساسية بنسلين شديدة",
    );
    const penicillinAlerts = evaluatePrescriptionSafety(
      [{ name: "Augmentin 1g", dose: "1g" }],
      "حساسية بنسلين شديدة",
    );
    expect(penicillinAlerts.every((a) => a.severity === "critical")).toBe(true);
    /* مجموعة التحذيرات غير الحرجة (ما يُعرض ويُقرّ) خالية من الحرج. */
    const noncritical = allAlerts.filter((a) => a.severity !== "critical");
    expect(noncritical.every((a) => a.severity !== "critical")).toBe(true);
  });
});

describe("صيغة الرمز: حمولة موقّعة تحمل المستخدم والبصمة والعمر", () => {
  it("الحمولة تحمل username وبصمة التحذيرات وiat/exp بفارق TTL", () => {
    const draft = draftOf();
    const warnings = warningsOf(ALERT_BLEEDING);
    const token = buildSafetyAcknowledgementToken({ username: USERNAME, draft, warnings, now: T0 });
    const [body] = token.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      v: number; u: string; f: string; iat: number; exp: number;
    };
    expect(payload.v).toBe(2);
    expect(payload.u).toBe(USERNAME);
    expect(payload.f).toBe(warningFingerprint(warnings));
    expect(payload.iat).toBe(T0);
    expect(payload.exp - payload.iat).toBe(SAFETY_ACK_TTL_MS);
    /* بصمة SHA-256 hex ثابتة الطول. */
    expect(payload.f).toMatch(/^[0-9a-f]{64}$/);
  });

  it("رمز مبني لتحذيراتٍ غير بصمة تحذيرات أخرى — لا يُعاد استخدام بين الحالات", () => {
    const draft = draftOf();
    const tokenForBleeding = buildSafetyAcknowledgementToken({
      username: USERNAME, draft, warnings: warningsOf(ALERT_BLEEDING), now: T0,
    });
    const tokenForBleedingAsthma = buildSafetyAcknowledgementToken({
      username: USERNAME, draft, warnings: warningsOf(ALERT_BLEEDING_ASTHMA), now: T0,
    });
    expect(tokenForBleeding).not.toBe(tokenForBleedingAsthma);
  });
});
