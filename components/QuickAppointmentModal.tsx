"use client";

import { useEffect, useId, useState } from "react";
import {
  SHIFTS, SHIFT_LABEL, WEEKDAYS, WEEKDAY_LABEL,
  type PreferredShift, type Weekday,
} from "@/lib/waiting-list";
import { Modal } from "./Modal";
import { APPOINTMENT_TYPES } from "@/lib/schedule";
import type { AppointmentService } from "@/lib/appointment-services";

function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

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
  const formId = useId();
  const [selectedPatientId, setSelectedPatientId] = useState<number | undefined>(patientId);
  const [selectedPatientName, setSelectedPatientName] = useState<string>(patientName || "");
  const [patientQuery, setPatientQuery] = useState("");
  const [matches, setMatches] = useState<PatientMatch[]>([]);
  const [phone, setPhone] = useState("");

  const [date, setDate] = useState(tomorrow);
  const [time, setTime] = useState("16:00");
  const [appointmentType, setAppointmentType] = useState<string>("consultation");
  const [duration, setDuration] = useState("30");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doctors, setDoctors] = useState<{ id: number; name: string }[]>([]);
  const [selectedDoctorId, setSelectedDoctorId] = useState<number | undefined>();
  /* كتالوج الخدمات من القاعدة — لا مصفوفةً في الشيفرة. وحين يتعذّر تحميله يعود
     النموذج إلى الأنواع المدمجة بدل أن يعجز عن الحجز: الاستقبال لا تنتظر شبكة. */
  const [services, setServices] = useState<AppointmentService[]>([]);
  const [selectedServiceId, setSelectedServiceId] = useState<number | undefined>();
  const [chairs, setChairs] = useState(0);
  const [chairNo, setChairNo] = useState<string>("");
  /* التجاوز لا يُطلب قبل الرفض: يظهر الحقل حين يقول الخادم إن الوقت ممتلئ وإن
     لصاحب الجلسة صلاحيةً — فلا يتعوّد أحدٌ كتابة سببٍ لا يحتاجه. */
  const [conflict, setConflict] = useState<
    { message: string; reasons: string[]; overrideHint: string; canOverride: boolean } | null
  >(null);
  const [overrideReason, setOverrideReason] = useState("");
  /* الرفض بلا وجهةٍ يعني مريضًا ضاع. فمن رُدّ يُكتب في قائمة الانتظار من
     اللوحة نفسها التي ردّته — لا من شاشةٍ أخرى يُنسى الانتقال إليها. */
  const [waitingBusy, setWaitingBusy] = useState(false);
  const [waitingNote, setWaitingNote] = useState<string | null>(null);
  /* خطوةُ التفضيلات — تُفتح بالضغط على «أضِف إلى قائمة الانتظار».
     والتسجيلُ بلا سؤالٍ عنها يكتب صفًّا يبدو كاملًا وهو يحمل تفضيلاتٍ لم يقلها
     أحد: «أيّ يوم» و«أيّ وردية» و«يقبل اليوم نفسه» — فيُنادى المريض في يومٍ لا
     يأتي فيه، ثمّ تُلام القائمة على ترشيحٍ لا يصلح. */
  const [waitingStep, setWaitingStep] = useState(false);
  const [waitingDays, setWaitingDays] = useState<Weekday[]>([]);
  const [waitingShift, setWaitingShift] = useState<PreferredShift>("any");
  /* `null` = لم يُسأل بعد. وهذا مقصود: إتاحةُ اليوم نفسه لا تُفترض عن المريض —
     من لا يستطيع الحضور اليوم يُنادى فيُوعَد بما لا يقدر عليه. */
  const [waitingSameDay, setWaitingSameDay] = useState<boolean | null>(null);

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
    if (!isOpen) return;
    void (async () => {
      try {
        const res = await fetch("/api/settings/appointment-services", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data?.services)) setServices(data.services);
        if (Number.isFinite(data?.chairs)) setChairs(Number(data.chairs));
      } catch {
        /* الكتالوج تعذّر — تبقى الأنواع المدمجة أدناه. */
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
    setSelectedServiceId(undefined);
    const preset = APPOINTMENT_TYPES.find((t) => t.id === typeId);
    if (preset) setDuration(String(preset.defaultDuration));
  };

  /* اختيار الخدمة يقترح مدّتها ولا يفرضها: مريضٌ بعينه قد يحتاج ضعفها، والمدّة
     المكتوبة هي ما يُحجز فعلًا وما يُحفظ لقطةً مع الموعد. */
  const handleServiceChange = (service: AppointmentService) => {
    setSelectedServiceId(service.id);
    setAppointmentType(service.legacyType ?? "");
    setDuration(String(service.defaultDurationMinutes));
    if (!service.requiresChair) setChairNo("");
  };

  const activeService = services.find((service) => service.id === selectedServiceId);
  /* خدمةٌ لا تشغل كرسيًّا لا يُعرض لها اختيار كرسي — والحقل يُفرَّغ لا يُخفى وقيمته باقية. */
  const chairApplies = !activeService || activeService.requiresChair;

  /**
   * تسجيلُ المريض المردود في قائمة الانتظار.
   *
   * لا يحجز شيئًا — يكتب أنّ هذا المريض يريد موعدًا ولم يجده. والنداء لاحقًا
   * بيد الاستقبال حين يشغر مكان: القائمة تقترح ولا تحجز.
   */
  const addToWaitingList = async (patientOverride?: number) => {
    const targetPatient = patientOverride ?? selectedPatientId;
    if (waitingBusy || !targetPatient) return;
    /* ولا يُسجَّل قبل أن يُجاب سؤالُ اليوم نفسه — الزرّ معطَّل، وهذا حارسٌ ثانٍ. */
    if (waitingSameDay === null) return;
    setWaitingBusy(true);
    try {
      const res = await fetch("/api/waiting-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId: targetPatient,
          serviceId: selectedServiceId || undefined,
          doctorId: selectedDoctorId || undefined,
          /* اليوم الذي طلبه المريض هو أبكر ما يقبله — لا يُفترض عنه مدىً أوسع. */
          earliestDate: date || undefined,
          durationMinutes: Number(duration) || undefined,
          note: note.trim() || undefined,
          /* ما قاله المريض في المكالمة نفسها — لا ما افترضه النظام عنه. */
          preferredDays: waitingDays,
          preferredShift: waitingShift,
          sameDayAvailable: waitingSameDay === true,
        }),
      });
      const data = await res.json().catch(() => null);
      setWaitingNote(res.ok
        ? "سُجِّل في قائمة الانتظار بتفضيلاته — سيُنادى إن شغر مكانٌ يناسبه."
        : (data?.message ?? "تعذّر التسجيل في قائمة الانتظار."));
      if (res.ok) setWaitingStep(false);
    } catch {
      setWaitingNote("تعذّر الاتصال بالخادم.");
    } finally {
      setWaitingBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !date || !time) return;

    let targetId = selectedPatientId;
    /* مريضٌ أُنشئ ملفُّه في هذه اللحظة هو مريضٌ جديدٌ بالتعريف — وهذا ما يقيسه
       حدُّ المرضى الجدد اليوميّ. ولا تخمين: من اختير من القائمة له ملفٌ سابق. */
    let isNewPatient = false;
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
        isNewPatient = true;
        /* يصير هو المريض المختار فعلًا.
           كان يبقى في متغيّرٍ محلّيّ، فإذا رُدّ الحجز لامتلاء اليوم وُجد زرُّ
           «أضِف إلى قائمة الانتظار» معطَّلًا — لمريضٍ أُنشئ ملفُّه قبل ثانية.
           أي أنّ الحلقة التي بُنيت لأجلها هذه المرحلة كانت تنكسر في أكثر
           حالاتها شيوعًا: مريضٌ جديد يتّصل، فلا مكان، فيضيع. */
        setSelectedPatientId(newP.id);
        setSelectedPatientName(name);
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
          serviceId: selectedServiceId || undefined,
          appointmentType: appointmentType || undefined,
          note: note.trim() || undefined,
          doctorId: selectedDoctorId || undefined,
          chairNo: chairApplies && chairNo ? Number(chairNo) : undefined,
          isNewPatient,
          overrideReason: overrideReason.trim() || undefined,
        }),
      });

      const data = await res.json().catch(() => null);
      if (res.status === 409 && data) {
        /* ليس خطأ إدخال: اليوم ممتلئ. تُعرض الأسباب والبديل، ويُفتح حقل السبب
           لمن يملك الصلاحية — ولا يُغلق النموذج فيفقد ما كُتب فيه. */
        setWaitingNote(null);
        setConflict({
          message: String(data.message ?? "لا يمكن الحجز في هذا الوقت."),
          reasons: Array.isArray(data.reasons) ? data.reasons.map(String) : [],
          overrideHint: String(data.overrideHint ?? ""),
          canOverride: data.canOverride === true,
        });
        setError(data.suggestionMessage ? String(data.suggestionMessage) : null);
        return;
      }
      if (!res.ok) {
        setError(data?.message ?? "تعذّر حجز الموعد.");
        return;
      }
      setConflict(null);
      setOverrideReason("");
      setSelectedServiceId(undefined);
      setChairNo("");

      setSelectedPatientId(patientId);
      setSelectedPatientName(patientName || "");
      setPatientQuery("");
      setMatches([]);
      setPhone("");
      setDate(tomorrow());
      setTime("16:00");
      setAppointmentType("consultation");
      setDuration("30");
      setNote("");
      setSelectedDoctorId(undefined);
      onSuccess();
      onClose();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} labelledBy={`${formId}-title`} busy={busy} initialFocus="input">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-navy-50 text-navy-800 font-bold text-sm">
              📅
            </span>
            <div>
              <h3 id={`${formId}-title`} className="text-sm font-black text-navy-900">
                {selectedPatientName ? `حجز موعد للمريض: ${selectedPatientName}` : "حجز موعد جديد"}
              </h3>
              <p className="text-[11px] text-slate-500">تحديد نوع الجلسة، الموعد، والمدة المقدرة</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="إغلاق"
            className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          >
            ✕
          </button>
        </div>

        {error && (
          <div role="alert" id={`${formId}-error`} className="mb-3 rounded-xl border border-red-200 bg-red-50 p-2.5 text-xs font-bold text-red-700">
            {error}
          </div>
        )}

        {conflict && (
          <div role="alert" className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
            <p className="font-black">{conflict.message}</p>
            {conflict.reasons.length > 0 && (
              <ul className="mt-1.5 list-disc space-y-0.5 pr-4 font-semibold">
                {conflict.reasons.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
            )}
            <p className="mt-2 font-bold text-amber-800">{conflict.overrideHint}</p>

            <div className="mt-2.5 border-t border-amber-200 pt-2.5">
              {waitingNote ? (
                <p className="font-bold text-emerald-800">{waitingNote}</p>
              ) : (
                <>
                  <p className="mb-1.5">
                    لا تُغلق الباب على المريض: سجّله في قائمة الانتظار، ويُنادى إن شغر مكان.
                  </p>

                  {!waitingStep ? (
                    <>
                      <button
                        type="button"
                        data-action="add-to-waiting-list"
                        disabled={waitingBusy || !selectedPatientId}
                        onClick={() => setWaitingStep(true)}
                        className="rounded-xl border border-amber-400 bg-white px-3 py-1.5 text-xs font-bold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                      >
                        أضِف إلى قائمة الانتظار
                      </button>
                      {!selectedPatientId && (
                        <span className="mr-2 text-[11px] text-amber-700">
                          (اختر المريض أولًا — القائمة تُسجَّل على ملفّ)
                        </span>
                      )}
                    </>
                  ) : (
                    /* خطوةُ التفضيلات — والهاتفُ في يد الموظّفة، فالأسئلة ثلاثة
                       قصيرة تُجاب في المكالمة نفسها لا نموذجٌ يُؤجَّل. */
                    <div data-waiting-preferences="1" className="rounded-xl border border-amber-300 bg-white p-2.5">
                      <p className="mb-1.5 font-bold text-amber-900">
                        اسأله الآن — تفضيلاته تحدّد متى يُنادى:
                      </p>

                      <p className="mb-1 text-[11px] font-bold text-slate-700">
                        الأيام التي يستطيع الحضور فيها (بلا تحديد = أيّ يوم)
                      </p>
                      <div className="mb-2 flex flex-wrap gap-1">
                        {WEEKDAYS.map((day) => {
                          const on = waitingDays.includes(day);
                          return (
                            <button
                              key={day}
                              type="button"
                              data-waiting-day={day}
                              aria-pressed={on}
                              onClick={() => setWaitingDays(on
                                ? waitingDays.filter((value) => value !== day)
                                : [...waitingDays, day].sort((a, b) => a - b))}
                              className={`rounded-lg border px-2 py-1 text-[11px] font-bold ${
                                on ? "border-navy-800 bg-navy-800 text-white" : "border-slate-200 bg-white text-slate-700"
                              }`}
                            >
                              {WEEKDAY_LABEL[day]}
                            </button>
                          );
                        })}
                      </div>

                      <label className="mb-2 block text-[11px] font-bold text-slate-700">
                        الوردية المفضّلة
                        <select
                          data-waiting-shift="1"
                          value={waitingShift}
                          onChange={(event) => setWaitingShift(event.target.value as PreferredShift)}
                          className="mr-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs"
                        >
                          {SHIFTS.map((shift) => (
                            <option key={shift} value={shift}>{SHIFT_LABEL[shift]}</option>
                          ))}
                        </select>
                      </label>

                      {/* لا افتراضَ هنا: السؤال يُطرح ويُجاب، والزرّ معطَّلٌ حتى يُجاب. */}
                      <p className="mb-1 text-[11px] font-bold text-slate-700">
                        هل يقبل مكانًا اليوم نفسه إن شغر؟
                      </p>
                      <div className="mb-2 flex gap-1.5">
                        <button
                          type="button"
                          data-waiting-sameday="yes"
                          aria-pressed={waitingSameDay === true}
                          onClick={() => setWaitingSameDay(true)}
                          className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold ${
                            waitingSameDay === true
                              ? "border-emerald-600 bg-emerald-600 text-white"
                              : "border-slate-200 bg-white text-slate-700"
                          }`}
                        >
                          نعم
                        </button>
                        <button
                          type="button"
                          data-waiting-sameday="no"
                          aria-pressed={waitingSameDay === false}
                          onClick={() => setWaitingSameDay(false)}
                          className={`rounded-lg border px-2.5 py-1 text-[11px] font-bold ${
                            waitingSameDay === false
                              ? "border-navy-800 bg-navy-800 text-white"
                              : "border-slate-200 bg-white text-slate-700"
                          }`}
                        >
                          لا
                        </button>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          data-action="save-to-waiting-list"
                          disabled={waitingBusy || !selectedPatientId || waitingSameDay === null}
                          onClick={() => void addToWaitingList()}
                          className="rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                        >
                          {waitingBusy ? "جارٍ التسجيل…" : "احفظ في قائمة الانتظار"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setWaitingStep(false)}
                          className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700"
                        >
                          تراجع
                        </button>
                        {waitingSameDay === null && (
                          <span className="text-[11px] text-amber-700">
                            أجِب سؤال «اليوم نفسه» — لا يُفترض عن المريض.
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            {conflict.canOverride && (
              <div className="mt-2">
                <label htmlFor={`${formId}-override`} className="mb-1 block font-bold">
                  سبب التجاوز (يُسجَّل في سجلّ التدقيق باسمك)
                </label>
                <input
                  id={`${formId}-override`}
                  type="text"
                  value={overrideReason}
                  onChange={(event) => setOverrideReason(event.target.value)}
                  placeholder="مثال: حالة ألم حادّ لا تحتمل التأجيل"
                  className="w-full rounded-xl border border-amber-300 bg-white px-3 py-2 text-xs outline-none focus:border-amber-500"
                />
              </div>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} aria-describedby={error ? `${formId}-error` : undefined} className="space-y-3.5">
          {!patientId && (
            <div className="relative">
              <label htmlFor={`${formId}-patient`} className="mb-1 block text-xs font-bold text-slate-700">المريض</label>
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
                id={`${formId}-patient`}
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
                            <span className="mr-2 text-[10px] text-slate-600">
                              {m.patientNumber} {m.phone ? `· ${m.phone}` : ""}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <input
                id={`${formId}-phone`}
                    aria-label="رقم الهاتف لمريض جديد"
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
            <div id={`${formId}-type`} className="mb-1.5 flex items-center justify-between text-xs font-bold text-slate-700">
              <span>نوع الموعد / الإجراء</span>
              <span className="text-[10px] text-slate-600">يحدد المدة التقديرية تلقائياً</span>
            </div>
            <div role="group" aria-labelledby={`${formId}-type`} className="grid grid-cols-3 gap-1.5">
              {services.length > 0
                ? services.map((service) => {
                  const isSelected = selectedServiceId === service.id;
                  return (
                    <button
                      key={service.id}
                      type="button"
                      data-service={service.code}
                      onClick={() => handleServiceChange(service)}
                      aria-pressed={isSelected}
                      className={`rounded-xl border p-2 text-right text-xs font-bold transition-all ${
                        isSelected
                          ? "border-navy-800 bg-navy-900 text-white shadow-xs"
                          : `${service.badgeClass ?? "border-slate-200 bg-slate-50 text-slate-700"} hover:opacity-85`
                      }`}
                    >
                      <div className="truncate font-extrabold">{service.nameAr}</div>
                      <div className={`text-[10px] ${isSelected ? "text-slate-300" : "opacity-75"}`}>
                        {service.defaultDurationMinutes} دقيقة
                        {service.bufferAfterMinutes > 0 ? ` + ${service.bufferAfterMinutes} فاصل` : ""}
                      </div>
                    </button>
                  );
                })
                : APPOINTMENT_TYPES.map((typeOption) => {
                  const isSelected = appointmentType === typeOption.id;
                  return (
                    <button
                      key={typeOption.id}
                      type="button"
                      onClick={() => handleTypeChange(typeOption.id)}
                      aria-pressed={isSelected}
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
              <label htmlFor={`${formId}-date`} className="mb-1 block text-xs font-bold text-slate-700">التاريخ</label>
              <input
                id={`${formId}-date`}
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-navy-900 outline-none focus:border-navy-800"
              />
            </div>
            <div>
              <label htmlFor={`${formId}-time`} className="mb-1 block text-xs font-bold text-slate-700">الوقت</label>
              <input
                id={`${formId}-time`}
                type="time"
                required
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-navy-900 outline-none focus:border-navy-800"
              />
            </div>
          </div>

          <div>
            <label htmlFor={`${formId}-duration`} className="mb-1 block text-xs font-bold text-slate-700">المدة المحجوزة على الكرسي</label>
            <select
                id={`${formId}-duration`}
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
            <label htmlFor={`${formId}-doctor`} className="mb-1 flex items-center justify-between text-xs font-bold text-slate-700">
              <span>الطبيب المعالج</span>
              <span className="text-[10px] text-slate-600">لحساب العمولات والمتابعة السريرية</span>
            </label>
            <select
                id={`${formId}-doctor`}
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

          {chairs > 0 && (
            <div>
              <label htmlFor={`${formId}-chair`} className="mb-1 flex items-center justify-between text-xs font-bold text-slate-700">
                <span>الكرسي</span>
                <span className="text-[10px] text-slate-600">
                  {chairApplies ? "«تلقائي» يحجز كرسيًّا دون تخصيصه" : "هذه الخدمة لا تشغل كرسيًّا"}
                </span>
              </label>
              <select
                id={`${formId}-chair`}
                value={chairNo}
                disabled={!chairApplies}
                onChange={(event) => setChairNo(event.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold outline-none focus:border-navy-800 disabled:bg-slate-100 disabled:text-slate-500"
              >
                <option value="">تلقائي — دون تخصيص كرسي</option>
                {Array.from({ length: chairs }, (_, index) => index + 1).map((seat) => (
                  <option key={seat} value={seat}>كرسي {seat}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label htmlFor={`${formId}-note`} className="mb-1 block text-xs font-bold text-slate-700">تفاصيل الزيارة وملاحظات إضافية</label>
            <textarea
                id={`${formId}-note`}
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
    </Modal>
  );
}
