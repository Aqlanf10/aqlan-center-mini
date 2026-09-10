import { createHash } from "node:crypto";
import { clientIpFromForwardedFor } from "@/lib/net";
import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, countRecentRequests, createBookingRequest } from "@/lib/db";
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
const MAX_PER_PHONE_PER_DAY = 3;
const MAX_PER_SOURCE_PER_DAY = 60;

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
  const validation = validateBookingRequest(source, today);
  if (!validation.ok) {
    return NextResponse.json({ message: validation.message }, { status: 400 });
  }

  try {
    const hash = sourceHash(request);
    const recent = await countRecentRequests(validation.value.phone, hash);
    // رسالتان مختلفتان: من أرسل ثلاثة طلبات اليوم يُقال له إنها وصلت، ومن مُنع بسبب
    // مصدرٍ مزدحم لم يرسل شيئًا — فإخباره «وصلتنا طلباتكم» كذبٌ يجعله ينتظر ردًّا
    // لن يأتي. لكلٍّ رسالته، وكلتاهما تعطيه طريقًا آخر إلى العيادة.
    if (recent.byPhone >= MAX_PER_PHONE_PER_DAY) {
      return NextResponse.json(
        { message: "وصلتنا طلباتكم اليوم وسنتصل بكم. للحالات المستعجلة اتصلوا بالمركز مباشرة." },
        { status: 429 },
      );
    }
    if (recent.bySource >= MAX_PER_SOURCE_PER_DAY) {
      return NextResponse.json(
        { message: "تعذّر استقبال الطلب الآن. اتصلوا بالمركز مباشرة لحجز موعدكم." },
        { status: 429 },
      );
    }
    await createBookingRequest(validation.value, hash);
    // لا يُعاد أي شيء من السجل: الصفحة عامة، ولا سبب يجعلها تعرف مُعرّفات قاعدة البيانات.
    return NextResponse.json({ received: true }, { status: 201 });
  } catch {
    return NextResponse.json(
      { message: "تعذّر إرسال الطلب. أعيدوا المحاولة أو اتصلوا بالمركز." },
      { status: 503 },
    );
  }
}
