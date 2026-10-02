import type { FinanceSummary } from "@/lib/db";
import {
  canDoctorViewClinicProfits,
  canDoctorViewClinicRevenue,
  canDoctorViewExpenses,
  type DoctorPermissions,
} from "@/lib/doctor-permissions";
import { financeAccessFor, type FinanceAccess } from "@/lib/finance-permissions";

/** The report always needs clinic revenue access. Other sections are independent. */
export interface FinanceReportAccess {
  revenue: boolean;
  expenses: boolean;
  profit: boolean;
}

export function financeReportAccess(
  role: string,
  permissions?: DoctorPermissions | null,
  financeAccess?: Partial<FinanceAccess>,
): FinanceReportAccess {
  if (role === "admin" || (role === "accountant" && financeAccessFor(role, financeAccess).viewReports)) {
    return { revenue: true, expenses: true, profit: true };
  }
  if (role !== "doctor") return { revenue: false, expenses: false, profit: false };

  const revenue = canDoctorViewClinicRevenue(permissions, role);
  const expenses = canDoctorViewExpenses(permissions, role);
  // Net exposes hidden outgoings by subtraction. A profit flag alone must not
  // defeat the separately denied expense section (or the report's revenue gate).
  const profit = revenue && expenses && canDoctorViewClinicProfits(permissions, role);
  return { revenue, expenses, profit };
}

export type VisibleFinanceSummary = Pick<FinanceSummary,
  "from" | "to" | "income" | "refunds" | "invoicedByCurrency" | "invoiceCount" | "patientCount" | "topServices"
> & Partial<Pick<FinanceSummary, "expenses" | "openingSettlements" | "netMinor">>;

/** Explicit allowlist: denied data is absent, never represented as a false zero. */
export function projectFinanceSummary(
  summary: FinanceSummary,
  access: FinanceReportAccess,
): VisibleFinanceSummary | null {
  if (!access.revenue) return null;
  return {
    from: summary.from,
    to: summary.to,
    income: {
      byCurrency: { ...summary.income.byCurrency },
      baseTotalMinor: summary.income.baseTotalMinor,
      count: summary.income.count,
    },
    refunds: { baseTotalMinor: summary.refunds.baseTotalMinor, count: summary.refunds.count },
    invoicedByCurrency: { ...summary.invoicedByCurrency },
    invoiceCount: summary.invoiceCount,
    patientCount: summary.patientCount,
    topServices: summary.topServices.map(({ name, count, totalMinor, currency }) => ({ name, count, totalMinor, currency })),
    ...(access.expenses ? {
      expenses: {
        byCategory: { ...summary.expenses.byCategory },
        baseTotalMinor: summary.expenses.baseTotalMinor,
        count: summary.expenses.count,
      },
      openingSettlements: {
        baseTotalMinor: summary.openingSettlements.baseTotalMinor,
        count: summary.openingSettlements.count,
      },
    } : {}),
    ...(access.expenses && access.profit ? { netMinor: summary.netMinor } : {}),
  };
}
