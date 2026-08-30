"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";

/**
 * شاشة إعدادات الذكاء الاصطناعي.
 *
 * هنا يوفر المالك الخدمة التي بنيت المرحلة 13 على انتظارها: مفتاحٌ يدخله مرة
 * واحدة، ويُخزَّن مشفَّرًا، ولا يعود إلى أي شاشة إلا بصمةً مُقنَّعة.
 *
 * وقبل كل حقلٍ في هذه الشاشة قاعدةٌ واحدة من الدستور (المادة 214):
 * **الذكاء الاصطناعي يقترح ولا يعتمد** — تفعيل الخدمة لا يمنحها قرارًا واحدًا،
 * كل ناتجها يمرّ على الطبيب، والاعتماد بيد الطبيب حصرًا.
 */

interface AiView {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keyMasked: string;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  providers: Array<{ value: string; label: string; defaultBaseUrl: string; modelHint: string }>;
}

const denied = () => window.location.assign("/login");

export default function AiSettingsPage() {
  const [view, setView] = useState<AiView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // الحقول المحلية — المفتاح لا يُعبَّأ أبدًا، ويُرسل فقط إذا كُتب الآن.
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState("zai");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/settings/ai", { cache: "no-store" });
      if (response.status === 401) return denied();
      if (response.status === 403) {
        setError("إعدادات الذكاء الاصطناعي للمدير وحده.");
        return;
      }
      const payload = (await response.json()) as AiView;
      if (!response.ok) throw new Error(payload ? "تعذّر التحميل." : "تعذّر التحميل.");
      setView(payload);
      setEnabled(payload.enabled);
      setProvider(payload.provider);
      setBaseUrl(payload.baseUrl);
      setModel(payload.model);
      setError(null);
    } catch {
      setError("تعذّر تحميل الإعدادات.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const providerMeta = useMemo(
    () => view?.providers.find((item) => item.value === provider) ?? null,
    [view, provider],
  );

  const onProviderChange = (next: string) => {
    setProvider(next);
    const meta = view?.providers.find((item) => item.value === next);
    if (meta?.defaultBaseUrl) setBaseUrl(meta.defaultBaseUrl);
    if (meta?.modelHint) setModel(meta.modelHint);
  };

  const hasNewKey = apiKey.trim().length > 0;
  const dirty = Boolean(
    view && (enabled !== view.enabled || provider !== view.provider || baseUrl !== view.baseUrl || model !== view.model || hasNewKey),
  );

  const enableProblem = enabled && !hasNewKey && !(view?.hasKey ?? false)
    ? "لا يمكن تمكين الخدمة قبل إدخال مفتاح."
    : null;
  const keyProblem = hasNewKey && apiKey.trim().length < 8
    ? "المفتاح قصير بغير منطق — تأكد من نسخه كاملًا."
    : null;
  const baseProblem = !/^https?:\/\/.+/.test(baseUrl.trim())
    ? "عنوان الخدمة يجب أن يبدأ بـ http:// أو https://."
    : null;
  const modelProblem = !/^[A-Za-z0-9._:/-]{1,120}$/.test(model.trim())
    ? "اسم النموذج: حروف لاتينية وأرقام ونقاط وشرطات فقط."
    : null;
  const blockProblem = enableProblem ?? keyProblem ?? baseProblem ?? modelProblem;

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const response = await fetch("/api/settings/ai", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          provider,
          baseUrl,
          model,
          ...(hasNewKey ? { apiKey } : {}),
        }),
      });
      if (response.status === 401) return denied();
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر الحفظ.");
        return;
      }
      setView(payload as AiView);
      setApiKey(""); // المفتاح لا يعيش في حالة الواجهة أطول من اللازم.
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setSaving(false);
    }
  }, [apiKey, baseUrl, enabled, hasNewKey, model, provider, saving]);

  const test = useCallback(async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch("/api/settings/ai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hasNewKey ? { apiKey } : {}),
      });
      if (response.status === 401) return denied();
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setTestResult({ ok: false, message: payload?.message ?? "تعذّر تنفيذ الاختبار." });
        return;
      }
      setTestResult({ ok: Boolean(payload?.ok), message: String(payload?.message ?? "") });
      // نتيجة الاختبار تُثبَّت في الخادم — نحدّث العرض بآخر نتيجة.
      void load();
    } catch {
      setTestResult({ ok: false, message: "تعذّر الاتصال بالخادم." });
    } finally {
      setTesting(false);
    }
  }, [apiKey, hasNewKey, load, testing]);

  return (
    <main className="mx-auto max-w-3xl p-4 pb-32">
      <PageHeader
        title="الذكاء الاصطناعي"
        subtitle="خدمة الاقتراحات — يقترح ولا يعتمد"
        links={[
          { href: "/settings", label: "عام" },
          { href: "/settings/users", label: "المستخدمون والصلاحيات" },
          { href: "/settings/audit", label: "سجل التدقيق" },
          { href: "/settings/export", label: "النسخ والتصدير" },
          { href: "/settings/ai", label: "الذكاء الاصطناعي", current: true },
        ]}
      />

      <p className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900">
        <strong>قاعدة الدستور:</strong> الذكاء الاصطناعي أداة مساعدة تقترح فقط —
        لا يعتمد أي تشخيص طبي أو حركة مالية إلا بتأكيد الطبيب الصريح. ولا تُرسل
        أسماء المرضى أو أرقام هواتفهم إلى أي خدمة خارجية إطلاقًا.
      </p>

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : (
        <>
          <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-3">
                <div>
                  <span className="block text-sm font-bold text-navy-900">تمكين الخدمة</span>
                  <span className="mt-0.5 block text-[11px] text-slate-500">
                    عند الإيقاف لا يُنفَّذ أي استدعاء خارجي — الوحدات الذكية تظهر معطّلة.
                  </span>
                </div>
                <label className="inline-flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) => setEnabled(event.target.checked)}
                    className="h-5 w-5 accent-brand-orange"
                  />
                  <span className="text-sm font-bold">{enabled ? "ممكّنة" : "متوقفة"}</span>
                </label>
              </div>

              <label className="block">
                <span className="mb-1 block text-[11px] font-bold text-slate-500">المزوّد</span>
                <select
                  value={provider}
                  onChange={(event) => onProviderChange(event.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue"
                >
                  {(view?.providers ?? []).map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="mb-1 block text-[11px] font-bold text-slate-500">عنوان الخدمة (Base URL)</span>
                <input
                  type="text"
                  dir="ltr"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder={providerMeta?.defaultBaseUrl || "https://…"}
                  className={`w-full rounded-xl border px-3 py-2 text-sm outline-none ${
                    baseProblem && dirty ? "border-red-300 bg-red-50" : "border-slate-200 focus:border-brand-blue"
                  }`}
                />
                <span className="mt-1 block text-[11px] text-slate-400">
                  واجهة متوافقة مع OpenAI chat completions — تُملأ تلقائيًا عند اختيار المزوّد.
                </span>
                {baseProblem && dirty ? <span className="mt-1 block text-[11px] font-bold text-red-600">{baseProblem}</span> : null}
              </label>

              <label className="block">
                <span className="mb-1 block text-[11px] font-bold text-slate-500">النموذج (Model)</span>
                <input
                  type="text"
                  dir="ltr"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder={providerMeta?.modelHint || "model-name"}
                  className={`w-full rounded-xl border px-3 py-2 text-sm outline-none ${
                    modelProblem && dirty ? "border-red-300 bg-red-50" : "border-slate-200 focus:border-brand-blue"
                  }`}
                />
                {providerMeta?.modelHint ? (
                  <span className="mt-1 block text-[11px] text-slate-400">مقترح لهذا المزوّد: {providerMeta.modelHint}</span>
                ) : null}
                {modelProblem && dirty ? <span className="mt-1 block text-[11px] font-bold text-red-600">{modelProblem}</span> : null}
              </label>

              <label className="block">
                <span className="mb-1 block text-[11px] font-bold text-slate-500">
                  المفتاح (API Key) — {view?.hasKey ? `محفوظ: ${view.keyMasked}` : "لم يُدخل بعد"}
                </span>
                <input
                  type="password"
                  dir="ltr"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={view?.hasKey ? "اتركه فارغًا للإبقاء على المفتاح المحفوظ" : "الصق المفتاح هنا"}
                  className={`w-full rounded-xl border px-3 py-2 text-sm outline-none ${
                    keyProblem ? "border-red-300 bg-red-50" : "border-slate-200 focus:border-brand-blue"
                  }`}
                />
                <span className="mt-1 block text-[11px] text-slate-400">
                  يُخزَّن مشفَّرًا ولا يظهر بعدها إلا بصمة مختصرة — ولن يعود إلى أي شاشة نصًّا كاملًا.
                </span>
                {keyProblem ? <span className="mt-1 block text-[11px] font-bold text-red-600">{keyProblem}</span> : null}
              </label>
            </div>
          </section>

          <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-black text-navy-900">اختبار الاتصال</h2>
                <p className="mt-1 text-xs text-slate-500">
                  طلب حقيقي بأصغر حجم ممكن. إن أدخلت مفتاحًا الآن فسيُجرَّب قبل الحفظ — لا يُحفظ مفتاح خاطئ.
                </p>
                {view?.lastTestAt ? (
                  <p className={`mt-2 text-[11px] font-bold ${view.lastTestOk ? "text-emerald-700" : "text-red-600"}`}>
                    آخر اختبار ({new Date(view.lastTestAt).toLocaleString("ar")}) : {view.lastTestOk ? "ناجح" : "فاشل"} — {view.lastTestMessage}
                  </p>
                ) : null}
              </div>
              <button
                onClick={test}
                disabled={testing}
                className="rounded-xl border border-navy-900 px-5 py-2.5 text-sm font-extrabold text-navy-900 disabled:opacity-40"
              >
                {testing ? "جارٍ الاختبار…" : "اختبار الاتصال"}
              </button>
            </div>
            {testResult ? (
              <p
                role="status"
                className={`mt-3 rounded-xl px-4 py-2 text-sm font-bold ${
                  testResult.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"
                }`}
              >
                {testResult.ok ? "✓ " : "✕ "}{testResult.message}
              </p>
            ) : null}
          </section>

          {view?.updatedBy ? (
            <p className="mb-5 text-[11px] text-slate-400">
              آخر تعديل: {view.updatedBy} — {view.updatedAt ? new Date(view.updatedAt).toLocaleString("ar") : ""}
            </p>
          ) : null}

          <div className="fixed inset-x-0 bottom-16 z-10 border-t border-slate-200 bg-white/95 p-3 backdrop-blur lg:bottom-0">
            <div className="mx-auto flex max-w-3xl items-center gap-3">
              <span className="flex-1 text-xs font-bold text-slate-500">
                {saved ? "حُفظت الإعدادات ✓"
                  : blockProblem ? blockProblem
                  : dirty ? "تغييرات بانتظار الحفظ"
                  : "لا تغييرات"}
              </span>
              <button
                onClick={save}
                disabled={saving || !dirty || Boolean(blockProblem)}
                className="rounded-xl bg-brand-orange px-6 py-2.5 text-sm font-extrabold text-white disabled:opacity-40"
              >
                {saving ? "جارٍ الحفظ…" : "حفظ"}
              </button>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
