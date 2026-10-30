import { beforeEach, expect, it, vi } from "vitest";
import { stagedRestore } from "../lib/restore/staging";

const state = vi.hoisted(() => ({ raw: "", calls: [] as string[], mkdir: vi.fn(), write: vi.fn(), end: vi.fn() }));
vi.mock("node:fs/promises", () => ({ mkdir: state.mkdir, writeFile: state.write, readFile: vi.fn(), rm: vi.fn() }));
vi.mock("pg", () => ({ Client: class {
  async connect() {}
  async end() { state.end(); }
  async query(sql: string) {
    state.calls.push(sql);
    if (sql.includes("information_schema.tables")) return { rows: [{ tables: 0 }] };
    if (sql === "SELECT value FROM settings WHERE key = $1") return { rows: state.raw ? [{ value: state.raw }] : [] };
    return { rows: [] };
  }
} }));
vi.mock("../lib/migrations", () => ({
  loadMigrationFiles: async () => [], migrate: async () => ({ appliedVersions: [] }),
  migrationStatus: async () => ({ probe: { ok: true, missing: [] }, consistent: true }),
}));
vi.mock("../lib/restore/client-config", () => ({ restoreClientConfigFor: () => ({}) }));
vi.mock("../lib/restore/archive", () => ({ readTarGzEntries: async () => ({}) }));
vi.mock("../lib/restore/validate", () => ({ validateBackupArchive: () => ({ ok: true, sql: Buffer.from("SELECT 1;"), documents: [] }) }));
vi.mock("../lib/restore/sql.mjs", () => ({ prepareBackupSql: () => ({ dataSql: "SELECT 1;", skippedMigrationRecordLines: 0, sqlRowsStatementLines: 1 }) }));
vi.mock("../lib/files", () => ({ putFile: vi.fn(), readFileByKey: vi.fn() }));

beforeEach(() => { state.raw = ""; state.calls.length = 0; vi.clearAllMocks(); });
const options = { archivePath: "synthetic.tar.gz", targetUrl: "postgres://synthetic@localhost/synthetic", stagingDir: "/synthetic/staging" };
it("rejects restored photo metadata before commit or any staged filesystem writes", async () => {
  state.raw = JSON.stringify({ key: "foreign-patient.png" });
  const result = await stagedRestore(options);
  expect(result.ok).toBe(false);
  expect(result.readyForCutover).toBe(false);
  expect(result.errors.join(" ")).toContain("صورة الدخول");
  expect(state.calls).toContain("BEGIN");
  expect(state.calls).toContain("ROLLBACK");
  expect(state.calls).not.toContain("COMMIT");
  expect(state.mkdir).not.toHaveBeenCalled();
  expect(state.write).not.toHaveBeenCalled();
  expect(state.end).toHaveBeenCalledOnce();
});
it("keeps legacy backups with no photo setting compatible", async () => {
  const result = await stagedRestore(options);
  expect(result.ok).toBe(true);
  expect(result.readyForCutover).toBe(true);
  expect(state.calls).toContain("COMMIT");
  expect(state.calls).not.toContain("ROLLBACK");
  expect(state.mkdir).toHaveBeenCalledOnce();
  expect(state.write).not.toHaveBeenCalled();
  expect(state.end).toHaveBeenCalledOnce();
});
