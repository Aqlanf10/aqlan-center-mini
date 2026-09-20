import { describe, expect, it } from "vitest";
import { restoreDrillAvailability } from "../lib/restore/admin";

const staging = "postgres://restore_user:secret@restore.internal:5432/restore_drill";
const production = "postgres://prod_user:secret@prod.internal:5432/clinic";

describe("بوابة Restore Drill الإدارية", () => {
  it("تفشل مغلقًا إذا لم يوجد هدف معزول", () => {
    expect(restoreDrillAvailability({ DATABASE_URL: production }).reason).toBe("missing-target");
  });

  it("ترفض أي تصنيف غير staging/test", () => {
    const result = restoreDrillAvailability({
      DATABASE_URL: production,
      RESTORE_DRILL_DATABASE_URL: staging,
      RESTORE_DRILL_DATABASE_ENVIRONMENT: "production",
      RESTORE_DRILL_DEDICATED_TARGET: "true",
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe("unsafe-classification");
  });

  it("ترفض الهدف إذا كان هو Production نفسه مهما سُمّي staging", () => {
    const result = restoreDrillAvailability({
      DATABASE_URL: production,
      RESTORE_DRILL_DATABASE_URL: production,
      RESTORE_DRILL_DATABASE_ENVIRONMENT: "staging",
      RESTORE_DRILL_DEDICATED_TARGET: "true",
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe("production-collision");
  });

  it("تقبل قاعدة مستقلة مخصصة ومصنفة staging", () => {
    const result = restoreDrillAvailability({
      DATABASE_URL: production,
      RESTORE_DRILL_DATABASE_URL: staging,
      RESTORE_DRILL_DATABASE_ENVIRONMENT: "staging",
      RESTORE_DRILL_DEDICATED_TARGET: "true",
    });
    expect(result).toEqual({ available: true, targetEnvironment: "staging", reason: null });
  });
});
