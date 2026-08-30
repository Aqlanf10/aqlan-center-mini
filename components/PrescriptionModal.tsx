"use client";

import { useState } from "react";
import { Icon } from "./Icon";
import { toWhatsAppNumber } from "@/lib/reminders";

export interface RxItem {
  name: string;
  form: string;
  dose: string;
  frequency: string;
  duration: string;
  instructions: string;
}

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
        form: "أقراص",
        dose: "1g",
        frequency: "قرص كل 12 ساعة",
        duration: "5 إلى 7 أيام",
        instructions: "بعد الطعام مباشرة مع كمية وافرة من الماء",
      },
      {
        name: "Ibuprofen (Brufen)",
        form: "أقراص",
        dose: "400mg",
        frequency: "قرص كل 8 ساعات",
        duration: "عند اللزوم / 3 أيام",
        instructions: "بعد الأكل لتسكين الألم وتقليل التورم",
      },
      {
        name: "Chlorhexidine Mouthwash (0.12%)",
        form: "مضمضة فموية",
        dose: "15ml",
        frequency: "مرتان يومياً",
        duration: "لمدة أسبوع",
        instructions: "مضمضة بعد 24 ساعة من الجراحة، لا تأكل أو تشرب بعدها لـ 30 دقيقة",
      },
    ],
  },
  {
    title: "علاج عصب / خراج سني مختلط",
    diagnosis: "Acute periapical abscess / Endodontic flare-up",
    items: [
      {
        name: "Amoxicillin",
        form: "كبسولات",
        dose: "500mg",
        frequency: "كبسولة كل 8 ساعات",
        duration: "5 أيام",
        instructions: "بانتظام حتى انتهاء الجرعة كاملة",
      },
      {
        name: "Metronidazole (Flagyl)",
        form: "أقراص",
        dose: "500mg",
        frequency: "قرص كل 8 ساعات",
        duration: "5 أيام",
        instructions: "مع الأكل لتغطية البكتيريا اللاهوائية",
      },
      {
        name: "Paracetamol + Caffeine (Panadol Extra)",
        form: "أقراص",
        dose: "500mg",
        frequency: "قرصان كل 6-8 ساعات",
        duration: "عند اللزوم",
        instructions: "لتسكين الألم والصداع",
      },
    ],
  },
  {
    title: "تسكين ألم الأسنان المعتدل",
    diagnosis: "Moderate dental pain / Post-operative pain",
    items: [
      {
        name: "Diclofenac Potassium (Cataflam)",
        form: "أقراص",
        dose: "50mg",
        frequency: "قرص كل 8 ساعات",
        duration: "عند اللزوم / 3 أيام",
        instructions: "سريع المفعول، يؤخذ بعد الأكل مباشرة",
      },
    ],
  },
  {
    title: "تقرحات فم والتهاب لثة حاد",
    diagnosis: "Aphthous stomatitis / Acute gingivitis",
    items: [
      {
        name: "Triamcinolone in Orabase (Kenalog)",
        form: "مرهم فموي",
        dose: "طبقة رقيقة",
        frequency: "2-3 مرات يومياً",
        duration: "5 أيام",
        instructions: "يوضع على التقرحات قبل النوم وبعد الوجبات",
      },
      {
        name: "Chlorhexidine + Benzydamine Mouthwash",
        form: "مضمضة ومسكن موضعي",
        dose: "15ml",
        frequency: "3 مرات يومياً",
        duration: "أسبوع",
        instructions: "مضمضة لمدة دقيقة لتهدئة الأنسجة",
      },
    ],
  },
  {
    title: "وصفة أطفال (Pediatric Rx)",
    diagnosis: "Pediatric dental infection & pain",
    items: [
      {
        name: "Amoxicillin Syrup",
        form: "شراب معلق",
        dose: "250mg / 5ml",
        frequency: "حسب وزن الطفل كل 8 ساعات",
        duration: "5 أيام",
        instructions: "رج العبوة جيداً قبل كل استخدام",
      },
      {
        name: "Paracetamol Syrup (Adol / Panadol)",
        form: "شراب مسكن وخافض حرارة",
        dose: "120mg / 5ml",
        frequency: "عند اللزوم كل 6 ساعات",
        duration: "3 أيام",
        instructions: "حسب وزن وعمر الطفل",
      },
    ],
  },
];

interface PrescriptionModalProps {
  isOpen: boolean;
  onClose: () => void;
  patientId: number;
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
        form: "أقراص",
        dose: "",
        frequency: "مرتان يومياً",
        duration: "5 أيام",
        instructions: "بعد الأكل",
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
    if (items.length > 0) {
      params.set("items", JSON.stringify(items));
    }
    return `/print/prescription/${patientId}?${params.toString()}`;
  };

  const handlePrint = () => {
    const url = buildPrintUrl();
    window.open(url, "_blank");
  };

  const handleWhatsApp = () => {
    if (!patientPhone) return;
    const phone = toWhatsAppNumber(patientPhone);
    if (!phone) return;

    let text = `*وصفة طبية من مركز الأسنان*\n\nالمريض: ${patientName}\n`;
    if (diagnosis) text += `التشخيص: ${diagnosis}\n`;
    if (medicalAlert) text += `تنبيه طبي: ${medicalAlert}\n`;
    text += `\n*الأدوية الموصوفة:*\n`;

    items.forEach((item, idx) => {
      text += `${idx + 1}. *${item.name}* ${item.dose ? `(${item.dose})` : ""}\n`;
      text += `   - الجرعة: ${item.frequency} ${item.duration ? `· ${item.duration}` : ""}\n`;
      if (item.instructions) text += `   - ملاحظات: ${item.instructions}\n`;
    });

    if (notes) text += `\n*إرشادات إضافية:* ${notes}\n`;
    text += `\nمع تمنياتنا لكم بالشفاء العاجل 🦷✨`;

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

          {/* تفاصيل الطبيب والتشخيص */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                التشخيص الطبي (Diagnosis)
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
                💊 قائمة الأدوية والجرعات ({items.length}):
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
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-xs font-bold text-slate-700">
                      {idx + 1}
                    </span>
                    <input
                      type="text"
                      value={item.name}
                      onChange={(e) => updateItem(idx, "name", e.target.value)}
                      placeholder="اسم الدواء (مثل: Augmentin / Brufen)"
                      className="flex-1 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-navy-900 focus:border-brand-navy focus:outline-none"
                    />
                    <input
                      type="text"
                      value={item.dose}
                      onChange={(e) => updateItem(idx, "dose", e.target.value)}
                      placeholder="العيار (1g / 500mg)"
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

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                    <input
                      type="text"
                      value={item.frequency}
                      onChange={(e) => updateItem(idx, "frequency", e.target.value)}
                      placeholder="التكرار (كل 8 ساعات / مرتان يومياً)"
                      className="rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 focus:border-brand-navy focus:outline-none"
                    />
                    <input
                      type="text"
                      value={item.duration}
                      onChange={(e) => updateItem(idx, "duration", e.target.value)}
                      placeholder="المدة (5 أيام / أسبوع)"
                      className="rounded-xl border border-slate-300 bg-white px-2.5 py-1.5 focus:border-brand-navy focus:outline-none"
                    />
                    <input
                      type="text"
                      value={item.instructions}
                      onChange={(e) => updateItem(idx, "instructions", e.target.value)}
                      placeholder="ملاحظة (بعد الأكل)"
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
