import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_BYTES,
  formatBytes,
  isSafeKey,
  isDocumentKind,
  storageKey,
  validateUpload,
} from "../lib/storage";

const sha = "a".repeat(64);

describe("قبول الملفّات", () => {
  it("يقبل الصور وPDF", () => {
    expect(validateUpload({ mimeType: "image/jpeg", sizeBytes: 1000 })).toMatchObject({ ok: true, isImage: true });
    expect(validateUpload({ mimeType: "application/pdf", sizeBytes: 1000 })).toMatchObject({ ok: true, isImage: false });
  });

  it("يردّ نوعًا غير مقبول برسالةٍ تقول المقبول", () => {
    const rejected = validateUpload({ mimeType: "video/mp4", sizeBytes: 1000 });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.message).toContain("PDF");
  });

  it("يردّ الفارغ والأكبر من الحدّ", () => {
    expect(validateUpload({ mimeType: "image/png", sizeBytes: 0 }).ok).toBe(false);
    expect(validateUpload({ mimeType: "image/png", sizeBytes: DEFAULT_MAX_BYTES + 1 }).ok).toBe(false);
    expect(validateUpload({ mimeType: "image/png", sizeBytes: DEFAULT_MAX_BYTES }).ok).toBe(true);
  });

  it("يحترم حدًّا مهيَّأً من الإعدادات", () => {
    expect(validateUpload({ mimeType: "image/png", sizeBytes: 5000, maxBytes: 4000 }).ok).toBe(false);
    expect(validateUpload({ mimeType: "image/png", sizeBytes: 5000, maxBytes: 6000 }).ok).toBe(true);
  });
});

describe("مسار الملف", () => {
  it("يُشقّ المسار من البصمة", () => {
    expect(storageKey(sha, "jpg")).toBe(`aa/aa/${sha}.jpg`);
  });

  it("يرفض بصمةً غير صالحة", () => {
    expect(() => storageKey("قصيرة", "jpg")).toThrow();
    expect(() => storageKey(sha + "a", "jpg")).toThrow();
  });

  it("يُطهّر امتدادًا خبيثًا", () => {
    expect(storageKey(sha, "../../sh")).toBe(`aa/aa/${sha}.bin`);
  });

  it("يمنع الخروج من مجلّد التخزين", () => {
    expect(isSafeKey(storageKey(sha, "jpg"))).toBe(true);
    expect(isSafeKey("../../etc/passwd")).toBe(false);
    expect(isSafeKey("aa/aa/../../../etc/passwd.jpg")).toBe(false);
    expect(isSafeKey(`aa/aa/${sha}.jpg/../x`)).toBe(false);
  });
});

describe("العرض", () => {
  it("يقرأ الحجم إنسانيًّا", () => {
    expect(formatBytes(500)).toContain("بايت");
    expect(formatBytes(2048)).toContain("كيلوبايت");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 ميغابايت");
  });

  it("النوع قائمة مغلقة", () => {
    expect(isDocumentKind("xray")).toBe(true);
    expect(isDocumentKind("أشعة")).toBe(false);
    expect(isDocumentKind(null)).toBe(false);
  });
});
