/** Shared built-app harness for canonical M2 journeys — synthetic test evidence ONLY.
 *
 * Each suite gets its own owned PostgreSQL database and its own cold built server on
 * `SECURITY_HTTP_PORT + portOffset` (never the shared security database or server):
 *  1. marker-free clinic schema through the real runtime (child process);
 *  2. synthetic accounts with explicit capability documents, optional synthetic
 *     doctor parties, then suite seed rows (`seed`);
 *  3. a direct-SQL trusted-ready identity footprint (fixture, NOT a preparation
 *     service: OWNER_READINESS_AND_ISSUANCE.md §2/§7);
 *  4. an event trigger recording every later DDL statement (`ddlLog()` must stay
 *     empty: canonical requests never run ensureSchema or DDL);
 *  5. the standalone server, then Chromium.
 * Logins go through the real password route; no token is minted by the test. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { openBackupTimestampFixture } from "../postgres/_backup-timestamp-fixture";
import { hashPassword } from "../../lib/auth";
import { staffIdentitySubstrateSql } from "../../lib/staff-identity-substrate-schema.mjs";
import { initializeStaffIdentitySubstrate, bindStaffAccountIncarnation } from "../../lib/staff-identity-substrate.mjs";
import { staffRuntimeSchemaSql } from "../../lib/staff-runtime-schema.mjs";

export type RecordScope = "none" | "own" | "all";
export interface JourneyAccount {
  readonly username: string;
  readonly password: string;
  readonly role: string;
  readonly display: string;
  readonly grants?: Readonly<Record<string, boolean>>;
  readonly patientScope?: RecordScope;
  readonly appointmentScope?: RecordScope;
  /** Default `owner` (confirmed); `pending` grants nothing until the owner saves it. */
  readonly confirmation?: "owner" | "pending";
  /** Link to a synthetic active doctor party. */
  readonly doctor?: boolean;
}
export interface CanonicalJourney<K extends string> {
  readonly db: Pool;
  readonly baseUrl: string;
  readonly ids: Readonly<Record<K, number>>;
  readonly parties: Readonly<Partial<Record<K, number>>>;
  readonly browser: Browser;
  login(key: K): Promise<{ status: number; cookie: string; body: Record<string, unknown> }>;
  api(path: string, cookie: string, init?: RequestInit): Promise<Response>;
  /** Fill the real login form; resolves once the canonical shell is shown. */
  browserLogin(page: Page, key: K): Promise<void>;
  ddlLog(): Promise<string[]>;
  close(): Promise<void>;
}

const capabilityDocument = (account: JourneyAccount) => JSON.stringify({
  schemaVersion: 2, confirmation: account.confirmation ?? "owner", revision: 1, patientScope: account.patientScope ?? "none", appointmentScope: account.appointmentScope ?? "none", grants: account.grants ?? {},
});

async function run(command: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, command, { cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", chunk => { stderr += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`bootstrap failed: ${stderr.slice(-2000)}`)));
  });
}

export async function openCanonicalJourney<K extends string>(options: {
  readonly portOffset: number;
  readonly secret: string;
  readonly accounts: Readonly<Record<K, JourneyAccount>>;
  readonly ownerKey: NoInfer<K>;
  readonly seed?: (db: Pool, ids: Readonly<Record<K, number>>, parties: Readonly<Partial<Record<K, number>>>) => Promise<void>;
}): Promise<CanonicalJourney<K>> {
  const port = Number(process.env.SECURITY_HTTP_PORT ?? 3217) + options.portOffset;
  const baseUrl = `http://127.0.0.1:${port}`;
  const owned = await openBackupTimestampFixture({ ...process.env });
  const dbUrl = owned.source.options.connectionString!;
  const db = new Pool({ connectionString: dbUrl, ssl: false, max: 4 });
  let server: ChildProcess | undefined;
  let storage: string | undefined;
  let browser: Browser | undefined;
  const close = async () => {
    await browser?.close();
    if (server && server.exitCode === null) {
      const exited = new Promise<void>(resolve => server!.once("exit", () => resolve()));
      server.kill("SIGTERM");
      const timer = setTimeout(() => server?.kill("SIGKILL"), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await db.query("DROP EVENT TRIGGER IF EXISTS synthetic_ddl_watch").catch(() => {});
    await db.end();
    await owned.close();
    if (storage) rmSync(storage, { recursive: true, force: true });
  };
  try {
    await run(["--import", "tsx", "__tests__/security-http/_schema-bootstrap.mts"],
      { ...process.env, DATABASE_URL: dbUrl, SKIP_SEED: "true", USE_LOCAL_DB: "false", NODE_ENV: "test" });
    const ids = {} as Record<K, number>, parties = {} as Partial<Record<K, number>>;
    for (const [key, account] of Object.entries(options.accounts) as [K, JourneyAccount][]) {
      let party: number | null = null;
      if (account.doctor) {
        party = (await db.query<{ id: number }>("INSERT INTO parties(name,kind,is_active) VALUES($1,'doctor',TRUE) RETURNING id", [`SYN ${account.display}`])).rows[0].id;
        parties[key] = party;
      }
      ids[key] = (await db.query<{ id: number }>(
        "INSERT INTO users(username,display_name,password_hash,role,is_active,party_id,permissions) VALUES($1,$2,$3,$4,TRUE,$5,$6) RETURNING id",
        [account.username, account.display, await hashPassword(account.password), account.role, party, capabilityDocument(account)])).rows[0].id;
    }
    await db.query("UPDATE users SET permissions=$1 WHERE id<>ALL($2::int[])", [capabilityDocument({ username: "", password: "", role: "", display: "" }), Object.values(ids)]);
    await options.seed?.(db, ids, parties);
    const c = await db.connect();
    try {
      await c.query(readFileSync(join(process.cwd(), "__tests__/fixtures/staff-identity/frozen-0076.sql"), "utf8"));
      await c.query(staffIdentitySubstrateSql("public"));
      await c.query("BEGIN");
      let h = await initializeStaffIdentitySubstrate(c, "public");
      for (const { id } of (await c.query<{ id: number }>("SELECT id FROM users ORDER BY id")).rows)
        h = await bindStaffAccountIncarnation(c, { userId: id, currentSubjectId: null, expected: { generationId: h.generationId, registryRevision: h.registryRevision } }, "public");
      await c.query("COMMIT");
      await c.query(staffRuntimeSchemaSql("public"));
      await c.query("BEGIN");
      await c.query("UPDATE users SET authorization_mode='canonical'");
      await c.query("UPDATE staff_authority_control SET state='prepared',pending_owner_user_id=$1,conversion_digest=repeat('a',64),recovery_reference='synthetic-journey-fixture-not-bootstrap' WHERE singleton", [ids[options.ownerKey]]);
      await c.query("UPDATE staff_authority_control SET state='active',owner_user_id=$1,pending_owner_user_id=NULL WHERE singleton", [ids[options.ownerKey]]);
      await c.query("COMMIT");
      await c.query("UPDATE staff_identity_state SET status='ready',ready_owner_subject_id=(SELECT subject_id FROM staff_identity_current WHERE user_id=$1),ready_control_epoch=(SELECT binding_epoch FROM staff_authority_control) WHERE singleton", [ids[options.ownerKey]]);
      await c.query(`CREATE TABLE public.synthetic_ddl_log(id BIGSERIAL PRIMARY KEY, tag TEXT NOT NULL);
       CREATE FUNCTION public.synthetic_record_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.synthetic_ddl_log(tag) VALUES (tg_tag); END $$;
       CREATE EVENT TRIGGER synthetic_ddl_watch ON ddl_command_start EXECUTE FUNCTION public.synthetic_record_ddl();`);
    } finally { c.release(); }
    storage = mkdtempSync(join(tmpdir(), "canonical-m2-journey-"));
    server = spawn(process.execPath, [".next/standalone/server.js"], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl, TEST_DATABASE_URL: dbUrl,
      APP_ORIGIN: baseUrl, CI: "false", DOCUMENTS_DIR: join(storage, "documents"), DURABLE_STORAGE_ROOT: storage, USE_LOCAL_DB: "false",
      NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", SESSION_SECRET: options.secret }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout?.resume(); server.stderr?.resume();
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (server.exitCode !== null) throw new Error("canonical journey server exited before readiness");
      try { if ((await fetch(`${baseUrl}/login`)).ok) break; } catch { /* starting */ }
      if (Date.now() > deadline) throw new Error("canonical journey server readiness timed out");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    const api = (path: string, cookie: string, init: RequestInit = {}) => fetch(`${baseUrl}${path}`, {
      ...init, redirect: "manual", headers: { cookie, Origin: baseUrl, "Content-Type": "application/json", ...(init.headers as Record<string, string> ?? {}) },
    });
    return {
      db, baseUrl, ids, parties, browser,
      async login(key) {
        const response = await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", Origin: baseUrl },
          body: JSON.stringify({ username: options.accounts[key].username, password: options.accounts[key].password }),
        });
        return { status: response.status, cookie: (response.headers.get("set-cookie") ?? "").split(";")[0], body: await response.json() as Record<string, unknown> };
      },
      api,
      async browserLogin(page, key) {
        await page.goto(`${baseUrl}/login`);
        await page.getByLabel("اسم المستخدم", { exact: true }).fill(options.accounts[key].username);
        await page.getByLabel("كلمة المرور", { exact: true }).fill(options.accounts[key].password);
        await page.locator("#login-submit-btn").click();
        await page.getByTestId("canonical-shell").waitFor();
      },
      async ddlLog() { return (await db.query<{ tag: string }>("SELECT tag FROM public.synthetic_ddl_log ORDER BY id")).rows.map(r => r.tag); },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
