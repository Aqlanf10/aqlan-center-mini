"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KpiCard, StructuredTable, ActionButton } from "@/lib/ai-tools/types";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  model?: string;
  latencyMs?: number;
  isLocalEngine?: boolean;
  sourceType?: "live_database" | "internal_engine" | "external_ai";
  cards?: KpiCard[];
  table?: StructuredTable | null;
  actions?: ActionButton[];
  warnings?: string[];
  timestamp: string;
}

interface PromptItem {
  category: "all" | "actions" | "finance" | "patients" | "clinic" | "system" | "pharma" | "endo" | "ortho" | "postop";
  icon: string;
  label: string;
  prompt: string;
}

const CATEGORIES = [
  { id: "all", label: "✨ الكل" },
  { id: "actions", label: "⚡ تنفيذ الأوامر والعمليات" },
  { id: "finance", label: "💰 المالية والتقارير" },
  { id: "patients", label: "👤 استعلام المرضى" },
  { id: "clinic", label: "📊 مواعيد وعمليات المركز" },
  { id: "system", label: "💡 دليل استخدام البرنامج" },
  { id: "ortho", label: "📐 تقويم وسيفالومتري" },
  { id: "pharma", label: "💊 أدوية ومضادات" },
  { id: "endo", label: "🦷 طوارئ وعصب" },
  { id: "postop", label: "🩹 رعاية ما بعد العلاج" },
] as const;

const QUICK_PROMPTS: PromptItem[] = [
  {
    category: "actions",
    icon: "➕",
    label: "إضافة مريض جديد",
    prompt: "أضف مريض جديد باسم: طارق الحميري، هاتف: 771234567، ذكر، 1996",
  },
  {
    category: "actions",
    icon: "📅",
    label: "حجز موعد مباشر",
    prompt: "احجز موعد للمريض طارق الحميري غداً الساعة 4:30 عصراً كشف واستشارة",
  },
  {
    category: "actions",
    icon: "💵",
    label: "تسجيل سند قبض",
    prompt: "سجل سند قبض بمبلغ 10000 ريال يمني للمريض طارق الحميري نقداً بالصندوق",
  },
  {
    category: "actions",
    icon: "⚠️",
    label: "تثبيت تنبيه طبي",
    prompt: "سجل تنبيه طبي للمريض طارق: حساسية مفرطة من البنسلين",
  },
  {
    category: "actions",
    icon: "🦷",
    label: "طلب معمل تركيبات",
    prompt: "طلب معمل تاج زركون للمريض طارق لون A2 التسليم بعد 4 أيام",
  },
  {
    category: "actions",
    icon: "📲",
    label: "تجهيز رسالة واتساب",
    prompt: "جهز رسالة تذكير بالموعد على الواتساب للمريض طارق",
  },
  {
    category: "actions",
    icon: "🚶",
    label: "تسجيل حضور مريض",
    prompt: "سجل وصول المريض طارق لصالة الانتظار",
  },
  {
    category: "actions",
    icon: "📦",
    label: "صرف مادة من المخزن",
    prompt: "سجل صرف 2 كراتين قفازات واستهلاكها بالعيادة",
  },
  {
    category: "finance",
    icon: "💵",
    label: "دخل وتحصيل اليوم",
    prompt: "كم دخل المركز ومتحصلات الصندوق اليوم بمختلف العملات؟",
  },
  {
    category: "finance",
    icon: "📊",
    label: "مديونية مرضى التقويم",
    prompt: "اعطني مديونية مرضى التقويم لهذا الشهر ومن أكثر المرضى مديونية؟",
  },
  {
    category: "finance",
    icon: "📈",
    label: "مقارنة هذا الشهر بالماضي",
    prompt: "قارن دخل هذا الشهر بالشهر الماضي وما هي نسبة التغير؟",
  },
  {
    category: "finance",
    icon: "⏳",
    label: "أعمار الديون +90 يوم",
    prompt: "كم إجمالي مديونيات المرضى المتأخرة لأكثر من 90 يوماً؟",
  },
  {
    category: "patients",
    icon: "👤",
    label: "استعلام رصيد وحساب مريض",
    prompt: "كم باقي على المريض وما هو رصيده وحالة حسابه وفواتيره؟",
  },
  {
    category: "patients",
    icon: "📋",
    label: "معلومات وبيانات مريض",
    prompt: "أريد معلومات المريض: رقم الملف، الهاتف، المواعيد القادمة، والتنبيه الطبي.",
  },
  {
    category: "clinic",
    icon: "📅",
    label: "مواعيد اليوم في المركز",
    prompt: "ما هي مواعيد اليوم في المركز ومن هم المرضى المسجلون وأوقاتهم؟",
  },
  {
    category: "clinic",
    icon: "📦",
    label: "نواقص المخزون وحد الطلب",
    prompt: "ما هي المواد والمستلزمات في المخزون التي وصلت إلى حد الطلب الأدنى وتحتاج لتوريد؟",
  },
  {
    category: "clinic",
    icon: "🔬",
    label: "أوامر المعمل المعلقة",
    prompt: "كم حالة في معمل الأسنان قيد التصنيع ولم تصل حتى الآن؟",
  },
  {
    category: "clinic",
    icon: "🦷",
    label: "أسعار خدمات المركز",
    prompt: "ما هي أسعار خدمات الحشوات وعلاج العصب والتقويم والتركيبات المعتمدة في المركز؟",
  },
  {
    category: "ortho",
    icon: "📐",
    label: "متابعات التقويم المتأخرة",
    prompt: "اعطني مرضى التقويم المتأخرين عن جلسات الشدة والمتابعة لأكثر من 30 يوماً.",
  },
  {
    category: "system",
    icon: "💳",
    label: "كيف أعمل فاتورة وسند قبض؟",
    prompt: "كيف أعمل فاتورة جديدة لمريض وأسجل سند قبض نقدي في النظام؟",
  },
  {
    category: "system",
    icon: "🗓️",
    label: "كيف أحجز موعد جديد؟",
    prompt: "كيف أحجز موعد لمريض في جدول مواعيد العيادة؟",
  },
  {
    category: "system",
    icon: "💾",
    label: "كيف أعمل نسخ احتياطي (Backup)؟",
    prompt: "كيف أقوم بتنزيل نسخة احتياطية كاملة لحفظ بيانات المركز والمرضى؟",
  },
  {
    category: "pharma",
    icon: "💊",
    label: "جرعات أوجمنتين وفلاجيل",
    prompt: "ما هي الجرعات المعتمدة لأوجمنتين (Augmentin) وفلاجيل (Metronidazole) للبالغين وللأطفال في خراجات الأسنان الحادة وموانع الاستعمال؟",
  },
  {
    category: "endo",
    icon: "🦷",
    label: "فتح علاج العصب الطارئ",
    prompt: "ما هو البروتوكول السريري الدقيق لفتح السن الطارئ (Pulpectomy) لحالة التهاب عصب حاد لا رجعة فيه مع ألم نابض؟",
  },
];

interface AiStaffChatModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUserRole?: string;
  currentUserName?: string;
}

export default function AiStaffChatModal({
  isOpen,
  onClose,
  currentUserRole,
  currentUserName,
}: AiStaffChatModalProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<PromptItem["category"]>("all");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [currentPatientId, setCurrentPatientId] = useState<number | null>(null);

  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [isOpen]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  const filteredPrompts = useMemo(() => {
    if (activeCategory === "all") return QUICK_PROMPTS;
    return QUICK_PROMPTS.filter((p) => p.category === activeCategory);
  }, [activeCategory]);

  if (!isOpen) return null;

  const handleSend = async (customPrompt?: string) => {
    const textToSend = (customPrompt || input).trim();
    if (!textToSend || busy) return;

    setError(null);
    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      role: "user",
      content: textToSend,
      timestamp: new Date().toLocaleTimeString("ar-YE", { hour: "2-digit", minute: "2-digit" }),
    };

    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    if (!customPrompt) setInput("");
    setBusy(true);

    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
          conversationPatientId: currentPatientId,
        }),
      });

      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        reply?: string;
        answer?: string;
        intent?: string;
        cards?: KpiCard[];
        table?: StructuredTable | null;
        actions?: ActionButton[];
        warnings?: string[];
        sourceType?: "live_database" | "internal_engine" | "external_ai";
        model?: string;
        latencyMs?: number;
        isLocalEngine?: boolean;
        message?: string;
        patientIdAccessed?: number;
      } | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || "تعذّر الحصول على رد من المساعد الذكي.");
      }

      if (payload.patientIdAccessed) {
        setCurrentPatientId(payload.patientIdAccessed);
      }

      const botMsg: ChatMessage = {
        id: `a_${Date.now()}`,
        role: "assistant",
        content: payload.answer || payload.reply || "",
        cards: payload.cards,
        table: payload.table,
        actions: payload.actions,
        warnings: payload.warnings,
        sourceType: payload.sourceType || "internal_engine",
        model: payload.model,
        latencyMs: payload.latencyMs,
        isLocalEngine: payload.isLocalEngine,
        timestamp: new Date().toLocaleTimeString("ar-YE", { hour: "2-digit", minute: "2-digit" }),
      };

      setMessages((prev) => [...prev, botMsg]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "حدث خطأ غير متوقع.";
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const copyText = (id: string, text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const sendToWhatsApp = (content: string) => {
    const match = content.match(/```text\s*([\s\S]*?)\s*```/);
    const msg = match ? match[1] : content;
    const url = `https://api.whatsapp.com/send?text=${encodeURIComponent(msg)}`;
    window.open(url, "_blank");
  };

  const clearChat = () => {
    setMessages([]);
    setCurrentPatientId(null);
    setError(null);
  };

  const getSourceBadge = (source?: "live_database" | "internal_engine" | "external_ai") => {
    switch (source) {
      case "live_database":
        return { label: "🟢 من بيانات المركز المباشرة", color: "bg-emerald-50 text-emerald-800 border-emerald-200" };
      case "external_ai":
        return { label: "☁️ مزود ذكاء سحابي مؤمّن", color: "bg-blue-50 text-blue-800 border-blue-200" };
      case "internal_engine":
      default:
        return { label: "📘 إجابة سريرية ومعرفية داخلية", color: "bg-purple-50 text-purple-800 border-purple-200" };
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/60 p-3 backdrop-blur-xs">
      <div
        className="flex h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        dir="rtl"
      >
        {/* Header */}
        <header className="flex items-center justify-between border-b border-slate-200 bg-gradient-to-r from-navy-900 via-navy-800 to-navy-900 px-5 py-3.5 text-white">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 text-xl backdrop-blur-xs shadow-inner">
              🤖
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-black tracking-wide">
                  AQLAN CENTER INTERNAL AI ASSISTANT
                </h2>
                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-black text-emerald-300 flex items-center gap-1 border border-emerald-400/30">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  واجهة المركز الذكية الموحدة
                </span>
              </div>
              <p className="text-[11px] text-slate-300">
                مرضى • حسابات • تقارير • مواعيد • تقويم • مخزون • معمل • بروتوكولات سريرية
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {messages.length > 0 && (
              <button
                type="button"
                onClick={clearChat}
                className="rounded-lg border border-white/20 bg-white/5 px-2.5 py-1 text-xs font-bold text-slate-200 hover:bg-white/10 transition-colors"
                title="مسح محادثة اليوم"
              >
                مسح
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="إغلاق"
              className="rounded-lg p-1.5 text-white/80 hover:bg-white/10 hover:text-white transition-colors"
            >
              ✕
            </button>
          </div>
        </header>

        {/* Disclaimer Banner */}
        <div className="flex items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-[11px] font-bold text-amber-900">
          <div className="flex items-center gap-1.5">
            <span>🛡️</span>
            <span>المادة 214 دستوريًا: الذكاء الاصطناعي يقترح ولا يعتمد — كافة الأرقام والحسابات تأتي من النظام المحاسبي المعتمد مباشرة.</span>
          </div>
          <span className="rounded bg-amber-200/60 px-1.5 py-0.5 text-[10px] font-extrabold text-amber-950">
            عزل أطباء وخصوصية §39
          </span>
        </div>

        {/* Chat Area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50/50">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center p-4">
              <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-blue/10 text-3xl shadow-inner">
                🦷
              </div>
              <h3 className="text-base font-black text-navy-900">
                مرحباً بك في المساعد الداخلي الموحد لمركز د. عقلان
              </h3>
              <p className="mt-1 max-w-lg text-xs leading-relaxed text-slate-500">
                اسألني باللغة الطبيعية عن أي مريض، أو موعد، أو دخل مالي، أو تقرير، أو حالة مخزون، أو أوامر معمل، أو إرشادات سريرية واستخدام للنظام.
              </p>

              {/* Categories Bar */}
              <div className="mt-5 flex flex-wrap justify-center gap-1.5 max-w-2xl">
                {CATEGORIES.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setActiveCategory(cat.id)}
                    className={`rounded-full px-3 py-1 text-[11px] font-black transition-all ${
                      activeCategory === cat.id
                        ? "bg-navy-900 text-white shadow-xs"
                        : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-100"
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>

              {/* Quick Prompts Grid */}
              <div className="mt-4 w-full max-w-2xl">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {filteredPrompts.map((item, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => handleSend(item.prompt)}
                      className="flex items-start gap-2.5 rounded-xl border border-slate-200 bg-white p-3 text-right transition-all hover:border-brand-blue hover:bg-blue-50/40 hover:shadow-xs"
                    >
                      <span className="text-lg">{item.icon}</span>
                      <div>
                        <div className="text-xs font-black text-slate-900">{item.label}</div>
                        <div className="mt-0.5 line-clamp-1 text-[10px] text-slate-500">{item.prompt}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            messages.map((m) => {
              const hasWhatsAppMsg = m.content.includes("```text") || m.content.includes("واتساب");
              const sourceBadge = m.role === "assistant" ? getSourceBadge(m.sourceType) : null;

              return (
                <div
                  key={m.id}
                  className={`flex flex-col ${m.role === "user" ? "items-start" : "items-end"}`}
                >
                  <div
                    className={`relative w-full max-w-[92%] rounded-2xl p-4 text-xs leading-relaxed shadow-2xs ${
                      m.role === "user"
                        ? "bg-navy-900 text-white rounded-tr-xs ml-auto"
                        : "border border-slate-200 bg-white text-slate-800 rounded-tl-xs shadow-xs"
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between gap-3 text-[10px] opacity-75">
                      <span className="font-bold">
                        {m.role === "user" ? "👤 استفسار المستخدم" : "🤖 مساعد مركز د. عقلان"}
                      </span>
                      <div className="flex items-center gap-2">
                        {sourceBadge && (
                          <span className={`rounded-md border px-2 py-0.5 text-[9px] font-black ${sourceBadge.color}`}>
                            {sourceBadge.label}
                          </span>
                        )}
                        <span>{m.timestamp}</span>
                      </div>
                    </div>

                    {/* KPI Cards Grid */}
                    {m.cards && m.cards.length > 0 && (
                      <div className="mb-3.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {m.cards.map((c, idx) => {
                          const toneClasses = {
                            good: "bg-emerald-50 text-emerald-900 border-emerald-200",
                            warn: "bg-amber-50 text-amber-900 border-amber-200",
                            bad: "bg-rose-50 text-rose-900 border-rose-200",
                            info: "bg-blue-50 text-blue-900 border-blue-200",
                            calm: "bg-slate-50 text-slate-800 border-slate-200",
                          }[c.tone || "info"];

                          return (
                            <div
                              key={idx}
                              className={`rounded-xl border p-2.5 shadow-2xs ${toneClasses}`}
                            >
                              <div className="text-[10px] font-bold opacity-80">{c.title}</div>
                              <div className="mt-1 text-sm font-black tracking-tight">{c.value}</div>
                              {c.hint && <div className="mt-0.5 text-[9px] opacity-70">{c.hint}</div>}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Message Body */}
                    <div className="whitespace-pre-wrap font-sans text-[12px] leading-relaxed select-text">
                      {m.content}
                    </div>

                    {/* Structured Table */}
                    {m.table && m.table.rows.length > 0 && (
                      <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
                        {m.table.caption && (
                          <div className="border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-[11px] font-bold text-slate-700">
                            {m.table.caption}
                          </div>
                        )}
                        <table className="w-full text-right text-[11px]">
                          <thead className="bg-slate-100/70 text-slate-700 font-bold border-b border-slate-200">
                            <tr>
                              {m.table.headers.map((h, i) => (
                                <th key={i} className="px-3 py-2">
                                  {h}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {m.table.rows.map((row, rIdx) => (
                              <tr key={rIdx} className="hover:bg-blue-50/30 transition-colors">
                                {row.map((cell, cIdx) => (
                                  <td key={cIdx} className="px-3 py-1.5 font-medium text-slate-800">
                                    {cell !== null && cell !== undefined ? String(cell) : "—"}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Action Buttons */}
                    {m.actions && m.actions.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5 pt-1">
                        {m.actions.map((act, aIdx) => (
                          <a
                            key={aIdx}
                            href={act.href}
                            target={act.actionType === "whatsapp" || act.actionType === "print" ? "_blank" : undefined}
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 rounded-lg border border-brand-blue/30 bg-blue-50/60 px-2.5 py-1 text-[11px] font-bold text-brand-blue hover:bg-brand-blue hover:text-white transition-all shadow-2xs"
                          >
                            <span>⚡</span>
                            <span>{act.label}</span>
                          </a>
                        ))}
                      </div>
                    )}

                    {/* Footer Tools and Model Info */}
                    {m.role === "assistant" && (
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2 text-[10px] text-slate-600">
                        <div className="flex items-center gap-2">
                          {m.model && (
                            <span className="font-mono rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-700">
                              {m.model}
                            </span>
                          )}
                          {m.latencyMs ? <span>• {(m.latencyMs / 1000).toFixed(1)} ث</span> : null}
                        </div>

                        <div className="flex items-center gap-1.5">
                          {hasWhatsAppMsg && (
                            <button
                              type="button"
                              onClick={() => sendToWhatsApp(m.content)}
                              className="flex items-center gap-1 rounded bg-emerald-50 border border-emerald-200 px-2 py-0.5 font-bold text-emerald-800 hover:bg-emerald-100 transition-colors"
                              title="إرسال نص الرسالة للواتساب"
                            >
                              <span>💬</span>
                              <span>واتساب المريض</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => copyText(m.id, m.content)}
                            className="rounded border border-slate-200 bg-white px-2 py-0.5 font-bold text-slate-700 hover:bg-slate-100 transition-colors"
                          >
                            {copiedId === m.id ? "✓ تم النسخ" : "📋 نسخ"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}

          {busy && (
            <div className="flex items-end">
              <div className="rounded-2xl rounded-tl-xs border border-slate-200 bg-white p-3.5 shadow-xs">
                <div className="flex items-center gap-2 text-xs font-bold text-slate-600">
                  <span className="inline-block animate-spin">🌀</span>
                  <span>المساعد الداخلي يبحث في النظام ويجهز التقرير...</span>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-bold text-rose-800">
              ⚠️ {error}
            </div>
          )}

          <div ref={endRef} />
        </div>

        {/* Input Bar */}
        <footer className="border-t border-slate-200 bg-white p-3.5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            className="flex items-end gap-2"
          >
            <div className="relative flex-1">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                rows={1}
                placeholder="اسأل عن أي مريض، أو مديونية، أو موعد، أو دخل اليوم، أو كيفية استخدام شاشة..."
                className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-800 placeholder-slate-400 focus:border-brand-blue focus:bg-white focus:outline-hidden focus:ring-1 focus:ring-brand-blue leading-relaxed max-h-32"
              />
            </div>

            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl bg-navy-900 px-4 text-xs font-black text-white shadow-xs transition-all hover:bg-navy-800 disabled:opacity-40 disabled:pointer-events-none"
            >
              <span>إرسال</span>
              <span>↵</span>
            </button>
          </form>
          <div className="mt-2 flex items-center justify-between text-[10px] text-slate-400">
            <span>Enter للإرسال • Shift+Enter لسطر جديد • Esc للإغلاق</span>
            <span>Aqlan Center Mini • الإصدار المتطور</span>
          </div>
        </footer>
      </div>
    </div>
  );
}

export { AiStaffChatModal };

