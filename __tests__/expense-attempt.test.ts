import { describe, expect, it } from "vitest";
import { EXPENSE_ATTEMPT_STORAGE_KEY, expenseAttemptKey, isDefinitiveExpenseAnswer, settleExpenseAttempt } from "../lib/expense-attempt";
import { IDEMPOTENCY_KEY_PATTERN } from "../lib/idempotency-key";

// docs/finance/EXPENSE_COMMANDS_0128.md §2.1 (owner #483 6831365228 item 3). Synthetic values only.
function storage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); }, map };
}
const body = JSON.stringify({ category: "other", amount: "125", currency: "YER", payee: "SYN" });

describe("expense request key on the client", () => {
  it("reuses the key for the same body until a definitive answer, then mints a new one", () => {
    const store = storage();
    const first = expenseAttemptKey(store, body);
    expect(first).toMatch(IDEMPOTENCY_KEY_PATTERN);
    expect(expenseAttemptKey(store, body)).toBe(first);
    expect(expenseAttemptKey(store, JSON.stringify({ ...JSON.parse(body), amount: "126" }))).not.toBe(first);
    settleExpenseAttempt(store, first);
    expect(expenseAttemptKey(store, body)).not.toBe(first);
  });
  it("survives a reload through storage and ignores tampered rows", () => {
    const store = storage();
    const key = expenseAttemptKey(store, body);
    expect(expenseAttemptKey(storage(), body)).not.toBe(key);
    const reloaded = storage(); reloaded.setItem(EXPENSE_ATTEMPT_STORAGE_KEY, store.getItem(EXPENSE_ATTEMPT_STORAGE_KEY)!);
    expect(expenseAttemptKey(reloaded, body)).toBe(key);
    reloaded.setItem(EXPENSE_ATTEMPT_STORAGE_KEY, JSON.stringify([{ body, key: "bad key" }]));
    expect(expenseAttemptKey(reloaded, body)).not.toBe("bad key");
    reloaded.setItem(EXPENSE_ATTEMPT_STORAGE_KEY, "{not json");
    expect(expenseAttemptKey(reloaded, body)).toMatch(IDEMPOTENCY_KEY_PATTERN);
  });
  it("works without storage, minting a key per send", () => {
    expect(expenseAttemptKey(null, body)).toMatch(IDEMPOTENCY_KEY_PATTERN);
  });
  it("treats 2xx and 4xx as definitive and 5xx or redirects as unknown", () => {
    for (const status of [200, 201, 400, 401, 403, 409]) expect(isDefinitiveExpenseAnswer(status), String(status)).toBe(true);
    for (const status of [302, 500, 502, 503]) expect(isDefinitiveExpenseAnswer(status), String(status)).toBe(false);
  });
});
