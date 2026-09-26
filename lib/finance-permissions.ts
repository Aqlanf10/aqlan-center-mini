/** Per-user limits inside the fixed cashier/accountant role boundaries. */
export interface FinanceAccess {
  operateShift: boolean;
  collectPayments: boolean;
  createExpenses: boolean;
  viewPatientLedger: boolean;
  viewReports: boolean;
  viewSuppliers: boolean;
  viewCommissions: boolean;
  viewReconciliation: boolean;
}

export const CASHIER_FINANCE_ACCESS: FinanceAccess = {
  operateShift: true,
  collectPayments: true,
  createExpenses: true,
  viewPatientLedger: true,
  viewReports: false,
  viewSuppliers: false,
  viewCommissions: false,
  viewReconciliation: false,
};

export const ACCOUNTANT_FINANCE_ACCESS: FinanceAccess = {
  operateShift: false,
  collectPayments: false,
  createExpenses: false,
  viewPatientLedger: true,
  viewReports: true,
  viewSuppliers: true,
  viewCommissions: true,
  viewReconciliation: true,
};

export function financeAccessFor(role: string | null | undefined, raw?: unknown): FinanceAccess {
  const base = role === "cashier" ? CASHIER_FINANCE_ACCESS : ACCOUNTANT_FINANCE_ACCESS;
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const result = { ...base };
  for (const key of Object.keys(base) as (keyof FinanceAccess)[]) {
    if (typeof source[key] === "boolean") result[key] = source[key];
  }
  // An accountant stays read-only even if a malformed/stale value says otherwise.
  if (role === "accountant") {
    result.operateShift = false;
    result.collectPayments = false;
    result.createExpenses = false;
  }
  // A cashier never gains administrative reports, suppliers or commissions.
  if (role === "cashier") {
    result.viewReports = false;
    result.viewSuppliers = false;
    result.viewCommissions = false;
    result.viewReconciliation = false;
  }
  return result;
}
