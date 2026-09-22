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

  // 1. أولاً: التحقق من وجود نسبة مخصصة محددة لهذه الخدمة بالذات (مثل التقويم أو الزراعة)
  if (serviceInfo && (serviceInfo.serviceId || serviceInfo.serviceName)) {
    const sId = serviceInfo.serviceId;
    const sName = serviceInfo.serviceName?.trim().toLowerCase() || "";

    // البحث في قائمة customServiceRates
    if (effectiveConfig.customServiceRates && effectiveConfig.customServiceRates.length > 0) {
      const match = effectiveConfig.customServiceRates.find((csr) => {
        if (sId && csr.serviceId && csr.serviceId === sId) return true;
        if (sName && csr.serviceName) {
          const csrName = csr.serviceName.trim().toLowerCase();
          return csrName === sName || sName.includes(csrName) || csrName.includes(sName);
        }
        return false;
      });

      if (match && typeof match.percent === "number") {
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

    // البحث في جدول فهرس serviceRates
    if (effectiveConfig.serviceRates) {
      if (sId && effectiveConfig.serviceRates[String(sId)] !== undefined) {
        return {
          percent: Math.max(0, Math.min(100, effectiveConfig.serviceRates[String(sId)])),
          deductLab: Boolean(effectiveConfig.deductLabCost),
          deductMaterials: Boolean(effectiveConfig.deductMaterialCost),
          basis: effectiveConfig.basis || "collected_cash",
          matchedRule: "custom_service",
          matchedServiceName: sName,
        };
      }
      if (sName && effectiveConfig.serviceRates[sName] !== undefined) {
        return {
          percent: Math.max(0, Math.min(100, effectiveConfig.serviceRates[sName])),
          deductLab: Boolean(effectiveConfig.deductLabCost),
          deductMaterials: Boolean(effectiveConfig.deductMaterialCost),
          basis: effectiveConfig.basis || "collected_cash",
          matchedRule: "custom_service",
          matchedServiceName: sName,
        };
      }
    }
  }

  // 2. ثانياً: إذا لم توجد نسبة خاصة بالخدمة، نعتمد طريقة الحساب (حسب القسم أو النسبة العامة)
  let percent = effectiveConfig.defaultPercent;
  let matchedRule: "custom_service" | "category" | "default" = "default";

  if (effectiveConfig.calculationMode === "by_category" && category && effectiveConfig.categoryRates?.[category] !== undefined) {
    percent = effectiveConfig.categoryRates[category];
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

interface ResolvedPolicy {
  percent: number;
  deductLab: boolean;
  deductMaterials: boolean;
  basis: "collected_cash" | "invoiced";
}

/** يطبّق لقطة السياسة على بند حصةٍ بعينه (خدمته وفئته) عند لحظة. */
export function resolvePolicyForShare(
  policy: CommissionPolicy,
  atIso: string,
  share: Pick<DoctorShareItem, "category" | "serviceId" | "serviceName">,
): ResolvedPolicy {
  if (!policy.config) {
    // النسبة العادية: على التحصيل، وتُخصم تكلفة المختبر (القاعدة المعتمدة).
    return { percent: clampPercent(policy.percent), deductLab: true, deductMaterials: false, basis: "collected_cash" };
  }
  const resolved = resolveDoctorEffectivePolicy(policy.config, atIso, share.category, {
    serviceId: share.serviceId,
    serviceName: share.serviceName,
  });
  return {
    percent: resolved.percent,
    deductLab: resolved.deductLab,
    deductMaterials: resolved.deductMaterials,
    basis: resolved.basis,
  };
}

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

/** أساس الاحتساب بعد الخصومات — لا يقلّ عن صفر، والمختبر مرّةً واحدة في البند. */
function shareBase(share: DoctorShareItem, policy: ResolvedPolicy): number {
  let base = share.amountMinor;
  if (policy.deductLab && share.labCostMinor) base = Math.max(0, base - share.labCostMinor);
  if (policy.deductMaterials && share.materialCostMinor) base = Math.max(0, base - share.materialCostMinor);
  return base;
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
 */
export function commissionForPatientAtEventTime(
  invoices: CommissionInvoice[],
  chunks: CoverageChunk[],
  policyAt: CommissionPolicyResolver,
  include?: (invoice: CommissionInvoice) => boolean,
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
      const atInvoice = resolvePolicyForShare(invoicePolicy, invoice.createdAt, share);
      const accrued = Math.round((shareBase(share, atInvoice) * atInvoice.percent) / 100);

      let earned = 0;
      if (atInvoice.basis === "invoiced") {
        earned = accrued;
      } else {
        /* الأجزاء تُجمع بحسب السياسة التي سرت عند دفعتها — فكل مجموعةٍ تُحسب
           بصيغتها الأصلية على ما غطّته هي وحدها. */
        const groups = new Map<string, { policy: ResolvedPolicy; covered: number }>();
        for (const chunk of covering) {
          const policy = policyAt(share.doctorId, chunk.sourceTime);
          if (!policy) continue;
          const resolved = resolvePolicyForShare(policy, chunk.sourceTime, share);
          const key = `${resolved.percent}|${resolved.deductLab}|${resolved.deductMaterials}`;
          const group = groups.get(key) ?? { policy: resolved, covered: 0 };
          group.covered += chunk.amount;
          groups.set(key, group);
        }
        for (const group of groups.values()) {
          if (group.policy.percent <= 0) continue;
          const groupAccrued = Math.round((shareBase(share, group.policy) * group.policy.percent) / 100);
          earned += Math.round(groupAccrued * Math.min(1, group.covered / invoice.netMinor));
        }
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
