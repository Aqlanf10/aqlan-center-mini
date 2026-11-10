import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { stagedRestore } from "../lib/restore/staging";
import { documentEntryName } from "../lib/restore/archive";

const state = vi.hoisted(() => ({ calls: [] as string[], rows: [] as { storage_key: string; sha256: string; size_bytes: number }[],
  archive: { entries: new Map(), order: [] as string[], truncated: false }, files: new Map<string, Uint8Array>(), mkdir: vi.fn(), write: vi.fn(), end: vi.fn() }));
vi.mock("node:fs/promises", () => ({ mkdir: state.mkdir, writeFile: async (path: string, bytes: Uint8Array) => { state.write(path, bytes); state.files.set(path, bytes); }, readFile: async (path: string) => state.files.get(path), rm: vi.fn() }));
vi.mock("pg", () => ({ Client: class {
  async connect() {}
  async end() { state.end(); }
  async query(sql: string) {
    state.calls.push(sql);
    if (sql.includes("information_schema.tables")) return { rows: [{ tables: 0 }] };
    if (sql.includes("FROM ortho_study_export_artifacts")) return { rows: state.rows };
    return { rows: [] };
  }
} }));
vi.mock("../lib/migrations", () => ({ loadMigrationFiles: async () => [], migrate: async () => ({ appliedVersions: [] }), migrationStatus: async () => ({ probe: { ok: true, missing: [] }, consistent: true }) }));
vi.mock("../lib/restore/client-config", () => ({ restoreClientConfigFor: () => ({}) }));
vi.mock("../lib/restore/archive", async importOriginal => ({ ...await importOriginal<typeof import("../lib/restore/archive")>(), readTarGzEntries: async () => state.archive }));
vi.mock("../lib/restore/sql.mjs", () => ({ prepareBackupSql: () => ({ dataSql: "SELECT 'synthetic replay';", skippedMigrationRecordLines: 0, sqlRowsStatementLines: 1 }) }));
vi.mock("../lib/files", () => ({ putFile: vi.fn(), readFileByKey: vi.fn() }));
const bytes = Buffer.from("Synthetic archived study; no patient data");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const storage_key = `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.pptx`;
const options = { archivePath: "synthetic.tar.gz", targetUrl: "postgres://synthetic@localhost/synthetic", stagingDir: "/synthetic/staging" };
function archive(include: boolean, content = bytes) {
  const sql = Buffer.from("BEGIN;\n-- Synthetic SQL artifact reference retained\nCOMMIT;\n");
  const entries = [{ name: "database.sql", data: sql }];
  if (include) entries.push({ name: documentEntryName(storage_key), data: content });
  entries.push({ name: "manifest.json", data: Buffer.from(JSON.stringify({ format: "aqlan-full-backup", version: 1, createdAt: "2026-11-10T00:00:00.000Z", databaseSha256: createHash("sha256").update(sql).digest("hex"), documents: include ? [{ id: 0, storageKey: storage_key, sha256: createHash("sha256").update(content).digest("hex"), sizeBytes: content.length, title: "Synthetic", patientId: 0 }] : [] })) });
  state.archive = { entries: new Map(entries.map((entry, order) => [entry.name, { ...entry, order }])), order: entries.map(entry => entry.name), truncated: false };
}
beforeEach(() => { state.calls.length = 0; state.rows = [{ storage_key, sha256, size_bytes: bytes.length }]; state.files.clear(); vi.clearAllMocks(); archive(true); });
it("rejects missing archived study bytes even when their manifest entry was removed too", async () => {
  archive(false);
  const result = await stagedRestore(options);
  expect(result.validationErrors).toEqual([]); // The archive is self-consistent; SQL reference is the authority.
  expect(result.readyForCutover).toBe(false);
  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toContain("دراسة التقويم");
  expect(state.calls).toContain("ROLLBACK");
  expect(state.calls).not.toContain("COMMIT");
  expect(state.mkdir).not.toHaveBeenCalled(); expect(state.write).not.toHaveBeenCalled();
});
it("rejects internally consistent replacement bytes and manifest that disagree with restored artifact metadata", async () => {
  archive(true, Buffer.from("Different synthetic archive bytes"));
  const result = await stagedRestore(options);
  expect(result.validationErrors).toEqual([]);
  expect(result.readyForCutover).toBe(false);
  expect(result.errors.join(" ")).toContain("دراسة التقويم");
  expect(state.calls).toContain("ROLLBACK"); expect(state.calls).not.toContain("COMMIT");
  expect(state.write).not.toHaveBeenCalled();
});
it("accepts a verified artifact shared by multiple restored archive rows", async () => {
  state.rows.push({ ...state.rows[0] });
  const result = await stagedRestore(options);
  expect(result).toMatchObject({ ok: true, readyForCutover: true, documentsVerified: 1 });
  expect(state.calls).toContain("COMMIT"); expect(state.write).toHaveBeenCalledOnce();
});
it("keeps legacy backups without archive artifact rows compatible", async () => {
  state.rows = []; archive(false);
  expect(await stagedRestore(options)).toMatchObject({ ok: true, readyForCutover: true, documentsVerified: 0 });
});
