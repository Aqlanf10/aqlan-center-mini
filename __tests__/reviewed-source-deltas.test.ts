import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reverseReviewedDeltas } from "./helpers/reviewed-source-deltas";

describe("reviewed source delta contract is exact, not normalization", () => {
  const delta = [{ before: "old guard", after: "new guard" }];
  it("recovers the old slice and preserves all unreviewed bytes for hashing", () => {
    expect(reverseReviewedDeltas("prefix new guard suffix", delta)).toBe("prefix old guard suffix");
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    expect(hash(reverseReviewedDeltas("CHANGED new guard suffix", delta)))
      .not.toBe(hash("prefix old guard suffix"));
  });
  it("rejects missing, modified, duplicated, and empty reviewed hunks", () => {
    for (const source of ["old guard", "new unsafe guard", "new guard new guard"]) {
      expect(() => reverseReviewedDeltas(source, delta)).toThrow();
    }
    expect(() => reverseReviewedDeltas("anything", [{ before: "old", after: "" }])).toThrow();
  });
});
