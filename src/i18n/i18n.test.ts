import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCALE,
  getDirection,
  isLocale,
  LOCALES,
} from "@/i18n/config";
import { ar } from "@/i18n/dictionaries/ar";
import { en } from "@/i18n/dictionaries/en";

function flattenKeys(
  value: Record<string, unknown>,
  prefix = ""
): Set<string> {
  const keys = new Set<string>();
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object") {
      for (const nested of flattenKeys(child as Record<string, unknown>, path)) {
        keys.add(nested);
      }
    } else {
      keys.add(path);
    }
  }
  return keys;
}

describe("i18n config", () => {
  it("defaults to Arabic", () => {
    expect(DEFAULT_LOCALE).toBe("ar");
    expect(LOCALES).toContain("ar");
  });

  it("validates locale values", () => {
    expect(isLocale("ar")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(42)).toBe(false);
  });

  it("maps locales to the correct writing direction", () => {
    expect(getDirection("ar")).toBe("rtl");
    expect(getDirection("en")).toBe("ltr");
  });
});

describe("dictionaries", () => {
  it("ar and en expose exactly the same key sets", () => {
    const arabicKeys = flattenKeys(ar as unknown as Record<string, unknown>);
    const englishKeys = flattenKeys(en as unknown as Record<string, unknown>);
    expect(englishKeys).toEqual(arabicKeys);
  });

  it("contain no empty string values", () => {
    for (const dict of [ar, en]) {
      const collect = (value: Record<string, unknown>) => {
        for (const child of Object.values(value)) {
          if (child && typeof child === "object") {
            collect(child as Record<string, unknown>);
          } else {
            expect(typeof child).toBe("string");
            expect((child as string).trim().length).toBeGreaterThan(0);
          }
        }
      };
      collect(dict as unknown as Record<string, unknown>);
    }
  });

  it("keep the clinic identity consistent in both languages", () => {
    expect(ar.app.name).toBe("Aqlan Center Mini");
    expect(en.app.name).toBe("Aqlan Center Mini");
    expect(ar.app.centerName).toContain("عقلان");
  });
});
