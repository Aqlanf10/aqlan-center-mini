/**
 * روابط القسم المالي — قائمة واحدة.
 *
 * كانت كل شاشة مالية تكتب صفّ روابطها بيدها، فاختلفت القوائم: شاشة تعرض خمسة روابط
 * وأخرى رابطين، وشاشتان جديدتان (الأرصدة الافتتاحية وإعادة التقييم) لم تظهرا إلا في
 * موضع واحد. ومن لا يجد الشاشة يظنّها غير موجودة.
 */
export interface FinanceLink { href: string; label: string; current?: boolean }

const SECTION: { href: string; label: string }[] = [
  { href: "/finance", label: "الصندوق" },
  { href: "/finance/reports", label: "التقارير" },
  { href: "/finance/debts", label: "المديونية" },
  { href: "/finance/plans", label: "الأقساط" },
  { href: "/finance/parties", label: "الجهات" },
  { href: "/finance/services", label: "الأسعار" },
  { href: "/finance/accounting", label: "الدفاتر" },
  { href: "/finance/opening", label: "الأرصدة الافتتاحية" },
  { href: "/finance/fx", label: "إعادة التقييم" },
];

export function financeLinks(current: string): FinanceLink[] {
  return SECTION.map((link) => ({ ...link, current: link.href === current }));
}
