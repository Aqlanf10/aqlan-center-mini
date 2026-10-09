import { describe, expect, it } from "vitest";
import { normalizeClinicalProcedureId } from "../lib/clinical-procedure-id";

describe("canonical clinical procedure identities", () => {
  it.each([1, 42, 2147483648, Number.MAX_SAFE_INTEGER])("preserves safe numeric identity %s", id => {
    expect(normalizeClinicalProcedureId(id)).toBe(id);
    expect(normalizeClinicalProcedureId(String(id))).toBe(id);
  });

  it.each([
    undefined, null, true, {}, [], 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
    "", "0", "-1", "1.5", "1e3", "0x10", "01", " 1", "1 ",
    "9007199254740992", "9007199254740993", "9223372036854775807",
  ])("rejects an absent, malformed or unsafe identity: %s", value => {
    expect(() => normalizeClinicalProcedureId(value)).toThrow(RangeError);
  });
});
