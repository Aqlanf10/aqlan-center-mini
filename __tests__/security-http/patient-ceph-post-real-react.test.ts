import { build, type Plugin } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CephFixtureSnapshot } from "../fixtures/patient-ceph-post-real-react";
import { baseUrl, harness } from "./_server";

// Real React/StrictMode source gate in the existing isolated HTTP job.
// No production route, external network, real study write or browser credentials.
let browser: Browser, script = "";
const fixturePath = "/__test_only_patient_ceph__/", scriptPath = fixturePath + "fixture.js";
const NEW = "+ دراسة سيفالومترية جديدة", OPEN = "📐 افتح مساحة التتبع والتحليل", BUSY = "جارٍ فتح كابينة الرسم…";
const linkOnly: Plugin = { name: "ceph-next-link-anchor", setup(builder) {
  builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "next-link", namespace: "ceph-link" }));
  builder.onLoad({ filter: /.*/, namespace: "ceph-link" }, () => ({
    contents: "export default function Link({children, ...props}) { return <a {...props}>{children}</a>; }",
    loader: "tsx", resolveDir: process.cwd(),
  }));
} };
beforeAll(async () => {
  const h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  const bundle = await build({ absWorkingDir: process.cwd(),
    entryPoints: ["__tests__/fixtures/patient-ceph-post-real-react.tsx"], bundle: true, write: false,
    platform: "browser", format: "iife", jsx: "automatic", tsconfig: "tsconfig.json", metafile: true,
    define: { "process.env.NODE_ENV": JSON.stringify("development") }, plugins: [linkOnly],
  });
  expect(bundle.outputFiles).toHaveLength(1);
  const inputs = Object.keys(bundle.metafile!.inputs);
  for (const real of ["components/PatientCeph.tsx", "components/SessionProvider.tsx", "node_modules/react-dom/client.js"]) {
    expect(inputs.some((path) => path.endsWith(real))).toBe(true);
  }
  expect(inputs.some((path) => /(?:^|\/)lib\/db(?:\.|\/)|node_modules\/(?:next|pg|@electric-sql)\//.test(path))).toBe(false);
  expect(inputs.filter((path) => path.startsWith("ceph-link:"))).toEqual(["ceph-link:next-link"]);
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });
const snapshot = (page: Page): Promise<CephFixtureSnapshot> => page.evaluate(() => window.__patientCephFixture.snapshot());
const panel = (page: Page) => page.locator("#fixture-ceph");
async function open() {
  const context = await browser.newContext({ locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const external: string[] = [], errors: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== baseUrl || request.method() !== "GET") {
      external.push(request.method() + " " + url.origin + url.pathname); await route.abort(); return;
    }
    if (url.pathname === fixturePath) await route.fulfill({ status: 200, contentType: "text/html", headers: {
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
    }, body: '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>Synthetic Ceph acceptance</title></head><body><div id="root"></div><script src="' + scriptPath + '"></script></body></html>' });
    else if (url.pathname === scriptPath) await route.fulfill({ status: 200, contentType: "text/javascript", body: script });
    else if (url.pathname === "/favicon.ico") await route.fulfill({ status: 204, body: "" });
    else { external.push(request.method() + " " + url.pathname); await route.abort(); }
  });
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(baseUrl + fixturePath, { waitUntil: "domcontentloaded" });
    await page.locator("#toggle-probe").waitFor();
    await expect.poll(async () => (await snapshot(page)).setups).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => (await snapshot(page)).cleanups).toBeGreaterThanOrEqual(1);
    return { page, context, assertIsolated: async () => {
      expect((await snapshot(page)).unexpected).toEqual([]); expect(external).toEqual([]); expect(errors).toEqual([]);
    } };
  } catch (error) { await context.close(); throw error; }
}
async function openForm(page: Page) {
  await panel(page).getByRole("button", { name: NEW, exact: true }).click();
  await expect.poll(() => panel(page).getByRole("button", { name: OPEN, exact: true }).isDisabled()).toBe(false);
}
async function submit(page: Page, savedKey?: string) {
  const previousCount = (await snapshot(page)).requests.length;
  await page.evaluate(() => window.__patientCephFixture.allow());
  const button = panel(page).getByRole("button", { name: OPEN, exact: true });
  if (savedKey) await button.evaluate((element, key) => window.__patientCephFixture.capture(key, element as HTMLElement), savedKey);
  await button.click();
  await expect.poll(async () => (await snapshot(page)).requests.length).toBe(previousCount + 1);
  return (await snapshot(page)).requests.at(-1)!.id;
}
async function decodeBody(page: Page, id: number) {
  await page.evaluate((id) => window.__patientCephFixture.headers(id), id);
  await expect.poll(async () => (await snapshot(page)).requests.find((one) => one.id === id)?.jsonCalls).toBe(1);
}
async function settle(page: Page) {
  // Flush event/microtask work in the real browser without imposing clock timing.
  await page.evaluate(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
}
async function retire(page: Page, kind: string) {
  if (kind === "cancel") await panel(page).getByRole("button", { name: "إلغاء", exact: true }).click();
  else if (kind === "header") await panel(page).getByRole("button", { name: "✕ إغلاق النموذج", exact: true }).click();
  else await page.locator("#" + kind).click();
}

describe("PatientCeph creation lifetime in real React development StrictMode", () => {
  for (const boundary of ["response", "body"] as const) {
    it.each(["cancel", "header", "toggle-probe", "patient-aba", "case-aba", "principal-aba", "permission-aba"])(
      "keeps newer navigation after %s while awaiting " + boundary, async (kind) => {
        const f = await open();
        try {
          await openForm(f.page); const id = await submit(f.page, "retired-submit");
          if (boundary === "body") await decodeBody(f.page, id);
          await retire(f.page, kind);
          await f.page.evaluate(() => {
            history.replaceState(null, "", location.pathname + "?newer=choice");
            window.__patientCephFixture.replay("retired-submit");
          });
          const destination = f.page.url();
          await f.page.evaluate((id) => window.__patientCephFixture.respond(id), id); await settle(f.page);
          expect(f.page.url()).toBe(destination);
          const state = await snapshot(f.page);
          expect(state.requests).toHaveLength(1); expect(state.requests[0].aborted).toBe(true);
          expect(state.requests[0].jsonCalls).toBe(boundary === "body" ? 1 : 0);
          expect(state.callbacks).toEqual([]); await f.assertIsolated();
        } finally { await f.context.close(); }
      },
    );
  }

  it("does not let old JSON failure/finally release the reopened form's live lock", async () => {
    const f = await open();
    try {
      await openForm(f.page); const first = await submit(f.page); await decodeBody(f.page, first);
      await retire(f.page, "cancel"); await openForm(f.page); const second = await submit(f.page, "current-submit");
      await f.page.evaluate((id) => window.__patientCephFixture.badJSON(id), first); await settle(f.page);
      expect(await panel(f.page).getByRole("button", { name: BUSY, exact: true }).isDisabled()).toBe(true);
      await f.page.evaluate(() => window.__patientCephFixture.replay("current-submit"));
      expect((await snapshot(f.page)).requests).toHaveLength(2);
      await f.page.evaluate((id) => window.__patientCephFixture.respond(id, { message: "Current refusal" }, 409), second);
      await expect.poll(() => panel(f.page).getByRole("alert").textContent()).toContain("Current refusal");
      expect((await snapshot(f.page)).callbacks).toEqual([]); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("uses its synchronous latch for repeated committed handlers in one browser task", async () => {
    const f = await open();
    try {
      await openForm(f.page);
      await panel(f.page).getByRole("button", { name: OPEN, exact: true }).evaluate((element) => {
        const api = window.__patientCephFixture; api.allow(); api.capture("double-submit", element as HTMLElement);
        api.replay("double-submit"); api.replay("double-submit");
      });
      await expect.poll(async () => (await snapshot(f.page)).requests.length).toBe(1);
      const id = (await snapshot(f.page)).requests[0].id; await decodeBody(f.page, id);
      await f.page.evaluate(() => window.__patientCephFixture.replay("double-submit"));
      expect((await snapshot(f.page)).requests).toHaveLength(1);
      await retire(f.page, "cancel"); await f.page.evaluate((id) => window.__patientCephFixture.body(id, { id: 937201 }), id);
      await settle(f.page); expect((await snapshot(f.page)).callbacks).toEqual([]); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("rechecks after the real creation callback synchronously unmounts the view", async () => {
    const f = await open();
    try {
      await f.page.locator("#callback-closes").click(); await openForm(f.page);
      const id = await submit(f.page), destination = f.page.url();
      await f.page.evaluate((id) => window.__patientCephFixture.respond(id), id);
      await expect.poll(async () => (await snapshot(f.page)).callbacks).toEqual([937201]);
      expect(await panel(f.page).count()).toBe(0); expect(f.page.url()).toBe(destination);
      await f.assertIsolated();
    } finally { await f.context.close(); }
  });
});

describe("PatientCeph document selection in a reused real React component", () => {
  const imageSelect = (page: Page) => panel(page).locator("select").first();

  it("rejects a captured A image change while B's read is pending and preserves A's explicit choice", async () => {
    const f = await open();
    try {
      await f.page.evaluate(() => { window.__patientCephFixture.setImages("a", [936201, 936203]); });
      await f.page.locator("#patient-b").click(); await f.page.locator("#patient-a").click();
      await openForm(f.page); await imageSelect(f.page).selectOption("936203");
      await imageSelect(f.page).evaluate((element) => {
        window.__patientCephFixture.captureChange("old-image", element as HTMLElement);
        window.__patientCephFixture.holdDocuments();
      });
      await f.page.locator("#patient-b").click();
      await expect.poll(async () => (await snapshot(f.page)).documentReads.length).toBe(1);
      await f.page.evaluate(() => window.__patientCephFixture.replayChange("old-image", "936201"));
      await f.page.locator("#patient-a").click(); await openForm(f.page);
      expect(await imageSelect(f.page).inputValue()).toBe("936203");
      await f.page.evaluate(() => {
        window.__patientCephFixture.documentHeaders(0);
        window.__patientCephFixture.documentBody(0, [936299]);
      });
      await settle(f.page);
      expect(await imageSelect(f.page).inputValue()).toBe("936203");
      expect((await snapshot(f.page)).requests).toHaveLength(0); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("recovers to patient B's only image and submits that image without an artificial change event", async () => {
    const f = await open();
    try {
      await openForm(f.page);
      await panel(f.page).getByRole("button", { name: OPEN, exact: true }).evaluate((element) => {
        window.__patientCephFixture.capture("old-owner", element as HTMLElement);
        window.__patientCephFixture.holdDocuments();
      });
      await f.page.locator("#patient-b").click();
      await panel(f.page).getByRole("button", { name: NEW, exact: true }).click();
      expect(await imageSelect(f.page).inputValue()).toBe("");
      expect(await panel(f.page).getByRole("button", { name: OPEN, exact: true }).isDisabled()).toBe(true);
      await f.page.evaluate(() => window.__patientCephFixture.replay("old-owner"));
      expect((await snapshot(f.page)).requests).toHaveLength(0);
      await f.page.evaluate(() => {
        window.__patientCephFixture.documentHeaders(0);
        window.__patientCephFixture.documentBody(0, [936202]);
      });
      await expect.poll(() => imageSelect(f.page).inputValue()).toBe("936202");
      await expect.poll(() => panel(f.page).getByRole("button", { name: OPEN, exact: true }).isDisabled()).toBe(false);
      expect((await snapshot(f.page)).requests).toHaveLength(0);
      const id = await submit(f.page), state = await snapshot(f.page);
      expect(state.requests[0].path).toBe("/api/patients/939202/ceph");
      expect(state.requests[0].submitted).toMatchObject({ documentId: 936202 });
      await f.page.evaluate((id) => window.__patientCephFixture.respond(id, { message: "Synthetic refusal" }, 409), id);
      await expect.poll(() => panel(f.page).getByRole("alert").textContent()).toContain("Synthetic refusal");
      expect((await snapshot(f.page)).callbacks).toEqual([]); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("clears old image options and stays disabled for an empty new image list", async () => {
    const f = await open();
    try {
      await openForm(f.page);
      await f.page.evaluate(() => { window.__patientCephFixture.setImages("b", []); });
      await f.page.locator("#patient-b").click();
      await panel(f.page).getByRole("button", { name: NEW, exact: true }).click();
      await settle(f.page);
      expect(await imageSelect(f.page).inputValue()).toBe("");
      expect(await imageSelect(f.page).locator("option").allTextContents()).toEqual(["لا توجد صور في مستندات المريض"]);
      expect(await panel(f.page).getByRole("button", { name: OPEN, exact: true }).isDisabled()).toBe(true);
      expect((await snapshot(f.page)).requests).toHaveLength(0); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  it("keeps an explicit valid patient-wide choice through case A→B→A without extra GETs", async () => {
    const f = await open();
    try {
      await f.page.evaluate(() => { window.__patientCephFixture.setImages("a", [936201, 936203]); });
      await f.page.locator("#patient-b").click(); await f.page.locator("#patient-a").click();
      await openForm(f.page); await imageSelect(f.page).selectOption("936203");
      const readCount = (await snapshot(f.page)).reads.length;
      await f.page.locator("#case-aba").click(); await openForm(f.page);
      expect(await imageSelect(f.page).inputValue()).toBe("936203");
      expect((await snapshot(f.page)).reads).toHaveLength(readCount);
      expect((await snapshot(f.page)).requests).toHaveLength(0); await f.assertIsolated();
    } finally { await f.context.close(); }
  });

  for (const boundary of ["response", "body"] as const) {
    it.each(["patient", "principal", "permission"])(
      "does not republish retired %s A→B→A document " + boundary, async (kind) => {
        const f = await open();
        try {
          await openForm(f.page);
          await panel(f.page).getByRole("button", { name: OPEN, exact: true }).evaluate((element) => {
            window.__patientCephFixture.capture("old-owner", element as HTMLElement);
          });
          await f.page.locator("#" + kind + "-b").click();
          await settle(f.page);
          await f.page.evaluate(() => window.__patientCephFixture.holdDocuments());
          await f.page.locator("#" + kind + "-a").click(); // Hold this A generation's read.
          await expect.poll(async () => (await snapshot(f.page)).documentReads.length).toBe(1);
          if (boundary === "body") {
            await f.page.evaluate(() => window.__patientCephFixture.documentHeaders(0));
            await expect.poll(async () => (await snapshot(f.page)).documentReads[0].jsonCalls).toBe(1);
          }
          await f.page.locator("#" + kind + "-b").click(); await settle(f.page);
          await f.page.evaluate(() => { window.__patientCephFixture.setImages("a", [936203]); });
          await f.page.locator("#" + kind + "-a").click(); await openForm(f.page);
          await expect.poll(() => imageSelect(f.page).inputValue()).toBe("936203");
          await f.page.evaluate(() => {
            window.__patientCephFixture.documentHeaders(0);
            window.__patientCephFixture.documentBody(0, [936299]);
            window.__patientCephFixture.replay("old-owner");
          });
          await settle(f.page);
          expect(await imageSelect(f.page).inputValue()).toBe("936203");
          expect(await imageSelect(f.page).locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))).toEqual(["936203"]);
          expect(await panel(f.page).getByRole("button", { name: OPEN, exact: true }).isDisabled()).toBe(false);
          const state = await snapshot(f.page);
          expect(state.documentReads[0].aborted).toBe(true);
          expect(state.documentReads[0].jsonCalls).toBe(boundary === "body" ? 1 : 0);
          expect(state.requests).toHaveLength(0); expect(state.callbacks).toEqual([]);
          await f.assertIsolated();
        } finally { await f.context.close(); }
      },
    );
  }
});
