import { canViewMoney } from "@/lib/roles";

/** The clinic-wide Z report is not a patient receipt; Reception never prints clinic Z-reports. */
export function canPrintShiftReport(role: string | null | undefined): boolean {
  return role !== "reception" && canViewMoney(role);
}
