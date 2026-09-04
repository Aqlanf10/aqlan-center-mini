"use client";

import { useMemo, useState } from "react";
import { COMMON_MEDICAL_RISKS, ageFromBirthYear, parseMedicalAlerts, type Patient } from "@/lib/patient";
import { postProcedureCareText, toWhatsAppNumber, whatsAppDirectLink } from "@/lib/reminders";
import { useClinicName, useSetting } from "@/components/SettingsProvider";

export interface ChairsideTabletViewProps {
  patient: Patient;
  visitId?: number | null;
  onClose: () => void;
  onProcedureSelected?: (procedureName: string) => void;
  onNoteAppended?: (noteSnippet: string) => void;
  onMaterialLogged?: (materialName: string) => void;
}

const QUICK_CLINICAL_PROCEDURES = [
  { label: "خلع سن بسيط", icon: "🦷", category: "surgical", phrase: "تم إجراء خلع سن بسيط تحت التخدير الموضعي وتجريف التجويف والسيطرة على النزيف." },
  { label: "خلع جراحي / عظمي", icon: "🔪", category: "surgical", phrase: "تم خلع جراحي بعد شق سني سنخي وفصل الجذور وخياطة الجرح بنجاح." },
  { label: "سحب عصب: جلسة 1", icon: "⚡", category: "endo", phrase: "فتح حجرة اللب وتحديد أطوال القنوات السنية واستئصال العصب وتوسيع القنوات ووضع ضماد طبي." },
  { label: "سحب عصب: حشو قنوات", icon: "💉", category: "endo", phrase: "تجفيف القنوات السنية وحشو القنوات نهائياً بأقماع كوتا بيركا ومعجون حشو قنوات والتأكد شعاعياً." },
  { label: "حشوة كمبوزيت تجميلية", icon: "✨", category: "restorative", phrase: "إزالة النخر السني وتطبيق حمض التخريش والمادة اللاصقة وحشو السن بالكمبوزيت وضبط الإطباق والتلميع." },
  { label: "تنظيف جير وتلميع", icon: "🧽", category: "hygiene", phrase: "إزالة الرواسب الجيرية فوق وتحت اللثة بالموجات فوق الصوتية وتلميع أسطح الأسنان بمعجون وقائي." },
  { label: "أخذ طبعة مقاس", icon: "📐", category: "prostho", phrase: "أخذ طبعة فكية دقيقة للسن المحضر لإرسالها لمعمل الأسنان لصناعة التركيبة." },
  { label: "شد وضبط تقويم", icon: "🧲", category: "ortho", phrase: "استبدال السلك التقويمي وتبديل المطاطات وتفعيل الشد حسب الخطة العلاجية." },
];

const QUICK_CLINICAL_PHRASES = [
  "تم التخدير الموضعي بنجاح بدون أي مضاعفات سريرية.",
  "تم عزل السن عزلاً تاماً باستخدام الحاجز المطاطي (Rubber Dam).",
  "تم تنظيف وتطهير وتوسيع القنوات بالكامل إلى الطول المحدد.",
  "تم وضع حشوة مؤقتة محكمة وإعطاء المريض موعد الجلسة القادمة.",
  "تم فحص الإطباق بواسطة ورق العض والتأكد من الراحة التامة.",
  "تم تسليم المريض تعليمات العناية الفموية وضرورة تجنب العض على السن المعالج.",
];

const CHAIRSIDE_COMMON_MATERIALS = [
  { name: "كاربولة بنج ليدوكايين 2%", icon: "💉" },
  { name: "إبرة تخدير معقمة", icon: "📍" },
  { name: "حشوة كمبوزيت (جرعة)", icon: "✨" },
  { name: "حاجز مطاطي (شيت)", icon: "🧤" },
  { name: "مبرد إندو دوار", icon: "🌀" },
  { name: "خيط جراحة مع إبرة", icon: "🧵" },
];

export function ChairsideTabletView({
  patient,
  visitId,
  onClose,
  onProcedureSelected,
  onNoteAppended,
  onMaterialLogged,
}: ChairsideTabletViewProps) {
  const clinicName = useClinicName();
  const clinicPhone = useSetting("clinic.phone");

  const [activeTab, setActiveTab] = useState<"actions" | "materials" | "whatsapp">("actions");
  const [loggedItems, setLoggedItems] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);

  const parsedAlerts = useMemo(() => parseMedicalAlerts(patient.medicalAlert), [patient.medicalAlert]);

  const showFeedback = (msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 3000);
  };

  const handleProcedureClick = (proc: (typeof QUICK_CLINICAL_PROCEDURES)[0]) => {
    onProcedureSelected?.(proc.label);
    onNoteAppended?.(proc.phrase);
    setLoggedItems((prev) => [proc.label, ...prev]);
    showFeedback(`تم تسجيل: ${proc.label}`);
  };

  const handlePhraseClick = (phrase: string) => {
    onNoteAppended?.(phrase);
    showFeedback("تمت إضافة الملاحظة السريرية");
  };

  const handleMaterialClick = (matName: string) => {
    onMaterialLogged?.(matName);
    setLoggedItems((prev) => [`+1 ${matName}`, ...prev]);
    showFeedback(`تم تسجيل استهلاك: ${matName}`);
  };

  const waNumber = toWhatsAppNumber(patient.phone);

  const postOpOptions: { label: string; kind: "extraction" | "rct" | "whitening" | "ortho_care"; icon: string }[] = [
    { label: "تعليمات ما بعد خلع الأسنان", kind: "extraction", icon: "🦷" },
    { label: "تعليمات ما بعد علاج الجذور (العصب)", kind: "rct", icon: "⚡" },
    { label: "تعليمات ما بعد تبييض الأسنان", kind: "whitening", icon: "✨" },
    { label: "تعليمات العناية بجهاز التقويم", kind: "ortho_care", icon: "🧲" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-900 text-white select-none overflow-hidden" dir="rtl">
      {/* Top Tablet Bar: Patient Identity & Glove-Friendly Close Button */}
      <header className="flex shrink-0 items-center justify-between border-b border-slate-800 bg-slate-950 px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-blue text-2xl font-black text-white shadow-lg">
            🦷
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-black text-white">{patient.fullName}</h1>
              <span className="rounded-full bg-slate-800 px-3 py-1 text-sm font-bold text-slate-300">
                ملف #{patient.patientNumber}
              </span>
              {patient.birthYear ? (
                <span className="rounded-full bg-slate-800 px-3 py-1 text-sm font-bold text-slate-300">
                  {ageFromBirthYear(patient.birthYear, new Date().toISOString().slice(0, 10))} سنة
                </span>
              ) : null}
            </div>
            <p className="text-xs text-slate-400 mt-1">
              📱 وضع الكرسي والتابلت السريري {visitId ? `· زيارة اليوم نشطة #${visitId}` : "· معاينة سريرية"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {feedback ? (
            <div className="rounded-xl bg-emerald-500/20 border border-emerald-500/40 px-4 py-2 text-sm font-bold text-emerald-300 animate-fade-in">
              ✓ {feedback}
            </div>
          ) : null}
          <button
            onClick={onClose}
            className="flex h-12 items-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 px-5 text-sm font-bold text-white transition-colors border border-slate-700 active:scale-95"
            title="العودة للوضع العادي"
          >
            <span>✕</span>
            <span>إنهاء وضع الكرسي</span>
          </button>
        </div>
      </header>

      {/* High-Contrast Critical Medical Alerts Banner */}
      <section className="shrink-0 bg-slate-900 border-b border-slate-800 px-6 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold text-slate-400 flex items-center gap-1.5 ml-2">
            <span>⚠️</span>
            <span>تنبيهات الأمان الطبي:</span>
          </span>
          {parsedAlerts.badges.length > 0 ? (
            parsedAlerts.badges.map((alert) => (
              <span
                key={alert.id}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-black border shadow-xs ${
                  alert.severity === "high"
                    ? "bg-red-500/20 text-red-300 border-red-500/50 animate-pulse"
                    : "bg-amber-500/20 text-amber-300 border-amber-500/50"
                }`}
              >
                <span>{alert.icon}</span>
                <span>{alert.label}</span>
              </span>
            ))
          ) : (
            <span className="inline-flex items-center gap-1 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-3 py-1 text-xs font-bold">
              <span>✓</span>
              <span>لا توجد تنبيهات حساسية أو أمراض مسجلة</span>
            </span>
          )}
        </div>
      </section>

      {/* Navigation Sub-tabs for Touch Mode */}
      <nav className="flex shrink-0 gap-2 border-b border-slate-800 bg-slate-950 px-6 py-2">
        <button
          onClick={() => setActiveTab("actions")}
          className={`flex h-12 items-center gap-2 rounded-xl px-6 text-sm font-black transition-all ${
            activeTab === "actions"
              ? "bg-brand-blue text-white shadow-md shadow-brand-blue/30"
              : "bg-slate-900 text-slate-400 hover:text-white"
          }`}
        >
          <span>⚡</span>
          <span>الإجراءات والملاحظات السريعة</span>
        </button>
        <button
          onClick={() => setActiveTab("materials")}
          className={`flex h-12 items-center gap-2 rounded-xl px-6 text-sm font-black transition-all ${
            activeTab === "materials"
              ? "bg-brand-blue text-white shadow-md shadow-brand-blue/30"
              : "bg-slate-900 text-slate-400 hover:text-white"
          }`}
        >
          <span>📦</span>
          <span>صرف المستهلكات بالكرسي</span>
        </button>
        <button
          onClick={() => setActiveTab("whatsapp")}
          className={`flex h-12 items-center gap-2 rounded-xl px-6 text-sm font-black transition-all ${
            activeTab === "whatsapp"
              ? "bg-brand-blue text-white shadow-md shadow-brand-blue/30"
              : "bg-slate-900 text-slate-400 hover:text-white"
          }`}
        >
          <span>📲</span>
          <span>تعليمات ما بعد العلاج (واتساب)</span>
        </button>
      </nav>

      {/* Main Touch Workspace */}
      <main className="flex-1 overflow-y-auto p-6">
        {activeTab === "actions" && (
          <div className="grid gap-6 lg:grid-cols-2">
            {/* 1-Tap Clinical Procedures */}
            <div>
              <h2 className="mb-3 text-base font-black text-slate-200 flex items-center gap-2">
                <span>🦷</span>
                <span>الإجراءات السريرية المنجزة (نقرة واحدة للتسجيل)</span>
              </h2>
              <div className="grid grid-cols-2 gap-3">
                {QUICK_CLINICAL_PROCEDURES.map((proc) => (
                  <button
                    key={proc.label}
                    onClick={() => handleProcedureClick(proc)}
                    className="flex min-h-[72px] flex-col justify-center rounded-2xl border border-slate-800 bg-slate-800/80 p-4 text-right hover:border-brand-blue hover:bg-slate-800 active:scale-98 transition-all shadow-sm"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-2xl">{proc.icon}</span>
                      <span className="text-base font-black text-white">{proc.label}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Quick Clinical Phrase Snippets */}
            <div>
              <h2 className="mb-3 text-base font-black text-slate-200 flex items-center gap-2">
                <span>📝</span>
                <span>الملاحظات السريرية الجاهزة (تضاف للتقرير الطبي)</span>
              </h2>
              <div className="space-y-2.5">
                {QUICK_CLINICAL_PHRASES.map((phrase, idx) => (
                  <button
                    key={idx}
                    onClick={() => handlePhraseClick(phrase)}
                    className="w-full rounded-2xl border border-slate-800 bg-slate-800/50 p-3.5 text-right text-sm font-semibold text-slate-200 hover:border-emerald-500 hover:bg-slate-800 active:scale-99 transition-all"
                  >
                    + {phrase}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === "materials" && (
          <div>
            <h2 className="mb-3 text-base font-black text-slate-200 flex items-center gap-2">
              <span>📦</span>
              <span>تسجيل المستهلكات الطبية المستخدمة في جلسة اليوم</span>
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {CHAIRSIDE_COMMON_MATERIALS.map((mat) => (
                <button
                  key={mat.name}
                  onClick={() => handleMaterialClick(mat.name)}
                  className="flex min-h-[90px] flex-col items-center justify-center gap-2 rounded-2xl border border-slate-800 bg-slate-800/80 p-4 text-center hover:border-amber-400 hover:bg-slate-800 active:scale-95 transition-all"
                >
                  <span className="text-3xl">{mat.icon}</span>
                  <span className="text-sm font-black text-white">{mat.name}</span>
                  <span className="rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 px-3 py-0.5 text-xs font-bold">
                    +1 صرف
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {activeTab === "whatsapp" && (
          <div>
            <h2 className="mb-3 text-base font-black text-slate-200 flex items-center gap-2">
              <span>📲</span>
              <span>إرسال تعليمات العناية والمتابعة لهاتف المريض مباشرة عبر واتساب</span>
            </h2>
            {waNumber ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {postOpOptions.map((opt) => (
                  <a
                    key={opt.kind}
                    href={
                      whatsAppDirectLink(
                        waNumber,
                        postProcedureCareText(patient.fullName, opt.kind, {
                          name: clinicName,
                          phone: clinicPhone,
                        })
                      ) ?? undefined
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-h-[80px] items-center gap-3 rounded-2xl border border-emerald-900/50 bg-emerald-950/40 p-4 text-right hover:border-emerald-500 hover:bg-emerald-900/40 active:scale-98 transition-all text-emerald-100"
                  >
                    <span className="text-3xl">{opt.icon}</span>
                    <div>
                      <p className="text-base font-black">{opt.label}</p>
                      <p className="text-xs text-emerald-400/80 mt-0.5">إرسال نصائح ما بعد الجلسة للمريض</p>
                    </div>
                  </a>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-amber-900/50 bg-amber-950/30 p-6 text-center text-amber-200">
                <p className="text-base font-bold">لا يوجد رقم هاتف صالح للمريض لإرسال تعليمات واتساب.</p>
                <p className="text-xs text-amber-400 mt-1">يرجى تحديث رقم الهاتف في الملف الشخصي للمريض.</p>
              </div>
            )}
          </div>
        )}

        {/* Recently Logged in this Chairside Session */}
        {loggedItems.length > 0 && (
          <div className="mt-8 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <h3 className="text-xs font-bold text-slate-400 mb-2">سجل إدخالات جلسة الكرسي الحالية:</h3>
            <div className="flex flex-wrap gap-2">
              {loggedItems.map((item, i) => (
                <span key={i} className="rounded-xl bg-slate-800 border border-slate-700 px-3 py-1 text-xs font-bold text-slate-300">
                  {item}
                </span>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
