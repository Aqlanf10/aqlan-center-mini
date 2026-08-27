import {
  ActivityIcon,
  BarChart3Icon,
  BanknoteIcon,
  CalendarDaysIcon,
  FlaskConicalIcon,
  LayoutDashboardIcon,
  PackageIcon,
  PhoneCallIcon,
  ScrollTextIcon,
  SettingsIcon,
  StethoscopeIcon,
  UserCogIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

import type { UserRole } from "@/db/schema/enums";

export type NavLabelKey =
  | "dashboard"
  | "today"
  | "patients"
  | "appointments"
  | "followUp"
  | "staff"
  | "reports"
  | "auditLog"
  | "clinicSettings"
  | "services"
  | "finance"
  | "financeOverview"
  | "receipts"
  | "vouchers"
  | "financeReports"
  | "commissions"
  | "cashAccounts"
  | "expenseCategories"
  | "labs"
  | "suppliers"
  | "myWork";

export type NavItem = {
  href: string;
  /** Key inside dict.nav / dict.navFinance */
  labelKey: NavLabelKey;
  icon: LucideIcon;
  /** When set, the item is only rendered for these roles. */
  roles?: readonly UserRole[];
  /** Section id — consecutive items with the same id share a header. */
  section?: "finance";
};

export const NAV_SECTIONS: Record<"finance", { labelKey: "finance" }> = {
  finance: { labelKey: "finance" },
};

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboardIcon },
  { href: "/today", labelKey: "today", icon: ActivityIcon },
  { href: "/patients", labelKey: "patients", icon: UsersIcon },
  { href: "/appointments", labelKey: "appointments", icon: CalendarDaysIcon },
  { href: "/follow-up", labelKey: "followUp", icon: PhoneCallIcon },
  {
    href: "/my-work",
    labelKey: "myWork",
    icon: StethoscopeIcon,
    roles: ["ADMIN", "DOCTOR"],
  },
  {
    href: "/reports",
    labelKey: "reports",
    icon: BarChart3Icon,
    roles: ["ADMIN"],
  },
  // ---- Finance section (ADMIN; receipts also for RECEPTION) ----
  {
    href: "/finance",
    labelKey: "financeOverview",
    icon: BanknoteIcon,
    roles: ["ADMIN"],
    section: "finance",
  },
  {
    href: "/finance/receipts",
    labelKey: "receipts",
    icon: BanknoteIcon,
    roles: ["ADMIN", "RECEPTION"],
    section: "finance",
  },
  {
    href: "/finance/vouchers",
    labelKey: "vouchers",
    icon: BanknoteIcon,
    roles: ["ADMIN"],
    section: "finance",
  },
  {
    href: "/finance/cash-accounts",
    labelKey: "cashAccounts",
    icon: BanknoteIcon,
    roles: ["ADMIN"],
    section: "finance",
  },
  {
    href: "/finance/expense-categories",
    labelKey: "expenseCategories",
    icon: BanknoteIcon,
    roles: ["ADMIN"],
    section: "finance",
  },
  {
    href: "/finance/commissions",
    labelKey: "commissions",
    icon: BanknoteIcon,
    roles: ["ADMIN"],
    section: "finance",
  },
  {
    href: "/finance/reports",
    labelKey: "financeReports",
    icon: BarChart3Icon,
    roles: ["ADMIN"],
    section: "finance",
  },
  // ---- Parties ----
  {
    href: "/labs",
    labelKey: "labs",
    icon: FlaskConicalIcon,
    roles: ["ADMIN"],
  },
  {
    href: "/suppliers",
    labelKey: "suppliers",
    icon: PackageIcon,
    roles: ["ADMIN"],
  },
  // ---- Settings ----
  {
    href: "/settings/services",
    labelKey: "services",
    icon: SettingsIcon,
    roles: ["ADMIN"],
  },
  {
    href: "/settings/audit-log",
    labelKey: "auditLog",
    icon: ScrollTextIcon,
    roles: ["ADMIN"],
  },
  {
    href: "/settings/clinic",
    labelKey: "clinicSettings",
    icon: SettingsIcon,
    roles: ["ADMIN"],
  },
  {
    href: "/settings/staff",
    labelKey: "staff",
    icon: UserCogIcon,
    roles: ["ADMIN"],
  },
];

/**
 * Group visible items into sections. Items without a section render first
 * (section = null); finance items render under their header.
 */
export function groupNavItems(
  items: readonly NavItem[]
): { section: "finance" | null; items: readonly NavItem[] }[] {
  const plain = items.filter((item) => !item.section);
  const finance = items.filter((item) => item.section === "finance");
  const groups: { section: "finance" | null; items: readonly NavItem[] }[] = [
    { section: null, items: plain },
  ];
  if (finance.length > 0) {
    groups.push({ section: "finance", items: finance });
  }
  return groups.filter((group) => group.items.length > 0);
}

/** Resolve a nav label from the dictionaries (nav + navFinance sections). */
export function navLabel(
  dict: { nav: Record<string, string>; navFinance: Record<string, string> },
  labelKey: NavLabelKey
): string {
  return dict.nav[labelKey] ?? dict.navFinance[labelKey] ?? labelKey;
}
