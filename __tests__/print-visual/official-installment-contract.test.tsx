import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DebtRepaymentAgreementPrint } from "../../components/DebtRepaymentAgreementPrint";
import type { readSavedRepaymentAgreement } from "../../lib/debt-repayment-agreement-db";
import { debtInstallmentProgress } from "../../lib/debt-installments";
import { formatMoney } from "../../lib/money";
import { SETTING_DEFAULTS } from "../../lib/settings";
import { PrintDocumentWatermark } from "../../components/PrintDocument";

type Agreement = NonNullable<Awaited<ReturnType<typeof readSavedRepaymentAgreement>>>;
const state = vi.hoisted(() => ({ agreement: null as Agreement | null }));
vi.mock("../../lib/debt-repayment-agreement-db", () => ({ readSavedRepaymentAgreement: async () => state.agreement }));
vi.mock("../../components/PrintButton", () => ({ PrintButton: () => null }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("Missing synthetic print agreement"); } }));

const artifactRoot = resolve(".settings-ui-artifacts/official-contract-print");
const reset = `*,::before,::after{box-sizing:border-box;border-width:0;border-style:solid}
html{line-height:1.5}body,p,h1,h2,h3,ol,ul{margin:0}ol,ul{padding:0;list-style:none}
h1,h2,h3{font-size:inherit;font-weight:inherit}table{border-collapse:collapse;border-color:inherit}
img{display:block;max-width:100%;height:auto}.object-contain{object-fit:contain}.h-9{height:2.25rem}.w-9{width:2.25rem}`;

function syntheticAgreement(count: number): Agreement {
  const installments = Array.from({ length: count }, (_, index) => ({
    kind: index === 0 ? "down_payment" as const : "installment" as const,
    dueDate: new Date(Date.UTC(2031, index, 13)).toISOString().slice(0, 10),
    amountMinor: 12_300 + index * 100,
  }));
  const revisionPrincipalMinor = installments.reduce((total, row) => total + row.amountMinor, 0);
  const netSettledSinceRevisionMinor = Math.floor(revisionPrincipalMinor / 3);
  const remainingMinor = revisionPrincipalMinor - netSettledSinceRevisionMinor;
  return {
    source: { patient_id: 99001, full_name: "مريض فحص بصري صناعي", patient_number: "SYNTHETIC-PRINT-99001", phone: null, invoice_number: "SYNTHETIC-INVOICE-99002" },
    settings: { ...SETTING_DEFAULTS, "clinic.name": "مركز الاختبار الصناعي للأسنان", "clinic.lead_doctor": "طبيب اختبار", "clinic.lead_doctor_title": "تقويم الأسنان", "clinic.lead_doctor_credentials": "" },
    schedule: {
      id: 99003, version: 2, status: "active", target: { patientId: 99001, currency: "SAR", invoiceId: 99002, openingCurrency: null },
      terms: { mode: "installments", installments }, principalMinor: revisionPrincipalMinor + 7_700,
      collectedMinor: netSettledSinceRevisionMinor + 7_700, remainingMinor, revisionPrincipalMinor,
      sourceHash: "synthetic-visual-print-only", available: true, requiresReview: false,
      accountDueMinor: remainingMinor, collectibleMinor: remainingMinor, history: [],
      progress: debtInstallmentProgress({ principalMinor: revisionPrincipalMinor, currentRemainingMinor: remainingMinor,
        netSettledSinceRevisionMinor, installments, today: "2031-01-01" }),
    },
  };
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const required = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing print element: ${selector}`);
      return element;
    };
    const rect = (element: HTMLElement) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left };
    };
    const print = window.matchMedia("print").matches;
    const watermark = required(print ? "body > .print-document-watermark" : ".agreement-table-watermark");
    return {
      table: rect(required(".agreement-installments")), watermark: rect(watermark),
      logo: rect(required(print ? ".print-document-watermark img" : ".agreement-table-watermark img")), header: rect(required("header")),
      summary: rect(required(".agreement-financial-summary")), signatures: rect(required(".agreement-signatures")),
      opacity: getComputedStyle(watermark).opacity, pointerEvents: getComputedStyle(watermark).pointerEvents,
      logoLayer: getComputedStyle(watermark).zIndex,
      cellLayers: [...document.querySelectorAll(".agreement-installments th,.agreement-installments td")].map(cell => getComputedStyle(cell).zIndex),
      watermarkCount: document.querySelectorAll(print ? "body > .print-document-watermark" : ".agreement-table-watermark").length,
      print, viewport: { width: window.innerWidth, height: window.innerHeight },
      oldMarkHidden: getComputedStyle(required(".agreement-table-watermark")).display === "none",
      signatureBackground: getComputedStyle(required(".agreement-signatures")).backgroundColor,
    };
  });
}
function assertGeometry(g: Awaited<ReturnType<typeof geometry>>) {
  expect(g.watermarkCount).toBe(1);
  expect(g.opacity).toBe("0.15");
  expect(g.pointerEvents).toBe("none");
  expect(g.logoLayer).toBe(g.print ? "10" : "1");
  expect(g.cellLayers.every(layer => layer === "2")).toBe(true);
  expect(Math.abs(g.watermark.width - 76 * 96 / 25.4)).toBeLessThan(1);
  expect(Math.abs(g.watermark.height - 65 * 96 / 25.4)).toBeLessThan(1);
  expect(g.logo.width).toBeGreaterThan(250);
  expect(g.oldMarkHidden).toBe(g.print);
  expect(g.signatureBackground).toBe("rgba(0, 0, 0, 0)");
  const centerX = g.print ? g.viewport.width / 2 : (g.table.left + g.table.right) / 2;
  const centerY = g.print ? g.viewport.height / 2 : (g.table.top + g.table.bottom) / 2;
  expect(Math.abs((g.watermark.left + g.watermark.right) / 2 - centerX)).toBeLessThan(1);
  expect(Math.abs((g.watermark.top + g.watermark.bottom) / 2 - centerY)).toBeLessThan(1);
  expect(g.header.bottom).toBeLessThanOrEqual(g.table.top);
  expect(g.summary.bottom).toBeLessThanOrEqual(g.table.top);
  expect(g.signatures.top).toBeGreaterThanOrEqual(g.table.bottom);
}

// Hosted visual job only: ordinary Playwright Chromium, no local
// browser flags, live application, sessions, database, or external network.
describe("official agreement actual browser and PDF print evidence", () => {
  it.each([1, 2, 4, 6, 12, 24, 36, 60].map(count => ({ name: `fixed-logo-${count}`, count })))(
    "$name retains fixed physical logo size, money and every installment across printed pages", async ({ name, count }) => {
      const agreement = syntheticAgreement(count);
      state.agreement = agreement;
      const before = structuredClone(agreement);
      const markup = renderToStaticMarkup(await DebtRepaymentAgreementPrint({ id: 99003, version: 2, today: "2031-01-01" }));
      const logo = `data:image/png;base64,${readFileSync(resolve("public/logo.png")).toString("base64")}`;
      const watermark = renderToStaticMarkup(<PrintDocumentWatermark />).replaceAll('src="/logo.png"', `src="${logo}"`);
      const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>${reset}\n${readFileSync(resolve("components/print-document.css"), "utf8")}\n${readFileSync(resolve("app/print/print.css"), "utf8")}</style></head><body>${watermark}<div class="print-root">${markup.replaceAll('src="/logo.png"', `src="${logo}"`)}</div></body></html>`;
      mkdirSync(artifactRoot, { recursive: true });
      const browser = await chromium.launch();
      const requests: string[] = [];
      try {
        const context = await browser.newContext({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 1, locale: "ar-YE", timezoneId: "UTC", serviceWorkers: "block" });
        await context.route("**/*", async route => { requests.push(route.request().url()); await route.abort(); });
        const page = await context.newPage();
        page.on("request", request => { if (/^(?:https?|wss?):/.test(request.url())) requests.push(request.url()); });
        await page.setContent(html, { waitUntil: "load" });
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map(image => image.decode()));
          if ([...document.images].some(image => !image.complete || image.naturalWidth === 0)) throw new Error("Print logo failed to load");
        });
        const screen = await geometry(page);
        assertGeometry(screen);
        expect(await page.locator(".agreement-installments tbody tr").count()).toBe(count);
        const schedule = agreement.schedule;
        const summary = await page.locator(".agreement-financial-summary").innerText();
        for (const amount of [schedule.principalMinor, schedule.collectedMinor, schedule.remainingMinor]) expect(summary).toContain(formatMoney(amount, "SAR"));
        for (const [index, row] of schedule.progress!.rows.entries()) {
          const cells = page.locator(".agreement-installments tbody tr").nth(index).locator("td");
          expect(await cells.nth(2).innerText()).toBe(formatMoney(row.amountMinor, "SAR"));
          expect(await cells.count()).toBe(6);
          expect(await cells.nth(3).innerText()).toBe(formatMoney(row.settledMinor, "SAR"));
          expect(await cells.nth(4).innerText()).toBe(formatMoney(row.remainingMinor, "SAR"));
        }
        await page.screenshot({ path: resolve(artifactRoot, `${name}-screen.png`), fullPage: true });
        await page.emulateMedia({ media: "print" });
        await page.setViewportSize({ width: Math.floor(194 * 96 / 25.4), height: Math.floor(281 * 96 / 25.4) });
        const print = await geometry(page);
        assertGeometry(print);
        const pdf = resolve(artifactRoot, `${name}.pdf`);
        await page.pdf({ path: pdf, format: "A4", printBackground: false, preferCSSPageSize: true });
        const commandOptions = { encoding: "utf8" as const, timeout: 30_000, maxBuffer: 1024 * 1024 };
        const info = execFileSync("pdfinfo", [pdf], commandOptions);
        const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
        expect(Number.isInteger(pages)).toBe(true);
        expect(pages).toBeGreaterThanOrEqual(count === 60 ? 2 : 1);
        expect(pages).toBeLessThanOrEqual(count === 60 ? 4 : 1);
        const paintedLogos = [...execFileSync("pdfimages", ["-list", pdf], commandOptions).matchAll(/^\s*(\d+)\s+\d+\s+image\s+1000\s+846\s/gm)].map(match => Number(match[1]));
        for (let physicalPage = 1; physicalPage <= pages; physicalPage++) expect(paintedLogos.filter(number => number === physicalPage)).toHaveLength(physicalPage === 1 ? 2 : 1);
        const text = execFileSync("pdftotext", ["-layout", pdf, "-"], commandOptions)
          .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
          .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x0660));
        const printedDates = text.match(/\d{2}\/\d{2}\/\d{4}/g) ?? [];
        for (const row of schedule.terms.installments) {
          const [year, month, day] = row.dueDate.split("-");
          expect(printedDates.filter(date => date === `${day}/${month}/${year}`)).toHaveLength(1);
        }
        expect(printedDates).toHaveLength(count);
        expect(text.match(/\b99003\b/g) ?? []).toHaveLength(1); // Printed saved-schedule identity survives PDF export.
        const bboxXml = execFileSync("pdftotext", ["-bbox-layout", pdf, "-"], commandOptions);
        const pdfGeometry = await page.evaluate(xml => {
          const document = new DOMParser().parseFromString(xml, "application/xml");
          if (document.querySelector("parsererror")) throw new Error("Invalid PDF bounding-box XML");
          return [...document.querySelectorAll("page")].map((pdfPage, index) => {
            const width = Number(pdfPage.getAttribute("width"));
            const height = Number(pdfPage.getAttribute("height"));
            const words = [...pdfPage.querySelectorAll("word")].map(word => ({
              xMin: Number(word.getAttribute("xMin")), yMin: Number(word.getAttribute("yMin")),
              xMax: Number(word.getAttribute("xMax")), yMax: Number(word.getAttribute("yMax")),
            }));
            const finite = [width, height, ...words.flatMap(word => Object.values(word))].every(Number.isFinite);
            const outside = words.filter(word => word.xMin < -0.5 || word.yMin < -0.5
              || word.xMax > width + 0.5 || word.yMax > height + 0.5
              || word.xMax < word.xMin || word.yMax < word.yMin);
            // Bounded diagnostic geometry only, never entire extracted page text.
            return { page: index + 1, width, height, finite, wordCount: words.length,
              bounds: words.length ? { left: Math.min(...words.map(word => word.xMin)),
                top: Math.min(...words.map(word => word.yMin)), right: Math.max(...words.map(word => word.xMax)),
                bottom: Math.max(...words.map(word => word.yMax)) } : null,
              outsideCount: outside.length, outsideExamples: outside.slice(0, 10) };
          });
        }, bboxXml);
        writeFileSync(resolve(artifactRoot, `${name}-geometry.json`), JSON.stringify({ name, rows: count, pages, screen, print, pdfGeometry, networkRequests: requests.length }, null, 2));
        expect(pdfGeometry).toHaveLength(pages);
        for (const pdfPage of pdfGeometry) {
          expect(pdfPage.finite).toBe(true);
          expect(pdfPage.width).toBeGreaterThan(0);
          expect(pdfPage.height).toBeGreaterThan(0);
          expect(pdfPage.wordCount).toBeGreaterThan(0);
          expect(pdfPage.outsideCount, `PDF page ${pdfPage.page} has clipped text`).toBe(0);
        }
        execFileSync("pdftoppm", ["-scale-to", "1600", "-png", pdf, resolve(artifactRoot, `${name}-page`)], commandOptions);
        expect(readdirSync(artifactRoot).filter(file => new RegExp(`^${name}-page-\\d+\\.png$`).test(file))).toHaveLength(pages);
        expect(requests).toEqual([]);
        expect(agreement).toEqual(before);
      } finally {
        await browser.close();
        state.agreement = null;
      }
    }, 90_000,
  );
});
