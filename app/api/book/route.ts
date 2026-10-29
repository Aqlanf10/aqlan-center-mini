import { createHash } from "node:crypto";
import { clientIpFromForwardedFor } from "@/lib/net";
import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, createBookingRequest, getSettings } from "@/lib/db";
import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/idempotency-key";
import { publicBookingCatalog, publicBookingTimes, validatePublicBookingSelection } from "@/lib/public-booking";
import { validateBookingRequest } from "@/lib/booking";
import { clinicDateString } from "@/lib/schedule";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { BOOK_RATE_LIMIT, JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { consumeSecurityLimit } from "@/lib/security-rate-limit";

export const dynamic = "force-dynamic";

/**
 * حدّان يوميّان: أحدهما للرقم والآخر للمصدر.
 *
 * حدّ الرقم هو الحدّ الحقيقي — ثلاثة طلبات في يوم من رقم واحد تكفي أكثر من الحاجة.
 * أما حدّ المصدر فمرفوع عمدًا: مشغّلو الجوال في اليمن يشاركون عنوانًا واحدًا بين آلاف
 * المشتركين (CGNAT)، فحدٌّ ضيّق عليه كان سيمنع مريضة لم ترسل شيئًا لأن غريبًا على
 * نفس الشبكة أرسل قبلها — وهو بالضبط «العيادة لا تهتم» الذي نعالجه. يبقى الحدّ
 * موجودًا ليوقف من يرسل ألفًا في دقيقة، لا ليحكم على مريض.
 */


/**
 * بصمة مصدر الطلب — لا عنوانه.
 *
 * العدّ يحتاج تمييز المُرسِل، ولا يحتاج معرفته. التجزئة بمفتاح الجلسات كملح تجعل
 * الجدول عديم الفائدة لمن يقرأه: لا يمكن استخراج عنوان منه ولا مطابقته بجدول آخر.
 */
function sourceHash(request: Request): string | null {
  /* (P0.15) العنوان الأخير في السلسلة — الذي أضافه الوسيط الموثوق — لا الأول
   * الذي يستطيع العميل كتابته فيتحدّى بصمة المصدر الخاصة به. */
  const address = clientIpFromForwardedFor(request.headers.get("x-forwarded-for"));
  if (!address) return null;
  const salt = process.env.SESSION_SECRET ?? "";
  return createHash("sha256").update(`${salt}|${address}`).digest("hex").slice(0, 32);
}

/**
 * طلب حجز من مريض — المسار الوحيد المفتوح للكتابة بلا جلسة.
 *
 * ولأنه كذلك، لا يكتب في جدول المواعيد إطلاقًا: يكتب طلبًا تراه الاستقبال. أسوأ ما
 * يستطيعه من يعبث به هو ملء قائمة طلبات — لا إفساد يوم عمل ولا حجز كرسي.
 */
export async function POST(request: Request) {
  /* (P2/S10) حدّ نافذة قصيرة موزّع فوق الحدّين اليوميّين القائمين (اللذين
     لم يُمسّا): سيلٌ متزامن في دقائق لا ينتظر عدّاد اليوم ليوقفه. */
  const burst = await consumeSecurityLimit({
    scope: "book",
    identifier: "public",
    maximum: BOOK_RATE_LIMIT.maximum,
    windowMinutes: BOOK_RATE_LIMIT.windowMinutes,
    headers: request.headers,
  });
  if (!burst.allowed) {
    return NextResponse.json(
      { message: "طلبات كثيرة. أعد المحاولة بعد قليل." },
      { status: 429, headers: { "Retry-After": String(Math.max(1, burst.retryAfterSeconds)) } },
    );
  }
  let body: unknown;
  try {
    /* (P2/S8) جسم محدود — بيانات حجز صغيرة بطبيعتها، وأي تضخيم إساءة. */
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  // حقل مخفي لا يراه المريض ولا يملؤه: الملأ يعني برنامجًا آليًا. يُقبل الطلب ظاهريًا
  // ولا يُكتب — الرفض الصريح يُعلّم كاتب البرنامج كيف يتجاوزه.
  if (typeof source.website === "string" && source.website.trim()) {
    return NextResponse.json({ received: true });
  }

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  /* أقصى مدى للحجز من الإعداد `scheduling.max_days_ahead` — والافتراضيّ داخل
     الدالّة يحفظ سلوك اليوم إن غاب المفتاح أو فسد. */
  const bookingSettings = await getSettings();
  const validation = validateBookingRequest(
    source, today, Number(bookingSettings["scheduling.max_days_ahead"]),
  );
  if (!validation.ok) {
    return NextResponse.json({ message: validation.message }, { status: 400 });
  }

  try {
    const hash = sourceHash(request);
    const requestKey = request.headers.get("Idempotency-Key");
    if (requestKey !== null && !IDEMPOTENCY_KEY_PATTERN.test(requestKey)) {
      return NextResponse.json({ message: "معرّف الطلب غير صالح." }, { status: 400 });
    }
    await createBookingRequest(validation.value, hash, requestKey,
      () => validatePublicBookingSelection(validation.value));
    // لا يُعاد أي شيء من السجل: الصفحة عامة، ولا سبب يجعلها تعرف مُعرّفات قاعدة البيانات.
    return NextResponse.json({ received: true }, { status: 201 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const errors: Record<string, [number, string]> = {
      BOOKING_KEY_CONFLICT: [409, "تغيّرت بيانات محاولة الإرسال. ارجع للملخص وابدأ طلبًا جديدًا."],
      BOOKING_PHONE_LIMIT: [429, "وصلتنا طلباتكم اليوم وسنتصل بكم. للحالات المستعجلة اتصلوا بالمركز مباشرة."],
      BOOKING_SOURCE_LIMIT: [429, "تعذّر استقبال الطلب الآن. اتصلوا بالمركز مباشرة لحجز موعدكم."],
      BOOKING_SELECTION_INVALID: [400, "الاختيارات غير متاحة الآن. حدّث الأوقات واختر موعدًا ضمن الدوام."],
      BOOKING_SLOT_UNAVAILABLE: [409, "لم يعد الوقت متاحًا. حدّث الأوقات واختر وقتًا آخر."],
    };
    if (errors[code]) return NextResponse.json({ message: errors[code][1] }, { status: errors[code][0], headers: { "Cache-Control": "no-store" } });
    return NextResponse.json(
      { message: "تعذّر إرسال الطلب. أعيدوا المحاولة أو اتصلوا بالمركز." },
      { status: 503 },
    );
  }
}

/** Same public path and existing abuse controls; no private availability route is exposed. */
export async function GET(request: Request) {
  const limit = await consumeSecurityLimit({ scope: "book-availability", identifier: sourceHash(request) ?? "public",
    maximum: BOOK_RATE_LIMIT.maximum * 20, windowMinutes: BOOK_RATE_LIMIT.windowMinutes, headers: request.headers });
  if (!limit.allowed) return NextResponse.json({ message: "طلبات كثيرة. أعد المحاولة بعد قليل." },
    { status: 429, headers: { "Retry-After": String(Math.max(1, limit.retryAfterSeconds)) } });
  try {
    const query = new URL(request.url).searchParams;
    const result = query.has("date")
      ? await publicBookingTimes(query.get("date") ?? "", Number(query.get("serviceId")), Number(query.get("doctorId")))
      : await publicBookingCatalog();
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const invalid = error instanceof Error && error.message === "BOOKING_SELECTION_INVALID";
    return NextResponse.json({ message: invalid ? "اختر يومًا وخدمة وطبيبًا متاحين." : "تعذّر تحميل الأوقات. أعد المحاولة." },
      { status: invalid ? 400 : 503, headers: { "Cache-Control": "no-store" } });
  }
}
