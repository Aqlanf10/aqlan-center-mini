/**
 * قراءة أجسام الطلبات بحدّ أعلى — P2/S8.
 *
 * المشكلة: `request.json()` و`request.formData()` يقرآن الجسم كاملًا مهما
 * بلغ حجمه. طلب ضخم واحد (أو عشرات) يستهلك الذاكرة حتى يتعطل الخادم —
 * DoS ببساطة. الطبقة المركزية هذه تفرض حدًّا لكل قارئ:
 *
 *   • Content-Length معلن ويتجاوز الحد ⇒ 413 فورًا قبل أي قراءة.
 *   • Content-Length غائب (chunked) ⇒ القارئ نفسه يقطع عند الحد+1 ويعيد 413 —
 *     لا نعتمد على الترويسة وحدها (شرط صريح من المواصفة).
 *
 * الحدود كلها في lib/security-limits.ts — مركز واحد قابل للتهيئة، لا
 * أرقامًا مبعثرة في عشرات المسارات.
 *
 * multipart (رفع المستندات حتى 20MB): يُقرأ عبر readBoundedBody ثم يُعاد
 * بناء Request منه ويُفكك formData — فيبقى حد القراءة قائمًا حتى مع غياب
 * Content-Length. ذاكرة 20MB مؤقتًا مطابقة لما يفعله المسار أصلًا
 * (Buffer.from(await file.arrayBuffer())) — لا تراجع هنا.
 */

import { NextResponse } from "next/server";

/** خطأ محدود — يعلّق حالة HTTP الصحيحة (413) فيلتقطه المسار ويعيدها. */
export class BodyTooLargeError extends Error {
  readonly status = 413;
  constructor(limitBytes: number) {
    super(`حجم الطلب يتجاوز الحد المسموح (${Math.round(limitBytes / 1024)} كيلوبايت).`);
    this.name = "BodyTooLargeError";
  }
}

export class MalformedBodyError extends Error {
  readonly status = 400;
  constructor(message = "طلب غير صالح.") {
    super(message);
    this.name = "MalformedBodyError";
  }
}

/** هل Content-Length المعلن يتجاوز الحد؟ — ترويسة العميل لا تُصدَّق بلا تحقق. */
export function declaredLengthExceeds(request: Request, limitBytes: number): boolean {
  const declared = Number(request.headers.get("content-length"));
  return Number.isFinite(declared) && declared > limitBytes;
}

/**
 * قراءة الجسم الخام بحد أعلى — اللبنة المشتركة لكل القراءات.
 * لا تحلل شيئًا: تعيد البايتات إن كانت ضمن الحد، أو ترمي BodyTooLargeError.
 */
export async function readBoundedBody(request: Request, limitBytes: number): Promise<Buffer> {
  if (declaredLengthExceeds(request, limitBytes)) {
    throw new BodyTooLargeError(limitBytes);
  }
  if (!request.body) {
    return Buffer.alloc(0);
  }
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limitBytes) {
      /* توقف فوري — لا نكمل قراءة جسم ضخم لنرفضه بعد ذلك. لا نلغي التيار
         يدويًّا (cancel يفجّر رفضًا غير معالَج في أنابيب undici الداخلية):
         تركُه بلا قراءة كافٍ لتحريره، والخطأ يُرمى هنا فورًا. */
      throw new BodyTooLargeError(limitBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * قارئ JSON المركزي: يفرض الحد ثم يحلل.
 * يرمي BodyTooLargeError (413) أو MalformedBodyError (400) — والمسار
 * يعيدها بمعالج موحد عبر bodyErrorResponse().
 */
export async function readJsonBody<T = unknown>(request: Request, limitBytes: number): Promise<T> {
  const raw = await readBoundedBody(request, limitBytes);
  if (raw.length === 0) throw new MalformedBodyError();
  try {
    return JSON.parse(raw.toString("utf8")) as T;
  } catch {
    throw new MalformedBodyError();
  }
}

/**
 * قارئ form data المحدود: يقرأ بحد أعلى (يغطي multipart وurlencoded)
 * ثم يفكك من نسخة Request معاد بناؤها — لا formData على جسم غير محدود.
 */
export async function readBoundedFormData(request: Request, limitBytes: number): Promise<FormData> {
  const raw = await readBoundedBody(request, limitBytes);
  if (raw.length === 0) throw new MalformedBodyError("لا يوجد محتوى في الطلب.");
  const contentType = request.headers.get("content-type") ?? "";
  const rebuilt = new Request(request.url, {
    method: "POST",
    headers: { "content-type": contentType },
    body: Uint8Array.from(raw),
    // duplex ضروري لإرسال جسم في Request مبني يدويًّا.
    ...(raw.length > 0 ? ({ duplex: "half" } as RequestInit) : {}),
  });
  try {
    return await rebuilt.formData();
  } catch {
    throw new MalformedBodyError();
  }
}

/** تحويل أخطاء الأجسام إلى استجابة HTTP الصحيحة — 413 لا 500 أبدًا. */
export function bodyErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof BodyTooLargeError) {
    return NextResponse.json({ message: error.message }, { status: 413 });
  }
  if (error instanceof MalformedBodyError) {
    return NextResponse.json({ message: error.message }, { status: 400 });
  }
  return null;
}

/**
 * تحقق نوع المحتوى قبل القراءة — نصف سياسة المسارات العامة (S5):
 * JSON حيث يُتوقع JSON، يرفض التخمين الهادئ.
 */
export function hasJsonContentType(request: Request): boolean {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  return contentType.includes("application/json");
}
