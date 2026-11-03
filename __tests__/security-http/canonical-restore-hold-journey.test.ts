/**
 * Restore protocol H2–H4 (docs/inventory/CANONICAL-RESTORE-PROTOCOL-20261028.md §3.0),
 * built application against an isolated, owned, SYNTHETIC restore target.
 *
 * A canonical source (built server, ready identity, password logins) is backed up, then
 * restored into an empty owned database while a second built server serves that target:
 * - H2: password login during the replay (paused on the migration lock) and after it,
 *   before any seal, answers maintenance (503, Arabic);
 * - H3: a legacy cookie genuinely signed for the target (current credential version of a
 *   restored account) and a legacy writer are refused while held; no request runs DDL or
 *   writes;
 * - H4: a valid canonical cookie from the source is refused by the restored target;
 * - a previously-ready target (the source itself) is refused, and its session is proved
 *   valid before and after the refused attempt.
 * H7/P1/P2 (positive) stay in the PostgreSQL suites with the synthetic seal fixture.
 * No real preparation/seal service, CONNECT or role change. Synthetic data only.
 */
import { vi } from "vitest";
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { Client, Pool } from "pg";
import { openCanonicalJourney, type CanonicalJourney } from "./_canonical-journey-harness";
import { openBackupTimestampFixture } from "../postgres/_backup-timestamp-fixture";
import { createSessionToken, sessionCredentialVersion } from "../../lib/auth";
import { SESSION_COOKIE } from "../../lib/sessionCookie";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { stagedRestore } from "../../lib/restore/staging";
import { MIGRATION_ADVISORY_LOCK_KEY } from "../../lib/migrations";

const ARABIC = /[؀-ۿ]/;
const SECRET = process.env.SESSION_SECRET ?? "";
const ACCOUNTS = {
  owner: { username: "canon-rh-owner", password: "Canon#RHOwner1", role: "admin", display: "المالك التجريبي" },
  reception: { username: "canon-rh-reception", password: "Canon#RHReception1", role: "reception", display: "استقبال تجريبي", patientScope: "all", grants: { "patients.create": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let source: CanonicalJourney<Key>;
let targets: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let target: Pool;
let directory = "";
let archivePath = "";
let server: ChildProcess | undefined;
let targetUrl = "";
let restoreResult: Awaited<ReturnType<typeof stagedRestore>> | null = null;

const port = Number(process.env.SECURITY_HTTP_PORT ?? 3217) + 26;
const baseUrl = `http://127.0.0.1:${port}`;
const call = (path: string, cookie = "", init: RequestInit = {}) => fetch(`${baseUrl}${path}`, {
  ...init, redirect: "manual", headers: { ...(cookie ? { cookie } : {}), Origin: baseUrl, "Content-Type": "application/json", ...(init.headers as Record<string, string> ?? {}) },
});
const login = (key: Key) => call("/api/auth/login", "", { method: "POST", body: JSON.stringify({ username: ACCOUNTS[key].username, password: ACCOUNTS[key].password }) });
const tables = async () => (await target.query<{ name: string }>("SELECT relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY relname")).rows.map(row => row.name);

async function startTargetServer() {
  const storage = await mkdtemp(join(tmpdir(), "canonical-restore-target-"));
  server = spawn(process.execPath, [".next/standalone/server.js"], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: targetUrl, TEST_DATABASE_URL: targetUrl,
    APP_ORIGIN: baseUrl, CI: "false", DOCUMENTS_DIR: join(storage, "documents"), DURABLE_STORAGE_ROOT: storage, USE_LOCAL_DB: "false",
    NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", SESSION_SECRET: SECRET }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.resume(); server.stderr?.resume();
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error("target server exited before readiness");
    try { if ((await fetch(`${baseUrl}/login`)).ok) return; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error("target server readiness timed out");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

beforeAll(async () => {
  source = await openCanonicalJourney({
    portOffset: 25, secret: SECRET, accounts: ACCOUNTS, ownerKey: "owner",
    async seed(db) { await db.query("INSERT INTO patients(patient_number,full_name,phone) VALUES('SYN-RHJ-1','مريض مصدر الاستعادة','0500000601')"); },
  });
  directory = await mkdtemp(join(tmpdir(), "canonical-restore-journey-"));
  // The harness's DDL watch is a test instrument, not clinic data: it never belongs in a backup.
  await source.db.query("DROP EVENT TRIGGER IF EXISTS synthetic_ddl_watch; DROP FUNCTION IF EXISTS public.synthetic_record_ddl(); DROP TABLE IF EXISTS public.synthetic_ddl_log");
  const client = await source.db.connect();
  try {
    const blocks: Uint8Array[] = [];
    for await (const block of fullBackupBlocks({ source: client, readDocument: async () => { throw new Error("No synthetic documents"); } })) blocks.push(block);
    archivePath = join(directory, "canonical-source.tar.gz");
    await writeFile(archivePath, gzipSync(Buffer.concat(blocks)));
  } finally { client.release(); }
  targets = await openBackupTimestampFixture({ ...process.env });
  target = targets.archiveTarget;
  targetUrl = target.options.connectionString!;
}, 360_000);
afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise<void>(resolve => server!.once("exit", () => resolve()));
    server.kill("SIGTERM");
    const timer = setTimeout(() => server?.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  await targets?.close();
  await source?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120_000);

describe("a previously-ready target", () => {
  it("is refused before anything is written, and its admitted session is valid before and after", async () => {
    const owner = await source.login("owner");
    expect(owner.status).toBe(200);
    expect((await source.api("/api/auth/me", owner.cookie)).status).toBe(200);
    const result = await stagedRestore({ archivePath, targetUrl: source.db.options.connectionString!, stagingDir: join(directory, "staging-ready") });
    expect(result).toMatchObject({ ok: false, restoreHold: false, migrationsApplied: [] });
    expect(result.errors.join(" ")).toMatch(/هوية موحّدة/);
    expect((await source.api("/api/auth/me", owner.cookie)).status).toBe(200);
    expect((await source.db.query("SELECT to_regclass('public.staff_restore_hold') IS NULL AS absent")).rows[0].absent).toBe(true);
  });
});

describe("an empty target restored from the canonical source, held", () => {
  it("H2 + H3 during the replay: maintenance; legacy cookie and writer refused; no DDL or write by any request", async () => {
    // Pause the replay right after the hold commits: the restore's migrator waits on this lock.
    const locker = new Client({ connectionString: targetUrl, ssl: false });
    await locker.connect();
    try {
      await locker.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
      const lockerPid = (await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const restoring = stagedRestore({ archivePath, targetUrl, stagingDir: join(directory, "staging-target") }).then(result => { restoreResult = result; });
      const deadline = Date.now() + 60_000;
      for (;;) {
        const blocked = (await target.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))", [lockerPid])).rows.length > 0;
        if (blocked) break;
        if (Date.now() > deadline) throw new Error("the replay never reached the migration lock");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(await tables()).toEqual(["staff_restore_hold"]);
      await startTargetServer();
      const during = await login("owner");
      expect(during.status).toBe(503);
      expect((await during.json()).message).toMatch(ARABIC);
      expect(during.headers.get("set-cookie")).toBeNull();
      const legacy = `${SESSION_COOKIE}=${createSessionToken({ userId: source.ids.owner, username: ACCOUNTS.owner.username, role: "admin", expiresAt: Date.now() + 600_000, credentialVersion: "synthetic-during-replay" })}`;
      expect((await call("/api/auth/me", legacy)).status).toBe(401);
      const writer = await call("/api/patients", legacy, { method: "POST", body: JSON.stringify({ fullName: "كتابة مرفوضة أثناء الاستعادة", phone: "0500000699" }) });
      expect([401, 403, 503]).toContain(writer.status);
      // No request ran the legacy schema bootstrap or wrote anything into the held target.
      expect(await tables()).toEqual(["staff_restore_hold"]);
      await locker.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
      await restoring;
    } finally { await locker.end(); }
    expect(restoreResult?.errors).toEqual([]);
    expect(restoreResult).toMatchObject({ ok: true, restoreHold: true });
    expect((await target.query("SELECT state FROM staff_restore_hold")).rows).toEqual([{ state: "held" }]);
  }, 300_000);

  it("H2 after the replay, before any seal: every password login answers maintenance", async () => {
    for (const key of ["owner", "reception"] as const) {
      const response = await login(key);
      expect(response.status).toBe(503);
      expect((await response.json()).message).toMatch(ARABIC);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("H3 while held: a legacy cookie genuinely signed for the target, and a legacy writer, are refused; nothing changes", async () => {
    const { rows: [owner] } = await target.query<{ id: number; password_hash: string }>("SELECT id, password_hash FROM users WHERE username=$1", [ACCOUNTS.reception.username]);
    // Everything the legacy revalidation checks is valid: signature, expiry, account,
    // current credential version. Only the hold refuses it.
    const legacy = `${SESSION_COOKIE}=${createSessionToken({ userId: owner.id, username: ACCOUNTS.reception.username, role: "reception", expiresAt: Date.now() + 600_000, credentialVersion: sessionCredentialVersion(owner.password_hash) })}`;
    const before = { tables: await tables(), patients: Number((await target.query("SELECT count(*) FROM patients")).rows[0].count) };
    expect((await call("/api/auth/me", legacy)).status).toBe(401);
    expect((await call("/api/patients", legacy)).status).toBe(401);
    const writer = await call("/api/patients", legacy, { method: "POST", body: JSON.stringify({ fullName: "كتابة مرفوضة أثناء الحجز", phone: "0500000698" }) });
    expect([401, 403, 503]).toContain(writer.status);
    expect({ tables: await tables(), patients: Number((await target.query("SELECT count(*) FROM patients")).rows[0].count) }).toEqual(before);
    expect((await target.query("SELECT state FROM staff_restore_hold")).rows).toEqual([{ state: "held" }]);
  });

  it("H4: a valid canonical cookie from the source is refused by the restored target, and stays valid on the source", async () => {
    const owner = await source.login("owner");
    expect((await source.api("/api/auth/me", owner.cookie)).status).toBe(200);
    // Refused: no session (401) or maintenance (503) — never an admitted identity or data.
    const me = await call("/api/auth/me", owner.cookie);
    expect([401, 503]).toContain(me.status);
    expect(JSON.stringify(await me.json())).not.toContain(ACCOUNTS.owner.username);
    const read = await call("/api/patients", owner.cookie);
    expect([401, 503]).toContain(read.status);
    expect(JSON.stringify(await read.json())).not.toContain("مريض مصدر الاستعادة");
    const write = await call("/api/patients", owner.cookie, { method: "POST", body: JSON.stringify({ fullName: "كتابة بهوية المصدر", phone: "0500000697" }) });
    expect([401, 403, 503]).toContain(write.status);
    expect(Number((await target.query("SELECT count(*) FROM patients WHERE phone='0500000697'")).rows[0].count)).toBe(0);
    expect((await source.api("/api/auth/me", owner.cookie)).status).toBe(200);
    expect((await target.query("SELECT state FROM staff_restore_hold")).rows).toEqual([{ state: "held" }]);
  });
});
