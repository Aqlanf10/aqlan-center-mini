import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PatientStatementDocument } from "../components/PatientStatementDocument";
import type { PatientStatementDocument as Document } from "../lib/patient-statement-document";
import { loadStatementFont, statementPdfBytes, statementRecipient, statementWhatsAppUrl, supportsStatementFileShare } from "../lib/patient-statement-export";

describe("patient statement local files and privacy", () => {
  it("loads only the bundled font when Next's optional local fallback is unavailable", async () => {
    const calls: string[] = [];
    const fontSet = {
      load: async (font: string) => { calls.push(font); if (font.includes("Fallback")) throw new Error("A network error occurred."); return [{} as FontFace]; },
      check: () => true,
      ready: Promise.resolve({} as FontFaceSet),
    };
    expect(await loadStatementFont('arabic, "arabic Fallback", system-ui, sans-serif', fontSet)).toBe("arabic");
    expect(calls).toEqual(["400 16px arabic", "700 20px arabic"]);
    expect(await loadStatementFont('"Arabic App", Arial, sans-serif', fontSet)).toBe('"Arabic App"');
    await expect(loadStatementFont("arabic", { ...fontSet, load: async () => [] })).rejects.toThrow("تعذر تحميل الخط العربي");
    await expect(loadStatementFont("arabic", { ...fontSet, load: async () => { throw new Error("network"); } })).rejects.toThrow("تعذر تحميل الخط العربي");
  });

  it("builds a multipage PDF with byte-accurate xref and image stream lengths", () => {
    const image = new Uint8Array([0xff, 0xd8, 0x00, 0xa4, 0x0a, 0xff, 0xd9]);
    const bytes = statementPdfBytes([{ bytes: image, width: 1588, height: 2246 }, { bytes: image, width: 1588, height: 2246 }]);
    const ascii = Buffer.from(bytes).toString("latin1");
    expect(ascii.startsWith("%PDF-1.4\n")).toBe(true);
    expect(ascii).toContain("/Type /Pages /Count 2");
    expect(ascii.match(/\/Subtype \/Image/g)).toHaveLength(2);
    expect(ascii).toContain("/Width 1588 /Height 2246");
    expect(ascii).toContain(`/Length ${image.length} >>\nstream\n`);
    const start = Number(ascii.match(/startxref\n(\d+)/)?.[1]);
    expect(ascii.slice(start, start + 4)).toBe("xref");
    const rows = ascii.slice(start).split("\n").slice(3, 11);
    rows.forEach((row, index) => {
      const offset = Number(row.slice(0, 10));
      expect(ascii.slice(offset).startsWith(`${index + 1} 0 obj\n`)).toBe(true);
    });
    expect(ascii.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(() => statementPdfBytes([])).toThrow("No statement pages");
  });

  it("requires an international recipient and never puts patient data/file URLs in wa.me", () => {
    expect(statementRecipient("+967 777 123 456")).toBe("967777123456");
    expect(statementRecipient("00967 (777) 123-456")).toBe("967777123456");
    expect(statementRecipient("777123456")).toBeNull();
    expect(statementRecipient("+9677?text=patient")).toBeNull();
    expect(statementRecipient("+01234567890")).toBeNull();
    expect(statementWhatsAppUrl("+967777123456")).toBe("https://wa.me/967777123456");
    expect(statementWhatsAppUrl("777123456")).toBeNull();
  });

  it("uses file capability detection and safely handles missing/throwing browser support", () => {
    const files = [new File(["%PDF-1.4"], "statement.pdf", { type: "application/pdf" })];
    expect(supportsStatementFileShare(files, { canShare: data => data?.files?.[0] === files[0], share: async () => {} })).toBe(true);
    expect(supportsStatementFileShare(files, { canShare: () => false, share: async () => {} })).toBe(false);
    expect(supportsStatementFileShare(files, { canShare: () => { throw new Error("unsupported"); }, share: async () => {} })).toBe(false);
    expect(supportsStatementFileShare(files, {} as Navigator)).toBe(false);
  });

  it("prints only patient presentation, excluding recipient and treatment selection metadata", () => {
    const document: Document = {
      patient: { name: "مريض اصطناعي", number: "TEST-7", phone: "+967777123456" },
      title: "كشف حساب", generatedAt: "2026-10-26", clinic: { name: "مركز اختبار" },
      sections: [{ title: "الرصيد", columns: ["العملة", "المتبقي"], rows: [["YER", "١٠٠"]] }],
      notices: ["ملاحظة للمريض <script>alert(1)</script>"], treatments: [{ id: 987654321, title: "selection-only" }],
    };
    const html = renderToStaticMarkup(<PatientStatementDocument document={document} />);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("مريض اصطناعي");
    expect(html).toContain("/logo.png");
    expect(html).not.toContain("967777123456");
    expect(html).not.toContain("987654321");
    expect(html).not.toContain("selection-only");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
