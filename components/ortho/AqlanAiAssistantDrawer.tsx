"use client";

import React, { useEffect, useState } from "react";
import { BookOpen, CheckCircle2, Lock, ShieldCheck, Sparkles, X, AlertTriangle } from "lucide-react";
import {
  AQLAN_AI_BRAND,
  type ExternalAssistantIntent,
  type LocalAssistantAction,
  type LocalAssistantResponse,
} from "@/lib/aqlan-ai-local";

interface AssistantStatus {
  canUseAi: boolean;
  canManageExternalConfig: boolean;
  externalGeminiEnabled: boolean;
  hasServerApiKey: boolean;
}

export function AqlanAiAssistantDrawer({
  open,
  onClose,
  patientId,
}: {
  open: boolean;
  onClose: () => void;
  patientId: number;
}) {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [mode, setMode] = useState<"local" | "external">("local");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localResult, setLocalResult] = useState<LocalAssistantResponse | null>(null);
  const [externalResult, setExternalResult] = useState<{
    titleAr: string;
    disclaimerAr: string;
    textAr: string;
  } | null>(null);
  const [intent, setIntent] = useState<ExternalAssistantIntent>("educational_literature");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    fetch("/api/ai/aqlan-assistant", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setStatus(data);
      })
      .catch(() => setStatus(null));
  }, [open]);

  if (!open) return null;

  const runLocal = async (action: LocalAssistantAction) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/aqlan-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine: "local", action, patientId }),
      });
      const data = (await res.json().catch(() => null)) as {
        result?: LocalAssistantResponse;
        message?: string;
      } | null;
      if (!res.ok || !data?.result) {
        setError(data?.message ?? "تعذّر تشغيل المحرك المحلي.");
        return;
      }
      setLocalResult(data.result);
    } catch {
      setError("تعذّر الاتصال بالخادم المحلي.");
    } finally {
      setBusy(false);
    }
  };

  const runExternal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Strictly NO patientId, NO workspace, NO images, NO clinical notes sent!
      const res = await fetch("/api/ai/aqlan-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          engine: "external_gemini",
          intent,
          query: query.trim(),
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        result?: { titleAr: string; disclaimerAr: string; textAr: string };
        message?: string;
      } | null;
      if (!res.ok || !data?.result) {
        setError(data?.message ?? "تم رفض الطلب أو تعذّر التنفيذ.");
        return;
      }
      setExternalResult(data.result);
    } catch {
      setError("تعذّر الاتصال بالخدمة الخارجية.");
    } finally {
      setBusy(false);
    }
  };

  const toggleExternalOwnerOnly = async (nextEnabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/aqlan-assistant", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ externalGeminiEnabled: nextEnabled }),
      });
      const data = (await res.json().catch(() => null)) as {
        externalGeminiEnabled?: boolean;
        message?: string;
      } | null;
      if (!res.ok) {
        setError(data?.message ?? "تعذّر تحديث إعداد المحرك الخارجي.");
        return;
      }
      setStatus((prev) => (prev ? { ...prev, externalGeminiEnabled: Boolean(data?.externalGeminiEnabled) } : prev));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40 backdrop-blur-[1px]">
      <aside
        aria-label={AQLAN_AI_BRAND.full}
        className="flex h-full w-full max-w-md flex-col bg-white shadow-2xl border-r border-slate-200"
      >
        {/* Header */}
        <div className="flex items-center justify-between bg-navy-900 px-4 py-3.5 text-white">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-sky-300" />
            <div>
              <h3 className="text-sm font-extrabold">{AQLAN_AI_BRAND.ar}</h3>
              <p className="text-[10px] text-slate-300">{AQLAN_AI_BRAND.en}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-white"
            aria-label="إغلاق"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Engine Switcher */}
        <div className="grid grid-cols-2 gap-1.5 border-b border-slate-200 bg-slate-50 p-2 text-xs">
          <button
            type="button"
            onClick={() => {
              setMode("local");
              setError(null);
            }}
            className={`rounded-lg px-2.5 py-2 font-extrabold ${
              mode === "local" ? "bg-navy-800 text-white" : "bg-white text-slate-700 border border-slate-200"
            }`}
          >
            المحرك السريري المحلي
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("external");
              setError(null);
            }}
            className={`rounded-lg px-2.5 py-2 font-extrabold flex items-center justify-center gap-1 ${
              mode === "external" ? "bg-navy-800 text-white" : "bg-white text-slate-700 border border-slate-200"
            }`}
          >
            <Lock className="h-3 w-3" />
            مكتبة Gemini (غير سريري)
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
          {error ? (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 font-bold text-red-800 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          ) : null}

          {mode === "local" ? (
            <div className="space-y-3">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 text-[11px] text-emerald-950 flex items-start gap-2">
                <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-700 mt-0.5" />
                <span>
                  يعمل هذا المحرك <strong>محليًا بالكامل داخل خادم المركز</strong> بلا أي اتصال خارجي، ويلتزم بصلاحياتك وبالسجلات المعتمدة فقط.
                </span>
              </div>

              <div className="grid grid-cols-1 gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runLocal("audit_completeness")}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-right font-bold text-slate-800 hover:border-navy-400 hover:bg-navy-50/40"
                >
                  1. تدقيق اكتمال السجل التقويمي ومعايير السيفالومتري
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runLocal("approved_summary")}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-right font-bold text-slate-800 hover:border-navy-400 hover:bg-navy-50/40"
                >
                  2. عرض القياسات والتشخيص والخطة المعتمدة فقط
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runLocal("presentation_checklist")}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-right font-bold text-slate-800 hover:border-navy-400 hover:bg-navy-50/40"
                >
                  3. فحص جاهزية عرض الحالة (Case Presentation)
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runLocal("scientific_references")}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-right font-bold text-slate-800 hover:border-navy-400 hover:bg-navy-50/40"
                >
                  4. المكتبة العلمية المرجعية المعتمدة (Proffit / Bolton / Moyers)
                </button>
              </div>

              {localResult ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-2.5">
                  <h4 className="font-extrabold text-navy-900 flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    {localResult.titleAr}
                  </h4>
                  <ul className="space-y-1.5 text-slate-800 list-disc pr-4">
                    {localResult.itemsAr.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                  {localResult.references ? (
                    <div className="border-t border-slate-200 pt-2 space-y-1">
                      <p className="font-bold text-navy-900 flex items-center gap-1">
                        <BookOpen className="h-3.5 w-3.5" />
                        الروابط المرجعية:
                      </p>
                      {localResult.references.map((r, i) => (
                        <a
                          key={i}
                          href={r.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block text-[11px] text-navy-800 underline"
                        >
                          {r.title} ({r.year})
                        </a>
                      ))}
                    </div>
                  ) : null}
                  <p className="border-t border-slate-200 pt-2 text-[10px] text-slate-500">
                    {localResult.disclaimerAr}
                  </p>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-[11px] text-amber-950 space-y-1">
                <p className="font-extrabold">جدار حماية خصوصية المرضى (Zero-PHI Firewall)</p>
                <p>
                  محرك Gemini الخارجي <strong>معطّل افتراضيًا</strong> ومحجوز للاستعلامات العلمية المرجعية العامة أو تنظيم القوالب الإدارية فقط. يُمنع منعًا باتًا إرسال أي بيانات أو أسماء أو صور أو أشعة أو ملاحظات مرضى (حتى بعد إزالة الأسماء).
                </p>
              </div>

              {status?.canManageExternalConfig ? (
                <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <span className="font-bold text-slate-800">
                    تحكم المالك: {status.externalGeminiEnabled ? "مفعّل (غير سريري فقط)" : "معطّل (الافتراضي الآمن)"}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void toggleExternalOwnerOnly(!status.externalGeminiEnabled)}
                    className={`rounded-lg px-2.5 py-1 font-bold text-white ${
                      status.externalGeminiEnabled ? "bg-red-700" : "bg-navy-800"
                    }`}
                  >
                    {status.externalGeminiEnabled ? "تعطيل" : "تفعيل"}
                  </button>
                </div>
              ) : null}

              {!status?.externalGeminiEnabled ? (
                <p className="rounded-xl border border-slate-200 bg-white p-4 text-center text-slate-600">
                  المحرك الخارجي معطّل حاليًا بقرار المالك. استخدم تبويب «المحرك السريري المحلي» أعلاه.
                </p>
              ) : (
                <form onSubmit={(e) => void runExternal(e)} className="space-y-2.5">
                  <select
                    value={intent}
                    onChange={(e) => setIntent(e.target.value as ExternalAssistantIntent)}
                    className="w-full rounded-lg border border-slate-300 bg-white p-2"
                  >
                    <option value="educational_literature">استعلام مرجعي علمي عام (المصدر والرابط والسنة)</option>
                    <option value="admin_template">تنظيم قالب تقرير أو قائمة تدقيق إدارية عامة</option>
                  </select>
                  <textarea
                    rows={3}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="اكتب سؤالًا علميًا عامًا فقط (مثال: ما هي حدود استخدام مؤشر بونت وفق Proffit؟) — بدون أي بيانات مريض..."
                    className="w-full rounded-lg border border-slate-300 p-2"
                  />
                  <button
                    type="submit"
                    disabled={busy || query.trim().length < 3}
                    className="w-full rounded-xl bg-navy-800 px-3 py-2 font-extrabold text-white hover:bg-navy-900 disabled:opacity-50"
                  >
                    {busy ? "جارٍ الاستعلام الآمن…" : "إرسال استعلام غير سريري"}
                  </button>
                </form>
              )}

              {externalResult ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-2">
                  <h4 className="font-extrabold text-navy-900">{externalResult.titleAr}</h4>
                  <div className="whitespace-pre-wrap text-slate-800 leading-relaxed">{externalResult.textAr}</div>
                  <p className="border-t border-slate-200 pt-2 text-[10px] text-slate-500">
                    {externalResult.disclaimerAr}
                  </p>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
