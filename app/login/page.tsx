"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Logo } from "@/components/Icon";
import { LoginPhoto } from "@/components/LoginPhoto";
import { useClinicName, useSetting } from "@/components/SettingsProvider";
import { useSessionActions } from "@/components/SessionProvider";
import {
  AlertCircle,
  AlertTriangle,
  Eye,
  EyeOff,
  HelpCircle,
  Loader2,
  Lock,
  LogIn,
  ShieldCheck,
  Sparkles,
  User,
  WifiOff,
  X,
} from "lucide-react";
import { InstallApp } from "@/components/InstallApp";

const SAVED_USERNAME_KEY = "aqlan_center_saved_username";

export default function LoginPage() {
  const router = useRouter();
  const { setSession } = useSessionActions();
  const clinicName = useClinicName();
  const doctor = useSetting("clinic.lead_doctor");
  const doctorTitle = useSetting("clinic.lead_doctor_title");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberUsername, setRememberUsername] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [showForgotHelp, setShowForgotHelp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invalidField, setInvalidField] = useState<"username" | "password" | "credentials" | null>(null);
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const loginInFlight = useRef(false);

  const usernameInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  // 1. قراءة أخطاء الرابط + استرجاع اسم المستخدم المحفوظ + التركيز التلقائي + مراقبة الإنترنت
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const err = params.get("error");
      if (err === "invalid_credentials") {
        setError("اسم المستخدم أو كلمة المرور غير صحيحة.");
      } else if (err === "missing_fields") {
        setError("يرجى إدخال اسم المستخدم وكلمة المرور.");
      } else if (err === "invalid_request") {
        setError("حدث خطأ في الطلب، يرجى المحاولة من جديد.");
      } else if (err === "server_error") {
        setError("حدث خطأ في الخادم، يرجى المحاولة لاحقاً.");
      } else if (err === "rate_limited") {
        setError("تم إيقاف المحاولات مؤقتاً لحماية الحساب، يرجى المحاولة لاحقاً.");
      }
    } catch {
      // ignore
    }

    // Remember only an explicitly opted-in username; never passwords or session data.
    try {
      const savedUser = localStorage.getItem(SAVED_USERNAME_KEY);
      if (savedUser) {
        setUsername(savedUser);
        setRememberUsername(true);
      }
    } catch {
      // Storage can be disabled on shared/private devices.
    }

    // مستشعر حالة الاتصال بالإنترنت (Online / Offline Detector)
    const updateOnlineStatus = () => {
      setIsOffline(typeof navigator !== "undefined" ? !navigator.onLine : false);
    };
    updateOnlineStatus();
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);

    return () => {
      window.removeEventListener("online", updateOnlineStatus);
      window.removeEventListener("offline", updateOnlineStatus);
    };
  }, []);

  // 2. فحص حالة زر Caps Lock أثناء الكتابة
  function handleKeyEvent(event: React.KeyboardEvent<HTMLInputElement>) {
    if (typeof event.getModifierState === "function") {
      setCapsLockOn(event.getModifierState("CapsLock"));
    }
  }

  async function performLogin(targetUsername: string, targetPass: string) {
    const trimmedUsername = targetUsername.trim();
    if (!trimmedUsername) {
      setInvalidField("username");
      setError("يرجى إدخال اسم المستخدم.");
      usernameInputRef.current?.focus();
      return;
    }
    if (!targetPass) {
      setInvalidField("password");
      setError("يرجى إدخال كلمة المرور.");
      passwordInputRef.current?.focus();
      return;
    }

    // navigator.onLine is a browser hint, not proof the clinic server is unreachable.
    if (loginInFlight.current) return;
    loginInFlight.current = true;

    setBusy(true);
    setError(null);
    setInvalidField(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: trimmedUsername, password: targetPass }),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        if (response.status === 429) {
          setError(
            payload?.message ??
              "تم تجاوز عدد المحاولات المسموحة لحماية الحساب. يرجى المحاولة لاحقاً."
          );
        } else if (response.status === 401 || response.status === 400) {
          setInvalidField("credentials");
          setError(
            payload?.message ??
              "اسم المستخدم أو كلمة المرور غير صحيحة. يرجى التحقق وإعادة المحاولة."
          );
        } else if (response.status === 403) {
          setError("هذا الحساب غير مفعّل حالياً. يرجى مراجعة إدارة المركز.");
        } else if (response.status >= 500) {
          setError(
            "حدث خطأ داخلي في الخادم أثناء معالجة الطلب. يرجى المحاولة بعد قليل."
          );
        } else {
          setError(
            payload?.message ?? "تعذّر تسجيل الدخول. يرجى المحاولة مرة أخرى."
          );
        }
        loginInFlight.current = false;
        setBusy(false);
        return;
      }

      // A 200 response alone is not a usable login result.
      if (typeof payload?.username !== "string" || !payload.username.trim()
        || typeof payload?.role !== "string" || !payload.role.trim()) {
        setError("تعذّر تأكيد تسجيل الدخول. يرجى المحاولة مرة أخرى.");
        loginInFlight.current = false;
        setBusy(false);
        return;
      }

      // حفظ أو مسح اسم المستخدم حسب رغبة المستخدم على جهاز العيادة
      try {
        if (rememberUsername) {
          localStorage.setItem(SAVED_USERNAME_KEY, trimmedUsername);
        } else {
          localStorage.removeItem(SAVED_USERNAME_KEY);
        }
      } catch {
        // ignore storage errors
      }

      // (P2-FIX-1) تحديث حالة الجلسة في سياق التطبيق — الجلسة كوكي HttpOnly
      // ضبطها الخادم في الرد نفسه، والعرض هنا بياناتٍ غير حساسة فقط.
      // لا توكن يُستلم ولا يُخزَّن في JavaScript إطلاقاً.
      if (payload?.username) {
        setSession({
          username: payload.username,
          displayName: payload.displayName,
          role: payload.role,
        });
      }

      // Preserve the existing route/session contract; embedded login is owned by its provider.
      if (typeof window !== "undefined" && window.location.pathname === "/login") {
        router.replace("/");
      }
    } catch {
      setError(
        "تعذّر الاتصال بالخادم. يرجى التحقق من اتصال الإنترنت ثم إعادة المحاولة."
      );
      loginInFlight.current = false;
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || loginInFlight.current) return;

    const form = event.currentTarget;
    const formData = new FormData(form);
    const formUsername =
      (formData.get("username") as string) ||
      usernameInputRef.current?.value ||
      username;
    const formPassword =
      (formData.get("password") as string) ||
      passwordInputRef.current?.value ||
      password;

    await performLogin(formUsername, formPassword);
  }

  return (
    <main dir="rtl" className="relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas p-4 sm:p-6 lg:p-10">
      {/* ألوان الهوية من tailwind.config.ts؛ لا لوحة منفصلة لشاشة الدخول. */}
      <div
        className="pointer-events-none absolute -top-40 -right-40 bg-navy-900 h-96 w-96 rounded-full opacity-[0.15] blur-3xl"

        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-40 -left-40 bg-brand-orange h-96 w-96 rounded-full opacity-[0.15] blur-3xl"

        aria-hidden="true"
      />

      <div className="relative z-10 w-full max-w-5xl">
        {/* البطاقة المزدوجة بأسلوب Google Workspace الفخم */}
        <div className="grid grid-cols-1 overflow-hidden rounded-[28px] border border-slate-200/80 bg-white shadow-raised lg:grid-cols-12">

          {/* القسم الأيمن: الهوية البصرية للمركز + الشعار + صورة الدكتور */}
          <div
            className="relative flex flex-col justify-between overflow-hidden bg-gradient-to-bl from-navy-900 via-navy-800 to-navy-950 p-5 text-white sm:p-8 lg:col-span-6"
          >
            {/* توهجات جمالية خلف الشعار والصورة */}
            <div
              className="pointer-events-none absolute -top-24 -right-24 bg-brand-orange h-72 w-72 rounded-full opacity-25 blur-3xl"

              aria-hidden="true"
            />
            <div
              className="pointer-events-none absolute -bottom-24 -left-24 bg-navy-800 h-72 w-72 rounded-full opacity-20 blur-3xl"

              aria-hidden="true"
            />

            {/* الشريط العلوي: الشعار الرسمي ووسام الهوية */}
            <div className="relative z-10 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 rounded-2xl border border-white/15 bg-white/10 px-3.5 py-2 backdrop-blur-md shadow-inner">
                <Logo variant="white" className="h-11 w-11 shrink-0" />
                <div className="hidden sm:block border-r border-white/15 pr-3">
                  <span className="block text-[11px] font-bold tracking-wide text-brand-orange">
                    AQLAN DENTAL CENTER
                  </span>
                  <span className="block text-[10px] text-white/75">
                    النظام السريري المتكامل
                  </span>
                </div>
              </div>

              <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-orange/40 bg-brand-orange/15 px-3 py-1 text-[11px] font-bold text-brand-orange">
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                <span>بوابة المركز</span>
              </span>
            </div>

            {/* الوسط: صورة الدكتور (إن وجدت) + اسم المركز واللقب العلمي */}
            <div className="relative z-10 my-4 flex flex-col items-center text-center lg:my-8">
              <LoginPhoto />

              <h1 className="text-lg sm:text-xl lg:text-2xl font-extrabold leading-relaxed text-white">
                {clinicName}
              </h1>

              {/* فاصل لوني بألوان الشعار */}
              <div className="my-3 flex items-center justify-center gap-1.5">
                <span className="h-1 w-10 rounded-full bg-brand-orange" />
                <span className="h-1 w-3 rounded-full bg-white/40" />
              </div>

              <p className="max-w-md text-xs sm:text-sm font-medium leading-relaxed text-slate-200/90">
                {doctor}
                {doctorTitle ? ` — ${doctorTitle}` : ""}
              </p>
            </div>

            {/* التذييل السفلي للبطاقة اليمنى مع مستشعر الاتصال الفعلي */}
            <div className="relative z-10 flex items-center justify-between border-t border-white/10 pt-4 text-[11px] text-white/75">
              <span className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${
                    isOffline ? "bg-amber-400" : "bg-white/60"
                  }`}
                />
                <span>
                  {isOffline
                    ? "وضع عدم الاتصال — تحقق من الشبكة"
                    : "بوابة النظام السريري"}
                </span>
              </span>
              <span className="font-medium text-white/60">
                تقويم • زراعة • تجميل
              </span>
            </div>
          </div>

          {/* القسم الأيسر: نموذج تسجيل الدخول + زر تثبيت التطبيق */}
          <div className="flex flex-col justify-between bg-white p-5 sm:p-10 lg:col-span-6 lg:p-12">
            <div className="my-auto mx-auto w-full max-w-sm">

              {/* ترويسة نموذج الدخول مع الشعار الملون للجوال */}
              <div className="mb-6">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3.5">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-100 bg-slate-50 p-1.5 lg:hidden">
                      <Logo className="h-full w-full" />
                    </div>
                    <div>
                      <p className="text-lg font-extrabold text-navy-900">
                        تسجيل الدخول
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        أدخل بيانات الاعتماد للوصول إلى لوحة التحكم
                      </p>
                    </div>
                  </div>
                  <span className="rounded-xl border border-brand-orange/25 bg-brand-orange/10 px-3 py-1.5 text-[11px] font-bold text-navy-900">
                    بوابة الطاقم الطبي
                  </span>
                </div>
              </div>

              {/* تنبيه انقطاع الإنترنت الفوري إن وجد */}
              {isOffline && (
                <div
                  role="status"
                  className="mb-4 flex items-center gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-medium text-amber-800"
                >
                  <WifiOff className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
                  <span>يبدو أن الجهاز غير متصل بالإنترنت حالياً.</span>
                </div>
              )}

              <form
                id="login-form"
                noValidate
                aria-busy={busy}
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit(e);
                }}
                className="w-full space-y-4"
              >
                {/* حقل اسم المستخدم */}
                <div>
                  <label
                    className="mb-1.5 block text-xs font-bold text-navy-900"
                    htmlFor="username"
                  >
                    اسم المستخدم
                  </label>
                  <div className="relative">
                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3.5 text-slate-400">
                      <User className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <input
                      ref={usernameInputRef}
                      id="username"
                      aria-invalid={invalidField === "username" || invalidField === "credentials"}
                      name="username"
                      type="text"
                      dir="ltr"
                      value={username}
                      onChange={(event) => {
                        setUsername(event.target.value);
                        if (error) setError(null);
                        setInvalidField(null);
                      }}
                      onKeyUp={handleKeyEvent}
                      onKeyDown={handleKeyEvent}
                      disabled={busy}
                      required
                      aria-describedby={error ? "login-error-alert" : undefined}
                      autoComplete="username"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="اسم المستخدم"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50/70 pr-10 pl-3.5 py-3 text-right text-sm text-slate-900 outline-none transition-all placeholder:text-slate-400 focus:border-brand-orange focus:bg-white focus:ring-4 focus:ring-brand-orange/15 disabled:bg-slate-100 disabled:text-slate-500"
                    />
                  </div>
                </div>

                {/* حقل كلمة المرور */}
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <label
                      className="block text-xs font-bold text-navy-900"
                      htmlFor="password"
                    >
                      كلمة المرور
                    </label>
                    <button
                      type="button"
                      ref={helpButtonRef}
                      aria-expanded={showForgotHelp}
                      aria-controls="login-help"
                      onClick={() => setShowForgotHelp((prev) => !prev)}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-navy-900 transition-colors"
                    >
                      <HelpCircle className="h-3 w-3 text-brand-orange" aria-hidden="true" />
                      <span>نسيت كلمة المرور؟</span>
                    </button>
                  </div>

                  <div className="relative">
                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3.5 text-slate-400">
                      <Lock className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <input
                      ref={passwordInputRef}
                      id="password"
                      aria-invalid={invalidField === "password" || invalidField === "credentials"}
                      name="password"
                      type={showPassword ? "text" : "password"}
                      dir="ltr"
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        if (error) setError(null);
                        setInvalidField(null);
                      }}
                      onKeyUp={handleKeyEvent}
                      onKeyDown={handleKeyEvent}
                      onBlur={() => setCapsLockOn(false)}
                      disabled={busy}
                      required
                      aria-describedby={error ? "login-error-alert" : undefined}
                      autoComplete="current-password"
                      placeholder="••••••••"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50/70 pr-10 pl-10 py-3 text-right text-sm text-slate-900 font-sans outline-none transition-all placeholder:text-slate-400 focus:border-brand-orange focus:bg-white focus:ring-4 focus:ring-brand-orange/15 disabled:bg-slate-100 disabled:text-slate-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((prev) => !prev)}
                      disabled={busy}
                      aria-pressed={showPassword}
                      aria-label={
                        showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"
                      }
                      className="absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-500 hover:text-navy-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy-900 disabled:opacity-50 transition-colors"
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <Eye className="h-4 w-4" aria-hidden="true" />
                      )}
                    </button>
                  </div>

                  {/* تنبيه Caps Lock الذكي */}
                  {capsLockOn && (
                    <div role="status" className="mt-2 flex items-center gap-1.5 text-[11px] font-semibold text-warning-900">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-brand-orange" aria-hidden="true" />
                      <span>تنبيه: زر الحروف الكبيرة (Caps Lock) مفعّل حالياً.</span>
                    </div>
                  )}
                </div>

                {/* صندوق إرشاد استعادة كلمة المرور */}
                {showForgotHelp && (
                  <div id="login-help" className="relative rounded-xl border border-slate-200 bg-slate-50 p-3 pl-10 text-xs leading-relaxed text-slate-600">
                    <button
                      type="button"
                      onClick={() => { setShowForgotHelp(false); helpButtonRef.current?.focus(); }}
                      aria-label="إغلاق الإرشاد"
                      className="absolute left-2.5 top-2.5 text-slate-400 hover:text-slate-600"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                    <p className="font-bold text-navy-900 mb-1">
                      استعادة بيانات الدخول:
                    </p>
                    للمساعدة في استعادة الوصول أو تفعيل الحساب، راجع{" "}
                    <span className="font-bold text-navy-900">
                      مدير النظام
                    </span>{" "}
                    في المركز.
                  </div>
                )}

                {/* خيار تذكر اسم المستخدم على جهاز العيادة */}
                <div className="flex items-center justify-between pt-0.5">
                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-600 select-none">
                    <input
                      type="checkbox"
                      checked={rememberUsername}
                      onChange={(e) => {
                        setRememberUsername(e.target.checked);
                        if (!e.target.checked) {
                          try { localStorage.removeItem(SAVED_USERNAME_KEY); } catch { /* Storage unavailable. */ }
                        }
                      }}
                      disabled={busy}
                      className="h-4 w-4 rounded border-slate-300 text-navy-900 focus:ring-brand-orange"
                    />
                    <span>تذكّر اسم المستخدم على هذا الجهاز</span>
                  </label>
                </div>

                {/* رسالة التنبيه عند وجود خطأ */}
                {error ? (
                  <div
                    id="login-error-alert"
                    role="alert"
                    className="flex items-start gap-2.5 rounded-xl border border-danger-300 bg-danger-50 p-3.5 text-xs font-medium text-danger-900 shadow-sm"
                  >
                    <AlertCircle
                      className="mt-0.5 h-4 w-4 shrink-0 text-danger-600"
                      aria-hidden="true"
                    />
                    <div className="flex-1 leading-relaxed">{error}</div>
                  </div>
                ) : null}

                {/* زر تسجيل الدخول بهوية المركز */}
                <button
                  id="login-submit-btn"
                  type="submit"
                  disabled={busy}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-navy-900 py-3.5 text-sm font-bold text-white shadow-lg shadow-navy-900/20 transition-all hover:opacity-95 active:scale-[0.99] focus:ring-2 focus:ring-brand-orange focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy ? (
                    <>
                      <Loader2
                        className="h-4 w-4 animate-spin text-brand-orange"
                        aria-hidden="true"
                      />
                      <span>جارٍ التحقق وتأكيد الدخول…</span>
                    </>
                  ) : (
                    <>
                      <LogIn
                        className="h-4 w-4 text-brand-orange"
                        aria-hidden="true"
                      />
                      <span>دخول النظام</span>
                    </>
                  )}
                </button>
              </form>

              {/* (INSTALL-1) تثبيت البرنامج على هذا الجهاز: أيقونة على سطح المكتب تفتحه في نافذته بلا رابط. */}
              <div className="mt-6 border-t border-slate-100 pt-5 flex flex-col items-center gap-3">
                <InstallApp label="ثبّت البرنامج على هذا الجهاز" />
                <div className="flex items-center gap-1.5 text-[11px] text-slate-600">
                  <ShieldCheck
                    className="h-3.5 w-3.5 text-emerald-600"
                    aria-hidden="true"
                  />
                  <span>لا تشارك بيانات الدخول مع الآخرين</span>
                </div>
              </div>

            </div>
          </div>

        </div>
      </div>
    </main>
  );
}
