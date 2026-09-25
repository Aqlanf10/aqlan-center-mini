import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXPENSE_ATTACHMENTS_SQL } from "../lib/expense-attachments-schema";

describe("expense attachments schema (P3-6)", () => {
  it("keeps migration 0020 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0020_expense_attachments.sql", "utf8").split("\n");
    let index = 0;
    while (index < lines.length && (lines[index].startsWith("--") || lines[index].trim() === "")) index += 1;
    expect(lines.slice(index).join("\n").trim()).toBe(EXPENSE_ATTACHMENTS_SQL.trim());
  });

  it("is append-only: updates and deletes raise", () => {
    expect(EXPENSE_ATTACHMENTS_SQL).toMatch(/BEFORE UPDATE OR DELETE ON expense_attachments/);
  });
});
