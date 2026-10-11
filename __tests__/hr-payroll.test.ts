import { describe, expect, it } from "vitest";
import {
  calculateItemNetDue,
  isAllowedHrCurrency,
} from "../lib/hr-payroll-shared";

describe("(HR-5) Payroll and Disbursements Calculations", () => {
  it("calculates standard net salary correctly", () => {
    const net = calculateItemNetDue({
      baseSalaryMinor: 150000,
      allowancesMinor: 20000,
      commissionsMinor: 0,
      advancesMinor: 0,
      deductionsMinor: 5000,
    });
    // 150000 + 20000 + 0 - 0 - 5000 = 165000
    expect(net).toBe(165000);
  });

  it("calculates doctor percentage commission payroll item", () => {
    const net = calculateItemNetDue({
      baseSalaryMinor: 0,
      allowancesMinor: 0,
      commissionsMinor: 320000, // doctor commission earned
      advancesMinor: 0,
      deductionsMinor: 0,
    });
    expect(net).toBe(320000);
  });

  it("calculates hybrid doctor contract with base and commission and advances", () => {
    const net = calculateItemNetDue({
      baseSalaryMinor: 100000,
      allowancesMinor: 15000,
      commissionsMinor: 85000,
      advancesMinor: 10000,
      deductionsMinor: 5000,
    });
    // 100000 + 15000 + 85000 - 10000 - 5000 = 185000
    expect(net).toBe(185000);
  });

  it("enforces non-negative net salary even if deductions exceed total additions", () => {
    const net = calculateItemNetDue({
      baseSalaryMinor: 50000,
      allowancesMinor: 0,
      commissionsMinor: 0,
      advancesMinor: 40000,
      deductionsMinor: 40000, // cuts: 80000 > gross: 50000
    });
    expect(net).toBe(0);
  });

  it("validates currency isolation for allowed currencies only", () => {
    expect(isAllowedHrCurrency("YER")).toBe(true);
    expect(isAllowedHrCurrency("SAR")).toBe(true);
    expect(isAllowedHrCurrency("USD")).toBe(true);
    expect(isAllowedHrCurrency("EUR")).toBe(false);
    expect(isAllowedHrCurrency("GBP")).toBe(false);
  });
});
