import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { backupStateDir } from "../lib/backupVolume";
import { readRestoreDrillState, RESTORE_DRILL_STATE_FILE } from "../lib/restore/admin";
import { numberingCutoverHold, numberingCutoverMessage } from "../lib/restore/cutover-readiness";

it.each([
  ["not-recorded", "numbering-history-not-recorded"],
  ["reconciled", "numbering-freshness-unverified"],
  [undefined, "numbering-evidence-unverified"],
  ["future-unknown", "numbering-evidence-unverified"],
])("never approves cutover from %s evidence", (evidence, cutoverBlocker) => {
  expect(numberingCutoverHold(evidence)).toMatchObject({ readyForCutover: false, cutoverBlocker });
  expect(numberingCutoverMessage(cutoverBlocker)).toContain("التحويل غير جاهز");
});

it("pessimistically normalizes a prior ready history without discarding verified drill counts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synthetic-restore-history-"));
  try {
    const stateDir = backupStateDir(dir);
    await mkdir(stateDir, { recursive: true });
    const file = join(stateDir, RESTORE_DRILL_STATE_FILE);
    const baseline = { backupId: "synthetic", readyForCutover: true, status: "ready", documentsVerified: 2, tablesCount: 42 };
    await writeFile(file, JSON.stringify(baseline));
    expect(await readRestoreDrillState(dir)).toMatchObject({
      ...baseline, status: "restored", readyForCutover: false,
      patientNumberSequence: "unverified", cutoverBlocker: "numbering-evidence-unverified",
    });
    // Do not trust a persisted ready bit or old/unknown blocker on newer records either.
    await writeFile(file, JSON.stringify({
      ...baseline, status: "restored", patientNumberSequence: "reconciled", cutoverBlocker: null,
    }));
    expect(await readRestoreDrillState(dir)).toMatchObject({
      status: "restored", readyForCutover: false,
      patientNumberSequence: "reconciled", cutoverBlocker: "numbering-freshness-unverified",
    });
    await writeFile(file, JSON.stringify({ ...baseline, status: "failed", patientNumberSequence: "reconciled" }));
    expect(await readRestoreDrillState(dir)).toMatchObject({
      status: "failed", readyForCutover: false, patientNumberSequence: "unverified", cutoverBlocker: null,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
