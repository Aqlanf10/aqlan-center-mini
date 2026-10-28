/**
 * Built-app canonical entry journey (M1_ENTRY_SLICE_DESIGN.md), on its own database
 * and server. Synthetic trusted-ready fixture ONLY: no owner provenance, live grant,
 * activation or Production data. The shared HTTP harness stays marker-free (legacy).
 *
 * password → private issuer → HttpOnly cookie → auth/me → canonical shell → directory
 * → owner edits a permission → target's live session revoked → fresh login reflects the
 * exact new scope; direct API denials; legacy/canonical envelope separation; and a
 * DDL event log proving that no canonical request (cold start included) initializes schema.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import { Pool } from "pg";
import { chromium, type Browser } from "playwright";
import { openBackupTimestampFixture } from "../postgres/_backup-timestamp-fixture";
import { hashPassword } from "../../lib/auth";
import { SESSION_COOKIE } from "../../lib/sessionCookie";
import { staffIdentitySubstrateSql } from "../../lib/staff-identity-substrate-schema.mjs";
import { initializeStaffIdentitySubstrate, bindStaffAccountIncarnation } from "../../lib/staff-identity-substrate.mjs";
import { staffRuntimeSchemaSql } from "../../lib/staff-runtime-schema.mjs";

const SECRET = "canonical-journey-test-secret-0123456789abcdef";
const port = Number(process.env.SECURITY_HTTP_PORT ?? 3217) + 3;
const baseUrl = `http://127.0.0.1:${port}`;
const ARABIC = /[؀-ۿ]/;
const ACCOUNTS = {
 owner: { username: "canon-owner", password: "Canon#Owner1", role: "admin", display: "المالك التجريبي" },
 manager: { username: "canon-manager", password: "Canon#Manager1", role: "reception", display: "مدير الصلاحيات التجريبي" },
 target: { username: "canon-target", password: "Canon#Target1", role: "reception", display: "موظف استقبال تجريبي" },
} as const;
const doc = (grants: Record<string, boolean>, scope: "none" | "all" = "none") => JSON.stringify({ schemaVersion: 1, revision: 1, patientScope: scope, appointmentScope: scope, grants });

let owned: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let db: Pool;
let server: ChildProcess | undefined;
let storage: string;
let browser: Browser;
const ids: Record<keyof typeof ACCOUNTS, number> = { owner: 0, manager: 0, target: 0 };

async function run(command: string[], env: NodeJS.ProcessEnv) {
 const child = spawn(process.execPath, command, { cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe"] });
 let stderr = "";
 child.stderr?.on("data", chunk => { stderr += String(chunk); });
 await new Promise<void>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", code => code === 0 ? resolve() : reject(new Error(`bootstrap failed: ${stderr.slice(-2000)}`)));
 });
}
async function login(account: keyof typeof ACCOUNTS, password: string = ACCOUNTS[account].password) {
 const response = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST", redirect: "manual",
  headers: { "Content-Type": "application/json", Origin: baseUrl },
  body: JSON.stringify({ username: ACCOUNTS[account].username, password }),
 });
 const setCookie = response.headers.get("set-cookie") ?? "";
 return { response, setCookie, cookie: setCookie.split(";")[0], body: await response.json() as Record<string, unknown> };
}
const me = (cookie: string) => fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
const api = (path: string, cookie: string, init: RequestInit = {}) => fetch(`${baseUrl}${path}`, {
 ...init, redirect: "manual", headers: { cookie, Origin: baseUrl, "Content-Type": "application/json", ...(init.headers as Record<string, string> ?? {}) },
});
async function ddlLog() { return (await db.query<{ tag: string }>("SELECT tag FROM public.synthetic_ddl_log ORDER BY id")).rows.map(r => r.tag); }

beforeAll(async () => {
 owned = await openBackupTimestampFixture({ ...process.env });
 const dbUrl = owned.source.options.connectionString!;
 db = new Pool({ connectionString: dbUrl, ssl: false, max: 4 });
 // 1. Marker-free base schema through the real runtime, in a child process.
 await run(["--import", "tsx", "__tests__/security-http/_schema-bootstrap.mts"],
  { ...process.env, DATABASE_URL: dbUrl, SKIP_SEED: "true", USE_LOCAL_DB: "false", NODE_ENV: "test" });
 // 2. Synthetic accounts; every existing account receives an explicit canonical document.
 for (const [key, account] of Object.entries(ACCOUNTS) as [keyof typeof ACCOUNTS, typeof ACCOUNTS[keyof typeof ACCOUNTS]][]) {
  const grants: Record<string, boolean> = key === "manager" ? { "staff.view": true, "staff.permissions.edit": true } : {};
  const { rows: [row] } = await db.query<{ id: number }>(
   "INSERT INTO users(username,display_name,password_hash,role,is_active,permissions) VALUES($1,$2,$3,$4,TRUE,$5) RETURNING id",
   [account.username, account.display, await hashPassword(account.password), account.role, doc(grants, key === "manager" ? "all" : "none")]);
  ids[key] = row.id;
 }
 await db.query("UPDATE users SET permissions=$1 WHERE id<>ALL($2::int[])", [doc({}), Object.values(ids)]);
 // 3. Synthetic trusted-ready footprint in the public schema (fixture, not a preparation API).
 const c = await db.connect();
 try {
  // KNOWN M4 BLOCKER (M1_ENTRY_SLICE_DESIGN.md §6): the frozen substrate/runtime catalogues were
  // generated from synthetic tables, so they pin users.id/parties.id WITHOUT the clinic schema's
  // SERIAL default. This synthetic database drops the two defaults to match the frozen contract;
  // a real installation needs a reviewed catalogue revision instead. Canonical account creation
  // does not exist yet, so nothing in this journey depends on the defaults.
  await c.query("ALTER TABLE users ALTER COLUMN id DROP DEFAULT; ALTER TABLE parties ALTER COLUMN id DROP DEFAULT");
  await c.query(readFileSync(join(process.cwd(), "__tests__/fixtures/staff-identity/frozen-0076.sql"), "utf8"));
  await c.query(staffIdentitySubstrateSql("public"));
  await c.query("BEGIN");
  let h = await initializeStaffIdentitySubstrate(c, "public");
  const { rows: users } = await c.query<{ id: number }>("SELECT id FROM users ORDER BY id");
  for (const { id } of users) h = await bindStaffAccountIncarnation(c, { userId: id, currentSubjectId: null, expected: { generationId: h.generationId, registryRevision: h.registryRevision } }, "public");
  await c.query("COMMIT");
  await c.query(staffRuntimeSchemaSql("public"));
  await c.query("BEGIN");
  await c.query("UPDATE users SET authorization_mode='canonical'");
  await c.query("UPDATE staff_authority_control SET state='prepared',pending_owner_user_id=$1,conversion_digest=repeat('a',64),recovery_reference='synthetic-journey-fixture-not-bootstrap' WHERE singleton", [ids.owner]);
  await c.query("UPDATE staff_authority_control SET state='active',owner_user_id=$1,pending_owner_user_id=NULL WHERE singleton", [ids.owner]);
  await c.query("COMMIT");
  await c.query("UPDATE staff_identity_state SET status='ready',ready_owner_subject_id=(SELECT subject_id FROM staff_identity_current WHERE user_id=$1),ready_control_epoch=(SELECT binding_epoch FROM staff_authority_control) WHERE singleton", [ids.owner]);
  // 4. From here on, every DDL statement in this database is recorded.
  await c.query(`CREATE TABLE public.synthetic_ddl_log(id BIGSERIAL PRIMARY KEY, tag TEXT NOT NULL);
   CREATE FUNCTION public.synthetic_record_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.synthetic_ddl_log(tag) VALUES (tg_tag); END $$;
   CREATE EVENT TRIGGER synthetic_ddl_watch ON ddl_command_start EXECUTE FUNCTION public.synthetic_record_ddl();`);
 } finally { c.release(); }
 // 5. Cold built server on the canonical database.
 storage = mkdtempSync(join(tmpdir(), "canonical-journey-"));
 server = spawn(process.execPath, [".next/standalone/server.js"], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl, TEST_DATABASE_URL: dbUrl,
  APP_ORIGIN: baseUrl, CI: "false", DOCUMENTS_DIR: join(storage, "documents"), DURABLE_STORAGE_ROOT: storage, USE_LOCAL_DB: "false",
  NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", SESSION_SECRET: SECRET }, stdio: ["ignore", "pipe", "pipe"] });
 server.stdout?.resume(); server.stderr?.resume();
 const deadline = Date.now() + 120_000;
 for (;;) {
  if (server.exitCode !== null) throw new Error("canonical journey server exited before readiness");
  try { if ((await fetch(`${baseUrl}/login`)).ok) break; } catch { /* starting */ }
  if (Date.now() > deadline) throw new Error("canonical journey server readiness timed out");
  await new Promise(resolve => setTimeout(resolve, 250));
 }
 browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 300_000);

afterAll(async () => {
 await browser?.close();
 if (server && server.exitCode === null) {
  const exited = new Promise<void>(resolve => server!.once("exit", () => resolve()));
  server.kill("SIGTERM");
  const timer = setTimeout(() => server?.kill("SIGKILL"), 5000);
  try { await exited; } finally { clearTimeout(timer); }
 }
 await db?.query("DROP EVENT TRIGGER IF EXISTS synthetic_ddl_watch").catch(() => {});
 await db?.end();
 await owned?.close();
 if (storage) rmSync(storage, { recursive: true, force: true });
}, 60_000);

it("cold login page renders; bad credentials are generic, limited persistently and issue nothing", async () => {
 expect((await fetch(`${baseUrl}/login`)).status).toBe(200);
 const wrong = await login("target", "not-the-password");
 expect(wrong.response.status).toBe(401);
 expect(wrong.body.message).toMatch(ARABIC);
 expect(wrong.setCookie).toBe("");
 const missing = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: baseUrl }, body: JSON.stringify({ username: "canon-nobody", password: "x" }) });
 expect(missing.status).toBe(401);
 expect(Number((await db.query("SELECT count(*) FROM staff_login_limits")).rows[0].count)).toBeGreaterThan(0);
 expect(await ddlLog()).toEqual([]);
});

it("password login issues only an HttpOnly cookie; auth/me admits the exact current tuple", async () => {
 const owner = await login("owner");
 expect(owner.response.status).toBe(200);
 expect(owner.body).toEqual({ username: ACCOUNTS.owner.username, displayName: ACCOUNTS.owner.display, role: "admin", canonical: true });
 expect(JSON.stringify(owner.body)).not.toMatch(/token|durable|scrypt/i);
 expect(owner.setCookie).toMatch(/HttpOnly/i);
 expect(owner.setCookie).toMatch(/SameSite=Lax/i);
 expect(owner.response.headers.get("cache-control")).toMatch(/no-store/);
 const profile = await me(owner.cookie);
 expect(profile.status).toBe(200);
 expect(await profile.json()).toMatchObject({ canonical: true, username: ACCOUNTS.owner.username, isOwner: true, patientScope: "all" });
 const target = await login("target");
 expect(await (await me(target.cookie)).json()).toMatchObject({ canonical: true, isOwner: false, capabilities: [] });
 expect(await ddlLog()).toEqual([]);
});

it("legacy and canonical envelopes never cross: legacy token refused on canonical routes, canonical cookie refused by legacy routes", async () => {
 const owner = await login("owner");
 const body = Buffer.from(JSON.stringify({ userId: ids.owner, username: ACCOUNTS.owner.username, role: "admin", expiresAt: Date.now() + 60_000, credentialVersion: "x" })).toString("base64url");
 const legacy = `${SESSION_COOKIE}=${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
 const refused = await api("/api/staff-access", legacy);
 expect(refused.status).toBe(403);
 expect((await refused.json()).message).toMatch(ARABIC);
 expect((await me(legacy)).status).toBe(401);
 const legacyRoute = await api("/api/patients", owner.cookie);
 expect([401, 403]).toContain(legacyRoute.status);
 // A canonical cookie never falls through to a (valid-looking) Bearer.
 const mixed = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: owner.cookie.replace(/.$/, "A"), Authorization: `Bearer ${legacy.split("=")[1]}` } });
 expect(mixed.status).toBe(401);
 expect(await ddlLog()).toEqual([]);
});

it("browser journey: owner → shell → directory → grant; target's live session is revoked and a fresh login gets exactly the new scope", async () => {
 const targetBefore = await login("target");
 expect((await me(targetBefore.cookie)).status).toBe(200);
 const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar" });
 const page = await ownerContext.newPage();
 const legacyCalls: string[] = [];
 page.on("request", request => {
  const path = new URL(request.url()).pathname;
  if (path.startsWith("/api/") && !/^\/api\/(auth\/(login|me|logout)|staff-access)/.test(path)) legacyCalls.push(path);
 });
 await page.goto(`${baseUrl}/login`);
 await page.getByLabel("اسم المستخدم", { exact: true }).fill(ACCOUNTS.owner.username);
 await page.getByLabel("كلمة المرور", { exact: true }).fill(ACCOUNTS.owner.password);
 await page.locator("#login-submit-btn").click();
 await page.getByTestId("canonical-shell").waitFor();
 await expect.poll(() => page.getByTestId("canonical-display-name").textContent()).toBe(ACCOUNTS.owner.display);
 // An unmigrated screen shows the workspace notice, never its legacy UI.
 await page.goto(`${baseUrl}/patients`);
 await page.getByTestId("canonical-workspace").waitFor();
 await expect.poll(() => page.getByRole("status").first().textContent()).toMatch(/لم تُنقل بعد/);
 await page.getByRole("link", { name: "صلاحيات الطاقم" }).first().click();
 await page.getByTestId("staff-directory").getByText(ACCOUNTS.target.username).waitFor();
 const row = page.getByTestId("staff-directory").locator("li", { hasText: ACCOUNTS.target.username });
 await row.getByRole("button", { name: "الصلاحيات" }).click();
 const editor = page.getByTestId("capability-editor");
 await editor.getByText(ACCOUNTS.target.display).waitFor();
 await editor.getByLabel("عرض دليل الطاقم").check();
 await editor.getByRole("button", { name: "حفظ الصلاحيات" }).click();
 await expect.poll(() => editor.getByRole("status").textContent()).toMatch(/المراجعة 2/);
 expect(legacyCalls).toEqual([]);
 await ownerContext.close();
 // Revocation linearizes at the committed edit: the earlier cookie is no longer admitted.
 expect((await me(targetBefore.cookie)).status).toBe(401);
 const targetAfter = await login("target");
 expect(await (await me(targetAfter.cookie)).json()).toMatchObject({ capabilities: ["staff.view"] });
 const directory = await api("/api/staff-access", targetAfter.cookie);
 expect(directory.status).toBe(200);
 // Hidden actions stay denied server-side even when invoked directly.
 const editorRead = await api(`/api/staff-access/${ids.manager}`, targetAfter.cookie);
 expect(editorRead.status).toBe(403);
 const escalate = await api(`/api/staff-access/${ids.target}`, targetAfter.cookie, { method: "PATCH", body: JSON.stringify({ expectedRevision: 2, patientScope: "all", appointmentScope: "all", grants: { "staff.view": true, "staff.permissions.edit": true } }) });
 expect(escalate.status).toBe(403);
 expect((await escalate.json()).message).toMatch(ARABIC);
 const { rows: [audit] } = await db.query("SELECT actor, entity_id FROM audit_log WHERE action='staff.capabilities.update' ORDER BY id DESC LIMIT 1");
 expect(audit).toEqual({ actor: ACCOUNTS.owner.username, entity_id: String(ids.target) });
 expect(await ddlLog()).toEqual([]);
});

it("a delegated manager cannot escalate a target beyond its own authority or touch the protected owner", async () => {
 const manager = await login("manager");
 const view = await (await api(`/api/staff-access/${ids.target}`, manager.cookie)).json();
 expect(view).toMatchObject({ editable: true });
 const beyond = await api(`/api/staff-access/${ids.target}`, manager.cookie, { method: "PATCH", body: JSON.stringify({ expectedRevision: view.revision, patientScope: "none", appointmentScope: "none", grants: { "staff.view": true, "finance.invoices.view": true } }) });
 expect(beyond.status).toBe(403);
 const owner = await api(`/api/staff-access/${ids.owner}`, manager.cookie, { method: "PATCH", body: JSON.stringify({ expectedRevision: 1, patientScope: "none", appointmentScope: "none", grants: {} }) });
 expect(owner.status).toBe(403);
 const stale = await api(`/api/staff-access/${ids.target}`, manager.cookie, { method: "PATCH", body: JSON.stringify({ expectedRevision: view.revision - 1, patientScope: "none", appointmentScope: "none", grants: {} }) });
 expect(stale.status).toBe(409);
 expect(await ddlLog()).toEqual([]);
});

it("mobile shell keeps navigation usable and logout clears the browser cookie", async () => {
 const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar" });
 const page = await context.newPage();
 await page.goto(`${baseUrl}/login`);
 await page.getByLabel("اسم المستخدم", { exact: true }).fill(ACCOUNTS.manager.username);
 await page.getByLabel("كلمة المرور", { exact: true }).fill(ACCOUNTS.manager.password);
 await page.locator("#login-submit-btn").click();
 await page.getByTestId("canonical-shell").waitFor();
 const link = page.getByRole("link", { name: "صلاحيات الطاقم" }).first();
 await link.waitFor();
 const box = await link.boundingBox();
 expect(box && box.height >= 44).toBe(true);
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
 await page.getByRole("button", { name: "تسجيل الخروج" }).click();
 await page.waitForURL(/\/login/);
 expect((await context.cookies()).find(cookie => cookie.name === SESSION_COOKIE && cookie.value)).toBeUndefined();
 await context.close();
 expect(await ddlLog()).toEqual([]);
});
