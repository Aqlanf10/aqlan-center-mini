import { describe, expect, it } from "vitest";

/**
 * مصفوفة تدقيق صلاحيات أدوات AI مقابل المسارات الرسمية + ثوابت عدم التجاوز
 * (مراجعة P0 المستقلة — Blockers 3/4/5).
 *
 * الثابت المُثبَت آليًّا: **AI permissions ⊆ normal API permissions.**
 *   ١) اكتمال المصفوفة: لا أداة بلا مدخل (Missing mapping ⇒ DENY مطبقة على
 *      مستوى المصفوفة) ولا مدخل بلا أداة.
 *   ٢) لا انحراف: حقول المصفوفة مطابقة لحقول السياسة الحية (لا نسخة منحرفة).
 *   ٣) لكل صلاحية مطلوبة: طبيب false ⇒ رفض، طبيب true ⇒ سماح، مدير ⇒ سماح،
 *      استقبال ⇒ وفق افتراضاته الرسمية.
 *   ٤) حالات المراجعة الصريحة: العمولات، أسعار الخدمات، وكل صلاحية مذكورة.
 */

import {
  AI_TOOL_ALIAS_TO_CANONICAL,
  AI_TOOL_POLICIES,
  authorizeToolPolicy,
  resolveToolPolicy,
} from "../lib/ai-tools/policy";
import { AI_TOOL_API_MATRIX, matrixEntryFor, matrixCoveredNames } from "../lib/ai-tools/permission-matrix";
import { executeAiTool } from "../lib/ai-tools/registry";
import {
  DEFAULT_DOCTOR_PERMISSIONS,
  RECEPTION_PERMISSIONS,
  type DoctorPermissions,
} from "../lib/doctor-permissions";
import type { AiToolContext } from "../lib/ai-tools/types";

function doctorCtx(overrides: Partial<DoctorPermissions> = {}, doctorPartyId: number | null = 5): AiToolContext {
  return {
    userId: 11,
    username: "dr.amjad",
    role: "doctor",
    doctorPartyId,
    permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, ...overrides },
    isDbConnected: false,
    todayISO: "2026-09-08",
  };
}

const RECEPTION_CTX: AiToolContext = {
  userId: 21,
  username: "reception1",
  role: "reception",
  permissions: { ...RECEPTION_PERMISSIONS },
  isDbConnected: false,
  todayISO: "2026-09-08",
};

const ADMIN_CTX: AiToolContext = {
  userId: 1,
  username: "admin",
  role: "admin",
  doctorPartyId: 7,
  permissions: null,
  isDbConnected: false,
  todayISO: "2026-09-08",
};

describe("اكتمال مصفوفة أدوات AI ↔ المسارات الرسمية (AI ⊆ API)", () => {
  it("كل أداة كانونية في السياسة لها مدخل مصفوفة — لا تعيين ⇒ فشل الاختبار", () => {
    const canonicalTools = Object.keys(AI_TOOL_POLICIES);
    expect(canonicalTools.length).toBeGreaterThanOrEqual(31);
    for (const tool of canonicalTools) {
      expect(AI_TOOL_API_MATRIX[tool], `الأداة «${tool}» بلا مدخل مصفوفة`).toBeDefined();
    }
  });

  it("لا مدخل مصفوفة لأداة غير موجودة في السياسة — لا مداخل يتيمة", () => {
    for (const entry of Object.keys(AI_TOOL_API_MATRIX)) {
      expect(AI_TOOL_POLICIES[entry], `مدخل مصفوفة «${entry}» بلا سياسة`).toBeDefined();
    }
  });

  it("كل اسم بديل يُحلّ إلى مدخل مصفوفة أصله — الأسماء البديلة لا تخرق التغطية", () => {
    for (const name of matrixCoveredNames()) {
      const entry = matrixEntryFor(name);
      expect(entry, `الاسم «${name}» بلا مدخل مصفوفة`).not.toBeNull();
      const policy = resolveToolPolicy(name);
      expect(policy).not.toBeNull();
      expect(entry!.canonicalName).toBe(policy!.canonicalName);
    }
  });

  it("لا انحراف بين المصفوفة والسياسة الحية (الأدوار/الصلاحيات/الهوية السريرية)", () => {
    for (const [tool, entry] of Object.entries(AI_TOOL_API_MATRIX)) {
      const policy = AI_TOOL_POLICIES[tool];
      expect(policy, tool).toBeDefined();
      expect(entry.aiRequiredPermissions, `${tool}: صلاحيات المصفوفة تنحرف عن السياسة`)
        .toEqual(policy!.requiredPermissions);
      expect(entry.aiAllowedRoles, `${tool}: أدوار المصفوفة تنحرف عن السياسة`)
        .toEqual(policy!.allowedRoles);
      expect(entry.requiresClinicalIdentity, `${tool}: شرط الهوية ينحرف`).toBe(policy!.requiresClinicalIdentity);
    }
  });

  it("كل مدخل يوثّق مساره الرسمي المكافئ ونموذج صلاحياته", () => {
    for (const [tool, entry] of Object.entries(AI_TOOL_API_MATRIX)) {
      expect(entry.apiEquivalents.length, `${tool} بلا مسار مكافئ`).toBeGreaterThan(0);
      expect(entry.apiPermissionModel.length, `${tool} بلا نموذج صلاحية موثق`).toBeGreaterThan(10);
    }
  });
});

describe("ثابت الصلاحيات: AI ⊆ API — لكل صلاحية مطلوبة", () => {
  /* كل أداة تشترط صلاحية: طبيب=false ⇒ رفض، طبيب=true ⇒ سماح، مدير ⇒ سماح. */
  const toolsWithPermissions = Object.values(AI_TOOL_POLICIES)
    .filter((p) => p.requiredPermissions.length > 0 && p.allowedRoles.includes("doctor"));

  it("يوجد أدوات تشترط صلاحيات صريحة تُختبر (تغطية فعلية لا شكلية)", () => {
    expect(toolsWithPermissions.length).toBeGreaterThanOrEqual(6);
  });

  it("الطبيب مع الصلاحية false ⇒ DENY لكل أداة تشترطها", () => {
    for (const policy of toolsWithPermissions) {
      for (const permission of policy.requiredPermissions) {
        const ctx = doctorCtx({ [permission]: false } as Partial<DoctorPermissions>);
        const decision = authorizeToolPolicy(policy, ctx);
        expect(decision.allowed, `${policy.canonicalName} مع ${permission}=false`).toBe(false);
      }
    }
  });

  it("الطبيب مع الصلاحية true ⇒ ALLOW (ضمن دوره) — المنح الصريح يعمل", () => {
    for (const policy of toolsWithPermissions) {
      const overrides: Partial<DoctorPermissions> = {};
      for (const permission of policy.requiredPermissions) {
        (overrides as Record<string, boolean>)[permission] = true;
      }
      const ctx = doctorCtx(overrides, policy.requiresClinicalIdentity ? 5 : 5);
      const decision = authorizeToolPolicy(policy, ctx);
      expect(decision.allowed, `${policy.canonicalName} مع منح كامل`).toBe(true);
    }
  });

  it("المدير ⇒ ALLOW دائمًا (المدير يفحص بالسماح في كل الصلاحيات)", () => {
    for (const policy of toolsWithPermissions) {
      expect(authorizeToolPolicy(policy, ADMIN_CTX).allowed, policy.canonicalName).toBe(true);
    }
  });

  it("الاستقبال ⇒ وفق افتراضاته الرسمية (RECEPTION_PERMISSIONS) — السلوك الرسمي محفوظ", () => {
    for (const policy of Object.values(AI_TOOL_POLICIES)) {
      if (!policy.allowedRoles.includes("reception")) {
        expect(authorizeToolPolicy(policy, RECEPTION_CTX).allowed, `${policy.canonicalName} يجب ألا يسمح للاستقبال`).toBe(false);
        continue;
      }
      /* مسموح له دوريًا: القرار يتبع افتراضاته — إن اشترط صلاحيةً فافتراضه هو المرجع */
      const decision = authorizeToolPolicy(policy, RECEPTION_CTX);
      const permissionFails = policy.requiredPermissions.some(
        (p) => RECEPTION_PERMISSIONS[p] !== true,
      );
      expect(decision.allowed, `${policy.canonicalName} (reception)`).toBe(!permissionFails);
    }
  });
});

describe("Blocker 3 — عمولات الطبيب: AI مطابق لـ /api/finance/commissions", () => {
  it("doctor canViewOwnCommissions=false → DENY", async () => {
    const res = await executeAiTool("get_doctor_commission", {}, doctorCtx({ canViewOwnCommissions: false }));
    expect(res.success).toBe(false);
    expect(res.textSummary).toContain("canViewOwnCommissions");
  });

  it("doctor canViewOwnCommissions=true (الافتراضي) → own commission allowed", async () => {
    const res = await executeAiTool("get_doctor_commission", {}, doctorCtx({ canViewOwnCommissions: true }));
    /* بلا قاعدة بيانات: الترخيص مرّ والرد نمط الاستعلام لا الرفض الأمني. */
    expect(res.success).toBe(true);
    expect(res.textSummary).not.toContain("غير مصرح");
  });

  it("doctor يستعلم عمولة طبيب آخر بلا منح → DENY (عزل المستوى المالي)", async () => {
    /* الطبيب (جهة 5) يحاول استعلام جهة 8: فحص صريح داخل الأداة يرفضه. */
    const res = await executeAiTool("get_doctor_commission", { doctorId: 8 }, {
      ...doctorCtx({ canViewOwnCommissions: true }),
      isDbConnected: false,
    });
    expect(res.success).toBe(false);
    expect(res.textSummary).toContain("عمولات");
    /* ولا يوسّع نطاقه عبر التقرير العام بلا منح مالية */
    const report = await executeAiTool("generate_internal_report", { reportType: "doctor", doctorId: 8 }, doctorCtx({ canViewClinicFinance: false }));
    expect(report.success).toBe(false);
  });

  it("authorized admin → allowed", async () => {
    const res = await executeAiTool("get_doctor_commission", { doctorId: 8 }, ADMIN_CTX);
    expect(res.success).toBe(true);
  });

  it("reception → DENY (خارج الباب تمامًا كما في المسار الرسمي)", async () => {
    const res = await executeAiTool("get_doctor_commission", {}, RECEPTION_CTX);
    expect(res.success).toBe(false);
  });

  it("المدير لا يتأثر بشرط canViewOwnCommissions (يفحص دائمًا بالسماح)", () => {
    const policy = AI_TOOL_POLICIES.get_doctor_commission;
    const adminNoPermissions: AiToolContext = { ...ADMIN_CTX, permissions: { canViewOwnCommissions: false } as any };
    expect(authorizeToolPolicy(policy, adminNoPermissions).allowed).toBe(true);
  });
});

describe("Blocker 4 — أسعار الخدمات: AI مطابق لـ /api/services", () => {
  it("doctor canViewServicePrices=false (الافتراضي) → DENY", async () => {
    const res = await executeAiTool("get_service_prices", { query: "تقويم" }, doctorCtx({ canViewServicePrices: false }));
    expect(res.success).toBe(false);
    expect(res.textSummary).toContain("canViewServicePrices");
  });

  it("doctor بلا كائن صلاحيات (الافتراضي: false) → DENY أيضًا", async () => {
    const res = await executeAiTool("get_service_prices", { query: "تقويم" }, doctorCtx());
    expect(res.success).toBe(false);
  });

  it("doctor canViewServicePrices=true → allowed", async () => {
    const res = await executeAiTool("get_service_prices", { keyword: "تقويم" }, doctorCtx({ canViewServicePrices: true }));
    expect(res.success).toBe(true);
  });

  it("الأسماء البديلة لا تتجاوز (alias cannot bypass): get_services وdental_prices وservice_prices وprice_list", async () => {
    for (const alias of ["get_services", "dental_prices", "service_prices", "price_list"]) {
      const denied = await executeAiTool(alias, { query: "تقويم" }, doctorCtx({ canViewServicePrices: false }));
      expect(denied.success, `${alias} يجب ألا يتجاوز شرط الطبيب`).toBe(false);
      const allowed = await executeAiTool(alias, { serviceQuery: "تقويم" }, doctorCtx({ canViewServicePrices: true }));
      expect(allowed.success, `${alias} مع المنح يعمل`).toBe(true);
    }
  });

  it("reception: السلوك الرسمي محفوظ (افتراضه canViewServicePrices=true) → allowed", async () => {
    const res = await executeAiTool("get_service_prices", { query: "تقويم" }, RECEPTION_CTX);
    expect(res.success).toBe(true);
  });

  it("admin → allowed", async () => {
    const res = await executeAiTool("get_service_pricing", { serviceQuery: "زراعة" }, ADMIN_CTX);
    expect(res.success).toBe(true);
  });
});

describe("صلاحيات المراجعة المذكورة — تغطية الترخيص في السياسات", () => {
  it("canViewXrays تشترطها أدوات السيفالو كما في مساراتها", () => {
    expect(AI_TOOL_POLICIES.get_cephalometric_summary.requiredPermissions).toContain("canViewXrays");
    const decision = authorizeToolPolicy(
      AI_TOOL_POLICIES.get_cephalometric_summary,
      doctorCtx({ canViewXrays: false }),
    );
    expect(decision.allowed).toBe(false);
    expect(
      authorizeToolPolicy(AI_TOOL_POLICIES.get_cephalometric_summary, doctorCtx({ canViewXrays: true })).allowed,
    ).toBe(true);
  });

  it("canAddPatient تشترطها create_patient كما في /api/patients (POST)", () => {
    expect(AI_TOOL_POLICIES.create_patient.requiredPermissions).toContain("canAddPatient");
    expect(authorizeToolPolicy(AI_TOOL_POLICIES.create_patient, doctorCtx({ canAddPatient: false })).allowed).toBe(false);
    expect(authorizeToolPolicy(AI_TOOL_POLICIES.create_patient, doctorCtx({ canAddPatient: true })).allowed).toBe(true);
  });

  it("canEditPatient تشترطها add_patient_medical_alert كما في تحرير الملف", () => {
    expect(AI_TOOL_POLICIES.add_patient_medical_alert.requiredPermissions).toContain("canEditPatient");
    expect(authorizeToolPolicy(AI_TOOL_POLICIES.add_patient_medical_alert, doctorCtx({ canEditPatient: false })).allowed).toBe(false);
  });

  it("canViewClinicFinance تشترطها كل أدوات التقارير المالية كما في /api/finance/report", () => {
    for (const tool of ["generate_internal_report", "get_today_collections", "get_patient_receivables", "get_debt_aging"]) {
      expect(AI_TOOL_POLICIES[tool].requiredPermissions, tool).toContain("canViewClinicFinance");
      expect(authorizeToolPolicy(AI_TOOL_POLICIES[tool], doctorCtx({ canViewClinicFinance: false })).allowed, tool).toBe(false);
      expect(authorizeToolPolicy(AI_TOOL_POLICIES[tool], doctorCtx({ canViewClinicFinance: true })).allowed, tool).toBe(true);
    }
    /* الاستقبال لا يرى الربح — أدواره لا تشمل المالية */
    for (const tool of ["generate_internal_report", "get_today_collections", "get_patient_receivables", "get_debt_aging"]) {
      expect(AI_TOOL_POLICIES[tool].allowedRoles, tool).not.toContain("reception");
    }
  });

  it("مسك المال (record_patient_payment) للمدير والاستقبال فقط — كمسار السندات", () => {
    expect(AI_TOOL_POLICIES.record_patient_payment.allowedRoles).toEqual(["admin", "reception"]);
    expect(authorizeToolPolicy(AI_TOOL_POLICIES.record_patient_payment, doctorCtx()).allowed).toBe(false);
    expect(authorizeToolPolicy(AI_TOOL_POLICIES.record_patient_payment, RECEPTION_CTX).allowed).toBe(true);
    expect(authorizeToolPolicy(AI_TOOL_POLICIES.record_patient_payment, ADMIN_CTX).allowed).toBe(true);
  });

  it("صلاحيات لا تظهر في أي أداة AI أوسع من مسارها (canViewCostPrices/Expenses/Profits/CashDrawer لا تُطلب أدواتُها عرضًا)", () => {
    /* الأدوات المالية القائمة لا تطلب صلاحيات أدنى من مسارها الرسمي؛
       والصلاحيات الحساسة المتبقية (تكلفة/مصروف/ربح/صندوق/حسابات الآخرين/
       تقارير الإدارة) لا تفتحها أي أداة AI إلا عبر canViewClinicFinance
       الذي يفتح /api/finance/report نفسه — أي AI ⊆ API محفوظ. */
    const allRequired = new Set<string>();
    for (const policy of Object.values(AI_TOOL_POLICIES)) {
      for (const permission of policy.requiredPermissions) allRequired.add(permission);
    }
    for (const neverLoosened of ["canViewCostPrices", "canViewExpenses", "canViewClinicProfits", "canViewCashDrawer", "canViewOtherDoctorsAccounts", "canViewAdminReports"]) {
      /* لا تشترطها أداةٌ بذاتها — فلا تُمنح ضمنيًّا بغير مسارها */
      expect(allRequired.has(neverLoosened)).toBe(false);
    }
  });
});
