import { addDays } from "./schedule";
import type { Currency } from "./money";

/**
 * أعمال المختبرات السنية (Dental Laboratory Management V2) — المنطق الخالص.
 *
 * يعالج إدارة التركيبات والأجهزة التقويمية سريريًا ومتابعة جاهزيتها
 * مع الفصل الصارم بين المسار السريري (الطبيب والطاقم) والتكلفة المحاسبية (المسؤول المالي).
 * مدموجة مع رحلة المريض V2 (§١٩): حالة `needed` للأعمال التي يولّدها توقيع الزيارة
 * تلقائيًا (تاج/جسر/قشرة) قبل إرسالها للمختبر، وزر `source` يميز تلقائي الزيارة من
 * يدوي الشاشة، و`toothCode` سنّ الإجراء الذي ولّد الطلب.
 */

export type LabOrderStatus =
  | "needed"
  | "sent"
  | "in_progress"
  | "received"
  | "delivered"
  | "remake"
  | "cancelled";
export type LabOrderPriority = "normal" | "urgent" | "rush";
export type LabImpressionType = "physical" | "digital_scan" | "alginate" | "silicone" | "other";
export type LabQualityCheckStatus = "pending" | "passed" | "rejected";
export type LabFinancialStatus = "pending_delivery" | "payable_created" | "paid" | "exempt";
export type LabServiceCategory = "prostho" | "ortho" | "implant" | "restorative" | "appliance" | "other";
export type LabToothScope = "single_tooth" | "multi_teeth_bridge" | "full_arch" | "general";

export interface LabService {
  id: number;
  name: string;
  code: string | null;
  category: LabServiceCategory;
  toothScope: LabToothScope;
  requiresShade: boolean;
  defaultDays: number;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  activeOrdersCount?: number;
  totalOrdersCount?: number;
  createdAt?: string;
}

export interface LabPricingRule {
  id: number;
  partyId: number;
  partyName?: string;
  labServiceId: number;
  serviceName?: string;
  costMinor: number;
  costCurrency: Currency;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null; // YYYY-MM-DD or null
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export interface LabOrderTrackingEvent {
  id: number;
  labOrderId: number;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  notes: string | null;
  actor: string;
  actorRole: string | null;
  createdAt: string;
}

/**
 * البيانات السريرية لأمر المختبر (يتاح للأطباء والتمريض وموظفي الاستقبال) — بلا أي ذكر للتكلفة المالية.
 */
export interface LabOrderClinicalDTO {
  id: number;
  patientId: number;
  patientName: string;
  patientNumber: string | null;
  patientPhone: string | null;
  labName: string;
  labPhone: string | null;
  partyId: number | null;
  labServiceId: number | null;
  serviceName?: string | null;
  workType: string;
  details: string | null;
  toothNumbers: string | null;
  shade: string | null;
  stumpShade: string | null;
  priority: LabOrderPriority;
  impressionType: LabImpressionType;
  sentDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  status: LabOrderStatus;
  receivedAt: string | null;
  deliveredAt: string | null;
  doctorId: number | null;
  doctorName?: string | null;
  visitId: number | null;
  /** سنّ الإجراء الذي ولّد الطلب (V2 §١٩) — طلب الزيارة له سنّه. */
  toothCode?: number | null;
  /** auto: تولّد من توقيع زيارة؛ manual: أُنشئ من شاشة (V2 §١٩). */
  source?: "auto" | "manual" | null;
  qualityCheck: LabQualityCheckStatus;
  qualityNotes: string | null;
  remakeOriginalId: number | null;
  remakeReason: string | null;
  technicianName: string | null;
  note: string | null;
  createdAt: string;
  events?: LabOrderTrackingEvent[];
}

/**
 * البيانات المالية لأمر المختبر (مخصصة للمدير المالي والمسؤولين ذوي الصلاحيات المالية فقط).
 */
export interface LabOrderFinancialDTO extends LabOrderClinicalDTO {
  costMinor: number | null;
  costCurrency: Currency | null;
  baseAmountMinor: number | null;
  exchangeRate: number;
  financialStatus: LabFinancialStatus;
  payableId: number | null;
  pricingRuleId?: number | null;
}

export interface LabOrder extends LabOrderClinicalDTO {
  costMinor?: number | null;
  costCurrency?: Currency | null;
  baseAmountMinor?: number | null;
  exchangeRate?: number | null;
  financialStatus?: LabFinancialStatus;
  payableId?: number | null;
}

export const PENDING_LAB_NAME = "لم يُحدَّد بعد";

export const LAB_STATUS_LABEL: Record<LabOrderStatus, string> = {
  needed: "لم يُرسل بعد",
  sent: "عند المختبر",
  in_progress: "قيد التصنيع",
  received: "وصل العيادة",
  delivered: "رُكّب للمريض",
  remake: "إعادة تصنيع (Remake)",
  cancelled: "ملغى",
};

export const LAB_PRIORITY_LABEL: Record<LabOrderPriority, { label: string; bg: string; text: string }> = {
  normal: { label: "عادي", bg: "bg-slate-100", text: "text-slate-700" },
  urgent: { label: "عاجل", bg: "bg-amber-100", text: "text-amber-800" },
  rush: { label: "طارئ جداً (Rush)", bg: "bg-red-100", text: "text-red-800" },
};

export const LAB_IMPRESSION_LABEL: Record<LabImpressionType, string> = {
  physical: "طبعة تقليدية (فيزيائية)",
  digital_scan: "مسح ضوئي رقمي (Digital Scan)",
  alginate: "طبعة ألجينات (Alginate)",
  silicone: "طبعة مطاطية (Addition Silicone)",
  other: "أخرى",
};

export const LAB_QUALITY_LABEL: Record<LabQualityCheckStatus, { label: string; color: string }> = {
  pending: { label: "بانتظار الفحص", color: "text-amber-600" },
  passed: { label: "مطابق ومقبول ✓", color: "text-emerald-700" },
  rejected: { label: "مرفوض (يحتاج تعديل/إعادة)", color: "text-red-700" },
};

/** ألوان وظلال VITA الكلاسيكية والمتقدمة */
export const VITA_CLASSICAL_SHADES = [
  "A1", "A2", "A3", "A3.5", "A4",
  "B1", "B2", "B3", "B4",
  "C1", "C2", "C3", "C4",
  "D2", "D3", "D4",
];

export const VITA_BLEACH_SHADES = ["OM1", "OM2", "OM3", "BL1", "BL2", "BL3", "BL4"];

export const VITA_3D_MASTER_SHADES = [
  "1M1", "1M2", "2L1.5", "2L2.5", "2M1", "2M2", "2M3", "2R1.5", "2R2.5",
  "3L1.5", "3L2.5", "3M1", "3M2", "3M3", "3R1.5", "3R2.5",
  "4L1.5", "4L2.5", "4M1", "4M2", "4M3", "4R1.5", "4R2.5",
  "5M1", "5M2", "5M3",
];

export const STUMP_SHADES_ND = ["ND1", "ND2", "ND3", "ND4", "ND5", "ND6", "ND7", "ND8", "ND9"];

/** أرقام الأسنان الدائمة واللبنية بنظام FDI العالمي (11-48, 51-85) */
export const ADULT_FDI_TEETH = {
  upperRight: [18, 17, 16, 15, 14, 13, 12, 11],
  upperLeft: [21, 22, 23, 24, 25, 26, 27, 28],
  lowerLeft: [31, 32, 33, 34, 35, 36, 37, 38],
  lowerRight: [48, 47, 46, 45, 44, 43, 42, 41],
};

export const PRIMARY_FDI_TEETH = {
  upperRight: [55, 54, 53, 52, 51],
  upperLeft: [61, 62, 63, 64, 65],
  lowerLeft: [71, 72, 73, 74, 75],
  lowerRight: [85, 84, 83, 82, 81],
};

/** أدوار السن في طلبات ووصفات المختبر (Prosthodontic Roles) */
export type LabToothRole = "crown" | "abutment" | "pontic" | "veneer" | "inlay_onlay" | "implant_crown";

export interface LabToothRoleMeta {
  role: LabToothRole;
  label: string;
  shortLabel: string;
  englishLabel: string;
  code: string;
  icon: string;
  color: string;
  bgClass: string;
  badgeClass: string;
  textClass: string;
  borderClass: string;
  fillHex: string;
  desc: string;
}

export const LAB_TOOTH_ROLE_META: Record<LabToothRole, LabToothRoleMeta> = {
  crown: {
    role: "crown",
    label: "تاج منفرد (Single Crown)",
    shortLabel: "تاج",
    englishLabel: "Crown",
    code: "CRW",
    icon: "👑",
    color: "blue",
    bgClass: "bg-blue-600 text-white",
    badgeClass: "bg-blue-50 text-blue-700 border-blue-200",
    textClass: "text-blue-700",
    borderClass: "border-blue-500",
    fillHex: "#2563eb",
    desc: "تاج يغطي سنًا محضرًا بالكامل بشكل منفرد",
  },
  abutment: {
    role: "abutment",
    label: "دعامة جسر (Bridge Abutment)",
    shortLabel: "دعامة جسر",
    englishLabel: "Abutment",
    code: "ABT",
    icon: "🏛️",
    color: "indigo",
    bgClass: "bg-indigo-600 text-white",
    badgeClass: "bg-indigo-50 text-indigo-700 border-indigo-200",
    textClass: "text-indigo-700",
    borderClass: "border-indigo-600",
    fillHex: "#4f46e5",
    desc: "سن طبيعي محضر أو غرسة يرتكز عليها طرف أو وسط الجسر",
  },
  pontic: {
    role: "pontic",
    label: "دمية جسر (Pontic)",
    shortLabel: "دمية جسر",
    englishLabel: "Pontic",
    code: "PNT",
    icon: "🌉",
    color: "teal",
    bgClass: "bg-teal-600 text-white",
    badgeClass: "bg-teal-50 text-teal-700 border-teal-200",
    textClass: "text-teal-700",
    borderClass: "border-teal-500",
    fillHex: "#0d9488",
    desc: "سن اصطناعي معلق يعوض سنًا مفقودًا بين دعامات الجسر",
  },
  veneer: {
    role: "veneer",
    label: "عدسة فينير (Veneer)",
    shortLabel: "فينير",
    englishLabel: "Veneer",
    code: "VNR",
    icon: "✨",
    color: "purple",
    bgClass: "bg-purple-600 text-white",
    badgeClass: "bg-purple-50 text-purple-700 border-purple-200",
    textClass: "text-purple-700",
    borderClass: "border-purple-500",
    fillHex: "#9333ea",
    desc: "قشرة خزفية رقيقة للسطح الدهليزي التجميلي",
  },
  inlay_onlay: {
    role: "inlay_onlay",
    label: "إنلاي / أونلاي (Inlay/Onlay)",
    shortLabel: "إنلاي/أونلاي",
    englishLabel: "Inlay/Onlay",
    code: "INL",
    icon: "🧩",
    color: "amber",
    bgClass: "bg-amber-600 text-white",
    badgeClass: "bg-amber-50 text-amber-700 border-amber-200",
    textClass: "text-amber-800",
    borderClass: "border-amber-500",
    fillHex: "#d97706",
    desc: "ترميم خزفي مصبوب جزئي للأسنان الخلفية",
  },
  implant_crown: {
    role: "implant_crown",
    label: "تاج فوق غرسة (Implant Crown)",
    shortLabel: "تاج غرسة",
    englishLabel: "Implant Crown",
    code: "IMP",
    icon: "🔩",
    color: "emerald",
    bgClass: "bg-emerald-600 text-white",
    badgeClass: "bg-emerald-50 text-emerald-700 border-emerald-200",
    textClass: "text-emerald-700",
    borderClass: "border-emerald-600",
    fillHex: "#059669",
    desc: "تركيبة فوق دعامة زرعة سنية (Screw or Cement Retained)",
  },
};

export type LabToothMap = Record<number, LabToothRole>;

export interface LabToothSummary {
  totalUnits: number;
  crownsCount: number;
  abutmentsCount: number;
  ponticsCount: number;
  veneersCount: number;
  otherCount: number;
  bridgeUnits: number;
  hasBridge: boolean;
  rawString: string;
  readableSummary: string;
  teethCodes: number[];
}

/**
 * تحويل خريطة الأسنان وأدوارها إلى نص معياري مفهوم للمختبر والعيادة
 * مثال: "14(Abutment), 15(Pontic), 16(Abutment), 21(Crown)"
 */
export function serializeLabTeeth(map: LabToothMap): string {
  const codes = Object.keys(map).map(Number).sort((a, b) => a - b);
  if (codes.length === 0) return "";

  return codes
    .map((code) => {
      const role = map[code];
      const roleMeta = LAB_TOOTH_ROLE_META[role];
      const roleName = roleMeta ? roleMeta.englishLabel : "Crown";
      return `${code}(${roleName})`;
    })
    .join(", ");
}

/**
 * فك وتحليل نص الأسنان السابق إلى خريطة تفاعلية (LabToothMap)
 * يدعم كلاً من التنسيقات القديمة والجديدة بمرونة عالية:
 * - "14(Abutment), 15(Pontic), 16(Abutment)"
 * - "14:abutment, 15:pontic"
 * - "14, 15, 16" (يُعين كـ Crown تلقائياً)
 * - "السن 16" أو "16-17"
 */
export function parseLabTeeth(raw: string | null | undefined, defaultRole: LabToothRole = "crown"): LabToothMap {
  if (!raw || typeof raw !== "string") return {};

  const map: LabToothMap = {};
  // إزالة أي زوائد ونصوص إضافية
  const clean = raw.replace(/[\[\]]/g, "").trim();
  if (!clean) return {};

  // تقسيم حسب الفواصل أو المسافات
  const items = clean.split(/[,،;|\n]+/).map((s) => s.trim()).filter(Boolean);

  for (const item of items) {
    // 1) Match format like "14(Abutment)" or "14 (دعامة)"
    const matchWithParen = item.match(/(\d{2})\s*\(([^)]+)\)/i);
    if (matchWithParen) {
      const code = parseInt(matchWithParen[1], 10);
      const roleText = matchWithParen[2].toLowerCase().trim();
      let role: LabToothRole = defaultRole;

      if (roleText.includes("abut") || roleText.includes("دعام")) role = "abutment";
      else if (roleText.includes("pont") || roleText.includes("دمي")) role = "pontic";
      else if (roleText.includes("ven") || roleText.includes("فين")) role = "veneer";
      else if (roleText.includes("inlay") || roleText.includes("onlay") || roleText.includes("انلاي") || roleText.includes("أونلاي")) role = "inlay_onlay";
      else if (roleText.includes("imp") || roleText.includes("زرع") || roleText.includes("غرس")) role = "implant_crown";
      else if (roleText.includes("crown") || roleText.includes("تاج")) role = "crown";

      if (!isNaN(code) && code >= 11 && code <= 85) {
        map[code] = role;
      }
      continue;
    }

    // 2) Match format like "14:abutment" or "14-abutment"
    const matchWithColon = item.match(/(\d{2})\s*[:=-]\s*([a-zA-Z_]+)/i);
    if (matchWithColon) {
      const code = parseInt(matchWithColon[1], 10);
      const roleKey = matchWithColon[2].toLowerCase().trim() as LabToothRole;
      if (LAB_TOOTH_ROLE_META[roleKey]) {
        map[code] = roleKey;
      } else {
        map[code] = defaultRole;
      }
      continue;
    }

    // 3) Match range format like "14-16" or "14 to 16"
    const matchRange = item.match(/(\d{2})\s*(?:-|إلى|to)\s*(\d{2})/);
    if (matchRange) {
      const start = parseInt(matchRange[1], 10);
      const end = parseInt(matchRange[2], 10);
      const min = Math.min(start, end);
      const max = Math.max(start, end);
      for (let c = min; c <= max; c++) {
        if (c >= 11 && c <= 85) {
          // If range, start and end are abutments, middle are pontics if 3+ teeth
          if (max - min >= 2) {
            if (c === min || c === max) map[c] = "abutment";
            else map[c] = "pontic";
          } else {
            map[c] = defaultRole;
          }
        }
      }
      continue;
    }

    // 4) Just extract numbers like "16" or "السن 21"
    const matchSingleNum = item.match(/(\d{2})/);
    if (matchSingleNum) {
      const code = parseInt(matchSingleNum[1], 10);
      if (!isNaN(code) && code >= 11 && code <= 85) {
        map[code] = defaultRole;
      }
    }
  }

  return map;
}

/**
 * تلخيص خريطة الأسنان المحددة وحساب عدد الوحدات والدعامات والدمى
 */
export function summarizeLabTeeth(map: LabToothMap): LabToothSummary {
  const codes = Object.keys(map).map(Number).sort((a, b) => a - b);
  let crownsCount = 0;
  let abutmentsCount = 0;
  let ponticsCount = 0;
  let veneersCount = 0;
  let otherCount = 0;

  for (const code of codes) {
    const role = map[code];
    if (role === "crown") crownsCount++;
    else if (role === "abutment") abutmentsCount++;
    else if (role === "pontic") ponticsCount++;
    else if (role === "veneer") veneersCount++;
    else otherCount++;
  }

  const bridgeUnits = abutmentsCount + ponticsCount;
  const hasBridge = bridgeUnits > 0;
  const totalUnits = codes.length;

  const parts: string[] = [];
  if (crownsCount > 0) parts.push(`${crownsCount} ${crownsCount === 1 ? "تاج" : "تيجان"}`);
  if (hasBridge) parts.push(`جسر (${abutmentsCount} دعامة + ${ponticsCount} دمية)`);
  if (veneersCount > 0) parts.push(`${veneersCount} فينير`);
  if (otherCount > 0) parts.push(`${otherCount} أخرى`);

  const readableSummary = totalUnits === 0
    ? "لم يتم تحديد أي أسنان"
    : `${totalUnits} ${totalUnits === 1 ? "وحدة" : "وحدات"} [${parts.join(" · ")}]`;

  return {
    totalUnits,
    crownsCount,
    abutmentsCount,
    ponticsCount,
    veneersCount,
    otherCount,
    bridgeUnits,
    hasBridge,
    rawString: serializeLabTeeth(map),
    readableSummary,
    teethCodes: codes,
  };
}

/** تصنيفات خدمات المختبر وبياناتها البصرية */
export const LAB_SERVICE_CATEGORY_META: Record<
  LabServiceCategory,
  { label: string; shortLabel: string; bg: string; text: string; border: string; desc: string }
> = {
  prostho: {
    label: "تركيبات سنية ثابتة ومتحركة (Prosthodontics)",
    shortLabel: "تركيبات سنية",
    bg: "bg-blue-50",
    text: "text-blue-700",
    border: "border-blue-200",
    desc: "تيجان زيركون، إيماكس، فينير، جسور، وأطقم متحركة",
  },
  implant: {
    label: "زراعة الأسنان وملحقاتها (Implantology)",
    shortLabel: "زراعة أسنان",
    bg: "bg-indigo-50",
    text: "text-indigo-700",
    border: "border-indigo-200",
    desc: "تيجان زراعة مخصصة، دعامات مخصصة، وجسور فوق الغرسات",
  },
  ortho: {
    label: "تقويم الأسنان والأجهزة (Orthodontics)",
    shortLabel: "تقويم أسنان",
    bg: "bg-purple-50",
    text: "text-purple-700",
    border: "border-purple-200",
    desc: "مثبتات تقويم هولي، قوالب شفافة، أجهزة توسيع، وحوافظ مسافة",
  },
  restorative: {
    label: "ترميمات وحشوات معملية (Restorative)",
    shortLabel: "ترميمات ومعمل",
    bg: "bg-teal-50",
    text: "text-teal-700",
    border: "border-teal-200",
    desc: "إنلاي، أونلاي سيراميك، وقلب ووتد مصبوب (Post & Core)",
  },
  appliance: {
    label: "أجهزة حماية وجبائر وظيفية (Appliances)",
    shortLabel: "أجهزة وجبائر",
    bg: "bg-amber-50",
    text: "text-amber-700",
    border: "border-amber-200",
    desc: "واقي ليلي، جبائر إطباقية، وحافظات للمفصل الصدغي الفكي",
  },
  other: {
    label: "تشخيص وقوالب دراسة (Diagnostic / Other)",
    shortLabel: "تشخيص وقوالب",
    bg: "bg-slate-50",
    text: "text-slate-700",
    border: "border-slate-200",
    desc: "صب قوالب تشخيص، شمع تجريبي تشخيصي، ونماذج دراسة",
  },
};

/** نطاق ارتباط الخدمة بمخطط وملف الأسنان */
export const LAB_TOOTH_SCOPE_META: Record<
  LabToothScope,
  { label: string; shortLabel: string; badgeBg: string; badgeText: string; icon: string; hint: string }
> = {
  single_tooth: {
    label: "سن مفرد (Single Tooth)",
    shortLabel: "سن مفرد",
    badgeBg: "bg-emerald-50 border-emerald-200 text-emerald-800",
    badgeText: "text-emerald-700",
    icon: "🦷",
    hint: "يرتبط برقم سن محدد على مخطط الأسنان (مثل تيجان Zirconia, E.max, Post & Core)",
  },
  multi_teeth_bridge: {
    label: "جسر / متعدد الأسنان (Multi-Teeth / Bridge)",
    shortLabel: "جسر متعدد",
    badgeBg: "bg-blue-50 border-blue-200 text-blue-800",
    badgeText: "text-blue-700",
    icon: "🔗",
    hint: "يرتبط بنطاق أسنان أو جسر ممتد (دعامات ودمى Abutment & Pontic)",
  },
  full_arch: {
    label: "فك كامل / قوس سني (Full Arch / Quadrant)",
    shortLabel: "فك كامل",
    badgeBg: "bg-amber-50 border-amber-200 text-amber-800",
    badgeText: "text-amber-700",
    icon: "👄",
    hint: "يرتبط بقوس سني كامل أو نصف فك (مثل أطقم الأسنان، مثبت التقويم، والواقي الليلي)",
  },
  general: {
    label: "عام / غير مقيد بسن (General / Non-tooth)",
    shortLabel: "عام",
    badgeBg: "bg-slate-50 border-slate-200 text-slate-800",
    badgeText: "text-slate-700",
    icon: "📋",
    hint: "أعمال غير مرتبطة بسن معين (مثل قوالب الدراسة ونماذج التشخيص)",
  },
};

/** أنواع العمل الأكثر تكرارًا — للتوافق والخيارات السريعة */
export const WORK_TYPES = [
  "تاج زيركون كامل (Full Zirconia)",
  "تاج إيماكس (E.max Crown)",
  "عدسة فينير (Veneer)",
  "تاج بورسلين ميتال (PFM)",
  "جسر زيركون (Zirconia Bridge)",
  "طقم أسنان كامل (Full Denture)",
  "طقم أسنان جزئي كاست (Cast Partial)",
  "حافظ مسافة (Space Maintainer)",
  "جهاز تقويم متحرك (Removable Appliance)",
  "واقي أسنان ليلي (Night Guard)",
  "تاج مؤقت (Temporary Crown)",
  "صب وتجهيز قالب دراسة (Study Model)",
  "أخرى (مخصص)",
];

/** خدمات المعمل الافتراضية للبذر الأولي */
export const DEFAULT_LAB_SERVICES: {
  name: string;
  code: string;
  category: LabServiceCategory;
  toothScope: LabToothScope;
  requiresShade: boolean;
  defaultDays: number;
  description: string;
  sortOrder: number;
}[] = [
  {
    name: "تاج زيركون كامل (Full Zirconia Crown)",
    code: "CRW_ZIRC",
    category: "prostho",
    toothScope: "single_tooth",
    requiresShade: true,
    defaultDays: 5,
    description: "تاج زيركون متجانس عالي الشفافية مع تلوين وتظليل VITA",
    sortOrder: 10,
  },
  {
    name: "تاج إيماكس تجميلي (E.max Crown)",
    code: "CRW_EMAX",
    category: "prostho",
    toothScope: "single_tooth",
    requiresShade: true,
    defaultDays: 5,
    description: "تاج خزفي ليثيوم دايسليكات عالي الجمالية للأسنان الأمامية",
    sortOrder: 20,
  },
  {
    name: "عدسة فينير إيماكس (E.max Veneer)",
    code: "VNR_EMAX",
    category: "prostho",
    toothScope: "single_tooth",
    requiresShade: true,
    defaultDays: 6,
    description: "قشرة خزفية تجميلية رقيقة بسماكة 0.3 - 0.5 ملم",
    sortOrder: 30,
  },
  {
    name: "تاج بورسلين فيوزد تو ميتال (PFM Crown)",
    code: "CRW_PFM",
    category: "prostho",
    toothScope: "single_tooth",
    requiresShade: true,
    defaultDays: 5,
    description: "تاج خزفي مدعم بمعدن غير نبيل مطبق بطبقات السيراميك",
    sortOrder: 40,
  },
  {
    name: "جسر زيركون متجانس (Zirconia Bridge / Unit)",
    code: "BRG_ZIRC",
    category: "prostho",
    toothScope: "multi_teeth_bridge",
    requiresShade: true,
    defaultDays: 6,
    description: "جسر زيركون متعدد الوحدات للتعويض عن الأسنان المفقودة",
    sortOrder: 50,
  },
  {
    name: "جسر بورسلين ميتال (PFM Bridge / Unit)",
    code: "BRG_PFM",
    category: "prostho",
    toothScope: "multi_teeth_bridge",
    requiresShade: true,
    defaultDays: 6,
    description: "جسر بورسلين مطبق على هيكل معدني مصبوب",
    sortOrder: 55,
  },
  {
    name: "حشوة إنلاي / أونلاي سيراميك (Ceramic Inlay / Onlay)",
    code: "RST_INLAY",
    category: "restorative",
    toothScope: "single_tooth",
    requiresShade: true,
    defaultDays: 4,
    description: "ترميم خزفي غير مباشر لتعويض الفقد الجزئي في التيجان الخلفية",
    sortOrder: 58,
  },
  {
    name: "قلب ووتد مصبوب (Custom Cast Post & Core)",
    code: "RST_POST",
    category: "restorative",
    toothScope: "single_tooth",
    requiresShade: false,
    defaultDays: 3,
    description: "وتد وقاعدة مصبوبة لدعم الأسنان المعالجة عصبيًا",
    sortOrder: 59,
  },
  {
    name: "تاج زراعة مخصص مع دعامة (Custom Implant Crown)",
    code: "CRW_IMP",
    category: "implant",
    toothScope: "single_tooth",
    requiresShade: true,
    defaultDays: 7,
    description: "تاج زراعة مع دعامة مخصصة (Custom Abutment) مخرطة بالكمبيوتر",
    sortOrder: 60,
  },
  {
    name: "جسر زراعة مدعوم بالغرسات (Implant Bridge)",
    code: "BRG_IMP",
    category: "implant",
    toothScope: "multi_teeth_bridge",
    requiresShade: true,
    defaultDays: 8,
    description: "جسر مدعم على غرسات سنية متعددة بنظام Screw-retained أو Cemented",
    sortOrder: 65,
  },
  {
    name: "طقم أسنان كامل أكريليك (Full Denture)",
    code: "DNT_FULL",
    category: "prostho",
    toothScope: "full_arch",
    requiresShade: true,
    defaultDays: 8,
    description: "طقم كامل علوي أو سفلي أكريليك مع أسنان مسبقة الصنع عالية الجودة",
    sortOrder: 70,
  },
  {
    name: "طقم أسنان جزئي كاست معدني (Cast Partial Denture)",
    code: "DNT_CAST",
    category: "prostho",
    toothScope: "full_arch",
    requiresShade: true,
    defaultDays: 9,
    description: "طقم جزئي بهيكل كروم كوبالت مصبوب مع ضامات دقيقة",
    sortOrder: 80,
  },
  {
    name: "جهاز مثبت تقويم هولي (Hawley Retainer)",
    code: "RET_HAW",
    category: "ortho",
    toothScope: "full_arch",
    requiresShade: false,
    defaultDays: 4,
    description: "مثبت تقويم سلكي مع صفيحة أكريليك ملونة أو شفافة",
    sortOrder: 90,
  },
  {
    name: "قالب تقويم شفاف متحرك (Clear Retainer / Essix)",
    code: "RET_CLR",
    category: "ortho",
    toothScope: "full_arch",
    requiresShade: false,
    defaultDays: 3,
    description: "قالب تثبيت تقويمي شفاف مفرغ حراريًا عالي الدقة",
    sortOrder: 100,
  },
  {
    name: "واقي ليلي صلب / مرن (Night Guard / Occlusal Splint)",
    code: "GRD_NGT",
    category: "appliance",
    toothScope: "full_arch",
    requiresShade: false,
    defaultDays: 4,
    description: "جبيرة إطباقية مفرغة لعلاج صرير الأسنان وحماية التيجان والمفصل",
    sortOrder: 110,
  },
  {
    name: "حافظ مسافة أحادي / ثنائي (Space Maintainer)",
    code: "SPC_MNT",
    category: "ortho",
    toothScope: "single_tooth",
    requiresShade: false,
    defaultDays: 4,
    description: "حافظ مسافة سلكي مع حلقة سنية للأطفال (Band & Loop)",
    sortOrder: 120,
  },
  {
    name: "جهاز توسيع الفك التقويمي (Hyrax / RPE Expander)",
    code: "EXP_HYR",
    category: "ortho",
    toothScope: "full_arch",
    requiresShade: false,
    defaultDays: 5,
    description: "جهاز توسيع الفك العلوي مع برغي توسيع مركزي وحلقات تثبيت",
    sortOrder: 125,
  },
  {
    name: "تاج مؤقت أكريليك / PMMA (Temp Crown)",
    code: "CRW_TMP",
    category: "prostho",
    toothScope: "single_tooth",
    requiresShade: true,
    defaultDays: 2,
    description: "تاج مؤقت مخرط بدقة لحماية السن واللثة أثناء فترة التصنيع",
    sortOrder: 130,
  },
  {
    name: "صب وتجهيز قالب دراسة وتشخيص (Study Model)",
    code: "MOD_STD",
    category: "other",
    toothScope: "general",
    requiresShade: false,
    defaultDays: 2,
    description: "صب جبس صلب وتشذيب القالب للتشخيص والتخطيط السريري",
    sortOrder: 140,
  },
];

/** المهلة الافتراضية حتى يُنجز المختبر */
export const DEFAULT_LAB_DAYS = 7;

export function defaultDueDate(sentDate: string, days = DEFAULT_LAB_DAYS): string {
  return addDays(sentDate, days);
}

/** العمل الذي ما زال في ذمّة المختبر. المستلَم والمركَّب والملغى خرجوا من الانتظار */
export function isOutstanding(order: LabOrder | LabOrderClinicalDTO): boolean {
  return order.status === "sent" || order.status === "in_progress" || order.status === "remake";
}

/**
 * كم يومًا تأخّر العمل عن موعده.
 * صفر يعني في موعده أو لم يحن بعد — لا رقمًا سالبًا.
 */
export function daysLate(order: LabOrder | LabOrderClinicalDTO, today: string): number {
  if (!isOutstanding(order)) return 0;
  const due = Date.parse(`${order.dueDate}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(now)) return 0;
  return Math.max(0, Math.round((now - due) / 86_400_000));
}

export function isOverdue(order: LabOrder | LabOrderClinicalDTO, today: string): boolean {
  return daysLate(order, today) > 0;
}

export function isDueToday(order: LabOrder | LabOrderClinicalDTO, today: string): boolean {
  return isOutstanding(order) && order.dueDate === today;
}

export type LabFilter = "late" | "pending" | "outstanding" | "received" | "remake" | "delivered" | "all";

export const LAB_FILTER_LABEL: Record<LabFilter, string> = {
  late: "متأخرة",
  pending: "لم تُرسل بعد",
  outstanding: "عند المختبر",
  received: "وصلت العيادة (جاهزة)",
  remake: "إعادات (Remakes)",
  delivered: "المكتملة والمسلّمة",
  all: "الكل",
};

export function filterOrders<T extends LabOrder | LabOrderClinicalDTO>(
  orders: T[],
  filter: LabFilter,
  today: string,
): T[] {
  switch (filter) {
    case "late":
      return orders.filter((order) => isOverdue(order, today));
    /* pending (V2 §١٩): أعمال ولّدها توقيع الزيارة ولم تُرسل للمختبر بعد. */
    case "pending":
      return orders.filter((order) => order.status === "needed");
    case "outstanding":
      return orders.filter(isOutstanding);
    case "received":
      return orders.filter((order) => order.status === "received");
    case "remake":
      return orders.filter((order) => order.status === "remake");
    case "delivered":
      return orders.filter((order) => order.status === "delivered");
    default:
      return orders;
  }
}

/** الترتيب الذي يجعل القائمة صالحة للعمل: الأكثر تأخّرًا أولًا */
export function sortByUrgency<T extends LabOrder | LabOrderClinicalDTO>(orders: T[], today: string): T[] {
  return [...orders].sort((a, b) => {
    const late = daysLate(b, today) - daysLate(a, today);
    if (late !== 0) return late;
    return a.dueDate.localeCompare(b.dueDate);
  });
}

export interface LabSummary {
  outstanding: number;
  late: number;
  dueToday: number;
  waitingFitting: number;
  remakes?: number;
  deliveredTotal?: number;
}

export function labSummary(orders: (LabOrder | LabOrderClinicalDTO)[], today: string): LabSummary {
  return {
    outstanding: orders.filter(isOutstanding).length,
    late: orders.filter((order) => isOverdue(order, today)).length,
    dueToday: orders.filter((order) => isDueToday(order, today)).length,
    waitingFitting: orders.filter((order) => order.status === "received").length,
  };
}

export function labSummaryV2(orders: (LabOrder | LabOrderClinicalDTO)[], today: string): Required<LabSummary> {
  return {
    outstanding: orders.filter(isOutstanding).length,
    late: orders.filter((order) => isOverdue(order, today)).length,
    dueToday: orders.filter((order) => isDueToday(order, today)).length,
    waitingFitting: orders.filter((order) => order.status === "received").length,
    remakes: orders.filter((order) => order.status === "remake").length,
    deliveredTotal: orders.filter((order) => order.status === "delivered").length,
  };
}

/**
 * رسالة المتابعة والاستعجال للمختبر عبر واتساب — تركيز سريري وتاريخ استحقاق بلا أي معلومات مالية.
 */
export function labFollowUpText(order: LabOrderClinicalDTO | LabOrder, today: string, clinicName: string): string {
  const late = daysLate(order, today);
  const toothInfo = order.toothNumbers ? ` [الأسنان: ${order.toothNumbers}]` : "";
  const shadeInfo = order.shade ? ` [اللون: ${order.shade}]` : "";
  const lines = [
    `السلام عليكم،`,
    ``,
    `متابعة عمل من ${clinicName}:`,
    `المريض: ${order.patientName}`,
    `العمل: ${order.workType}${order.details ? ` — ${order.details}` : ""}${toothInfo}${shadeInfo}`,
    `أُرسل: ${order.sentDate} · الموعد المتفق: ${order.dueDate}`,
  ];

  if (order.priority === "urgent" || order.priority === "rush") {
    lines.push(`درجة الأهمية: ${LAB_PRIORITY_LABEL[order.priority].label}`);
  }

  lines.push(
    late > 0
      ? `مضى على الموعد ${late} ${late === 1 ? "يوم" : "أيام"}. نرجو إفادتنا بموعد التسليم — المريض بانتظاره.`
      : `نرجو تأكيد الجاهزية في موعدها.`,
  );
  return lines.join("\n");
}

/** إبلاغ المريض أن عمله وصل إلى العيادة وجاهز للتركيب */
export function patientReadyText(
  order: LabOrderClinicalDTO | LabOrder,
  clinicName: string,
  clinicPhone: string,
): string {
  return [
    `السلام عليكم ${order.patientName}،`,
    ``,
    `يسرنا إبلاغكم بأن ${order.workType} الخاص بكم قد وصل إلى ${clinicName} وجاهز للتركيب.`,
    `تفضّلوا بالتواصل معنا لحجز وتأكيد الموعد المناسب لكم.`,
    ``,
    `للتواصل والحجز: ${clinicPhone}`,
  ].join("\n");
}

/**
 * إنشاء نص طلب العمل المخبري السريري (Lab Prescription Sheet) الموجه للمعمل.
 * خالٍ تماماً وبشكل صارم من أي مبالغ أو أسعار أو تكاليف.
 */
export function formatLabPrescriptionText(
  order: LabOrderClinicalDTO | LabOrder,
  clinicName: string,
  clinicPhone?: string,
): string {
  const parts = [
    `══════════════════════════════════════`,
    `      طلب عمل مخبري سني (LAB PRESCRIPTION)      `,
    `          ${clinicName}          `,
    `══════════════════════════════════════`,
    `رقم الطلب: #${order.id}`,
    `التاريخ: ${order.sentDate}`,
    `موعد التسليم المطلوب: ${order.dueDate}`,
    `درجة الاستعجال: ${LAB_PRIORITY_LABEL[order.priority || "normal"].label}`,
    `──────────────────────────────────────`,
    `بيانات المريض:`,
    `• الاسم: ${order.patientName}`,
    `• رقم الملف: ${order.patientNumber || "—"}`,
    `• الطبيب المعالج: ${order.doctorName || "عيادة المركز"}`,
    `• المختبر: ${order.labName}`,
    `──────────────────────────────────────`,
    `المواصفات السريرية والسنية:`,
    `• نوع التركيبة / العمل: ${order.workType}`,
    `• رقم السن / الأسنان: ${order.toothNumbers || "—"}`,
    `• لون السن (Shade): ${order.shade || "—"}`,
    `• لون الجذع المحضر (Stump Shade): ${order.stumpShade || "—"}`,
    `• نوع الطبعة: ${LAB_IMPRESSION_LABEL[order.impressionType || "physical"]}`,
    order.details ? `• التفاصيل والتعليمات: ${order.details}` : "",
    order.note ? `• ملاحظات إضافية للفني: ${order.note}` : "",
    `──────────────────────────────────────`,
    `ملاحظة: هذا المستند سريري وتقني ولا يحتوي على أي بيانات مالية.`,
    clinicPhone ? `هاتف العيادة: ${clinicPhone}` : "",
    `══════════════════════════════════════`,
  ];
  return parts.filter(Boolean).join("\n");
}

