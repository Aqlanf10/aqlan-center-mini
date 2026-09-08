"use client";

import { useEffect, useMemo, useState } from "react";
import { useClinicName } from "./SettingsProvider";
import { Icon } from "./Icon";
import { toWhatsAppNumber } from "@/lib/reminders";
import { evaluatePrescriptionSafety, type DrugSafetyAlert } from "@/lib/medication-safety";
import { PROCEDURE_TEMPLATES } from "@/lib/prescription-procedure-templates";
import { interpretPrescriptionSaveResponse } from "@/lib/prescription-save-workflow";

/**
 * الوصفة الطبية — الدواء بالإنجليزية والتعليمات بلغة المريض.
 *
 * اسم الدواء وعياره وشكله وعدد مراته ومدته يُكتب لاتينيًا دائمًا: الصيدلاني
 * والمرجع الدوائي والطبيب الاستشاري كلهم يقرؤون الإنجليزية، والاسم العربي
 * للدواء يختلف من بلدٍ لبلد فيصير ترجمةُ الاسم خطأً دوائيًا. أما التعليمات —
 * متى يؤخذ وماذا يتجنب — فهي كلامٌ للمريض، فيختار الطبيب لغتها: عربية، أو
 * إنجليزية، أو الاثنتين معًا لبيئةٍ ثنائية اللغة.
 */

export interface RxItem {
  /** اسم الدواء — لاتيني دائمًا. */
  name: string;
  /** العيار: 1g / 500mg. */
  dose: string;
  /** الشكل الدوائي بالإنجليزية: Tablets / Syrup / Mouthwash. */
  form: string;
  /** التكرار بالإنجليزية: 1 tablet every 12 hours. */
  frequency: string;
  /** المدة بالإنجليزية: 5-7 days. */
  duration: string;
  /** تعليمات المريض بالعربية. */
  instructions: string;
  /** تعليمات المريض بالإنجليزية. */
  instructionsEn: string;
}

/** لغة التعليمات على الروشتة المطبوعة: عربي، إنجليزي، أو كلاهما. */
export type InstructionsLang = "both" | "ar" | "en";

const LANG_LABELS: { key: InstructionsLang; label: string }[] = [
  { key: "both", label: "عربي + English" },
  { key: "ar", label: "عربي" },
  { key: "en", label: "English" },
];

/* قوالب الأدوية الجاهزة أُزيلت كليًا (مراجعة الجولة الثانية — Blocker A):
 * كان هنا COMMON_TEMPLATES تحمل regimens ثابتة (Augmentin بعد الخلع الجراحي،
 * Amoxicillin+Metronidazole للخراج، وقاية الزراعة، شراب أطفال…) تُحمّل
 * بضغطةٍ واحدة بلا أي سياق سريري. صارت القوالب في lib/prescription-procedure-templates
 * «إجراءات وتشخيصات» تُعبّئ الحالة والملاحظات فقط — اختيار الدواء والجرعة
 * بيد الطبيب، ومع قائمة تحققٍ سريري تظهر قبل الوصف. */

interface PrescriptionModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** اختياري (من عمل الوكيل المساعد): وصفة من مساحة الزيارة قد لا تملك ملفًّا
   * مرتبطًا بعد — فتُكتب بيانات المريض نصًّا حتى يُربط. */
  patientId?: number | null;
  patientName: string;
  patientPhone?: string | null;
  medicalAlert?: string | null;
  defaultDiagnosis?: string;
  defaultDoctorName?: string;
}

export function PrescriptionModal({
  isOpen,
  onClose,
  patientId,
  patientName,
  patientPhone,
  medicalAlert,
  defaultDiagnosis = "",
  defaultDoctorName = "",
}: PrescriptionModalProps) {
  const clinicName = useClinicName();
  const [diagnosis, setDiagnosis] = useState(defaultDiagnosis);
  const [doctorName, setDoctorName] = useState(defaultDoctorName);
  const [notes, setNotes] = useState("");
  const [lang, setLang] = useState<InstructionsLang>("both");
  /* تبدأ فارغة: القالب اختيارٌ صريح لا حالة افتراضية (P0.10) — فتحُ المودال
     محمّلًا بمضادٍ حيوي جعل ضغطة طباعةٍ واحدة وصفةً لم تُراجَع. */
  const [items, setItems] = useState<RxItem[]>([]);
  /* قائمة التحقق السريري للقالب المطبّق (مراجعة الجولة الثانية): تُعرض للطبيب
   * قبل الوصف — القالب عبّأ الحالة فقط، والدواء قراره هو. */
  const [appliedChecklist, setAppliedChecklist] = useState<string[] | null>(null);
  /* الوصفة وثيقة تُحفى كُما طُبِعت (من مستودع الوكيل الآخر): الحفظ قبل الطباعة
     يبقي في السجل ما صُرِف فعلاً من دواء، والاقتراحات مما سبق وصفه للمريض
     نفسه تقلّل النقر — ولا تُفرض. */
  const [preserving, setPreserving] = useState(false);
  const [preserveError, setPreserveError] = useState<string | null>(null);
  /* مراجعة الجولة الثانية (Blocker B) — الخادم هو المرجع: */
  /* عرض تحذيرات الخادم غير الحرجة قبل الحفظ، مع رمز الإقرار المرتبط بالوصفة. */
  const [safetyPreview, setSafetyPreview] = useState<{
    warnings: DrugSafetyAlert[];
    token: string;
  } | null>(null);
  /* منعٌ حرج من الخادم (409): توقّف تام — لا رسمية ولا مسودة تلقائية. */
  const [criticalBlock, setCriticalBlock] = useState<{
    message: string;
    alerts: DrugSafetyAlert[];
  } | null>(null);
  /* رسالة إبطال الإقرار (تغيّرت الأدوية بعد الإقرار). */
  const [ackInvalidMessage, setAckInvalidMessage] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<{
    name: string; dose: string; frequency: string; duration: string;
    timesPrescribed: number; lastPrescribedAt: string;
  }[]>([]);

  /* الاقتراحات تُجلب مرة عند الفتح — من وصفاته الفاعلة لا المبطلة، للطبيب
     والمدير وحدهما؛ وغيرهم لا يقترح ولا يصير الفشل صامتًا. */
  useEffect(() => {
    if (!isOpen || !patientId) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/patients/${patientId}/prescriptions`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json();
        if (!cancelled) setSuggestions(payload?.suggestions ?? []);
      } catch { /* الاقتراحات تحسينٌ لا شرط: فشلها لا يعطّل الوصفة */ }
    })();
    return () => { cancelled = true; };
  }, [isOpen, patientId]);

  const safetyAlerts = useMemo(() => {
    return evaluatePrescriptionSafety(items, medicalAlert);
  }, [items, medicalAlert]);

  const hasCriticalAlert = safetyAlerts.some((a) => a.severity === "critical");

  if (!isOpen) return null;

  const applyTemplate = (index: number) => {
    /* قوالب الإجراءات والتشخيصات (مراجعة الجولة الثانية): تُعبّئ التشخيص
     * والملاحظات الإجرائية فقط — لا دواء ولا جرعة. الأدوية يكتبها الطبيب
     * بنفسه (أو يختارها مما وُصف له سابقًا)، ومع القائمة قائمة تحقق سريري. */
    const t = PROCEDURE_TEMPLATES[index];
    if (t) {
      setDiagnosis(t.diagnosis);
      setNotes(t.notes);
      setAppliedChecklist(t.contextChecklist);
    }
  };

  const addItem = () => {
    setItems((prev) => [
      ...prev,
      {
        name: "",
        dose: "",
        form: "Tablets",
        frequency: "",
        duration: "",
        instructions: "",
        instructionsEn: "",
      },
    ]);
  };

  const updateItem = (index: number, field: keyof RxItem, value: string) => {
    setItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const removeItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const buildPrintUrl = () => {
    /* معاينة مسودة معلنة (P0.9): تُطبع بعلامة «مسودة غير معتمدة» وباسم الطبيب
     * من الجلسة — لا من الرابط. الوثيقة الرسمية وحدها (rx) تُطبع كوصفة صرف. */
    const params = new URLSearchParams();
    params.set("draft", "1");
    if (diagnosis) params.set("diagnosis", diagnosis);
    if (notes) params.set("notes", notes);
    params.set("lang", lang);
    if (items.length > 0) {
      params.set("items", JSON.stringify(items));
    }
    return `/print/prescription/${patientId}?${params.toString()}`;
  };

  /** إرسال الوصفة إلى الخادم — برمز إقرارٍ إن كان الطبيب أقرّ التحذيرات. */
  const submitToServer = async (acknowledgedSafetyToken?: string) => {
    const response = await fetch("/api/prescriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        patientId,
        diagnosis,
        notes,
        instructionsLang: lang,
        items,
        ...(acknowledgedSafetyToken ? { acknowledgedSafetyToken } : {}),
      }),
    });
    const payload = await response.json().catch(() => null);
    return interpretPrescriptionSaveResponse(response.status, payload);
  };

  const openOfficialPrint = (prescriptionId: number) => {
    /* الوثيقة الرسمية تُطبع من المحفوظ: اسم الطبيب من السجل (createdBy)
     * لا من الرابط — فلا وثيقة رسمية تحمل اسمًا مزوّرًا (P0.9). */
    const params = new URLSearchParams();
    params.set("rx", String(prescriptionId));
    window.open(`/print/prescription/${patientId}?${params.toString()}`, "_blank");
  };

  const handlePrint = async () => {
    /* الوصفة وثيقة: تُحفَظ أوّلًا ثم تُطبَع من المحفوظ. والخادم هو المرجع
     * النهائي للسلامة (مراجعة الجولة الثانية — Blocker B):
     * - تعارضٌ حرج (409) ⇒ توقّف تام: لا طباعة رسمية ولا سقوط تلقائي إلى
     *   مسودة؛ يُعرض سبب المنع، والمسودة زرّ منفصل صريح فقط.
     * - تحذيرات غير حرجة ⇒ عرضٌ وإقرارٌ صريح قبل الحفظ والطباعة الرسمية.
     * - فشلٌ غير حرج (شبكة/500) لا يحرم المريض وصفته: مسودة معلنة مع سببٍ ظاهر. */
    setCriticalBlock(null);
    setSafetyPreview(null);
    setAckInvalidMessage(null);
    if (patientId && items.some((item) => /[A-Za-z]/.test(item.name))) {
      setPreserving(true);
      setPreserveError(null);
      try {
        const outcome = await submitToServer();
        if (outcome.kind === "officialPrint") {
          openOfficialPrint(outcome.prescriptionId);
          return;
        }
        if (outcome.kind === "criticalBlock") {
          /* منعٌ حرج: توقّف تام — لا window.open إطلاقًا من هذا المسار. */
          setCriticalBlock({ message: outcome.message, alerts: outcome.safetyAlerts });
          return;
        }
        if (outcome.kind === "awaitAcknowledgement") {
          /* لا حفظ ولا طباعة بعد: عرض التحذيرات على الطبيب أولاً. */
          setSafetyPreview({ warnings: outcome.safetyWarnings, token: outcome.acknowledgementToken });
          return;
        }
        if (outcome.kind === "acknowledgementRejected") {
          setAckInvalidMessage(outcome.message);
          return;
        }
        setPreserveError(outcome.reason);
      } catch {
        setPreserveError("تعذّر حفظ الوصفة كوثيقة — ستُطبع بالطريقة السريعة.");
      } finally {
        setPreserving(false);
      }
    }
    const url = buildPrintUrl();
    window.open(url, "_blank");
  };

  /** إقرار الطبيب قراءة التحذيرات غير الحرجة ثم الحفظ والطباعة الرسمية —
   * يُعاد إرسال نفس الوصفة مع رمز الإقرار؛ فإن تغيّرت الأدوية بعد الإقرار
   * رفضه الخادم وأُعيد العرض. */
  const handleAcknowledgeAndPrint = async () => {
    if (!safetyPreview?.token || !patientId) return;
    setPreserving(true);
    setAckInvalidMessage(null);
    try {
      const outcome = await submitToServer(safetyPreview.token);
      if (outcome.kind === "officialPrint") {
        setSafetyPreview(null);
        openOfficialPrint(outcome.prescriptionId);
        return;
      }
      if (outcome.kind === "criticalBlock") {
        /* تحوّل الحالة إلى حرج بين المعاينة والإقرار (ملف المريض تغيّر): توقّف تام. */
        setSafetyPreview(null);
        setCriticalBlock({ message: outcome.message, alerts: outcome.safetyAlerts });
        return;
      }
      if (outcome.kind === "acknowledgementRejected") {
        setSafetyPreview(null);
        setAckInvalidMessage(outcome.message);
        return;
      }
      if (outcome.kind === "awaitAcknowledgement") {
        /* رجع الخادم بعرض تحذيرات جديدة/محدثة بعد الإقرار — يُعرض من جديد. */
        setSafetyPreview({ warnings: outcome.safetyWarnings, token: outcome.acknowledgementToken });
        return;
      }
      setSafetyPreview(null);
      setPreserveError(outcome.reason);
      const url = buildPrintUrl();
      window.open(url, "_blank");
    } catch {
      setAckInvalidMessage("تعذّر الاتصال بالخادم — حاول الإقرار من جديد.");
    } finally {
      setPreserving(false);
    }
  };

  /** تعليمات دواء واحد بلغة الروشتة المختارة. */
  const instructionsLines = (item: RxItem): string[] => {
    const ar = item.instructions.trim();
    const en = item.instructionsEn.trim();
    if (lang === "ar") return ar ? [ar] : [];
    if (lang === "en") return en ? [en] : [];
    return [ar, en].filter(Boolean);
  };

  const handleWhatsApp = () => {
    if (!patientPhone) return;
    const phone = toWhatsAppNumber(patientPhone);
    if (!phone) return;

    const label = (ar: string, en: string) => lang === "ar" ? ar : lang === "en" ? en : `${ar} / ${en}`;
    let text = `*${label("وصفة طبية", "Prescription")} — ${clinicName}*\n\n`;
    text += `${label("المريض", "Patient")}: ${patientName}\n`;
    if (diagnosis) text += `${label("التشخيص", "Diagnosis")}: ${diagnosis}\n`;
    if (medicalAlert) text += `${label("تنبيه طبي", "Medical alert")}: ${medicalAlert}\n`;
    text += `\n*${label("الأدوية", "Medications")}:*\n`;

    items.forEach((item, idx) => {
      text += `${idx + 1}. *${item.name}* ${item.dose ? `(${item.dose})` : ""}\n`;
      text += `   - ${[item.form, item.frequency, item.duration].filter(Boolean).join(" · ")}\n`;
      for (const line of instructionsLines(item)) {
        text += `   - ${line}\n`;
      }
    });

    if (notes) text += `\n*${label("تعليمات إضافية", "Additional instructions")}:* ${notes}\n`;
    text += `\n${label("مع تمنياتنا لكم بالشفاء العاجل", "Wishing you a speedy recovery")} 🦷`;

    const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
    window.open(waUrl, "_blank");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div
        className="fixed inset-0"
        onClick={onClose}
      />
      <div className="relative z-10 flex flex-col max-h-[90vh] w-full max-w-3xl rounded-3xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
        {/* رأس النافذة */}
        <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/80 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-navy text-white text-lg font-serif font-black shadow-xs">
              ℞
            </div>
            <div>
              <h2 className="text-base font-black text-navy-900">
                إصدار وصفة طبية (روشتة)
              </h2>
              <p className="text-xs text-slate-500 font-medium">
                المريض: <strong className="text-navy-800">{patientName}</strong>
                 · <span dir="ltr">Drug names in English</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-slate-400 hover:bg-slate-200 hover:text-slate-700 transition-colors"
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>

        {/* محتوى النموذج */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* تنبيه الحساسية إن وُجد */}
          {medicalAlert && (
            <div className="flex items-center gap-2.5 rounded-2xl border border-red-200 bg-red-50/80 p-3.5 text-xs text-red-900">
              <span className="text-base">⚠️</span>
              <div>
                <strong className="font-bold">تنبيه طبي وحساسية للمريض: </strong>
                <span>{medicalAlert}</span>
              </div>
            </div>
          )}

          {/* فحص الأمان الدوائي والتعارضات السريرية */}
          {safetyAlerts.length > 0 && (
            <div className="space-y-2.5 rounded-2xl border border-red-300 bg-red-50/90 p-4 shadow-xs">
              <div className="flex items-center justify-between text-xs font-black text-red-900">
                <div className="flex items-center gap-2">
                  <span className="text-base">🛡️</span>
                  <span>فحص الأمان الدوائي — تم رصد ({safetyAlerts.length}) تعارض سريري محتمل:</span>
                </div>
                {hasCriticalAlert && (
                  <span className="rounded-full bg-red-600 px-2.5 py-0.5 text-[10px] font-extrabold text-white">
                    خطر حرج
                  </span>
                )}
              </div>
              <div className="space-y-2">
                {safetyAlerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={`rounded-xl border p-3 text-xs ${
                      alert.severity === "critical"
                        ? "border-red-400 bg-white text-red-950"
                        : "border-amber-400 bg-white text-amber-950"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1.5 font-bold">
                        <span>{alert.severity === "critical" ? "⛔" : "⚠️"}</span>
                        <span>{alert.title}</span>
                      </div>
                      <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-mono font-bold text-slate-700">
                        {alert.medicationName}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-700">
                      {alert.message}
                    </p>
                    {alert.suggestedAlternative && (
                      <div className="mt-2 rounded-lg bg-emerald-50 border border-emerald-200 p-2 text-[11px] text-emerald-900 font-semibold">
                        💡 {alert.suggestedAlternative}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* قوالب الإجراءات والتشخيصات — لا أدوية (مراجعة الجولة الثانية):
           * تُعبّئ نوع الحالة والتشخيص والملاحظات الإجرائية فقط؛ اختيار الدواء
           * والجرعة يبقى بيد الطبيب، وتظهر معها قائمة تحقق سريري. */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-2">
              ⚡ قوالب إجراءات وتشخيصات (تُعبّئ الحالة — لا تحتوي أدوية):
            </label>
            <div className="flex flex-wrap gap-2">
              {PROCEDURE_TEMPLATES.map((tmpl, idx) => (
                <button
                  key={idx}
                  type="button"
                  title={`${tmpl.diagnosis} — يُعبّئ التشخيص والعناية الإجرائية؛ الأدوية والجرعات يحددها الطبيب`}
                  onClick={() => applyTemplate(idx)}
                  className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-brand-navy hover:bg-navy-50 hover:text-navy-900 transition-all"
                >
                  {tmpl.title}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] font-semibold text-slate-400">
              القالب لا يختار دواءً ولا جرعة — التقييم الدوائي والأدوية قرارٌ سريري يُكتب يدويًا أو يُختار مما وُصف له سابقًا.
            </p>
          </div>

          {/* قائمة التحقق السريري للقالب المطبّق: «لا تنبيه مسجل ≠ مريض سليم». */}
          {appliedChecklist && (
            <div className="rounded-2xl border border-amber-300 bg-amber-50/80 p-4 text-xs text-amber-950">
              <div className="flex items-center gap-2 font-black">
                <span className="text-base">🩺</span>
                <span>قبل وصف أي دواء لهذه الحالة — تحقّق سريريًا من:</span>
              </div>
              <ul className="mt-2 space-y-1.5 pr-4">
                {appliedChecklist.map((point) => (
                  <li key={point} className="list-disc text-[11px] leading-relaxed">{point}</li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] font-bold text-amber-800">
                غياب التنبيه المسجل في الملف لا يعني مريضًا سليمًا — تحقّق وسجّل ما يلزم.
              </p>
            </div>
          )}

          {/*
            * مما سبق وصفه لهذا المريض (من مستودع الوكيل الآخر): رقائقٌ تُقلّل
            * النقر ولا تُفرض — التكرار الإداري المريح ليس قرارًا سريريًّا.
            */}
          {suggestions.length > 0 ? (
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-2">
                ↩️ وُصف له سابقًا (اضغط لإضافته إلى القائمة):
              </label>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion.name}
                    type="button"
                    title={`وُصف ${suggestion.timesPrescribed} مرة — آخرها ${new Date(suggestion.lastPrescribedAt).toLocaleDateString("ar")}`}
                    onClick={() => setItems((prev) => [
                      ...prev,
                      {
                        name: suggestion.name,
                        dose: suggestion.dose,
                        form: "",
                        frequency: suggestion.frequency,
                        duration: suggestion.duration,
                        instructions: "",
                        instructionsEn: "",
                      },
                    ])}
                    className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-800 hover:border-sky-400 hover:bg-sky-100 transition-all"
                    dir="ltr"
                  >
                    {suggestion.name}
                    {suggestion.timesPrescribed > 1 ? ` ×${suggestion.timesPrescribed}` : ""}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {preserveError ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
              {preserveError}
            </p>
          ) : null}

          {/* منعٌ حرج من الخادم (409): توقّف تام — لا طباعة رسمية ولا مسودة
              تلقائية؛ سبب المنع ظاهر، والمسودة زرّ منفصل صريح (مراجعة الجولة الثانية). */}
          {criticalBlock && (
            <div className="space-y-2.5 rounded-2xl border-2 border-red-500 bg-red-50 p-4 shadow-xs">
              <div className="flex items-center gap-2 text-xs font-black text-red-900">
                <span className="text-base">⛔</span>
                <span>منع حفظ وطباعة رسمية — تعارض دوائي حرج وفق ملف المريض:</span>
              </div>
              <p className="text-[11px] font-bold leading-relaxed text-red-800">{criticalBlock.message}</p>
              <div className="space-y-2">
                {criticalBlock.alerts.map((alert) => (
                  <div key={alert.id} className="rounded-xl border border-red-300 bg-white p-3 text-xs text-red-950">
                    <div className="flex items-center justify-between gap-2 font-bold">
                      <span>{alert.title}</span>
                      <span className="rounded-md bg-red-100 px-2 py-0.5 text-[10px] font-mono text-red-800">{alert.medicationName}</span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-700">{alert.message}</p>
                  </div>
                ))}
              </div>
              <p className="text-[11px] font-bold text-red-700">
                صحّح التعارض (بديلٌ يقرره الطبيب أو تحديث الملف) ثم أعد المحاولة — لا تُصرف وصفة رسمية بهذا التعارض.
              </p>
              <button
                type="button"
                onClick={() => window.open(buildPrintUrl(), "_blank")}
                className="rounded-xl border border-red-300 bg-white px-4 py-2 text-xs font-bold text-red-700 hover:bg-red-100 transition-colors"
              >
                عرض مسودة غير معتمدة (لا تُصرف كوصفة)
              </button>
            </div>
          )}

          {/* عرض تحذيرات الخادم غير الحرجة قبل الحفظ: لا طباعة رسمية إلا بعد
              إقرار الطبيب الصريح — والإقرار مرتبط بالوصفة نفسها (رمز خادمي). */}
          {safetyPreview && (
            <div className="space-y-2.5 rounded-2xl border-2 border-amber-400 bg-amber-50/90 p-4 shadow-xs">
              <div className="flex items-center gap-2 text-xs font-black text-amber-950">
                <span className="text-base">⚠️</span>
                <span>تحذيرات سلامة دوائية من الخادم — إقرارك مطلوب قبل الحفظ والطباعة الرسمية:</span>
              </div>
              <div className="space-y-2">
                {safetyPreview.warnings.map((alert) => (
                  <div key={alert.id} className="rounded-xl border border-amber-300 bg-white p-3 text-xs text-amber-950">
                    <div className="flex items-center justify-between gap-2 font-bold">
                      <span>{alert.title}</span>
                      <span className="rounded-md bg-amber-100 px-2 py-0.5 text-[10px] font-mono text-amber-900">{alert.medicationName}</span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-700">{alert.message}</p>
                    {alert.suggestedAlternative && (
                      <p className="mt-1.5 text-[11px] font-semibold text-emerald-800">💡 {alert.suggestedAlternative}</p>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void handleAcknowledgeAndPrint()}
                  disabled={preserving}
                  className="rounded-xl bg-amber-600 px-4 py-2 text-xs font-black text-white shadow-xs hover:bg-amber-700 transition-all disabled:opacity-50"
                >
                  {preserving ? "جارٍ الحفظ بعد الإقرار…" : "أقرّ قراءة التحذيرات — حفظ الوصفة وطباعتها رسميًا"}
                </button>
                <button
                  type="button"
                  onClick={() => setSafetyPreview(null)}
                  className="rounded-xl border border-amber-300 bg-white px-4 py-2 text-xs font-bold text-amber-800 hover:bg-amber-100"
                >
                  رجوع للتعديل (تغيير الأدوية يُبطل هذا الإقرار)
                </button>
              </div>
              <p className="text-[11px] font-semibold text-amber-800">
                الإقرار مرتبط بهذه الأدوية تحديدًا: أي تغيير دوائي بعد الإقرار يرفضه الخادم ويعيد العرض.
              </p>
            </div>
          )}

          {ackInvalidMessage ? (
            <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-bold text-red-800">
              {ackInvalidMessage}
            </p>
          ) : null}

          {/* لغة التعليمات */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-2">
              🌐 لغة تعليمات المريض على الروشتة:
            </label>
            <div className="inline-flex gap-1 rounded-xl bg-slate-100 p-1">
              {LANG_LABELS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setLang(key)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-black transition-colors ${
                    lang === key ? "bg-white text-navy-900 shadow-xs" : "text-slate-500 hover:text-navy-800"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] font-semibold text-slate-400">
              أسماء الأدوية والجرعات تُطبع بالإنجليزية دائمًا — التعليمات للمريض بلغته.
            </p>
          </div>

          {/* تفاصيل الطبيب والتشخيص */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                التشخيص الطبي
              </label>
              <input
                type="text"
                value={diagnosis}
                onChange={(e) => setDiagnosis(e.target.value)}
                placeholder="مثال: Acute Pulpitis / Post-Extraction"
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-xs focus:border-brand-navy focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                اسم الطبيب المعالج
              </label>
              <input
                type="text"
                value={doctorName}
                onChange={(e) => setDoctorName(e.target.value)}
                placeholder="د. طبيب الأسنان"
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2 text-xs focus:border-brand-navy focus:outline-none"
              />
            </div>
          </div>

          {/* قائمة الأدوية */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold text-slate-700">
                💊 قائمة الأدوية والجرعات ({items.length}) — <span dir="ltr" className="font-extrabold">English</span>:
              </label>
              <button
                type="button"
                onClick={addItem}
                className="flex items-center gap-1 text-xs font-bold text-brand-navy hover:text-navy-700"
              >
                <Icon name="plus" className="h-3.5 w-3.5" />
                <span>إضافة دواء جديد</span>
              </button>
            </div>

            <div className="space-y-3">
              {items.map((item, idx) => {
                const itemAlert = safetyAlerts.find(
                  (a) => a.medicationName.trim().toLowerCase() === item.name.trim().toLowerCase()
                );
                return (
                  <div
                    key={idx}
                    className={`rounded-2xl border p-3.5 space-y-2.5 transition-all ${
                      itemAlert?.severity === "critical"
                        ? "border-red-400 bg-red-50/40 ring-1 ring-red-400/50"
                        : itemAlert?.severity === "warning"
                        ? "border-amber-400 bg-amber-50/40 ring-1 ring-amber-400/50"
                        : "border-slate-200 bg-slate-50/60"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-bold text-slate-700">
                        {idx + 1}
                      </span>
                      <input
                        type="text"
                        value={item.name}
                        onChange={(e) => updateItem(idx, "name", e.target.value)}
                        placeholder="Drug name (e.g. Augmentin / Brufen)"
                        dir="ltr"
                        className="flex-1 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-navy-900 focus:border-brand-navy focus:outline-none"
                      />
                      <input
                        type="text"
                        value={item.dose}
                        onChange={(e) => updateItem(idx, "dose", e.target.value)}
                        placeholder="Dose (1g / 500mg)"
                        dir="ltr"
                        className="w-28 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs focus:border-brand-navy focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => removeItem(idx)}
                        className="text-slate-400 hover:text-red-600 p-1"
                        title="حذف الدواء"
                      >
                        <Icon name="trash" className="h-4 w-4" />
                      </button>
                    </div>

                    {itemAlert && (
                      <div className="flex items-center gap-1.5 text-[11px] font-bold text-red-700 bg-red-100/70 px-2.5 py-1 rounded-lg">
                        <span>{itemAlert.severity === "critical" ? "⛔" : "⚠️"}</span>
                        <span>{itemAlert.title}: {itemAlert.message}</span>
                      </div>
                    )}

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs" dir="ltr">
                    <input
                      type="text"
                      value={item.form}
                      onChange={(e) => updateItem(idx, "form", e.target.value)}
                      placeholder="Form (Tablets / Syrup)"
                      className="rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 focus:border-brand-navy focus:outline-none"
                    />
                    <input
                      type="text"
                      value={item.frequency}
                      onChange={(e) => updateItem(idx, "frequency", e.target.value)}
                      placeholder="Frequency (every 8 hours)"
                      className="rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 focus:border-brand-navy focus:outline-none"
                    />
                    <input
                      type="text"
                      value={item.duration}
                      onChange={(e) => updateItem(idx, "duration", e.target.value)}
                      placeholder="Duration (5 days)"
                      className="rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 focus:border-brand-navy focus:outline-none"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    <input
                      type="text"
                      value={item.instructions}
                      onChange={(e) => updateItem(idx, "instructions", e.target.value)}
                      placeholder="التعليمات بالعربية (بعد الأكل…)"
                      className="rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 focus:border-brand-navy focus:outline-none"
                    />
                    <input
                      type="text"
                      value={item.instructionsEn}
                      onChange={(e) => updateItem(idx, "instructionsEn", e.target.value)}
                      placeholder="Instructions in English (after meals…)"
                      dir="ltr"
                      className="rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 focus:border-brand-navy focus:outline-none"
                    />
                  </div>
                </div>
              );
            })}
          </div>
          </div>

          {/* ملاحظات وإرشادات إضافية */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">
              إرشادات وتعليمات خاصة للمريض
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="مثال: الامتناع عن المشروبات الساخنة لمدة 24 ساعة، وضع كمادات باردة..."
              className="w-full rounded-xl border border-slate-300 p-3 text-xs focus:border-brand-navy focus:outline-none"
            />
          </div>
        </div>

        {/* تذييل النافذة والإجراءات */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-6 py-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100"
            >
              إلغاء
            </button>
            {hasCriticalAlert && (
              <div className="flex items-center gap-1.5 rounded-xl border border-red-300 bg-red-100 px-3 py-1.5 text-xs font-black text-red-700 animate-pulse">
                <span>⛔</span>
                <span>تحذير: توجد أدوية تتعارض مع حالة المريض!</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {patientPhone && (
              <button
                type="button"
                onClick={handleWhatsApp}
                className="flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-xs font-bold text-emerald-800 hover:bg-emerald-100 transition-colors"
              >
                <span>💬</span>
                <span>إرسال واتساب</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => void handlePrint()}
              disabled={preserving}
              className="flex items-center gap-1.5 rounded-xl bg-brand-navy px-5 py-2 text-xs font-bold text-white shadow-xs hover:bg-navy-900 transition-all disabled:opacity-50"
            >
              <Icon name="print" className="h-4 w-4" />
              <span>{preserving ? "جارٍ حفظ الوصفة…" : "طباعة الروشتة (A5)"}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
