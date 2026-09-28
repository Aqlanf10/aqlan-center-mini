import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLANNED_VISIT_INTERVAL_SQL } from "../lib/planned-visit-interval-schema";

describe("(SPEC-T4) planned visit interval schema", () => {
  it("keeps migration 0029 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0029_planned_visit_interval.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(PLANNED_VISIT_INTERVAL_SQL.trim());
  });
});
