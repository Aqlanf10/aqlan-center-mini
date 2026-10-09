/**
 * عمولات الأطباء — المنطق الخالص.
 *
 * السؤال الذي تجيب عنه هذه الوحدة: **كم يستحق الطبيب فعلًا؟** وهو سؤال له جوابان
 * مختلفان، والخلط بينهما هو ما يجعل صاحب العيادة يدفع من جيبه:
 *
 * - **المستحق على الفواتير**: نسبة الطبيب من قيمة ما عمله، مفوترًا كان أو محصّلًا.
 * - **المستحق على التحصيل**: نسبته من المال الذي **دخل الصندوق فعلًا**.
 *
 * الفرق بينهما هو المرضى الذين لم يدفعوا. ولأن العيادة تدفع للطبيب نقدًا من صندوق
 * حقيقي، فالمعتمَد هنا **التحصيل**: عمولةٌ على فاتورة لم تُحصّل تعني أن يدفع صاحب
 * العيادة من ماله عن مريض لم يدفع، ثم يطارد المريض وحده.
 *
 * (P-01 owner review — تصحيح ٢) العمولة **بعملة الاتفاق** في كل جانب: استحقاق
 * الفاتورة بعملة الفاتورة، وتوزيع الدفعات على فواتير دلوها فقط (FIFO داخل
 * العملة الواحدة)، والمصروف للطبيب يُقارن بما استحقه بعملته نفسها حصرًا. فالطبيب
 * الواحد قد يكون له يمنيٌّ مستحق وسعوديٌّ مستحق ودولارٌ مستحق — ثلاثة أرصدة
 * منفصلة لا رقمًا واحدًا يمزجها ولا تحويلًا صامتًا إلى يمني.
 */

import {
  CURRENCIES,
  FinancialCurrencyIntegrityError,
  type Currency,
} from "./money";
import type { CustomDoctorServiceRate, DoctorCommissionConfig } from "./doctor-permissions";
import { normalizeName } from "./duplicates";

export interface DoctorShareItem {
  doctorId: number;
  /** حصة الطبيب — بعملة الفاتورة التي جاء منها البند (تصحيح ٢). */
  amountMinor: number;
  /** (تصحيح ٢) عملة بند الحصة — عملة الفاتورة نفسها. */
  currency: Currency;
  serviceId?: number;
  serviceName?: string;
  category?: string;
  labCostMinor?: number;
  materialCostMinor?: number;
  /** (COMM-DETAIL-1) الحالة التخصصية للعمل — مشتقة: بند الفاتورة ← إجراء الزيارة ← بند الخطة. */
  caseId?: number;
  /** (COMM-DETAIL-1) خطة العلاج التي جاء منها العمل — مشتقة بالطريق نفسه. */
  planId?: number;
  /**
   * (FIN-DISC, owner decision: option 2) Admin-discount parts allocated to this share's lines, each at its decision time
   * (only decisions up to the report cutoff). The commission base is the share after them.
   */
  adminDiscounts?: { atIso: string; amountMinor: number }[];
}

export interface CommissionInvoice {
  id: number;
  /** صافي الفاتورة — بعملتها (تصحيح ٢). */
  netMinor: number;
  /** (تصحيح ٢) عملة الفاتورة — دلو التوزيع والاستحقاق كله. */
  currency: Currency;
  createdAt: string;
  /** حصة كل طبيب من بنود هذه الفاتورة مع تفاصيل الخدمة والخصومات إن وجدت. */
  doctorShares: DoctorShareItem[];
  /**
   * (FIN-DISC) Admin-discount decisions on this invoice up to the report cutoff, at their time. `netMinor` is the net after
   * them. Collections before a decision keep their commission; see `commissionForPatientAtEventTime`.
   */
  adminDiscounts?: { atIso: string; amountMinor: number }[];
}

export interface DoctorCommission {
  doctorId: number;
  /** (تصحيح ٢) عملة هذا الصف — استحقاقه ومصروفه ودَينه كلها بها. */
  currency: Currency;
  /** نسبته من قيمة ما عمله كاملًا — بعملة الاتفاق. */
  accruedMinor: number;
  /** نسبته من المحصّل فعلًا — وهو المستحق للدفع — بعملة الاتفاق. */
  earnedMinor: number;
  /** ما صُرف له بعملته نفسها حصرًا — لا يُطرح منه ما صُرف بعملةٍ أخرى. */
  paidMinor: number;
  dueMinor: number;
}

/**
 * يحدّد نسبة وسياسة الطبيب الفعالة في تاريخ إصدار الفاتورة وبند الخدمة المحدد.
 * إذا كانت هناك نسبة خاصة لخدمة معينة (مثل التقويم أو الزراعة) تُعتمد أولوياً بدلاً من النسبة العامة.
 */
export function resolveDoctorEffectivePolicy(
  config: DoctorCommissionConfig | undefined,
  invoiceDateStr: string,
  category?: string,
  serviceInfo?: { serviceId?: number; serviceName?: string },
): {
  percent: number;
  deductLab: boolean;
  deductMaterials: boolean;
  basis: "collected_cash" | "invoiced";
  matchedRule: "custom_service" | "category" | "default";
  matchedServiceName?: string;
} {
  if (!config) {
    return { percent: 0, deductLab: true, deductMaterials: false, basis: "collected_cash", matchedRule: "default" };
  }

  const invoiceDate = invoiceDateStr.slice(0, 10);
  let effectiveConfig: {
    calculationMode: "percentage" | "by_category" | "fixed";
    defaultPercent: number;
    categoryRates: Record<string, number>;
    customServiceRates?: CustomDoctorServiceRate[];
    serviceRates?: Record<string, number>;
    deductLabCost: boolean;
    deductMaterialCost: boolean;
    basis: "collected_cash" | "invoiced";
  } = config;

  // فحص السجل التاريخي للنسب: نأخذ النسخة التي كانت سارية في تاريخ الفاتورة
  if (config.rateHistory && config.rateHistory.length > 0) {
    const sorted = [...config.rateHistory].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
    const matched = sorted.find((h) => h.effectiveDate <= invoiceDate);
    if (matched) {
      effectiveConfig = matched;
    }
  }

  // 1. أولاً: نسبة خاصة لهذه الخدمة بالذات (مثل التقويم أو الزراعة).
  //    (COMM-DETAIL-1 · F-5) المطابقة **بمعرّف الخدمة** حين يوجد، وبالاسم المطبَّع
  //    **مطابقةً تامّة** للقواعد القديمة وحدها — لا «يحتوي» في أي اتجاه: قاعدة
  //    «زراعة» لا تمسّ «إزالة زراعة».
  if (serviceInfo && (serviceInfo.serviceId || serviceInfo.serviceName)) {
    const match = findServiceRate(effectiveConfig, serviceInfo.serviceId, serviceInfo.serviceName);
    if (match) {
      return {
        percent: Math.max(0, Math.min(100, match.percent)),
        deductLab: Boolean(effectiveConfig.deductLabCost),
        deductMaterials: Boolean(effectiveConfig.deductMaterialCost),
        basis: effectiveConfig.basis || "collected_cash",
        matchedRule: "custom_service",
        matchedServiceName: match.serviceName,
      };
    }
  }

  // 2. ثانياً: إذا لم توجد نسبة خاصة بالخدمة، نعتمد طريقة الحساب (حسب القسم أو النسبة العامة)
  let percent = effectiveConfig.defaultPercent;
  let matchedRule: "custom_service" | "category" | "default" = "default";

  const categoryRate = category && effectiveConfig.categoryRates && Object.hasOwn(effectiveConfig.categoryRates, category)
    ? effectiveConfig.categoryRates[category] : undefined;
  if (effectiveConfig.calculationMode === "by_category" && typeof categoryRate === "number" && Number.isFinite(categoryRate)) {
    percent = categoryRate;
    matchedRule = "category";
  }

  return {
    percent: Math.max(0, Math.min(100, percent)),
    deductLab: Boolean(effectiveConfig.deductLabCost),
    deductMaterials: Boolean(effectiveConfig.deductMaterialCost),
    basis: effectiveConfig.basis || "collected_cash",
    matchedRule,
  };
}

/** (F-5) تطبيع اسم الخدمة للمطابقة التامّة: المسافات والتشكيل وصور الألف والتاء والياء. */
export function normalizeServiceName(raw: string): string {
  return normalizeName(raw);
}

type ServiceRateSource = {
  customServiceRates?: CustomDoctorServiceRate[];
  serviceRates?: Record<string, number>;
};

/**
 * (COMM-DETAIL-1 · F-5) النسبة الخاصة المطابِقة لخدمة البند — أو لا شيء.
 *
 * - `customServiceRates` (إن لم تكن فارغة) هي المرجع، و`serviceRates` فهرسٌ مشتقّ
 *   منها فلا يُقرأ معها — كان مفتاح الاسم فيه يطابق خدمةً أخرى تحمل الاسم نفسه.
 * - بندٌ له معرّف خدمة: قاعدة بمعرّف ⇒ المعرّف نفسه حصرًا؛ قاعدة قديمة بلا معرّف ⇒
 *   الاسم المطبَّع مطابقةً تامّة.
 * - بندٌ بلا معرّف (وصفٌ حرّ): الاسم المطبَّع مطابقةً تامّة.
 * - فهرس `serviceRates` القديم وحده (بلا قائمة): مفتاحٌ رقمي = معرّف، وغيره اسمٌ تامّ.
 */
export function findServiceRate(
  config: ServiceRateSource,
  serviceId: number | undefined,
  serviceName: string | undefined,
): { percent: number; serviceName?: string } | undefined {
  const key = serviceName ? normalizeServiceName(serviceName) : "";
  const rules = config.customServiceRates ?? [];
  if (rules.length > 0) {
    if (serviceId) {
      const byId = rules.find((rule) => rule.serviceId === serviceId && typeof rule.percent === "number");
      if (byId) return { percent: byId.percent, serviceName: byId.serviceName };
    }
    if (!key) return undefined;
    const byName = rules.find((rule) =>
      typeof rule.percent === "number"
      && (!rule.serviceId || !serviceId)
      && typeof rule.serviceName === "string"
      && normalizeServiceName(rule.serviceName) === key);
    return byName ? { percent: byName.percent, serviceName: byName.serviceName } : undefined;
  }
  const index = config.serviceRates ?? {};
  if (serviceId && typeof index[String(serviceId)] === "number") {
    return { percent: index[String(serviceId)], serviceName };
  }
  if (!key) return undefined;
  for (const [name, percent] of Object.entries(index)) {
    if (/^\d+$/.test(name) || typeof percent !== "number") continue;
    if (normalizeServiceName(name) === key) return { percent, serviceName: name };
  }
  return undefined;
}

/** (F-5) ما لم يُحلّ من القواعد القديمة المخزَّنة بالاسم — يُقال للمالك ولا يُخمَّن. */
export interface ServiceRateFinding {
  doctorId: number;
  ruleName: string;
  percent: number;
  status: "ambiguous" | "unresolved";
  candidateServiceIds: number[];
}

/**
 * (F-5) يحلّ القواعد القديمة المخزَّنة بالاسم وحده إلى معرّف خدمة **مرّةً عند
 * التحميل** وفي الذاكرة فقط — لا يُعاد كتابة سجل النسب (إلحاقيّ).
 *
 * - اسمٌ يطابق خدمةً واحدة تمامًا ⇒ تُقرأ القاعدة بمعرّفها.
 * - اسمٌ يطابق أكثر من خدمة ⇒ «ملتبسة»: تبقى بالاسم التامّ (تنطبق على كل خدمةٍ
 *   بهذا الاسم حرفيًّا، كما كُتبت) وتُعرض للمالك ليختار الخدمة.
 * - اسمٌ لا يطابق خدمة ⇒ «غير محلولة»: تنطبق فقط على بندٍ وصفه الاسم نفسه، وتُعرض.
 */
export function resolveLegacyServiceRateNames(
  config: DoctorCommissionConfig,
  catalog: ReadonlyArray<{ id: number; name: string }>,
  doctorId: number,
  findings: ServiceRateFinding[],
): DoctorCommissionConfig {
  const byName = new Map<string, number[]>();
  for (const service of catalog) {
    const key = normalizeServiceName(service.name);
    byName.set(key, [...(byName.get(key) ?? []), service.id]);
  }
  const seen = new Set<string>();
  const resolveRules = (source: ServiceRateSource): CustomDoctorServiceRate[] | undefined => {
    let rules = source.customServiceRates ?? [];
    if (rules.length === 0 && source.serviceRates && Object.keys(source.serviceRates).length > 0) {
      // فهرسٌ قديم بلا قائمة: يُقرأ قواعدَ صريحة بالمعرّف أو بالاسم.
      rules = Object.entries(source.serviceRates)
        .filter(([, percent]) => typeof percent === "number")
        .map(([name, percent], index) => (/^\d+$/.test(name)
          ? { id: `legacy_${index}`, serviceId: Number(name), serviceName: name, percent }
          : { id: `legacy_${index}`, serviceName: name, percent }));
    }
    if (rules.length === 0) return source.customServiceRates;
    return rules.map((rule) => {
      if (rule.serviceId || typeof rule.serviceName !== "string" || !rule.serviceName.trim()) return rule;
      const candidates = byName.get(normalizeServiceName(rule.serviceName)) ?? [];
      if (candidates.length === 1) return { ...rule, serviceId: candidates[0] };
      const status = candidates.length === 0 ? "unresolved" : "ambiguous";
      const findingKey = `${status}|${normalizeServiceName(rule.serviceName)}|${rule.percent}`;
      if (!seen.has(findingKey)) {
        seen.add(findingKey);
        findings.push({ doctorId, ruleName: rule.serviceName, percent: rule.percent, status, candidateServiceIds: candidates });
      }
      return rule;
    });
  };
  return {
    ...config,
    customServiceRates: resolveRules(config),
    serviceRates: config.serviceRates,
    rateHistory: (config.rateHistory ?? []).map((entry) => ({ ...entry, customServiceRates: resolveRules(entry) })),
  };
}

/**
 * (P-01 owner review — تصحيح ٢) يوزّع محصّل كل عملة على فواتيرها بالأقدم أولًا.
 *
 * **دلو لكل عملة**: تحصيل الدولار يغطّي فواتير الدولار حصرًا، وتحصيل اليمني
 * فواتير اليمني — لا يعبر المال بين الدلاء. يعيد لكل فاتورة ما غُطّي منها
 * بعملتها؛ المجموع داخل الدلو لا يتجاوز محصّل الدلو، والفائض يبقى رصيدًا
 * للمريض في عملته ولا يُنسب إلى فاتورة — فلا عمولة على مالٍ لم يقابله عمل.
 */
export function allocateFifoByCurrency(
  invoices: { id: number; netMinor: number; createdAt: string; currency: Currency }[],
  collectedByCurrency: Record<Currency, number>,
): Map<number, number> {
  const allocation = new Map<number, number>();
  for (const currency of CURRENCIES) {
    let pool = Math.max(0, collectedByCurrency[currency] ?? 0);
    const ordered = invoices
      .filter((invoice) => invoice.currency === currency)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const invoice of ordered) {
      const covered = Math.min(pool, Math.max(0, invoice.netMinor));
      allocation.set(invoice.id, covered);
      pool -= covered;
    }
  }
  return allocation;
}

/**
 * (P0-1) سياسة عمولة الطبيب السارية في لحظةٍ ما — لقطةٌ كاملة من سجلّها الزمني.
 *
 * `config` = الإعداد المتقدّم إن وُجد (يغلب النسبة العادية لهذا الطبيب وحده)،
 * و`percent` = النسبة العادية المسجّلة على جهته. غياب الإعداد ⇒ النسبة العادية.
 */
export interface CommissionPolicy {
  percent: number;
  config: DoctorCommissionConfig | null;
}

/** يحلّ سياسة طبيبٍ عند لحظة (ISO) — `undefined` = طبيبٌ لا سياسة له فلا عمولة. */
export type CommissionPolicyResolver = (doctorId: number, atIso: string) => CommissionPolicy | undefined;

/**
 * (P0-1) جزءٌ من تحصيلٍ غطّى فاتورة: مبلغه بعملة الفاتورة ولحظة **دفعته الأصلية**.
 * النسبة تُحلّ عند هذه اللحظة — فتغيير النسبة لاحقًا لا يمسّ ما قُبض قبله.
 */
export interface CoverageChunk {
  invoiceId: number;
  amount: number;
  sourceTime: string;
}

/** (COMM-DETAIL-1) مصدر النسبة المطبَّقة على بند — بترتيب الأولوية. */
export type CommissionRuleSource = "case_override" | "custom_service" | "category" | "default";

export const RULE_SOURCE_LABEL: Record<CommissionRuleSource, string> = {
  case_override: "نسبة خاصة بالحالة",
  custom_service: "نسبة الخدمة",
  category: "نسبة التخصص",
  default: "النسبة الافتراضية للطبيب",
};

/** (F-11) نسبةٌ خاصة بحالة/خطة سارية لحظة الحدث — من سجلٍّ إلحاقيّ. */
export interface CaseOverrideHit {
  overrideId: number;
  percent: number;
}

/** يحلّ النسبة الخاصة لبند حصةٍ عند لحظة — `undefined` = لا نسبة خاصة (يسقط إلى الخدمة ثم التخصص ثم الافتراضي). */
export type CaseOverrideResolver = (
  doctorId: number,
  share: Pick<DoctorShareItem, "caseId" | "planId">,
  atIso: string,
) => CaseOverrideHit | undefined;

/** صفّ من سجل النسب الخاصة (`commission_case_overrides`) كما يُقرأ. */
export interface CaseOverrideRow {
  id: number;
  doctorId: number;
  caseId: number | null;
  planId: number | null;
  percent: number | null;
  action: "set" | "void";
  effectiveFrom: string;
}

/**
 * (F-11) المحلِّل: لكل (طبيب، حالة) أو (طبيب، خطة) عند لحظة t ⇒ **أحدث صفٍّ سريانه ≤ t**
 * (والتعادل للأحدث إدراجًا). إن كان «إلغاءً» فلا نسبة خاصة، ويسقط الحساب إلى الخدمة ثم
 * التخصص ثم الافتراضي. الحالة أولى من الخطة حين يحمل البند الاثنين.
 */
export function buildCaseOverrideResolver(rows: readonly CaseOverrideRow[]): CaseOverrideResolver {
  const timelines = new Map<string, Array<{ at: number; id: number; row: CaseOverrideRow }>>();
  for (const row of rows) {
    const key = row.caseId !== null ? `c:${row.doctorId}:${row.caseId}` : row.planId !== null ? `p:${row.doctorId}:${row.planId}` : null;
    if (!key) continue;
    const list = timelines.get(key) ?? [];
    list.push({ at: new Date(row.effectiveFrom).getTime(), id: row.id, row });
    timelines.set(key, list);
  }
  for (const list of timelines.values()) list.sort((a, b) => a.at - b.at || a.id - b.id);
  const latestAt = (key: string, at: number): CaseOverrideRow | undefined => {
    const list = timelines.get(key);
    if (!list) return undefined;
    let chosen: CaseOverrideRow | undefined;
    for (const entry of list) {
      if (entry.at <= at) chosen = entry.row;
      else break;
    }
    return chosen;
  };
  return (doctorId, share, atIso) => {
    const at = new Date(atIso).getTime();
    for (const key of [
      share.caseId ? `c:${doctorId}:${share.caseId}` : null,
      share.planId ? `p:${doctorId}:${share.planId}` : null,
    ]) {
      if (!key) continue;
      const row = latestAt(key, at);
      if (row && row.action === "set" && row.percent !== null) {
        return { overrideId: row.id, percent: row.percent };
      }
      // «إلغاء» أو لا صفّ: ننتقل إلى المستوى التالي (الخطة) ثم إلى قواعد الطبيب.
    }
    return undefined;
  };
}

interface ResolvedPolicy {
  percent: number;
  deductLab: boolean;
  deductMaterials: boolean;
  basis: "collected_cash" | "invoiced";
  /** (COMM-DETAIL-1) من أين جاءت النسبة — للشرح لا للحساب. */
  ruleSource: CommissionRuleSource;
  overrideId?: number;
}

/**
 * يطبّق لقطة السياسة على بند حصةٍ بعينه (خدمته وفئته) عند لحظة. (F-11) النسبة الخاصة
 * بالحالة — إن وُجدت ساريةً — تغلب النسبة وحدها؛ والخصومات والأساس من سياسة الطبيب.
 */
export function resolvePolicyForShare(
  policy: CommissionPolicy,
  atIso: string,
  share: Pick<DoctorShareItem, "category" | "serviceId" | "serviceName">,
  override?: CaseOverrideHit,
): ResolvedPolicy {
  let resolved: ResolvedPolicy;
  if (!policy.config) {
    // النسبة العادية: على التحصيل، وتُخصم تكلفة المختبر (القاعدة المعتمدة).
    resolved = { percent: clampPercent(policy.percent), deductLab: true, deductMaterials: false, basis: "collected_cash", ruleSource: "default" };
  } else {
    const effective = resolveDoctorEffectivePolicy(policy.config, atIso, share.category, {
      serviceId: share.serviceId,
      serviceName: share.serviceName,
    });
    resolved = {
      percent: effective.percent,
      deductLab: effective.deductLab,
      deductMaterials: effective.deductMaterials,
      basis: effective.basis,
      ruleSource: effective.matchedRule,
    };
  }
  if (override) {
    return { ...resolved, percent: clampPercent(override.percent), ruleSource: "case_override", overrideId: override.overrideId };
  }
  return resolved;
}

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

/** أساس الاحتساب بعد الخصومات — لا يقلّ عن صفر، والمختبر مرّةً واحدة في البند. */
function shareBase(share: DoctorShareItem, policy: Pick<ResolvedPolicy, "deductLab" | "deductMaterials">): number {
  let base = share.amountMinor;
  if (policy.deductLab && share.labCostMinor) base = Math.max(0, base - share.labCostMinor);
  if (policy.deductMaterials && share.materialCostMinor) base = Math.max(0, base - share.materialCostMinor);
  return base;
}

/** (COMM-DETAIL-1) جزءٌ من المستحق على التحصيل بنسبةٍ واحدة — لشرح سطر التفصيل. */
export interface CommissionEarnedPart {
  percent: number;
  ruleSources: CommissionRuleSource[];
  overrideIds: number[];
  /** ما غطّته دفعات هذه النسبة من صافي الفاتورة (بعملتها). */
  coveredMinor: number;
  earnedMinor: number;
}

/**
 * (COMM-DETAIL-1 · F-8) سطر تفصيل: حصة طبيبٍ واحدة من فاتورة واحدة كما حسبها المحرّك نفسه.
 * لا يُعاد الحساب خارج المحرّك: مجموع السطور = المجاميع حرفيًّا.
 */
export interface CommissionDetailLine {
  invoiceId: number;
  invoiceCreatedAt: string;
  invoiceNetMinor: number;
  invoiceCoveredMinor: number;
  doctorId: number;
  currency: Currency;
  serviceId: number | null;
  serviceName: string | null;
  category: string | null;
  caseId: number | null;
  planId: number | null;
  /** حصة الطبيب من البند قبل أي خصم. */
  amountMinor: number;
  /** (FIN-DISC) Admin discount allocated to this share up to the cutoff (0 when none). */
  adminDiscountMinor: number;
  labCostMinor: number;
  materialCostMinor: number;
  labDeducted: boolean;
  materialDeducted: boolean;
  /** الأساس بعد الخصومات بسياسة وقت الفاتورة. */
  baseMinor: number;
  percent: number;
  ruleSource: CommissionRuleSource;
  overrideId: number | null;
  basis: "collected_cash" | "invoiced";
  accruedMinor: number;
  earnedMinor: number;
  earnedParts: CommissionEarnedPart[];
}

export type CommissionDetailSink = (line: CommissionDetailLine) => void;

export interface CommissionEngineOptions {
  /** (F-11) النسب الخاصة بالحالات — تُحلّ وقت كل حدث. */
  overrideAt?: CaseOverrideResolver;
  /** (F-8) مصبّ التفصيل — لا يغيّر شيئًا من الحساب. */
  sink?: CommissionDetailSink;
}

/**
 * (P0-1) المحرّك الواحد: عمولة كل (طبيب × عملة) من فواتير مريضٍ واحد، بسياسة
 * **وقت الحدث**.
 *
 *  - المستحق على الفاتورة (accrued) = (حصته − مختبره) × النسبة السارية **وقت الفاتورة**.
 *  - المستحق على التحصيل (earned) = لكل جزء تحصيل غطّى الفاتورة: نصيبه من الأساس ×
 *    النسبة السارية **وقت دفعته الأصلية**. فتغيير النسبة اليوم لا يعيد كتابة ما قُبض
 *    أمس، وتحصيلٌ بعد التغيير يأخذ الجديدة.
 *  - الأساس «مفوتَر» (basis: invoiced) في سياسة الفاتورة ⇒ المستحق = accrued.
 *
 * وحين تكون النسبة ثابتة عبر الأجزاء كلها تساوي النتيجة حرفيًّا الصيغة القديمة
 * `round(accrued × covered/net)` — فالتقارير التاريخية لا تتزحزح بالانتقال.
 *
 * (COMM-DETAIL-1) `options.overrideAt` يُدخل النسبة الخاصة بالحالة في الحلّ نفسه عند
 * كل حدث، و`options.sink` يستقبل سطرًا لكل حصةٍ محسوبة — المحرّك واحد، والتفصيل مصبٌّ له.
 */
export function commissionForPatientAtEventTime(
  invoices: CommissionInvoice[],
  chunks: CoverageChunk[],
  policyAt: CommissionPolicyResolver,
  include?: (invoice: CommissionInvoice) => boolean,
  options: CommissionEngineOptions = {},
): Map<number, Record<Currency, { accruedMinor: number; earnedMinor: number }>> {
  const result = new Map<number, Record<Currency, { accruedMinor: number; earnedMinor: number }>>();
  const bump = (doctorId: number, currency: Currency, accrued: number, earned: number) => {
    const byCurrency = result.get(doctorId) ?? {
      YER: { accruedMinor: 0, earnedMinor: 0 },
      SAR: { accruedMinor: 0, earnedMinor: 0 },
      USD: { accruedMinor: 0, earnedMinor: 0 },
    };
    byCurrency[currency].accruedMinor += accrued;
    byCurrency[currency].earnedMinor += earned;
    result.set(doctorId, byCurrency);
  };
  const { overrideAt, sink } = options;
  const overrideFor = (doctorId: number, share: DoctorShareItem, atIso: string) =>
    overrideAt && (share.caseId || share.planId) ? overrideAt(doctorId, share, atIso) : undefined;

  const chunksByInvoice = new Map<number, CoverageChunk[]>();
  for (const chunk of chunks) {
    if (chunk.amount <= 0) continue;
    const list = chunksByInvoice.get(chunk.invoiceId) ?? [];
    list.push(chunk);
    chunksByInvoice.set(chunk.invoiceId, list);
  }

  for (const invoice of invoices) {
    if (invoice.netMinor <= 0) continue;
    if (include && !include(invoice)) continue;
    const covering = chunksByInvoice.get(invoice.id) ?? [];

    for (const share of invoice.doctorShares) {
      // (تصحيح ٣) حصة بعملةٍ تخالف فاتورتها = فساد بيانات يُقال لا يُدار.
      if (share.currency !== invoice.currency) {
        throw new FinancialCurrencyIntegrityError(
          `بند حصة طبيب بعملة تخالف فاتورته`,
          `فاتورة #${invoice.id} · حصة ${share.currency} على فاتورة ${invoice.currency}`,
          share.currency,
        );
      }
      const invoicePolicy = policyAt(share.doctorId, invoice.createdAt);
      if (!invoicePolicy) continue;
      const atInvoice = resolvePolicyForShare(
        invoicePolicy, invoice.createdAt, share, overrideFor(share.doctorId, share, invoice.createdAt),
      );
      /*
       * (FIN-DISC, owner decision: option 2) An admin discount lowers the commission base of the lines it was allocated to,
       * from its decision time on. Collections before a decision keep exactly what they earned (the classic proportion);
       * later collections earn from the remaining base over the remaining net, so a fully collected invoice ends at the
       * reduced accrual. Invoices without admin discounts take the unchanged path below.
       */
      const invoiceEvents = invoice.adminDiscounts ?? [];
      const shareEvents = share.adminDiscounts ?? [];
      const timed = invoiceEvents.length > 0;
      const shareDiscountMinor = shareEvents.reduce((sum, event) => sum + event.amountMinor, 0);
      const shareAt = (iso: string) => share.amountMinor
        - shareEvents.filter((event) => event.atIso <= iso).reduce((sum, event) => sum + event.amountMinor, 0);
      const netAt = (iso: string) => invoice.netMinor
        + invoiceEvents.filter((event) => event.atIso > iso).reduce((sum, event) => sum + event.amountMinor, 0);
      const current: DoctorShareItem = timed ? { ...share, amountMinor: share.amountMinor - shareDiscountMinor } : share;
      const accrued = Math.round((shareBase(current, atInvoice) * atInvoice.percent) / 100);

      let earned = 0;
      const parts: CommissionEarnedPart[] = [];
      if (atInvoice.basis === "invoiced") {
        earned = accrued;
      } else {
        /* الأجزاء تُجمع بحسب السياسة التي سرت عند دفعتها — فكل مجموعةٍ تُحسب
           بصيغتها الأصلية على ما غطّته هي وحدها. */
        const groups = new Map<string, { policy: ResolvedPolicy; covered: number; sources: Set<CommissionRuleSource>; overrides: Set<number> }>();
        const chunkKeys: (string | null)[] = [];
        for (const chunk of covering) {
          const policy = policyAt(share.doctorId, chunk.sourceTime);
          if (!policy) { chunkKeys.push(null); continue; }
          const resolved = resolvePolicyForShare(
            policy, chunk.sourceTime, share, overrideFor(share.doctorId, share, chunk.sourceTime),
          );
          const key = `${resolved.percent}|${resolved.deductLab}|${resolved.deductMaterials}`;
          chunkKeys.push(key);
          const group = groups.get(key) ?? { policy: resolved, covered: 0, sources: new Set(), overrides: new Set() };
          group.covered += chunk.amount;
          group.sources.add(resolved.ruleSource);
          if (resolved.overrideId !== undefined) group.overrides.add(resolved.overrideId);
          groups.set(key, group);
        }
        for (const [groupKey, group] of groups) {
          if (group.policy.percent <= 0) continue;
          let part: number;
          if (!timed) {
            const groupAccrued = Math.round((shareBase(share, group.policy) * group.policy.percent) / 100);
            part = Math.round(groupAccrued * Math.min(1, group.covered / invoice.netMinor));
          } else {
            /* Collections before the first decision earn exactly the classic amount (same formula, same rounding, on the
               net as it stood then), so a decision can never lower what was already earned — or paid out. Collections
               from a decision on earn the remaining base over the remaining net, in collection order, with this group's
               base rules; added once and rounded once. */
            const firstEventIso = invoiceEvents.reduce((min, event) => (event.atIso < min ? event.atIso : min), invoiceEvents[0].atIso);
            const netBefore = netAt("");
            let preCovered = 0;
            let consumed = 0;
            let coveredSoFar = 0;
            let laterMine = 0;
            covering.forEach((chunk, index) => {
              const base = shareBase({ ...share, amountMinor: shareAt(chunk.sourceTime) }, group.policy);
              const remainingBase = Math.max(0, base - consumed);
              const remainingNet = netAt(chunk.sourceTime) - coveredSoFar;
              const portion = remainingNet > 0 ? Math.min(remainingBase, (remainingBase * chunk.amount) / remainingNet) : 0;
              consumed += portion;
              coveredSoFar += chunk.amount;
              if (chunkKeys[index] !== groupKey) return;
              if (chunk.sourceTime < firstEventIso) preCovered += chunk.amount;
              else laterMine += portion;
            });
            const accruedBefore = Math.round((shareBase(share, group.policy) * group.policy.percent) / 100);
            const prePart = preCovered > 0 && netBefore > 0 ? Math.round(accruedBefore * Math.min(1, preCovered / netBefore)) : 0;
            part = prePart + Math.round((laterMine * group.policy.percent) / 100);
          }
          earned += part;
          parts.push({
            percent: group.policy.percent,
            ruleSources: [...group.sources],
            overrideIds: [...group.overrides],
            coveredMinor: group.covered,
            earnedMinor: part,
          });
        }
      }
      if (sink) {
        sink({
          invoiceId: invoice.id,
          invoiceCreatedAt: invoice.createdAt,
          invoiceNetMinor: invoice.netMinor,
          invoiceCoveredMinor: covering.reduce((sum, chunk) => sum + chunk.amount, 0),
          doctorId: share.doctorId,
          currency: invoice.currency,
          serviceId: share.serviceId ?? null,
          serviceName: share.serviceName ?? null,
          category: share.category ?? null,
          caseId: share.caseId ?? null,
          planId: share.planId ?? null,
          amountMinor: share.amountMinor,
          adminDiscountMinor: timed ? shareDiscountMinor : 0,
          labCostMinor: share.labCostMinor ?? 0,
          materialCostMinor: share.materialCostMinor ?? 0,
          labDeducted: atInvoice.deductLab && Boolean(share.labCostMinor),
          materialDeducted: atInvoice.deductMaterials && Boolean(share.materialCostMinor),
          baseMinor: shareBase(current, atInvoice),
          percent: atInvoice.percent,
          ruleSource: atInvoice.ruleSource,
          overrideId: atInvoice.overrideId ?? null,
          basis: atInvoice.basis,
          accruedMinor: accrued,
          earnedMinor: earned,
          earnedParts: parts,
        });
      }
      if (accrued === 0 && earned === 0) continue;
      bump(share.doctorId, invoice.currency, accrued, earned);
    }
  }
  return result;
}

/**
 * (تصحيح ٢) يحسب عمولة كل طبيب من فواتير مريض واحد — لكل (طبيب × عملة).
 *
 * واجهةٌ مبسّطة فوق المحرّك الواحد (P0-1): توزيعٌ FIFO بلا طوابع دفعات — فكل تغطية
 * تُعامل كأنها وقت فاتورتها، والسياسة ثابتة لكل طبيب. تبقى للاختبارات والاستدعاءات
 * البسيطة؛ تقرير العمولات نفسه يمرّر أجزاء التحصيل بطوابعها الفعلية.
 */
export function commissionForPatient(
  invoices: CommissionInvoice[],
  collectedByCurrency: Record<Currency, number>,
  percentByDoctorOrConfig: Map<number, number> | Map<number, DoctorCommissionConfig>,
  /**
   * تصفية الفواتير المحسوبة — للتقارير بمدى تاريخي.
   */
  include?: (invoice: CommissionInvoice) => boolean,
): Map<number, Record<Currency, { accruedMinor: number; earnedMinor: number }>> {
  const allocation = allocateFifoByCurrency(invoices, collectedByCurrency);
  const chunks: CoverageChunk[] = invoices.map((invoice) => ({
    invoiceId: invoice.id,
    amount: allocation.get(invoice.id) ?? 0,
    sourceTime: invoice.createdAt,
  }));
  const policyAt: CommissionPolicyResolver = (doctorId) => {
    const entry = (percentByDoctorOrConfig as Map<number, number | DoctorCommissionConfig>).get(doctorId);
    if (entry === undefined) return undefined;
    return typeof entry === "number"
      ? { percent: entry, config: null }
      : { percent: entry.defaultPercent, config: entry };
  };
  return commissionForPatientAtEventTime(invoices, chunks, policyAt, include);
}

/** (تصحيح ٢) يجمع نتائج عدة مرضى ويطرح ما دُفع للطبيب بعملته نفسها. */
export function summarizeCommissions(
  perPatient: Map<number, Record<Currency, { accruedMinor: number; earnedMinor: number }>>[],
  paidByDoctor: Map<number, Record<Currency, number>>,
): DoctorCommission[] {
  const emptyByCurrency = () => ({
    YER: { accruedMinor: 0, earnedMinor: 0 },
    SAR: { accruedMinor: 0, earnedMinor: 0 },
    USD: { accruedMinor: 0, earnedMinor: 0 },
  });
  const totals = new Map<number, Record<Currency, { accruedMinor: number; earnedMinor: number }>>();
  for (const entry of perPatient) {
    for (const [doctorId, byCurrency] of entry) {
      const current = totals.get(doctorId) ?? emptyByCurrency();
      for (const currency of CURRENCIES) {
        current[currency].accruedMinor += byCurrency?.[currency]?.accruedMinor ?? 0;
        current[currency].earnedMinor += byCurrency?.[currency]?.earnedMinor ?? 0;
      }
      totals.set(doctorId, current);
    }
  }
  // الأطباء الذين صُرف لهم ولا عمولة محسوبة لهم يظهرون أيضًا: صرفٌ بلا استحقاق
  // مقابل هو ما يجب أن يُرى، لا أن يختفي من التقرير — بعملة الصرف نفسها.
  for (const doctorId of paidByDoctor.keys()) {
    if (!totals.has(doctorId)) totals.set(doctorId, emptyByCurrency());
  }

  const rows: DoctorCommission[] = [];
  for (const [doctorId, byCurrency] of totals) {
    for (const currency of CURRENCIES) {
      const value = byCurrency[currency];
      const paidMinor = paidByDoctor.get(doctorId)?.[currency] ?? 0;
      if (value.accruedMinor === 0 && value.earnedMinor === 0 && paidMinor === 0) continue;
      rows.push({
        doctorId,
        currency,
        accruedMinor: value.accruedMinor,
        earnedMinor: value.earnedMinor,
        paidMinor,
        dueMinor: value.earnedMinor - paidMinor,
      });
    }
  }
  // (P-01/D-1) الترتيب داخل العملة فقط: العملات بترتيب الدلاء ثم الدَّين
  // تنازليًا داخل عملته — لا مقارنة عابرة للعملات بالوحدات الصغرى.
  return rows.sort((a, b) => {
    const currencyOrder = CURRENCIES.indexOf(a.currency) - CURRENCIES.indexOf(b.currency);
    if (currencyOrder !== 0) return currencyOrder;
    return b.dueMinor - a.dueMinor;
  });
}
