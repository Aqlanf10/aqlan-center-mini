import { access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { fullBackupBlocks } from "../lib/fullBackup";
import { parseTarBytes } from "../lib/restore/archive";
import { validateBackupArchive, type ValidatedDocument } from "../lib/restore/validate";
import { loginPhotoRestoreProblem } from "../lib/restore/login-photo";

const mocks = vi.hoisted(() => ({ source: null as unknown, ensure: vi.fn(), release: vi.fn(), stages: [] as string[] }));
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, mkdtemp: async (...args: Parameters<typeof original.mkdtemp>) => {
    const stage = await original.mkdtemp(...args);
    mocks.stages.push(String(stage));
    return stage;
  } };
});
vi.mock("../lib/db", () => ({
  ensureSchema: mocks.ensure,
  getPool: () => ({ connect: async () => ({ ...(mocks.source as object), release: mocks.release }) }),
  backupSnapshotSqlLines: async function* () { yield "BEGIN;\nCOMMIT;\n"; },
}));

// Synthetic 1x1 PNG, no owner photo, EXIF, patient, or personal information.
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const key = `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.loginpng`;
const asset = { key, sha256, mimeType: "image/png", sizeBytes: bytes.length, width: 1, height: 1 };
const raw = JSON.stringify(asset);
const file = (): ValidatedDocument => ({
  relativePath: key, sha256, bytes,
  manifest: { id: 0, storageKey: key, sha256, sizeBytes: bytes.length, title: "", patientId: 0 },
});

function sourceFor(value?: string) {
  const calls: string[] = [];
  const source = { query: async (sql: string, values?: unknown[]) => {
    calls.push(sql);
    if (sql.startsWith("SELECT to_regclass")) return { rows: [{ present: true }] };
    if (sql.startsWith("SELECT 'doc-'")) return { rows: [] };
    if (sql === "SELECT value FROM settings WHERE key = $1") {
      expect(values).toEqual(["clinic.login_photo_asset"]);
      // No visibility predicate: an approved-but-hidden photo must survive.
      return { rows: value === undefined ? [] : [{ value }] };
    }
    if (["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  return { source, calls };
}
async function archive(value?: string, useDefault = false, readBytes: Buffer | null = bytes) {
  const { source, calls } = sourceFor(value);
  mocks.source = source;
  const blocks: Uint8Array[] = [];
  for await (const block of fullBackupBlocks({
    ...(useDefault ? {} : { source }),
    readDocument: async requested => { expect(requested).toBe(key); return readBytes; },
  })) blocks.push(block);
  return { parsed: parseTarBytes(Buffer.concat(blocks.map(b => Buffer.from(b)))), calls };
}

describe("configured login photo full backup preservation", () => {
  it.each([false, true])("includes the hidden configured photo in the SQL snapshot and manifest (default=%s)", async useDefault => {
    mocks.ensure.mockClear(); mocks.release.mockClear();
    const { parsed, calls } = await archive(raw, useDefault);
    const result = validateBackupArchive(parsed);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected valid synthetic archive");
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].relativePath).toBe(key);
    expect(loginPhotoRestoreProblem(raw, result.documents)).toBeNull();
    expect(calls[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(calls.indexOf("SELECT value FROM settings WHERE key = $1")).toBeLessThan(calls.indexOf("COMMIT"));
    expect(mocks.ensure).toHaveBeenCalledTimes(useDefault ? 1 : 0);
    expect(mocks.release).toHaveBeenCalledTimes(useDefault ? 1 : 0);
  });
  it.each([undefined, ""])("preserves old backups without configured photo (%s)", async value => {
    const { parsed } = await archive(value);
    const result = validateBackupArchive(parsed);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.documents).toHaveLength(0);
  });
  it.each(["{bad", JSON.stringify({ ...asset, key: key.replace(".loginpng", ".png") }), JSON.stringify({ ...asset, key: "../../patient.png" })])("fails closed on invalid configured metadata", async value => {
    await expect(archive(value)).rejects.toThrow(/Invalid configured login photo/);
  });
  it("rolls back and releases the default client and removes staging on invalid metadata", async () => {
    const { source, calls } = sourceFor("{bad");
    mocks.source = source; mocks.release.mockClear();
    await expect((async () => {
      for await (const _block of fullBackupBlocks()) { /* consume */ }
    })()).rejects.toThrow(/Invalid configured login photo/);
    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
    expect(mocks.release).toHaveBeenCalledTimes(1);
    await expect(access(mocks.stages.at(-1)!)).rejects.toThrow();
  });
  it("releases before streaming, cleans partial output on failure, and never emits its final manifest", async () => {
    const { source, calls } = sourceFor(raw);
    mocks.source = source; mocks.release.mockClear();
    const blocks: Uint8Array[] = [];
    await expect((async () => {
      for await (const block of fullBackupBlocks({ readDocument: async () => {
        expect(calls).toContain("COMMIT");
        expect(mocks.release).toHaveBeenCalledTimes(1);
        throw new Error("synthetic disk failure");
      } })) blocks.push(block);
    })()).rejects.toThrow("synthetic disk failure");
    expect(Buffer.concat(blocks).includes(Buffer.from("manifest.json"))).toBe(false);
    await expect(access(mocks.stages.at(-1)!)).rejects.toThrow();
  });
  it("refuses a missing or corrupted configured asset instead of emitting a complete manifest", async () => {
    await expect(archive(raw, false, null)).rejects.toThrow(/missing or corrupt/);
    await expect(archive(raw, false, Buffer.alloc(bytes.length))).rejects.toThrow(/missing or corrupt/);
  });
});

describe("restored login photo activation guard", () => {
  it("accepts legacy absent settings and validates the exact configured reserved asset", () => {
    expect(loginPhotoRestoreProblem("", [])).toBeNull();
    expect(loginPhotoRestoreProblem(raw, [file()])).toBeNull();
  });
  it("rejects foreign patient file keys even if a valid matching file exists in the archive", () => {
    const foreignKey = key.replace(".loginpng", ".png");
    const foreign = file(); foreign.relativePath = foreignKey; foreign.manifest.storageKey = foreignKey;
    expect(loginPhotoRestoreProblem(JSON.stringify({ ...asset, key: foreignKey }), [foreign])).not.toBeNull();
  });
  it("rejects missing/duplicate manifest membership", () => {
    expect(loginPhotoRestoreProblem(raw, [])).not.toBeNull();
    expect(loginPhotoRestoreProblem(raw, [file(), file()])).not.toBeNull();
  });
  it("rejects invalid image bytes even when metadata and manifest hashes are internally consistent", () => {
    const badBytes = Buffer.concat([bytes, Buffer.from("trailing synthetic content")]);
    const badSha = createHash("sha256").update(badBytes).digest("hex");
    const badKey = `${badSha.slice(0, 2)}/${badSha.slice(2, 4)}/${badSha}.loginpng`;
    const badAsset = { ...asset, key: badKey, sha256: badSha, sizeBytes: badBytes.length };
    const badFile: ValidatedDocument = {
      bytes: badBytes, relativePath: badKey, sha256: badSha,
      manifest: { ...file().manifest, storageKey: badKey, sha256: badSha, sizeBytes: badBytes.length },
    };
    expect(loginPhotoRestoreProblem(JSON.stringify(badAsset), [badFile])).not.toBeNull();
  });
  it("rejects hash, byte size, content and dimension mismatch", () => {
    const hashMismatch = file(); hashMismatch.manifest.sha256 = "f".repeat(64);
    const sizeMismatch = file(); sizeMismatch.manifest.sizeBytes++;
    const corrupt = file(); corrupt.bytes = Buffer.alloc(bytes.length);
    expect(loginPhotoRestoreProblem(raw, [hashMismatch])).not.toBeNull();
    expect(loginPhotoRestoreProblem(raw, [sizeMismatch])).not.toBeNull();
    expect(loginPhotoRestoreProblem(raw, [corrupt])).not.toBeNull();
    expect(loginPhotoRestoreProblem(JSON.stringify({ ...asset, width: 2 }), [file()])).not.toBeNull();
  });
});
