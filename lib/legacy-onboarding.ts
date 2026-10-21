import { classifyOrthoAdjustment, type BillingClassification } from "./billing-classification";
import type { LegacyFinancialMode } from "./ortho-baseline";
import { missingOrthoFinancialReference, type OrthoFinancialReference } from "./ortho-financial-reference";

/**
 * (P1-A) تهيئة مريض التقويم السابق للنظام — قائمة تحقّق مشتقة لا مخزّنة.
 *
 * المريض القديم يُدخَل بثلاث قطع قائمة: لقطة الحالة (CASE-1) بطريقة المال قبل النظام، والرصيد السابق
 * (opening balance) إن بقي عليه شيء، وترتيب تحصيله (P0-C). هذه الدالة تقول ما الناقص وما أثره على
 * فوترة الشدّة — بالمصنِّف نفسه الذي يقرر التوقيع (classifyOrthoAdjustment)، فلا تتناقض الشاشة والتوقيع.
 * لا تكتب شيئًا ولا تحوّل شيئًا تلقائيًا: كل خطوة بمسارها القائم وصلاحيته.
 */

export type OnboardingStepKey = "baseline" | "financial_mode" | "opening_balance" | "arrangement" | "plan" | "financial_source";

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
  financialReference: OrthoFinancialReference;
}

export function legacyOnboarding(input: {
  legacy: boolean;
  financialMode: LegacyFinancialMode | null;
  openingCurrencies: readonly string[];
  activeArrangementCurrencies: readonly string[];
  fundedPlan: boolean;
  financialReference?: OrthoFinancialReference;
  /** Read with the signing classifier in the same snapshot, never inferred from a schedule. */
  adjustmentClass?: BillingClassification;
}): LegacyOnboarding {
  const adjustmentClass = input.adjustmentClass ?? classifyOrthoAdjustment({
    legacy: input.legacy,
    financialMode: input.financialMode,
    openingCurrencies: input.openingCurrencies,
    fundedPlan: input.fundedPlan,
  });
  const financialReference = input.financialReference ?? missingOrthoFinancialReference();
  if (!input.legacy) {
    return { legacy: false, steps: [], complete: true, adjustmentClass, warning: null, financialReference };
  }
  const steps: OnboardingStep[] = [
    { key: "baseline", label: "لقطة الحالة السابقة (الأسلاك والمرحلة)", done: true, optional: false, hint: null },
    {
      key: "financial_mode", label: "طريقة المال قبل النظام", done: input.financialMode !== null, optional: false,
      hint: input.financialMode === null ? "حدّدها في لقطة الحالة: رصيد سابق، أو مدفوع مسبقًا، أو كل جلسة، أو أقساط." : null,
    },
  ];
  if (financialReference.state === "restricted") {
    return { legacy: true, steps: [steps[0]], complete: false, adjustmentClass, financialReference,
      warning: "تفاصيل المرجع المالي غير متاحة بصلاحيتك؛ لا يمكن تأكيد اكتمال التهيئة من هذه الشاشة." };
  }
  // Invoice/approved historical identity owns the financial reference. The old
  // intake mode is historical metadata; it cannot require another debt/plan.
  if (financialReference.state !== "missing") {
    steps[1] = { ...steps[1], optional: true };
    steps.push({ key: "financial_source", label: "مرجع العلاج المالي المرتبط بالحالة",
      done: financialReference.state === "linked", optional: false,
      hint: financialReference.state === "review" ? "المرجع محفوظ، لكن هويته أو صلاحيته تحتاج مراجعة في الحساب؛ لا تُنشئ دينًا بديلًا." : null });
    steps.push({ key: "arrangement", label: financialReference.sources.some((source) => source.kind === "historical_agreement")
      ? "جدول تحصيل لرصيد الحساب المشترك، لا تخصيص لهذه الحالة" : "جدول تحصيل لدين الفاتورة القائم", optional: true,
      done: financialReference.hasRecordedSchedule,
      hint: "اختياري: جدول التحصيل ينظّم سداد الدين القائم ولا ينشئ أصلًا جديدًا أو يحدد شمول الشدّة." });
    return { legacy: true, steps, complete: steps.every((step) => step.optional || step.done), adjustmentClass,
      financialReference, warning: adjustmentClass === "OUTSIDE_CONTRACT"
        ? "مرجع العلاج لا يثبت وحده شمول هذه الشدّة؛ يلزم قرار فوترة موثّق، دون إنشاء فاتورة أو رسوم تلقائيًا." : null };
  }
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
      key: "plan", label: input.fundedPlan ? "رابط اتفاق أقساط قديم محفوظ للتوافق" : "مرجع مالي موثّق لهذه الحالة", done: input.fundedPlan, optional: false,
      hint: input.fundedPlan ? null : "راجع الفاتورة أو الاتفاق السابق في الحساب وربطه ببند هذه الحالة. لا تُنشئ خطة أقساط أو فاتورة مكررة لإصلاح الربط.",
    });
  }
  const complete = steps.every((step) => step.optional || step.done);
  const warning = adjustmentClass === "OUTSIDE_CONTRACT" && input.financialMode !== "per_session"
    ? "الشدّة اليوم لن تُعدّ مشمولة: أكمل الخطوات الناقصة أعلاه، وإلا احتاجت قرار فوترة منفصلًا."
    : null;
  return { legacy: true, steps, complete, adjustmentClass, warning, financialReference };
}
