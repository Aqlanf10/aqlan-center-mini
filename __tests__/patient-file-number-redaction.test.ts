import { describe, expect, it, vi } from "vitest";
import { redactPatientFileNumbers, type PatientFileFact } from "../lib/privacy/patient-file-number-redaction";

const mask = "[ملف محمي]";
const classify = (patients: readonly string[] = []) =>
  vi.fn(async (ids: readonly string[]): Promise<PatientFileFact[]> => ids.map((number) => ({
    number,
    kind: patients.includes(number) ? "patient" : "not-patient",
  })));

describe("configurable clinic file identifiers: offline redaction boundary", () => {
  it("protects legacy P and Arabic file forms, keeping 7000 unrelated elsewhere", async () => {
    const resolver = classify();
    const actual = await redactPatientFileNumbers("P-07000, p7001, م-٠٠٧, 7000", {
      historicalNumbers: [], classify: resolver,
    });
    expect(actual).toEqual({ ok: true, text: `${mask}, ${mask}, ${mask}, 7000` });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("resolves every valid prefix incl. one/six letters, old/custom identifiers and a clean receipt", async () => {
    const resolver = classify(["A-01500", "ABCDEF-9223372036854775807", "INV-01001"]);
    const input = "a-01500 / ABCDEF-9223372036854775807; legacy/2042-04; ملف المريض: XT.401. Invoice INV-01001, receipt INV-01002.";
    const result = await redactPatientFileNumbers(input, { historicalNumbers: ["legacy/2042-04"], classify: resolver });
    expect(result).toEqual({
      ok: true, text: `${mask} / ${mask}; ${mask}; ملف المريض: ${mask}. Invoice ${mask}, receipt INV-01002.`,
    });
    expect(resolver).toHaveBeenCalledExactlyOnceWith(["A-01500", "ABCDEF-9223372036854775807", "INV-01001", "INV-01002"]);
  });

  it("classifies exact numbers rather than banning prefixes, and never trusts only the receipt label", async () => {
    const resolver = classify(["R-00001"]);
    expect(await redactPatientFileNumbers("إيصال R-00001 وإيصال R-00002 وسند V-00001 و RECEIPT FILE ID INV-00200", {
      historicalNumbers: [], classify: resolver,
    })).toEqual({ ok: true, text: `إيصال ${mask} وإيصال R-00002 وسند V-00001 و RECEIPT FILE ID INV-00200` });
  });

  it("normalizes fullwidth chars, Arabic/Persian digits, dashes and invisible bidi marks only for matching", async () => {
    const resolver = classify(["A-01500"]);
    expect(await redactPatientFileNumbers("قبل وａ\u200f−۰١۵００ وبعد: وبجوارP-٠٧٠٠٠مباشرةً.", {
      historicalNumbers: [], classify: resolver,
    })).toEqual({ ok: true, text: `قبل و${mask} وبعد: وبجوار${mask}مباشرةً.` });
    expect(resolver).toHaveBeenCalledExactlyOnceWith(["A-01500"]);
  });

  it("allows server-provided exact custom IDs without masking surrounding text or larger tokens", async () => {
    const resolver = classify();
    expect(await redactPatientFileNumbers("OLD/44 old/442 PrefixOld/44 | PATIENT FILE NO: 'OLD.77'; ANB 82, 0.04 mg", {
      historicalNumbers: ["Old/44"], classify: resolver,
    })).toEqual({ ok: true, text: `${mask} old/442 PrefixOld/44 | PATIENT FILE NO: '${mask}'; ANB 82, 0.04 mg` });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("deduplicates inputs only after Unicode normalization and masks all occurrences", async () => {
    const resolver = classify(["A-01500"]);
    expect(await redactPatientFileNumbers("A-01500 | a-٠١٥٠٠ | AB-01500", {
      historicalNumbers: [], classify: resolver,
    })).toEqual({ ok: true, text: `${mask} | ${mask} | AB-01500` });
    expect(resolver).toHaveBeenCalledExactlyOnceWith(["A-01500", "AB-01500"]);
  });

  it("returns no outbound text on outage, omitted, duplicate, or mismatched verification facts", async () => {
    for (const noProof of [
      async () => { throw new Error("synthetic lookup failure"); },
      async () => [],
      async () => [{ number: "A-01000", kind: "not-patient" }, { number: "A-01000", kind: "patient" }] as const,
      async () => [{ number: "A-01000", kind: "not-patient" }, { number: "Z-00042", kind: "not-patient" }] as const,
    ]) {
      expect(await redactPatientFileNumbers("A-01000 and Z-00001", {
        historicalNumbers: [], classify: noProof,
      })).toEqual({ ok: false, reason: "unverified" });
    }
  });

  it("rejects excess whole-input, left-over candidate, historical-list and label lengths without truncation", async () => {
    const resolver = classify();
    const distinct = Array.from({ length: 65 }, (_, i) => `A-${String(1500 + i).padStart(5, "0")}`).join(" ");
    for (const boundary of [
      { text: "x".repeat(4_001), historicalNumbers: [] },
      { text: distinct, historicalNumbers: [] },
      { text: "PATIENT FILE ID: A-" + "0".repeat(128), historicalNumbers: [] },
      { text: "A-" + "0".repeat(128), historicalNumbers: [] },
      { text: "some text", historicalNumbers: Array(65).fill("OLD/04") as string[] },
    ]) {
      expect(await redactPatientFileNumbers(boundary.text, {
        historicalNumbers: boundary.historicalNumbers, classify: resolver,
      })).toEqual({ ok: false, reason: "limit" });
    }
    expect(resolver).not.toHaveBeenCalled();
  });
});
