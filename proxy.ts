import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/sessionCookie";

/**
 * الباب الوحيد.
 *
 * الحماية هنا لا في كل مسار على حدة: مسارٌ جديد يُضاف غدًا يصير محميًا تلقائيًا، بينما
 * الحماية الموزّعة تُنسى في أول ملف. القائمة أدناه هي **ما يُسمح به** لا ما يُمنع —
 * والفرق جوهري: نسيان إضافة مسار هنا يعني إغلاقه، لا كشفه.
 *
 * التحقق هنا من وجود الكوكي وشكلها فقط؛ التحقق من التوقيع يجري في مسارات API نفسها،
 * لأن middleware يعمل على Edge حيث `node:crypto` غير متاح.
 */
const PUBLIC_PATHS = new Set([
  "/login",
  "/setup",
  // شاشة الصالة: تلفاز معلّق على الحائط لا لوحة مفاتيح معه. الجلسة تنتهي بعد اثنتي
  // عشرة ساعة، وربطها بها كان يعني شاشة سوداء كل صباح إلى أن يفتحها أحد ويسجّل الدخول.
  // ما يُسرّب مقابل ذلك محدود عمدًا: الاسم الأول ورقم الكرسي وعدد المنتظرين — أي ما
  // يراه ويسمعه كل جالس في الصالة أصلًا. لا هاتف ولا اسم كامل ولا رقم مريض.
  "/display",
  // صفحة طلب الموعد: مفتوحة للمرضى بالتعريف. لا تكتب في المواعيد — تكتب طلبًا
  // تؤكّده الاستقبال — فأسوأ ما يستطيعه العابث بها ملء قائمة طلبات.
  "/book",
  // بوابة المريض: كشف الحساب والمواعيد والاستمارة. الصفحة قشرة فارغة، وكل
  // مسارها يتحقق من جلسة البوابة الموقّعة على الخادم — لا معرّف من العميل أصلًا.
  "/portal",
]);
const PUBLIC_API = new Set([
  "/api/auth/login",
  "/api/auth/setup",
  "/api/auth/logout",
  "/api/auth/me",
  // فحص الإعداد: من يحتاجه هو من لا يستطيع الدخول بعد.
  "/api/health",
  // نبض المنصة. مغلقًا كان يعني أن فاحص Railway يتلقّى 401 إلى الأبد فلا تُعتمد
  // نشرة سليمة أبدًا — والحارس الذي يمنع الفحص يمنع التطبيق من أن يُولد.
  "/api/ping",
  // تغذية شاشة الصالة — تُبنى استجابتها على الخادم بما يُعرض فقط.
  "/api/display",
  // استقبال طلب الموعد. المسار الوحيد المفتوح للكتابة بلا جلسة، ومحدود بحدّين
  // يوميّين للرقم وللمصدر داخل المسار نفسه.
  "/api/book",
  // مسارات بوابة المريض. تُفتح للمرور فقط: كل واحد منها يفحص جلسة البوابة
  // الموقّعة بمجال منفصل عن جلسة الطاقم — فلا توكن طاقم يفتح بوابة ولا عكس،
  // ولا معرّف مريض يقبل من العميل إطلاقًا.
  "/api/portal/login",
  "/api/portal/logout",
  "/api/portal/me",
  "/api/portal/statement",
  "/api/portal/appointments",
  "/api/portal/appointments/confirm",
  "/api/portal/intake",
  // محادثة المريض مع العيادة — نفس عزل البوابة: المسار يتحقق من جلسة
  // البوابة الموقّعة قبل أن يعيد رسالة واحدة، والمريض لا يملك كوكي الطاقم
  // فيمرّ من هنا لا من باب الطاقم.
  "/api/portal/messages",
]);

/**
 * مسارات يُفتح مرورها بالبادئة: تشغيل الرسائل الصوتية يشترك فيه الطاقم
 * والمرضى، فلا يصلح لها باب الطاقم (كوكي الطاقم) ولا قائمة البوابة وحدها.
 * المسار نفسه هو الحارس: يفحص جلسة البوابة أو جلسة الطاقم ثم يتحقق أن
 * الطالب طرفٌ في الرسالة — رسالة زميلين لا يسمعها ثالث، وخيط مريض يسمعه
 * الطاقم وصاحبه فقط.
 */
const PUBLIC_API_PREFIXES = ["/api/messages/voice/"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const authHeader = request.headers.get("authorization");
  const hasAuthHeader = Boolean(authHeader && authHeader.startsWith("Bearer "));
  const hasUserHeader = Boolean(request.headers.get("x-session-user"));
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value) || hasAuthHeader || hasUserHeader;

  if (PUBLIC_API.has(pathname)
    || PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  // أصول التثبيت: بيان التطبيق وعامله وصفحة الانقطاع وأيقوناته. المتصفح يطلبها
  // قبل الدخول أصلًا — حجزها خلف الجلسة يكسر التثبيت كله. وهي ملفات عامة
  // لا تقرأ ولا تكتب شيئًا.
  if (pathname === "/manifest.webmanifest" || pathname === "/sw.js"
    || pathname === "/offline.html" || pathname.startsWith("/icons/")) {
    return NextResponse.next();
  }

  // ملفات الشعار: شاشة الدخول نفسها تحمل الشعار، ومن يفتح النظام لأول مرة
  // لا يملك جلسة بعد — فحجزها خلف الجلسة يكسر أول شاشة يراها كل من يدخل.
  // صور ثابتة بلا أي قراءة بيانات.
  if (pathname === "/logo.png" || pathname === "/logo-white.png"
    || pathname === "/logo-icon.png" || pathname === "/favicon.png") {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    if (hasSession || process.env.NODE_ENV !== "production") return NextResponse.next();
    // رسالة عربية حتى لمسارات API: قد تظهر في الواجهة كما هي.
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }

  return NextResponse.next();
}

export const config = {
  // الملفات الساكنة وحدها خارج الحارس.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
