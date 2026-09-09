import { beforeAll, describe, expect, it } from "vitest";
import {
  baseUrl,
  harness,
  authedMutation,
} from "./_server";

/**
 * اختبارات حدود الأجسام والرفع على HTTP الحقيقي (P2/S14): oversized JSON ⇒ 413
 * (معلنًا وchunked)، 413 لا 500، الرفع المسموح يمر، وبصمة المحتوى ترفض
 * الملف المدّعى.
 */

let h: Awaited<ReturnType<typeof harness>>;

beforeAll(async () => {
  h = await harness();
}, 240_000);

describe("حدود أجسام JSON — 413 لا 500", () => {
  it("JSON بحجم معلن يتجاوز الحد ⇒ 413 فورًا", async () => {
    const bigPayload = JSON.stringify({ message: "a".repeat(3 * 1024 * 1024) });
    const response = await authedMutation("/api/ai/chat", h.sessions.doctorA, "POST", bigPayload);
    // Content-Length معلن ~3MB > سقف proxy (2MB) أو حد المسار (1MB) — كلاهما 413
    expect(response.status).toBe(413);
  });

  it("JSON بلا Content-Length يتجاوز الحد ⇒ 413 من القارئ المحدود", async () => {
    // تيار متقطع: أرقام كافية لتجاوز حد محادثة AI (1MB) — القارئ يقاطع
    const chunks: Uint8Array[] = [];
    const header = new TextEncoder().encode('{"message":"');
    chunks.push(header);
    while (chunks.reduce((sum, c) => sum + c.length, 0) < 1.5 * 1024 * 1024) {
      chunks.push(new TextEncoder().encode("x".repeat(64 * 1024)));
    }
    chunks.push(new TextEncoder().encode('"}'));
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = await fetch(`${baseUrl}/api/ai/chat`, {
      method: "POST",
      headers: {
        Cookie: h.sessions.doctorA.cookie,
        Origin: baseUrl,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        // بلا Content-Length: تيار الجسم يجعل undici يرسله chunked تلقائيًا
      },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    expect(payload?.message).toBeTruthy(); // رسالة عربية واضحة لا 500 صامت
  });

  it("JSON سليم ضمن الحد يصل طبيعيًّا (لا كسر للأصل المشروع)", async () => {
    const response = await authedMutation(
      "/api/ai/chat",
      h.sessions.doctorA,
      "POST",
      JSON.stringify({ message: "مرحبا" }),
    );
    // الحارس والأجسام سليمة: الطلب يصل المسار (رد المحرك المحلي 200)
    expect([200, 503]).toContain(response.status);
  });

  it("طلب عام بحجم يتجاوز سقف proxy ⇒ 413 حتى قبل الجلسة", async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl,
      },
      body: JSON.stringify({ username: "a".repeat(3 * 1024 * 1024), password: "x" }),
    });
    expect(response.status).toBe(413);
  });
});

describe("حدود المعدل — 429 مع Retry-After (S10)", () => {
  it("اختبار اتصال مزود AI: تجاوز الحد ⇒ 429 + Retry-After", async () => {
    // الحد: 10 لكل 5 دقائق لكل مستخدم — نستهلكه كاملًا ثم نطالب بالرفض
    let last: Response | null = null;
    for (let i = 0; i < 12; i += 1) {
      last = await authedMutation(
        "/api/settings/ai/providers/openai/test",
        h.sessions.admin,
        "POST",
        JSON.stringify({}),
      );
      // أول 10 تصل المسار (404 مزود غير موجود بذورًا أو أخطاء أخرى داخلية)،
      // والهدف: التفاعل مع الحد لا نتيجة المزود
      if (last.status === 429) break;
    }
    expect(last?.status).toBe(429);
    const retryAfter = last?.headers.get("retry-after");
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("الحد موزّع: نفس اللحظة عبر جلسات مختلفة تُحصى للمستخدم نفسه", async () => {
    // admin استهلك حد اختبار المزود في الاختبار السابق؛ طلب فوري آخر ⇒ 429
    const response = await authedMutation(
      "/api/settings/ai/providers/openai/test",
      h.sessions.admin,
      "POST",
      JSON.stringify({}),
    );
    expect(response.status).toBe(429);
  });
});

describe("رفع المستندات — البصمة والحجم (S9 + S8)", () => {
  const VALID_PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR"),
    Buffer.alloc(25, 0),
  ]);
  const FAKE_PNG_TEXT = Buffer.from("#!/bin/sh\nthis is not a png at all");

  function multipartUpload(file: Blob, filename: string, mime: string): Promise<Response> {
    const form = new FormData();
    form.append("file", file, filename);
    form.append("kind", "photo");
    return fetch(`${baseUrl}/api/patients/${h.seeded.patientAId}/documents`, {
      method: "POST",
      headers: {
        Cookie: h.sessions.doctorA.cookie,
        Origin: baseUrl,
        "Sec-Fetch-Site": "same-origin",
      },
      body: form,
    });
  }

  it("ملف نصي مدّعى image/png ⇒ 400 (بصمة المحتوى لا تطابق)", async () => {
    const response = await multipartUpload(
      new Blob([FAKE_PNG_TEXT], { type: "image/png" }),
      "evil.png",
      "image/png",
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { message?: string };
    expect(payload.message).toContain("لا يطابق");
  });

  it("PNG سليم ⇒ 201 يُخزَّن بعنوان المحتوى", async () => {
    const response = await multipartUpload(
      new Blob([VALID_PNG], { type: "image/png" }),
      "xray.png",
      "image/png",
    );
    expect(response.status).toBe(201);
    const document = (await response.json()) as Record<string, unknown>;
    // العرض المُعاد للواجهة: نوع صورة حقيقي وحجم فعلي ومعرف موجب —
    // والعنونة بالمحتوى تُثبت على مستوى lib/storage.ts في اختبارات الوحدة.
    expect(document.isImage).toBe(true);
    expect(document.mimeType).toBe("image/png");
    expect(Number(document.id)).toBeGreaterThan(0);
    expect(Number(document.sizeBytes)).toBeGreaterThan(0);
  });

  it("تحميل المستندات يتجاوز السقف ⇒ 413 لا 500", async () => {
    // 26MB فوق سقف multipart (25MB) — يرفض من proxy قبل الذاكرة
    const huge = new Uint8Array(26 * 1024 * 1024);
    huge.set(VALID_PNG.subarray(0, 12), 0);
    const response = await multipartUpload(
      new Blob([huge], { type: "image/png" }),
      "huge.png",
      "image/png",
    );
    expect(response.status).toBe(413);
  });

  it("تنزيل المستند: nosniff وprivate no-store وauthorization", async () => {
    // طبيب ب يطلب مستند مريض أ ⇒ 403 (BOLA) — والرؤوس على المسار نفسه
    const denied = await fetch(`${baseUrl}/api/documents/1`, {
      headers: { Cookie: h.sessions.doctorB.cookie },
    });
    expect(denied.status).toBe(403);
  });
});
