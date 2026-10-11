import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import tailwindConfig from "../../tailwind.config";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {} from "../fixtures/ortho-study-editor-real-react";
import { retainIndependentOrthoEvidence } from "./_ortho-independent-evidence";
let browser: Browser, script: string, styles: string;
beforeAll(async () => {
  const bundle = await build({ absWorkingDir: process.cwd(), entryPoints: ["__tests__/fixtures/ortho-study-editor-real-react.tsx"], bundle: true, write: false,
    platform: "browser", format: "iife", jsx: "automatic", tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": JSON.stringify("development") } });
  script = bundle.outputFiles[0].text;
  const content = await Promise.all(["components/OrthoCaseStudy.tsx", "components/OrthoSavedStudyReview.tsx", "components/OrthoStudyImageEditor.tsx"]
    .map(async path => ({ raw: await readFile(path, "utf8"), extension: "tsx" })));
  styles = (await postcss([tailwindcss({ ...tailwindConfig, content })]).process("@tailwind base; @tailwind components; @tailwind utilities;", { from: undefined })).css;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 120000);
afterAll(async () => { await browser?.close(); });
async function open(width: number) {
  const context = await browser.newContext({ viewport: { width, height: 900 } }), outside: string[] = [];
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:47891" && url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.origin === "http://127.0.0.1:47891" && url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${styles}</style><div id="root"></div><script src="/fixture.js"></script>` });
    outside.push(url.origin + url.pathname); await route.abort();
  });
  const page = await context.newPage(); await page.goto("http://127.0.0.1:47891/");
  await page.getByLabel("سبب حفظ النسخة", { exact: true }).waitFor();
  return { page, context, outside };
}
describe("real study React editor with strictly synthetic transport", () => {
  it.each([390, 1280])("keeps committed/lost reply identity through detach and A→B→A at %s", async width => {
    const f = await open(width);
    try {
      const reason = f.page.getByLabel("سبب حفظ النسخة", { exact: true });
      await expect.poll(() => reason.isEnabled()).toBe(true); await reason.fill("Synthetic recovery reason");
      await f.page.getByLabel("تعليق الدراسة", { exact: true }).fill("Synthetic retained A narrative");
      await f.page.getByRole("button", { name: "حفظ مسودة الدراسة", exact: true }).click();
      await expect.poll(async () => (await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests.length).toBe(1);
      await f.page.evaluate(() => window.__studyEditorFixture.detach());
      await f.page.getByTestId("ortho-case-study").waitFor({ state: "hidden" });
      await f.page.evaluate(() => { window.__studyEditorFixture.forceB(); window.__studyEditorFixture.remount(); });
      await f.page.getByRole("heading", { name: "دراسة حالة تقويم — Synthetic 20", exact: true }).waitFor();
      await f.page.getByLabel("سبب حفظ النسخة", { exact: true }).waitFor();
      await f.page.evaluate(() => window.__studyEditorFixture.forceA());
      await f.page.getByRole("heading", { name: "دراسة حالة تقويم — Synthetic 19", exact: true }).waitFor();
      await f.page.getByLabel("سبب حفظ النسخة", { exact: true }).waitFor();
      expect(await f.page.getByRole("button", { name: "حفظ مسودة الدراسة", exact: true }).isDisabled()).toBe(true);
      await f.page.evaluate(() => window.__studyEditorFixture.commit(0, true));
      const retry = f.page.getByRole("button", { name: "إعادة التحقق بنفس الطلب", exact: true });
      await expect.poll(() => retry.isEnabled()).toBe(true);
      expect(await f.page.getByLabel("تعليق الدراسة", { exact: true }).inputValue()).toBe("Synthetic retained A narrative");
      await retry.click();
      await expect.poll(async () => (await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests.length).toBe(2);
      let snapshot = await f.page.evaluate(() => window.__studyEditorFixture.snapshot()); expect(snapshot.requests[1]).toEqual(snapshot.requests[0]); expect(snapshot.count).toBe(1);
      await f.page.evaluate(() => window.__studyEditorFixture.commit(1, false));
      await expect.poll(async () => (await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).uncertain).toBe(false);
      await expect.poll(() => f.page.getByLabel("تعليق الدراسة", { exact: true }).inputValue()).toBe("Synthetic retained A narrative");
      snapshot = await f.page.evaluate(() => window.__studyEditorFixture.snapshot()); expect(snapshot.count).toBe(1); expect(snapshot.unload).toBe(false); expect(snapshot.unexpected).toEqual([]);
      const timestamp = f.page.getByRole("region", { name: "مراجعة الدراسة المحفوظة", exact: true }).locator("time");
      await expect.poll(() => timestamp.textContent()).toBe("2026-10-01T00:00:00.000Z");
      expect(await timestamp.getAttribute("datetime")).toBe("2026-10-01T00:00:00.000Z");
      expect(await timestamp.evaluate(node => getComputedStyle(node).direction)).toBe("ltr");
      await retainIndependentOrthoEvidence(f.page, `ortho-independent-study-recovered-${width}`);
    } finally { await f.context.close(); }
    expect(f.outside).toEqual([]);
  });
  it("prevents a foreign actor from replaying private pending bytes", async () => {
    const f = await open(390);
    try {
      await f.page.getByLabel("سبب حفظ النسخة", { exact: true }).fill("Private synthetic reason");
      await f.page.getByRole("button", { name: "حفظ مسودة الدراسة", exact: true }).click();
      await expect.poll(async () => (await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests.length).toBe(1);
      await f.page.evaluate(() => { window.__studyEditorFixture.otherActor(); });
      await f.page.evaluate(() => window.__studyEditorFixture.commit(0, true));
      await expect.poll(async () => (await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).pending).toBe(false);
      expect(await f.page.getByRole("button", { name: "إعادة التحقق بنفس الطلب", exact: true }).isDisabled()).toBe(true);
      expect(await f.page.getByText("Private synthetic reason", { exact: true }).count()).toBe(0);
      expect(await f.page.locator("input,textarea").evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value))).not.toContain("Private synthetic reason");
      expect((await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests).toHaveLength(1);
      await f.page.evaluate(() => window.__studyEditorFixture.readonly());
      expect((await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests).toHaveLength(1);
    } finally { await f.context.close(); }
    expect(f.outside).toEqual([]);
  });
});

it("keeps confirmed readonly data visible without a second write", async () => {
  const f = await open(390);
  try {
    await f.page.getByLabel("سبب حفظ النسخة", { exact: true }).fill("Synthetic documented reason");
    await f.page.getByLabel("تعليق الدراسة", { exact: true }).fill("Readonly preserved narrative");
    await f.page.getByRole("button", { name: "حفظ مسودة الدراسة", exact: true }).click();
    await expect.poll(async () => (await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests.length).toBe(1);
    await f.page.evaluate(() => window.__studyEditorFixture.commit(0, false));
    await expect.poll(async () => (await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).readVersion).toBe(1);
    await f.page.evaluate(() => window.__studyEditorFixture.readonly());
    await f.page.getByText("عرض فقط حسب الصلاحية الحالية.", { exact: true }).waitFor();
    expect(await f.page.getByLabel("تعليق الدراسة", { exact: true }).inputValue()).toBe("Readonly preserved narrative");
    expect(await f.page.getByLabel("تعليق الدراسة", { exact: true }).isDisabled()).toBe(true);
    expect(await f.page.getByRole("button", { name: "حفظ مسودة الدراسة", exact: true }).isDisabled()).toBe(true);
    expect((await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests).toHaveLength(1);
  } finally { await f.context.close(); }
  expect(f.outside).toEqual([]);
});


it("chooses a source into the actual sole panel after returning from a newer multi-panel revision", async () => {
  const f = await open(390);
  try {
    const reason = f.page.getByLabel("سبب حفظ النسخة", { exact: true });
    await expect.poll(() => reason.isEnabled()).toBe(true); await reason.fill("Synthetic first revision");
    await f.page.getByRole("button", { name: "حفظ مسودة الدراسة", exact: true }).click();
    await expect.poll(async () => (await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests.length).toBe(1);
    await f.page.evaluate(() => window.__studyEditorFixture.commit(0, false));
    await expect.poll(() => reason.inputValue()).toBe("");
    await f.page.getByRole("button", { name: "إضافة القسم", exact: true }).click();
    const target = f.page.getByLabel("إضافة المرجع إلى القسم", { exact: true });
    await expect.poll(() => target.locator("option").count()).toBe(2);
    await reason.fill("Synthetic second revision");
    await f.page.getByRole("button", { name: "حفظ مسودة الدراسة", exact: true }).click();
    await expect.poll(async () => (await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests.length).toBe(2);
    await f.page.evaluate(() => window.__studyEditorFixture.commit(1, false));
    await expect.poll(() => reason.inputValue()).toBe("");
    await target.selectOption({ index: 1 });
    expect(await target.inputValue()).not.toBe("cover1");
    await f.page.getByLabel("النسخة المعروضة", { exact: true }).selectOption("141");
    await expect.poll(() => target.locator("option").count()).toBe(1);
    expect(await target.inputValue()).toBe("cover1");
    await f.page.getByLabel("نوع مصدر الدراسة", { exact: true }).selectOption("diagnosis");
    await f.page.getByRole("button", { name: "اختيار", exact: true }).click();
    await expect.poll(() => f.page.locator('ol > li').first().innerText()).toContain("diagnosis_91");
    expect((await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests).toHaveLength(2);
    expect((await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).unexpected).toEqual([]);
  } finally { await f.context.close(); }
  expect(f.outside).toEqual([]);
});

it("retires held saved-panel reads after case change and refuses a mismatched immutable review hash", async () => {
  const f = await open(390);
  try {
    await f.page.getByLabel("سبب حفظ النسخة", { exact: true }).fill("Synthetic review reason");
    await f.page.getByLabel("تعليق الدراسة", { exact: true }).fill("Synthetic captured A-only comment");
    await f.page.getByRole("button", { name: "حفظ مسودة الدراسة", exact: true }).click();
    await expect.poll(async () => (await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests.length).toBe(1);
    await f.page.evaluate(() => window.__studyEditorFixture.commit(0, false));
    const review = f.page.getByRole("region", { name: "مراجعة الدراسة المحفوظة", exact: true });
    await review.getByText("Synthetic captured A-only comment", { exact: true }).waitFor();
    await f.page.evaluate(() => { window.__studyEditorFixture.holdReviews(); window.__studyEditorFixture.refresh(); });
    await expect.poll(async () => (await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).heldReviews).toBeGreaterThan(0);
    await f.page.evaluate(() => window.__studyEditorFixture.forceB());
    await f.page.getByRole("heading", { name: "دراسة حالة تقويم — Synthetic 20", exact: true }).waitFor();
    await f.page.evaluate(() => window.__studyEditorFixture.releaseReviews());
    expect(await f.page.getByText("Synthetic captured A-only comment", { exact: true }).count()).toBe(0);
    await f.page.evaluate(() => { window.__studyEditorFixture.wrongReview(); window.__studyEditorFixture.forceA(); });
    await f.page.getByRole("heading", { name: "دراسة حالة تقويم — Synthetic 19", exact: true }).waitFor();
    await review.getByRole("alert").waitFor();
    expect(await review.getByText("Synthetic captured A-only comment", { exact: true }).count()).toBe(0);
    expect((await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests).toHaveLength(1);
    expect((await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).unexpected).toEqual([]);
  } finally { await f.context.close(); }
  expect(f.outside).toEqual([]);
});


it.each([false, true])("removes saved private text on review403 even when parent denial callback fails=%s", async failParent => {
  const f = await open(390);
  try {
    await f.page.getByLabel("سبب حفظ النسخة", { exact: true }).fill("Synthetic denial witness");
    await f.page.getByLabel("تعليق الدراسة", { exact: true }).fill("Synthetic currently authorized clinical comment");
    await f.page.getByRole("button", { name: "حفظ مسودة الدراسة", exact: true }).click();
    await expect.poll(async () => (await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests.length).toBe(1);
    await f.page.evaluate(() => window.__studyEditorFixture.commit(0, false));
    await f.page.getByRole("region", { name: "مراجعة الدراسة المحفوظة", exact: true }).getByText("Synthetic currently authorized clinical comment", { exact: true }).waitFor();
    await f.page.evaluate(() => { window.__studyEditorFixture.holdReviews(); window.__studyEditorFixture.refresh(); });
    await expect.poll(async () => (await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).heldReviews).toBeGreaterThan(0);
    await f.page.evaluate(fails => window.__studyEditorFixture.revokeReview(fails), failParent);
    await expect.poll(async () => (await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).ownerActive).toBe(false);
    await expect.poll(() => f.page.getByRole("region", { name: "مراجعة الدراسة المحفوظة", exact: true }).count()).toBe(0);
    await f.page.evaluate(() => window.__studyEditorFixture.releaseReviews());
    expect(await f.page.getByRole("button", { name: "حفظ مسودة الدراسة", exact: true }).count()).toBe(0);
    expect(await f.page.getByText("Synthetic currently authorized clinical comment", { exact: true }).count()).toBe(0);
    expect(await f.page.locator("input,textarea").evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value))).not.toContain("Synthetic currently authorized clinical comment");
    expect((await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests).toHaveLength(1);
    expect((await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).unexpected).toEqual([]);
  } finally { await f.context.close(); }
  expect(f.outside).toEqual([]);
});

it.each([
  { state: "not_recorded" as const, label: "غير مسجل" },
  { state: "unavailable" as const, label: "غير متاح" },
  { state: "restricted" as const, label: "مقيّد" },
])("discloses saved $state and refuses clinical blocks injected into it", async ({ state, label }) => {
  const f = await open(390);
  try {
    await f.page.evaluate(value => window.__studyEditorFixture.seedAuthoredState(value), state);
    const review = f.page.getByRole("region", { name: "مراجعة الدراسة المحفوظة", exact: true });
    await review.getByText(`حالة القسم المحفوظة: ${label}`, { exact: true }).waitFor();
    await review.getByText("Preserved synthetic authored comment", { exact: true }).waitFor();
    expect(await review.getByText("Synthetic clinical facts forbidden by panel state", { exact: true }).count()).toBe(0);
    await f.page.evaluate(value => window.__studyEditorFixture.seedAuthoredState(value, true), state);
    await review.getByRole("alert").waitFor();
    expect(await review.getByText("Synthetic clinical facts forbidden by panel state", { exact: true }).count()).toBe(0);
    expect((await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests).toHaveLength(0);
    expect((await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).unexpected).toEqual([]);
  } finally { await f.context.close(); }
  expect(f.outside).toEqual([]);
});
