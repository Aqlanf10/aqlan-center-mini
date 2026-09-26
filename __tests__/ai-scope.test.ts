import { describe, expect, it } from "vitest";
import { ADMIN_ASSISTANT_SYSTEM_PROMPT, externalConsultPlan, hasClinicalSignal, redactPersonNames } from "../lib/ai-scope";
import { SETTING_DEFAULTS, validateSetting } from "../lib/settings";
import { AI_PROVIDER_PRESETS } from "../lib/ai-providers/presets";

/**
 * (P2-11 — قرار المالك) Claude للمهام الإدارية فقط: النص السريري لا يخرج من المركز
 * إلا بتفعيلٍ صريح، والإداري يخرج برسالته الأخيرة وحدها.
 */

const base = { hasKey: true, clinicalExternalAllowed: false, clinicalIdentity: true, message: "" };
const clinicalQuestion = "ما جرعة المضاد الحيوي للخراج؟";
const adminRequest = "اكتب إعلانًا للمرضى أن المركز مغلق يوم العيد";

describe("external consult plan", () => {
  it("clinical questions stay inside the clinic by default — even for a linked doctor", () => {
    for (const intent of ["pharmacology", "anesthesia", "endo_emergency", "orthodontics", "post_op"]) {
      expect(externalConsultPlan({ ...base, intent, message: clinicalQuestion }), intent)
        .toEqual({ kind: "clinical_blocked", reason: "scope" });
    }
    expect(externalConsultPlan({ ...base, intent: "clinical_general", message: clinicalQuestion }))
      .toEqual({ kind: "clinical_blocked", reason: "scope" });
  });

  it("clinical goes out only when the owner enables it, and only for a clinical identity", () => {
    const enabled = { ...base, clinicalExternalAllowed: true, message: clinicalQuestion };
    expect(externalConsultPlan({ ...enabled, intent: "pharmacology" })).toEqual({ kind: "clinical" });
    expect(externalConsultPlan({ ...enabled, clinicalIdentity: false, intent: "pharmacology" }))
      .toEqual({ kind: "clinical_blocked", reason: "identity" });
  });

  it("an unmatched question with no clinical signal is administrative — for any role", () => {
    for (const clinicalIdentity of [true, false]) {
      expect(externalConsultPlan({ ...base, clinicalIdentity, intent: "clinical_general", message: adminRequest }))
        .toEqual({ kind: "administrative" });
    }
  });

  it("answers built from the clinic's data or guide stay local", () => {
    for (const intent of ["clinic_ops", "system_guide", "triage", "today_appointments", "patient_query", "action_record_payment"]) {
      expect(externalConsultPlan({ ...base, intent, message: adminRequest }), intent).toEqual({ kind: "none" });
    }
  });

  it("no key, no provider", () => {
    expect(externalConsultPlan({ ...base, hasKey: false, clinicalExternalAllowed: true, intent: "pharmacology", message: clinicalQuestion }))
      .toEqual({ kind: "none" });
    expect(externalConsultPlan({ ...base, hasKey: false, intent: "clinical_general", message: adminRequest })).toEqual({ kind: "none" });
  });

  it("clinical signals: one clinical word keeps the text inside", () => {
    expect(hasClinicalSignal(clinicalQuestion)).toBe(true);
    expect(hasClinicalSignal("مريض عنده ألم بعد القلع")).toBe(true);
    expect(hasClinicalSignal("what dose of amoxicillin")).toBe(true);
    expect(hasClinicalSignal(adminRequest)).toBe(false);
    expect(hasClinicalSignal("رتب لي جدول دوام الاستقبال للأسبوع القادم")).toBe(false);
    // مقاطع قصيرة لا توقع نصًّا إداريًّا في الفخ.
    for (const text of ["راجع طلبات الحجز الجديدة", "نحتاج حملة تسويقية", "عندي فكرة للسكرتارية", "اكتب رسالة شكر للمرضى"]) {
      expect(hasClinicalSignal(text), text).toBe(false);
    }
  });

  it("the administrative prompt forbids clinical advice", () => {
    expect(ADMIN_ASSISTANT_SYSTEM_PROMPT).toContain("لا تقدّم أي رأي سريري");
  });
});

describe("(review) administrative dispatch is explicit, clinical-safe and name-free", () => {
  it("a clinical question without a listed keyword is not treated as administrative", () => {
    const question = "ما توصياتك لحالة مصابة بقرحة فموية؟";
    expect(externalConsultPlan({ ...base, intent: "clinical_general", message: question }).kind).not.toBe("administrative");
    expect(hasClinicalSignal("عنده كسر في السن الأمامي")).toBe(true);
  });

  it("an unmatched text with no administrative request stays local", () => {
    expect(externalConsultPlan({ ...base, intent: "clinical_general", message: "ما رأيك؟" }).kind).not.toBe("administrative");
  });

  it("reception and unlinked admins reach the administrative assistant (the local gate rejected it as clinical)", () => {
    expect(externalConsultPlan({ ...base, clinicalIdentity: false, intent: "clinical_scope_rejection", message: adminRequest }))
      .toEqual({ kind: "administrative" });
    expect(externalConsultPlan({ ...base, clinicalIdentity: false, intent: "clinical_scope_rejection", message: clinicalQuestion }))
      .toEqual({ kind: "none" });
  });

  it("names of people registered in the clinic are masked before anything leaves", () => {
    const tokens = new Set(["احمد", "علي", "سعيد"]);
    const out = redactPersonNames("اكتب رسالة إلى أحمد علي ولسعيد أن المركز مغلق غدًا", tokens);
    expect(out).not.toMatch(/أحمد|علي|سعيد/);
    expect(out).toContain("المركز مغلق");
    expect(out).toContain("[اسم]");
  });
});

describe("setting and provider preset", () => {
  it("ai.clinical_external defaults to off and accepts only true/false", () => {
    expect(SETTING_DEFAULTS["ai.clinical_external"]).toBe("false");
    expect(validateSetting("ai.clinical_external", "true")).toBeNull();
    expect(validateSetting("ai.clinical_external", "yes")).toMatch(/true أو false/);
  });

  it("the Claude preset offers current models, economical Haiku by default", () => {
    const claude = AI_PROVIDER_PRESETS.find((preset) => preset.id === "anthropic")!;
    expect(claude.defaultModel).toBe("claude-haiku-4-5-20251001");
    expect(claude.suggestedModels).toEqual(["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5-5"]);
  });
});
