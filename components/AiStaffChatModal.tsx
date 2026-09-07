"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  model?: string;
  latencyMs?: number;
  isLocalEngine?: boolean;
  timestamp: string;
}

interface PromptItem {
  category: "all" | "pharma" | "endo" | "ortho" | "postop" | "anesthesia" | "triage";
  icon: string;
  label: string;
  prompt: string;
}

const CATEGORIES = [
  { id: "all", label: "✨ الكل" },
  { id: "pharma", label: "💊 أدوية ومضادات" },
  { id: "anesthesia", label: "💉 تخدير وحالات خطرة" },
  { id: "endo", label: "🦷 طوارئ وعصب" },
  { id: "ortho", label: "📐 تقويم وفكين" },
  { id: "postop", label: "🩹 رعاية ما بعد العلاج" },
  { id: "triage", label: "📋 فرز الاستقبال" },
] as const;

const QUICK_PROMPTS: PromptItem[] = [
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
    prompt: "ما هو البروتوكول السريري الدقيق لفتح السن الطارئ (Pulpectomy) لحالة التهاب عصب حاد لا رجعة فيه (Irreversible Pulpitis) مع ألم نابض؟",
  },
  {
    category: "ortho",
    icon: "📐",
    label: "تشخيص تصنيف التقويم",
    prompt: "كيف نميز سريرياً وشعاعياً بين Class II div 1 و Class II div 2 وما هي معايير قرار القلع مقابل بدون قلع؟",
  },
  {
    category: "postop",
    icon: "🩹",
    label: "تعليمات ما بعد الخلع الجراحي",
    prompt: "اكتب لي تعليمات طبية واضحة وموجزة باللغة العربية يمكن إعطاؤها لمريض خضع لخلع جراحي لضرس العقل لتفادي النزف والسن الجاف (Dry Socket).",
  },
  {
    category: "anesthesia",
    icon: "💉",
    label: "تخدير مرضى الضغط والقلب",
    prompt: "ما هي القواعد المعتمدة لاختيار مخدر الأسنان لحالات ارتفاع ضغط الدم والقلب، وما هو الحد الأقصى لأمبولات الليدوكائين مع الأدرينالين (1:80,000 / 1:100,000)؟",
  },
  {
    category: "triage",
    icon: "📋",
    label: "توجيه الطوارئ بالاستقبال",
    prompt: "كيف يرتب موظف الاستقبال أولوية استقبال الحالات الطارئة (نزف، كسر سن أمامي، ألم حاد، سقوط حاصرة تقويم) في جدول المواعيد المزدحم؟",
  },
  {
    category: "endo",
    icon: "⚠️",
    label: "تدبير السنخ الجاف (Dry Socket)",
    prompt: "ما هو البروتوكول المعتمد لعلاج التهاب السنخ الجاف بعد خلع السن، وما حكم كحت وتجريف العظم؟",
  },
  {
    category: "anesthesia",
    icon: "🤰",
    label: "تخدير ومعالجة الحوامل",
    prompt: "ما هو أفضل توقيت لمعالجة المرأة الحامل وما هو البنج الموضعي الأكثر أماناً لها وما هي المحاذير الواجب مراعاتها في كرسي الأسنان؟",
  },
  {
    category: "endo",
    icon: "🦷",
    label: "انقلاع السن الدائم (Avulsion)",
    prompt: "ما هي الإسعافات الأولية وسرعة التدخل لحالة سقوط وانقلاع سن دائم أمامي لطفل، وما هي أوساط الحفظ ومدة التثبيت المعتمدة؟",
  },
  {
    category: "pharma",
    icon: "⚡",
    label: "بروتوكول تسكين الألم الحاد",
    prompt: "ما هو البروتوكول التآزري الفعال (Multimodal Analgesia) لدمج الإيبوبروفين مع الباراسيتامول لتسكين ألم الأسنان الحاد بأمان؟",
  },
];

const FOLLOWUP_CHIPS = [
  "💊 ما هي جرعة الأطفال الدقيقة حسب الوزن؟",
  "⚠️ ما هي موانع الاستعمال والتحذيرات؟",
  "🤰 هل هذا الإجراء أو الدواء آمن للحامل؟",
  "📱 صِغ لي رسالة واتساب جاهزة للمريض",
];

export function AiStaffChatModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Focus on input when opened and handle Escape
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);

      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") onClose();
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }
  }, [isOpen, onClose]);

  // Scroll to bottom on messages change
  useEffect(() => {
    if (isOpen) {
      chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, busy, isOpen]);

  const filteredPrompts = useMemo(() => {
    if (activeCategory === "all") return QUICK_PROMPTS;
    return QUICK_PROMPTS.filter((p) => p.category === activeCategory);
  }, [activeCategory]);

  if (!isOpen) return null;

  const handleSend = async (customPrompt?: string) => {
    const text = (customPrompt ?? input).trim();
    if (!text || busy) return;

    setError(null);
    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      role: "user",
      content: text,
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
        }),
      });

      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        reply?: string;
        model?: string;
        latencyMs?: number;
        isLocalEngine?: boolean;
        message?: string;
      } | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || "تعذّر الحصول على رد من المساعد الذكي.");
      }

      const botMsg: ChatMessage = {
        id: `a_${Date.now()}`,
        role: "assistant",
        content: payload.reply || "",
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
    setError(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/60 p-3 backdrop-blur-xs">
      <div
        className="flex h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
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
                <h2 className="text-sm font-black tracking-wide">المساعد السريري الذكي</h2>
                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-black text-emerald-300 flex items-center gap-1 border border-emerald-400/30">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  جاهز للخدمة
                </span>
              </div>
              <p className="text-[11px] text-slate-300">
                بروتوكولات سريرية • جرعات الأدوية • طوارئ العصب والجراحة • تقويم وسيفالومتري
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
            <span>المادة 214 دستوريًا: الذكاء الاصطناعي يقترح ولا يعتمد — القرار السريري النهائي بيد الطبيب المعالج دائمًا.</span>
          </div>
          <span className="rounded bg-amber-200/60 px-1.5 py-0.5 text-[10px] font-extrabold text-amber-950">
            خصوصية محمية
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
                مرحباً بك في المساعد الذكي لطاقم مركز د. عقلان
              </h3>
              <p className="mt-1 max-w-md text-xs leading-relaxed text-slate-500">
                محرك سريري ذكي جاهز لإجابتك فوراً عن بروتوكولات العلاج، حساب جرعات الأدوية بدقة، حالات الخطورة، واستشارات التقويم.
              </p>

              {/* Categories Bar */}
              <div className="mt-5 flex flex-wrap justify-center gap-1.5 max-w-xl">
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
              <div className="mt-4 w-full max-w-xl">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {filteredPrompts.map((item, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => handleSend(item.prompt)}
                      className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white p-2.5 text-right transition-all hover:border-brand-blue hover:bg-blue-50/40 hover:shadow-xs"
                    >
                      <span className="text-base">{item.icon}</span>
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

              return (
                <div
                  key={m.id}
                  className={`flex flex-col ${m.role === "user" ? "items-start" : "items-end"}`}
                >
                  <div
                    className={`relative max-w-[85%] rounded-2xl p-4 text-xs leading-relaxed shadow-2xs ${
                      m.role === "user"
                        ? "bg-navy-900 text-white rounded-tr-xs"
                        : "border border-slate-200 bg-white text-slate-800 rounded-tl-xs shadow-xs"
                    }`}
                  >
                    <div className="mb-1.5 flex items-center justify-between gap-3 text-[10px] opacity-70">
                      <span className="font-bold">
                        {m.role === "user" ? "👤 استفسار الطبيب / الموظف" : "🤖 مساعد مركز د. عقلان"}
                      </span>
                      <span>{m.timestamp}</span>
                    </div>

                    <div className="whitespace-pre-wrap font-sans text-[12px] leading-relaxed select-text">
                      {m.content}
                    </div>

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
                  <span>المساعد السريري الذكي يبحث ويصيغ الرد المعتمد...</span>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-bold text-red-700">
              ⚠️ {error}
            </div>
          )}

          <div ref={chatBottomRef} />
        </div>

        {/* Suggestion Followup Chips (when conversation has started) */}
        {messages.length > 0 && !busy && (
          <div className="flex items-center gap-1.5 overflow-x-auto border-t border-slate-100 bg-slate-50 px-3 py-2 text-[11px]">
            <span className="text-slate-400 font-bold shrink-0">⚡ استفسار سريع:</span>
            {FOLLOWUP_CHIPS.map((chip, i) => (
              <button
                key={i}
                type="button"
                onClick={() => handleSend(chip)}
                className="shrink-0 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-bold text-slate-700 hover:border-brand-blue hover:text-navy-900 transition-all shadow-2xs"
              >
                {chip}
              </button>
            ))}
          </div>
        )}

        {/* Input Bar */}
        <footer className="border-t border-slate-200 bg-white p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSend();
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
                    void handleSend();
                  }
                }}
                rows={2}
                placeholder="اكتب استفسارك الطبي أو السريري هنا... (Enter للإرسال، Shift+Enter لسطر جديد)"
                className="w-full resize-none rounded-xl border border-slate-200 p-2.5 text-xs outline-none focus:border-brand-blue"
              />
            </div>

            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="flex h-11 items-center justify-center rounded-xl bg-brand-orange px-5 text-xs font-black text-white shadow-xs transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy ? "..." : "إرسال"}
            </button>
          </form>
        </footer>
      </div>
    </div>
  );
}

