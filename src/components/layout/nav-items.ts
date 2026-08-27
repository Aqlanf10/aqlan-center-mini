import {
  ActivityIcon,
  BarChart3Icon,
  BanknoteIcon,
  BookOpenCheckIcon,
  CalendarDaysIcon,
  ClipboardListIcon,
  FlaskConicalIcon,
  HandCoinsIcon,
  LandmarkIcon,
  LayoutDashboardIcon,
  PackageIcon,
  PhoneCallIcon,
  ReceiptTextIcon,
  ScrollTextIcon,
  SettingsIcon,
  StethoscopeIcon,
  TagsIcon,
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
  /** Task-oriented module shown as a stable navigation group. */
  section?: NavSection;
};

export type NavSection =
  | "dailyOperations"
  | "clinical"
  | "finance"
  | "partners"
  | "administration";

export type NavSectionLabelKey =
  | "sectionDailyOperations"
  | "sectionClinical"
  | "sectionFinance"
  | "sectionPartners"
  | "sectionAdministration";

export const NAV_SECTIONS: Record<
  NavSection,
  { labelKey: NavSectionLabelKey }
> = {
  dailyOperations: { labelKey: "sectionDailyOperations" },
  clinical: { labelKey: "sectionClinical" },
  finance: { labelKey: "sectionFinance" },
  partners: { labelKey: "sectionPartners" },
  administration: { labelKey: "sectionAdministration" },
};

const NAV_SECTION_ORDER: readonly NavSection[] = [
  "dailyOperations",
  "clinical",
  "finance",
  "partners",
  "administration",
];

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboardIcon },
  {
    href: "/today",
    labelKey: "today",
    icon: ActivityIcon,
    section: "dailyOperations",
  },
  {
    href: "/appointments",
    labelKey: "appointments",
    icon: CalendarDaysIcon,
    section: "dailyOperations",
  },
  {
    href: "/follow-up",
    labelKey: "followUp",
    icon: PhoneCallIcon,
    section: "dailyOperations",
  },
  {
    href: "/reports",
    labelKey: "reports",
    icon: BarChart3Icon,
    roles: ["ADMIN"],
    section: "dailyOperations",
  },
  {
    href: "/patients",
    labelKey: "patients",
    icon: UsersIcon,
    section: "clinical",
  },
  {
    href: "/my-work",
    labelKey: "myWork",
    icon: StethoscopeIcon,
    roles: ["ADMIN", "DOCTOR"],
    section: "clinical",
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
    icon: ReceiptTextIcon,
    roles: ["ADMIN", "RECEPTION"],
    section: "finance",
  },
  {
    href: "/finance/vouchers",
    labelKey: "vouchers",
    icon: HandCoinsIcon,
    roles: ["ADMIN"],
    section: "finance",
  },
  {
    href: "/finance/commissions",
    labelKey: "commissions",
    icon: ClipboardListIcon,
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
    section: "partners",
  },
  {
    href: "/suppliers",
    labelKey: "suppliers",
    icon: PackageIcon,
    roles: ["ADMIN"],
    section: "partners",
  },
  // ---- Administration and reference data ----
  {
    href: "/settings/services",
    labelKey: "services",
    icon: BookOpenCheckIcon,
    roles: ["ADMIN"],
    section: "administration",
  },
  {
    href: "/finance/cash-accounts",
    labelKey: "cashAccounts",
    icon: LandmarkIcon,
    roles: ["ADMIN"],
    section: "administration",
  },
  {
    href: "/finance/expense-categories",
    labelKey: "expenseCategories",
    icon: TagsIcon,
    roles: ["ADMIN"],
    section: "administration",
  },
  {
    href: "/settings/audit-log",
    labelKey: "auditLog",
    icon: ScrollTextIcon,
    roles: ["ADMIN"],
    section: "administration",
  },
  {
    href: "/settings/clinic",
    labelKey: "clinicSettings",
    icon: SettingsIcon,
    roles: ["ADMIN"],
    section: "administration",
  },
  {
    href: "/settings/staff",
    labelKey: "staff",
    icon: UserCogIcon,
    roles: ["ADMIN"],
    section: "administration",
  },
];

/**
 * Group visible items into a stable business order. A role may see only one
 * item in a module, but its location never jumps to another module.
 */
export function groupNavItems(
  items: readonly NavItem[]
): { section: NavSection | null; items: readonly NavItem[] }[] {
  const plain = items.filter((item) => !item.section);
  return [
    { section: null, items: plain },
    ...NAV_SECTION_ORDER.map((section) => ({
      section,
      items: items.filter((item) => item.section === section),
    })),
  ].filter((group) => group.items.length > 0);
}

/** Apply the same role filter on desktop and mobile navigation. */
export function visibleNavItems(
  role: UserRole,
  items: readonly NavItem[] = NAV_ITEMS
): readonly NavItem[] {
  return items.filter((item) => !item.roles || item.roles.includes(role));
}

/**
 * Match the most-specific visible route. This prevents both `/finance` and
 * `/finance/receipts` from being highlighted on the receipt screen while
 * still keeping `/patients` active on a patient detail page.
 */
export function isNavItemActive(
  pathname: string,
  href: string,
  items: readonly NavItem[]
): boolean {
  const matches = items
    .map((item) => item.href)
    .filter(
      (candidate) =>
        pathname === candidate || pathname.startsWith(`${candidate}/`)
    )
    .sort((a, b) => b.length - a.length);

  return matches[0] === href;
}

/** Resolve a nav label from the dictionaries (nav + navFinance sections). */
export function navLabel(
  dict: { nav: Record<string, string>; navFinance: Record<string, string> },
  labelKey: NavLabelKey
): string {
  return dict.nav[labelKey] ?? dict.navFinance[labelKey] ?? labelKey;
}
