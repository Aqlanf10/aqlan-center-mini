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
 * حقيقي، فالمعتمَد هنا **التحصيل**: عمولةٌ على فاتورة لم تُحصَّل تعني أن يدفع صاحب
 * العيادة من ماله عن مريض لم يدفع، ثم يطارد المريض وحده.
 *
 * وتوزيع دفعات المريض على فواتيره **بالأقدم أولًا** (FIFO): المريض يدفع «على
 * حسابه» غالبًا لا على فاتورة بعينها، وهذا هو التوزيع الذي يفهمه الناس ويتوقعونه —
 * ويُنتج نفس النتيجة مهما اختلف ترتيب إدخال الدفعات.
 */

import type { CustomDoctorServiceRate, DoctorCommissionConfig, RateHistoryEntry } from "./doctor-permissions";

export interface DoctorShareItem {
  doctorId: number;
  amountMinor: number;
  serviceId?: number;
  serviceName?: string;
  category?: string;
  labCostMinor?: number;
  materialCostMinor?: number;
}

export interface CommissionInvoice {
  id: number;
  netMinor: number;
  createdAt: string;
  /** حصة كل طبيب من بنود هذه الفاتورة مع تفاصيل الخدمة والخصومات إن وجدت. */
  doctorShares: DoctorShareItem[];
}

export interface DoctorCommission {
  doctorId: number;
  /** نسبته من قيمة ما عمله كاملًا. */
  accruedMinor: number;
  /** نسبته من المحصّل فعلًا — وهو المستحق للدفع. */
  earnedMinor: number;
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
 * يوزّع ما دفعه المريض على فواتيره بالأقدم أولًا.
 *
 * يعيد لكل فاتورة ما غُطّي منها. المجموع لا يتجاوز المدفوع، والفائض عن كل الفواتير
 * يبقى رصيدًا للمريض ولا يُنسب إلى فاتورة — فلا يُحسب للطبيب عمولةٌ على مالٍ لم
 * يقابله عمل.
 */
export function allocateFifo(
  invoices: { id: number; netMinor: number; createdAt: string }[],
  collectedMinor: number,
): Map<number, number> {
  const allocation = new Map<number, number>();
  let pool = Math.max(0, collectedMinor);
  const ordered = [...invoices].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const invoice of ordered) {
    const covered = Math.min(pool, Math.max(0, invoice.netMinor));
    allocation.set(invoice.id, covered);
    pool -= covered;
  }
  return allocation;
}

/**
 * يحسب عمولة كل طبيب من فواتير مريض واحد.
 *
 * يدعم كلاً من النسب المباشرة أو مصفوفة الإعدادات المتقدمة لكل طبيب.
 */
export function commissionForPatient(
  invoices: CommissionInvoice[],
  collectedMinor: number,
  percentByDoctorOrConfig: Map<number, number> | Map<number, DoctorCommissionConfig>,
  /**
   * تصفية الفواتير المحسوبة — للتقارير بمدى تاريخي.
   */
  include?: (invoice: CommissionInvoice) => boolean,
): Map<number, { accruedMinor: number; earnedMinor: number }> {
  const allocation = allocateFifo(invoices, collectedMinor);
  const result = new Map<number, { accruedMinor: number; earnedMinor: number }>();

  for (const invoice of invoices) {
    if (invoice.netMinor <= 0) continue;
    if (include && !include(invoice)) continue;
    const covered = allocation.get(invoice.id) ?? 0;
    const ratio = Math.min(1, covered / invoice.netMinor);

    for (const share of invoice.doctorShares) {
      const docEntry = percentByDoctorOrConfig.get(share.doctorId);
      if (docEntry === undefined) continue;

      let percent = 0;
      let deductLab = true;
      let deductMaterials = false;
      let basis: "collected_cash" | "invoiced" = "collected_cash";

      if (typeof docEntry === "number") {
        percent = docEntry;
      } else {
        const policy = resolveDoctorEffectivePolicy(docEntry, invoice.createdAt, share.category, {
          serviceId: share.serviceId,
          serviceName: share.serviceName,
        });
        percent = policy.percent;
        deductLab = policy.deductLab;
        deductMaterials = policy.deductMaterials;
        basis = policy.basis;
      }

      if (percent <= 0) continue;

      let baseAmountMinor = share.amountMinor;
      if (deductLab && share.labCostMinor) {
        baseAmountMinor = Math.max(0, baseAmountMinor - share.labCostMinor);
      }
      if (deductMaterials && share.materialCostMinor) {
        baseAmountMinor = Math.max(0, baseAmountMinor - share.materialCostMinor);
      }

      const accrued = Math.round((baseAmountMinor * percent) / 100);
      const earned = basis === "invoiced" ? accrued : Math.round(accrued * ratio);

      const current = result.get(share.doctorId) ?? { accruedMinor: 0, earnedMinor: 0 };
      result.set(share.doctorId, {
        accruedMinor: current.accruedMinor + accrued,
        earnedMinor: current.earnedMinor + earned,
      });
    }
  }
  return result;
}

/** يجمع نتائج عدة مرضى ويطرح ما دُفع للطبيب. */
export function summarizeCommissions(
  perPatient: Map<number, { accruedMinor: number; earnedMinor: number }>[],
  paidByDoctor: Map<number, number>,
): DoctorCommission[] {
  const totals = new Map<number, { accruedMinor: number; earnedMinor: number }>();
  for (const entry of perPatient) {
    for (const [doctorId, value] of entry) {
      const current = totals.get(doctorId) ?? { accruedMinor: 0, earnedMinor: 0 };
      totals.set(doctorId, {
        accruedMinor: current.accruedMinor + value.accruedMinor,
        earnedMinor: current.earnedMinor + value.earnedMinor,
      });
    }
  }
  // الأطباء الذين صُرف لهم ولا عمولة محسوبة لهم يظهرون أيضًا: صرفٌ بلا استحقاق
  // مقابل هو ما يجب أن يُرى، لا أن يختفي من التقرير.
  for (const doctorId of paidByDoctor.keys()) {
    if (!totals.has(doctorId)) totals.set(doctorId, { accruedMinor: 0, earnedMinor: 0 });
  }

  return [...totals.entries()].map(([doctorId, value]) => {
    const paidMinor = paidByDoctor.get(doctorId) ?? 0;
    return {
      doctorId,
      accruedMinor: value.accruedMinor,
      earnedMinor: value.earnedMinor,
      paidMinor,
      dueMinor: value.earnedMinor - paidMinor,
    };
  }).sort((a, b) => b.dueMinor - a.dueMinor);
}
