import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scanMoneyAggregation } from "../lib/money-aggregation-guard";

const path = "lib/legacy-treatment-db.ts";
const source = readFileSync(path, "utf8");

describe("legacy opening collections retain the native currency boundary", () => {
  it("passes the unchanged money guard without an allowlist exception", () => {
    expect(scanMoneyAggregation(source, path)).toEqual([]);
    expect(source).toContain("GROUP BY currency, base_currency ORDER BY currency, base_currency");
  });

  it("the guard still rejects the actual query if its native currency grouping is removed", () => {
    const ungrouped = source.replace("GROUP BY currency, base_currency ORDER BY currency, base_currency", "");
    expect(scanMoneyAggregation(ungrouped, path)).toMatchObject([{ column: "amount_minor" }]);
  });
});
