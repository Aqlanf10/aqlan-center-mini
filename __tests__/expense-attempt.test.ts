import { describe, expect, it } from "vitest";
import {
  EXPENSE_ATTEMPT_STORAGE_KEY, beginExpenseAttempt, classifyExpenseAnswer, dismissExpenseAttempt,
  pendingExpenseAttempts, resetExpenseAttemptMemoryForTesting, settleExpenseAttempt,
} from "../lib/expense-attempt";
import { IDEMPOTENCY_KEY_PATTERN } from "../lib/idempotency-key";

// docs/finance/EXPENSE_COMMANDS_0128.md §2.1 and the owner's review #483 6882465665: an unsettled expense
// request is never lost and never silently replaced by a new key. Synthetic values only.
function storage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); }, map };
}
function broken() {
  return { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceededError"); },
    removeItem: () => { throw new Error("SecurityError"); } };
}
const body = JSON.stringify({ category: "other", amount: "125", currency: "YER", payee: "SYN" });
const start = (store: Parameters<typeof beginExpenseAttempt>[0], extra: Partial<Parameters<typeof beginExpenseAttempt>[1]> = {}) =>
  beginExpenseAttempt(store, { actor: "syn-cashier", surface: "petty", match: body, body, label: "SYN 125", ...extra });

describe("one key per intended voucher", () => {
  it("reuses the pending key for the same user and entry, and mints a new one only after a settled answer", () => {
    resetExpenseAttemptMemoryForTesting();
    const store = storage();
    const first = start(store).attempt;
    expect(first.key).toMatch(IDEMPOTENCY_KEY_PATTERN);
    expect(start(store).attempt.key).toBe(first.key);
    expect(start(store, { match: "{\"amount\":\"126\"}" }).attempt.key).not.toBe(first.key);
    settleExpenseAttempt(store, first.key);
    expect(start(store).attempt.key).not.toBe(first.key);
  });

  it("survives a reload through storage", () => {
    resetExpenseAttemptMemoryForTesting();
    const store = storage();
    const key = start(store).attempt.key;
    resetExpenseAttemptMemoryForTesting();
    const reloaded = storage(); reloaded.setItem(EXPENSE_ATTEMPT_STORAGE_KEY, store.getItem(EXPENSE_ATTEMPT_STORAGE_KEY)!);
    expect(start(reloaded).attempt.key).toBe(key);
    expect(pendingExpenseAttempts(reloaded, "syn-cashier").map((a) => a.key)).toEqual([key]);
  });

  it("keeps the key stable in the page when storage throws, and says it cannot survive a reload", () => {
    resetExpenseAttemptMemoryForTesting();
    const first = start(broken());
    expect(first.persisted).toBe(false);
    const again = start(broken());
    expect(again.attempt.key).toBe(first.attempt.key);
    expect(pendingExpenseAttempts(broken(), "syn-cashier").map((a) => a.key)).toEqual([first.attempt.key]);
    expect(start(null).attempt.key).toBe(first.attempt.key);
  });

  it("never hands another user's pending attempt to this user, and never shows it to them", () => {
    resetExpenseAttemptMemoryForTesting();
    const store = storage();
    const mine = start(store).attempt;
    const theirs = start(store, { actor: "syn-reception" }).attempt;
    expect(theirs.key).not.toBe(mine.key);
    expect(pendingExpenseAttempts(store, "syn-reception").map((a) => a.key)).toEqual([theirs.key]);
    expect(pendingExpenseAttempts(store, "syn-cashier").map((a) => a.key)).toEqual([mine.key]);
  });

  it("ignores tampered rows and keeps the exact body to resend", () => {
    resetExpenseAttemptMemoryForTesting();
    const store = storage();
    store.setItem(EXPENSE_ATTEMPT_STORAGE_KEY, JSON.stringify([{ key: "bad key", actor: "syn-cashier", match: body, body }]));
    expect(pendingExpenseAttempts(store, "syn-cashier")).toEqual([]);
    const sent = start(store, { body: JSON.stringify({ ...JSON.parse(body), expected: { paymentExchangeRate: 1 } }) }).attempt;
    expect(JSON.parse(pendingExpenseAttempts(store, "syn-cashier")[0].body)).toMatchObject({ expected: { paymentExchangeRate: 1 } });
    dismissExpenseAttempt(store, sent.key);
    expect(pendingExpenseAttempts(store, "syn-cashier")).toEqual([]);
  });
});

describe("what an answer proves", () => {
  const receipt = { id: 9, voucherNumber: "SYN-V-9" };
  it("is saved only with a readable receipt", () => {
    expect(classifyExpenseAnswer(201, false, receipt)).toBe("saved");
    expect(classifyExpenseAnswer(200, false, { ...receipt, replayed: true })).toBe("saved");
    expect(classifyExpenseAnswer(201, false, null)).toBe("unknown");
    expect(classifyExpenseAnswer(201, false, { id: "9" })).toBe("unknown");
    expect(classifyExpenseAnswer(200, true, receipt)).toBe("unknown");
  });
  it("is a proven refusal only when the server says the key holds nothing", () => {
    expect(classifyExpenseAnswer(409, false, { code: "exceeds_drawer_cash", requestKeyState: "unused" })).toBe("refused");
    expect(classifyExpenseAnswer(400, false, { code: "invalid_payment_split", requestKeyState: "unused" })).toBe("refused");
    for (const [status, payload] of [[401, { message: "SYN" }], [403, { code: "owner_private_requires_owner" }],
      [409, { code: "expense_request_conflict" }], [400, { message: "SYN" }], [500, null], [502, { requestKeyState: "unused" }]] as const) {
      expect(classifyExpenseAnswer(status, false, payload), `${status}`).toBe("unknown");
    }
  });
});
