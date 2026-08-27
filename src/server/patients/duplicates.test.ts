import { describe, expect, it } from "vitest";

import {
  classifyDuplicate,
  digitsOnly,
  mobileLooksSimilar,
  mobileTail,
  normalizeNameForMatch,
} from "@/server/patients/duplicates";

describe("normalizeNameForMatch", () => {
  it("collapses inner whitespace and lowercases", () => {
    expect(normalizeNameForMatch("  أحمد   محمد ")).toBe("أحمد محمد");
    expect(normalizeNameForMatch("SARA Ali")).toBe("sara ali");
  });
});

describe("digitsOnly / mobileTail", () => {
  it("extracts digits from formatted numbers", () => {
    expect(digitsOnly("+967 (712) 345-678")).toBe("967712345678");
    expect(digitsOnly("0712345678")).toBe("0712345678");
  });

  it("takes the trailing 9 digits regardless of country code form", () => {
    expect(mobileTail("+967712345678")).toBe("67712345678".slice(-9));
    expect(mobileTail("0712345678")).toBe("0712345678".slice(-9));
    expect(mobileTail("+967712345678")).toBe(mobileTail("0712345678"));
  });

  it("keeps short inputs untouched", () => {
    expect(mobileTail("12345")).toBe("12345");
  });
});

describe("mobileLooksSimilar", () => {
  it("treats +967 form and local 0 form as the same line", () => {
    expect(mobileLooksSimilar("+967712345678", "0712345678")).toBe(true);
    expect(mobileLooksSimilar("967-712-345-678", "+967 712 345 678")).toBe(true);
  });

  it("rejects different lines", () => {
    expect(mobileLooksSimilar("+967712345678", "+967799999999")).toBe(false);
  });

  it("refuses to match very short tails", () => {
    expect(mobileLooksSimilar("1234567", "1234567")).toBe(false);
    expect(mobileLooksSimilar("12345678", "12345678")).toBe(true);
  });
});

describe("classifyDuplicate", () => {
  const base = {
    id: "p1",
    fileNumber: "P-000001",
    fullName: "أحمد محمد",
    mobile: "+967712345678",
    alternateMobile: null,
  };

  it("flags a matching mobile as reason=mobile", () => {
    expect(
      classifyDuplicate(base, { fullName: "شخص آخر", mobile: "0712345678" })
    ).toBe("mobile");
  });

  it("checks the alternate number too", () => {
    const withAlt = { ...base, mobile: null, alternateMobile: "+967712345678" };
    expect(
      classifyDuplicate(withAlt, { fullName: "x", mobile: "+967712345678" })
    ).toBe("mobile");
  });

  it("same name AND same line is reason=nameAndMobile", () => {
    expect(
      classifyDuplicate(base, { fullName: "أحمد   محمد", mobile: "0712345678" })
    ).toBe("nameAndMobile");
  });

  it("same name with a different number does not warn", () => {
    expect(
      classifyDuplicate(base, { fullName: "أحمد محمد", mobile: "+967799999999" })
    ).toBeNull();
  });

  it("different name with different number does not warn", () => {
    expect(
      classifyDuplicate(base, { fullName: "سارة", mobile: "+967799999999" })
    ).toBeNull();
  });
});
