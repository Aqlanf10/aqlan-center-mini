import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { longConsentPrintFixture } from "../fixtures/consent-print-long";

// Explicit local fixture runner: vitest run --config vitest.config.consent-pdf.mts
// No security-harness global setup, real patient, database, upload or signature.
const mocks = vi.hoisted(() => ({ patient: vi.fn(), document: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ role: "admin", username: "synthetic-pdf" }) }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: async () => true }));
vi.mock("@/lib/db", () => ({ getPatient: mocks.patient, getDocumentForDownload: mocks.document,
  getSettingsSafe: async () => ({ "clinic.name": "Synthetic fixture clinic", "clinic.address": "SYNTHETIC-CONSENT-FOOTER", "clinic.phone": "000" }) }));
import ConsentPrintPage from "../../app/print/consent/[id]/page";

it("paginates a near-limit saved snapshot with repeated context and keeps the synthetic signature image with its signer", async () => {
  const fixture = longConsentPrintFixture();
  mocks.patient.mockResolvedValue({ id: 91, fullName: "Current synthetic patient", patientNumber: "SYN-91", birthYear: 1985, gender: "male" });
  mocks.document.mockResolvedValue({ document: { id: 801, patientId: 91, visitId: null, orthoCaseId: null, adjustmentId: null,
    kind: "consent", mimeType: "image/png", note: fixture.note, takenOn: "2026-10-03", removedAt: null } });
  const html = renderToStaticMarkup(await ConsentPrintPage({ params: Promise.resolve({ id: "91" }), searchParams: Promise.resolve({ docId: "801" }) }));
  const css = await readFile("app/print/print.css", "utf8");
  const directory = ".settings-ui-artifacts/consent-pagination";
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "source.html"), html);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, locale: "ar-YE" });
    // A visible geometric fixture image, deliberately not a person's signature.
    const syntheticImage = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 300; canvas.height = 80;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#475569"; context.fillRect(5, 5, 290, 70);
      context.fillStyle = "#fff"; context.font = "18px sans-serif"; context.fillText("SYNTHETIC IMAGE ONLY", 20, 46);
      return canvas.toDataURL("image/png");
    });
    const offlineHtml = html.replaceAll("/api/documents/801", syntheticImage);
    await page.route("**/*", (route) => route.abort());
    await page.setContent(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>${css}</style></head><body><div class="print-root">${offlineHtml}</div></body></html>`, { waitUntil: "load" });
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.emulateMedia({ media: "print" });
    const image = page.locator(".consent-signatures img");
    expect(await image.evaluate((node) => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0)).toBe(true);
    expect(await page.locator(".consent-signatures").evaluate((node) => getComputedStyle(node).breakInside)).toBe("avoid");
    await page.locator(".consent-sheet").screenshot({ path: join(directory, "print-media.png") });
    const pdfPath = join(directory, "consent-a4.pdf");
    const pdf = await page.pdf({ path: pdfPath, format: "A4", printBackground: true, displayHeaderFooter: false, preferCSSPageSize: true });
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const pdfText = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, "-"], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 })
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
    const pages = pdfText.split("\f").filter((text) => text.trim());
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const [index, text] of pages.entries()) {
      for (const identity of ["SYNTHETIC-CONSENT-PATIENT", "SYNTHETIC-PROCEDURE-801", "2026-10-03", "801", "91"]) {
        expect(text, `${identity} on PDF page ${index + 1}`).toContain(identity);
      }
      expect(text, `native page number on page ${index + 1}`).toMatch(new RegExp(`\\b${index + 1}\\s*/\\s*${pages.length}\\b`));
    }
    for (const marker of fixture.markers) expect(pdfText.split(marker), `${marker} exactly once`).toHaveLength(2);
    expect(pages.filter((text) => fixture.markers.some((marker) => text.includes(marker))).length).toBeGreaterThanOrEqual(2);
    const signerPage = pages.findIndex((text) => text.includes("SYNTHETIC-SIGNATORY-801")) + 1;
    expect(signerPage).toBeGreaterThan(0);
    const imageListing = execFileSync("pdfimages", ["-list", pdfPath], { encoding: "utf8" });
    const imagePages = imageListing.split("\n").filter((line) => /^\s*\d+\s+\d+\s+image\s/.test(line)).map((line) => Number(line.trim().split(/\s+/)[0]));
    expect(imagePages).toEqual([signerPage]);
    expect(pdfText).toContain("SYNTHETIC-CONSENT-FOOTER");
    // Actual PDF text/image assertions are still not visual QA. Render every page
    // and inspect clipping, header/body clearance, RTL order and signature grouping.
  } finally { await browser.close(); }
});
