import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const faults = vi.hoisted(() => ({ phase: "", fired: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      if (faults.phase === "link") { faults.fired = true; throw new Error("private path must not escape"); }
      return actual.link(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      const temporary = String(args[0]).includes(".export-");
      const finalRead = String(args[0]).endsWith(".pptx") && (Number(args[1]) & constants.O_RDWR) === 0;
      return new Proxy(file, { get(target, property) {
        if (temporary && ((faults.phase === "write" && property === "writeFile") || (faults.phase === "sync" && property === "sync"))) {
          return async () => { faults.fired = true; throw new Error("private storage fault"); };
        }
        if (!temporary && faults.phase === "directory-sync" && property === "sync" && String(args[0]).split("/").at(-1) === reference().sha256.slice(2, 4)) {
          return async () => { faults.fired = true; throw new Error("private directory sync fault"); };
        }
        if (finalRead && property === "stat" && faults.phase === "growth" && !faults.fired) {
          return async () => { const info = await target.stat(); faults.fired = true; await actual.appendFile(args[0], "growth"); return info; };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }});
    },
  };
});
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { storeStudyExportArtifact, readStudyExportArtifactBytes, MAX_STUDY_EXPORT_ARTIFACT_BYTES } from "../lib/ortho-study-export-artifact-storage";
import { storageKey } from "../lib/storage";
import { putImmutableFile, readImmutableFileByKey } from "../lib/files";

let root = "";
const synthetic = Buffer.from("PK synthetic server-rendered archive bytes");
const reference = (bytes = synthetic) => {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { sha256, storageKey: storageKey(sha256, "pptx"), sizeBytes: bytes.length };
};
async function seed(bytes: Buffer, expected = reference()) {
  const target = join(root, expected.storageKey);
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); return target;
}
async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => entry.isDirectory() ? filesBelow(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}
beforeEach(async () => {
  // An absolute workspace directory exercises the real development durability
  // policy; /tmp deliberately fails that policy. All bytes here are synthetic.
  root = await mkdtemp(join(process.cwd(), ".synthetic-export-storage-"));
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("DOCUMENTS_DIR", root);
  faults.phase = ""; faults.fired = false;
});
afterEach(async () => { faults.phase = ""; await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe("immutable study export bytes", () => {
  it("publishes and verifies bytes; concurrent identical writes do not replace the final file", async () => {
    const refs = await Promise.all(Array.from({ length: 12 }, () => storeStudyExportArtifact(synthetic)));
    expect(refs.every(value => JSON.stringify(value) === JSON.stringify(refs[0]))).toBe(true);
    expect(refs[0]).toEqual(reference());
    expect(await readStudyExportArtifactBytes(refs[0])).toEqual(synthetic);
    const files = await filesBelow(root);
    expect(files.filter(path => path.endsWith(".pptx"))).toHaveLength(1);
    expect(files.some(path => path.includes(".export-"))).toBe(false);
  });
  it("different bytes have distinct keys and input mutation after call cannot alter the snapshot", async () => {
    const input = Buffer.from(synthetic); const pending = storeStudyExportArtifact(input); input.fill(65);
    const stored = await pending;
    const other = await storeStudyExportArtifact(input);
    expect(stored).toEqual(reference()); expect(other.storageKey).not.toBe(stored.storageKey);
    expect(await readStudyExportArtifactBytes(stored)).toEqual(synthetic);
  });
  it("rejects corrupt same-size dedup without overwriting or deleting the existing file", async () => {
    const corrupt = Buffer.alloc(synthetic.length, 66); const target = await seed(corrupt);
    await expect(storeStudyExportArtifact(synthetic)).rejects.toThrow(/^STUDY_EXPORT_ARTIFACT_WRITE_FAILED$/);
    expect(await readFile(target)).toEqual(corrupt);
    await expect(readStudyExportArtifactBytes(reference())).rejects.toThrow(/^STUDY_EXPORT_ARTIFACT_READ_FAILED$/);
    expect((await filesBelow(root)).some(path => path.includes(".export-"))).toBe(false);
  });
  it("rejects truncated and oversized bytes against recorded metadata", async () => {
    const stored = await storeStudyExportArtifact(synthetic);
    await truncate(join(root, stored.storageKey), synthetic.length - 1);
    await expect(readStudyExportArtifactBytes(stored)).rejects.toThrow("STUDY_EXPORT_ARTIFACT_READ_FAILED");
    await writeFile(join(root, stored.storageKey), Buffer.concat([synthetic, Buffer.from("extra")]));
    await expect(readStudyExportArtifactBytes(stored)).rejects.toThrow("STUDY_EXPORT_ARTIFACT_READ_FAILED");
  });
  it("detects file growth after fstat instead of accepting a prefix", async () => {
    const stored = await storeStudyExportArtifact(synthetic); faults.phase = "growth";
    await expect(readStudyExportArtifactBytes(stored)).rejects.toThrow("STUDY_EXPORT_ARTIFACT_READ_FAILED");
    expect(faults.fired).toBe(true);
  });
  it.each(["write", "sync", "link"])("fails closed and cleans only its own temporary on %s failure", async phase => {
    // Precreate safe shards so this tests the intended publication failure.
    await mkdir(dirname(join(root, reference().storageKey)), { recursive: true });
    faults.phase = phase;
    await expect(storeStudyExportArtifact(synthetic)).rejects.toThrow(/^STUDY_EXPORT_ARTIFACT_WRITE_FAILED$/);
    expect(faults.fired).toBe(true);
    expect((await filesBelow(root)).filter(path => path.endsWith(".pptx") || path.includes(".export-"))).toEqual([]);
  });
  it("keeps a valid final file if directory fsync fails after publication", async () => {
    await mkdir(dirname(join(root, reference().storageKey)), { recursive: true });
    faults.phase = "directory-sync";
    await expect(storeStudyExportArtifact(synthetic)).rejects.toThrow("STUDY_EXPORT_ARTIFACT_WRITE_FAILED");
    expect(faults.fired).toBe(true); faults.phase = "";
    expect(await readFile(join(root, reference().storageKey))).toEqual(synthetic);
    expect(await storeStudyExportArtifact(synthetic)).toEqual(reference());
  });
  it("rejects symlink leaves and shard directories without touching their targets", async () => {
    const outside = join(root, "synthetic-target"); await writeFile(outside, synthetic);
    const path = join(root, reference().storageKey); await mkdir(dirname(path), { recursive: true }); await symlink(outside, path);
    await expect(storeStudyExportArtifact(synthetic)).rejects.toThrow("STUDY_EXPORT_ARTIFACT_WRITE_FAILED");
    await expect(readStudyExportArtifactBytes(reference())).rejects.toThrow("STUDY_EXPORT_ARTIFACT_READ_FAILED");
    expect(await readFile(outside)).toEqual(synthetic);
    await rm(join(root, reference().sha256.slice(0, 2)), { recursive: true });
    const outsideDir = join(root, "synthetic-outside-directory"); await mkdir(outsideDir);
    await symlink(outsideDir, join(root, reference().sha256.slice(0, 2)));
    await expect(storeStudyExportArtifact(synthetic)).rejects.toThrow("STUDY_EXPORT_ARTIFACT_WRITE_FAILED");
    await expect(readStudyExportArtifactBytes(reference())).rejects.toThrow("STUDY_EXPORT_ARTIFACT_READ_FAILED");
    expect(await readdir(outsideDir)).toEqual([]);
  });
  it("rejects a symlink storage root before running a write probe", async () => {
    const target = join(root, "target"); const alias = join(root, "alias"); await mkdir(target); await symlink(target, alias);
    vi.stubEnv("DOCUMENTS_DIR", alias);
    await expect(storeStudyExportArtifact(synthetic)).rejects.toThrow("STUDY_EXPORT_STORAGE_UNAVAILABLE");
    await expect(readStudyExportArtifactBytes(reference())).rejects.toThrow("STUDY_EXPORT_STORAGE_UNAVAILABLE");
    expect(await readdir(target)).toEqual([]);
  });
  it("rejects nonregular final paths and unsafe or mismatched references", async () => {
    await mkdir(join(root, reference().storageKey), { recursive: true });
    await expect(storeStudyExportArtifact(synthetic)).rejects.toThrow("STUDY_EXPORT_ARTIFACT_WRITE_FAILED");
    await expect(readStudyExportArtifactBytes(reference())).rejects.toThrow("STUDY_EXPORT_ARTIFACT_READ_FAILED");
    for (const patch of [{ storageKey: "../secret" }, { sha256: "a".repeat(64) }, { sizeBytes: 0 }, { sizeBytes: MAX_STUDY_EXPORT_ARTIFACT_BYTES + 1 }]) {
      await expect(readStudyExportArtifactBytes({ ...reference(), ...patch })).rejects.toThrow("STUDY_EXPORT_ARTIFACT_INVALID");
    }
    await expect(readImmutableFileByKey("../secret", reference().sha256, 10)).rejects.toThrow("IMMUTABLE_FILE_INVALID");
  });
  it("enforces artifact and generic file limits before allocating or writing", async () => {
    await expect(storeStudyExportArtifact(new Uint8Array())).rejects.toThrow("STUDY_EXPORT_ARTIFACT_INVALID");
    await expect(storeStudyExportArtifact(new Uint8Array(MAX_STUDY_EXPORT_ARTIFACT_BYTES + 1))).rejects.toThrow("STUDY_EXPORT_ARTIFACT_INVALID");
    await expect(putImmutableFile(new Uint8Array(25 * 1024 * 1024 + 1), "pptx")).rejects.toThrow("IMMUTABLE_FILE_INVALID");
    expect(await readdir(root)).toEqual([]);
  });
  it("accepts exactly the maximum artifact length and verifies it on retrieval", async () => {
    const bytes = Buffer.alloc(MAX_STUDY_EXPORT_ARTIFACT_BYTES, 83);
    const stored = await storeStudyExportArtifact(bytes);
    expect(stored.sizeBytes).toBe(MAX_STUDY_EXPORT_ARTIFACT_BYTES);
    const read = await readStudyExportArtifactBytes(stored);
    expect(read.byteLength).toBe(bytes.byteLength);
    expect(createHash("sha256").update(read).digest("hex")).toBe(stored.sha256);
  });
  it("requires real configured writable durable storage for both writing and reading", async () => {
    const missing = join(root, "unprovisioned", "archive"); vi.stubEnv("DOCUMENTS_DIR", missing);
    await expect(storeStudyExportArtifact(synthetic)).rejects.toThrow("STUDY_EXPORT_STORAGE_UNAVAILABLE");
    expect(await readdir(root)).toEqual([]);
    vi.stubEnv("DOCUMENTS_DIR", "");
    await expect(storeStudyExportArtifact(synthetic)).rejects.toThrow("STUDY_EXPORT_STORAGE_UNAVAILABLE");
    await expect(readStudyExportArtifactBytes(reference())).rejects.toThrow("STUDY_EXPORT_STORAGE_UNAVAILABLE");
    vi.stubEnv("DOCUMENTS_DIR", "/tmp/synthetic-archive-unavailable");
    await expect(storeStudyExportArtifact(synthetic)).rejects.toThrow("STUDY_EXPORT_STORAGE_UNAVAILABLE");
    const notDirectory = join(root, "not-directory"); await writeFile(notDirectory, "x"); vi.stubEnv("DOCUMENTS_DIR", notDirectory);
    await expect(storeStudyExportArtifact(synthetic)).rejects.toThrow("STUDY_EXPORT_STORAGE_UNAVAILABLE");
  });
});
