import {
  ActivityIcon,
  CalendarDaysIcon,
  LayoutDashboardIcon,
  PhoneCallIcon,
  UserCogIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

import type { UserRole } from "@/db/schema/enums";

export type NavItem = {
  href: string;
  /** Key inside dict.nav */
  labelKey: "dashboard" | "today" | "patients" | "appointments" | "followUp" | "staff";
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
    href: "/settings/staff",
    labelKey: "staff",
    icon: UserCogIcon,
    roles: ["ADMIN"],
  },
];
