import type { ExpenseCategoryDTO, ExpenseBudgetSummary } from "@/lib/db";
import type { StandardAccountItem } from "@/lib/accounting";
import { canDoctorViewExpenses, type DoctorPermissions } from "@/lib/doctor-permissions";
import { financeAccessFor, type FinanceAccess } from "@/lib/finance-permissions";
import type { Currency } from "@/lib/money";

export type ExpenseCatalogueAccess = "denied" | "catalogue" | "full";

/** Preserve daily-money roles; apply the existing doctor/report denials. */
export function expenseCatalogueAccess(
  role: string | null | undefined,
  permissions?: DoctorPermissions | null,
  financeAccess?: Partial<FinanceAccess>,
): ExpenseCatalogueAccess {
  if (role === "admin" || role === "reception" || role === "cashier") return "full";
  if (role === "doctor") return canDoctorViewExpenses(permissions, role) ? "full" : "catalogue";
  if (role === "accountant") return financeAccessFor(role, financeAccess).viewReports ? "full" : "catalogue";
  return "denied";
}

/** Operational labels/mappings needed by the lab order form, with no amounts. */
export type ExpenseCatalogueCategory = Pick<ExpenseCategoryDTO,
  "id" | "key" | "name" | "categoryGroup" | "accountCode" | "accountName" | "isActive"
>;

export interface ExpenseCategoriesInput {
  categories: ExpenseCategoryDTO[];
  summary: ExpenseBudgetSummary;
  standardExpenseAccounts: readonly StandardAccountItem[];
  baseCurrency: Currency;
}

export type ExpenseCategoriesResponse = {
  visibility: "catalogue";
  categories: ExpenseCatalogueCategory[];
  baseCurrency: Currency;
} | {
  visibility: "full";
  categories: ExpenseCategoryDTO[];
  summary: ExpenseBudgetSummary;
  standardExpenseAccounts: StandardAccountItem[];
  baseCurrency: Currency;
};

function projectCatalogueCategory(category: ExpenseCategoryDTO): ExpenseCatalogueCategory {
  return {
    id: category.id,
    key: category.key,
    name: category.name,
    categoryGroup: category.categoryGroup,
    accountCode: category.accountCode,
    accountName: category.accountName,
    isActive: category.isActive,
  };
}

/** Denied financial fields are absent, including counts and reconstructive ratios. */
export function projectExpenseCategories(
  input: ExpenseCategoriesInput,
  access: ExpenseCatalogueAccess,
): ExpenseCategoriesResponse | null {
  if (access === "denied") return null;
  if (access !== "full") return {
    visibility: "catalogue",
    categories: input.categories.map(projectCatalogueCategory),
    baseCurrency: input.baseCurrency,
  };

  const summary = input.summary;
  return {
    visibility: "full",
    categories: input.categories.map((category) => ({
      ...projectCatalogueCategory(category),
      monthlyBudgetMinor: category.monthlyBudgetMinor,
      annualBudgetMinor: category.annualBudgetMinor,
      budgetCurrency: category.budgetCurrency,
      isSystem: category.isSystem,
      autoPostJournal: category.autoPostJournal,
      description: category.description,
      displayOrder: category.displayOrder,
      actualSpentMinor: category.actualSpentMinor,
      expensesCount: category.expensesCount,
      budgetMinor: category.budgetMinor,
      varianceMinor: category.varianceMinor,
      consumptionPercent: category.consumptionPercent,
      variancePercent: category.variancePercent,
      isOverBudget: category.isOverBudget,
    })),
    summary: {
      month: summary.month,
      totalCategories: summary.totalCategories,
      activeCategories: summary.activeCategories,
      totalMonthlyBudgetMinor: summary.totalMonthlyBudgetMinor,
      totalActualSpentMinor: summary.totalActualSpentMinor,
      totalVarianceMinor: summary.totalVarianceMinor,
      totalExpensesCount: summary.totalExpensesCount,
      overBudgetCount: summary.overBudgetCount,
      overallConsumptionPercent: summary.overallConsumptionPercent,
      overallVariancePercent: summary.overallVariancePercent,
    },
    standardExpenseAccounts: input.standardExpenseAccounts.map((account) => ({
      code: account.code,
      name: account.name,
      category: account.category,
      description: account.description,
      ...(account.isDefault !== undefined ? { isDefault: account.isDefault } : {}),
    })),
    baseCurrency: input.baseCurrency,
  };
}
