import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harness, type Harness } from "./_server";
import { openHrJourneyServer } from "./_hr-isolated-server";

let h: Harness, isolated: Awaited<ReturnType<typeof openHrJourneyServer>>, browser: Browser;
let future: { periodId: number; runId: number; staffId: number }, terminal: { periodId: number; runId: number; staffId: number };
const evidence = process.env.HR_EVIDENCE_DIR ?? "/tmp/hr-contract-effective-evidence";
async function api(method: string, path: string, body?: unknown, cookie = h.sessions.admin.cookie) {
  const response = await fetch(`${isolated.baseUrl}${path}`, { method, headers: { cookie, origin: isolated.baseUrl, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function employee(name: string) {
  const created = await api("POST", "/api/hr/staff", { fullName: name, department: "secretariat", jobTitle: "استقبال تجريبي", hireDate: "2026-01-01", endDate: null, phone: null, note: null, workStatus: "active", contractKind: "salary", salaryAmountMinor: 100000, salaryCurrency: "YER", salaryPeriod: "monthly", salaryEffectiveOn: "2026-01-01" });
  expect(created.status, JSON.stringify(created.body)).toBe(201); return created.body.staff?.id ?? created.body.id;
}
async function agreement(staffId: number, startDate: string, amount: number) {
  const created = await api("POST", "/api/hr/contracts", { staffId, title: "اتفاق أجر تجريبي مؤرخ", templateKind: "support_staff", startDate, compensationKind: "salary", baseSalaryMinor: amount, salaryCurrency: "YER", salaryPeriod: "monthly" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await api("PATCH", `/api/hr/contracts/${created.body.id}`, { action: "transition", status: "approved", reason: "اعتماد اتفاق تجريبي" })).status).toBe(200);
  return created.body.id;
}
async function prepare(month: string, staffId: number) {
  const period = await api("POST", "/api/hr/payroll/periods", { periodMonth: month }); expect(period.status).toBe(201);
  const run = await api("POST", "/api/hr/payroll/runs", { action: "calculate", periodId: period.body.id, currency: "YER" }); expect(run.status).toBe(201);
  return { periodId: period.body.id, runId: run.body.id, staffId };
}
beforeAll(async () => {
  h = await harness(); isolated = await openHrJourneyServer(h);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  mkdirSync(evidence, { recursive: true });
  const futureStaff = await employee("استقبال العقد المستقبلي التجريبي");
  await agreement(futureStaff, "2099-02-01", 150000);
  future = await prepare("2099-02", futureStaff);
  const futureItems = (await api("GET", `/api/hr/payroll/runs?id=${future.runId}`)).body.items;
  expect(futureItems.find((item: { staffId: number }) => item.staffId === futureStaff)).toMatchObject({ baseSalaryMinor: 150000, blockerCodes: [] });
  expect((await api("POST", "/api/hr/payroll/runs", { action: "approve", runId: future.runId })).status).toBe(200);
  expect((await isolated.db.query("SELECT salary_amount_minor::int AS amount, salary_effective_on::text AS effective FROM hr_staff WHERE id=$1", [futureStaff])).rows[0]).toEqual({ amount: 100000, effective: "2026-01-01" });
  const terminalStaff = await employee("استقبال العقد المنتهي التجريبي"), contractId = await agreement(terminalStaff, "2026-01-01", 120000);
  expect((await api("PATCH", `/api/hr/contracts/${contractId}`, { action: "transition", status: "terminated", reason: "قرار تجريبي دون تاريخ لأثر الأجر" })).status).toBe(200);
  terminal = await prepare("2026-08", terminalStaff);
});
afterAll(async () => { await browser?.close(); await isolated?.close(); });

it("HTTP approval rejects unresolved terminal pay terms and preserves the prepared run and liabilities", async () => {
  const before = (await isolated.db.query("SELECT to_jsonb(p)::text AS value FROM payables p ORDER BY id")).rows;
  const refused = await api("POST", "/api/hr/payroll/runs", { action: "approve", runId: terminal.runId });
  expect(refused.status).toBe(409); expect(JSON.stringify(refused.body)).toContain("حالة العقد المرجعي");
  expect((await api("GET", `/api/hr/payroll/runs?id=${terminal.runId}`)).body.status).toBe("draft");
  expect((await isolated.db.query("SELECT to_jsonb(p)::text AS value FROM payables p ORDER BY id")).rows).toEqual(before);
  writeFileSync(join(evidence, "effective-http-result.json"), JSON.stringify({ syntheticOnly: true, future, terminal, refused }, null, 2));
});
it("HTTP current-account authority rejects payroll calculation after manager revocation", async () => {
  const actor = (await isolated.db.query("SELECT id FROM users WHERE username='secadmin'")).rows[0];
  const before = (await isolated.db.query("SELECT to_jsonb(r)::text AS value FROM hr_payroll_runs r ORDER BY id")).rows;
  await isolated.db.query("UPDATE users SET is_active=FALSE WHERE id=$1", [actor.id]);
  try {
    expect((await api("POST", "/api/hr/payroll/runs", { action: "calculate", periodId: terminal.periodId, currency: "YER" })).status).toBe(401);
    expect((await api("POST", "/api/hr/payroll/runs", { action: "approve", runId: terminal.runId })).status).toBe(401);
    expect((await isolated.db.query("SELECT to_jsonb(r)::text AS value FROM hr_payroll_runs r ORDER BY id")).rows).toEqual(before);
  } finally { await isolated.db.query("UPDATE users SET is_active=TRUE WHERE id=$1", [actor.id]); }
});
for (const width of [390, 1280]) it(`native payroll displays future approved pay and unresolved terminal blocker at ${width}`, async () => {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
  const pair = h.sessions.admin.cookie.split(";")[0], separator = pair.indexOf("=");
  await context.addCookies([{ name: pair.slice(0, separator), value: pair.slice(separator + 1), url: isolated.baseUrl }]);
  try {
    const page = await context.newPage(); await page.goto(`${isolated.baseUrl}/hr`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "المسير والصرف" }).click();
    const panel = page.locator('section[aria-label="إدارة المسير والصرف"]');
    await panel.locator("select").first().selectOption(String(future.periodId));
    await expect.poll(() => panel.locator("tbody").textContent()).toContain("استقبال العقد المستقبلي التجريبي");
    await page.screenshot({ path: join(evidence, `future-approved-${width}.png`), fullPage: true });
    await panel.locator("select").first().selectOption(String(terminal.periodId));
    await expect.poll(() => panel.locator("tbody").textContent()).toContain("contract_lifecycle_unresolved");
    expect(await panel.getByRole("button", { name: "اعتماد وترحيل للمالية" }).isDisabled()).toBe(true);
    await page.screenshot({ path: join(evidence, `terminal-blocked-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  } finally { await context.close(); }
});
