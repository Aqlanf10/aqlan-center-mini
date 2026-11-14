import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { chromium, type Browser } from "playwright";
import type { MeasurementValueDraftV2 } from "../../lib/ortho-assessment-measurement-editor-v2";

// Real React + browser for the actual editors, with synthetic records and
// in-memory ownership. HTTP/RBAC and persisted save proof live in the workup test.
let browser: Browser, script: string, css: string;
beforeAll(async () => {
  const bundle = await build({ stdin: { resolveDir: process.cwd(), sourcefile: "synthetic-value-first.jsx", loader: "jsx", contents: `
    import React,{useState,useLayoutEffect} from 'react';
    import {createRoot} from 'react-dom/client';
    import {flushSync} from 'react-dom';
    import {OrthoAssessmentFindingsV2} from './components/OrthoAssessmentFindingsV2';
    import {OrthoAssessmentMeasurementsV2} from './components/OrthoAssessmentMeasurementsV2';
    import {newAssessmentEditorV2} from './lib/ortho-assessment-editor-v2';
    const root=createRoot(document.getElementById('root'));let current=null, grant=true, changes=0, sequence=0;
    function Fixture({mode}) {
      const [draft,setDraft]=useState(()=>newAssessmentEditorV2('synthetic-'+sequence,null).measurements);
      useLayoutEffect(()=>{current=draft;return()=>{if(current===draft)current=null}},[draft]);
      const owner={renderEditable:grant,active:()=>grant&&current===draft,editable:()=>grant&&current===draft};
      window.fixture.read=()=>({values:draft.values,changes});
      const props={draft,owner,sources:[],onChange:next=>{if(owner.active()){changes++;setDraft(next)}}};
      return <main dir="rtl" className="mx-auto max-w-6xl p-3">
        {mode==='measurements'?<OrthoAssessmentMeasurementsV2 {...props}/>:<OrthoAssessmentFindingsV2 {...props} focusGroup={mode}/>}
      </main>;
    }
    window.fixture={mount:mode=>{grant=true;changes=0;sequence++;flushSync(()=>root.render(<Fixture key={sequence} mode={mode}/>))},revoke:()=>{grant=false}};
  ` }, bundle: true, write: false, jsx: "automatic", platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  script = bundle.outputFiles[0].text;
  await mkdir(".settings-ui-artifacts", { recursive: true });
  execFileSync(process.execPath, ["node_modules/tailwindcss/lib/cli.js", "-i", "app/globals.css", "-o", ".settings-ui-artifacts/ortho-editor-fixture.css"], { stdio: "pipe" });
  css = await readFile(".settings-ui-artifacts/ortho-editor-fixture.css", "utf8");
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
});
afterAll(async () => { await browser?.close(); });
type FixtureWindow = Window & { fixture: {
  mount(mode: "history" | "facial" | "intraoral" | "measurements"): void;
  read(): { values: Record<string, MeasurementValueDraftV2>; changes: number };
  revoke(): void;
} };

describe("value-first clinical entry in real React", () => {
  it.each([390, 1280])("keeps blank values untouched and makes shared provenance explicit and cancellable at %ipx", async width => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, locale: "ar-YE" });
    const writes: string[] = [], errors: string[] = [];
    page.on("request", request => { if (!["GET", "HEAD"].includes(request.method())) writes.push(request.url()); });
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.setContent('<div id="root"></div>'); await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.mount("history"));
      const complaint = page.getByLabel("الشكوى الرئيسية — اختيار قابل للبحث أو نص حر", { exact: true });
      const dental = page.getByLabel("التاريخ السني — اختيار قابل للبحث أو نص حر", { exact: true });
      expect(await complaint.isVisible()).toBe(true); expect(await dental.isVisible()).toBe(true);
      expect(await page.evaluate(() => (window as unknown as FixtureWindow).fixture.read().changes)).toBe(0);
      await complaint.fill("ملاحظة اصطناعية"); await dental.fill("تاريخ سني اصطناعي");
      const read = () => page.evaluate(() => (window as unknown as FixtureWindow).fixture.read());
      expect((await read()).values.clinical_chiefComplaint.state).toBe("recorded");
      expect((await read()).values.clinical_medicalHistory.state).toBe("not_recorded");
      await page.getByLabel("الحقل المرجعي لمصدر الجلسة", { exact: true }).selectOption("clinical_chiefComplaint");
      await page.getByLabel("حالة تاريخ الشكوى الرئيسية", { exact: true }).selectOption("unknown");
      await page.getByLabel("سبب غياب تاريخ الشكوى الرئيسية", { exact: true }).fill("التاريخ غير موثق في المثال الاصطناعي");
      await page.getByLabel("طريقة توثيق الشكوى الرئيسية", { exact: true }).selectOption("direct_examination");
      await page.getByLabel("وصف طريقة توثيق الشكوى الرئيسية", { exact: true }).fill("مقابلة اصطناعية واحدة");
      await page.getByRole("button", { name: "اختيار الحقول المدخلة في القسم الحالي (1)", exact: true }).click();
      const preview = page.getByRole("region", { name: "مراجعة مصدر حقول الفحص", exact: true });
      expect(await preview.innerText()).toContain("التاريخ السني"); expect(await preview.innerText()).not.toContain("مرجع التاريخ الطبي");
      const before = await read();
      page.once("dialog", dialog => void dialog.dismiss());
      await page.getByRole("button", { name: "تطبيق مصدر الجلسة على 1 حقول مختارة", exact: true }).click();
      expect(await read()).toEqual(before);
      page.once("dialog", dialog => void dialog.accept());
      await page.getByRole("button", { name: "تطبيق مصدر الجلسة على 1 حقول مختارة", exact: true }).click();
      expect((await read()).values.clinical_dentalHistory).toMatchObject({ text: "تاريخ سني اصطناعي", dateState: "unknown", dateReason: "التاريخ غير موثق في المثال الاصطناعي", methodDescription: "مقابلة اصطناعية واحدة" });
      expect((await read()).values.clinical_medicalHistory).toEqual(before.values.clinical_medicalHistory);
      await page.getByRole("button", { name: "إغلاق مصدر الجلسة", exact: true }).click();
      await complaint.fill(""); expect((await read()).values.clinical_chiefComplaint).toMatchObject({ state: "recorded", text: "", method: "direct_examination" });
      await page.getByLabel("حالة التاريخ العائلي", { exact: true }).selectOption("not_measured");
      await page.getByLabel("سبب حالة التاريخ العائلي", { exact: true }).fill("لم يُفحص في هذا المثال");
      expect((await read()).values.clinical_familyHistory).toMatchObject({ state: "not_measured", reason: "لم يُفحص في هذا المثال" });
      await page.getByLabel("حالة تاريخ وتقييم النمو", { exact: true }).selectOption("unavailable");
      await page.getByLabel("سبب حالة تاريخ وتقييم النمو", { exact: true }).fill("رفض الفحص في المثال الاصطناعي");
      expect((await read()).values.clinical_growthHistory).toMatchObject({ state: "unavailable", reason: "رفض الفحص في المثال الاصطناعي" });
      await page.screenshot({ path: `.settings-ui-artifacts/ortho-direct-history-${width}.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(writes).toEqual([]); expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it("keeps numeric entry, exceptions and shared source review distinct, and rejects a revoked grant during confirmation", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    try {
      await page.setContent('<div id="root"></div>'); await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.mount("measurements"));
      const number = page.getByLabel("قيمة السن 11 (mm)", { exact: true });
      expect(await number.isVisible()).toBe(true); await number.fill("7.2");
      await page.getByLabel("قيمة السن 12 (mm)", { exact: true }).fill("6.8");
      await page.getByLabel("حالة السن 13", { exact: true }).selectOption("tooth_absent");
      await page.getByLabel("سبب السن 13", { exact: true }).fill("غائب في المثال الاصطناعي");
      const read = () => page.evaluate(() => (window as unknown as FixtureWindow).fixture.read());
      expect((await read()).values.width_11).toMatchObject({ state: "measured", numberText: "7.2", method: "" });
      expect((await read()).values.width_14.state).toBe("not_recorded");
      await page.getByLabel("القياس المرجعي لمصدر الجلسة", { exact: true }).selectOption("width_11");
      await page.getByLabel("حالة تاريخ الفحص", { exact: true }).selectOption("unknown");
      await page.getByLabel("سبب غياب تاريخ الفحص", { exact: true }).fill("تاريخ المثال غير معلوم");
      await page.getByLabel("طريقة القياس", { exact: true }).selectOption("manual_record_measurement");
      await page.getByLabel("وصف طريقة القياس", { exact: true }).fill("قياس نموذج اصطناعي");
      await page.getByRole("button", { name: "اختيار القياسات المدخلة في هذه المجموعة (2)", exact: true }).click();
      const preview = page.getByRole("region", { name: "مراجعة تطبيق مصدر الجلسة", exact: true });
      expect(await preview.innerText()).toContain("FDI 12"); expect(await preview.innerText()).toContain("FDI 13");
      // Excluding a measurement removes it from the reviewed preview (the checkbox is not left unchecked in place).
      await preview.getByLabel("إبقاء FDI 13 ضمن التطبيق", { exact: true }).click();
      await expect.poll(async () => preview.innerText()).not.toContain("FDI 13"); expect(await preview.innerText()).toContain("FDI 12");
      const before = await read();
      await page.evaluate(() => {
        window.confirm = () => { (window as unknown as FixtureWindow).fixture.revoke(); return true; };
      });
      await page.getByRole("button", { name: "تطبيق مصدر الجلسة على 1 مدخلات مختارة", exact: true }).click();
      expect(await read()).toEqual(before);
      await page.screenshot({ path: ".settings-ui-artifacts/ortho-direct-measurements-1280.png", fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await page.close(); }
  });
});
