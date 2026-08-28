"use client";

import { useState } from "react";
import { Logo } from "@/components/Icon";
import { useClinicName, useSetting } from "@/components/SettingsProvider";

export default function LoginPage() {
  const clinicName = useClinicName();
  const doctor = useSetting("clinic.lead_doctor");
  const doctorTitle = useSetting("clinic.lead_doctor_title");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.message ?? "تعذّر تسجيل الدخول.");
        return;
      }
      // إعادة تحميل كاملة لا تنقّل داخل التطبيق: الكوكي وُضعت للتو، والتحميل الكامل
      // يضمن أن الحارس يراها من أول طلب.
      window.location.href = "/";
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  }

  return (
    /*
     * أول ما يُرى من النظام — وكان صندوقًا أبيض بلا هوية في وسط صفحة رمادية.
     * الشاشة الأولى تقول لمن يقف أمامها أيّ مركزٍ هذا، فتُطمئن الموظف الجديد أنه في
     * المكان الصحيح، وتجعل البرنامج يبدو **نظام المركز** لا أداةً عامة رُكّبت عليه.
     *
     * واسم المركز واسم الطبيب من الإعدادات لا مكتوبين في الكود: كانا مكتوبين هنا،
     * فكان تغيير الاسم من شاشة الإعدادات يغيّره في كل مكان إلا أول شاشة تُرى.
     */
    <main className="flex min-h-screen items-center justify-center bg-navy-900 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <Logo className="mx-auto h-16 w-16" />
          <h1 className="mt-3 text-base font-bold leading-snug text-white">{clinicName}</h1>
          <p className="mt-1 text-xs font-medium text-navy-300">
            {doctor}{doctorTitle ? ` — ${doctorTitle}` : ""}
          </p>
        </div>

      <form onSubmit={submit} className="w-full rounded-2xl bg-white p-6 shadow-raised">
        <p className="text-sm font-bold text-navy-900">تسجيل الدخول</p>

        <label className="mt-4 block text-xs font-bold text-navy-900" htmlFor="username">اسم المستخدم</label>
        <input
          id="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-blue"
        />

        <label className="mt-3 block text-xs font-bold text-navy-900" htmlFor="password">كلمة المرور</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-blue"
        />

        {error ? (
          <p role="alert" className="mt-3 rounded-xl border border-danger-300 bg-danger-50 px-3 py-2 text-xs font-semibold text-danger-700">{error}</p>
        ) : null}

        <button
          type="submit"
          disabled={busy || !username.trim() || !password}
          className="mt-5 w-full rounded-xl bg-navy-900 py-3 text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "جارٍ الدخول…" : "دخول"}
        </button>
      </form>
      </div>
    </main>
  );
}
