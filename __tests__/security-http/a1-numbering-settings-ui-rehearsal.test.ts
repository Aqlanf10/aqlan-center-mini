/**
 * Hosted browser rehearsal, not owner/provider verification. The built-app
 * half proves only that the real Settings page stays dormant. Its synthetic
 * admin cookie never enters the separate loopback fixture or its browser
 * context. The fixture cannot write to the app, DB or network.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";

const root = process.cwd();
const localRequire = createRequire(join(root, "package.json"));
const run = promisify(execFile);
const title = "ترقيم ملفات المرضى الجدد";
const saved = "أكّد الخادم اعتماد الترقيم الجديد.";
const category = "فئات الإعدادات";
let browser: Browser;

type TrialWindow = Window & { a1NumberingFixture: { saved: () => number; awaitingReadback: () => boolean } };

async function compileFixture(directory: string) {
  const fixtureModule = join(root, "__tests__/security-http/fixtures/a1-numbering-settings-slot.tsx");
  const result = await build({
    absWorkingDir: root, bundle: true, write: false, platform: "browser", jsx: "automatic", metafile: true,
    stdin: {
      contents: `import { createRoot } from "react-dom/client"; import Settings from "@/app/settings/page"; createRoot(document.querySelector("#app")).render(<Settings />);`,
      resolveDir: root, sourcefile: "isolated-numbering-settings-entry.tsx", loader: "tsx",
    },
    plugins: [{ name: "synthetic-settings-slot-only", setup(builder) {
      builder.onResolve({ filter: /^@\/components\/settings\/PatientNumberingSettingsSlot$/ }, () => ({ path: fixtureModule }));
      builder.onResolve({ filter: /^@\// }, arg => builder.resolve("./" + arg.path.slice(2), { kind: arg.kind, resolveDir: root }));
      builder.onResolve({ filter: /^next\/(navigation|link)$/ }, arg => ({ path: arg.path, namespace: "fixture-next" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture-next" }, arg => ({
        contents: arg.path === "next/link"
          ? "export default function Link(props) { return <a {...props}/>; }"
          : "const router = { refresh() {} }; export function useRouter() { return router; }",
        loader: "tsx", resolveDir: root,
      }));
    } }],
  });
  const sources = Object.keys(result.metafile.inputs);
  expect(sources.some(path => path.endsWith("app/settings/page.tsx"))).toBe(true);
  expect(sources.some(path => path.endsWith("components/settings/OwnerPatientNumberingEditor.tsx"))).toBe(true);
  expect(sources.filter(path => /(?:^|\/)lib\/(db|auth|session|patient-numbering-postgres|patient-numbering-protected-grant)\.ts$/.test(path))).toEqual([]);
  const css = join(directory, "trial.css");
  await run(process.execPath, [localRequire.resolve("tailwindcss/lib/cli.js"),
    "-i", "app/globals.css", "-c", "tailwind.config.ts", "-o", css], {
    cwd: root, env: { PATH: process.env.PATH, HOME: directory, NODE_ENV: "production" }, timeout: 30_000,
  });
  return { js: Buffer.from(result.outputFiles[0].contents), css: await readFile(css) };
}

async function startFixture(assets: Awaited<ReturnType<typeof compileFixture>>) {
  const html = '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>A1 synthetic trial</title><link rel="stylesheet" href="/trial.css"><div id="app"></div><script src="/trial.js"></script></html>';
  const assetsByPath = new Map<string, readonly [string, Buffer | string]>([
    ["/settings", ["text/html; charset=utf-8", html]],
    ["/trial.js", ["text/javascript", assets.js]],
    ["/trial.css", ["text/css", assets.css]],
    ["/api/settings", ["application/json", "{}"]],
    ["/api/auth/me", ["application/json", JSON.stringify({ role: null, displayName: "تجربة اصطناعية" })]],
  ]);
  const server = createServer((req, res) => {
    const payload = req.method === "GET" && req.url ? assetsByPath.get(req.url) : undefined;
    if (!payload) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": payload[0], "Cache-Control": "no-store" }).end(payload[1]);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

async function chooseWorkflow(page: Page, mobile = false) {
  const nav = page.getByRole("navigation", { name: category });
  await page.getByRole("heading", { name: "الإعدادات المركزية", exact: true }).waitFor();
  if (mobile) await page.getByRole("button", { name: /الفئات ·/ }).click();
  await nav.getByRole("button", { name: /رحلة المريض/ }).click();
  await page.getByRole("heading", { name: "رحلة المريض", exact: true }).waitFor();
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
});
afterAll(async () => { await browser?.close(); });

it("built Settings remains dormant under the normal synthetic admin session", async () => {
  const h = await harness();
  const origin = new URL(baseUrl).origin;
  expect(new URL(origin).hostname).toBe("127.0.0.1");
  const context = await browser.newContext({ viewport: { width: 1330, height: 950 }, locale: "ar-YE", serviceWorkers: "block" });
  try {
    await context.route("**/*", route => {
      const req = route.request();
      return new URL(req.url()).origin === origin && req.method() === "GET" ? route.continue() : route.abort();
    });
    const cookie = h.sessions.admin.cookie;
    const delimiter = cookie.indexOf("=");
    if (delimiter <= 0) throw new Error("Missing synthetic harness session");
    await context.addCookies([{ name: cookie.slice(0, delimiter), value: cookie.slice(delimiter + 1), url: origin }]);
    const page = await context.newPage();
    const numberingTraffic: string[] = [];
    page.on("request", req => {
      const pathname = new URL(req.url()).pathname;
      if (pathname.startsWith("/api/") && pathname.includes("numbering")) numberingTraffic.push(pathname);
    });
    await page.goto(`${origin}/settings`);
    await chooseWorkflow(page);
    expect(await page.getByText(title, { exact: true }).count()).toBe(0);
    expect(await page.getByRole("region", { name: "ترقيم ملفات المرضى" }).count()).toBe(0);
    expect(numberingTraffic).toEqual([]);
  } finally { await context.close(); }
});

it("in a separate no-cookie Settings fixture, reviews the exact preview and shows success only after readback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "a1-settings-browser-synthetic-"));
  try {
    const fixture = await startFixture(await compileFixture(directory));
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar-YE",
        timezoneId: "Asia/Aden", serviceWorkers: "block" });
      try {
        await context.route("**/*", route => {
          const req = route.request();
          return new URL(req.url()).origin === fixture.origin && req.method() === "GET" ? route.continue() : route.abort();
        });
        expect(await context.cookies()).toEqual([]);
        const page = await context.newPage();
        const scriptErrors: string[] = [];
        page.on("pageerror", error => scriptErrors.push(error.message));
        await page.goto(`${fixture.origin}/settings`);
        await chooseWorkflow(page, true);
        const editor = page.getByRole("region", { name: "ترقيم ملفات المرضى" });
        const current = editor.locator("dl[aria-label='آخر حالة معتمدة من الخادم']");
        await editor.getByRole("heading", { name: title, exact: true }).waitFor();
        expect(await page.locator("main[dir='rtl']").count()).toBe(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        expect(await current.innerText()).toMatch(/P[\s\S]*7000/);
        const preview = async (prefix: string, start: string) => {
          await editor.getByLabel("البادئة", { exact: true }).fill(prefix);
          await editor.getByLabel("أول رقم في السلسلة الجديدة").fill(start);
          await editor.getByLabel("سبب تغيير الترقيم").fill("تجربة اصطناعية");
          await editor.getByRole("button", { name: "اطلب معاينة من الخادم" }).click();
        };
        const saveCount = () => page.evaluate(() => (window as unknown as TrialWindow).a1NumberingFixture.saved());
        await preview("P", "7000");
        await editor.getByText("P-07000", { exact: true }).waitFor();
        expect(await saveCount()).toBe(0);
        await editor.getByRole("button", { name: "العودة إلى التعديل" }).click();
        await preview("m", "4310");
        await editor.getByText("M-04310", { exact: true }).waitFor();
        await editor.getByRole("button", { name: "اعتماد الترقيم المعروض" }).click();
        await page.waitForFunction(() => (window as unknown as TrialWindow).a1NumberingFixture.awaitingReadback());
        expect(await current.innerText()).toMatch(/P[\s\S]*7000/);
        expect(await editor.getByText(saved, { exact: true }).count()).toBe(0);
        expect(await saveCount()).toBe(1);

        // Deliberate test barrier, external to the actual presenter.
        await page.getByRole("button", { name: "تسليم قراءة الاختبار الاصطناعية" }).click();
        await editor.getByText(saved, { exact: true }).waitFor();
        expect(await current.innerText()).toMatch(/M[\s\S]*4310/);
        await preview("P", "7000");
        await editor.getByText("لم يعتمد الخادم هذا الطلب. اطلب معاينة جديدة قبل المحاولة.", { exact: true }).waitFor();
        expect(await editor.getByRole("button", { name: "اعتماد الترقيم المعروض" }).count()).toBe(0);
        expect(await saveCount()).toBe(1);
        expect(await context.cookies()).toEqual([]);
        expect(scriptErrors).toEqual([]);
      } finally { await context.close(); }
    } finally { await fixture.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
