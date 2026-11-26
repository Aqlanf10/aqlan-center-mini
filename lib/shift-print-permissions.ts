import { canViewMoney } from "@/lib/roles";

/** The clinic-wide Z report is not a patient receipt. */
export function canPrintShiftReport(role: string | null | undefined): boolean {
  return role !== "reception" && canViewMoney(role);
}
