"use client";

import { useState } from "react";
import { Icon } from "./Icon";
import { toWhatsAppNumber } from "@/lib/reminders";

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

const COMMON_TEMPLATES: {
  title: string;
  diagnosis: string;
  items: RxItem[];
}[] = [
  {
    title: "خلع جراحي / التهاب متوسط إلى شديد",
    diagnosis: "Surgical extraction / Acute alveolar infection",
    items: [
      {
        name: "Amoxicillin + Clavulanate (Augmentin)",
        dose: "1g",
        form: "Tablets",
        frequency: "1 tablet every 12 hours",
        duration: "5-7 days",
        instructions: "بعد الطعام مباشرة مع كمية وافرة من الماء",
        instructionsEn: "Take right after food with plenty of water",
      },
      {
        name: "Ibuprofen (Brufen)",
        dose: "400mg",
        form: "Tablets",
        frequency: "1 tablet every 8 hours",
        duration: "3 days / as needed",
        instructions: "بعد الأكل لتسكين الألم وتقليل التورم",
        instructionsEn: "After meals for pain and swelling relief",
      },
      {
        name: "Chlorhexidine Mouthwash 0.12%",
        dose: "15ml",
        form: "Mouthwash",
        frequency: "Twice daily",
        duration: "7 days",
        instructions: "مضمضة بعد 24 ساعة من الجراحة، لا تأكل أو تشرب بعدها لـ 30 دقيقة",
        instructionsEn: "Rinse starting 24h after surgery; no eating or drinking for 30 minutes after",
      },
    ],
  },
  {
    title: "علاج عصب / خراج سني مختلط",
    diagnosis: "Acute periapical abscess / Endodontic flare-up",
    items: [
      {
        name: "Amoxicillin",
        dose: "500mg",
        form: "Capsules",
        frequency: "1 capsule every 8 hours",
        duration: "5 days",
        instructions: "بانتظام حتى انتهاء الجرعة كاملة",
        instructionsEn: "Regularly until the full course is finished",
      },
      {
        name: "Metronidazole (Flagyl)",
        dose: "500mg",
        form: "Tablets",
        frequency: "1 tablet every 8 hours",
        duration: "5 days",
        instructions: "مع الأكل — لا كحول إطلاقًا خلال الدورة",
        instructionsEn: "Take with food; strictly no alcohol during the course",
      },
      {
        name: "Paracetamol + Caffeine (Panadol Extra)",
        dose: "500mg",
        form: "Tablets",
        frequency: "2 tablets every 6-8 hours",
        duration: "As needed",
        instructions: "لتسكين الألم والصداع",
        instructionsEn: "For pain and headache relief",
      },
    ],
  },
  {
    title: "تسكين ألم الأسنان المعتدل",
    diagnosis: "Moderate dental pain / Post-operative pain",
    items: [
      {
        name: "Diclofenac Potassium (Cataflam)",
        dose: "50mg",
        form: "Tablets",
        frequency: "1 tablet every 8 hours",
        duration: "3 days / as needed",
        instructions: "سريع المفعول، يؤخذ بعد الأكل مباشرة",
        instructionsEn: "Fast-acting; take immediately after meals",
      },
    ],
  },
  {
    title: "تقرحات فم والتهاب لثة حاد",
    diagnosis: "Aphthous stomatitis / Acute gingivitis",
    items: [
      {
        name: "Triamcinolone in Orabase (Kenalog)",
        dose: "Thin layer",
        form: "Oral ointment",
        frequency: "2-3 times daily",
        duration: "5 days",
        instructions: "يوضع على التقرحات قبل النوم وبعد الوجبات",
        instructionsEn: "Apply on ulcers after meals and before bedtime",
      },
      {
        name: "Chlorhexidine + Benzydamine Mouthwash",
        dose: "15ml",
        form: "Mouthwash",
        frequency: "3 times daily",
        duration: "7 days",
        instructions: "مضمضة لمدة دقيقة لتهدئة الأنسجة",
        instructionsEn: "Rinse for one minute to soothe the tissues",
      },
    ],
  },
  {
    title: "وصفة أطفال",
    diagnosis: "Pediatric dental infection & pain",
    items: [
      {
        name: "Amoxicillin Syrup",
        dose: "250mg / 5ml",
        form: "Suspension",
        frequency: "By weight, every 8 hours",
        duration: "5 days",
        instructions: "رجّ العبوة جيدًا قبل كل استخدام",
        instructionsEn: "Shake the bottle well before each use",
      },
      {
        name: "Paracetamol Syrup (Adol / Panadol)",
        dose: "120mg / 5ml",
        form: "Suspension",
        frequency: "Every 6 hours as needed",
        duration: "3 days",
        instructions: "حسب وزن وعمر الطفل",
        instructionsEn: "Dose by the child's weight and age",
      },
    ],
  },
  {
    title: "زراعة أسنان / وقاية جراحية",
    diagnosis: "Dental implant placement / Surgical prophylaxis",
    items: [
      {
        name: "Amoxicillin + Clavulanate (Augmentin)",
        dose: "1g",
        form: "Tablets",
        frequency: "1 tablet every 12 hours",
        duration: "7 days",
        instructions: "تبدأ الجرعة قبل الجراحة بساعة وتستمر بانتظام بعد الأكل",
        instructionsEn: "Take starting 1 hour before surgery, then with meals regularly",
      },
      {
        name: "Dexketoprofen (Keral)",
        dose: "25mg",
        form: "Tablets",
        frequency: "1 tablet every 8 hours",
        duration: "4 days / as needed",
        instructions: "مسكن ومضاد التهاب سريع لتخفيف وذمة ما بعد الزرع",
        instructionsEn: "Rapid analgesic and anti-inflammatory to minimize post-op swelling",
      },
      {
        name: "Chlorhexidine Mouthwash 0.12%",
        dose: "15ml",
        form: "Mouthwash",
        frequency: "Twice daily",
        duration: "10 days",
        instructions: "مضمضة خفيفة دون بصق عنيف، تبدأ بعد 24 ساعة من الجراحة",
        instructionsEn: "Gentle oral rinse, start 24 hours after surgery",
      },
    ],
  },
  {
    title: "تبييض وحساسية عاجية مفرطة",
    diagnosis: "Post-bleaching sensitivity / Dentin hypersensitivity",
    items: [
      {
        name: "Potassium Nitrate + Sodium Fluoride Paste (Sensodyne Rapid Relief)",
        dose: "Pea-sized",
        form: "Toothpaste",
        frequency: "Twice daily",
        duration: "14 days",
        instructions: "يُدهن مباشرة على الأسنان الحساسة ويترك دقيقة قبل التفريش",
        instructionsEn: "Apply directly to sensitive teeth and leave for 1 minute before brushing",
      },
      {
        name: "Ibuprofen (Brufen)",
        dose: "400mg",
        form: "Tablets",
        frequency: "1 tablet as needed",
        duration: "1-2 days",
        instructions: "لتسكين نوبات الألم الحادة بعد التبييض عند الضرورة",
        instructionsEn: "For sharp sensitivity spikes after in-office bleaching",
      },
    ],
  },
  {
    title: "التهاب دواعم السن الحاد واللثة",
    diagnosis: "Acute periodontitis / Subgingival scaling post-op",
    items: [
      {
        name: "Spiramycin + Metronidazole (Rodogyl)",
        dose: "1 tablet",
        form: "Tablets",
        frequency: "1 tablet every 8 hours",
        duration: "6 days",
        instructions: "فعال جداً في مكافحة بكتيريا الجيوب اللثوية العميقة، مع الوجبات",
        instructionsEn: "Highly effective for deep periodontal pocket pathogens; take with food",
      },
      {
        name: "Chlorhexidine Gel 1%",
        dose: "Small amount",
        form: "Oral Gel",
        frequency: "Twice daily",
        duration: "7 days",
        instructions: "تدليك اللثة الملتهبة بلطف بعد تنظيف الأسنان بالفرشاة",
        instructionsEn: "Gently massage onto inflamed gingival margins after brushing",
      },
    ],
  },
];

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
  const [diagnosis, setDiagnosis] = useState(defaultDiagnosis);
  const [doctorName, setDoctorName] = useState(defaultDoctorName);
  const [notes, setNotes] = useState("");
  const [lang, setLang] = useState<InstructionsLang>("both");
  const [items, setItems] = useState<RxItem[]>(COMMON_TEMPLATES[0].items);

  if (!isOpen) return null;

  const applyTemplate = (index: number) => {
    const t = COMMON_TEMPLATES[index];
    if (t) {
      setDiagnosis(t.diagnosis);
      setItems(JSON.parse(JSON.stringify(t.items)));
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
    const params = new URLSearchParams();
    if (diagnosis) params.set("diagnosis", diagnosis);
    if (doctorName) params.set("doctorName", doctorName);
    if (notes) params.set("notes", notes);
    params.set("lang", lang);
    if (items.length > 0) {
      params.set("items", JSON.stringify(items));
    }
    return `/print/prescription/${patientId}?${params.toString()}`;
  };

  const handlePrint = () => {
    const url = buildPrintUrl();
    window.open(url, "_blank");
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

    let text = `*Prescription — Aqlan Dental Center*\n\n`;
    text += `Patient: ${patientName}\n`;
    if (diagnosis) text += `Diagnosis: ${diagnosis}\n`;
    if (medicalAlert) text += `Medical alert: ${medicalAlert}\n`;
    text += `\n*Medications:*\n`;

    items.forEach((item, idx) => {
      text += `${idx + 1}. *${item.name}* ${item.dose ? `(${item.dose})` : ""}\n`;
      text += `   - ${[item.form, item.frequency, item.duration].filter(Boolean).join(" · ")}\n`;
      for (const line of instructionsLines(item)) {
        text += `   - ${line}\n`;
      }
    });

    if (notes) text += `\n*Additional instructions:* ${notes}\n`;
    text += `\nمع تمنياتنا لكم بالشفاء العاجل 🦷`;

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

          {/* قوالب سريعة شائعة */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-2">
              ⚡ قوالب وصفات طبية سنية جاهزة:
            </label>
            <div className="flex flex-wrap gap-2">
              {COMMON_TEMPLATES.map((tmpl, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => applyTemplate(idx)}
                  className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-brand-navy hover:bg-navy-50 hover:text-navy-900 transition-all"
                >
                  {tmpl.title}
                </button>
              ))}
            </div>
          </div>

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
              {items.map((item, idx) => (
                <div
                  key={idx}
                  className="rounded-2xl border border-slate-200 bg-slate-50/60 p-3.5 space-y-2.5"
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
              ))}
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
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100"
          >
            إلغاء
          </button>

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
              onClick={handlePrint}
              className="flex items-center gap-1.5 rounded-xl bg-brand-navy px-5 py-2 text-xs font-bold text-white shadow-xs hover:bg-navy-900 transition-all"
            >
              <Icon name="print" className="h-4 w-4" />
              <span>طباعة الروشتة (A5)</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
