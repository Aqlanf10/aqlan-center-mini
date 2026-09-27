import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MEDICAL_HISTORY_SQL } from "../lib/medical-history-schema";

describe("(PAT-2) medical history schema", () => {
  it("keeps migration 0027 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0027_medical_history.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(MEDICAL_HISTORY_SQL.trim());
  });
});
