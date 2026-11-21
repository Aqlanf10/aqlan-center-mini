import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { tarEnd, tarHeader, tarPadding } from "../lib/tar";
import {
  sealSyntheticApplicationArchive, verifySyntheticApplicationArchive,
} from "../scripts/review/patient-numbering-application-archive";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const held = {
  binding: "12345679000000000000:8192", prefix: "ABCDEF", revision: "3",
  lastValue: "9007199254740993", isCalled: false, syntheticNumberMapSha256: "a".repeat(64),
};

function appArchive(when = "2026-11-21T01:00:00.000Z") {
  const sql = Buffer.from("BEGIN;\n-- ordinary existing writer format\nCOMMIT;\n");
  const manifest = Buffer.from(JSON.stringify({
    format: "aqlan-full-backup", version: 1, createdAt: when, databaseSha256: sha(sql), documents: [],
  }));
  const date = new Date(when);
  return gzipSync(Buffer.concat([
    tarHeader("database.sql", sql.length, date), sql, tarPadding(sql.length),
    tarHeader("manifest.json", manifest.length, date), manifest, tarPadding(manifest.length), tarEnd(),
  ]));
}

describe("detached verification for a synthetic application archive", () => {
  it("leaves a valid archive without numbering evidence available as legacy data only", () => {
    expect(verifySyntheticApplicationArchive(appArchive())).toEqual({ kind: "legacy-data-only", management: "held" });
    expect(verifySyntheticApplicationArchive(Buffer.from("not a supported archive")))
      .toEqual({ kind: "refused", reason: "archive-invalid" });
  });

  it("preserves an exact decimal string above JS integer precision without granting management", () => {
    for (const isCalled of [true, false]) {
      const archive = appArchive();
      const checkpoint = { ...held, isCalled };
      const evidence = sealSyntheticApplicationArchive(archive, checkpoint, checkpoint)!;
      expect(verifySyntheticApplicationArchive(archive, {
        bytes: evidence.bytes, expectedSidecarSha256: evidence.sha256,
      })).toEqual({ kind: "recovery-candidate", management: "held", witness: checkpoint });
    }
  });

  it("refuses sidecar swaps and never downgrades invalid present evidence", () => {
    const original = appArchive();
    const other = appArchive("2026-11-21T02:00:00.000Z"); // same SQL; different exact app archive
    const evidence = sealSyntheticApplicationArchive(original, held, held)!;
    for (const [archive, hash] of [[other, evidence.sha256], [original, "0".repeat(64)]] as const) {
      expect(verifySyntheticApplicationArchive(archive, { bytes: evidence.bytes, expectedSidecarSha256: hash }))
        .toEqual({ kind: "refused", reason: "numbering-evidence-invalid" });
    }
  });

  it("refuses changed or malformed held state instead of inventing a counter", () => {
    const archive = appArchive();
    for (const changed of [
      { ...held, isCalled: true }, { ...held, revision: "4" }, { ...held, lastValue: Number(held.lastValue) },
      { ...held, lastValue: "9223372036854775808" }, { ...held, syntheticNumberMapSha256: "" },
      { ...held, prefix: "A-1" }, { ...held, origin: "unknown" },
    ]) expect(sealSyntheticApplicationArchive(archive, held, changed)).toBeNull();
  });

  it("rejects wrong format and duplicate/unknown JSON keys even if the checksum matches", () => {
    const archive = appArchive();
    const evidence = sealSyntheticApplicationArchive(archive, held, held)!;
    const good = evidence.bytes.toString("utf8");
    for (const candidate of [
      good.replace('"version":1', '"version":2'), good.replace('"version":1', '"version":1,"version":1'),
      good.replace('"version":1', '"version":1,"extra":true'), "{".repeat(1025),
    ]) {
      const bytes = Buffer.from(candidate);
      expect(verifySyntheticApplicationArchive(archive, { bytes, expectedSidecarSha256: sha(bytes) }))
        .toEqual({ kind: "refused", reason: "numbering-evidence-invalid" });
    }
  });
});
