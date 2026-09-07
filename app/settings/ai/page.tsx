"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import type { AiProviderView, AiProtocolType, AiTaskModels } from "@/lib/ai-providers/types";
import type { AiProviderPreset } from "@/lib/ai-providers/presets";
import { AI_PROTOCOL_LABELS } from "@/lib/ai-providers/types";

const denied = () => window.location.assign("/login");

export default function AiSettingsPage() {
  const [providers, setProviders] = useState<AiProviderView[]>([]);
  const [presets, setPresets] = useState<AiProviderPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // حالة النافذة المنبثقة لإضافة/تعديل مزود
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<AiProviderView | null>(null);

  // حقول نموذج الإضافة / التعديل
  const [formId, setFormId] = useState("");
  const [formName, setFormName] = useState("");
  const [formProtocol, setFormProtocol] = useState<AiProtocolType>("openai-compatible");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [formEndpoint, setFormEndpoint] = useState("");
  const [formModel, setFormModel] = useState("");
  const [formModelsText, setFormModelsText] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  const [formOrgId, setFormOrgId] = useState("");
  const [formHeadersText, setFormHeadersText] = useState("");
  const [formTimeout, setFormTimeout] = useState(30000);
  const [formMaxTokens, setFormMaxTokens] = useState(2048);
  const [formTemperature, setFormTemperature] = useState(0.2);
  const [formEnabled, setFormEnabled] = useState(true);
  const [formIsDefault, setFormIsDefault] = useState(false);
  const [formPriority, setFormPriority] = useState(10);
  const [formTaskModels, setFormTaskModels] = useState<AiTaskModels>({});

  // حالات الاختبار المباشر لكل مزود
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; message: string; latencyMs: number }>
  >({});
  const [saving, setSaving] = useState(false);

  // تحميل المزودين من السجل
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/settings/ai/providers", { cache: "no-store" });
      if (response.status === 401) return denied();
      if (response.status === 403) {
        setError("إعدادات الذكاء الاصطناعي للمدير وحده.");
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data?.message || "تعذّر تحميل المزودين.");
      setProviders(data.providers || []);
      setPresets(data.presets || []);
      setError(null);
    } catch (err) {
      setError((err as Error).message || "تعذّر تحميل مزودي الذكاء الاصطناعي.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // فتح نموذج إضافة مزود جديد
  const handleOpenAdd = (preset?: AiProviderPreset) => {
    setEditingProvider(null);
    if (preset) {
      setFormId(preset.id === "custom" ? `custom-${Date.now().toString().slice(-4)}` : preset.id);
      setFormName(preset.name);
      setFormProtocol(preset.protocolType);
      setFormBaseUrl(preset.baseUrl);
      setFormEndpoint(preset.protocolType === "anthropic-compatible" ? "/v1/messages" : "/chat/completions");
      setFormModel(preset.defaultModel);
      setFormModelsText(preset.suggestedModels.join(", "));
    } else {
      setFormId(`provider-${Date.now().toString().slice(-4)}`);
      setFormName("");
      setFormProtocol("openai-compatible");
      setFormBaseUrl("https://api.openai.com/v1");
      setFormEndpoint("/chat/completions");
      setFormModel("gpt-4o-mini");
      setFormModelsText("gpt-4o, gpt-4o-mini");
    }
    setFormApiKey("");
    setFormOrgId("");
    setFormHeadersText("");
    setFormTimeout(30000);
    setFormMaxTokens(2048);
    setFormTemperature(0.2);
    setFormEnabled(true);
    setFormIsDefault(providers.length === 0);
    setFormPriority((providers.length + 1) * 10);
    setFormTaskModels({});
    setModalOpen(true);
  };

  // فتح نموذج تعديل مزود قائم
  const handleOpenEdit = (p: AiProviderView) => {
    setEditingProvider(p);
    setFormId(p.id);
    setFormName(p.name);
    setFormProtocol(p.protocolType);
    setFormBaseUrl(p.baseUrl);
    setFormEndpoint(p.apiEndpoint || "");
    setFormModel(p.model);
    setFormModelsText((p.models || []).join(", "));
    setFormApiKey(""); // لا نعبئ المفتاح الصريح أبداً
    setFormOrgId(p.organizationId || "");
    setFormHeadersText(p.customHeaders ? JSON.stringify(p.customHeaders, null, 2) : "");
    setFormTimeout(p.timeoutMs || 30000);
    setFormMaxTokens(p.maxTokens || 2048);
    setFormTemperature(p.temperature ?? 0.2);
    setFormEnabled(p.enabled);
    setFormIsDefault(p.isDefault);
    setFormPriority(p.priority || 10);
    setFormTaskModels(p.taskModels || {});
    setModalOpen(true);
  };

  // حفظ المزود (إنشاء أو تعديل)
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);

    let parsedHeaders: Record<string, string> | undefined = undefined;
    if (formHeadersText.trim()) {
      try {
        parsedHeaders = JSON.parse(formHeadersText.trim());
      } catch {
        setError("صيغة الترويسات المخصصة (Custom Headers) غير صحيحة، يجب أن تكون JSON صالحاً.");
        setSaving(false);
        return;
      }
    }

    const modelsList = formModelsText
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    if (!modelsList.includes(formModel.trim())) {
      modelsList.unshift(formModel.trim());
    }

    const payload = {
      id: formId.trim(),
      name: formName.trim(),
      protocolType: formProtocol,
      baseUrl: formBaseUrl.trim(),
      apiEndpoint: formEndpoint.trim() || null,
      model: formModel.trim(),
      models: modelsList,
      ...(formApiKey.trim() ? { apiKey: formApiKey.trim() } : {}),
      organizationId: formOrgId.trim() || null,
      customHeaders: parsedHeaders,
      timeoutMs: Number(formTimeout),
      maxTokens: Number(formMaxTokens),
      temperature: Number(formTemperature),
      enabled: formEnabled,
      isDefault: formIsDefault,
      priority: Number(formPriority),
      taskModels: formTaskModels,
    };

    try {
      const isEdit = Boolean(editingProvider);
      const url = isEdit ? `/api/settings/ai/providers/${editingProvider!.id}` : "/api/settings/ai/providers";
      const method = isEdit ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const resData = await res.json();
      if (!res.ok) throw new Error(resData?.message || "فشل حفظ المزود.");

      setSuccess(`تم حفظ المزود «${payload.name}» بنجاح.`);
      setModalOpen(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // حذف مزود
  const handleDelete = async (p: AiProviderView) => {
    if (!confirm(`هل أنت متأكد من حذف المزود «${p.name}»؟`)) return;
    try {
      const res = await fetch(`/api/settings/ai/providers/${p.id}`, { method: "DELETE" });
      const resData = await res.json();
      if (!res.ok) throw new Error(resData?.message || "تعذر الحذف.");
      setSuccess(`تم حذف المزود «${p.name}».`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // تفعيل / تعطيل سريع
  const handleToggleEnabled = async (p: AiProviderView) => {
    try {
      const res = await fetch(`/api/settings/ai/providers/${p.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...p, enabled: !p.enabled }),
      });
      if (!res.ok) throw new Error("تعذر تحديث الحالة.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // تعيين كافتراضي
  const handleSetDefault = async (p: AiProviderView) => {
    try {
      const res = await fetch(`/api/settings/ai/providers/${p.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...p, isDefault: true, enabled: true }),
      });
      if (!res.ok) throw new Error("تعذر تعيين المزود كافتراضي.");
      setSuccess(`تم تعيين «${p.name}» كمزود أساسي افتراضي.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // اختبار الاتصال الحي
  const handleTestConnection = async (p: AiProviderView) => {
    setTestingId(p.id);
    try {
      const res = await fetch(`/api/settings/ai/providers/${p.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      setTestResults((prev) => ({
        ...prev,
        [p.id]: {
          ok: data.ok,
          message: data.message,
          latencyMs: data.latencyMs || 0,
        },
      }));
      // تحديث بيانات المزود لعرض التاريخ
      await load();
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [p.id]: {
          ok: false,
          message: (err as Error).message,
          latencyMs: 0,
        },
      }));
    } finally {
      setTestingId(null);
    }
  };

  // رفع / خفض الأولوية
  const handleMovePriority = async (index: number, direction: "up" | "down") => {
    const targetIdx = direction === "up" ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= providers.length) return;

    const newOrder = [...providers];
    const [moved] = newOrder.splice(index, 1);
    newOrder.splice(targetIdx, 0, moved);

    try {
      const res = await fetch("/api/settings/ai/providers/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds: newOrder.map((p) => p.id) }),
      });
      if (!res.ok) throw new Error("تعذر حفظ الترتيب الجديد.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 pb-16 font-sans">
      <PageHeader
        title="إدارة مزودي الذكاء الاصطناعي (AI Provider Registry)"
        subtitle="إدارة ديناميكية حرة لمزودي الذكاء الاصطناعي، ربط واجهات متوافقة، وسلسلة احتياطية تلقائية (Fallback Chain)."
        back={{ href: "/settings", label: "الإعدادات" }}
      />

      <main className="mx-auto max-w-6xl px-4 py-6 space-y-6">
        {/* التنبيهات */}
        {error && (
          <div className="flex items-center justify-between rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs font-bold text-rose-800 shadow-xs">
            <span>⚠️ {error}</span>
            <button onClick={() => setError(null)} className="text-rose-500 hover:text-rose-700">✕</button>
          </div>
        )}
        {success && (
          <div className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs font-bold text-emerald-800 shadow-xs">
            <span>✅ {success}</span>
            <button onClick={() => setSuccess(null)} className="text-emerald-500 hover:text-emerald-700">✕</button>
          </div>
        )}

        {/* مخطط السلسلة الاحتياطية (Fallback Chain Visualizer) */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
            <div>
              <h2 className="text-sm font-black text-navy-900 flex items-center gap-2">
                <span>🔄</span>
                <span>تسلسل السلسلة الاحتياطية (Fallback Chain)</span>
              </h2>
              <p className="text-[11px] text-slate-500 mt-0.5">
                في حال نفاد الرصيد (429) أو انقطاع خدمة المزود الأساسي، ينتقل البوت تلقائياً للمزود التالي ثم للمحرك الداخلي دون توقف.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleOpenAdd()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-navy-900 px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-navy-800 transition-all"
              >
                <span>+</span>
                <span>إضافة مزود AI</span>
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 py-1">
            {providers.filter((p) => p.enabled).length === 0 ? (
              <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50/60 px-4 py-3 text-xs text-amber-800">
                ⚠️ لا يوجد أي مزود سحابي مفعّل حالياً. يعمل المساعد الذكي كلياً عبر <strong>محرك مركز عقلان المدمج</strong>.
              </div>
            ) : (
              providers
                .filter((p) => p.enabled)
                .map((p, idx) => (
                  <div key={p.id} className="flex items-center gap-2">
                    <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2 shadow-2xs">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-navy-900 text-[10px] font-black text-white">
                        {idx + 1}
                      </span>
                      <div>
                        <div className="text-xs font-black text-slate-800 flex items-center gap-1">
                          <span>{p.name}</span>
                          {p.isDefault && <span className="text-amber-500" title="المزود الافتراضي">⭐</span>}
                        </div>
                        <div className="text-[10px] font-mono text-slate-500">{p.model}</div>
                      </div>
                    </div>
                    <span className="text-slate-400 font-bold text-sm">➔</span>
                  </div>
                ))
            )}

            <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 px-3.5 py-2 shadow-2xs">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-[10px] font-black text-white">
                🛡️
              </span>
              <div>
                <div className="text-xs font-black text-emerald-900">محرك مركز عقلان الداخلي</div>
                <div className="text-[10px] text-emerald-700">احتياطي دائم لا ينقطع أبداً (المادة 214)</div>
              </div>
            </div>
          </div>
        </section>

        {/* القوالب السريعة (Presets) */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
          <h3 className="text-xs font-black text-slate-700 mb-2 flex items-center gap-1.5">
            <span>⚡</span>
            <span>قوالب سريعة لإضافة مزودي الذكاء الاصطناعي بنقرة واحدة:</span>
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-8 gap-2">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleOpenAdd(preset)}
                className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-center hover:border-brand-blue hover:bg-blue-50/50 hover:shadow-xs transition-all"
              >
                <span className="text-xs font-black text-navy-900">{preset.name}</span>
                <span className="text-[9px] font-mono text-slate-500 mt-0.5 truncate max-w-full">
                  {preset.defaultModel}
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* جدول المزودين */}
        <section className="rounded-2xl border border-slate-200 bg-white shadow-xs overflow-hidden">
          <div className="border-b border-slate-100 bg-slate-50/70 px-5 py-3.5 flex items-center justify-between">
            <h3 className="text-sm font-black text-navy-900">قائمة المزودين المسجلين في النظام ({providers.length})</h3>
            <span className="text-[11px] text-slate-500">مفاتيح API مشفرة بـ AES-256-GCM ومحمية داخل السيرفر</span>
          </div>

          {loading ? (
            <div className="p-8 text-center text-xs text-slate-500">جاري تحميل المزودين...</div>
          ) : providers.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              لا يوجد أي مزود مسجل. انقر على «+ إضافة مزود AI» أو اختر من القوالب أعلاه.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="border-b border-slate-200 bg-slate-100/70 text-slate-700 font-bold">
                  <tr>
                    <th className="px-4 py-3">الأولوية</th>
                    <th className="px-4 py-3">المزود والبروتوكول</th>
                    <th className="px-4 py-3">النموذج (Model)</th>
                    <th className="px-4 py-3">مفتاح API</th>
                    <th className="px-4 py-3">الحالة</th>
                    <th className="px-4 py-3">آخر اختبار اتصال</th>
                    <th className="px-4 py-3 text-center">الإجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {providers.map((p, idx) => {
                    const test = testResults[p.id];
                    const isTesting = testingId === p.id;

                    return (
                      <tr key={p.id} className={`hover:bg-slate-50/50 transition-colors ${!p.enabled ? "opacity-60 bg-slate-50/30" : ""}`}>
                        {/* الأولوية والترتيب */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            <span className="font-bold text-slate-700">{idx + 1}</span>
                            <div className="flex flex-col">
                              <button
                                type="button"
                                disabled={idx === 0}
                                onClick={() => handleMovePriority(idx, "up")}
                                className="text-[10px] text-slate-400 hover:text-navy-900 disabled:opacity-20 leading-none"
                              >
                                ▲
                              </button>
                              <button
                                type="button"
                                disabled={idx === providers.length - 1}
                                onClick={() => handleMovePriority(idx, "down")}
                                className="text-[10px] text-slate-400 hover:text-navy-900 disabled:opacity-20 leading-none"
                              >
                                ▼
                              </button>
                            </div>
                          </div>
                        </td>

                        {/* اسم المزود والبروتوكول */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <span className="font-black text-slate-900">{p.name}</span>
                            {p.isDefault && (
                              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-black text-amber-800">
                                الافتراضي ⭐
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] font-mono text-slate-400 mt-0.5 truncate max-w-xs" title={p.baseUrl}>
                            {p.protocolType} • {p.baseUrl}
                          </div>
                        </td>

                        {/* النموذج */}
                        <td className="px-4 py-3">
                          <span className="inline-block rounded-lg bg-blue-50 px-2 py-1 font-mono text-[11px] font-bold text-brand-blue border border-blue-100">
                            {p.model}
                          </span>
                          {p.models && p.models.length > 1 && (
                            <span className="text-[9px] text-slate-400 block mt-0.5">
                              +{p.models.length - 1} نماذج إضافية
                            </span>
                          )}
                        </td>

                        {/* المفتاح المقنع */}
                        <td className="px-4 py-3">
                          {p.hasKey ? (
                            <span className="font-mono text-[11px] text-slate-600 bg-slate-100 px-2 py-0.5 rounded-md">
                              {p.keyMasked}
                            </span>
                          ) : (
                            <span className="text-[10px] font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-md">
                              مفقود
                            </span>
                          )}
                        </td>

                        {/* الحالة (مفعل / معطل) */}
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={() => handleToggleEnabled(p)}
                            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-black transition-all ${
                              p.enabled
                                ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                                : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                            }`}
                          >
                            <span>{p.enabled ? "مفعّل 🟢" : "معطّل ⚪"}</span>
                          </button>
                        </td>

                        {/* نتيجة آخر اختبار */}
                        <td className="px-4 py-3">
                          {test ? (
                            <div className="text-[11px]">
                              <span className={test.ok ? "font-bold text-emerald-700" : "font-bold text-rose-700"}>
                                {test.ok ? `متصل (${test.latencyMs} م.ث)` : "فشل الاتصال"}
                              </span>
                              <div className="text-[10px] text-slate-500 truncate max-w-xs" title={test.message}>
                                {test.message}
                              </div>
                            </div>
                          ) : p.lastTestAt ? (
                            <div className="text-[11px]">
                              <span className={p.lastTestOk ? "font-bold text-emerald-700" : "font-bold text-rose-700"}>
                                {p.lastTestOk ? `متصل (${p.lastTestLatency || 0} م.ث)` : "فشل الاتصال"}
                              </span>
                              <div className="text-[10px] text-slate-500 truncate max-w-xs" title={p.lastTestMessage || ""}>
                                {p.lastTestMessage || ""}
                              </div>
                            </div>
                          ) : (
                            <span className="text-[10px] text-slate-400">لم يُختبر بعد</span>
                          )}
                        </td>

                        {/* أزرار الإجراءات */}
                        <td className="px-4 py-3 text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              type="button"
                              disabled={isTesting}
                              onClick={() => handleTestConnection(p)}
                              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-700 hover:border-brand-blue hover:text-navy-900 transition-all shadow-2xs disabled:opacity-40"
                              title="اختبار اتصال حي بالمزود"
                            >
                              {isTesting ? "جاري الفحص..." : "فحص 🔌"}
                            </button>

                            <button
                              type="button"
                              onClick={() => handleOpenEdit(p)}
                              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-700 hover:border-navy-900 hover:text-navy-900 transition-all shadow-2xs"
                              title="تعديل المزود"
                            >
                              تعديل ✏️
                            </button>

                            {!p.isDefault && (
                              <button
                                type="button"
                                onClick={() => handleSetDefault(p)}
                                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-bold text-slate-500 hover:text-amber-600 hover:border-amber-300 transition-all shadow-2xs"
                                title="تعيين كمزود افتراضي"
                              >
                                ⭐
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => handleDelete(p)}
                              className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-bold text-rose-500 hover:border-rose-300 hover:bg-rose-50 transition-all shadow-2xs"
                              title="حذف المزود"
                            >
                              🗑️
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      {/* Modal نافذة إضافة / تعديل المزود */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
          <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-black text-navy-900">
                {editingProvider ? `تعديل المزود «${editingProvider.name}»` : "إضافة مزود ذكاء اصطناعي جديد"}
              </h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 font-bold"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSave} className="mt-4 space-y-4 text-xs">
              {/* الصف الأول: الاسم والمعرف */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">اسم المزود *</label>
                  <input
                    type="text"
                    required
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="مثال: OpenAI Production أو DeepSeek"
                    className="w-full rounded-xl border border-slate-200 p-2.5 text-xs outline-none focus:border-brand-blue"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">معرف المزود الداخلي (ID) *</label>
                  <input
                    type="text"
                    required
                    disabled={Boolean(editingProvider)}
                    value={formId}
                    onChange={(e) => setFormId(e.target.value)}
                    placeholder="مثال: openai-prod أو deepseek"
                    className="w-full rounded-xl border border-slate-200 p-2.5 text-xs outline-none focus:border-brand-blue disabled:bg-slate-100 font-mono"
                  />
                </div>
              </div>

              {/* الصف الثاني: نوع البروتوكول و Base URL */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">نوع البروتوكول (Adapter) *</label>
                  <select
                    value={formProtocol}
                    onChange={(e) => setFormProtocol(e.target.value as AiProtocolType)}
                    className="w-full rounded-xl border border-slate-200 p-2.5 text-xs outline-none focus:border-brand-blue font-bold"
                  >
                    {Object.entries(AI_PROTOCOL_LABELS).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">عنوان Base URL *</label>
                  <input
                    type="text"
                    required
                    value={formBaseUrl}
                    onChange={(e) => setFormBaseUrl(e.target.value)}
                    placeholder="https://api.openai.com/v1"
                    className="w-full rounded-xl border border-slate-200 p-2.5 text-xs outline-none focus:border-brand-blue font-mono"
                  />
                </div>
              </div>

              {/* الصف الثالث: مسار الـ Endpoint والنموذج الافتراضي */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">مسار الاستدعاء (API Endpoint)</label>
                  <input
                    type="text"
                    value={formEndpoint}
                    onChange={(e) => setFormEndpoint(e.target.value)}
                    placeholder="افتراضي: /chat/completions"
                    className="w-full rounded-xl border border-slate-200 p-2.5 text-xs outline-none focus:border-brand-blue font-mono"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">النموذج الافتراضي (Model) *</label>
                  <input
                    type="text"
                    required
                    value={formModel}
                    onChange={(e) => setFormModel(e.target.value)}
                    placeholder="مثال: gpt-4o-mini أو glm-4.6"
                    className="w-full rounded-xl border border-slate-200 p-2.5 text-xs outline-none focus:border-brand-blue font-mono"
                  />
                </div>
              </div>

              {/* قائمة النماذج الإضافية */}
              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  قائمة النماذج المدعومة (مفصولة بفواصل)
                </label>
                <input
                  type="text"
                  value={formModelsText}
                  onChange={(e) => setFormModelsText(e.target.value)}
                  placeholder="gpt-4o, gpt-4o-mini, o1"
                  className="w-full rounded-xl border border-slate-200 p-2.5 text-xs outline-none focus:border-brand-blue font-mono"
                />
              </div>

              {/* مفتاح الـ API */}
              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  مفتاح API Key {editingProvider?.hasKey ? "(متروك فارغاً = الإبقاء على المفتاح المشفر الحالي)" : "*"}
                </label>
                <input
                  type="password"
                  value={formApiKey}
                  onChange={(e) => setFormApiKey(e.target.value)}
                  placeholder={editingProvider?.hasKey ? editingProvider.keyMasked : "sk-..."}
                  className="w-full rounded-xl border border-slate-200 p-2.5 text-xs outline-none focus:border-brand-blue font-mono"
                />
                <p className="text-[10px] text-slate-400 mt-1">
                  🔒 يُشفر المفتاح في الخادم فوراً بـ AES-256-GCM ولا يُرسل أبداً لأي متصفح.
                </p>
              </div>

              {/* تخصيصات متقدمة: المهلة ودرجة الحرارة ومعرف المنظمة */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">المهلة (Timeout ms)</label>
                  <input
                    type="number"
                    value={formTimeout}
                    onChange={(e) => setFormTimeout(Number(e.target.value))}
                    className="w-full rounded-xl border border-slate-200 p-2.5 text-xs outline-none focus:border-brand-blue"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">أقصى توكن (Max Tokens)</label>
                  <input
                    type="number"
                    value={formMaxTokens}
                    onChange={(e) => setFormMaxTokens(Number(e.target.value))}
                    className="w-full rounded-xl border border-slate-200 p-2.5 text-xs outline-none focus:border-brand-blue"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">الحرارة (Temperature)</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="1"
                    value={formTemperature}
                    onChange={(e) => setFormTemperature(Number(e.target.value))}
                    className="w-full rounded-xl border border-slate-200 p-2.5 text-xs outline-none focus:border-brand-blue"
                  />
                </div>
              </div>

              {/* الخيارات والتبديلات */}
              <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-slate-100">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formEnabled}
                    onChange={(e) => setFormEnabled(e.target.checked)}
                    className="rounded text-brand-blue"
                  />
                  <span className="font-bold text-slate-800">تفعيل هذا المزود</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formIsDefault}
                    onChange={(e) => setFormIsDefault(e.target.checked)}
                    className="rounded text-brand-blue"
                  />
                  <span className="font-bold text-slate-800">تعيين كمزود افتراضي أساسي ⭐</span>
                </label>
              </div>

              {/* أزرار الإجراءات */}
              <div className="flex items-center justify-end gap-2 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 transition-all"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-xl bg-navy-900 px-5 py-2 text-xs font-bold text-white shadow-xs hover:bg-navy-800 transition-all disabled:opacity-50"
                >
                  {saving ? "جاري الحفظ..." : "حفظ المزود"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
