import { describe, expect, it } from "vitest";

import {
  buildWhatsAppLink,
  isInternationalPhone,
  normalizePhone,
} from "@/lib/whatsapp";

describe("normalizePhone (Yemen +967 default)", () => {
  it("preserves full international numbers", () => {
    expect(normalizePhone("+967 712 345 678")).toEqual({
      ok: true,
      e164: "+967712345678",
      digits: "967712345678",
    });
    expect(normalizePhone("+967712345678")).toEqual({
      ok: true,
      e164: "+967712345678",
      digits: "967712345678",
    });
  });

  it("converts 00-prefix to +", () => {
    expect(normalizePhone("00967 712 345 678")).toEqual({
      ok: true,
      e164: "+967712345678",
      digits: "967712345678",
    });
  });

  it("assumes country code when number already starts with it", () => {
    expect(normalizePhone("967712345678")).toEqual({
      ok: true,
      e164: "+967712345678",
      digits: "967712345678",
    });
  });

  it("upgrades local Yemeni mobile numbers", () => {
    expect(normalizePhone("712345678")).toEqual({
      ok: true,
      e164: "+967712345678",
      digits: "967712345678",
    });
  });

  it("strips a leading national zero before adding the country code", () => {
    expect(normalizePhone("0712345678")).toEqual({
      ok: true,
      e164: "+967712345678",
      digits: "967712345678",
    });
  });

  it("keeps other countries intact when written internationally", () => {
    expect(normalizePhone("+966501234567")).toEqual({
      ok: true,
      e164: "+966501234567",
      digits: "966501234567",
    });
  });

  it("rejects empty and non-numeric input", () => {
    expect(normalizePhone("")).toEqual({ ok: false, reason: "empty" });
    expect(normalizePhone("   ")).toEqual({ ok: false, reason: "empty" });
    expect(normalizePhone("abc-def-ghij")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(normalizePhone("+")).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("buildWhatsAppLink", () => {
  it("builds a wa.me link from a local Yemeni number", () => {
    expect(buildWhatsAppLink("712 345 678")).toBe("https://wa.me/967712345678");
  });

  it("keeps already-international numbers untouched", () => {
    expect(buildWhatsAppLink("+967712345678")).toBe(
      "https://wa.me/967712345678"
    );
  });

  it("appends a URL-encoded prefilled message", () => {
    expect(
      buildWhatsAppLink("712345678", "مرحبًا، موعدك غدًا في المركز")
    ).toBe(
      `https://wa.me/967712345678?text=${encodeURIComponent(
        "مرحبًا، موعدك غدًا في المركز"
      )}`
    );
  });

  it("ignores whitespace-only messages", () => {
    expect(buildWhatsAppLink("712345678", "   ")).toBe(
      "https://wa.me/967712345678"
    );
  });

  it("returns null for invalid numbers", () => {
    expect(buildWhatsAppLink("not-a-phone")).toBeNull();
  });
});

describe("isInternationalPhone", () => {
  it("detects explicit international format", () => {
    expect(isInternationalPhone("+967712345678")).toBe(true);
    expect(isInternationalPhone("00967712345678")).toBe(true);
    expect(isInternationalPhone("712345678")).toBe(false);
  });
});
