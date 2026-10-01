import { classifyOrthoAdjustment, type BillingClassification } from "./billing-classification";
import type { LegacyFinancialMode } from "./ortho-baseline";

/**
 * (P1-A) تهيئة مريض التقويم السابق للنظام — قائمة تحقّق مشتقة لا مخزّنة.
 *
 * المريض القديم يُدخَل بثلاث قطع قائمة: لقطة الحالة (CASE-1) بطريقة المال قبل النظام، والرصيد السابق
 * (opening balance) إن بقي عليه شيء، وترتيب تحصيله (P0-C). هذه الدالة تقول ما الناقص وما أثره على
 * فوترة الشدّة — بالمصنِّف نفسه الذي يقرر التوقيع (classifyOrthoAdjustment)، فلا تتناقض الشاشة والتوقيع.
 * لا تكتب شيئًا ولا تحوّل شيئًا تلقائيًا: كل خطوة بمسارها القائم وصلاحيته.
 */

export type OnboardingStepKey = "baseline" | "financial_mode" | "opening_balance" | "arrangement" | "plan";

export interface OnboardingStep {
  key: OnboardingStepKey;
  label: string;
  done: boolean;
  /** خطوة اختيارية (موصى بها) لا تمنع اكتمال التهيئة. */
  optional: boolean;
  hint: string | null;
}

export interface LegacyOnboarding {
  /** هل الحالة سابقة للنظام أصلًا؟ */
  legacy: boolean;
  steps: OnboardingStep[];
  complete: boolean;
  /** تصنيف شدّة اليوم بالمعطيات الحالية — ما سيقرره التوقيع. */
  adjustmentClass: BillingClassification;
  warning: string | null;
}

export function legacyOnboarding(input: {
  legacy: boolean;
  financialMode: LegacyFinancialMode | null;
  openingCurrencies: readonly string[];
  activeArrangementCurrencies: readonly string[];
  fundedPlan: boolean;
}): LegacyOnboarding {
  const adjustmentClass = classifyOrthoAdjustment({
    legacy: input.legacy,
    financialMode: input.financialMode,
    openingCurrencies: input.openingCurrencies,
    fundedPlan: input.fundedPlan,
  });
  if (!input.legacy) {
    return { legacy: false, steps: [], complete: true, adjustmentClass, warning: null };
  }
  const steps: OnboardingStep[] = [
    { key: "baseline", label: "لقطة الحالة السابقة (الأسلاك والمرحلة)", done: true, optional: false, hint: null },
    {
      key: "financial_mode", label: "طريقة المال قبل النظام", done: input.financialMode !== null, optional: false,
      hint: input.financialMode === null ? "حدّدها في لقطة الحالة: رصيد سابق، أو مدفوع مسبقًا، أو كل جلسة، أو أقساط." : null,
    },
  ];
  if (input.financialMode === "opening_balance") {
    steps.push({
      key: "opening_balance", label: "الرصيد السابق في حساب المريض", done: input.openingCurrencies.length === 1, optional: false,
      hint: input.openingCurrencies.length === 0
        ? "سجّل المتبقي عليه في «الرصيد السابق» من تبويب الحساب — لا فاتورة جديدة."
        : input.openingCurrencies.length > 1
          ? "للمريض رصيدٌ سابق بأكثر من عملة — الشدّة لا تُغطّى تلقائيًا حتى يتضح أي رصيدٍ يخصّ التقويم."
          : null,
    });
    steps.push({
      key: "arrangement", label: "ترتيب تحصيل الرصيد السابق (قسط مقترح)", optional: true,
      done: input.openingCurrencies.some((currency) => input.activeArrangementCurrencies.includes(currency)),
      hint: "اختياري: حدّد قسطًا مع كل زيارة أو شهريًا ليقترحه الاستقبال عند الوصول.",
    });
  }
  if (input.financialMode === "installments") {
    steps.push({
      key: "plan", label: "خطة أقساط مربوطة بالحالة", done: input.fundedPlan, optional: false,
      hint: input.fundedPlan ? null : "اربط خطة الأقساط القائمة بحالة التقويم (أو أنشئها) — الأقساط تُحصَّل منها.",
    });
  }
  const complete = steps.every((step) => step.optional || step.done);
  const warning = adjustmentClass === "OUTSIDE_CONTRACT" && input.financialMode !== "per_session"
    ? "الشدّة اليوم لن تُعدّ مشمولة: أكمل الخطوات الناقصة أعلاه، وإلا احتاجت قرار فوترة منفصلًا."
    : null;
  return { legacy: true, steps, complete, adjustmentClass, warning };
}
