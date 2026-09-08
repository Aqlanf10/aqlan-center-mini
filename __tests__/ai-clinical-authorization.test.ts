import { describe, expect, it } from "vitest";

/**
 * اختبارات الترخيص السريري المركزي لأدوات الذكاء الاصطناعي (مراجعة P0 — Blocker 1).
 *
 * القاعدة: أدوات دعم القرار السريري الحساسة (اختيار دواء، اقتراح جرعة،
 * توصية علاج، تقرير طبي يعتمد قرارًا طبيًا) لا تُفتح لمجرد القدرة على فتح
 * نافذة المساعد (canUseAiChat). الطبيب المربوط بجهة طبيب فقط — أو المدين
 * المربوط صراحةً بجهة طبيب. الاستقبال مرفوضٌ جملةً مهما فُعّل له.
 */

import { executeAiTool } from "../lib/ai-tools/registry";
import { authorizeToolPolicy, AI_TOOL_POLICIES } from "../lib/ai-tools/policy";
import { clinicalCapabilityOf, isIssuingClinician } from "../lib/clinical-identity";
import type { AiToolContext } from "../lib/ai-tools/types";

const CLINICAL_TOOLS = [
  "recommend_prescription",
  "generate_post_op_care",
  "draft_medical_report_form",
] as const;

const CLINICAL_ALIASES = [
  ["recommend_prescription", ["prescription_safety", "check_prescription", "suggest_drugs"]],
  ["generate_post_op_care", ["post_op_care", "post_op_instructions"]],
  ["draft_medical_report_form", ["medical_report", "medical_report_form", "clinical_report"]],
] as const;

/** استقبالٌ فعّل له المدير canUseAiChat — يملك «فتح النافذة» لا «القرار السريري». */
const RECEPTION_WITH_AI: AiToolContext = {
  userId: 31,
  username: "reception1",
  role: "reception",
  permissions: { canUseAiChat: true, canViewAllPatients: true },
  isDbConnected: false,
  todayISO: "2026-09-08",
};

const ADMIN_WITHOUT_CLINICAL_ID: AiToolContext = {
  userId: 1,
  username: "admin",
  role: "admin",
  doctorPartyId: null, /* مدير إداري بلا ربط بجهة طبيب */
  isDbConnected: false,
  todayISO: "2026-09-08",
};

const ADMIN_WITH_CLINICAL_ID: AiToolContext = {
  userId: 2,
  username: "admin_doctor",
  role: "admin",
  doctorPartyId: 7, /* مدين مرتبط صراحةً بجهة طبيب (هوية سريرية) */
  isDbConnected: false,
  todayISO: "2026-09-08",
};

const DOCTOR_WITH_PARTY: AiToolContext = {
  userId: 11,
  username: "dr.amjad",
  role: "doctor",
  doctorPartyId: 5,
  isDbConnected: false,
  todayISO: "2026-09-08",
};

const DOCTOR_WITHOUT_PARTY: AiToolContext = {
  userId: 12,
  username: "dr.orphan",
  role: "doctor",
  doctorPartyId: null, /* طبيب بلا ربط بجهة طبيب */
  isDbConnected: false,
  todayISO: "2026-09-08",
};

describe("فحص القدرة السريرية المركزي (clinicalCapabilityOf)", () => {
  it("الاستقبال لا يملك هوية سريرية أبدًا — حتى مع canUseAiChat=true", () => {
    const capability = clinicalCapabilityOf({ role: "reception", doctorPartyId: 99 });
    expect(capability.ok).toBe(false);
    expect(capability.reason).toContain("الاستقبال");
  });

  it("الطبيب بلا جهة طبيب لا يملك قدرة سريرية", () => {
    expect(clinicalCapabilityOf({ role: "doctor", doctorPartyId: null }).ok).toBe(false);
    expect(clinicalCapabilityOf({ role: "doctor", doctorPartyId: 0 }).ok).toBe(false);
    expect(clinicalCapabilityOf({ role: "doctor" }).ok).toBe(false);
  });

  it("الطبيب المربوط بجهة طبيب يملك قدرة سريرية بجهته", () => {
    const capability = clinicalCapabilityOf({ role: "doctor", doctorPartyId: 5 });
    expect(capability.ok).toBe(true);
    expect(capability.partyId).toBe(5);
  });

  it("المدير ليس طبيبًا لمجرد أنه مدير — لا قدرة بلا ربط صريح بجهة طبيب", () => {
    expect(clinicalCapabilityOf({ role: "admin", doctorPartyId: null }).ok).toBe(false);
    expect(clinicalCapabilityOf({ role: "admin" }).ok).toBe(false);
    /* بالربط الصريح: قدرة سريرية بجهته */
    const capability = clinicalCapabilityOf({ role: "admin", doctorPartyId: 7 });
    expect(capability.ok).toBe(true);
    expect(capability.partyId).toBe(7);
  });

  it("دور غير معروف: رفض افتراضي", () => {
    expect(clinicalCapabilityOf({ role: undefined, doctorPartyId: 5 }).ok).toBe(false);
    expect(clinicalCapabilityOf({ role: "portal", doctorPartyId: 5 }).ok).toBe(false);
  });

  it("مطابقة مُصدر الوصفة: جهة الوصفة أو (للقديم) اسم مُنشئها", () => {
    const clinician = { partyId: 5, username: "dr.amjad" };
    expect(isIssuingClinician({ doctorPartyId: 5, createdBy: "غيره" }, clinician)).toBe(true);
    expect(isIssuingClinician({ doctorPartyId: 8, createdBy: "dr.amjad" }, clinician)).toBe(false);
    expect(isIssuingClinician({ doctorPartyId: null, createdBy: "dr.amjad" }, clinician)).toBe(true);
    expect(isIssuingClinician({ doctorPartyId: null, createdBy: "غيره" }, clinician)).toBe(false);
    expect(isIssuingClinician({ doctorPartyId: null, createdBy: null }, clinician)).toBe(false);
  });
});

describe("سياسة الأدوات السريرية الحساسة — الهوية الإلزامية", () => {
  it("الأدوات السريرية الحساسة معلّمة requiresClinicalIdentity ولا تسمح للاستقبال دوريًا", () => {
    for (const tool of CLINICAL_TOOLS) {
      const policy = AI_TOOL_POLICIES[tool];
      expect(policy, tool).toBeDefined();
      expect(policy!.requiresClinicalIdentity, `${tool} بلا شرط هوية سريرية`).toBe(true);
      expect(policy!.allowedRoles, `${tool} يسمح للاستقبال`).not.toContain("reception");
    }
  });

  it("reception + canUseAiChat=true → recommend_prescription DENY", async () => {
    const res = await executeAiTool(
      "recommend_prescription",
      { patientName: "سالم عبدالله", condition: "خراج سني" },
      RECEPTION_WITH_AI,
    );
    expect(res.success).toBe(false);
    expect(res.textSummary).toContain("هوية سريرية");
    expect(res.warnings?.[0]).toContain("غير مصرح");
  });

  it("reception + canUseAiChat=true → generate_post_op_care DENY", async () => {
    const res = await executeAiTool(
      "generate_post_op_care",
      { patientName: "سالم عبدالله", procedureType: "خلع جراحي" },
      RECEPTION_WITH_AI,
    );
    expect(res.success).toBe(false);
    expect(res.textSummary).toContain("هوية سريرية");
  });

  it("reception + canUseAiChat=true → clinical medical report DENY", async () => {
    const res = await executeAiTool(
      "draft_medical_report_form",
      { patientName: "سالم عبدالله", diagnosis: "التهاب لبي" },
      RECEPTION_WITH_AI,
    );
    expect(res.success).toBe(false);
    expect(res.textSummary).toContain("هوية سريرية");
  });

  it("admin without doctorPartyId → clinical CDS DENY (ليس طبيبًا لمجرد أنه مدير)", async () => {
    for (const tool of CLINICAL_TOOLS) {
      const res = await executeAiTool(tool, { patientName: "سالم", condition: "خراج" }, ADMIN_WITHOUT_CLINICAL_ID);
      expect(res.success, tool).toBe(false);
      expect(res.textSummary).toContain("هوية سريرية");
    }
  });

  it("admin with doctorPartyId → allowed وفق السياسة المصرح بها", async () => {
    for (const tool of CLINICAL_TOOLS) {
      const res = await executeAiTool(tool, { patientName: "سالم", condition: "خراج" }, ADMIN_WITH_CLINICAL_ID);
      /* الترخيص مرّ — النتيجة نجاح الدعم (وضع بلا قاعدة بيانات) لا رفض أمني. */
      expect(res.success, tool).toBe(true);
      expect(res.warnings?.[0] ?? "").not.toContain("غير مصرح");
    }
  });

  it("doctor with doctorPartyId → allowed", async () => {
    for (const tool of CLINICAL_TOOLS) {
      const res = await executeAiTool(tool, { patientName: "سالم", condition: "خراج" }, DOCTOR_WITH_PARTY);
      expect(res.success, tool).toBe(true);
    }
  });

  it("doctor without doctorPartyId → DENY", async () => {
    for (const tool of CLINICAL_TOOLS) {
      const res = await executeAiTool(tool, { patientName: "سالم", condition: "خراج" }, DOCTOR_WITHOUT_PARTY);
      expect(res.success, tool).toBe(false);
      expect(res.textSummary).toContain("غير مرتبط بجهة طبيب");
    }
  });

  it("الأسماء البديلة لا تتجاوز شرط الهوية السريرية (alias cannot bypass)", async () => {
    for (const [canonical, aliases] of CLINICAL_ALIASES) {
      for (const alias of aliases) {
        const res = await executeAiTool(alias, { patientName: "سالم", condition: "خراج" }, RECEPTION_WITH_AI);
        expect(res.success, `${alias} → ${canonical}`).toBe(false);
        expect(res.textSummary).toContain("هوية سريرية");
        /* والمدير بلا هوية كذلك */
        const resAdmin = await executeAiTool(alias, { patientName: "سالم" }, ADMIN_WITHOUT_CLINICAL_ID);
        expect(resAdmin.success, `${alias} (admin) → ${canonical}`).toBe(false);
        /* والطبيب المربوط ناجح */
        const resDoctor = await executeAiTool(alias, { patientName: "سالم", condition: "خراج" }, DOCTOR_WITH_PARTY);
        expect(resDoctor.success, `${alias} (doctor) → ${canonical}`).toBe(true);
      }
    }
  });

  it("authorizeToolPolicy: نفس القواعد على مستوى السياسة الصرف", () => {
    const policy = AI_TOOL_POLICIES.recommend_prescription;
    expect(authorizeToolPolicy(policy, RECEPTION_WITH_AI).allowed).toBe(false);
    expect(authorizeToolPolicy(policy, ADMIN_WITHOUT_CLINICAL_ID).allowed).toBe(false);
    expect(authorizeToolPolicy(policy, ADMIN_WITH_CLINICAL_ID).allowed).toBe(true);
    expect(authorizeToolPolicy(policy, DOCTOR_WITH_PARTY).allowed).toBe(true);
    expect(authorizeToolPolicy(policy, DOCTOR_WITHOUT_PARTY).allowed).toBe(false);
  });

  it("استقبالٌ يبقى قادرًا على أدواته الإدارية — الحجب سريريٌّ فقط لا شامل", async () => {
    /* الموعد والبحث ودليل النظام تظل تعمل للاستقبال (السلوك الرسمي محفوظ). */
    const search = await executeAiTool("search_patient", { term: "سالم" }, RECEPTION_WITH_AI);
    expect(search.success).toBe(true);
    const guide = await executeAiTool("get_system_guide", { query: "كيف أحجز موعدًا" }, RECEPTION_WITH_AI);
    expect(guide.success).toBe(true);
  });
});
