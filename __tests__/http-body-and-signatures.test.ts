import { describe, expect, it } from "vitest";
import {
  readBoundedBody,
  readBoundedFormData,
  readJsonBody,
  bodyErrorResponse,
  BodyTooLargeError,
  MalformedBodyError,
  declaredLengthExceeds,
} from "../lib/http-body";
import { contentMatchesMimeType } from "../lib/magic-bytes";

/**
 * اختبارات حدود الأجسام وبصمات الملفات (P2/S8 وS9).
 */

const LIMIT = 256;

describe("حدود أجسام الطلبات", () => {
  it("JSON سليم يُقرأ عاديًا", async () => {
    const request = jsonRequest({ a: 1 });
    expect(await readJsonBody(request, LIMIT)).toEqual({ a: 1 });
  });

  it("Content-Length معلن يتجاوز الحد ⇒ 413 فورًا قبل القراءة", async () => {
    const request = new Request("http://localhost/x", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "999999" },
      body: "x",
    });
    await expect(readJsonBody(request, LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
    const response = bodyErrorResponse(new BodyTooLargeError(LIMIT));
    expect(response?.status).toBe(413);
  });

  it("declaredLengthExceeds يقرأ الترويسة المعلنة فقط", () => {
    expect(declaredLengthExceeds(
      new Request("http://localhost/x", { method: "POST", headers: { "Content-Length": "100" }, body: "x" }),
      99,
    )).toBe(true);
    expect(declaredLengthExceeds(
      new Request("http://localhost/x", { method: "POST", headers: { "Content-Length": "100" }, body: "x" }),
      100,
    )).toBe(false);
  });

  it("chunked (بلا Content-Length) يتجاوز الحد ⇒ 413 من القارئ نفسه", async () => {
    // تيار كسول: القطع تُدفع عند السحب، فإلغاء القراءة عند تجاوز الحد
    // لا يصطدم بدفعٍ بعد الإغلاق.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        try {
          controller.enqueue(new TextEncoder().encode("a".repeat(100)));
        } catch { /* أُلغي التيار — المتوقع */ }
      },
    });
    const request = new Request("http://localhost/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expect(readJsonBody(request, LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("JSON تالف ⇒ 400 لا 500", async () => {
    const request = jsonRequestRaw("{not json");
    await expect(readJsonBody(request, LIMIT)).rejects.toBeInstanceOf(MalformedBodyError);
    expect(bodyErrorResponse(new MalformedBodyError())?.status).toBe(400);
  });

  it("جسم فارغ ⇒ 400", async () => {
    const request = new Request("http://localhost/x", { method: "POST" });
    await expect(readJsonBody(request, LIMIT)).rejects.toBeInstanceOf(MalformedBodyError);
  });

  it("readBoundedBody يعيد البايتات كما هي ضمن الحد", async () => {
    const request = jsonRequestRaw("hello");
    const bytes = await readBoundedBody(request, LIMIT);
    expect(bytes.toString("utf8")).toBe("hello");
  });

  it("multipart محدود يُفك بنجاح", async () => {
    const form = new FormData();
    form.append("username", "doctor");
    form.append("password", "synthetic");
    const request = new Request("http://localhost/login", { method: "POST", body: form });
    const parsed = await readBoundedFormData(request, 128 * 1024);
    expect(parsed.get("username")).toBe("doctor");
    expect(parsed.get("password")).toBe("synthetic");
  });

  it("multipart يتجاوز الحد ⇒ 413", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(1000)]), "x.bin");
    const request = new Request("http://localhost/upload", { method: "POST", body: form });
    await expect(readBoundedFormData(request, 100)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

function jsonRequest(payload: unknown): Request {
  return new Request("http://localhost/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function jsonRequestRaw(text: string): Request {
  return new Request("http://localhost/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: text,
  });
}

/* ── بصمات الملفات (magic bytes) ─────────────────────────────────────── */

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),               // طول IHDR
  Buffer.from("IHDR"),
  Buffer.alloc(20, 0),
]);

const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(30, 0),
]);

const WEBP_BYTES = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x10, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 "),
  Buffer.alloc(20, 0),
]);

const PDF_BYTES = Buffer.from(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< >>\n%%EOF\n",
);

describe("بصمات المحتوى (magic bytes)", () => {
  it("PNG سليم يُقبل", () => {
    expect(contentMatchesMimeType(PNG_BYTES, "image/png")).toBe(true);
  });
  it("JPEG سليم يُقبل", () => {
    expect(contentMatchesMimeType(JPEG_BYTES, "image/jpeg")).toBe(true);
  });
  it("WebP سليم يُقبل", () => {
    expect(contentMatchesMimeType(WEBP_BYTES, "image/webp")).toBe(true);
  });
  it("PDF سليم يُقبل", () => {
    expect(contentMatchesMimeType(PDF_BYTES, "application/pdf")).toBe(true);
  });

  it("MIME يقول PNG والمحتوى نص/تنفيذي ⇒ رفض", () => {
    expect(contentMatchesMimeType(Buffer.from("#!/bin/sh\nrm -rf /"), "image/png")).toBe(false);
    expect(contentMatchesMimeType(Buffer.from("<html>not an image</html>"), "image/png")).toBe(false);
  });
  it("MIME يقول JPEG والمحتوى PNG ⇒ رفض (تنافر النوعين)", () => {
    expect(contentMatchesMimeType(PNG_BYTES, "image/jpeg")).toBe(false);
  });
  it("PDF بلا %%EOF في الذيل ⇒ رفض (بنية ناقصة)", () => {
    const truncated = Buffer.from("%PDF-1.7\n1 0 obj\n<< >>");
    expect(contentMatchesMimeType(truncated, "application/pdf")).toBe(false);
  });
  it("ملف أصغر من أصغر توقيع ⇒ رفض", () => {
    expect(contentMatchesMimeType(Buffer.alloc(5), "image/png")).toBe(false);
    expect(contentMatchesMimeType(Buffer.alloc(0), "image/jpeg")).toBe(false);
  });
  it("نوع خارج القائمة ⇒ رفض دائمًا", () => {
    expect(contentMatchesMimeType(PNG_BYTES, "image/gif")).toBe(false);
    expect(contentMatchesMimeType(PNG_BYTES, "image/svg+xml")).toBe(false);
  });
  it("PNG بلا chunk IHDR بعد البصمة ⇒ رفض (بنية غير منطقية)", () => {
    const broken = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 10]),
      Buffer.from("IDAT"),
      Buffer.alloc(10, 0),
    ]);
    expect(contentMatchesMimeType(broken, "image/png")).toBe(false);
  });
});
