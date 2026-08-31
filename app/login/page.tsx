"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Logo } from "@/components/Icon";
import { useClinicName, useSetting } from "@/components/SettingsProvider";
import { useSessionActions } from "@/components/SessionProvider";
import { AlertCircle, Eye, EyeOff, Loader2, Lock, LogIn, User } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const { setSession } = useSessionActions();
  const clinicName = useClinicName();
  const doctor = useSetting("clinic.lead_doctor");
  const doctorTitle = useSetting("clinic.lead_doctor_title");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const usernameInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);

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
      }
    } catch {
      // ignore
    }
  }, []);

  async function performLogin(targetUsername: string, targetPass: string) {
    const trimmedUsername = targetUsername.trim();
    if (!trimmedUsername) {
      setError("يرجى إدخال اسم المستخدم.");
      return;
    }
    if (!targetPass) {
      setError("يرجى إدخال كلمة المرور.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: trimmedUsername, password: targetPass }),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        if (response.status === 401 || response.status === 400) {
          setError(payload?.message ?? "اسم المستخدم أو كلمة المرور غير صحيحة. يرجى التحقق وإعادة المحاولة.");
        } else if (response.status === 403) {
          setError("هذا الحساب غير مفعّل حالياً. يرجى مراجعة إدارة المركز.");
        } else if (response.status >= 500) {
          setError("حدث خطأ داخلي في الخادم أثناء معالجة الطلب. يرجى المحاولة بعد قليل.");
        } else {
          setError(payload?.message ?? "تعذّر تسجيل الدخول. يرجى المحاولة مرة أخرى.");
        }
        setBusy(false);
        return;
      }

      // تحديث حالة الجلسة فوراً في سياق التطبيق والتخزين المحلي
      if (payload?.username) {
        setSession({
          username: payload.username,
          displayName: payload.displayName,
          role: payload.role,
          token: payload.token,
        });
      }

      // إذا كانت الصفحة الحالية صفحة /login، نقوم بالانتقال للصفحة الرئيسية بسلاسة
      if (typeof window !== "undefined" && window.location.pathname === "/login") {
        router.replace("/");
      }
    } catch {
      setError("تعذّر الاتصال بالخادم. يرجى التحقق من اتصال الإنترنت ثم إعادة المحاولة.");
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    const form = event.currentTarget;
    const formData = new FormData(form);
    const formUsername = (formData.get("username") as string) || usernameInputRef.current?.value || username;
    const formPassword = (formData.get("password") as string) || passwordInputRef.current?.value || password;

    await performLogin(formUsername, formPassword);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-navy-900 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <Logo variant="white" className="mx-auto h-16 w-16" />
          <h1 className="mt-3 text-base font-bold leading-snug text-white">{clinicName}</h1>
          <p className="mt-1 text-xs font-medium text-navy-300">
            {doctor}{doctorTitle ? ` — ${doctorTitle}` : ""}
          </p>
        </div>

        <form
          id="login-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(e);
          }}
          className="w-full rounded-2xl bg-white p-6 shadow-raised transition-all"
        >
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <p className="text-sm font-bold text-navy-900">تسجيل الدخول</p>
            <span className="text-[11px] font-medium text-slate-600">بوابة الطاقم الطبي</span>
          </div>

          <div className="mt-4">
            <label className="block text-xs font-bold text-navy-900 mb-1" htmlFor="username">
              اسم المستخدم
            </label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400">
                <User className="h-4 w-4" aria-hidden="true" />
              </div>
              <input
                ref={usernameInputRef}
                id="username"
                name="username"
                type="text"
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  if (error) setError(null);
                }}
                disabled={busy}
                required
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="اسم المستخدم"
                className="w-full rounded-xl border border-slate-200 bg-white pr-9 pl-3 py-2.5 text-sm text-slate-900 outline-none transition-colors focus:border-brand-blue focus:ring-1 focus:ring-brand-blue disabled:bg-slate-50 disabled:text-slate-500"
              />
            </div>
          </div>

          <div className="mt-3.5">
            <label className="block text-xs font-bold text-navy-900 mb-1" htmlFor="password">
              كلمة المرور
            </label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400">
                <Lock className="h-4 w-4" aria-hidden="true" />
              </div>
              <input
                ref={passwordInputRef}
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (error) setError(null);
                }}
                disabled={busy}
                required
                autoComplete="current-password"
                placeholder="••••••••"
                className="w-full rounded-xl border border-slate-200 bg-white pr-9 pl-10 py-2.5 text-sm text-slate-900 outline-none transition-colors focus:border-brand-blue focus:ring-1 focus:ring-brand-blue disabled:bg-slate-50 disabled:text-slate-500 font-sans"
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowPassword((prev) => !prev)}
                disabled={busy}
                aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
                className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400 hover:text-slate-600 focus:outline-none disabled:opacity-50"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
          </div>

          {error ? (
            <div
              id="login-error-alert"
              role="alert"
              className="mt-3 flex items-start gap-2.5 rounded-xl border border-danger-300 bg-danger-50 p-3 text-xs font-medium text-danger-800"
            >
              <AlertCircle className="h-4 w-4 shrink-0 text-danger-600 mt-0.5" aria-hidden="true" />
              <div className="flex-1 leading-relaxed">{error}</div>
            </div>
          ) : null}

          <button
            id="login-submit-btn"
            type="submit"
            disabled={busy}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-navy-900 py-3 text-sm font-bold text-white shadow-sm transition-all hover:bg-navy-800 active:scale-[0.99] focus:ring-2 focus:ring-navy-900 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin text-white" aria-hidden="true" />
                <span>جارٍ التحقق وتأكيد الدخول…</span>
              </>
            ) : (
              <>
                <LogIn className="h-4 w-4 text-white/90" aria-hidden="true" />
                <span>دخول النظام</span>
              </>
            )}
          </button>
        </form>
      </div>
    </main>
  );
}
