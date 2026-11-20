import { describe, expect, it } from "vitest";
import { deIdentifyClinicalContext } from "../lib/ai-tools/privacy";

// Synthetic file identifiers only. No database, provider, allocation or network I/O.
const prefixes = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

describe("existing text privacy boundary with selectable patient prefixes", () => {
  it.each(prefixes)("masks canonical %s file numbers without depending on the active prefix", (prefix) => {
    for (const letter of [prefix, prefix.toLowerCase()]) {
      for (const suffix of ["1", "01500", "100000", "1234567", "777123456", "123456789012345", "123456789012345678", "123456777123456"]) {
        const code = `${letter}-${suffix}`;
        const result = deIdentifyClinicalContext(`file=${code}; follow up`);
        expect(result).not.toContain(code);
        expect(result).not.toContain(suffix);
        expect(result).toBe("file=[ملف محمي]; follow up");
      }
    }
  });

  it.each(prefixes)("masks explicitly labelled %s identifiers with existing separator variants", (prefix) => {
    for (const letter of [prefix, prefix.toLowerCase()]) {
      for (const code of [`${letter}-01500`, `${letter}01500`]) {
        for (const text of [`ملف ${code}`, `رقم الملف: ${code}`, `ملف # '${code}'`, `ملف: \`${code}\``]) {
          const result = deIdentifyClinicalContext(text);
          expect(result).not.toContain(code);
          expect(result).not.toContain("01500");
        }
      }
    }
  });

  it.each(["71-234-567", "71 234 567", "71234-567", "71234 567", "+967-71234-567", "071 234 567", "81-234-5678", "96731-234-567", "+967 71 234 567"])(
    "preserves complete legacy phone redaction for %s rather than consuming a file-shaped prefix", (phone) => {
      for (const prefix of ["", "A-", "P-", "ملف A-", "ملف P", "رقم الملف: "]) {
        expect(deIdentifyClinicalContext(`${prefix}${phone}`)).toBe(`${prefix}[هاتف محمي] •••`);
      }
    },
  );

  it("keeps historical P identifiers masked after a different prefix is selected", () => {
    const result = deIdentifyClinicalContext("P-01500, A-01500, z-01500; P01500 p1500");
    for (const code of ["P-01500", "A-01500", "z-01500", "P01500", "p1500"]) expect(result).not.toContain(code);
    expect(result).not.toContain("01500");
    expect(result).not.toContain("1500");
  });

  it("does not newly classify unlabelled vitamin names or clinical measurements as file numbers", () => {
    const clinical = "Vitamin B12; HbA1c; SNA 82; ANB 4; 0.04 mg; tooth 16; 500 mg";
    expect(deIdentifyClinicalContext(clinical)).toBe(clinical);
  });

  it("masks independent old/new codes and grouped phones together without residual numeric tokens", () => {
    expect(deIdentifyClinicalContext("A-01500 777123456; P01500; phone A-71-234-567; file Z-123456789012345678"))
      .toBe("[ملف محمي] [هاتف محمي] •••; [ملف محمي]; phone A-[هاتف محمي] •••; file [ملف محمي]");
    expect(deIdentifyClinicalContext("ملف: A-01500; ملف P71 234 567; B-01500 500 mg"))
      .toBe("ملف: [ملف محمي]; ملف P[هاتف محمي] •••; [ملف محمي] 500 mg");
  });

  it("retains surrounding case, punctuation and non-identifying text", () => {
    expect(deIdentifyClinicalContext("Before (a-01500), AFTER [Z-100000]."))
      .toBe("Before ([ملف محمي]), AFTER [[ملف محمي]].");
  });
});
