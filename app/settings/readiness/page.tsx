"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";

interface ReadinessCheck {
  id: string;
  category: "clinic" | "finance" | "clinical" | "security" | "operations";
  title: string;
  description: string;
  status: "pass" | "warn" | "fail";
  details?: string;
  actionHref?: string;
  actionLabel?: string;
}

interface ReadinessData {
  checks: ReadinessCheck[];
  summary: {
    total: number;
    passed: number;
    warnings: number;
    failed: number;
    ready: boolean;
  };
}

export default function ReadinessPage() {
  const [data, setData] = useState<ReadinessData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/readiness", { cache: "no-store" });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.message ?? "تعذّر الفحص.");
      setData(payload as ReadinessData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر الفحص.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const CATEGORY_NAMES: Record<string, { label: string; icon: string }> = {
    clinic: { label: "هوية وبيانات المركز", icon: "🏥" },
    finance: { label: "النظام المالي والعملات", icon: "💰" },
    clinical: { label: "الخدمات والعيادات السريرية", icon: "🦷" },
    security: { label: "الأمان والمستخدمون والنسخ", icon: "🛡️" },
    operations: { label: "التشغيل والربط التقني", icon: "⚡" },
  };

  return (
    <main className="mx-auto max-w-4xl p-4 pb-32">
      <PageHeader
        title="جاهزية الإطلاق والتشغيل"
        subtitle="فحص شامل لكافة وحدات وتكوينات النظام للتأكد من جاهزية المركز للعمل اليومي"
        links={[
          { href: "/settings", label: "عام" },
          { href: "/settings/readiness", label: "جاهزية الإطلاق", current: true },
          { href: "/settings/users", label: "المستخدمون والصلاحيات" },
          { href: "/settings/audit", label: "سجل التدقيق" },
          { href: "/settings/export", label: "النسخ والتصدير" },
          { href: "/settings/ai", label: "الذكاء الاصطناعي" },
        ]}
      />

      {loading && (
        <div className="rounded-3xl border border-slate-200 bg-white p-12 text-center shadow-xs">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-brand-navy border-t-transparent mb-3" />
          <p className="text-sm font-bold text-slate-600">جارٍ إجراء الفحص التلقائي لجاهزية النظام...</p>
        </div>
      )}

      {error && (
        <div className="rounded-3xl border border-red-200 bg-red-50 p-6 text-sm font-bold text-red-800">
          ⚠️ {error}
        </div>
      )}

      {data && !loading && (
        <div className="space-y-6">
          {/* بطاقة النتيجة الإجمالية */}
          <div
            className={`rounded-3xl border p-6 shadow-xs transition-all ${
              data.summary.ready
                ? "border-emerald-200 bg-emerald-50/70"
                : "border-amber-200 bg-amber-50/70"
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div
                  className={`flex h-14 w-14 items-center justify-center rounded-2xl text-2xl shadow-xs ${
                    data.summary.ready
                      ? "bg-emerald-600 text-white"
                      : "bg-amber-500 text-white"
                  }`}
                >
                  {data.summary.ready ? "✓" : "!"}
                </div>
                <div>
                  <h2 className="text-lg font-black text-navy-900">
                    {data.summary.ready
                      ? "النظام جاهز تماماً للتشغيل والخدمة السريرية"
                      : "توجد بعض التنبيهات التي يُوصى بإكمالها قبل الإطلاق"}
                  </h2>
                  <p className="text-xs text-slate-600 font-medium mt-0.5">
                    تم اجتياز {data.summary.passed} من أصل {data.summary.total} فحص بنجاح.
                    {data.summary.warnings > 0 && ` (${data.summary.warnings} تنبيهات تحسين)`}
                    {data.summary.failed > 0 && ` (${data.summary.failed} متطلب بحاجة لضبط)`}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={load}
                className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-700 shadow-2xs hover:bg-slate-50 transition-colors"
              >
                <span>🔄</span>
                <span>إعادة الفحص</span>
              </button>
            </div>

            {/* أشرطة الإحصاء */}
            <div className="mt-6 grid grid-cols-3 gap-3">
              <div className="rounded-2xl border border-emerald-200 bg-white p-3 text-center">
                <span className="text-xs font-bold text-slate-500">ناجح ومكتمل</span>
                <p className="text-xl font-black text-emerald-600">{data.summary.passed}</p>
              </div>
              <div className="rounded-2xl border border-amber-200 bg-white p-3 text-center">
                <span className="text-xs font-bold text-slate-500">تنبيهات / اقتراحات</span>
                <p className="text-xl font-black text-amber-600">{data.summary.warnings}</p>
              </div>
              <div className="rounded-2xl border border-red-200 bg-white p-3 text-center">
                <span className="text-xs font-bold text-slate-500">غير مكتمل / حرج</span>
                <p className="text-xl font-black text-red-600">{data.summary.failed}</p>
              </div>
            </div>
          </div>

          {/* قائمة الفحوصات مقسمة حسب الفئة */}
          <div className="space-y-5">
            {Object.entries(CATEGORY_NAMES).map(([catKey, catMeta]) => {
              const catChecks = data.checks.filter((c) => c.category === catKey);
              if (catChecks.length === 0) return null;

              return (
                <div key={catKey} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-2xs space-y-3">
                  <div className="flex items-center gap-2.5 border-b border-slate-100 pb-3">
                    <span className="text-lg">{catMeta.icon}</span>
                    <h3 className="text-sm font-black text-navy-900">{catMeta.label}</h3>
                  </div>

                  <div className="space-y-2.5">
                    {catChecks.map((check) => (
                      <div
                        key={check.id}
                        className={`flex flex-wrap items-start justify-between gap-3 rounded-2xl border p-4 transition-all ${
                          check.status === "pass"
                            ? "border-slate-100 bg-slate-50/50"
                            : check.status === "warn"
                            ? "border-amber-200 bg-amber-50/40"
                            : "border-red-200 bg-red-50/40"
                        }`}
                      >
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                          <span
                            className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-black ${
                              check.status === "pass"
                                ? "bg-emerald-100 text-emerald-700"
                                : check.status === "warn"
                                ? "bg-amber-100 text-amber-700"
                                : "bg-red-100 text-red-700"
                            }`}
                          >
                            {check.status === "pass" ? "✓" : "!"}
                          </span>
                          <div>
                            <h4 className="text-xs font-black text-navy-900">{check.title}</h4>
                            <p className="text-xs text-slate-600 font-medium mt-0.5 leading-relaxed">
                              {check.description}
                            </p>
                          </div>
                        </div>

                        {check.actionHref && (
                          <Link
                            href={check.actionHref}
                            className="shrink-0 rounded-xl border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-bold text-slate-700 shadow-2xs hover:bg-navy-50 hover:text-navy-900 hover:border-brand-navy transition-all"
                          >
                            {check.actionLabel || "ضبط الآن"}
                          </Link>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </main>
  );
}
