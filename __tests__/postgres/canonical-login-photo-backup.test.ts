/** Main/WORK integration: public branding is data, canonical identity is provenance only. */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { parseTarBytes } from "../../lib/restore/archive";
import { validateBackupArchive } from "../../lib/restore/validate";
import { readIdentityProvenance } from "../../lib/restore/identity-provenance";
import { stagedRestore } from "../../lib/restore/staging";
import { readStaffEntryMode } from "../../lib/legacy-staff-schema.mjs";

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-photo-backup-identity-2026");
const db = await import("../../lib/db");
const accounts = { owner: { username: "SYN-PHOTO-BACKUP-OWNER", role: "admin" } } as const;
let fx: CanonicalInventoryDatabase<keyof typeof accounts>;
let targets: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let directory: string;
// One synthetic pixel. Never read a real photo or patient document.
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const key = `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.loginpng`;
const raw = JSON.stringify({ key, sha256, mimeType: "image/png", sizeBytes: bytes.length, width: 1, height: 1 });
beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, accounts, "owner");
  targets = await openBackupTimestampFixture({ ...process.env });
  directory = await mkdtemp(join(tmpdir(), "canonical-photo-backup-"));
});
beforeEach(async () => {
  for (const [name, value] of [["clinic.login_photo_asset", raw], ["clinic.login_photo_visible", "false"]]) {
    await fx.pool.query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [name, value]);
  }
});
afterAll(async () => {
  await targets?.close(); await fx?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function capture(useDefault: boolean, mutateDuringSnapshot = false) {
  const client = useDefault ? null : await fx.pool.connect();
  let mutated = false;
  try {
    const source = client ? { query: async (sql: string, values?: unknown[]) => {
      // SQL has already been captured, but file metadata and identity provenance have not.
      if (mutateDuringSnapshot && !mutated && sql.includes("to_regclass('public.expense_attachments')")) {
        mutated = true;
        const writer = await db.getPool().connect();
        try {
          await writer.query("BEGIN");
          await writer.query("UPDATE settings SET value='' WHERE key='clinic.login_photo_asset'");
          await writer.query("COMMIT");
        } catch (error) { await writer.query("ROLLBACK"); throw error; }
        finally { writer.release(); }
      }
      return client.query(sql, values);
    } } : undefined;
    const chunks: Uint8Array[] = [];
    for await (const chunk of fullBackupBlocks({ ...(source ? { source } : {}), readDocument: async requested => {
      expect(requested).toBe(key); return bytes;
    } })) chunks.push(chunk);
    const tar = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
    const validated = validateBackupArchive(parseTarBytes(tar));
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error(validated.errors.join("; "));
    return { tar, validated, mutated };
  } finally { client?.release(); }
}
it.each([false, true])("retains a hidden photo and exact provenance without exporting authority (default=%s)", async useDefault => {
  const provenance = await readIdentityProvenance(fx.pool);
  const { validated } = await capture(useDefault);
  expect(validated.manifest.identityProvenance).toEqual(provenance);
  expect(validated.documents.map(document => document.relativePath)).toEqual([key]);
  expect(Buffer.from(validated.documents[0].bytes)).toEqual(bytes);
  const sql = Buffer.from(validated.sql).toString("utf8");
  expect(sql).toContain(raw);
  expect(sql).not.toMatch(/INSERT INTO "?staff_(?:authority_control|identity_state|identity_current)"?/);
  expect(sql).toContain("-- staff_authority_control: target-owned authority");
});
it("SQL, hidden photo and provenance remain in one real snapshot across a concurrent commit", async () => {
  const before = await readIdentityProvenance(fx.pool);
  const { validated, mutated } = await capture(false, true);
  expect(mutated).toBe(true);
  expect(validated.manifest.identityProvenance).toEqual(before);
  expect(validated.documents.map(document => document.relativePath)).toEqual([key]);
  expect(Buffer.from(validated.sql).toString("utf8")).toContain(raw);
  expect((await fx.pool.query("SELECT value FROM settings WHERE key='clinic.login_photo_asset'")).rows).toEqual([{ value: "" }]);
  expect(await readIdentityProvenance(fx.pool)).toEqual(before);
});
it("restores photo bytes into an empty owned target while canonical entry remains held", async () => {
  const { tar } = await capture(true);
  const archivePath = join(directory, "synthetic.tar.gz"), stagingDir = join(directory, "restored");
  await writeFile(archivePath, gzipSync(tar));
  const result = await stagedRestore({ archivePath, targetUrl: targets.archiveTarget.options.connectionString!, stagingDir });
  expect(result).toMatchObject({ ok: true, restoreHold: true, errors: [], validationErrors: [] });
  expect(await readStaffEntryMode(targets.archiveTarget)).toBe("canonical");
  expect((await targets.archiveTarget.query("SELECT state FROM staff_restore_hold")).rows).toEqual([{ state: "held" }]);
  expect((await targets.archiveTarget.query("SELECT to_regclass('public.staff_authority_control') AS authority")).rows).toEqual([{ authority: null }]);
  expect((await targets.archiveTarget.query("SELECT value FROM settings WHERE key='clinic.login_photo_visible'")).rows).toEqual([{ value: "false" }]);
  expect(await readFile(join(stagingDir, key))).toEqual(bytes);
});
