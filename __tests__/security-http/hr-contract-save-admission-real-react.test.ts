import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { hrNavigationAdapter } from "./_hr-navigation-adapter";
import { chromium, type Browser, type Page } from "playwright";

// Production HrPage + ContractsPanel + receipt/admission helper + Modal run
// under real React. Only session and unrelated panels have synthetic adapters.
// No production hook or alternate mutation handler is introduced.
let browser: Browser, script: string;
beforeAll(async () => {
  const result = await build({
    stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import HrPage from './app/hr/page';const root=createRoot(document.getElementById('root'));window.mountContractOwner=(username,role='admin')=>{window.syntheticContractSession=username?{username,role}:null;flushSync(()=>root.render(React.createElement(HrPage)));};`, resolveDir: process.cwd(), sourcefile: "synthetic-contract-admission.jsx", loader: "jsx" },
    bundle: true, write: false, jsx: "automatic", platform: "browser", format: "iife",
    define: { "process.env.NODE_ENV": '"development"' }, logLevel: "silent",
    plugins: [hrNavigationAdapter, { name: "synthetic-contract-session", setup(build) {
      build.onResolve({ filter: /(?:^|\/)SessionProvider$/ }, () => ({ path: "session", namespace: "contract-fixture" }));
      build.onResolve({ filter: /(?:^|\/)hr\/(?:Tasks|Staff|Attendance|Leaves|Payroll|Reports)Panel$/ }, args => ({ path: args.path, namespace: "contract-fixture" }));
      build.onResolve({ filter: /(?:^|\/)PageHeader$/ }, () => ({ path: "header", namespace: "contract-fixture" }));
      build.onLoad({ filter: /.*/, namespace: "contract-fixture" }, args => ({ loader: "js", contents: args.path === "session"
        ? "export const useSession=()=>window.syntheticContractSession;"
        : "export const PageHeader=()=>null;export const HrTasksPanel=()=>null;export const HrStaffPanel=()=>null;export const HrAttendancePanel=()=>null;export const HrLeavesPanel=()=>null;export const HrPayrollPanel=()=>null;export const HrReportsPanel=()=>null;" }));
    } }],
  });
  if (!result.outputFiles?.[0]) throw new Error("Synthetic admission bundle was not produced");
  script = result.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 120000);
afterAll(async () => { await browser?.close(); });

type FixtureWindow = Window & {
  mountContractOwner: (username: string | null, role?: string) => void;
  retiredContractSubmit?: (event: { preventDefault: () => void }) => Promise<void>;
};
const mount = (page: Page, username: string, role = "admin") => page.evaluate(({ username, role }) => {
  (window as unknown as FixtureWindow).mountContractOwner(username, role);
}, { username, role });

async function setup() {
  const context = await browser.newContext(), page = await context.newPage();
  const mutations: string[] = [], outside: string[] = [];
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:47893") { outside.push(url.origin + url.pathname);return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root"></div>' });
    if (url.pathname === "/api/hr/contracts" && request.method() !== "GET") {
      mutations.push(request.method());
      return route.fulfill({ status: 201, contentType: "application/json", body: "{}" });
    }
    if (url.pathname === "/api/hr/staff") return route.fulfill({ contentType: "application/json", body: JSON.stringify([{ id: 8, fullName: "Synthetic staff", jobTitle: "Synthetic", department: "Synthetic" }]) });
    if (url.pathname === "/api/hr/contracts" || url.pathname === "/api/parties") return route.fulfill({ contentType: "application/json", body: "[]" });
    outside.push(url.pathname);return route.abort();
  });
  await page.goto("http://127.0.0.1:47893/");await page.addScriptTag({ content: script });
  return { page, context, mutations, outside };
}

async function fillAndCapture(page: Page) {
  const create = page.getByRole("region", { name: "إدارة العقود", exact: true }).getByRole("button", { name: /إنشاء عقد جديد/ });
  expect(await create.count()).toBe(1);
  expect(await create.isVisible()).toBe(true);
  await create.click();
  const modal = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "إنشاء عقد وظيفي جديد", exact: true }) });
  await modal.getByLabel("الموظف", { exact: true }).selectOption("8");
  await modal.getByLabel("مسمى العقد", { exact: true }).fill("Synthetic retained intent");
  await modal.locator("form").evaluate(form => {
    // Retain the actual committed React onSubmit, not a reimplemented handler.
    const key = Object.keys(form).find(key => key.startsWith("__reactProps$"));
    if (!key) throw new Error("Committed React form props are unavailable");
    const props = (form as unknown as Record<string, { onSubmit?: FixtureWindow["retiredContractSubmit"] }>)[key];
    if (typeof props.onSubmit !== "function") throw new Error("Production submit handler is unavailable");
    (window as unknown as FixtureWindow).retiredContractSubmit = props.onSubmit;
  });
}
const invokeRetired = (page: Page) => page.evaluate(async () => {
  const handler = (window as unknown as FixtureWindow).retiredContractSubmit;
  if (!handler) throw new Error("No retained production handler");
  await handler({ preventDefault() {} });
});

it.each(["owner-A-B-A", "tab-detach", "admin-revoked"])("rejects a real retained form handler after %s with zero fresh reservation or fetch", async scenario => {
  const fixture = await setup(), { page } = fixture;
  try {
    await mount(page, "synthetic-a");
    await page.getByRole("tab", { name: /العقود/ }).click();
    await fillAndCapture(page);
    if (scenario === "owner-A-B-A") {
      await mount(page, "synthetic-b");await invokeRetired(page);
      await mount(page, "synthetic-a");await invokeRetired(page);
    } else if (scenario === "tab-detach") {
      await page.getByRole("dialog").getByRole("button", { name: "إلغاء", exact: true }).click();
      await page.getByRole("tab", { name: /المهام/ }).click();await invokeRetired(page);
      await page.getByRole("tab", { name: /العقود/ }).click();await invokeRetired(page);
    } else {
      await mount(page, "synthetic-a", "doctor");await invokeRetired(page);
      await mount(page, "synthetic-a");await invokeRetired(page);
    }
    expect(fixture.mutations).toEqual([]);
    const panel = page.getByRole("region", { name: "إدارة العقود", exact: true });
    expect(await panel.getByRole("status").count()).toBe(0);
    expect(await panel.getByRole("button", { name: "عرض طلب الحفظ المعلق", exact: true }).count()).toBe(0);
    // A fresh live form remains admissible, proving that rejection was scoped
    // to the retired callback rather than a blanket broken Save control.
    await fillAndCapture(page);await invokeRetired(page);
    await expect.poll(() => fixture.mutations.length).toBe(1);
    await expect.poll(() => panel.getByText(/^نتيجة حفظ العقد غير مؤكدة/).count()).toBe(1);
    expect(fixture.mutations).toEqual(["POST"]);
    expect(fixture.outside).toEqual([]);
  } finally { await fixture.context.close(); }
}, 60000);
