import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SAVED_REPORTS_SQL } from "../lib/saved-reports-schema";
import {
  normalizeReportSection,
  normalizeSavedReportName,
  normalizeSavedReportQuery,
} from "../lib/saved-reports";
import { canAccessUnifiedReport, isKnownUnifiedReport } from "../lib/report-access";

describe("saved reports schema", () => {
  it("keeps migration 0015 byte-equal to runtime schema SQL", () => {
    const migration = readFileSync("migrations/0015_saved_reports.sql", "utf8");
    const lines = migration.split("\n");
    let index = 0;
    while (index < lines.length && (lines[index].startsWith("--") || lines[index].trim() === "")) index += 1;
    expect(lines.slice(index).join("\n").trim()).toBe(SAVED_REPORTS_SQL.trim());
  });
});

describe("saved report input", () => {
  it("canonicalizes only supported report-filter keys", () => {
    const normalized = normalizeSavedReportQuery(
      "appointments",
      "report=appointments&preset=this_month&doctorId=7&currency=SAR&evil=DROP&section=financial",
    );
    expect(normalized.reportId).toBe("appointments");
    expect(normalized.queryString).toContain("report=appointments");
    expect(normalized.queryString).toContain("doctorId=7");
    expect(normalized.queryString).toContain("currency=SAR");
    expect(normalized.queryString).not.toContain("evil");
    expect(normalized.queryString).not.toContain("section");
  });

  it("rejects mismatched or unknown report ids", () => {
    expect(() => normalizeSavedReportQuery("visits", "report=debt&preset=today")).toThrow();
    expect(() => normalizeSavedReportQuery("not-a-report", "report=not-a-report")).toThrow();
  });

  it("validates names and sections", () => {
    expect(normalizeSavedReportName("  مواعيد الشهر  ")).toBe("مواعيد الشهر");
    expect(normalizeReportSection("operational")).toBe("operational");
    expect(() => normalizeReportSection("secret")).toThrow();
  });
});

describe("unified report allowlist", () => {
  it("fails closed for unknown report identifiers even for admin", () => {
    expect(isKnownUnifiedReport("made-up")).toBe(false);
    expect(canAccessUnifiedReport("admin", "made-up")).toBe(false);
  });
});
