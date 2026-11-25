import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { backupStateDir } from "../lib/backupVolume";
import { readRestoreDrillState, RESTORE_DRILL_STATE_FILE, restoreDrillAvailability } from "../lib/restore/admin";

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


it("holds previously recorded ready drills until the last issued number has independent proof", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "synthetic-numbering-drill-state-"));
  try {
    await mkdir(backupStateDir(directory), { recursive: true });
    await writeFile(path.join(backupStateDir(directory), RESTORE_DRILL_STATE_FILE), JSON.stringify({
      status: "ready", readyForCutover: true, backupId: "synthetic-previous-drill",
    }));
    expect(await readRestoreDrillState(directory)).toMatchObject({
      backupId: "synthetic-previous-drill", status: "restored", readyForCutover: false, cutoverBlocker: "numbering-freshness-unverified",
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
