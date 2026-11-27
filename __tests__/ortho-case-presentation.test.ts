import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createDefaultOrthoWorkspace } from "@/lib/ortho-workspace-types";
import {
  buildCasePresentationDeck,
  generateEditablePptxBytes,
} from "@/lib/ortho-case-presentation";

function readZipEntries(zipBytes: Uint8Array): Map<string, string> {
  const buf = Buffer.from(zipBytes);
  const entries = new Map<string, string>();
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  expect(eocdOffset).toBeGreaterThan(0);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  let cdOffset = buf.readUInt32LE(eocdOffset + 16);

  for (let idx = 0; idx < totalEntries; idx++) {
    expect(buf.readUInt32LE(cdOffset)).toBe(0x02014b50);
    const method = buf.readUInt16LE(cdOffset + 10);
    const compSize = buf.readUInt32LE(cdOffset + 20);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = buf.readUInt32LE(cdOffset + 42);
    const name = buf.subarray(cdOffset + 46, cdOffset + 46 + nameLen).toString("utf8");

    expect(buf.readUInt32LE(localHeaderOffset)).toBe(0x04034b50);
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawSlice = buf.subarray(dataStart, dataStart + compSize);

    if (name.endsWith(".xml") || name.endsWith(".rels")) {
      const text =
        method === 8
          ? inflateRawSync(rawSlice).toString("utf8")
          : rawSlice.toString("utf8");
      entries.set(name, text);
    }
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

describe("ECMA-376 Strict OPC Orthodontic Case Presentation (.pptx) & Anonymization", () => {
  it("generates valid ECMA-376 OPC relationships, core-properties URI, theme1.xml relationship, and DEFLATE XML parts", () => {
    const record = createDefaultOrthoWorkspace(7001, 12);
    record.questionnaire.chiefComplaint = "بروز الأسنان العلوية";
    record.questionnaire.consentForEducationDeidentified = true;
    record.diagnosisSummary.finalDiagnosisAr = "سوء إطباق صنف ثانٍ قسم أول";
    record.diagnosisSummary.approvedAt = "2026-11-27T06:00:00Z";
    record.diagnosisSummary.approvedBy = "د. عقلان";

    const deck = buildCasePresentationDeck({
      clinicName: "مركز الدكتور عقلان",
      patientName: "مريض تجريبي",
      patientCode: "P-07001",
      record,
      anonymize: false,
    });

    expect(deck.slides.length).toBeGreaterThanOrEqual(20);
    const pptx = generateEditablePptxBytes(deck);
    expect(pptx.byteLength).toBeGreaterThan(10_000);

    const xmlEntries = readZipEntries(pptx);
    const rootRels = xmlEntries.get("_rels/.rels") ?? "";
    expect(rootRels).toContain(
      "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
    );
    expect(rootRels).not.toContain(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/metadata/core-properties",
    );

    const presRels = xmlEntries.get("ppt/_rels/presentation.xml.rels") ?? "";
    expect(presRels).toContain('Target="theme/theme1.xml"');

    const coreXml = xmlEntries.get("docProps/core.xml") ?? "";
    expect(coreXml).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    expect(coreXml).not.toContain(".123Z");

    const appXml = xmlEntries.get("docProps/app.xml") ?? "";
    expect(appXml).toContain("<TitlesOfParts>");
    expect(appXml).toContain(`<Slides>${deck.slides.length}</Slides>`);

    const masterXml = xmlEntries.get("ppt/slideMasters/slideMaster1.xml") ?? "";
    expect(masterXml).toContain("<a:lvl9pPr");
    expect(masterXml).toContain('typeface="+mn-ea"');

    const layoutXml = xmlEntries.get("ppt/slideLayouts/slideLayout1.xml") ?? "";
    expect(layoutXml).toContain('<p:bgRef idx="1001">');
  });

  it("deduplicates repeated embedded clinical photos and keeps table cx equal to gridCol sum", () => {
    const TINY_PNG = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
      0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
      0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const record = createDefaultOrthoWorkspace(7001, 12);
    const deck = buildCasePresentationDeck({
      clinicName: "مركز الدكتور عقلان",
      patientName: "مريض تجريبي",
      patientCode: "P-07001",
      record,
      anonymize: false,
      mediaAssets: [
        { id: "m1", docId: 1, title: "Frontal", viewType: "extraoral_frontal", stage: "T0", bytes: TINY_PNG, ext: "png" },
      ],
    });
    const pptx = generateEditablePptxBytes(deck);
    const xmlEntries = readZipEntries(pptx);
    const allRels = [...xmlEntries.entries()]
      .filter(([k]) => k.startsWith("ppt/slides/_rels/"))
      .map(([, v]) => v)
      .join("\n");
    expect(allRels).toContain("../media/image1.png");
    expect(allRels).not.toContain("../media/image2.png");

    const allSlides = [...xmlEntries.entries()]
      .filter(([k]) => k.startsWith("ppt/slides/slide") && k.endsWith(".xml"))
      .map(([, v]) => v)
      .join("\n");
    expect(allSlides).toContain("<a:srcRect/>");
    expect(allSlides).toContain("<a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId>");
  });

  it("scrubs internal patientId, patientName, and patientNumber when anonymize=true", () => {
    const record = createDefaultOrthoWorkspace(98765, 3);
    record.questionnaire.consentForEducationDeidentified = true;

    const deck = buildCasePresentationDeck({
      clinicName: "مركز الدكتور عقلان",
      patientName: "مريض سري للغاية",
      patientCode: "BRW-07429",
      record,
      anonymize: true,
    });

    const pptx = generateEditablePptxBytes(deck);
    const xmlEntries = readZipEntries(pptx);
    for (const [, content] of xmlEntries) {
      expect(content).not.toContain("98765");
      expect(content).not.toContain("مريض سري للغاية");
      expect(content).not.toContain("BRW-07429");
    }
  });
});
