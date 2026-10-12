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
async function open(width: number, populated = false) {
  const context = await browser.newContext({ viewport: { width, height: 900 } }), outside: string[] = [];
  if (populated) await context.addInitScript(() => { window.__studyEditorScenario = "populated-readonly"; });
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
  it.each([390, 1280])("preserves populated read-only tables/media and language semantics across switching and hard reload at %s", async width => {
    const f = await open(width, true);
    try {
      const study = f.page.getByTestId("ortho-case-study"), language = f.page.getByLabel("لغة العرض / Display language", { exact: true });
      const review = study.locator("section").filter({ has: f.page.getByRole("heading", { name: /(?:مراجعة النسخة المحفوظة|Review saved revision)/ }) }).first();
      const table = review.getByRole("table");
      await table.getByText("fixture-analysis-17", { exact: true }).waitFor();
      const witness = await f.page.evaluate(() => window.__studyEditorFixture.populatedWitness());
      const rows = witness.blocks.find(block => block.kind === "table")!;
      expect(rows.kind).toBe("table");
      const expectedCells = rows.kind === "table" ? rows.rows.flatMap(row => row.cells) : [];
      const checkAuthoredSemantics = async () => {
        expect(await table.getByRole("cell").allTextContents()).toEqual(expectedCells);
        expect(await table.getByRole("columnheader").evaluateAll(nodes => nodes.map(node => ({
          text: node.textContent, lang: node.getAttribute("lang"), dir: getComputedStyle(node).direction, scope: node.getAttribute("scope"),
        })))).toEqual([
          { text: "الحقل المسجل", lang: "", dir: "rtl", scope: "col" }, { text: "Recorded value", lang: "", dir: "ltr", scope: "col" },
        ]);
        for (const locator of [table.getByRole("cell"), review.locator("aside p"), review.getByText("ملاحظة الطبيب الأصلية — texte original, 12.5 mm", { exact: true }), study.locator("textarea")]) {
          expect(await locator.evaluateAll(nodes => nodes.every(node => node.getAttribute("lang") === "" && node.getAttribute("dir") === "auto"))).toBe(true);
        }
        expect(await study.getByRole("textbox", { name: /^(?:تعليق الدراسة|Study comment)$/ }).inputValue()).toBe(witness.revision!.authored.comment);
        expect(await f.page.evaluate(() => window.__studyEditorFixture.populatedWitness())).toEqual(witness);
        expect(await study.getByRole("button", { name: /^(?:حفظ مسودة الدراسة|Save study draft)$/ }).isDisabled()).toBe(true);
        expect((await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests).toEqual([]);
      };
      await checkAuthoredSemantics();
      await language.selectOption("en");
      await review.getByText("document_83 — The document was removed. No replacement was substituted.", { exact: true }).waitFor();
      await review.getByText("decision_92 — Presentation of this source type in this section is not implemented yet.", { exact: true }).waitFor();
      await review.getByText("future_reason_<b>literal</b>", { exact: true }).waitFor();
      expect(await review.locator("b").count()).toBe(0);
      await checkAuthoredSemantics();
      await retainIndependentOrthoEvidence(f.page, `ortho-populated-table-en-${width}`);
      await study.getByLabel("Study source type", { exact: true }).selectOption("document");
      const picker = study.getByRole("group", { name: "Select an existing source", exact: true });
      await picker.getByText(/The document was removed/).waitFor();
      expect(await picker.getByRole("button", { name: "Select", exact: true }).isDisabled()).toBe(true);
      await review.getByRole("combobox", { name: "Displayed saved section", exact: true }).selectOption("media_panel");
      await review.getByText(/Images selected for this section: 1/).waitFor();
      const media = study.getByRole("region", { name: "محرر استخدام الصورة", exact: true });
      // Current production mount supplies no preview callback. Exercise that
      // boundary honestly: populated recipes remain visible, no fake image URL.
      await media.getByText("المعاينة غير متاحة الآن. يمكنك متابعة تعديل المسودة وحفظها في دراسة الحالة.", { exact: true }).waitFor();
      expect(await media.getAttribute("lang")).toBe("ar");
      expect(await media.getByRole("img").count()).toBe(0);
      expect(await media.getByLabel("زاوية الميل بالدرجات", { exact: true }).inputValue()).toBe("90");
      expect(await media.getByLabel("اليسار %", { exact: true }).inputValue()).toBe("10");
      expect(await media.getByRole("button", { name: "تطبيق حدود القص", exact: true }).isDisabled()).toBe(true);
      await language.selectOption("ar");
      await review.getByText(/الصور المختارة لهذا القسم: 1/).waitFor();
      await media.scrollIntoViewIfNeeded();
      await retainIndependentOrthoEvidence(f.page, `ortho-populated-media-ar-${width}`);
      expect(await f.page.evaluate(() => window.__studyEditorFixture.populatedWitness())).toEqual(witness);
      await review.getByRole("combobox", { name: "القسم المحفوظ المعروض", exact: true }).selectOption("analysis_panel");
      await table.waitFor();
      await checkAuthoredSemantics();
      await review.getByText("document_83 — أُزيل المستند؛ لم يُستبدل بمستند آخر.", { exact: true }).waitFor();
      await study.scrollIntoViewIfNeeded();
      await retainIndependentOrthoEvidence(f.page, `ortho-populated-table-ar-${width}`);
      await language.selectOption("en");
      // Reload replays the deterministic synthetic GET data. Only displayLocale
      // is browser-persisted; this assertion is NOT real clinical persistence.
      await f.page.reload();
      await table.getByText("fixture-analysis-17", { exact: true }).waitFor();
      await expect.poll(() => study.getAttribute("lang")).toBe("en");
      await checkAuthoredSemantics();
      expect(await f.page.evaluate(() => Object.keys(localStorage))).toEqual(["aqlan.orthoStudy.displayLocale"]);
      expect(await f.page.evaluate(() => localStorage.getItem("aqlan.orthoStudy.displayLocale"))).toBe("en");
      await review.getByRole("combobox", { name: "Displayed saved section", exact: true }).selectOption("media_panel");
      await review.getByText(/Images selected for this section: 1/).waitFor();
      await media.getByText("المعاينة غير متاحة الآن. يمكنك متابعة تعديل المسودة وحفظها في دراسة الحالة.", { exact: true }).waitFor();
      await media.scrollIntoViewIfNeeded();
      await retainIndependentOrthoEvidence(f.page, `ortho-populated-media-en-${width}`);
      expect(await f.page.evaluate(() => window.__studyEditorFixture.populatedWitness())).toEqual(witness);
      expect((await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).unexpected).toEqual([]);
      expect((await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests).toEqual([]);
    } finally { await f.context.close(); }
    expect(f.outside).toEqual([]);
  });
  it.each([390, 1280])("switches display language without rewriting clinical text or a pending command at %s", async width => {
    const f = await open(width);
    const narrative = "شكوى اصطناعية بنص الطبيب — authored text 12.5 mm";
    try {
      const language = f.page.getByLabel("لغة العرض / Display language", { exact: true });
      await f.page.getByLabel("سبب حفظ النسخة", { exact: true }).fill("سبب اصطناعي محفوظ حرفيًا");
      await f.page.getByLabel("تعليق الدراسة", { exact: true }).fill(narrative);
      const before = await f.page.evaluate(() => window.__studyEditorFixture.snapshot());
      await language.selectOption("en");
      const study = f.page.getByTestId("ortho-case-study");
      expect(await study.getAttribute("lang")).toBe("en");
      expect(await study.getAttribute("dir")).toBe("ltr");
      expect(await f.page.getByRole("heading", { name: "Orthodontic case study — Synthetic 19", exact: true }).count()).toBe(1);
      expect(await f.page.getByLabel("Study comment", { exact: true }).inputValue()).toBe(narrative);
      expect(await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).toEqual(before);
      await f.page.getByRole("button", { name: "Save study draft", exact: true }).click();
      await expect.poll(async () => (await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests.length).toBe(1);
      const sent = (await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests[0];
      expect(JSON.parse(sent.body).command.content.comment).toBe(narrative);
      expect(sent.body).not.toContain("displayLocale");
      await language.selectOption("ar");
      expect(await study.getAttribute("dir")).toBe("rtl");
      await f.page.evaluate(() => window.__studyEditorFixture.commit(0, true));
      await f.page.getByRole("button", { name: "إعادة التحقق بنفس الطلب", exact: true }).waitFor();
      await language.selectOption("en");
      await f.page.getByRole("button", { name: "Recheck the same request", exact: true }).click();
      await expect.poll(async () => (await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests.length).toBe(2);
      expect((await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).requests[1]).toEqual(sent);
      await f.page.evaluate(() => window.__studyEditorFixture.commit(1, false));
      const review = f.page.getByRole("region", { name: "Saved study review", exact: true });
      await review.waitFor();
      await review.getByText(narrative, { exact: true }).waitFor();
      expect(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await retainIndependentOrthoEvidence(f.page, `ortho-study-language-en-${width}`);
      const after = await f.page.evaluate(() => window.__studyEditorFixture.snapshot());
      await language.selectOption("ar");
      await review.waitFor({ state: "hidden" });
      await f.page.getByRole("region", { name: "مراجعة الدراسة المحفوظة", exact: true }).getByText(narrative, { exact: true }).waitFor();
      expect(await f.page.evaluate(() => window.__studyEditorFixture.snapshot())).toEqual(after);
      expect(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await retainIndependentOrthoEvidence(f.page, `ortho-study-language-ar-${width}`);
      expect(after.count).toBe(1); expect(after.unexpected).toEqual([]);
    } finally { await f.context.close(); }
    expect(f.outside).toEqual([]);
  });
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
