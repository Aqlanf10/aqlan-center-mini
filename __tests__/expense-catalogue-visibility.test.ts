import { describe, expect, it } from "vitest";
import { parseDoctorPermissions } from "../lib/doctor-permissions";
import { expenseCatalogueAccess, projectExpenseCategories } from "../lib/expense-catalogue-visibility";
import { expenseCategoriesFixture as input } from "./fixtures/expense-categories";

const catalogueKeys = ["accountCode", "accountName", "categoryGroup", "id", "isActive", "key", "name"].sort();
const deniedCategoryKeys = ["monthlyBudgetMinor", "annualBudgetMinor", "budgetCurrency", "actualSpentMinor",
  "expensesCount", "budgetMinor", "varianceMinor", "consumptionPercent", "variancePercent", "isOverBudget", "description"];

describe("expense catalogue visibility policy", () => {
  it.each([undefined, null, {}, "{broken", { canViewClinicRevenue: true }, { canViewClinicFinance: true },
    { canViewCostPrices: true }, { canViewClinicProfits: true }, { canViewAdminReports: true }])("never grants expense budgets through unrelated doctor flags: %j", (raw) => {
      expect(expenseCatalogueAccess("doctor", parseDoctorPermissions(raw))).toBe("catalogue");
    });

  it("honors explicit expense permission independently of clinic revenue", () => {
    expect(expenseCatalogueAccess("doctor", parseDoctorPermissions({ canViewExpenses: true }))).toBe("full");
    expect(expenseCatalogueAccess("doctor", null)).toBe("catalogue");
    expect(expenseCatalogueAccess("doctor", undefined)).toBe("catalogue");
  });

  it("uses the normalized accountant report scope", () => {
    expect(expenseCatalogueAccess("accountant")).toBe("full");
    expect(expenseCatalogueAccess("accountant", null, { viewReports: true })).toBe("full");
    expect(expenseCatalogueAccess("accountant", parseDoctorPermissions({}, "admin"), { viewReports: false })).toBe("catalogue");
  });

  it.each(["admin", "reception", "cashier"])("preserves the existing %s read contract without inventing new restrictions", (role) => {
    expect(expenseCatalogueAccess(role, parseDoctorPermissions({}, role), { viewReports: false, createExpenses: false })).toBe("full");
  });

  it.each(["assistant", "unknown", "manager", undefined, null])("does not grant a new role access: %j", (role) => {
    expect(expenseCatalogueAccess(role, parseDoctorPermissions({}, "admin"))).toBe("denied");
  });
});

describe("explicit financial payload projection", () => {
  it("omits denied money, counts, reconstructive ratios and entire summary in serialized JSON", () => {
    const result = projectExpenseCategories(input, "catalogue")!;
    const serialized = JSON.parse(JSON.stringify(result));
    expect(serialized.visibility).toBe("catalogue");
    expect(Object.keys(serialized.categories[0]).sort()).toEqual(catalogueKeys);
    for (const key of deniedCategoryKeys) expect(serialized.categories[0]).not.toHaveProperty(key);
    expect(serialized).not.toHaveProperty("summary");
    expect(serialized).not.toHaveProperty("standardExpenseAccounts");
    expect(serialized.baseCurrency).toBe("YER");
    for (const value of [123400, 1480800, 45678, 77722]) expect(JSON.stringify(serialized)).not.toContain(String(value));
  });

  it("retains every existing lab selection and account-mapping field", () => {
    const result = projectExpenseCategories(input, "catalogue")!;
    const selected = result.categories.find((category) => category.key === "lab" || category.accountCode === "5101");
    expect(selected).toEqual({ id: 901, key: "lab", name: "Synthetic lab category", categoryGroup: "Synthetic group",
      accountCode: "5101", accountName: "Synthetic account", isActive: true });
  });

  it("preserves all authorized values and distinguishes true zero from omission", () => {
    expect(projectExpenseCategories(input, "full")).toEqual({ visibility: "full", ...input });
    const zero = { ...input, categories: input.categories.map((category) => ({ ...category, actualSpentMinor: 0 })),
      summary: { ...input.summary, totalActualSpentMinor: 0 } };
    expect(projectExpenseCategories(zero, "full")!.categories[0]).toHaveProperty("actualSpentMinor", 0);
    expect(projectExpenseCategories(zero, "catalogue")!.categories[0]).not.toHaveProperty("actualSpentMinor");
  });

  it.each(["full", "catalogue"] as const)("allowlists future fields and does not mutate/alias the source in %s mode", (access) => {
    const expanded = { ...input, futureSecret: "UNCLASSIFIED_SECRET",
      categories: input.categories.map((category) => ({ ...category, futureSecret: "UNCLASSIFIED_SECRET" })),
      summary: { ...input.summary, futureSecret: "UNCLASSIFIED_SECRET" },
      standardExpenseAccounts: input.standardExpenseAccounts.map((account) => ({ ...account, futureSecret: "UNCLASSIFIED_SECRET" })),
    };
    const before = JSON.stringify(expanded);
    const result = projectExpenseCategories(expanded, access)!;
    expect(JSON.stringify(result)).not.toContain("UNCLASSIFIED_SECRET");
    expect(JSON.stringify(expanded)).toBe(before);
    expect(result.categories[0]).not.toBe(expanded.categories[0]);
    if (result.visibility === "full") {
      expect(result.summary).not.toBe(expanded.summary);
      expect(result.standardExpenseAccounts[0]).not.toBe(expanded.standardExpenseAccounts[0]);
    }
  });

  it("returns no payload for an excluded role", () => {
    expect(projectExpenseCategories(input, "denied")).toBeNull();
  });
});
