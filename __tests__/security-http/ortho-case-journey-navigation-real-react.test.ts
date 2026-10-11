import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tailwindConfig from "../../tailwind.config";
import type {} from "../fixtures/ortho-case-journey-navigation-real-react";
import { retainIndependentOrthoEvidence } from "./_ortho-independent-evidence";

// Isolated real React/component fixture. No clinical HTTP, database, auth or owner integration proof.
// Uses the repository's actual Tailwind configuration and component classes, not copied fixture CSS.
let browser: Browser, script: string, styles: string;
beforeAll(async () => {
  const entry = "__tests__/fixtures/ortho-case-journey-navigation-real-react.tsx";
  const bundle = await build({ absWorkingDir: process.cwd(), entryPoints: [entry], bundle: true, write: false,
    platform: "browser", format: "iife", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": JSON.stringify("development") } });
  script = bundle.outputFiles[0].text;
  const content = await Promise.all([entry, "components/OrthoCaseJourneyNavigation.tsx"].map(async path => ({ raw: await readFile(path, "utf8"), extension: "tsx" })));
  styles = (await postcss([tailwindcss({ ...tailwindConfig, content })]).process("@tailwind base; @tailwind components; @tailwind utilities;", { from: undefined })).css;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 120000);
afterAll(async () => { await browser?.close(); });
async function open(width: number) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: true, locale: "ar-YE", serviceWorkers: "block" });
  const outside: string[] = [], errors: string[] = [];
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:47893" && url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.origin === "http://127.0.0.1:47893" && url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: styles });
    if (url.origin === "http://127.0.0.1:47893" && url.pathname === "/") return route.fulfill({ contentType: "text/html", body:
      '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
    outside.push(url.origin + url.pathname); await route.abort();
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:47893/"); await page.getByTestId("ortho-case-journey-navigation").waitFor();
  return { page, context, outside, errors };
}
async function selectSection(page: Page, value: string, label: string) {
  const select = page.getByLabel("القسم", { exact: true });
  if (await select.isVisible()) await select.selectOption(value);
  else await page.getByRole("tab", { name: label, exact: true }).click();
}
async function selected(page: Page, step: string) {
  await expect.poll(() => page.getByTestId("selected-step").innerText()).toBe(step);
}
async function geometry(page: Page) {
  const result = await page.getByTestId("ortho-case-journey-navigation").evaluate(nav => {
    const visible = [...nav.querySelectorAll("button,select")].filter(node => node.getClientRects().length > 0);
    return { overflow: document.documentElement.scrollWidth > innerWidth,
      controls: visible.map(node => { const r = node.getBoundingClientRect(); return { width: r.width, height: r.height, left: r.left, right: r.right }; }) };
  });
  expect(result.overflow).toBe(false); expect(result.controls.length).toBeGreaterThan(0);
  for (const box of result.controls) { expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(page.viewportSize()!.width); }
}
describe("real controlled five-section journey navigation", () => {
  it.each([390, 768, 1280, 1440])("renders responsive controls and reaches ceph/study without altering the URL at %s", async width => {
    const f = await open(width);
    try {
      const url = f.page.url(); await selected(f.page, "visits"); await geometry(f.page);
      expect(await f.page.getByLabel("القسم", { exact: true }).isVisible()).toBe(width < 1024);
      expect(await f.page.getByRole("tablist").isVisible()).toBe(width >= 1024);
      expect(await f.page.locator('[role="tab"]').count()).toBe(5);
      await selectSection(f.page, "records", "السجلات والتشخيص"); await selected(f.page, "interview");
      if (width < 1024) await f.page.getByRole("combobox", { name: "خطوة القسم", exact: true }).selectOption("ceph");
      else await f.page.getByRole("button", { name: /^7\. السيفالو/ }).click();
      await selected(f.page, "ceph"); await geometry(f.page);
      await selectSection(f.page, "presentation", "عرض الحالة"); await selected(f.page, "study");
      expect(await f.page.getByRole("button", { name: "الخطوة التالية", exact: true }).isDisabled()).toBe(true);
      await f.page.getByRole("button", { name: "الخطوة السابقة", exact: true }).tap(); await selected(f.page, "outcome_retention");
      expect(f.page.url()).toBe(url); expect(f.outside).toEqual([]); expect(f.errors).toEqual([]);
      await retainIndependentOrthoEvidence(f.page, `ortho-independent-navigation-${width}`);
    } finally { await f.context.close(); }
  });
  it.each([390, 1280])("retains dirty, pending and uncertain caller state when navigation is refused at %s", async width => {
    const f = await open(width);
    try {
      await f.page.getByLabel("Synthetic retained draft").fill("Synthetic retained text");
      for (const state of ["dirty", "pending", "uncertain"] as const) {
        await f.page.evaluate(value => window.__orthoJourneyNavigationFixture.lock(value), state);
        await selectSection(f.page, "presentation", "عرض الحالة"); await selected(f.page, "visits");
        expect(await f.page.getByLabel("Synthetic retained draft").inputValue()).toBe("Synthetic retained text");
        expect((await f.page.evaluate(() => window.__orthoJourneyNavigationFixture.snapshot())).requested).toEqual([]);
        if (width < 1024) expect(await f.page.getByLabel("القسم", { exact: true }).inputValue()).toBe("summary");
      }
      await f.page.evaluate(() => { window.__orthoJourneyNavigationFixture.lock("dirty"); window.__orthoJourneyNavigationFixture.allowDirty(true); });
      await selectSection(f.page, "presentation", "عرض الحالة"); await selected(f.page, "study");
      expect(await f.page.getByLabel("Synthetic retained draft").inputValue()).toBe("Synthetic retained text");
      expect((await f.page.evaluate(() => window.__orthoJourneyNavigationFixture.snapshot())).dirty).toBe(true);
      expect(f.outside).toEqual([]); expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });
  it("uses manual activation with RTL/LTR arrows, Home, End, Enter and Space", async () => {
    const f = await open(1280);
    try {
      const summary = f.page.getByRole("tab", { name: "ملخص الحالة والجلسة", exact: true });
      const records = f.page.getByRole("tab", { name: "السجلات والتشخيص", exact: true });
      await summary.focus(); await summary.press("ArrowLeft");
      expect(await records.evaluate(node => node === document.activeElement)).toBe(true); await selected(f.page, "visits");
      expect((await f.page.evaluate(() => window.__orthoJourneyNavigationFixture.snapshot())).guardCount).toBe(0);
      await records.press("Enter"); await selected(f.page, "interview");
      await records.press("End"); await f.page.getByRole("tab", { name: "عرض الحالة", exact: true }).press("Space"); await selected(f.page, "study");
      await f.page.evaluate(() => window.__orthoJourneyNavigationFixture.locale("en"));
      const presentation = f.page.getByRole("tab", { name: "Case presentation", exact: true });
      await presentation.press("Home"); const first = f.page.getByRole("tab", { name: "Case summary and visit", exact: true });
      expect(await first.evaluate(node => node === document.activeElement)).toBe(true);
      await first.press("ArrowRight"); expect(await f.page.getByRole("tab", { name: "Records and diagnosis", exact: true }).evaluate(node => node === document.activeElement)).toBe(true);
      await selected(f.page, "study"); expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });
  it("leaves acceptance with the caller and cannot let a delayed old scope override a newer case", async () => {
    const f = await open(390);
    try {
      await f.page.evaluate(() => window.__orthoJourneyNavigationFixture.mode("hold"));
      await selectSection(f.page, "presentation", "عرض الحالة"); await selected(f.page, "visits");
      expect(await f.page.getByLabel("القسم", { exact: true }).inputValue()).toBe("summary");
      await f.page.evaluate(() => window.__orthoJourneyNavigationFixture.replaceScope("interview")); await selected(f.page, "interview");
      await f.page.evaluate(() => window.__orthoJourneyNavigationFixture.release(0)); await selected(f.page, "interview");
      await f.page.evaluate(() => window.__orthoJourneyNavigationFixture.permission(false));
      await selectSection(f.page, "presentation", "عرض الحالة");
      expect((await f.page.evaluate(() => window.__orthoJourneyNavigationFixture.snapshot())).requested).toHaveLength(1);
      expect(f.outside).toEqual([]); expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });
  it("keeps repeated asynchronous navigation requests controlled while the caller accepts only its latest intent", async () => {
    const f = await open(1280);
    try {
      await f.page.evaluate(() => window.__orthoJourneyNavigationFixture.mode("hold"));
      await selectSection(f.page, "presentation", "عرض الحالة");
      await selectSection(f.page, "records", "السجلات والتشخيص");
      await selected(f.page, "visits");
      await f.page.evaluate(() => window.__orthoJourneyNavigationFixture.release(0)); await selected(f.page, "visits");
      await f.page.evaluate(() => window.__orthoJourneyNavigationFixture.release(1)); await selected(f.page, "interview");
      expect((await f.page.evaluate(() => window.__orthoJourneyNavigationFixture.snapshot())).requested.map(value => value.to)).toEqual(["study", "interview"]);
      expect(f.outside).toEqual([]); expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });
});
