import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { drillReportText, runOffsiteRestoreDrill } from "../lib/backup-offsite-drill";
import { sha256Hex, type S3Client } from "../lib/s3-client";
import { PATIENT_NUMBER_CUTOVER_HOLD_TEXT } from "../lib/restore/readiness-hold";

const { staged } = vi.hoisted(() => ({ staged: vi.fn() }));
vi.mock("../lib/restore/staging", () => ({ stagedRestore: staged }));
vi.mock("../lib/backupEncryption", () => ({
  decryptArchiveBuffer: () => Buffer.from("synthetic payload, not an archive"),
  encryptionKeyFingerprint: () => "synthetic-fingerprint",
}));

const body = Buffer.from("synthetic transport bytes");
const client = {
  headObject: async () => ({ metadata: {
    "encrypted-sha256": sha256Hex(body),
    "archive-sha256": sha256Hex(Buffer.from("synthetic payload, not an archive")),
    "key-fingerprint": "synthetic-fingerprint",
  } }),
  getObject: async () => body,
} as unknown as S3Client;

let stagingDir: string;
beforeAll(async () => { stagingDir = await mkdtemp(path.join(tmpdir(), "synthetic-offsite-report-")); });
afterAll(async () => { await rm(stagingDir, { recursive: true, force: true }); });
function run(witness = "synthetic witness") {
  return runOffsiteRestoreDrill({ client, stagingDir, env: {}, keyHex: "unused", targetUrl: "unused",
    witness, operator: "synthetic operator", objectKey: "fixture.enc" });
}
const verified = {
  ok: true, validationErrors: [], errors: [], documentsRestored: 1, documentsVerified: 1,
  verification: { tablesCount: 3, criticalProbeOk: true, migrationConsistent: true },
  readyForCutover: false, cutoverBlocker: "patient-number-freshness-unverified",
};

it.each([
  ["current staged result", verified],
  ["unexpected upstream claims", { ...verified, readyForCutover: true, cutoverBlocker: "UNTRUSTED_DETAIL" }],
])("reports only isolated success with a bounded hold: %s", async (_name, result) => {
  staged.mockResolvedValueOnce(result);
  const report = await run();
  const json = JSON.stringify(report);
  expect(JSON.parse(json)).toMatchObject({ ok: true, readyForCutover: false,
    cutoverBlocker: "patient-number-freshness-unverified", restore: { documentsVerified: 1 }, errors: [] });
  const text = drillReportText(report);
  expect(text).toContain("نجحت ✔");
  expect(text).toContain(PATIENT_NUMBER_CUTOVER_HOLD_TEXT);
  expect(json + text).not.toContain("UNTRUSTED_DETAIL");
});

it("does not describe a skipped or failed restore as verified", async () => {
  const skipped = await run(" ");
  expect(skipped.restore).toBeNull();
  staged.mockResolvedValueOnce({ ...verified, ok: false, errors: ["synthetic failure"] });
  const failed = await run();
  expect(failed.restore).not.toBeNull();
  for (const report of [skipped, failed]) {
    expect(JSON.parse(JSON.stringify(report))).toMatchObject({ ok: false, readyForCutover: false, cutoverBlocker: null });
    expect(drillReportText(report)).toContain("لم تنجح");
    expect(drillReportText(report)).not.toContain(PATIENT_NUMBER_CUTOVER_HOLD_TEXT);
  }
});
