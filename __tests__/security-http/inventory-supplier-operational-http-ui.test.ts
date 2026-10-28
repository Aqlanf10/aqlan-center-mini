/**
 * Built-app CANONICAL inventory & procurement journey (M3a), on its own database and
 * server. It replaces the obsolete supplier suite that installed the retired parallel
 * authority schema into the shared HTTP database: that footprint put the shared
 * server's entry into maintenance (503) and broke every later inventory suite.
 *
 * Synthetic trusted-ready fixture ONLY: no owner provenance, live grant, activation
 * or Production data. Covered end to end through the real issuer, cookie, auth/me,
 * canonical shell, the procurement route and the browser UI:
 *  - navigation is a projection of exact grants over the registered inventory pages;
 *  - every read/command is admitted by its exact capability (adjacent actions 403);
 *  - procurement cycle, idempotent replay and zero debt/cash before posting;
 *  - supplier panel: review → revise → post → cancel at 390/1280 px;
 *  - lost admission/execution replies keep one exact intent across reload, 403 and
 *    two tabs; another browser's pending intent durably rejects a new nonce;
 *  - custody statement scope and controls follow grants and the clinician link;
 *  - an editor revocation kills the live cookie; a fresh login gets the new scope;
 *  - a DDL event log proves no canonical request initialises schema.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { openBackupTimestampFixture } from "../postgres/_backup-timestamp-fixture";
import { hashPassword } from "../../lib/auth";
import { staffIdentitySubstrateSql } from "../../lib/staff-identity-substrate-schema.mjs";
import { initializeStaffIdentitySubstrate, bindStaffAccountIncarnation } from "../../lib/staff-identity-substrate.mjs";
import { staffRuntimeSchemaSql } from "../../lib/staff-runtime-schema.mjs";
import { INVENTORY_PROCUREMENT_SQL } from "../../lib/inventory-domain/schema-proposal";
import { INVENTORY_CUSTODY_SQL } from "../../lib/inventory-domain/custody-schema-proposal";
import { INVENTORY_SUPPLIER_FINANCE_SQL } from "../../lib/inventory-domain/supplier-finance-schema-proposal";
import { INVENTORY_SUPPLIER_NUMBER_SQL } from "../../lib/inventory-domain/supplier-number-schema-proposal";
import { INVENTORY_COMMAND_LIFECYCLE_SQL } from "../../lib/inventory-domain/command-lifecycle-schema-proposal";
import { INVENTORY_SUPPLIER_TRANSPORT_SQL } from "../../lib/inventory-domain/supplier-transport-schema-proposal";
import { valuationSnapshot, type PurchaseOrder, type ReceiptRevision, type RequestRevision } from "../../lib/inventory-domain/procurement";

const SECRET = "canonical-inventory-journey-secret-0123456789abcdef";
const port = Number(process.env.SECURITY_HTTP_PORT ?? 3217) + 4;
const baseUrl = `http://127.0.0.1:${port}`;
const ARABIC = /[؀-ۿ]/;
const artifacts = process.env.INVENTORY_EVIDENCE_DIR ?? ".inventory-procurement-artifacts";
const MANAGER = {
  "inventory.references.view": true, "inventory.requests.view": true, "inventory.requests.approve": true,
  "inventory.orders.view": true, "inventory.orders.manage": true, "inventory.receipts.post": true,
  "finance.suppliers.view": true, "inventory.supplier-invoices.record": true, "inventory.supplier-invoices.cancel": true,
};
const ACCOUNTS = {
  owner: { username: "inv-owner", password: "Inv#Owner1", role: "admin", grants: {} as Record<string, boolean>, doctor: false },
  manager: { username: "inv-manager", password: "Inv#Manager1", role: "reception", grants: MANAGER, doctor: false },
  requester: { username: "inv-requester", password: "Inv#Requester1", role: "doctor", doctor: true,
    grants: { "inventory.references.view": true, "inventory.requests.view": true, "inventory.requests.create": true, "inventory.custody.view": true, "inventory.custody.acknowledge": true, "inventory.custody.use": true } },
  keeper: { username: "inv-keeper", password: "Inv#Keeper1", role: "reception", doctor: false,
    grants: { "inventory.references.view": true, "inventory.custody.view": true, "inventory.custody.dispatch": true } },
} as const;
type Who = keyof typeof ACCOUNTS;
const doc = (grants: Record<string, boolean>, revision = 1) => JSON.stringify({ schemaVersion: 1, revision, patientScope: "none", appointmentScope: "none", grants });

let owned: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let db: Pool;
let server: ChildProcess | undefined;
let storage: string;
let browser: Browser;
const ids = {} as Record<Who, number>;
let doctorParty: number, itemId: number, supplierId: number;
const store = `INV-STORE-${randomUUID()}`, transit = `INV-TRANSIT-${randomUUID()}`, custody = `INV-CUSTODY-${randomUUID()}`;
const diagnostics = { pageErrors: [] as string[] };
const cookies: Partial<Record<Who, string>> = {};

async function run(command: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, command, { cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", chunk => { stderr += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`bootstrap failed: ${stderr.slice(-2000)}`)));
  });
}
async function login(who: Who) {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/json", Origin: baseUrl }, body: JSON.stringify({ username: ACCOUNTS[who].username, password: ACCOUNTS[who].password }) });
  expect(response.status).toBe(200);
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  cookies[who] = cookie;
  return cookie;
}
const cookieOf = async (who: Who) => cookies[who] ?? login(who);
const api = (path: string, cookie: string, init: RequestInit = {}) => fetch(`${baseUrl}${path}`, {
  ...init, redirect: "manual", headers: { cookie, Origin: baseUrl, "Content-Type": "application/json", ...(init.headers as Record<string, string> ?? {}) },
});
const get = async (who: Who, view = "") => api(`/api/inventory/procurement${view}`, await cookieOf(who));
const post = async (who: Who, body: object) => api("/api/inventory/procurement", await cookieOf(who), { method: "POST", body: JSON.stringify(body) });
const operation = (command: string, payload: object) => ({ command, operationKey: randomUUID(), ...payload });
async function ddlLog() { return (await db.query<{ tag: string }>("SELECT tag FROM public.synthetic_ddl_log ORDER BY id")).rows.map(r => r.tag); }
const counts = async () => (await db.query("SELECT (SELECT COUNT(*) FROM inventory_movements)::int AS stock,(SELECT COUNT(*) FROM payables)::int AS debt,(SELECT COUNT(*) FROM expenses)::int AS cash")).rows[0];
const conversion = () => ({ itemId, version: 1, baseUnit: "cartridge", enteredUnit: "box", baseUnitsPerEnteredUnit: "50", enteredPrecision: 0, basePrecision: 0 });

beforeAll(async () => {
  owned = await openBackupTimestampFixture({ ...process.env });
  const dbUrl = owned.source.options.connectionString!;
  db = new Pool({ connectionString: dbUrl, ssl: false, max: 4 });
  // 1. Marker-free base schema through the real runtime, in a child process.
  await run(["--import", "tsx", "__tests__/security-http/_schema-bootstrap.mts"],
    { ...process.env, DATABASE_URL: dbUrl, SKIP_SEED: "true", USE_LOCAL_DB: "false", NODE_ENV: "test" });
  // 2. The unpublished inventory proposals (explicit, never request-time).
  for (const sql of [INVENTORY_PROCUREMENT_SQL, INVENTORY_CUSTODY_SQL, INVENTORY_SUPPLIER_FINANCE_SQL, INVENTORY_SUPPLIER_NUMBER_SQL, INVENTORY_COMMAND_LIFECYCLE_SQL]) await db.query(sql);
  doctorParty = (await db.query<{ id: number }>("INSERT INTO parties(name,kind,is_active) VALUES('INV doctor','doctor',TRUE) RETURNING id")).rows[0].id;
  for (const [who, account] of Object.entries(ACCOUNTS) as [Who, typeof ACCOUNTS[Who]][]) {
    ids[who] = (await db.query<{ id: number }>(
      "INSERT INTO users(username,display_name,password_hash,role,is_active,party_id,permissions) VALUES($1,$1,$2,$3,TRUE,$4,$5) RETURNING id",
      [account.username, await hashPassword(account.password), account.role, account.doctor ? doctorParty : null, doc(account.grants)])).rows[0].id;
  }
  await db.query("UPDATE users SET permissions=$1 WHERE id<>ALL($2::int[])", [doc({}), Object.values(ids)]);
  // 3. Synthetic trusted-ready footprint (fixture, not a preparation API).
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
    await c.query("UPDATE staff_authority_control SET state='prepared',pending_owner_user_id=$1,conversion_digest=repeat('a',64),recovery_reference='synthetic-inventory-journey-not-bootstrap' WHERE singleton", [ids.owner]);
    await c.query("UPDATE staff_authority_control SET state='active',owner_user_id=$1,pending_owner_user_id=NULL WHERE singleton", [ids.owner]);
    await c.query("COMMIT");
    await c.query("UPDATE staff_identity_state SET status='ready',ready_owner_subject_id=(SELECT subject_id FROM staff_identity_current WHERE user_id=$1),ready_control_epoch=(SELECT binding_epoch FROM staff_authority_control) WHERE singleton", [ids.owner]);
    await c.query(INVENTORY_SUPPLIER_TRANSPORT_SQL);
    // Synthetic reference data.
    itemId = (await c.query<{ id: number }>("INSERT INTO inventory_items(name,category,unit,min_level,created_by) VALUES('INV cartridges','anesthesia','cartridge',5,'inv-owner') RETURNING id")).rows[0].id;
    await c.query("INSERT INTO inventory_item_unit_versions(item_id,version,entered_unit,base_unit,factor,entered_precision,base_precision) VALUES($1,1,'box','cartridge',50,0,0)", [itemId]);
    supplierId = (await c.query<{ id: number }>("INSERT INTO parties(name,kind) VALUES('INV supplier','supplier') RETURNING id")).rows[0].id;
    for (const [id, label, kind, party] of [[store, "مخزن تجريبي", "store", null], [transit, "نقل تجريبي", "transit", null], [custody, "عهدة الطبيب التجريبي", "custody", doctorParty]] as const)
      await c.query("INSERT INTO inventory_locations(id,branch_key,label,kind,doctor_party_id) VALUES($1,'clinic',$2,$3,$4)", [id, label, kind, party]);
    await c.query("INSERT INTO inventory_approval_policies(id,branch_key,version,currency,limit_minor,allow_self_approval,created_by) VALUES($1,'clinic',1,'YER',1000000000,FALSE,$2)", [randomUUID(), ids.owner]);
    // 4. From here on, every DDL statement in this database is recorded.
    await c.query(`CREATE TABLE public.synthetic_ddl_log(id BIGSERIAL PRIMARY KEY, tag TEXT NOT NULL);
     CREATE FUNCTION public.synthetic_record_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.synthetic_ddl_log(tag) VALUES (tg_tag); END $$;
     CREATE EVENT TRIGGER synthetic_inventory_ddl_watch ON ddl_command_start EXECUTE FUNCTION public.synthetic_record_ddl();`);
  } finally { c.release(); }
  // 5. Cold built server on the canonical database, inventory integration enabled.
  storage = mkdtempSync(join(tmpdir(), "canonical-inventory-journey-"));
  server = spawn(process.execPath, [".next/standalone/server.js"], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl, TEST_DATABASE_URL: dbUrl,
    APP_ORIGIN: baseUrl, CI: "false", DOCUMENTS_DIR: join(storage, "documents"), DURABLE_STORAGE_ROOT: storage, USE_LOCAL_DB: "false",
    NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", SESSION_SECRET: SECRET, INVENTORY_INTEGRATION_ENABLED: "true" }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.resume(); server.stderr?.resume();
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error("canonical inventory journey server exited before readiness");
    try { if ((await fetch(`${baseUrl}/login`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error("canonical inventory journey server readiness timed out");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.INVENTORY_CHROMIUM_EXECUTABLE || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(artifacts, { recursive: true });
}, 300_000);

afterAll(async () => {
  await writeFile(`${artifacts}/canonical-inventory-diagnostics.json`, JSON.stringify(diagnostics, null, 2)).catch(() => {});
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise<void>(resolve => server!.once("exit", () => resolve()));
    server.kill("SIGTERM");
    const timer = setTimeout(() => server?.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  await db?.query("DROP EVENT TRIGGER IF EXISTS synthetic_inventory_ddl_watch").catch(() => {});
  await db?.end();
  await owned?.close();
  if (storage) rmSync(storage, { recursive: true, force: true });
  expect(diagnostics.pageErrors).toEqual([]);
}, 60_000);

/** Request → approval → order → partial receipt → matched invoice, entirely through the route. */
async function fixture(missingNumber = false) {
  const before = await counts();
  const r: RequestRevision = { id: randomUUID(), version: 1, branchId: "clinic", requestedBy: 999999, reason: "INV request journey", proposedSupplierPartyId: supplierId,
    value: { currency: "SAR", amountMinor: 30000 }, lines: [{ id: randomUUID(), itemId, quantity: "3", conversion: conversion() }] };
  const submit = operation("request.submit", { document: r });
  expect((await post("requester", submit)).status).toBe(201);
  expect((await post("requester", submit)).status).toBe(201); // exact replay
  expect((await db.query("SELECT requested_by FROM purchase_requests WHERE id=$1", [r.id])).rows[0].requested_by).toBe(ids.requester);
  const approval = { requestId: r.id, version: 1, decisions: [{ lineId: r.lines[0].id, quantity: "3", reason: "Synthetic approval" }],
    valuation: valuationSnapshot({ purpose: "approval_estimate", currency: "SAR", amountMinor: 30000, rateToBase: "500", capturedAt: "2026-10-14T01:00:00Z", sourceRef: "synthetic quote" }) };
  const denied = await post("requester", operation("request.approve", { approval }));
  expect(denied.status).toBe(403);
  expect((await denied.json()).message).toMatch(ARABIC);
  expect((await post("manager", operation("request.approve", { approval }))).status).toBe(200);
  const o: PurchaseOrder = { id: randomUUID(), version: 1, branchId: "clinic", supplierPartyId: supplierId, currency: "SAR", shippingMinor: 0, discountMinor: 0,
    lines: [{ id: randomUUID(), itemId, kind: "stock", quantity: "3", conversion: conversion(), price: { state: "known", currency: "SAR", unitPriceMinor: 10000, reason: "Synthetic quote" },
      trackLot: true, requiresExpiry: true, minimumShelfLifeDays: 30, sources: [{ id: randomUUID(), requestId: r.id, requestLineId: r.lines[0].id, baseQuantity: "150" }] }] };
  expect((await post("manager", operation("order.issue", { document: o }))).status).toBe(201);
  const receipt: ReceiptRevision = { id: randomUUID(), version: 1, orderId: o.id, orderVersion: 1, branchId: "clinic", supplierPartyId: supplierId, actualArrivalDate: "2026-10-14",
    lines: [{ orderLineId: o.lines[0].id, arrivedQuantity: "2", portions: [{ id: randomUUID(), quantity: "2", disposition: "accepted", lotCode: "INV-LOT", expiryDate: "2027-11-01", locationId: store, damaged: false, reason: "Synthetic inspection" }] }] };
  const receiptBody = operation("receipt.post", { document: receipt });
  for (let retry = 0; retry < 2; retry++) {
    const response = await post("manager", receiptBody);
    expect(response.status).toBe(201);
    expect((await response.json()).remaining[0].remainingFulfillmentBaseQuantity).toBe("50");
  }
  const after = await counts();
  expect(after.stock - before.stock).toBe(1);
  expect(after.debt).toBe(before.debt);
  expect(after.cash).toBe(before.cash);
  const lineId = randomUUID();
  const invoice = { id: randomUUID(), version: 1, orderId: o.id, orderVersion: 1, branchId: "clinic", supplierPartyId: supplierId, currency: "SAR",
    invoiceNumber: missingNumber ? null : `INV-${randomUUID()}`, invoiceDate: "2026-10-14", missingNumberReason: missingNumber ? "INV official number pending" : null, shippingMinor: 0, discountMinor: 0,
    valuation: valuationSnapshot({ purpose: "invoice_valuation", currency: "SAR", amountMinor: 20000, rateToBase: "500", capturedAt: "2026-10-14T01:00:00Z", sourceRef: "synthetic invoice" }),
    lines: [{ id: lineId, orderLineId: o.lines[0].id, quantity: "2", price: { state: "known", currency: "SAR", unitPriceMinor: 10000, reason: "Synthetic invoice" },
      receiptAllocations: [{ id: randomUUID(), invoiceLineId: lineId, receiptLineId: receipt.lines[0].portions[0].id, baseQuantity: "100" }] }] };
  const matched = await post("manager", operation("invoice.match", { document: invoice }));
  expect(matched.status).toBe(201);
  expect((await matched.json()).financialPosting).toBe("pending_shared_finance_review");
  expect(await counts()).toEqual(after);
  return { order: o, invoice };
}

async function browserFor(who: Who, width: number): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ar" });
  context.setDefaultTimeout(15000);
  context.on("page", p => p.on("pageerror", e => diagnostics.pageErrors.push(e.message)));
  const page = await context.newPage();
  await page.goto(`${baseUrl}/login`);
  await page.getByLabel("اسم المستخدم", { exact: true }).fill(ACCOUNTS[who].username);
  await page.getByLabel("كلمة المرور", { exact: true }).fill(ACCOUNTS[who].password);
  await page.locator("#login-submit-btn").click();
  await page.getByTestId("canonical-shell").waitFor();
  return { context, page };
}
async function openInvoice(width: number, orderId: string) {
  const opened = await browserFor("manager", width);
  await opened.page.goto(`${baseUrl}/inventory/procurement/operations`, { waitUntil: "domcontentloaded" });
  await opened.page.getByLabel("أمر الشراء للفواتير", { exact: true }).selectOption(orderId);
  await opened.page.getByTestId("supplier-finance-invoice").waitFor();
  return opened;
}
async function confirm(page: Page, action: "post" | "cancel", reason: string) {
  await page.getByTestId("supplier-finance-invoice").getByRole("button", { name: action === "post" ? "ترحيل مستحق المورد" : "إلغاء الفاتورة غير المسدّدة", exact: true }).click();
  const form = page.getByTestId("supplier-confirmation");
  await form.getByLabel("سبب العملية", { exact: true }).fill(reason);
  await form.getByRole("button", { name: "تأكيد العملية", exact: true }).click();
}
const sameIntentEnabled = (page: Page) => page.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find(x => x.textContent?.includes("إعادة تأكيد العملية نفسها"));
  return b && !b.disabled;
});

describe("canonical inventory & procurement journey", () => {
  it("navigation is the exact projection of grants over the registered inventory pages", async () => {
    const pagesOf = async (who: Who) => {
      const { context, page } = await browserFor(who, 1280);
      try {
        const nav = page.getByRole("navigation", { name: "شاشات الهوية الموحّدة" });
        return (await nav.getByRole("link").evaluateAll(links => links.map(a => new URL((a as HTMLAnchorElement).href).pathname))).filter(p => p !== "/");
      } finally { await context.close(); }
    };
    expect(await pagesOf("requester")).toEqual(["/inventory/procurement", "/inventory/custody", "/inventory/procurement/setup"]);
    expect(await pagesOf("manager")).toEqual(["/inventory/procurement", "/inventory/procurement/review", "/inventory/procurement/operations", "/inventory/procurement/setup"]);
    expect(await pagesOf("keeper")).toEqual(["/inventory/custody", "/inventory/procurement/setup"]);
    // A nested page never inherits its parent's grant: the requester gets the workspace notice.
    const { context, page } = await browserFor("requester", 390);
    try {
      await page.goto(`${baseUrl}/inventory/procurement/operations`);
      await page.getByTestId("canonical-workspace").waitFor();
    } finally { await context.close(); }
    expect(await ddlLog()).toEqual([]);
  });

  it("every view and command is admitted by its exact capability; refusals are Arabic", async () => {
    const status = async (who: Who, view: string) => (await get(who, view)).status;
    expect(await status("requester", "")).toBe(200);
    expect(await status("requester", "?view=catalog")).toBe(200);
    expect(await status("requester", "?view=custody")).toBe(200);
    expect(await status("requester", "?view=workbench")).toBe(403);
    expect(await status("requester", `?view=supplier-finance&orderId=${randomUUID()}`)).toBe(403);
    expect(await status("manager", "?view=workbench")).toBe(200);
    expect(await status("manager", "?view=custody")).toBe(403);
    expect(await status("keeper", "")).toBe(403);
    expect(await status("keeper", "?view=first-use-readiness")).toBe(200);
    const refused = await get("keeper", "?view=workbench");
    expect((await refused.json()).message).toMatch(ARABIC);
    // A legacy-shaped request without a canonical cookie is unauthenticated.
    expect((await api("/api/inventory/procurement", "")).status).toBe(401);
    for (const command of ["order.issue", "receipt.post", "invoice.match", "custody.dispatch", "legacy.reconcile"]) {
      const response = await post("requester", operation(command, { document: { id: randomUUID(), version: 1, lines: [] }, transfer: { lines: [] }, reconciliation: {} }));
      expect(response.status, command).toBe(403);
    }
    expect(await ddlLog()).toEqual([]);
  });

  it("procurement cycle through the route keeps stock, debt and cash exact before posting", async () => {
    const { order } = await fixture();
    const bench = await (await get("manager", "?view=workbench")).json();
    expect(bench.orders.some((row: { id: string }) => row.id === order.id)).toBe(true);
    const mine = await (await get("requester", "")).json();
    expect(mine.items.every((row: { document: { value: unknown } }) => row.document.value === null)).toBe(true);
    expect(await ddlLog()).toEqual([]);
  });

  it.each([390, 1280])("supplier panel reviews, revises, posts and cancels unpaid supplier debt at %ipx", async (width) => {
    const f = await fixture(), before = await counts();
    const { context, page } = await openInvoice(width, f.order.id);
    try {
      await page.getByTestId("supplier-finance-invoice").getByRole("button", { name: "مراجعة الإصدار", exact: true }).click();
      const editor = page.getByTestId("supplier-revision-form");
      await editor.getByLabel("سبب المراجعة", { exact: true }).fill(`INV review ${width}`);
      await editor.getByRole("button", { name: "حفظ الإصدار الجديد", exact: true }).click();
      await page.getByTestId("supplier-finance-invoice").getByRole("heading", { name: `${f.invoice.invoiceNumber} · إصدار 2`, exact: true }).waitFor();
      await confirm(page, "post", `INV reviewed posting ${width}`);
      await page.getByTestId("supplier-finance-invoice").getByText("مستحق مُرحّل", { exact: true }).waitFor();
      expect(await page.getByTestId("supplier-finance-invoice").innerText()).toContain("200.00");
      // The legacy supplier-ledger page is not canonical yet (M2): no link to it.
      expect(await page.getByRole("link", { name: "كشف المورد والسداد", exact: true }).count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${artifacts}/canonical-supplier-posted-ar-${width}.png`, fullPage: true });
      await confirm(page, "cancel", `INV explicit unpaid cancellation ${width}`);
      await page.getByTestId("supplier-finance-invoice").getByText("ملغاة ماليًا", { exact: true }).waitFor();
      await page.screenshot({ path: `${artifacts}/canonical-supplier-cancelled-ar-${width}.png`, fullPage: true });
      expect(await counts()).toEqual({ ...before, debt: before.debt + 1 });
      const view = await (await get("manager", `?view=supplier-finance&orderId=${f.order.id}`)).json();
      expect(view.invoices[0]).toMatchObject({ status: "cancelled", effectiveMinor: 0, settledMinor: 0 });
    } finally { await context.close(); }
    expect(await ddlLog()).toEqual([]);
  });

  it("lost admission and execution replies retain one exact intent across reload, 403 and two tabs", async () => {
    const f = await fixture(), before = await counts();
    const { context, page } = await openInvoice(390, f.order.id);
    const admissions: string[] = [], executions: string[] = [];
    let refuse = true, abortAdmission = true, abortExecution = true, finalReplies = 0, releaseReplies!: () => void;
    const bothReplies = new Promise<void>(resolve => { releaseReplies = resolve; });
    await context.route("**/api/inventory/procurement", async route => {
      if (route.request().method() !== "POST") return route.continue();
      const raw = route.request().postData()!, body = JSON.parse(raw);
      if (body.command === "supplier.admit") {
        admissions.push(raw);
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        if (abortAdmission) { abortAdmission = false; return route.abort(); }
        return route.fulfill({ response });
      }
      if (body.command === "supplier.execute") {
        executions.push(raw);
        if (executions.length > 1 && refuse) { refuse = false; return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ code: "operation_forbidden" }) }); }
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        if (abortExecution) { abortExecution = false; return route.abort(); }
        finalReplies++;
        if (finalReplies === 2) releaseReplies();
        await bothReplies;
        return route.fulfill({ response });
      }
      return route.continue();
    });
    try {
      await confirm(page, "post", "INV lost replies exact command");
      await page.getByTestId("supplier-saved-intent").getByRole("button", { name: "إعادة تأكيد العملية نفسها", exact: true }).waitFor();
      await sameIntentEnabled(page);
      for (let round = 0; round < 2; round++) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByLabel("أمر الشراء للفواتير", { exact: true }).selectOption(f.order.id);
        await page.getByRole("button", { name: "إعادة تأكيد العملية نفسها", exact: true }).click();
        await sameIntentEnabled(page);
      }
      expect(await page.getByTestId("supplier-saved-intent").count()).toBe(1);
      const second = await context.newPage();
      await second.goto(`${baseUrl}/inventory/procurement/operations`, { waitUntil: "domcontentloaded" });
      await second.getByRole("button", { name: "إعادة تأكيد العملية نفسها", exact: true }).waitFor();
      await Promise.all([
        page.getByRole("button", { name: "إعادة تأكيد العملية نفسها", exact: true }).click(),
        second.getByRole("button", { name: "إعادة تأكيد العملية نفسها", exact: true }).click(),
      ]);
      await Promise.all([
        page.getByTestId("supplier-saved-intent").waitFor({ state: "detached" }),
        second.getByTestId("supplier-saved-intent").waitFor({ state: "detached" }),
      ]);
      expect(admissions.length).toBeGreaterThanOrEqual(2);
      expect(new Set(admissions).size).toBe(1);
      expect(executions.length).toBeGreaterThanOrEqual(4);
      expect(new Set(executions).size).toBe(1);
      expect(await counts()).toEqual({ ...before, debt: before.debt + 1 });
    } finally { await context.close(); }
    expect(await ddlLog()).toEqual([]);
  });

  it("another browser's pending intent durably rejects a new nonce and recovers a lost refusal reply", async () => {
    const f = await fixture(), before = await counts();
    const view = await (await get("manager", `?view=supplier-finance&orderId=${f.order.id}`)).json(), i = view.invoices[0];
    const original = { protocol: "inventory-supplier-v2", authority: view.authority, nonce: randomUUID(), action: "post",
      input: { invoiceId: i.invoiceId, expectedVersion: i.version, expectedDigest: i.digest, reason: "INV original other-browser intent" } };
    const admitted = await post("manager", { command: "supplier.admit", intent: original });
    expect(admitted.status).toBe(201);
    const originalAdmission = await admitted.json();
    const { context, page } = await openInvoice(390, f.order.id);
    let lost = true;
    const attempts: string[] = [];
    await context.route("**/api/inventory/procurement", async route => {
      if (route.request().method() !== "POST") return route.continue();
      const raw = route.request().postData()!;
      expect(JSON.parse(raw).command).toBe("supplier.admit");
      attempts.push(raw);
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      expect((await response.json()).status).toBe("rejected");
      if (lost) { lost = false; return route.abort(); }
      return route.fulfill({ response });
    });
    try {
      await confirm(page, "post", "INV duplicate browser intent");
      await sameIntentEnabled(page);
      expect(await page.getByTestId("supplier-confirmation").getByRole("button", { name: "تأكيد العملية", exact: true }).isDisabled()).toBe(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "إعادة تأكيد العملية نفسها", exact: true }).click();
      await page.getByTestId("supplier-saved-intent").waitFor({ state: "detached" });
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toBe(attempts[1]);
      expect(await counts()).toEqual(before);
      expect((await db.query("SELECT 1 FROM inventory_supplier_intents WHERE intent_nonce=$1", [original.nonce])).rowCount).toBe(1);
      expect((await db.query("SELECT 1 FROM inventory_operations WHERE operation_key=$1", [originalAdmission.envelope.operationKey])).rowCount).toBe(0);
    } finally { await context.close(); }
  });

  it("custody statement scope and controls follow grants and the validated clinician link", async () => {
    const { order } = await fixture();
    const lot = (await db.query<{ id: string }>("SELECT l.id::text FROM stock_lots l JOIN goods_receipt_lines g ON g.id=l.receipt_line_id WHERE g.order_id=$1 LIMIT 1", [order.id])).rows[0].id;
    const transfer = { id: randomUUID(), fromLocationId: store, toLocationId: custody, transitLocationId: transit, reason: "INV custody supply", lines: [{ id: randomUUID(), lotId: lot, quantity: "10" }] };
    expect((await post("requester", operation("custody.dispatch", { transfer }))).status).toBe(403);
    expect((await post("keeper", operation("custody.dispatch", { transfer }))).status).toBe(201);
    expect((await post("requester", operation("custody.acknowledge", { acknowledgement: { id: randomUUID(), transferId: transfer.id, reason: "INV count",
      lines: [{ lineId: transfer.lines[0].id, acceptedQuantity: "10", returnedQuantity: "0" }] } }))).status).toBe(201);
    const doctorView = await (await get("requester", "?view=custody")).json();
    expect(doctorView.locations.map((row: { id: string }) => row.id)).toEqual([custody]);
    expect(doctorView.pricesAllowed).toBe(false);
    for (const [who, dispatchVisible] of [["requester", false], ["keeper", true]] as const) {
      const { context, page } = await browserFor(who, 390);
      try {
        await page.goto(`${baseUrl}/inventory/custody`, { waitUntil: "domcontentloaded" });
        await page.getByTestId("doctor-custody").waitFor();
        await page.getByTestId("custody-usage-form").or(page.getByTestId("custody-dispatch-form")).first().waitFor();
        expect(await page.getByTestId("custody-dispatch-form").count()).toBe(dispatchVisible ? 1 : 0);
        expect(await page.getByTestId("custody-waste-approval-form").count()).toBe(0);
        await page.screenshot({ path: `${artifacts}/canonical-custody-${who}-390.png`, fullPage: true });
      } finally { await context.close(); }
    }
    expect(await ddlLog()).toEqual([]);
  });

  it("an editor revocation kills the live cookie; a fresh login gets exactly the narrowed scope", async () => {
    const live = await login("manager");
    expect((await api("/api/inventory/procurement?view=workbench", live)).status).toBe(200);
    const ownerCookie = await login("owner");
    const target = await (await api(`/api/staff-access/${ids.manager}`, ownerCookie)).json();
    const narrowed = { ...MANAGER, "finance.suppliers.view": false, "inventory.supplier-invoices.record": false, "inventory.supplier-invoices.cancel": false };
    const edit = await api(`/api/staff-access/${ids.manager}`, ownerCookie, { method: "PATCH", body: JSON.stringify({ expectedRevision: target.revision, patientScope: "none", appointmentScope: "none", grants: narrowed }) });
    expect(edit.status).toBe(200);
    expect((await api("/api/inventory/procurement?view=workbench", live)).status).toBe(401);
    const fresh = await login("manager");
    expect((await api("/api/inventory/procurement?view=workbench", fresh)).status).toBe(200);
    const supplier = await api(`/api/inventory/procurement?view=supplier-finance&orderId=${randomUUID()}`, fresh);
    expect(supplier.status).toBe(403);
    expect((await supplier.json()).message).toMatch(ARABIC);
    expect(await ddlLog()).toEqual([]);
  });
});
