"use client";

import { useEffect, useState } from "react";
import { APPOINTMENT_TYPES, type AppointmentTypeOption } from "@/lib/schedule";

interface PatientMatch {
  id: number;
  patientNumber: string;
  fullName: string;
  phone: string | null;
}

export function QuickAppointmentModal({
  patientId,
  patientName,
  isOpen,
  onClose,
  onSuccess,
}: {
  patientId?: number;
  patientName?: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [selectedPatientId, setSelectedPatientId] = useState<number | undefined>(patientId);
  const [selectedPatientName, setSelectedPatientName] = useState<string>(patientName || "");
  const [patientQuery, setPatientQuery] = useState("");
  const [matches, setMatches] = useState<PatientMatch[]>([]);
  const [phone, setPhone] = useState("");

  const [date, setDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  });
  const [time, setTime] = useState("16:00");
  const [appointmentType, setAppointmentType] = useState<string>("consultation");
  const [duration, setDuration] = useState("30");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doctors, setDoctors] = useState<{ id: number; name: string }[]>([]);
  const [selectedDoctorId, setSelectedDoctorId] = useState<number | undefined>();

  useEffect(() => {
    if (!isOpen) return;
    void (async () => {
      try {
        const res = await fetch("/api/parties?kind=doctor");
        if (res.ok) {
          const list = await res.json();
          if (Array.isArray(list)) {
            setDoctors(
              list
                .filter((p: { isActive?: boolean }) => p.isActive !== false)
                .map((p: { id: number; name: string }) => ({ id: p.id, name: p.name })),
            );
          }
        }
      } catch {
        /* ignore */
      }
    })();
  }, [isOpen]);

  useEffect(() => {
    if (patientId) {
      setSelectedPatientId(patientId);
      setSelectedPatientName(patientName || "");
    }
  }, [patientId, patientName]);

  useEffect(() => {
    if (selectedPatientId || patientQuery.trim().length < 2) {
      setMatches([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/patients?q=${encodeURIComponent(patientQuery.trim())}`);
        if (res.ok) setMatches(await res.json());
      } catch {
        /* ignore */
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [patientQuery, selectedPatientId]);

  if (!isOpen) return null;

  const handleTypeChange = (typeId: string) => {
    setAppointmentType(typeId);
    const preset = APPOINTMENT_TYPES.find((t) => t.id === typeId);
    if (preset) {
      setDuration(String(preset.defaultDuration));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !date || !time) return;

    let targetId = selectedPatientId;
    if (!targetId) {
      const name = (patientQuery || selectedPatientName).trim();
      if (!name) {
        setError("يرجى اختيار مريض أو كتابة اسم المريض الجديد.");
        return;
      }
      // Create new patient on the fly
      try {
        const pRes = await fetch("/api/patients", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fullName: name, phone: phone.trim() }),
        });
        if (!pRes.ok) {
          setError("تعذّر إنشاء ملف للمريض الجديد.");
          return;
        }
        const newP = await pRes.json();
        targetId = newP.id;
      } catch {
        setError("تعذّر إنشاء ملف المريض.");
        return;
      }
    }

    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/appointments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId: targetId,
          date,
          time,
          durationMinutes: Number(duration) || 30,
          appointmentType: appointmentType || undefined,
          note: note.trim() || undefined,
          doctorId: selectedDoctorId || undefined,
        }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message ?? "تعذّر حجز الموعد.");
        return;
      }

      onSuccess();
      onClose();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl max-h-[92vh] overflow-y-auto">
        <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-navy-50 text-navy-800 font-bold text-sm">
              📅
            </span>
            <div>
              <h3 className="text-sm font-black text-navy-900">
                {selectedPatientName ? `حجز موعد للمريض: ${selectedPatientName}` : "حجز موعد جديد"}
              </h3>
              <p className="text-[11px] text-slate-500">تحديد نوع الجلسة، الموعد، والمدة المقدرة</p>
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
          <div className="mb-3 rounded-xl border border-red-200 bg-red-50 p-2.5 text-xs font-bold text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3.5">
          {!patientId && (
            <div className="relative">
              <label className="mb-1 block text-xs font-bold text-slate-700">المريض</label>
              {selectedPatientId ? (
                <div className="flex items-center justify-between rounded-xl border border-navy-200 bg-navy-50/50 px-3 py-2 text-xs font-bold text-navy-900">
                  <span className="flex items-center gap-2">
                    <span>👤</span>
                    <span>{selectedPatientName}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedPatientId(undefined);
                      setSelectedPatientName("");
                    }}
                    className="text-xs text-navy-700 underline hover:text-navy-900 font-semibold"
                  >
                    تغيير المريض
                  </button>
                </div>
              ) : (
                <>
                  <input
                    type="text"
                    value={patientQuery}
                    onChange={(e) => setPatientQuery(e.target.value)}
                    placeholder="ابحث بالاسم أو اكتب اسم مريض جديد…"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
                  />
                  {matches.length > 0 && (
                    <ul className="absolute z-20 mt-1 max-h-40 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
                      {matches.map((m) => (
                        <li key={m.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedPatientId(m.id);
                              setSelectedPatientName(m.fullName);
                              setMatches([]);
                            }}
                            className="w-full px-3 py-2 text-right text-xs hover:bg-navy-50"
                          >
                            <span className="font-bold text-navy-900">{m.fullName}</span>
                            <span className="mr-2 text-[10px] text-slate-400">
                              {m.patientNumber} {m.phone ? `· ${m.phone}` : ""}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <input
                    type="tel"
                    dir="ltr"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="رقم الهاتف (لمريض جديد)"
                    className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
                  />
                </>
              )}
            </div>
          )}

          {/* اختيار نوع الموعد */}
          <div>
            <label className="mb-1.5 flex items-center justify-between text-xs font-bold text-slate-700">
              <span>نوع الموعد / الإجراء</span>
              <span className="text-[10px] text-slate-400">يحدد المدة التقديرية تلقائياً</span>
            </label>
            <div className="grid grid-cols-3 gap-1.5">
              {APPOINTMENT_TYPES.map((typeOption: AppointmentTypeOption) => {
                const isSelected = appointmentType === typeOption.id;
                return (
                  <button
                    key={typeOption.id}
                    type="button"
                    onClick={() => handleTypeChange(typeOption.id)}
                    className={`rounded-xl border p-2 text-right text-xs font-bold transition-all ${
                      isSelected
                        ? "border-navy-800 bg-navy-900 text-white shadow-xs"
                        : `${typeOption.badgeClass} hover:opacity-85`
                    }`}
                  >
                    <div className="truncate font-extrabold">{typeOption.shortLabel}</div>
                    <div className={`text-[10px] ${isSelected ? "text-slate-300" : "opacity-75"}`}>
                      {typeOption.defaultDuration} دقيقة
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-700">التاريخ</label>
              <input
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-navy-900 outline-none focus:border-navy-800"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-700">الوقت</label>
              <input
                type="time"
                required
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-navy-900 outline-none focus:border-navy-800"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-bold text-slate-700">المدة المحجوزة على الكرسي</label>
            <select
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
            >
              <option value="15">15 دقيقة (متابعة سريعة / شد سلك / كشف مستعجل)</option>
              <option value="20">20 دقيقة (طوارئ وتسكين ألم)</option>
              <option value="30">30 دقيقة (كشف واستشارة / حشوة بسيطة / تنظيف)</option>
              <option value="45">45 دقيقة (علاج عصب / حشوة تجميلية / تركيب تاج)</option>
              <option value="60">60 دقيقة (لصق تقويم / جراحة وخلع جراحي)</option>
              <option value="90">90 دقيقة (إجراء مطوّل / زراعة أسنان)</option>
            </select>
          </div>

          <div>
            <label className="mb-1 flex items-center justify-between text-xs font-bold text-slate-700">
              <span>الطبيب المعالج</span>
              <span className="text-[10px] text-slate-400">لحساب العمولات والمتابعة السريرية</span>
            </label>
            <select
              value={selectedDoctorId ?? ""}
              onChange={(e) => setSelectedDoctorId(e.target.value ? Number(e.target.value) : undefined)}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold outline-none focus:border-navy-800"
            >
              <option value="">-- بدون تحديد طبيب معين --</option>
              {doctors.map((doc) => (
                <option key={doc.id} value={doc.id}>
                  د. {doc.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-bold text-slate-700">تفاصيل الزيارة وملاحظات إضافية</label>
            <textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="مثال: الضرس العلوي الأيمن، تبديل أقواس التقويم، متابعة ما بعد الخلع…"
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800 resize-none"
            />
          </div>

          <div className="mt-4 flex gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="flex-1 rounded-xl border border-slate-200 bg-white py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={busy}
              className="flex-1 rounded-xl bg-navy-800 py-2 text-xs font-bold text-white shadow-xs hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "جارٍ الحجز…" : "تأكيد الحجز"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
