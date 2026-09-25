import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SAVED_REPORTS_SQL } from "../lib/saved-reports-schema";
import {
  createSavedReport,
  deleteSavedReport,
  listSavedReports,
  normalizeReportSection,
  normalizeSavedReportName,
  normalizeSavedReportQuery,
  updateSavedReport,
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


vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const db = await import("../lib/db");

describe("saved reports persistence", () => {
  beforeAll(async () => {
    await db.ensureSchema();
    await db.getPool().query(
      `INSERT INTO users (username, display_name, password_hash, role, is_active)
       VALUES ('reports-saved-a', 'Reports A', 'test-hash', 'admin', TRUE),
              ('reports-saved-b', 'Reports B', 'test-hash', 'admin', TRUE)
       ON CONFLICT (username) DO NOTHING`,
    );
  });

  afterAll(async () => {
    await db.resetPoolForTesting();
  });

  it("keeps reports private to their owner and supports favorites", async () => {
    const created = await createSavedReport({
      ownerUsername: "reports-saved-a",
      name: "مواعيد الشهر",
      reportId: "appointments",
      sectionId: "operational",
      queryString: "report=appointments&preset=this_month",
    });
    expect((await listSavedReports("reports-saved-a")).map((item) => item.id)).toContain(created.id);
    expect(await listSavedReports("reports-saved-b")).toEqual([]);

    const favorite = await updateSavedReport({
      ownerUsername: "reports-saved-a",
      id: created.id,
      isFavorite: true,
    });
    expect(favorite?.isFavorite).toBe(true);

    expect(await deleteSavedReport("reports-saved-b", created.id)).toBe(false);
    expect(await deleteSavedReport("reports-saved-a", created.id)).toBe(true);
  });
});
