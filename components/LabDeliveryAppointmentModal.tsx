"use client";

import React, { useState } from "react";
import { type LabOrder, type LabOrderClinicalDTO } from "@/lib/lab";
import { APPOINTMENT_TYPES, type AppointmentTypeOption } from "@/lib/schedule";

interface LabDeliveryAppointmentModalProps {
  order: LabOrder | LabOrderClinicalDTO;
  clinicName?: string;
  clinicPhone?: string;
  isOpen: boolean;
  onClose: () => void;
  onAppointmentBooked?: () => void;
}

export function LabDeliveryAppointmentModal({
  order,
  clinicName = "مركز عقلان لطب الأسنان",
  isOpen,
  onClose,
  onAppointmentBooked,
}: LabDeliveryAppointmentModalProps) {
  // Appointment Form State
  const [date, setDate] = useState(() => {
    const d = new Date();
    // Default to today or tomorrow
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  });
  const [time, setTime] = useState("16:30");
  const [appointmentType, setAppointmentType] = useState<string>("prosthetics");
  const [duration, setDuration] = useState("30");
  const [note, setNote] = useState(
    () =>
      `تسليم وتركيب عمل المعمل: ${order.workType}${
        order.toothNumbers ? ` [سن ${order.toothNumbers}]` : ""
      } - طلب معمل #${order.id} من مختبر ${order.labName}`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bookedSuccess, setBookedSuccess] = useState(false);

  if (!isOpen) return null;

  const patientPhoneClean = (order.patientPhone || "").replace(/\D/g, "");
  const patientWa = patientPhoneClean.length >= 7 ? patientPhoneClean : null;

  const patientMsg = `مرحباً ${order.patientName}،\nيسرنا إعلامكم في ${clinicName} بوصول تركيبتكم السنية (${order.workType}${
    order.toothNumbers ? ` - أسنان ${order.toothNumbers}` : ""
  }) من المختبر، وأصبحت جاهزة للتركيب والتسليم.\nنرجو تأكيد موعد زيارتكم لمطابقة وتركيب العمل في أقرب وقت يناسبكم.`;

  const handleTypeChange = (typeId: string) => {
    setAppointmentType(typeId);
    const preset = APPOINTMENT_TYPES.find((t) => t.id === typeId);
    if (preset) {
      setDuration(String(preset.defaultDuration));
    }
  };

  const handleBookAppointment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !date || !time) return;

    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/appointments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId: order.patientId,
          date,
          time,
          durationMinutes: Number(duration) || 30,
          appointmentType: appointmentType || "prosthetics",
          note: note.trim() || undefined,
        }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message ?? data?.suggestionMessage ?? "تعذّر حجز موعد التسليم.");
        return;
      }

      setBookedSuccess(true);
      if (onAppointmentBooked) {
        onAppointmentBooked();
      }
      setTimeout(() => {
        onClose();
      }, 1800);
    } catch {
      setError("تعذّر الاتصال بالخادم لحجز الموعد.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/70 p-3 sm:p-4 backdrop-blur-xs overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="relative my-6 w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-5 sm:p-6 shadow-2xl transition-all">
        {/* Header with visual badge */}
        <div className="mb-4 flex items-start justify-between border-b border-slate-100 pb-3.5">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-500 text-xl text-white shadow-xs">
              🦷
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-black text-navy-950">
                  تذكير بحجز موعد تسليم وتركيب
                </h3>
                <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-[10px] font-black text-emerald-800">
                  وصل العيادة ✓
                </span>
              </div>
              <p className="text-xs text-slate-500">
                وصلت التركيبة السنية من المختبر وتتطلب حجز موعد في جدول العيادة
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </div>

        {/* Order Summary Pill */}
        <div className="mb-4 rounded-2xl bg-slate-50 border border-slate-200 p-3 text-xs space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="font-bold text-slate-500">المريض:</span>
            <span className="font-black text-navy-950 text-sm">{order.patientName}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-bold text-slate-500">نوع العمل / التركيبة:</span>
            <span className="font-bold text-brand-blue">{order.workType}</span>
          </div>
          {order.toothNumbers && (
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-500">الأسنان المحددة (FDI):</span>
              <span className="font-mono font-black text-slate-800">#{order.toothNumbers}</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="font-bold text-slate-500">المختبر السني:</span>
            <span className="font-bold text-slate-700">{order.labName}</span>
          </div>
        </div>

        {/* WhatsApp Quick Patient Notification */}
        {patientWa && (
          <div className="mb-4 flex items-center justify-between rounded-2xl border border-emerald-200 bg-emerald-50/70 p-3 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-lg">💬</span>
              <div>
                <p className="font-black text-emerald-950">إشعار فوري للمريض عبر واتساب</p>
                <p className="text-[11px] text-emerald-800">إرسال رسالة جاهزة بوصول التركيبة والجاهزية للتسليم</p>
              </div>
            </div>
            <a
              href={`https://wa.me/${patientWa}?text=${encodeURIComponent(patientMsg)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-xl bg-[#25D366] px-3 py-1.5 text-xs font-black text-white shadow-2xs hover:opacity-90"
            >
              إرسال واتساب
            </a>
          </div>
        )}

        {/* Success Banner */}
        {bookedSuccess ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-center text-xs font-black text-emerald-800">
            ✓ تم حجز موعد تسليم وتركيب العمل في جدول المواعيد بنجاح!
          </div>
        ) : (
          /* Appointment Booking Form */
          <form onSubmit={handleBookAppointment} className="space-y-3">
            {error && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-xs font-bold text-rose-700">
                {error}
              </div>
            )}

            <div>
              <label className="mb-1 block text-xs font-black text-navy-950">
                نوع الموعد في الجدول
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {APPOINTMENT_TYPES.filter(
                  (t) => t.id === "prosthetics" || t.id === "follow_up" || t.id === "consultation",
                ).map((typeOption: AppointmentTypeOption) => {
                  const isSelected = appointmentType === typeOption.id;
                  return (
                    <button
                      key={typeOption.id}
                      type="button"
                      onClick={() => handleTypeChange(typeOption.id)}
                      className={`rounded-xl border p-2 text-right text-xs font-bold transition-all ${
                        isSelected
                          ? "border-navy-900 bg-navy-950 text-white shadow-xs"
                          : `${typeOption.badgeClass} hover:opacity-85`
                      }`}
                    >
                      <div className="truncate font-black">{typeOption.shortLabel}</div>
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
                <label className="mb-1 block text-xs font-bold text-slate-700">تاريخ موعد التسليم *</label>
                <input
                  type="date"
                  required
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-navy-900 outline-none focus:border-navy-800"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-bold text-slate-700">وقت الجلسة *</label>
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
              <label className="mb-1 block text-xs font-bold text-slate-700">مدة الجلسة المقدرة على الكرسي</label>
              <select
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold outline-none focus:border-navy-800"
              >
                <option value="15">15 دقيقة (تسليم سريع / فحص مبدئي)</option>
                <option value="30">30 دقيقة (جلسة تركيب وتثبيت تاج / جسر)</option>
                <option value="45">45 دقيقة (مطابقة إطباق وتركيب جسور متعددة / طقم)</option>
                <option value="60">60 دقيقة (إجراء تسليم مطوّل وتعديلات)</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-bold text-slate-700">ملاحظات حجز التسليم</label>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="ملاحظات الموعد..."
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
            </div>

            <div className="mt-4 flex gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="flex-1 rounded-xl border border-slate-200 bg-white py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                تخطي لاحقاً
              </button>
              <button
                type="submit"
                disabled={busy}
                className="flex-1 rounded-xl bg-navy-950 py-2 text-xs font-black text-white shadow-xs hover:bg-navy-900 disabled:opacity-50"
              >
                {busy ? "جارٍ الحجز…" : "📅 تأكيد حجز موعد التسليم"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
