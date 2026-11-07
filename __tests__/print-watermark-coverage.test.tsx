import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrintDocumentWatermark } from "../components/PrintDocument";

const reviewedPrintRoutes = [
  "card/[id]/page.tsx",
  "ceph-compare/page.tsx",
  "ceph/[id]/page.tsx",
  "commission-statement/[id]/page.tsx",
  "consent/[id]/page.tsx",
  "dossier/[id]/page.tsx",
  "family-statement/[id]/page.tsx",
  "hr/contracts/[id]/page.tsx",
  "hr/payroll/[id]/page.tsx",
  "hr/staff/page.tsx",
  "hr/tasks/page.tsx",
  "invoice/[id]/page.tsx",
  "lab/[id]/page.tsx",
  "ortho-followups/page.tsx",
  "ortho-sessions/[id]/page.tsx",
  "ortho-space/[id]/page.tsx",
  "ortho-study/[id]/page.tsx",
  "party/[id]/page.tsx",
  "patient-card/[id]/page.tsx",
  "plan/[id]/page.tsx",
  "post-op/[id]/page.tsx",
  "prescription/[id]/page.tsx",
  "receipt/[id]/page.tsx",
  "referral/[id]/page.tsx",
  "report/page.tsx",
  "shift/[id]/page.tsx",
  "statement/[id]/page.tsx",
  "voucher/[id]/page.tsx",
  "walkout/[id]/page.tsx"
];

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
describe("one shared print-document watermark across all paper families", () => {
  it("has exactly one app-body owner, never a repeated header/table owner", () => {
    const layout = source("app/layout.tsx");
    expect(layout.match(/<PrintDocumentWatermark\s*\/>/g)).toHaveLength(1);
    expect(layout.indexOf("<PrintDocumentWatermark />")).toBeGreaterThan(layout.indexOf("<body"));
    for (const file of ["components/PrintHeader.tsx", "components/ReportPrintHeader.tsx", "app/print/layout.tsx"]) expect(source(file)).not.toContain("<PrintDocumentWatermark");
    const html = renderToStaticMarkup(<PrintDocumentWatermark />);
    expect(html.match(/class="print-document-watermark"/g)).toHaveLength(1);
    expect(html).toContain('src="/logo.png"'); expect(html).toContain('alt=""'); expect(html).toContain('aria-hidden="true"');
  });
  it("renders no substitute logo for unavailable source and removes a failed image", () => {
    const html = renderToStaticMarkup(<PrintDocumentWatermark src="" />);
    expect(html).toContain('data-logo-state="unavailable"'); expect(html).not.toContain("<img");
    expect(source("components/PrintDocumentWatermark.tsx")).toContain("onError={() => setFailed(true)}");
  });
  it("covers the reviewed dedicated-route manifest through their existing shared identity renderers", () => {
    const pages: string[] = [];
    function visit(path: string) { for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name); if (entry.isDirectory()) visit(full); else if (entry.name === "page.tsx") pages.push(full);
    } }
    visit(new URL("../app/print", import.meta.url).pathname);
    // Exact inventory catches both missing routes and unreviewed additions.
    const root = new URL("../app/print", import.meta.url).pathname;
    expect(pages.map(page => relative(root, page)).sort()).toEqual(reviewedPrintRoutes);
    expect(pages.some(page => page.endsWith("/ortho-study/[id]/page.tsx"))).toBe(true);
    for (const page of pages) expect(readFileSync(page, "utf8")).toMatch(/PrintHeader|PrintableReportDocument/);
  });
  it("uses fixed-size agreement/page marks and retains compact paper choice", () => {
    const css = source("components/print-document.css");
    expect(css).toContain("body:has(.print-brand-header) > .print-document-watermark");
    expect(css).toContain("position: fixed;"); expect(css).toContain("opacity: .15;");
    expect(css).toContain("body:has(> .print-document-watermark) :is(.print-table-watermark, .agreement-table-watermark) { display: none; }");
    expect(css).toContain("top: min(50%, 66mm)"); expect(css).toContain("top: min(50%, 97mm)");
    expect(css).not.toMatch(/@page[^}]*size:\s*A[56]/);
  });
  it("protects original QR, stored signature, and clinical pixels above decoration", () => {
    const css = source("components/print-document.css");
    expect(css).toContain(".print-watermark-protected, .sign-row, .print-document-signatures, [data-signature-img]");
    expect(css).toContain("position: relative; z-index: 20;");
    expect(css).toContain("body:has(> .print-document-watermark) :is(.print-watermark-protected, [data-signature-img])");
    expect(css).not.toMatch(/:is\([^)]*\.sign-row[^)]*\)\s*\{[^}]*background-color/);
    expect(source("app/print/consent/[id]/page.tsx")).toContain('<img data-signature-img src={`/api/documents/${resolution.documentId}`}');
    expect(source("app/print/lab/[id]/page.tsx")).toContain('className="print-watermark-protected" src={qrCodeDataUrl}');
    expect(source("app/print/ceph/[id]/page.tsx")).toContain('className="print-watermark-protected"');
    expect(source("app/print/ortho-study/[id]/page.tsx")).toContain("<PrintHeader");
    const illustratedStudy = source("components/OrthoIllustratedStudyPrint.tsx");
    expect(illustratedStudy).toContain("<PrintHeader");
    expect(illustratedStudy).toMatch(/<img\s+className="[^"]*\bprint-watermark-protected\b/);
    expect(source("app/print/print.css")).toContain("z-index: 50;"); // reprint warning remains above the decorative logo
  });
  it("exempts only the decorative singleton from modal sibling suppression", () => {
    const css = source("components/PrintReportModal.module.css");
    expect(css).toContain(":not(.modal):not(:global(.print-document-watermark))");
    expect(css).toContain("backdrop-filter: none !important");
    expect(css).toContain("z-index: auto !important");
    expect(source("components/LabPrescriptionModal.tsx")).toContain("body { display: none !important; }");
  });
});
