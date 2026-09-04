/**
 * محرك تحليل ربحية الإجراءات السريرية وهامش المساهمة — المنطق الخالص.
 *
 * يربط بين إيراد المريض من الإجراء السني وتكاليفه المباشرة:
 * 1. تكلفة مختبر الأسنان (Dental Lab Fee).
 * 2. تكلفة المواد والمستهلكات السنية المستهلكة في الإجراء (Dental Materials).
 * 3. أتعاب وعمولة الطبيب المعالج (Doctor Commission).
 *
 * الصافي = الإيراد - (تكلفة المختبر + المواد + عمولة الطبيب)
 * هامش الربح % = (الصافي / الإيراد) × 100%
 */

export type ProfitabilityTier = "excellent" | "healthy" | "tight" | "loss_risk";

export interface ProfitabilityTierMeta {
  tier: ProfitabilityTier;
  label: string;
  badge: string;
  color: string;
  bg: string;
  icon: string;
  advice: string;
}

export const PROFITABILITY_TIER_META: Record<ProfitabilityTier, ProfitabilityTierMeta> = {
  excellent: {
    tier: "excellent",
    label: "عائد استثنائي ممتاز",
    badge: "ممتاز (≥ 55%)",
    color: "text-emerald-700",
    bg: "bg-emerald-50 border-emerald-200",
    icon: "💎",
    advice: "هامش مساهمة مرتفع وممتاز يغطي المصاريف التشغيلية ويحقق عائداً قوياً للمركز.",
  },
  healthy: {
    tier: "healthy",
    label: "هامش ربح صحي ومستقر",
    badge: "صحي (35% – 54%)",
    color: "text-sky-700",
    bg: "bg-sky-50 border-sky-200",
    icon: "✅",
    advice: "هامش ربح طبيعي ومتوازن ومتوافق مع المعايير القياسية لعيادات الأسنان.",
  },
  tight: {
    tier: "tight",
    label: "هامش ربح منخفض ومضغوط",
    badge: "منخفض (20% – 34%)",
    color: "text-amber-700",
    bg: "bg-amber-50 border-amber-200",
    icon: "⚠️",
    advice: "التكاليف المباشرة تستنزف النسبة الأكبر من السعر. يُفضل مراجعة تسعيرة الإجراء أو التفاوض مع المعمل.",
  },
  loss_risk: {
    tier: "loss_risk",
    label: "هامش حرج / خطر خسارة",
    badge: "حرج (< 20%)",
    color: "text-rose-700",
    bg: "bg-rose-50 border-rose-200",
    icon: "🚨",
    advice: "تنبيه رقابي: الإجراء قريب من التكلفة المباشرة أو يسبب خسارة بعد احتساب المعمل والمواد وعمولة الطبيب.",
  },
};

export interface ProcedureCostInput {
  serviceId?: number | null;
  serviceName: string;
  toothCode?: number | null;
  revenueMinor: number;
  labCostMinor?: number;
  materialCostMinor?: number;
  doctorCommissionMinor?: number;
  doctorCommissionPercent?: number;
}

export interface ProcedureProfitability {
  serviceId?: number | null;
  serviceName: string;
  toothCode?: number | null;
  revenueMinor: number;
  labCostMinor: number;
  materialCostMinor: number;
  doctorCommissionMinor: number;
  totalDirectCostMinor: number;
  netContributionMinor: number;
  marginPercent: number;
  tier: ProfitabilityTier;
}

export interface CaseProfitabilitySummary {
  totalRevenueMinor: number;
  totalLabCostMinor: number;
  totalMaterialCostMinor: number;
  totalDoctorCommissionMinor: number;
  totalDirectCostsMinor: number;
  netClinicProfitMinor: number;
  overallMarginPercent: number;
  tier: ProfitabilityTier;
  procedures: ProcedureProfitability[];
}

export function determineProfitabilityTier(marginPercent: number): ProfitabilityTier {
  if (marginPercent >= 55) return "excellent";
  if (marginPercent >= 35) return "healthy";
  if (marginPercent >= 20) return "tight";
  return "loss_risk";
}

export function calculateProcedureProfitability(input: ProcedureCostInput): ProcedureProfitability {
  const revenue = Math.max(0, input.revenueMinor || 0);
  const lab = Math.max(0, input.labCostMinor || 0);
  const material = Math.max(0, input.materialCostMinor || 0);
  const commission =
    input.doctorCommissionMinor !== undefined
      ? Math.max(0, input.doctorCommissionMinor)
      : input.doctorCommissionPercent !== undefined
      ? Math.round((revenue * Math.max(0, input.doctorCommissionPercent)) / 100)
      : 0;

  const totalDirectCost = lab + material + commission;
  const netContribution = revenue - totalDirectCost;

  const marginPercent = revenue > 0
    ? Math.round((netContribution / revenue) * 1000) / 10
    : 0;

  const tier = determineProfitabilityTier(marginPercent);

  return {
    serviceId: input.serviceId ?? null,
    serviceName: input.serviceName,
    toothCode: input.toothCode ?? null,
    revenueMinor: revenue,
    labCostMinor: lab,
    materialCostMinor: material,
    doctorCommissionMinor: commission,
    totalDirectCostMinor: totalDirectCost,
    netContributionMinor: netContribution,
    marginPercent,
    tier,
  };
}

export function calculateCaseProfitability(items: ProcedureCostInput[]): CaseProfitabilitySummary {
  const procedures = items.map(calculateProcedureProfitability);

  const totalRevenueMinor = procedures.reduce((sum, p) => sum + p.revenueMinor, 0);
  const totalLabCostMinor = procedures.reduce((sum, p) => sum + p.labCostMinor, 0);
  const totalMaterialCostMinor = procedures.reduce((sum, p) => sum + p.materialCostMinor, 0);
  const totalDoctorCommissionMinor = procedures.reduce((sum, p) => sum + p.doctorCommissionMinor, 0);

  const totalDirectCostsMinor =
    totalLabCostMinor + totalMaterialCostMinor + totalDoctorCommissionMinor;

  const netClinicProfitMinor = totalRevenueMinor - totalDirectCostsMinor;

  const overallMarginPercent = totalRevenueMinor > 0
    ? Math.round((netClinicProfitMinor / totalRevenueMinor) * 1000) / 10
    : 0;

  const tier = determineProfitabilityTier(overallMarginPercent);

  return {
    totalRevenueMinor,
    totalLabCostMinor,
    totalMaterialCostMinor,
    totalDoctorCommissionMinor,
    totalDirectCostsMinor,
    netClinicProfitMinor,
    overallMarginPercent,
    tier,
    procedures,
  };
}
