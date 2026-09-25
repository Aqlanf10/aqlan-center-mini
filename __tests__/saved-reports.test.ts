import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SAVED_REPORTS_SQL } from "../lib/saved-reports-schema";
import {
  availableCopyName,
  createSavedReport,
  deleteSavedReport,
  getVisibleSavedReport,
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

  it("keeps the custom view (columns order, sort, group) in the saved link", () => {
    const normalized = normalizeSavedReportQuery(
      "lab",
      "report=lab&preset=this_year&columns=labName,patientName&sort=daysLate:desc&group=labName",
    );
    const params = new URLSearchParams(normalized.queryString);
    expect(params.get("columns")).toBe("labName,patientName");
    expect(params.get("sort")).toBe("daysLate:desc");
    expect(params.get("group")).toBe("labName");
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

  it("shares admin templates read-only: others see and duplicate them, only the owner edits", async () => {
    const template = await createSavedReport({
      ownerUsername: "reports-saved-a",
      name: "مرضى اليوم — قالب",
      reportId: "visits",
      sectionId: "operational",
      queryString: "report=visits&preset=today",
      isShared: true,
    });
    const seenByB = (await listSavedReports("reports-saved-b")).find((item) => item.id === template.id);
    expect(seenByB?.isShared).toBe(true);
    expect(seenByB?.owned).toBe(false);
    expect(seenByB?.isFavorite).toBe(false);
    expect(await getVisibleSavedReport("reports-saved-b", template.id)).not.toBeNull();

    // غير المالك لا يعدّل ولا يحذف القالب.
    expect(await updateSavedReport({ ownerUsername: "reports-saved-b", id: template.id, name: "اختطاف" })).toBeNull();
    expect(await deleteSavedReport("reports-saved-b", template.id)).toBe(false);

    // النسخ يعطي نسخةً خاصة باسمٍ متاح.
    const copyName = await availableCopyName("reports-saved-b", template.name);
    expect(copyName).toBe("نسخة من مرضى اليوم — قالب");
    const copy = await createSavedReport({
      ownerUsername: "reports-saved-b",
      name: copyName,
      reportId: template.reportId,
      sectionId: template.sectionId,
      queryString: template.queryString,
    });
    expect(copy.owned).toBe(true);
    expect(copy.isShared).toBe(false);
    expect(await availableCopyName("reports-saved-b", template.name)).toBe("نسخة من مرضى اليوم — قالب (2)");

    // المالك يحدّث القالب بعرضٍ جديد ويلغي المشاركة.
    const updated = await updateSavedReport({
      ownerUsername: "reports-saved-a",
      id: template.id,
      isShared: false,
      view: { reportId: "visits", sectionId: "operational", queryString: "report=visits&preset=this_week&group=doctorName" },
    });
    expect(updated?.queryString).toContain("group=doctorName");
    expect(await getVisibleSavedReport("reports-saved-b", template.id)).toBeNull();

    await deleteSavedReport("reports-saved-b", copy.id);
    await deleteSavedReport("reports-saved-a", template.id);
  });

  it("rejects a duplicate name for the same owner in Arabic", async () => {
    const first = await createSavedReport({
      ownerUsername: "reports-saved-a", name: "مكرر", reportId: "visits", sectionId: "operational",
      queryString: "report=visits&preset=today",
    });
    await expect(createSavedReport({
      ownerUsername: "reports-saved-a", name: "مكرر", reportId: "visits", sectionId: "operational",
      queryString: "report=visits&preset=today",
    })).rejects.toThrow("لديك تقرير محفوظ بهذا الاسم.");
    await deleteSavedReport("reports-saved-a", first.id);
  });
});
