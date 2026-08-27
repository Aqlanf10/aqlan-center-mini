import {
  ActivityIcon,
  BarChart3Icon,
  CalendarDaysIcon,
  LayoutDashboardIcon,
  PhoneCallIcon,
  ScrollTextIcon,
  SettingsIcon,
  UserCogIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

import type { UserRole } from "@/db/schema/enums";

export type NavItem = {
  href: string;
  /** Key inside dict.nav */
  labelKey:
    | "dashboard"
    | "today"
    | "patients"
    | "appointments"
    | "followUp"
    | "staff"
    | "reports"
    | "auditLog"
    | "clinicSettings";
  icon: LucideIcon;
  /** When set, the item is only rendered for these roles. */
  roles?: readonly UserRole[];
};

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboardIcon },
  { href: "/today", labelKey: "today", icon: ActivityIcon },
  { href: "/patients", labelKey: "patients", icon: UsersIcon },
  { href: "/appointments", labelKey: "appointments", icon: CalendarDaysIcon },
  { href: "/follow-up", labelKey: "followUp", icon: PhoneCallIcon },
  {
    href: "/reports",
    labelKey: "reports",
    icon: BarChart3Icon,
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
