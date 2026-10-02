import type { ExpenseCategoriesInput } from "../../lib/expense-catalogue-visibility";

export const expenseCategoriesFixture: ExpenseCategoriesInput = {
  categories: [{
    id: 901, key: "lab", name: "Synthetic lab category", categoryGroup: "Synthetic group",
    accountCode: "5101", accountName: "Synthetic account", monthlyBudgetMinor: 123400,
    annualBudgetMinor: 1480800, budgetCurrency: "YER", isActive: true, isSystem: false,
    autoPostJournal: true, description: "Synthetic confidential budget note", displayOrder: 10,
    actualSpentMinor: 45678, expensesCount: 3, budgetMinor: 123400, varianceMinor: 77722,
    consumptionPercent: 37, variancePercent: -63, isOverBudget: false,
  }],
  summary: {
    month: "2026-07", totalCategories: 1, activeCategories: 1, totalMonthlyBudgetMinor: 123400,
    totalActualSpentMinor: 45678, totalVarianceMinor: 77722, totalExpensesCount: 3,
    overBudgetCount: 0, overallConsumptionPercent: 37, overallVariancePercent: -63,
  },
  standardExpenseAccounts: [{ code: "5101", name: "Synthetic account", category: "Synthetic group",
    description: "Static chart metadata", isDefault: true }],
  baseCurrency: "YER",
};
