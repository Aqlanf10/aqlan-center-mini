import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Page } from "playwright";
import { beforeAll, describe, expect, it, vi } from "vitest";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import tailwindConfig from "../../tailwind.config";
import { SETTING_DEFAULTS } from "../../lib/settings";
import { matchesPrintPdfWord, type PrintPdfPage } from "../helpers/print-pdf-glyphs";
import { assertHrNativePdf } from "../helpers/hr-native-print-pdf";

const fixture = vi.hoisted(() => ({ rows: 3 }));
const settings = { ...SETTING_DEFAULTS, "clinic.phone": "777000123" };
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ role: "admin" }) }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));
vi.mock("@/lib/db", () => ({ getSettingsSafe: async () => settings }));
vi.mock("@/lib/reports", () => ({ dbTodayISO: async () => "2031-01-15" }));
vi.mock("@/lib/hr", async () => ({
  ...await import("../../lib/hr-shared"),
  listStaff: async () => Array.from({ length: fixture.rows }, (_, index) => {
    const currency = (["YER", "SAR", "USD"] as const)[index % 3];
    return { id: index + 1, fullName: `HS${String(index + 1).padStart(3, "0")} موظف اصطناعي`,
      jobTitle: "وظيفة اصطناعية", department: "secretariat", workStatus: "active", hireDate: "2030-01-01", endDate: null, userId: null,
      currentPay: { asOf: "2031-01-15", effectiveOn: "2030-01-01", source: "contract", blockers: [],
        terms: { kind: "salary", currency, salaryPeriod: "monthly", salaryMinor: ({ YER: 150000, SAR: 150055, USD: 150099 })[currency] },
        contract: { contractNumber: `HC${String(index + 1).padStart(3, "0")}`, versionNumber: 1 } },
    };
  }),
  listTasks: async () => ({
    tasks: Array.from({ length: fixture.rows }, (_, index) => ({ id: index + 1,
      title: `HT${String(index + 1).padStart(3, "0")} مهمة اصطناعية لمراجعة الطباعة`, status: "planned", priority: "normal",
      assigneeLabel: "مسؤول اصطناعي", ownerDisplayName: "مالك اصطناعي", plannedFor: "2031-01-15", dueAt: "2031-01-16T10:00:00Z", overdueDays: 0, isPrivate: false })),
    overdueCount: 0, counts: { planned: fixture.rows, in_progress: 0, blocked: 0, completed: 0, cancelled: 0 },
  }),
}));
import StaffPage from "../../app/print/hr/staff/page";
import TasksPage from "../../app/print/hr/tasks/page";
import { PrintDocumentWatermark } from "../../components/PrintDocument";

let globalCss: string;
beforeAll(async () => {
  globalCss = (await postcss([tailwindcss(tailwindConfig), autoprefixer()])
    .process(readFileSync(resolve("app/globals.css"), "utf8"), { from: resolve("app/globals.css") })).css;
});
const output = resolve(".settings-ui-artifacts/unified-print");
const plain = (text: string) => text.normalize("NFKC").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
type Kind = "staff" | "tasks";

/** Remove only the repair, reproducing the real pre-fix screen-sized sheet. */
function withoutHrPrintReset(source: string): string {
  const css = postcss.parse(source);
  let removed = 0;
  css.walkRules(rule => {
    if (rule.parent?.type !== "atrule" || rule.parent.name !== "media" || rule.parent.params !== "print") return;
    if (rule.selector.replace(/\s/g, "") !== ".hr-staff-sheet,.hr-tasks-sheet") return;
    const declarations: Record<string, string> = {};
    rule.walkDecls(declaration => { declarations[declaration.prop] = declaration.value; });
    if (JSON.stringify(declarations) === JSON.stringify({ width: "auto", "min-height": "0", margin: "0", padding: "0" })) {
      rule.remove(); removed++;
    }
  });
  expect(removed, "negative control removes exactly the scoped HR print reset").toBe(1);
  return css.toString();
}

async function inspectPdf(page: Page, name: string): Promise<{ pages: PrintPdfPage[]; text: string }> {
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode().catch(() => undefined))); });
  await page.emulateMedia({ media: "print" });
  await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
  const bytes = await page.pdf({ path: resolve(output, `${name}.pdf`), format: "A4", preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
  const xml = execFileSync("pdftotext", ["-bbox-layout", "-enc", "UTF-8", "-", "-"], { input: bytes, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const pages = await page.evaluate(raw => {
    const doc = new DOMParser().parseFromString(raw, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("Invalid HR native PDF geometry");
    return [...doc.getElementsByTagName("page")].map(sheet => ({ width: Number(sheet.getAttribute("width")), height: Number(sheet.getAttribute("height")),
      words: [...sheet.getElementsByTagName("word")].map(word => ({ text: word.textContent ?? "", xMin: Number(word.getAttribute("xMin")), xMax: Number(word.getAttribute("xMax")), yMin: Number(word.getAttribute("yMin")), yMax: Number(word.getAttribute("yMax")) })) }));
  }, xml);
  const text = plain(execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], { input: bytes, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
  writeFileSync(resolve(output, `${name}-geometry.json`), JSON.stringify({ syntheticOnly: true, pages, text }, null, 2));
  return { pages, text };
}

function assertNativeHr(result: { pages: PrintPdfPage[]; text: string }, kind: Kind, rows: number) {
  const { pages, text } = result;
  assertHrNativePdf(pages, { landscape: kind === "staff", short: rows < 10, clinicName: settings["clinic.name"] });
  for (const sheet of pages) {
    const rowMarker = kind === "staff" ? /^HS\d{3}$/ : /^HT\d{3}$/;
    if (sheet.words.some(word => rowMarker.test(plain(word.text)))) {
      expect(sheet.words.some(word => matchesPrintPdfWord(word.text, kind === "staff" ? "الاسم" : "المهمة")),
        "each continuation containing HR rows repeats its table heading").toBe(true);
    }
  }
  for (let row = 1; row <= rows; row++) {
    const marker = `${kind === "staff" ? "HS" : "HT"}${String(row).padStart(3, "0")}`;
    expect(text.match(new RegExp(`\\b${marker}\\b`, "g")), `complete row ${marker} occurs once`).toHaveLength(1);
    if (kind === "staff") expect(text.match(new RegExp(`\\bHC${String(row).padStart(3, "0")}\\b`, "g"))).toHaveLength(1);
  }
  expect(text.match(/777000123/g), "contact footer is complete and occurs once").toHaveLength(1);
  if (kind === "staff") {
    // Three independent native currencies: no unit conversion or amount loss.
    for (const amount of ["150,000", "1,500.55", "1,500.99"]) {
      expect(text.match(new RegExp(`\\b${amount.replaceAll(".", "\\.")}\\b`, "g"))).toHaveLength(rows / 3 + (rows === 3 ? 1 : 0));
    }
  }
}

describe("actual HR routes keep native page bounds and complete financial text", () => {
  it.each([{ kind: "staff", rows: 3 }, { kind: "tasks", rows: 4 }, { kind: "staff", rows: 60 }, { kind: "tasks", rows: 80 }] as const)("$kind with $rows rows", async ({ kind, rows }) => {
    fixture.rows = rows;
    const before = fixture.rows;
    const node = await (kind === "staff" ? StaffPage : TasksPage)({ searchParams: Promise.resolve({}) });
    const markup = renderToStaticMarkup(<><PrintDocumentWatermark /><div className="print-root">{node}</div></>);
    expect(fixture.rows).toBe(before);
    const logo = `data:image/png;base64,${readFileSync(resolve("public/logo.png")).toString("base64")}`;
    const shared = globalCss + readFileSync(resolve("components/print-document.css"), "utf8");
    const printCss = readFileSync(resolve("app/print/print.css"), "utf8");
    const html = (css: string) => `<!doctype html><html lang="ar" dir="rtl"><style>${shared}${css}</style><body>${markup.replaceAll('src="/logo.png"', `src="${logo}"`)}</body></html>`;
    mkdirSync(output, { recursive: true });
    const name = `hr-native-${kind}-${rows}`;
    writeFileSync(resolve(output, `${name}-source.json`), JSON.stringify({ syntheticOnly: true, kind, rows, html: html(printCss) }, null, 2));
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    try {
      const page = await browser.newPage();
      await page.route("**/*", route => route.abort());
      await page.setContent(html(printCss));
      const current = await inspectPdf(page, name);
      assertNativeHr(current, kind, rows);
      if (rows < 10) {
        await page.setContent(html(withoutHrPrintReset(printCss)));
        const negative = await inspectPdf(page, `${name}-before-fix-negative`);
        expect(() => assertNativeHr(negative, kind, rows), "the same native PDF oracle rejects the pre-fix sheet").toThrow();
      }
    } finally { await browser.close(); }
  });
});
