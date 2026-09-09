import { NextResponse, type NextRequest } from "next/server";
import { PORTAL_COOKIE_NAME, SESSION_COOKIE } from "@/lib/sessionCookie";
import { buildCspHeaderValue } from "@/lib/csp";
import {
  MESSAGES_BODY_LIMIT_BYTES,
  PROXY_JSON_DECLARED_LIMIT_BYTES,
  UPLOAD_BODY_LIMIT_BYTES,
} from "@/lib/security-limits";

/**
 * الباب الوحيد — وحارس الأمن على مستوى الطلب (P2).
 *
 * الحماية هنا لا في كل مسار على حدة: مسارٌ جديد يُضاف غدًا يصير محميًا تلقائيًا، بينما
 * الحماية الموزّعة تُنسى في أول ملف. القائمة أدناه هي **ما يُسمح به** لا ما يُمنع —
 * والفرق جوهري: نسيان إضافة مسار هنا يعني إغلاقه، لا كشفه.
 *
 * التحقق هنا من وجود الكوكي وشكلها فقط؛ التحقق من التوقيع يجري في مسارات API نفسها،
 * لأن middleware يعمل على Edge حيث `node:crypto` غير متاح.
 *
 * ── ما أُضيف في P2 فوق بوابة الجلسة ──────────────────────────────────────────
 *
 * 1. CSP بـnonce لكل طلب (lib/csp.ts): سكربتات الإنتاج بلا unsafe-inline
 *    ولا unsafe-eval إطلاقًا. الـnonce يوضع في ترويسة الطلب فيطبّقه Next على
 *    سكربتاته، وفي ترويسة الرد فيلتزم به المتصفح.
 *
 * 2. حارس الـmutations (CSRF/Origin — P2/S4): كل POST/PUT/PATCH/DELETE على
 *    /api/* يمر هنا. طلب معتمد بالكوكي من متصفح: Sec-Fetch-Site: cross-site
 *    ⇒ رفض، Origin غير موثوق ⇒ رفض، غياب الاثنين (كوكي مسروق بلا متصفح)
 *    ⇒ رفض (fail-closed: عملاء البرنامج لهم مسار Bearer). طلبات Bearer
 *    الصريحة لا تُعامل CSRF — RBAC كامل في المسار نفسه.
 *
 * 3. سقف Content-Length معلن (P2/S8): طبقة شبكية تردّ الجسم المعلن الضخم
 *    ب413 قبل أي قراءة — متممة لقارئات الجسم المحدودة في المسارات.
 *
 * 4. Cache-Control: no-store على بيانات المرضى والطباعة والبوابة (P2/S12).
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
  // تسجيل الوصول والحضور الذاتي للمرضى عبر مسح الباركود بهواتفهم.
  "/checkin",
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
  // مسار تسجيل الحضور والوصول الذاتي للمريض عبر الباركود
  "/api/checkin",
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
 * مسارات يُفتح مرورها بالبادئة: تشغيل الرسائل الصوتية والمرفقات يشترك فيه
 * الطاقم والمرضى، فلا يصلح لها باب الطاقم (كوكي الطاقم) ولا قائمة البوابة
 * وحدها. المسار نفسه هو الحارس: يفحص جلسة البوابة أو جلسة الطاقم ثم يتحقق
 * أن الطالب طرفٌ في الرسالة — رسالة زميلين لا يسمعها ثالث، وخيط مريض يسمعه
 * الطاقم وصاحبه فقط.
 */
const PUBLIC_API_PREFIXES = ["/api/messages/voice/", "/api/messages/file/"];

/** الطلبات التي تغيّر حالة — حارس الـmutations يشملها كلها. */
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** هل اسم المضيف شكله سليم قبل أي مقارنة؟ (منطق lib/net.ts نفسه — Edge-safe) */
function isPlausibleHost(host: string): boolean {
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(host) && !host.includes("..");
}

/** المضيف الذي يراه الخادم للطلب — الأول من الوسيط الموثوق أو ترويسة Host. */
function requestHost(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded && isPlausibleHost(forwarded)) return forwarded.split(":")[0];
  const host = request.headers.get("host")?.split(",")[0]?.trim().toLowerCase();
  if (host && isPlausibleHost(host)) return host.split(":")[0];
  return "";
}

/** قائمة TRUSTED_HOSTS من البيئة — كما هي في lib/net.ts (نسخة Edge-safe). */
function trustedHostSet(): Set<string> {
  const raw = process.env.TRUSTED_HOSTS ?? "";
  const entries = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0 && entry.length <= 253);
  return new Set(entries);
}

/** هل هذا المضيف موثوق لمصلحة سياسة الأصل؟ نفس الأصل أو قائمة المشغّل. */
function isOriginTrusted(request: NextRequest, originHost: string): boolean {
  if (!originHost || !isPlausibleHost(originHost)) return false;
  const bare = originHost.split(":")[0];
  const trusted = trustedHostSet();
  if (trusted.size > 0 && (trusted.has(originHost) || trusted.has(bare))) return true;
  const own = requestHost(request);
  if (own && own === bare) return true;
  return false;
}

/**
 * حارس الـmutations المركزي — قرار واحد لكل الطلبات التي تغيّر الحالة.
 * يعيد سبب الرفض أو null إذا سمح.
 *
 * طلبات Bearer (عملاء بلا متصفح): تخضع لـRBAC/BOLA في المسار نفسه لا
 * لسياسة متصفح — التوكن لا يُرسل تلقائيًّا من أي موقع آخر، فخطر CSRF لا
 * ينطبق عليها أصلًا.
 */
function mutationGuardVerdict(request: NextRequest): string | null {
  const { pathname } = request.nextUrl;
  if (!pathname.startsWith("/api/")) return null;
  if (!MUTATION_METHODS.has(request.method)) return null;

  const authorization = request.headers.get("authorization") ?? "";
  if (authorization.toLowerCase().startsWith("bearer ")) return null;

  // أي جلسة مبنية على كوكي — طاقم أو بوابة — ترفع سقف التشدد: صاحب
  // الجلسة يمكن استدراجه من موقع آخر، وذاكرته تحمل الكوكي معه.
  const cookieAuthenticated = Boolean(request.cookies.get(SESSION_COOKIE)?.value)
    || Boolean(request.cookies.get(PORTAL_COOKIE_NAME)?.value);

  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase() ?? "";
  const origin = request.headers.get("origin");
  const originHost = origin ? safeOriginHost(origin) : null;

  // 1) متصفح أعلن cross-site بلسانه (ترويسة لا يكتبها JS): رفض قاطع.
  if (fetchSite === "cross-site") {
    return "طلب بين مواقع لعملية تغيّر الحالة — مرفوض.";
  }

  // 2) Origin معلن: يجب أن يكون موثوقًا — نفس المضيف أو قائمة المشغّل.
  if (origin !== null && originHost !== null) {
    if (!isOriginTrusted(request, originHost)) {
      return "أصل الطلب غير موثوق لعملية تغيّر الحالة — مرفوض.";
    }
    return null;
  }
  if (origin !== null) {
    // Origin موجود لكنه غير قابل للتحليل (ملغوم الشكل): رفض.
    return "أصل الطلب غير صالح — مرفوض.";
  }

  // 3) غياب Origin تمامًا:
  //    متصفح حديث دائمًا يرسل Origin على الطلبات التي تغيّر الحالة — غيابه
  //    مع أي كوكي يعني عميلًا اصطناعيًّا بكوكي منسوخ: نغلق الباب.
  if (cookieAuthenticated) {
    return "طلب مصادَق بالكوكي بلا أصل موثوق — مرفوض.";
  }
  // عملاء بلا متصفح على مسارات عامة (curl/تطبيق native): حدود المعدل
  // والحجم والنوع داخل المسار هي حمايتهم — الممنوع هنا هو cross-site
  // المعلن فقط (قاعدة 1).
  return null;
}

/** يستخرج مضيف Origin بأمان أو null إن كان ملغومًا. */
function safeOriginHost(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * سقف الحجم المعلن (Content-Length): ترويسة يكتبها العميل لكنها تُستخدم
 * هنا كشباك مبكر لا كحارس وحيد — القارئ المحدود في المسار هو الحكم.
 * multipart (رفع المستندات) له سقفه الأعلى، وJSON العادي أضيق بكثير.
 */
function declaredBodyLimitFor(request: NextRequest): number {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const { pathname } = request.nextUrl;
  if (contentType.includes("multipart/form-data")) {
    return UPLOAD_BODY_LIMIT_BYTES;
  }
  if (pathname === "/api/messages" || pathname === "/api/portal/messages") {
    return MESSAGES_BODY_LIMIT_BYTES;
  }
  return PROXY_JSON_DECLARED_LIMIT_BYTES;
}

/** يبني طلب الرد بترويسات الطلب المحدثة (CSP للـnonce) ويطبق أمن الرد. */
function securedNext(request: NextRequest): NextResponse {
  const nonce = crypto.randomUUID();
  const isProduction = process.env.NODE_ENV === "production";
  const { pathname } = request.nextUrl;
  const frameAncestors = /^\/api\/documents\/\d+$/.test(pathname) ? "'self'" : "'none'";
  const csp = buildCspHeaderValue({ nonce, isProduction, frameAncestors });

  const requestHeaders = new Headers(request.headers);
  // Next يقرأ CSP من ترويسات الطلب فيطبّق الـnonce على سكربتاته — ونمرره
  // أيضًا باسم صريح يقرؤه الخادم عند الحاجة.
  requestHeaders.set("Content-Security-Policy", csp);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  if (pathname.startsWith("/api/") || pathname.startsWith("/portal/") || pathname.startsWith("/print/")) {
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const authHeader = request.headers.get("authorization");
  const hasAuthHeader = Boolean(authHeader && authHeader.startsWith("Bearer "));
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value) || hasAuthHeader;

  // ── سقف الحجم المعلن (P2/S8): قبل أي معالجة أو قراءة. ──────────────────
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > declaredBodyLimitFor(request)) {
    return NextResponse.json(
      { message: "حجم الطلب يتجاوز الحد المسموح." },
      { status: 413 },
    );
  }

  // ── حارس الـmutations (P2/S4): قبل بوابة الجلسة — يشمل المسارات العامة. ──
  const verdict = mutationGuardVerdict(request);
  if (verdict) {
    return NextResponse.json({ message: verdict }, { status: 403 });
  }

  if (PUBLIC_API.has(pathname)
    || PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return securedNext(request);
  }

  // أصول التثبيت: بيان التطبيق وعامله وصفحة الانقطاع وأيقوناته. المتصفح يطلبها
  // قبل الدخول أصلًا — حجزها خلف الجلسة يكسر التثبيت كله. وهي ملفات عامة
  // لا تقرأ ولا تكتب شيئًا.
  if (pathname === "/manifest.webmanifest" || pathname === "/sw.js"
    || pathname === "/offline.html" || pathname.startsWith("/icons/")) {
    return securedNext(request);
  }

  // ملفات الشعار: شاشة الدخول نفسها تحمل الشعار، ومن يفتح النظام لأول مرة
  // لا يملك جلسة بعد — فحجزها خلف الجلسة يكسر أول شاشة يراها كل من يدخل.
  // صور ثابتة بلا أي قراءة بيانات.
  if (pathname === "/logo.png" || pathname === "/logo-white.png"
    || pathname === "/logo-icon.png" || pathname === "/favicon.png") {
    return securedNext(request);
  }

  if (pathname.startsWith("/api/")) {
    if (hasSession || process.env.NODE_ENV !== "production") return securedNext(request);
    // رسالة عربية حتى لمسارات API: قد تظهر في الواجهة كما هي.
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }

  // حماية المسارات غير العامة: تحويل الزوار غير المسجلين مباشرة إلى صفحة تسجيل الدخول
  const isPublicPage = PUBLIC_PATHS.has(pathname) || pathname.startsWith("/print/") || pathname.startsWith("/portal/");
  if (!isPublicPage && !hasSession && process.env.NODE_ENV === "production") {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return securedNext(request);
}

export const config = {
  // الملفات الساكنة وحدها خارج الحارس.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
