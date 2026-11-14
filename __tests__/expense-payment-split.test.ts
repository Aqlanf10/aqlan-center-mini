import { describe, expect, it } from "vitest";
import { expenseEntry } from "../lib/accounting";
import { ownerFundingAccountProblem, parseExpensePaymentSplit, requestsOwnerPrivatePart } from "../lib/expense-payment-split";
import { validateSetting } from "../lib/settings";
import { SETTING_KEY_CLASSES } from "../lib/settings-capabilities";

// docs/finance/EXPENSE_COMMANDS_0128.md §2.2–2.3 (owner #483 6831365228 item 2). Synthetic values only.
describe("payment split of an expense request", () => {
  it("pays wholly from the drawer when no private part is sent", () => {
    expect(parseExpensePaymentSplit({}, 300, "YER")).toEqual({ ok: true, value: { drawerMinor: 300, ownerPrivateMinor: 0, ownerPrivateReason: null } });
    expect(parseExpensePaymentSplit({ ownerPrivateAmount: "  " }, 300, "YER").ok).toBe(true);
    expect(requestsOwnerPrivatePart({})).toBe(false);
    expect(requestsOwnerPrivatePart({ ownerPrivateAmount: "" })).toBe(false);
  });
  it("splits the owner's worked mixed example: 300 with 200 private leaves 100 from the drawer", () => {
    expect(parseExpensePaymentSplit({ ownerPrivateAmount: "200", ownerPrivateReason: " SYN drawer short " }, 300, "YER"))
      .toEqual({ ok: true, value: { drawerMinor: 100, ownerPrivateMinor: 200, ownerPrivateReason: "SYN drawer short" } });
    expect(parseExpensePaymentSplit({ ownerPrivateAmount: "300", ownerPrivateReason: "SYN all private" }, 300, "YER").ok).toBe(true);
    expect(parseExpensePaymentSplit({ ownerPrivateAmount: "12.50", ownerPrivateReason: "SYN cents" }, 2000, "USD"))
      .toMatchObject({ ok: true, value: { drawerMinor: 750, ownerPrivateMinor: 1250 } });
  });
  it.each([
    ["no reason", { ownerPrivateAmount: "100" }],
    ["a two-letter reason", { ownerPrivateAmount: "100", ownerPrivateReason: "ab" }],
    ["an over-long reason", { ownerPrivateAmount: "100", ownerPrivateReason: "x".repeat(301) }],
    ["a part above the amount", { ownerPrivateAmount: "301", ownerPrivateReason: "SYN reason" }],
    ["a zero part", { ownerPrivateAmount: "0", ownerPrivateReason: "SYN reason" }],
    ["a negative part", { ownerPrivateAmount: "-5", ownerPrivateReason: "SYN reason" }],
    ["a non-number", { ownerPrivateAmount: "abc", ownerPrivateReason: "SYN reason" }],
    ["a reason alone", { ownerPrivateReason: "SYN reason" }],
  ])("refuses %s, never trims it to fit", (_label, source) => {
    const result = parseExpensePaymentSplit(source, 300, "YER");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/لم يُسجَّل شيء/);
  });
});

describe("the owner funding account", () => {
  it("accepts only a postable equity or liability account", () => {
    expect(ownerFundingAccountProblem("3101")).toBeNull();
    expect(ownerFundingAccountProblem("2101")).toBeNull();
    for (const code of ["", "1101", "1111", "1201", "4101", "5901", "3", "9999"]) expect(ownerFundingAccountProblem(code), code).not.toBeNull();
  });
  it("is validated on save, may stay empty, and is an owner-only setting", () => {
    expect(validateSetting("finance.owner_private_funding_account", "")).toBeNull();
    expect(validateSetting("finance.owner_private_funding_account", "3101")).toBeNull();
    expect(validateSetting("finance.owner_private_funding_account", "1101")).not.toBeNull();
    expect(SETTING_KEY_CLASSES["finance.owner_private_funding_account"]).toEqual({ class: "authority" });
  });
});

describe("the journal entry of a split voucher", () => {
  const base = { voucherNumber: "SYN-V-1", date: "2026-11-14", payeeName: "SYN", category: "other", currency: "YER" as const, settlesPayable: false };
  const credits = (entry: ReturnType<typeof expenseEntry>) => entry!.lines.filter((l) => l.side === "credit").map((l) => [l.accountCode, l.amountMinor]);
  it("credits cash for a drawer voucher exactly as before 0128", () => {
    expect(credits(expenseEntry({ ...base, amountMinor: 300 }))).toEqual([["1101", 300]]);
  });
  it("credits cash with the drawer part and the captured account with the private part", () => {
    expect(credits(expenseEntry({ ...base, amountMinor: 300, drawerMinor: 100, ownerPrivate: { amountMinor: 200, accountCode: "3101" } })))
      .toEqual([["1101", 100], ["3101", 200]]);
    expect(credits(expenseEntry({ ...base, amountMinor: 300, drawerMinor: 0, ownerPrivate: { amountMinor: 300, accountCode: "3101" } })))
      .toEqual([["3101", 300]]);
  });
  it("mirrors a reversal and refuses parts that do not add up", () => {
    const reversal = expenseEntry({ ...base, amountMinor: -300, drawerMinor: -100, ownerPrivate: { amountMinor: -200, accountCode: "3101" } })!;
    expect(reversal.lines.filter((l) => l.side === "debit").map((l) => [l.accountCode, l.amountMinor])).toEqual([["1101", 100], ["3101", 200]]);
    expect(() => expenseEntry({ ...base, amountMinor: 300, drawerMinor: 100, ownerPrivate: { amountMinor: 100, accountCode: "3101" } })).toThrow();
  });
});
