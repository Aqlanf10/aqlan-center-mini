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
