import {
  ActivityIcon,
  CalendarDaysIcon,
  LayoutDashboardIcon,
  PhoneCallIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  /** Key inside dict.nav */
  labelKey: "dashboard" | "today" | "patients" | "appointments" | "followUp";
  icon: LucideIcon;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboardIcon },
  { href: "/today", labelKey: "today", icon: ActivityIcon },
  { href: "/patients", labelKey: "patients", icon: UsersIcon },
  { href: "/appointments", labelKey: "appointments", icon: CalendarDaysIcon },
  { href: "/follow-up", labelKey: "followUp", icon: PhoneCallIcon },
];
