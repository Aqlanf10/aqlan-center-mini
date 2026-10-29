import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Page } from "playwright";
import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import { PrintDocumentWatermark } from "../../components/PrintDocument";
import { PrintHeader } from "../../components/PrintHeader";
import { LabPricingReportModal } from "../../components/LabPricingReportModal";
import modalStyles from "../../components/PrintReportModal.module.css";
import { SETTING_DEFAULTS } from "../../lib/settings";

const output = resolve(".settings-ui-artifacts/unified-print");
const shared = readFileSync(resolve("components/print-document.css"), "utf8");
const logo = `data:image/png;base64,${readFileSync(resolve("public/logo.png")).toString("base64")}`;
function html(markup: string, extra = "") {
  return `<!doctype html><html lang="ar" dir="rtl"><style>*{box-sizing:border-box}body{margin:0;background:white}.print\\:hidden{display:none}${shared}${extra}</style><body>${markup.replaceAll('src="/logo.png"', `src="${logo}"`)}</body></html>`;
}
/** Decode PNG pixels rather than comparing encoder bytes/metadata. */
async function pixelDifference(page: Page, first: Buffer, second: Buffer) {
  return page.evaluate(async ([a, b]) => {
    const decode = async (encoded: string) => {
      const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d"); if (!context) throw new Error("PNG pixel decoder unavailable");
      context.drawImage(image, 0, 0);
      return { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const [left, right] = await Promise.all([decode(a), decode(b)]);
    if (left.width !== right.width || left.height !== right.height) throw new Error("Compared pixel dimensions changed");
    let differentPixels = 0;
    for (let offset = 0; offset < left.pixels.length; offset += 4) {
      if ([0, 1, 2, 3].some(channel => left.pixels[offset + channel] !== right.pixels[offset + channel])) differentPixels++;
    }
    return differentPixels;
  }, [first.toString("base64"), second.toString("base64")]);
}
function modalCss() {
  return readFileSync(resolve("components/PrintReportModal.module.css"), "utf8")
    .replace(/:global\(([^)]+)\)/g, "$1").replace(/\.modal\b/g, `.${modalStyles.modal}`).replace(/\.landscape\b/g, `.${modalStyles.landscape}`);
}
describe("hosted watermark isolation and protected-pixel behavior", () => {
  it("prints two actual lab sections without sibling content or duplicate page marks", async () => {
    const markup = renderToStaticMarkup(<><PrintDocumentWatermark /><p>SYNTHETIC-HIDDEN-SIBLING</p><main><LabPricingReportModal
      laboratories={[{ id: 99001, name: "SYNTHETIC-LAB-A", currency: "SAR", isActive: true, deliveryDays: 3 }, { id: 99002, name: "SYNTHETIC-LAB-B", currency: "SAR", isActive: true, deliveryDays: 3 }]}
      services={[{ id: 99100, name: "خدمة صناعية فقط", code: "SYNTH-SERVICE", category: "prostho", toothScope: "single_tooth", requiresShade: false, defaultDays: 3, description: null, isActive: true, sortOrder: 1 }]}
      rules={[99001, 99002].map((id, index) => ({ id: 99200 + index, partyId: id, labServiceId: 99100, costMinor: 123456, costCurrency: "SAR" as const, effectiveFrom: "2000-01-01", effectiveTo: null, note: `SYNTHETIC-ROW-${index}`, createdBy: "synthetic", createdAt: "2000-01-01" }))}
      onClose={() => {}} /></main></>);
    mkdirSync(output, { recursive: true }); const browser = await chromium.launch();
    try {
      const page = await browser.newPage(); await page.route("**/*", route => route.abort()); await page.setContent(html(markup, modalCss())); await page.emulateMedia({ media: "print" });
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.decode().catch(() => undefined))); });
      expect(await page.locator("body > .print-document-watermark").count()).toBe(1);
      expect(await page.locator("body > .print-document-watermark").isVisible()).toBe(true);
      expect(await page.getByText("SYNTHETIC-HIDDEN-SIBLING").isVisible()).toBe(false);
      expect(await page.locator(".print-table-watermark").evaluateAll(nodes => nodes.every(node => getComputedStyle(node).display === "none"))).toBe(true);
      const pdf = resolve(output, "two-lab-sections.pdf"); await page.pdf({ path: pdf, format: "A4", printBackground: false });
      const text = execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" });
      expect(text).not.toContain("SYNTHETIC-HIDDEN-SIBLING"); for (const row of ["SYNTHETIC-ROW-0", "SYNTHETIC-ROW-1"]) expect(text.match(new RegExp(row, "g"))).toHaveLength(1);
      const pages = Number(execFileSync("pdfinfo", [pdf], { encoding: "utf8" }).match(/^Pages:\s+(\d+)/m)?.[1]); expect(pages).toBeGreaterThanOrEqual(2);
      const paints = [...execFileSync("pdfimages", ["-list", pdf], { encoding: "utf8" }).matchAll(/^\s*(\d+)\s+\d+\s+image\s+1000\s+846\s/gm)].map(m => Number(m[1]));
      expect(paints.length).toBe(pages + 2); for (let p = 1; p <= pages; p++) expect(paints.filter(n => n === p).length).toBeGreaterThanOrEqual(1);
    } finally { await browser.close(); }
  });
  it("leaves overlapping QR, signature and clinical-color pixels exactly unchanged", async () => {
    const qr = await QRCode.toDataURL("SYNTHETIC-QR-NO-PATIENT-DATA", { width: 100, margin: 4 });
    const signature = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="130" height="30"><path d="M5 22Q25 3 45 20T85 18T125 10" fill="none" stroke="black" stroke-width="2"/></svg>').toString("base64")}`;
    const markup = renderToStaticMarkup(<><PrintDocumentWatermark /><PrintHeader settings={SETTING_DEFAULTS} title="اختبار صناعي لحماية مناطق المستند" />
      <div className="print-watermark-protected" id="protected-pixels" style={{ position: "fixed", left: 322, top: 470, width: 150, padding: 8 }}>
        <img src={qr} alt="Synthetic QR" width={100} height={100} /><svg width="130" height="25"><rect width="65" height="25" fill="#0284c7" /><rect x="65" width="65" height="25" fill="#b91c1c" /></svg><img data-signature-img src={signature} alt="Synthetic signature" width={130} height={30} />
      </div></>);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 794, height: 1123 } }); await page.route("**/*", route => route.abort()); await page.setContent(html(markup)); await page.emulateMedia({ media: "print" });
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.decode().catch(() => undefined))); });
      mkdirSync(output, { recursive: true });
      const protectedRegion = page.locator("#protected-pixels");
      const box = await protectedRegion.boundingBox(); expect(box).not.toBeNull();
      const painted = await protectedRegion.evaluate(node => ({ background: getComputedStyle(node).backgroundColor, zIndex: getComputedStyle(node).zIndex, transform: getComputedStyle(node).transform, deviceScale: window.devicePixelRatio }));
      expect(painted).toEqual({ background: "rgb(255, 255, 255)", zIndex: "20", transform: "none", deviceScale: 1 });
      expect(box!.x).toBe(322); expect(box!.y).toBe(470);
      const logoBox = await page.locator("body > .print-document-watermark").boundingBox(); expect(logoBox).not.toBeNull();
      const logoCenter = { x: logoBox!.x + logoBox!.width / 2, y: logoBox!.y + logoBox!.height / 2 };
      expect(box!.x).toBeLessThan(logoCenter.x); expect(box!.x + box!.width).toBeGreaterThan(logoCenter.x);
      expect(box!.y).toBeLessThan(logoCenter.y); expect(box!.y + box!.height).toBeGreaterThan(logoCenter.y);
      // Place the adversarial box on device-pixel coordinates without transform
      // rasterization. The diagnostic hosted fixture differed only on the translated
      // outer top paint edge; all QR/signature/clinical pixels already matched.
      // Keep the entire protected rectangle, with no tolerance or edge removal.
      const clip = { x: Math.ceil(box!.x), y: Math.ceil(box!.y), width: Math.floor(box!.x + box!.width) - Math.ceil(box!.x), height: Math.floor(box!.y + box!.height) - Math.ceil(box!.y) };
      expect(clip).toEqual(box);
      expect(clip.width).toBeGreaterThan(140); expect(clip.height).toBeGreaterThan(100);
      const protectedWithLogo = await page.screenshot({ clip, path: resolve(output, "protected-with-logo.png") });
      const pageWithLogo = await page.screenshot({ path: resolve(output, "protected-page-with-logo.png") });
      await page.locator(".print-document-watermark").evaluate(node => { (node as HTMLElement).style.display = "none"; });
      expect(await protectedRegion.boundingBox()).toEqual(box);
      const protectedWithoutLogo = await page.screenshot({ clip, path: resolve(output, "protected-without-logo.png") });
      const pageWithoutLogo = await page.screenshot({ path: resolve(output, "protected-page-without-logo.png") });
      expect(await pixelDifference(page, protectedWithoutLogo, protectedWithLogo), JSON.stringify({ box, clip, painted })).toBe(0);
      expect(await pixelDifference(page, pageWithoutLogo, pageWithLogo)).toBeGreaterThan(0);
    } finally { await browser.close(); }
  });
});
