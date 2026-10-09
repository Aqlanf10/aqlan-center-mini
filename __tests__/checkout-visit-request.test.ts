import { describe, expect, it } from "vitest";
import { readCheckoutVisitRequest } from "../lib/checkout-visit-request";

describe("explicit checkout visit URL", () => {
  it("distinguishes an absent selection from a valid exact visit", () => {
    expect(readCheckoutVisitRequest(undefined)).toBeNull();
    expect(readCheckoutVisitRequest("17")).toBe(17);
    expect(readCheckoutVisitRequest(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });
  it.each([null, "", "0", "-1", "01", "+1", "1.0", "1e3", " 17", "17 ", "9007199254740992", "Infinity", "1/2", ["17"], ["17", "18"], 17])("rejects %j without falling back to latest visit", value => {
    expect(readCheckoutVisitRequest(value)).toBe("invalid");
  });
});
