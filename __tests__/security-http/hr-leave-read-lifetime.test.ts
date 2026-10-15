import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type Page, type Route } from "playwright";

let browser: Browser, script: string;
beforeAll(async () => {
  const built = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {HrLeavesPanel} from './components/hr/LeavesPanel';import {HrAttendancePanel} from './components/hr/AttendancePanel';const root=createRoot(document.getElementById('root'));window.mount=(owner='owner-a',view='leaves')=>{window.syntheticSession={username:owner,role:'admin'};flushSync(()=>root.render(React.createElement(view==='leaves'?HrLeavesPanel:HrAttendancePanel,{isAdmin:true})));};`, resolveDir: process.cwd(), sourcefile: "hr-read-fixture.jsx", loader: "jsx" }, bundle: true, write: false, jsx: "automatic", platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"development"' }, logLevel: "silent", plugins: [{ name: "signed-session-fixture", setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)SessionProvider$/ }, () => ({ path: "session", namespace: "hr-read-fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "hr-read-fixture" }, () => ({ contents: "export const useSession=()=>window.syntheticSession;", loader: "js" }));
  } }] });
  script = built.outputFiles![0].text;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
});
afterAll(async () => { await browser?.close(); });
const requests = [{ id: 41, staffId: 1, staffName: "موظف اصطناعي أول", startDate: "2026-08-01", endDate: "2026-08-01", daysCount: 1, reason: "طلب اصطناعي", status: "pending", attachmentRefs: [] }];
const leaveData = (name = "موظف اصطناعي أول") => ({ requests: requests.map(r => ({ ...r, staffName: name })), types: [{ id: 1, code: "annual", nameAr: "سنوية" }], staff: [{ id: 1, fullName: name }, { id: 2, fullName: "موظف اصطناعي ثان" }] });
const balanceData = (staffId: number) => [{ id: staffId, staffId, leaveTypeName: `رصيد الموظف ${staffId}`, availableDays: staffId * 3, usedDays: 0, allocatedDays: staffId * 3 }];
const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
async function fixture(width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage();
  const writes: string[] = [], reads: Route[] = [], balances: Route[] = [], outside: string[] = [];
  let delayReads = false, delayBalances = false;
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:47896") { outside.push(url.href); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root" dir="rtl"></div>' });
    if (request.method() !== "GET") { writes.push(url.pathname); return json(route, { id: 41, status: "approved" }); }
    if (url.pathname === "/api/hr/leaves") { if (delayReads) { reads.push(route); return; } return json(route, leaveData()); }
    if (url.pathname === "/api/hr/leaves/balances") { if (delayBalances) { balances.push(route); return; } return json(route, balanceData(Number(url.searchParams.get("staffId")))); }
    if (url.pathname === "/api/hr/attendance/corrections") return json(route, [{ id: 41, staffId: 1, staffName: "تصحيح اصطناعي", status: "pending", requestedBy: "employee", requestedAt: "2026-08-01", reason: "تصحيح اصطناعي", newCheckIn: null, newCheckOut: null }]);
    if (["/api/hr/attendance", "/api/hr/schedules", "/api/hr/staff"].includes(url.pathname)) return json(route, []);
    outside.push(url.pathname); return route.abort();
  });
  await page.goto("http://127.0.0.1:47896"); await page.addScriptTag({ content: script });
  return { page, context, writes, reads, balances, outside, delayReads: () => { delayReads = true; }, delayBalances: () => { delayBalances = true; } };
}
async function mount(page: Page, owner = "owner-a", view = "leaves") {
  await page.evaluate(({ owner, view }) => (window as unknown as { mount(owner: string, view: string): void }).mount(owner, view), { owner, view });
}
for (const width of [390, 1280]) it(`canceling a leave or attendance decision sends no mutation at ${width}`, async () => {
  const f = await fixture(width);
  try {
    await mount(f.page); await f.page.getByRole("button", { name: "قبول", exact: true }).waitFor();
    f.page.on("dialog", dialog => dialog.dismiss());
    await f.page.getByRole("button", { name: "قبول", exact: true }).click();
    await f.page.getByRole("button", { name: "رفض", exact: true }).click();
    await mount(f.page, "owner-a", "attendance");
    await f.page.getByRole("button", { name: /طلبات التصحيح/ }).click();
    await f.page.getByRole("button", { name: "اعتماد التصحيح", exact: true }).click();
    await f.page.getByRole("button", { name: "رفض", exact: true }).click();
    expect(f.writes).toEqual([]); expect(f.outside).toEqual([]);
  } finally { await f.context.close(); }
});
it("a late employee balance cannot replace the current employee; clearing and failure remove it", async () => {
  const f = await fixture();
  try {
    await mount(f.page); await f.page.getByRole("button", { name: "قبول", exact: true }).waitFor();
    f.delayBalances(); const selector = f.page.locator("select").first();
    await selector.selectOption("1"); await expect.poll(() => f.balances.length).toBe(1);
    await selector.selectOption("2"); await expect.poll(() => f.balances.length).toBe(2);
    await json(f.balances[1], balanceData(2)); await f.page.getByText("رصيد الموظف 2", { exact: true }).waitFor();
    await json(f.balances[0], balanceData(1));
    await expect.poll(() => f.page.getByText("رصيد الموظف 1", { exact: true }).count()).toBe(0);
    await selector.selectOption(""); expect(await f.page.getByText("رصيد الموظف 2", { exact: true }).count()).toBe(0);
    await selector.selectOption("1"); await expect.poll(() => f.balances.length).toBe(3);
    await json(f.balances[2], { message: "Synthetic denied read" }, 403);
    await f.page.getByText("تعذّر تحميل رصيد الموظف المختار.", { exact: true }).waitFor();
    expect(await f.page.getByText(/رصيد الموظف [12]/).count()).toBe(0);
  } finally { await f.context.close(); }
});
it("account changes clear the old form and fence delayed reads across A to B to A", async () => {
  const f = await fixture();
  try {
    await mount(f.page); await f.page.getByRole("button", { name: "قبول", exact: true }).waitFor();
    await f.page.getByRole("button", { name: "تقديم طلب إجازة" }).click();
    f.delayReads(); await mount(f.page, "owner-b");
    expect(await f.page.getByRole("dialog").count()).toBe(0);
    expect(await f.page.getByText("موظف اصطناعي أول", { exact: true }).count()).toBe(0);
    await expect.poll(() => f.reads.length).toBe(1);
    await mount(f.page, "owner-a"); await expect.poll(() => f.reads.length).toBe(2);
    await json(f.reads[1], leaveData("سجل الحساب الحالي")); await expect.poll(() => f.page.locator("tbody").textContent()).toContain("سجل الحساب الحالي");
    await json(f.reads[0], leaveData("سجل حساب سابق خاص"));
    await expect.poll(() => f.page.getByText("سجل حساب سابق خاص", { exact: true }).count()).toBe(0);
    expect(f.writes).toEqual([]);
  } finally { await f.context.close(); }
});
it("a previous status-filter response cannot replace the current list", async () => {
  const f = await fixture();
  try {
    await mount(f.page); await f.page.getByRole("button", { name: "قبول", exact: true }).waitFor();
    f.delayReads();
    const status = f.page.getByLabel("حالة طلب الإجازة");
    await status.selectOption("pending"); await expect.poll(() => f.reads.length).toBe(1);
    await status.selectOption("approved"); await expect.poll(() => f.reads.length).toBe(2);
    await json(f.reads[1], { ...leaveData("طلب الحساب المعتمد"), requests: requests.map(r => ({ ...r, staffName: "طلب الحساب المعتمد", status: "approved" })) });
    await f.page.getByRole("button", { name: "إلغاء الإجازة وعكس الرصيد" }).waitFor();
    await json(f.reads[0], leaveData("طلب قديم قيد الانتظار"));
    await expect.poll(() => f.page.locator("tbody").textContent()).not.toContain("طلب قديم قيد الانتظار");
    f.page.once("dialog", dialog => dialog.dismiss());
    await f.page.getByRole("button", { name: "إلغاء الإجازة وعكس الرصيد" }).click();
    expect(f.writes).toEqual([]);
    // An explicitly accepted optional blank note still means approval, unlike Cancel.
    await mount(f.page, "owner-a", "attendance");
    await f.page.getByRole("button", { name: /طلبات التصحيح/ }).click();
    f.page.once("dialog", dialog => dialog.accept(""));
    await f.page.getByRole("button", { name: "اعتماد التصحيح", exact: true }).click();
    await expect.poll(() => f.writes).toEqual(["/api/hr/attendance/corrections"]);
  } finally { await f.context.close(); }
});
