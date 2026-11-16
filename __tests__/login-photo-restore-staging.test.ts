import { beforeEach, expect, it, vi } from "vitest";
import { stagedRestore } from "../lib/restore/staging";

const state = vi.hoisted(() => ({ raw: "", partialIdentity: false, calls: [] as string[], mkdir: vi.fn(), write: vi.fn(), end: vi.fn() }));
vi.mock("node:fs/promises", () => ({ mkdir: state.mkdir, writeFile: state.write, readFile: vi.fn(), rm: vi.fn() }));
vi.mock("pg", () => ({ Client: class {
  async connect() {}
  async end() { state.end(); }
  async query(sql: string) {
    state.calls.push(sql);
    if (sql.includes("to_regclass('public.staff_authority_identity')")) return { rows: [{ identity: state.partialIdentity, epochs: false, subjects: false }] };
    if (sql.includes("information_schema.tables")) return { rows: [{ tables: 0 }] };
    if (sql === "SELECT value FROM settings WHERE key = $1") return { rows: state.raw ? [{ value: state.raw }] : [] };
    return { rows: [] };
  }
} }));
vi.mock("../lib/migrations", () => ({
  loadMigrationFiles: async () => [], migrate: async () => { state.calls.push("MIGRATE"); return { appliedVersions: [] }; },
  migrationStatus: async () => ({ probe: { ok: true, missing: [] }, consistent: true }),
}));
vi.mock("../lib/restore/client-config", () => ({ restoreClientConfigFor: () => ({}) }));
vi.mock("../lib/restore/archive", () => ({ readTarGzEntries: async () => ({}) }));
vi.mock("../lib/restore/validate", () => ({ validateBackupArchive: () => ({ ok: true, manifest: {}, sql: Buffer.from("SELECT 1;"), documents: [] }) }));
vi.mock("../lib/restore/sql.mjs", () => ({ prepareBackupSql: () => ({ dataSql: "SELECT 1;", skippedMigrationRecordLines: 0, sqlRowsStatementLines: 1 }) }));
vi.mock("../lib/files", () => ({ putFile: vi.fn(), readFileByKey: vi.fn() }));

beforeEach(() => { state.raw = ""; state.partialIdentity = false; state.calls.length = 0; vi.clearAllMocks(); });
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

it("pins literal semantics before any schema migration or data replay", async () => {
  expect((await stagedRestore(options)).ok).toBe(true);
  const pin = state.calls.indexOf("SET standard_conforming_strings = on");
  expect(pin).toBeGreaterThanOrEqual(0);
  expect(pin).toBeLessThan(state.calls.indexOf("MIGRATE"));
  expect(pin).toBeLessThan(state.calls.indexOf("BEGIN"));
  expect(pin).toBeLessThan(state.calls.indexOf("SELECT 1;"));
});

it("retains WORK refusal of a partial identity schema before declaring the photo restore complete", async () => {
  state.partialIdentity = true;
  const result = await stagedRestore(options);
  expect(result.ok).toBe(false); expect(result.readyForCutover).toBe(false);
  expect(result.errors.join(" ")).toContain("partial_staff_authority_schema");
  expect(state.calls).toContain("ROLLBACK"); expect(state.calls).not.toContain("COMMIT");
  expect(state.mkdir).not.toHaveBeenCalled(); expect(state.write).not.toHaveBeenCalled();
});
