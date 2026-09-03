/**
 * منظومة الإدارة المالية الطبية — الهيكل العلمي الموحد.
 *
 * تنقسم المنظومة المالية في مراكز طب الأسنان عالمياً (وفق معايير ADA و RCM) إلى أربع ركائز رئيسية
 * مترابطة عضوياً مع وحدة المرضى:
 * 1. العمليات النقدية والورديات (Cash Drawer & Day-End Balancing)
 * 2. حسابات وإيرادات المرضى ودورة الإيرادات (Patient Accounts & Revenue Cycle - AR)
 * 3. التكاليف التشغيلية والمختبرات والمصروفات (Accounts Payable & Cost Control - AP)
 * 4. المحاسبة العامة والرقابة والتقارير (General Ledger & Practice Intelligence - GL)
 */

export interface FinanceLink {
  href: string;
  label: string;
  current?: boolean;
  group?: string;
  pillarId?: "cash" | "ar" | "ap" | "gl";
}

export interface FinancePillar {
  id: "cash" | "ar" | "ap" | "gl";
  name: string;
  englishTitle: string;
  description: string;
  badge: string;
  links: { href: string; label: string; description: string }[];
}

export const FINANCE_PILLARS: FinancePillar[] = [
  {
    id: "cash",
    name: "العمليات النقدية والورديات",
    englishTitle: "Cash Drawer & Day-End",
    description: "إدارة حركة الصندوق والسيولة اليومية وإقفال المطابقة الصندوقية",
    badge: "نقدية وسيارات",
    links: [
      { href: "/finance", label: "المركز المالي والصندوق", description: "لوحة القيادة المالية والوردية المفتوحة والقبض الفوري" },
      { href: "/finance/reconciliation", label: "إقفال اليومية والتسوية", description: "مطابقة رصيد النظام مع النقد الفعلي والإيداع" },
    ],
  },
  {
    id: "ar",
    name: "حسابات وإيرادات المرضى",
    englishTitle: "Patient Billing & AR",
    description: "دورة إيرادات المرضى، المديونيات، خطط التقسيط، وتسعير الخدمات الطبية",
    badge: "إيرادات وذمم",
    links: [
      { href: "/finance/debts", label: "أعمار الديون والمطالبات", description: "أرصدة المرضى والتحصيل بحسب فترات الاستحقاق (Aging)" },
      { href: "/finance/plans", label: "خطط الأقساط العلاجية", description: "متابعة دفعات التقويم والزراعة المجدولة" },
      { href: "/finance/services", label: "تسعيرة الخدمات الطبية", description: "التعريفات الطبية وتكاليف الإجراءات والتأمينات" },
    ],
  },
  {
    id: "ap",
    name: "التكاليف والمختبرات والمصروفات",
    englishTitle: "Accounts Payable & Costs",
    description: "الذمم الدائنة، فواتير معامل الأسنان، ميزانيات المصروفات، وعمولات الأطباء",
    badge: "تكاليف وموردون",
    links: [
      { href: "/finance/lab-accounting", label: "حسابات مختبرات الأسنان", description: "مطابقة فواتير التركيبات والزراعة وسداد المعامل" },
      { href: "/finance/commissions", label: "مستحقات وعمولات الأطباء", description: "احتساب نسب الأطباء من الإنتاج والتحصيل الفعلي" },
      { href: "/finance/expense-categories", label: "بنود وميزانيات المصروفات", description: "رقابة الموازنات التقديرية التشغيلية ونسب الانحراف" },
      { href: "/finance/parties", label: "الجهات والموردون", description: "إدارة الموردين والشركاء وسجلات التعامل" },
    ],
  },
  {
    id: "gl",
    name: "المحاسبة العامة والتقارير",
    englishTitle: "General Ledger & Control",
    description: "شجرة الحسابات، القيود المزدوجة، إعادة تقييم العملات، والرقابة الختامية",
    badge: "دفاتر وقوائم",
    links: [
      { href: "/finance/accounting", label: "الدفاتر والقيود المحاسبية", description: "ميزان المراجعة، الأستاذ العام، وقائمة الدخل والأرباح" },
      { href: "/finance/opening", label: "الأرصدة الافتتاحية", description: "أرصدة بداية الفترة للصناديق والجهات والمصارف" },
      { href: "/finance/fx", label: "إعادة تقييم العملات", description: "معالجة فروق أسعار الصرف للعملات الأجنبية" },
      { href: "/finance/reports", label: "التقارير المالية التحليلية", description: "صافي دخل المركز، التدفقات النقدية، والمؤشرات" },
    ],
  },
];

const ORDERED_LINKS: { href: string; label: string; group: string; pillarId: "cash" | "ar" | "ap" | "gl" }[] = [
  // ١. العمليات النقدية والورديات
  { href: "/finance", label: "المركز المالي والصندوق", group: "العمليات النقدية", pillarId: "cash" },
  { href: "/finance/reconciliation", label: "إقفال اليومية", group: "العمليات النقدية", pillarId: "cash" },

  // ٢. حسابات وإيرادات المرضى
  { href: "/finance/debts", label: "أعمار الديون", group: "إيرادات المرضى", pillarId: "ar" },
  { href: "/finance/plans", label: "أقساط العلاج", group: "إيرادات المرضى", pillarId: "ar" },
  { href: "/finance/services", label: "تسعير الخدمات", group: "إيرادات المرضى", pillarId: "ar" },

  // ٣. التكاليف والمختبرات والمصروفات
  { href: "/finance/lab-accounting", label: "حسابات المختبرات", group: "التكاليف والمصروفات", pillarId: "ap" },
  { href: "/finance/commissions", label: "عمولات الأطباء", group: "التكاليف والمصروفات", pillarId: "ap" },
  { href: "/finance/expense-categories", label: "المصروفات والميزانيات", group: "التكاليف والمصروفات", pillarId: "ap" },
  { href: "/finance/parties", label: "الجهات والموردون", group: "التكاليف والمصروفات", pillarId: "ap" },

  // ٤. المحاسبة والرقابة والتقارير
  { href: "/finance/accounting", label: "الدفاتر المحاسبية", group: "المحاسبة والتقارير", pillarId: "gl" },
  { href: "/finance/opening", label: "الأرصدة الافتتاحية", group: "المحاسبة والتقارير", pillarId: "gl" },
  { href: "/finance/fx", label: "إعادة التقييم", group: "المحاسبة والتقارير", pillarId: "gl" },
  { href: "/finance/reports", label: "التقارير المالية", group: "المحاسبة والتقارير", pillarId: "gl" },
];

export function financeLinks(current: string): FinanceLink[] {
  return ORDERED_LINKS.map((link) => ({
    ...link,
    current: link.href === current,
  }));
}
