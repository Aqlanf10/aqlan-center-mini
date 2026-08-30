"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GENDER_LABEL, type Gender } from "@/lib/patient";
import type { DuplicateMatch } from "@/lib/duplicates";

export function QuickPatientModal({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (patient: { id: number; fullName: string; patientNumber: string; phone: string | null }) => void;
}) {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [altPhone, setAltPhone] = useState("");
  const [gender, setGender] = useState<Gender>("male");
  const [birthYear, setBirthYear] = useState("");
  const [address, setAddress] = useState("");
  const [medicalAlert, setMedicalAlert] = useState("");
  const [note, setNote] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateMatch[] | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent, confirmDuplicate = false) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/patients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName,
          phone: phone || null,
          altPhone: altPhone || null,
          gender,
          birthYear: birthYear ? Number(birthYear) : null,
          address: address || null,
          medicalAlert: medicalAlert || null,
          note: note || null,
          confirmDuplicate,
        }),
      });

      const payload = await res.json();
      if (res.status === 409 && Array.isArray(payload.duplicates)) {
        setDuplicates(payload.duplicates);
        setError(payload.message);
        setBusy(false);
        return;
      }

      if (!res.ok) {
        throw new Error(payload.message || "تعذّر إضافة المريض.");
      }

      onClose();
      if (onSuccess) {
        onSuccess(payload);
      } else {
        router.push(`/patients/${payload.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ أثناء الحفظ.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl max-h-[92vh] overflow-y-auto">
        <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-orange-50 text-orange-700 font-bold text-sm">
              👤
            </span>
            <div>
              <h3 className="text-sm font-black text-navy-900">تسجيل ملف مريض جديد</h3>
              <p className="text-[11px] text-slate-500">إدخال البيانات الأساسية والتنبيهات الصحية</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-bold text-rose-800">
            {error}
          </div>
        )}

        {duplicates && (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <p className="font-bold mb-1">يوجد مرضى مسجلون ببيانات مشابهة:</p>
            <ul className="list-disc pr-4 space-y-1">
              {duplicates.map((d) => (
                <li key={d.patient.id}>
                  {d.patient.fullName} — ملف #{d.patient.patientNumber}{" "}
                  {d.patient.phone ? `(${d.patient.phone})` : ""}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={(e) => handleSubmit(e, true)}
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-white shadow-xs hover:bg-amber-700"
              >
                تأكيد الإنشاء رغم التشابه
              </button>
              <button
                type="button"
                onClick={() => setDuplicates(null)}
                className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-bold text-amber-800"
              >
                مراجعة وتعديل الاسم
              </button>
            </div>
          </div>
        )}

        <form onSubmit={(e) => handleSubmit(e, false)} className="space-y-3.5">
          <div>
            <label className="mb-1 block text-xs font-bold text-slate-700">
              اسم المريض الرباعي / الكامل <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="مثال: أحمد محمد علي السعدي"
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-navy-900 outline-none focus:border-navy-800"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-700">رقم الجوال الأساسي</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="770000000"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-700">رقم جوال بديل / قريب</label>
              <input
                type="tel"
                value={altPhone}
                onChange={(e) => setAltPhone(e.target.value)}
                placeholder="730000000"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-700">الجنس</label>
              <select
                value={gender}
                onChange={(e) => setGender(e.target.value as Gender)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold outline-none focus:border-navy-800 bg-white"
              >
                {(Object.keys(GENDER_LABEL) as Gender[]).map((g) => (
                  <option key={g} value={g}>
                    {GENDER_LABEL[g]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-700">سنة الميلاد (التقريبية)</label>
              <input
                type="number"
                value={birthYear}
                onChange={(e) => setBirthYear(e.target.value)}
                placeholder="مثال: 1995"
                min="1900"
                max={new Date().getFullYear()}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-bold text-rose-700">
              ⚠️ التنبيهات الطبية والتحسس (حساسية بنسلين، سكري، ضغط، سيولة، حمل…)
            </label>
            <input
              type="text"
              value={medicalAlert}
              onChange={(e) => setMedicalAlert(e.target.value)}
              placeholder="مثال: حساسية بنسلين، مريض سكري نوع 2"
              className="w-full rounded-xl border border-rose-200 bg-rose-50/50 px-3 py-2 text-xs font-bold text-rose-900 outline-none focus:border-rose-600 placeholder:text-rose-300"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-700">العنوان / المنطقة</label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="صنعاء - شارع الستين"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-700">ملاحظات عامة</label>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="تفضيلات المريض..."
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
            </div>
          </div>

          <div className="mt-5 flex gap-2 pt-2 border-t border-slate-100">
            <button
              type="submit"
              disabled={busy}
              className="flex-1 rounded-xl bg-brand-orange py-2.5 text-xs font-extrabold text-white shadow-xs hover:bg-orange-600 disabled:opacity-50 transition-colors"
            >
              {busy ? "جاري الحفظ..." : "حفظ وفتح ملف المريض"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
            >
              إلغاء
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
