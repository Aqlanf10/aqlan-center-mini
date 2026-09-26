import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEGACY_ARCHIVE_SQL } from "../lib/legacy-archive-schema";

describe("(P1-5c) legacy archive schema", () => {
  it("keeps migration 0024 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0024_legacy_archive.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(LEGACY_ARCHIVE_SQL.trim());
  });
});
