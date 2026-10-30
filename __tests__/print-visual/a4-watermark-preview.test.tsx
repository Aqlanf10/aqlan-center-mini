import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium, type Page } from "playwright";
import { beforeAll, describe, expect, it } from "vitest";

const output = resolve(".settings-ui-artifacts/unified-print");
const logoBytes = readFileSync(resolve("public/logo.png"));
const logo = `data:image/png;base64,${logoBytes.toString("base64")}`;
const css = readFileSync(resolve("components/print-document.css"), "utf8") + readFileSync(resolve("app/print/print.css"), "utf8");
let script: string;
beforeAll(async () => {
  mkdirSync(output, { recursive: true });
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {PrintDocumentWatermark} from './components/PrintDocumentWatermark';
    import {PrintHeader} from './components/PrintHeader';
    import {PrintTableFrame} from './components/PrintDocument';
    import {SETTING_DEFAULTS} from './lib/settings';
    const f=window.fixture;
    createRoot(document.body).render(<><PrintDocumentWatermark src={${JSON.stringify(logo)}} />
      <div className="print-actions"><button onClick={()=>{window.unrelatedClicks=(window.unrelatedClicks||0)+1}}>Unrelated</button></div>
      <div className="print-root"><div className="print-actions"><button data-print-document-action onClick={()=>{window.previewClicks=(window.previewClicks||0)+1}}>اطبع</button></div>
      <div className={f.kind} id="canvas"><PrintHeader settings={SETTING_DEFAULTS} title="Synthetic A4 statement" />
        {Array.from({length:f.tables},(_,t)=><PrintTableFrame key={t}><table><tbody>
          {Array.from({length:f.rows},(_,i)=><tr key={i}><td style={{height:24}}>SYNTHETIC {t}-{i}</td><td>123</td></tr>)}
        </tbody></table></PrintTableFrame>)}
        <p>END OF SYNTHETIC DOCUMENT</p>
      </div></div></>);
  ` }, bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
  script = bundle.outputFiles[0].text;
});
async function mount(page: Page, kind: string, tables: number, rows: number) {
  await page.route("**/logo.png", route => route.fulfill({ contentType: "image/png", body: logoBytes }));
  await page.setContent(`<!doctype html><html><head><base href="http://synthetic.invalid/"><style>*{box-sizing:border-box}body{margin:0}${css}@page{size:A4;margin:8mm}</style></head><body></body></html>`);
  await page.evaluate(fixture => { (window as unknown as { fixture: unknown }).fixture = fixture; }, { kind, tables, rows });
  await page.addScriptTag({ content: script });
  await page.locator("#canvas .print-brand-header").waitFor();
}
async function assertFixedBox(page: Page, landscape = false) {
  const mark = await page.locator(".a4-preview-watermark").boundingBox();
  const canvas = await page.locator("#canvas").boundingBox();
  expect(mark).not.toBeNull(); expect(canvas).not.toBeNull();
  expect(Math.abs(mark!.width - 76 * 96 / 25.4)).toBeLessThan(1);
  expect(Math.abs(mark!.height - 65 * 96 / 25.4)).toBeLessThan(1);
  expect(Math.abs(mark!.x + mark!.width / 2 - canvas!.x - canvas!.width / 2)).toBeLessThan(1);
  expect(Math.abs(mark!.y + mark!.height / 2 - canvas!.y - (landscape ? 105 : 148.5) * 96 / 25.4)).toBeLessThan(1);
  expect(await page.locator(".a4-preview-watermark").evaluate(node => getComputedStyle(node).opacity)).toBe("0.15");
}
describe("one physical A4 preview logo, independent of table count/content", () => {
  it.each([{ kind: "sheet sheet-a4", tables: 0 }, { kind: "sheet sheet-a4", tables: 1 }, { kind: "sheet sheet-a4", tables: 3 }, { kind: "print-sheet hr-staff-sheet", tables: 2 }, { kind: "print-sheet hr-tasks-sheet", tables: 2 }])("$kind with $tables tables", async ({ kind, tables }) => {
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
      await mount(page, kind, tables, 2);
      await page.locator(".a4-preview-watermark").waitFor();
      expect(await page.locator(".a4-preview-watermark").count()).toBe(1);
      await assertFixedBox(page, kind.includes("hr-staff"));
      const canvasWidth = (await page.locator("#canvas").boundingBox())!.width;
      expect(Math.abs(canvasWidth - (kind.includes("hr-staff") ? 297 : 210) * 96 / 25.4)).toBeLessThan(1);
      expect(await page.locator(".print-table-watermark").evaluateAll(nodes => nodes.every(node => getComputedStyle(node).display === "none"))).toBe(true);
      await page.screenshot({ path: resolve(output, `a4-preview-${kind.includes("hr-staff") ? "landscape" : "portrait"}-${tables}.png`), fullPage: true });
      await page.emulateMedia({ media: "print" });
      expect(await page.locator(".a4-preview-watermark").isVisible()).toBe(false);
      expect(await page.locator("body > .print-document-watermark").isVisible()).toBe(true);
    } finally { await browser.close(); }
  });
  it("long document uses explicit native preview and one image per printed page, not scroll midpoint", async () => {
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
      await mount(page, "sheet sheet-a4", 3, 28);
      await page.getByRole("button", { name: "معاينة صفحات الطباعة" }).waitFor();
      expect(await page.locator(".a4-preview-watermark").count()).toBe(0);
      await page.getByRole("button", { name: "معاينة صفحات الطباعة" }).click();
      expect(await page.evaluate(() => (window as unknown as { previewClicks: number }).previewClicks)).toBe(1);
      expect(await page.evaluate(() => (window as unknown as { unrelatedClicks?: number }).unrelatedClicks || 0)).toBe(0);
      await page.emulateMedia({ media: "print" });
      expect(await page.locator(".a4-preview-notice").isVisible()).toBe(false);
      expect(await page.locator(".print-table-watermark").evaluateAll(nodes => nodes.every(node => getComputedStyle(node).display === "none"))).toBe(true);
      const pdf = resolve(output, "a4-preview-long.pdf");
      await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
      const pages = Number(execFileSync("pdfinfo", [pdf], { encoding: "utf8" }).match(/Pages:\s+(\d+)/)![1]);
      expect(pages).toBeGreaterThan(1);
      const images = [...execFileSync("pdfimages", ["-list", pdf], { encoding: "utf8" }).matchAll(/^\s*(\d+)\s+\d+\s+image\s+1000\s+846\s/gm)].map(match => Number(match[1]));
      expect(images).toHaveLength(pages + 1); // one header total + one watermark on each page
      for (let p = 1; p <= pages; p++) expect(images.filter(value => value === p)).toHaveLength(p === 1 ? 2 : 1);
      const text = execFileSync("pdftotext", [pdf, "-"], { encoding: "utf8" });
      expect(text).toContain("END OF SYNTHETIC DOCUMENT");
      expect(text).not.toContain("معاينة صفحات الطباعة");
    } finally { await browser.close(); }
  });
  it.each(["staff", "tasks"])("native HR %s watermark is centered on physical paper despite asymmetric margins", async kind => {
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    try {
      const page = await browser.newPage();
      await mount(page, `print-sheet hr-${kind}-sheet`, 2, 28);
      await page.evaluate(async () => { await Promise.all([...document.images].map(image => image.decode().catch(() => undefined))); });
      const pdf = resolve(output, `a4-preview-hr-${kind}-center.pdf`);
      await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
      const xml = execFileSync("pdftohtml", ["-xml", "-stdout", "-zoom", "1", "-noroundcoord", pdf], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
      const geometry = await page.evaluate(raw => {
        const doc = new DOMParser().parseFromString(raw, "application/xml");
        if (doc.querySelector("parsererror")) throw new Error("Invalid native PDF image geometry");
        return [...doc.getElementsByTagName("page")].map(sheet => ({
          width: Number(sheet.getAttribute("width")), height: Number(sheet.getAttribute("height")),
          marks: [...sheet.getElementsByTagName("image")].map(image => ({
            x: Number(image.getAttribute("left")), y: Number(image.getAttribute("top")),
            width: Number(image.getAttribute("width")), height: Number(image.getAttribute("height")),
          })).filter(image => image.width > 100),
        }));
      }, xml);
      writeFileSync(resolve(output, `a4-preview-hr-${kind}-center.json`), JSON.stringify({ syntheticOnly: true, geometry }, null, 2));
      expect(geometry.length).toBeGreaterThan(1);
      for (const sheet of geometry) {
        expect(sheet.marks).toHaveLength(1);
        const mark = sheet.marks[0];
        expect(Math.abs(mark.x + mark.width / 2 - sheet.width / 2)).toBeLessThan(1.5);
        expect(Math.abs(mark.y + mark.height / 2 - sheet.height / 2)).toBeLessThan(1.5);
      }
    } finally { await browser.close(); }
  });
  it("screen-first report adapters use a native-page notice, not a fake paper canvas", async () => {
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    try {
      const page = await browser.newPage();
      await mount(page, "print-document-on-print", 2, 2);
      await page.locator(".a4-preview-notice").waitFor();
      expect(await page.getByRole("button", { name: "معاينة صفحات الطباعة" }).count()).toBe(0);
      expect(await page.locator(".a4-preview-watermark").count()).toBe(0);
      expect(await page.locator("#canvas").getAttribute("data-a4-preview-paper")).toBe("false");
      expect(await page.locator(".print-table-watermark").evaluateAll(nodes => nodes.every(node => getComputedStyle(node).display === "none"))).toBe(true);
      await page.emulateMedia({ media: "print" });
      expect(await page.locator(".a4-preview-notice").isVisible()).toBe(false);
    } finally { await browser.close(); }
  });
  it.each(["sheet sheet-a5", "sheet sheet-a6"])("leaves %s geometry and previews untouched", async kind => {
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    try {
      const page = await browser.newPage(); await mount(page, kind, 1, 2);
      expect(await page.locator(".a4-preview-canvas, .a4-preview-watermark, .a4-preview-notice").count()).toBe(0);
      await page.emulateMedia({ media: "print" });
      const width = await page.locator("body > .print-document-watermark").evaluate(node => node.getBoundingClientRect().width);
      expect(Math.abs(width - (kind.endsWith("a6") ? 52 : 64) * 96 / 25.4)).toBeLessThan(1);
    } finally { await browser.close(); }
  });
});
