"use client";

import { useEffect, useState } from "react";
import { Logo } from "@/components/Icon";
import type { PortalAdminPreviewContext } from "@/lib/portal";

export interface PortalSessionInfo {
  fullName: string;
  patientNumber: string;
  loginName?: string;
  adminPreview?: PortalAdminPreviewContext;
}

export function PortalAdminPreviewBanner({
  preview,
  onExited,
}: {
  preview: PortalAdminPreviewContext;
  onExited: (returnTo: string) => void;
}) {
  const [exiting, setExiting] = useState(false);

  const handleExit = async () => {
    setExiting(true);
    try {
      const response = await fetch("/api/portal/admin-preview/exit", { method: "POST" });
      const payload = await response.json().catch(() => null);
      onExited(typeof payload?.returnTo === "string" ? payload.returnTo : "/");
    } catch {
      onExited("/");
    } finally {
      setExiting(false);
    }
  };

  return (
    <section
      role="region"
      aria-label="تنبيه الدخول الإداري لبوابة المريض"
      data-testid="portal-admin-preview-banner"
      className="mb-4 rounded-2xl border-2 border-amber-400 bg-amber-50 p-4 text-amber-950 shadow-xs"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-black uppercase tracking-wide text-amber-800">
            وضع الدخول الإداري المقيّد — للقراءة فقط
          </p>
          <p className="text-sm font-bold">
            أنت تتصفح بوابة المريض بصفتك الوظيفية:{" "}
            <span className="font-black">{preview.staffDisplayName}</span> ({preview.staffUsername})
          </p>
          <p className="text-xs text-amber-900">
            السبب المسجّل في التدقيق: <span className="font-semibold">{preview.reason}</span> · لا يُسمح
            بتنفيذ أي إجراء أو تأكيد أو مراسلة باسم المريض في هذا الوضع.
          </p>
        </div>
        <button
          type="button"
          onClick={handleExit}
          disabled={exiting}
          data-testid="portal-admin-preview-exit"
          className="rounded-xl bg-amber-900 px-3.5 py-2 text-xs font-black text-white hover:bg-amber-950 disabled:opacity-50"
        >
          {exiting ? "جارٍ الخروج…" : "خروج من عرض البوابة الإداري"}
        </button>
      </div>
    </section>
  );
}

export function PortalLoginAndTokenScreen({
  onLogin,
}: {
  onLogin: (session: PortalSessionInfo) => void;
}) {
  const [flowMode, setFlowMode] = useState<"login" | "activate" | "reset">("login");
  const [rawToken, setRawToken] = useState("");
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenInfo, setTokenInfo] = useState<{
    loginName: string;
    patientFirstName: string;
    expiresAt: string;
  } | null>(null);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showForgotHelp, setShowForgotHelp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const modeParam = params.get("mode");
    const tokenParam = params.get("token");
    if ((modeParam === "activate" || modeParam === "reset") && tokenParam) {
      setFlowMode(modeParam);
      setRawToken(tokenParam);
      // إزالة الرمز السري من شريط العنوان فور التقاطه لمنع بقائه في سجل المتصفح أو Referer.
      const cleanParams = new URLSearchParams(window.location.search);
      cleanParams.delete("token");
      cleanParams.delete("mode");
      const nextQuery = cleanParams.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`,
      );

      setTokenLoading(true);
      setError(null);
      void fetch("/api/portal/token-info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tokenParam }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            throw new Error(data?.message ?? "انتهت صلاحية الرابط أو سبق استخدامه.");
          }
          setTokenInfo({
            loginName: data.loginName,
            patientFirstName: data.patientFirstName,
            expiresAt: data.expiresAt,
          });
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : "تعذّر التحقق من الرابط.");
        })
        .finally(() => {
          setTokenLoading(false);
        });
    }
  }, []);

  const submitLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/portal/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر تسجيل الدخول.");
      onLogin(payload as PortalSessionInfo);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "تعذّر تسجيل الدخول.");
    } finally {
      setBusy(false);
    }
  };

  const submitTokenPassword = async () => {
    if (password !== confirmPassword) {
      setError("كلمتا المرور غير متطابقتين.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const endpoint =
        flowMode === "activate" ? "/api/portal/activate" : "/api/portal/reset-password";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: rawToken, password }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر حفظ كلمة المرور.");
      onLogin(payload as PortalSessionInfo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر حفظ كلمة المرور.");
    } finally {
      setBusy(false);
    }
  };

  if (flowMode === "activate" || flowMode === "reset") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-4">
        <div className="mb-6 text-center">
          <Logo className="mx-auto mb-3 h-12 w-12" />
          <h1 className="text-xl font-black text-navy-900">
            {flowMode === "activate" ? "تفعيل حساب بوابة المريض" : "إعادة تعيين كلمة المرور"}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            رابط مؤقت أحادي الاستخدام لتعيين كلمة المرور الخاصة بك بأمان.
          </p>
        </div>

        <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
          {tokenLoading ? (
            <p className="py-4 text-center text-sm text-slate-500">جارٍ التحقق من صلاحية الرابط…</p>
          ) : tokenInfo ? (
            <>
              <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-sky-950">
                <p className="font-bold">مرحباً {tokenInfo.patientFirstName}</p>
                <p className="mt-1">
                  اسم المستخدم المخصّص لك:{" "}
                  <strong dir="ltr" className="font-mono text-sm">
                    {tokenInfo.loginName}
                  </strong>
                </p>
              </div>
              <label className="block text-sm">
                <span className="mb-1 block font-bold text-slate-700">كلمة المرور الجديدة</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  dir="ltr"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-left"
                  placeholder="8 خانات على الأقل (حروف وأرقام)"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-bold text-slate-700">تأكيد كلمة المرور</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  dir="ltr"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-left"
                  placeholder="أعد كتابة كلمة المرور"
                />
              </label>
              {error && (
                <p className="rounded-xl border border-danger-200 bg-danger-50 p-3 text-sm font-bold text-danger-800">
                  {error}
                </p>
              )}
              <button
                type="button"
                onClick={submitTokenPassword}
                disabled={busy}
                className="w-full rounded-xl bg-navy-800 py-2.5 text-sm font-black text-white disabled:opacity-50"
              >
                {busy
                  ? "جارٍ الحفظ…"
                  : flowMode === "activate"
                    ? "تفعيل الحساب والدخول"
                    : "حفظ كلمة المرور الجديدة والدخول"}
              </button>
            </>
          ) : (
            <>
              {error && (
                <p className="rounded-xl border border-danger-200 bg-danger-50 p-3 text-sm font-bold text-danger-800">
                  {error}
                </p>
              )}
              <button
                type="button"
                onClick={() => {
                  setFlowMode("login");
                  setError(null);
                }}
                className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 text-xs font-bold text-slate-700"
              >
                العودة إلى شاشة تسجيل الدخول
              </button>
            </>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-4">
      <div className="mb-6 text-center">
        <Logo className="mx-auto mb-3 h-12 w-12" />
        <h1 className="text-xl font-black text-navy-900">بوابة المريض</h1>
        <p className="mt-1 text-sm text-slate-500">
          سجّل الدخول باسم المستخدم وكلمة المرور المفعّلين لحسابك.
        </p>
      </div>
      <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
        <label className="block text-sm">
          <span className="mb-1 block font-bold text-slate-700">اسم المستخدم</span>
          <input
            type="text"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            dir="ltr"
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-left"
            placeholder="patient.username"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-bold text-slate-700">كلمة المرور</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) void submitLogin();
            }}
            dir="ltr"
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-left"
            placeholder="••••••••"
          />
        </label>
        {error && (
          <p className="rounded-xl border border-danger-200 bg-danger-50 p-3 text-sm font-bold text-danger-800">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={submitLogin}
          disabled={busy}
          className="w-full rounded-xl bg-navy-800 py-2.5 text-sm font-black text-white disabled:opacity-50"
        >
          {busy ? "جارٍ الدخول…" : "دخول"}
        </button>

        <div className="border-t border-slate-100 pt-2 text-center">
          <button
            type="button"
            onClick={() => setShowForgotHelp((v) => !v)}
            className="text-xs font-bold text-navy-800 underline"
          >
            نسيت كلمة المرور أو لم يُفعَّل حسابك بعد؟
          </button>
          {showForgotHelp && (
            <p className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-right text-xs leading-relaxed text-slate-600">
              لحماية خصوصية ملفك الطبي، لا تُعاد كلمة المرور برقم الملف والهاتف وحدهما. تواصل مع
              موظف الاستقبال المخوّل للتحقق من هويتك وإرسال رابط مؤقت أحادي الاستخدام عبر واتساب أو
              SMS، أو راجع الاستقبال حضوريًا عند فقدان الرقم المسجّل.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
