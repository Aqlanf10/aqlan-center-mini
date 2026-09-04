"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  dayLoad,
  distributeAppointmentsToChairs,
  type Appointment,
  type ChairSchedule,
  APPOINTMENT_TYPES,
  getAppointmentTypeLabel,
  getAppointmentTypeBadge,
} from "@/lib/schedule";
import { whatsAppLink, friendlyDateLong, friendlyTime, reminderNeedsOverride, bookingConfirmationText, toWhatsAppNumber } from "@/lib/reminders";
import { useChairCount } from "@/components/SettingsProvider";
import { useSession } from "@/components/SessionProvider";
import { isAdmin } from "@/lib/roles";
import { PageHeader } from "@/components/PageHeader";
import { QuickAppointmentModal } from "@/components/QuickAppointmentModal";

/**
 * المواعيد — إدارة الجدولة، تدفق الحجوزات، والتكامل الفوري مع كراسي العيادة.
 */

const DURATIONS = [
  { minutes: 15, label: "شدّ سلك / فحص سريع — ١٥ د" },
  { minutes: 30, label: "متابعة عامة / كشف — ٣٠ د" },
  { minutes: 45, label: "حشوة تجميلية / سحب عصب — ٤٥ د" },
  { minutes: 60, label: "لصق تقويم / تركيب تاج — ٦٠ د" },
  { minutes: 90, label: "جراحة وزراعة — ٩٠ د" },
];

function todayLocal(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function addDaysToDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

interface Patient {
  id: number;
  patientNumber: string;
  fullName: string;
  phone: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  booked: "محجوز",
  arrived: "وصل بالعيادة",
  done: "مكتمل",
  cancelled: "ملغى",
  no_show: "لم يحضر",
};

const STATUS_COLOR: Record<string, string> = {
  booked: "border-sky-200 bg-sky-50 text-sky-800",
  arrived: "border-emerald-300 bg-emerald-50 text-emerald-800",
  done: "border-slate-200 bg-slate-100 text-slate-700",
  cancelled: "border-slate-200 bg-slate-50 text-slate-400",
  no_show: "border-amber-200 bg-amber-50 text-amber-800",
};

export default function AppointmentsPage() {
  const session = useSession();
  const admin = isAdmin(session?.role);
  const CHAIRS = useChairCount();
  const today = useMemo(todayLocal, []);
  const [date, setDate] = useState(today);
  const [items, setItems] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  // Filters & Search
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "chairs">("list");


  // Booking Form State
  const [showAddModal, setShowAddModal] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Patient[]>([]);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [phone, setPhone] = useState("");
  const [time, setTime] = useState("10:00");
  const [appointmentType, setAppointmentType] = useState<string>("consultation");
  const [duration, setDuration] = useState(30);
  const [note, setNote] = useState("");

  const handleTypeSelect = (typeId: string) => {
    setAppointmentType(typeId);
    const preset = APPOINTMENT_TYPES.find((t) => t.id === typeId);
    if (preset) {
      setDuration(preset.defaultDuration);
    }
  };

  const load = useCallback(async (target: string) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/appointments?date=${target}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setItems(payload as Appointment[]);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  useEffect(() => {
    if (patient || query.trim().length < 2) {
      setMatches([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/patients?q=${encodeURIComponent(query.trim())}`, {
          cache: "no-store",
        });
        if (response.ok) setMatches(await response.json());
      } catch {
        /* تجاهل الأخطاء العابرة */
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, patient]);

  const load_ = useMemo(() => dayLoad(items, date, CHAIRS), [items, date, CHAIRS]);

  const act = useCallback(
    async (run: () => Promise<Response>, after?: () => void) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setHint(null);
      try {
        const response = await run();
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          setError(payload?.message ?? "تعذّر تنفيذ الإجراء.");
          if (payload?.suggestionMessage) setHint(payload.suggestionMessage);
          if (payload?.suggestion) setTime(payload.suggestion);
        } else {
          setError(null);
          after?.();
        }
        await load(date);
      } catch {
        setError("تعذّر الاتصال بالخادم.");
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [date, load],
  );

  const book = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      let target = patient;
      if (!target) {
        const name = query.trim();
        if (!name) return;
        const response = await fetch("/api/patients", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fullName: name, phone: phone.trim() }),
        });
        if (!response.ok) {
          setError("تعذّر إنشاء المريض.");
          return;
        }
        target = await response.json();
        setPatient(target);
      }
      await act(
        () =>
          fetch("/api/appointments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              patientId: target!.id,
              date,
              time,
              durationMinutes: duration,
              appointmentType: appointmentType || undefined,
              note: note.trim() || undefined,
            }),
          }),
        () => {
          setPatient(null);
          setQuery("");
          setPhone("");
          setNote("");
          setMatches([]);
        },
      );
    },
    [act, appointmentType, date, duration, note, patient, phone, query, time],
  );

  // إدخال فوري للكرسي وقائمة الانتظار اليومية
  const handleDirectArrival = async (item: Appointment) => {
    await act(async () => {
      // 1. تحديث حالة الموعد إلى arrived
      await fetch(`/api/appointments/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "arrive" }),
      });
      // 2. إنشاء زيارة سريرية فورية لليوم إذا لم تكن موجودة
      const typeLabel = item.appointmentType ? getAppointmentTypeLabel(item.appointmentType) : null;
      const visitNote = [
        typeLabel ? `نوع الموعد: ${typeLabel}` : null,
        item.note ? `الملاحظة: ${item.note}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      return fetch("/api/visits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId: item.patientId,
          patientName: item.patientName,
          patientPhone: item.patientPhone,
          appointmentId: item.id,
          note: visitNote || "وصول عبر جدول المواعيد",
        }),
      });
    });
  };

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const matchStatus = statusFilter === "all" || item.status === statusFilter;
      const typeLabel = (item.appointmentType && getAppointmentTypeLabel(item.appointmentType)) || "";
      const q = searchQuery.toLowerCase().trim();
      const matchSearch =
        !q ||
        item.patientName.toLowerCase().includes(q) ||
        (item.patientPhone ?? "").includes(q) ||
        (item.note ?? "").toLowerCase().includes(q) ||
        typeLabel.toLowerCase().includes(q);
      return matchStatus && matchSearch;
    });
  }, [items, statusFilter, searchQuery]);

  const chairSchedules = useMemo(
    () => distributeAppointmentsToChairs(filteredItems, date, CHAIRS),
    [filteredItems, date, CHAIRS],
  );

  return (
    <main className="mx-auto max-w-5xl p-4 pb-24">
      <PageHeader
        title="جدول المواعيد والعيادات"
        subtitle="حجز وإدارة المواعيد مع التحويل الفوري لقائمة الانتظار وكراسي العلاج"
      >
        <div className="flex flex-wrap items-center gap-2">
          {/* محول نمط العرض بين القائمة والأجندة */}
          <div className="inline-flex rounded-xl border border-slate-200 bg-white p-0.5 shadow-xs">
            <button
              type="button"
              onClick={() => setViewMode("list")}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-black transition-all ${
                viewMode === "list" ? "bg-navy-800 text-white shadow-xs" : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              📋 قائمة
            </button>
            <button
              type="button"
              onClick={() => setViewMode("chairs")}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-black transition-all ${
                viewMode === "chairs" ? "bg-navy-800 text-white shadow-xs" : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              🪑 كراسي ({CHAIRS})
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="rounded-xl bg-brand-orange px-4 py-2 text-xs font-extrabold text-white shadow-xs transition-opacity hover:opacity-90"
          >
            + حجز موعد جديد
          </button>
        </div>
      </PageHeader>

      {/* شريط اختيار التاريخ والتنقل السريع */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setDate(addDaysToDate(date, -1))}
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100"
          >
            ‹ اليوم السابق
          </button>

          <button
            type="button"
            onClick={() => setDate(today)}
            className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
              date === today
                ? "bg-navy-800 text-white shadow-xs"
                : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            اليوم ({today})
          </button>

          <button
            type="button"
            onClick={() => setDate(addDaysToDate(today, 1))}
            className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
              date === addDaysToDate(today, 1)
                ? "bg-navy-800 text-white shadow-xs"
                : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            غداً
          </button>

          <button
            type="button"
            onClick={() => setDate(addDaysToDate(today, 2))}
            className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
              date === addDaysToDate(today, 2)
                ? "bg-navy-800 text-white shadow-xs"
                : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            بعد غد
          </button>

          <button
            type="button"
            onClick={() => setDate(addDaysToDate(date, 1))}
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100"
          >
            اليوم التالي ›
          </button>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-extrabold text-navy-900 outline-none focus:border-navy-800"
          />
        </div>
      </div>

      {/* شريط مؤشر حمولة اليوم وسعة الكراسي */}
      <div
        className={`mb-4 rounded-2xl border p-3.5 shadow-xs transition-colors ${
          load_.percent >= 90
            ? "border-red-300 bg-red-50"
            : load_.percent >= 70
            ? "border-amber-300 bg-amber-50"
            : "border-slate-200 bg-white"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-extrabold">
          <span className="text-navy-900">
            📊 استيعاب المواعيد ليوم {friendlyDateLong(date)}:{" "}
            <span className="text-navy-800">
              {load_.booked} {load_.booked === 1 ? "موعد" : "مواعيد"}
            </span>
          </span>
          <span className="text-slate-600">
            {Math.round((load_.bookedMinutes / 60) * 10) / 10} ساعة محجوزة من إجمالي طاقة {Math.round(load_.capacityMinutes / 60)} ساعة ({CHAIRS} كراسي)
          </span>
        </div>
        <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className={`h-full transition-all duration-300 ${
              load_.percent >= 90 ? "bg-red-500" : load_.percent >= 70 ? "bg-amber-500" : "bg-emerald-500"
            }`}
            style={{ width: `${Math.min(100, load_.percent)}%` }}
          />
        </div>
      </div>

      {/* نموذج الحجز السريع المدمج */}
      <form onSubmit={book} className="mb-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
        <h2 className="mb-3 text-xs font-extrabold text-navy-900">+ حجز موعد مباشر في هذا اليوم</h2>
        <div className="relative">
          <input
            value={patient ? patient.fullName : query}
            onChange={(event) => {
              setPatient(null);
              setQuery(event.target.value);
            }}
            placeholder="اسم المريض — اكتب للبحث في ملفات المرضى أو لإضافة جديد…"
            aria-label="اسم المريض"
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
          />
          {matches.length > 0 && !patient ? (
            <ul className="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl">
              {matches.map((match) => (
                <li key={match.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setPatient(match);
                      setMatches([]);
                    }}
                    className="w-full px-3 py-2 text-right text-xs hover:bg-navy-50"
                  >
                    <span className="font-extrabold text-navy-900">{match.fullName}</span>
                    <span className="mr-2 text-[11px] text-slate-400">
                      {match.patientNumber} {match.phone ? `· ${match.phone}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {!patient ? (
          <input
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            inputMode="tel"
            dir="ltr"
            placeholder="رقم الهاتف (في حال كان المريض جديداً)"
            aria-label="هاتف المريض"
            className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
          />
        ) : null}

        {/* اختيار نوع الموعد السريع */}
        <div className="mt-3">
          <label className="mb-1 block text-[11px] font-bold text-slate-700">نوع الإجراء / الموعد:</label>
          <div className="flex flex-wrap gap-1.5">
            {APPOINTMENT_TYPES.map((t) => {
              const isSelected = appointmentType === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => handleTypeSelect(t.id)}
                  className={`rounded-xl border px-2.5 py-1 text-xs font-bold transition-all ${
                    isSelected
                      ? "border-navy-800 bg-navy-900 text-white shadow-xs"
                      : `${t.badgeClass} hover:opacity-85`
                  }`}
                >
                  {t.shortLabel}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          <input
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
            aria-label="وقت الموعد"
            className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold outline-none focus:border-navy-800"
          />
          <select
            value={duration}
            onChange={(event) => setDuration(Number(event.target.value))}
            aria-label="مدة الموعد"
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
          >
            {DURATIONS.map((option) => (
              <option key={option.minutes} value={option.minutes}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="ملاحظات تفصيلية أو رقم السن…"
            className="rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
          />
          <button
            type="submit"
            disabled={busy || (!patient && !query.trim())}
            className="rounded-xl bg-navy-800 px-5 py-2 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            تأكيد الحجز
          </button>
        </div>
      </form>

      {error ? (
        <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-xs font-bold text-red-700">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p className="mb-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-xs font-bold text-blue-800">
          💡 {hint}
        </p>
      ) : null}

      {/* شريط الفلترة والبحث في جدول اليوم */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {["all", "booked", "arrived", "done", "no_show"].map((st) => {
            const count = st === "all" ? items.length : items.filter((i) => i.status === st).length;
            const isSelected = statusFilter === st;
            return (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
                  isSelected
                    ? "bg-navy-800 text-white shadow-xs"
                    : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {st === "all" ? "جميع الحالات" : STATUS_LABEL[st]} ({count})
              </button>
            );
          })}
        </div>

        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="🔍 بحث في مواعيد اليوم…"
          className="w-full sm:w-56 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs outline-none focus:border-navy-800"
        />
      </div>

      {/* قائمة المواعيد المجدولة */}
      <section aria-label="مواعيد اليوم">
        {loading ? (
          <p className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-400">
            جارٍ تحميل المواعيد…
          </p>
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-xs text-slate-400">
            لا توجد أي مواعيد محجوزة في هذا اليوم ({friendlyDateLong(date)}).
          </div>
        ) : filteredItems.length === 0 ? (
          <p className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-400">
            لا توجد مواعيد مطابقة لفلتر البحث.
          </p>
        ) : viewMode === "list" ? (
          <ul className="space-y-2.5">
            {filteredItems.map((item) => (
              <li
                key={item.id}
                className={`rounded-2xl border p-3.5 transition-all ${
                  item.status === "cancelled" || item.status === "no_show"
                    ? "border-slate-200 bg-slate-50 opacity-60"
                    : "border-slate-200 bg-white shadow-2xs hover:border-slate-300"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-black text-white">
                      {item.scheduledTime}
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <a
                          href={`/patients/${item.patientId}`}
                          className="truncate text-sm font-black text-navy-900 hover:text-navy-700"
                        >
                          {item.patientName}
                        </a>
                        {item.appointmentType ? (
                          <span
                            className={`rounded-lg border px-2 py-0.5 text-[10px] font-extrabold ${getAppointmentTypeBadge(
                              item.appointmentType,
                            )}`}
                          >
                            {getAppointmentTypeLabel(item.appointmentType)}
                          </span>
                        ) : null}
                        <span
                          className={`rounded-lg border px-2 py-0.5 text-[10px] font-bold ${
                            STATUS_COLOR[item.status] ?? "bg-slate-100 text-slate-700"
                          }`}
                        >
                          {STATUS_LABEL[item.status] ?? item.status}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {item.durationMinutes} دقيقة
                        {item.patientPhone ? ` · 📞 ${item.patientPhone}` : ""}
                        {item.note ? ` · 📝 ${item.note}` : ""}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {item.status === "booked" || item.status === "no_show" ? (
                      <>
                        <ReminderButton
                          item={item}
                          onSent={() =>
                            act(() =>
                              fetch(`/api/appointments/${item.id}`, {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ action: "reminded" }),
                              }),
                            )
                          }
                        />
                        {item.status === "booked" && <ConfirmationButton item={item} />}
                      </>
                    ) : null}

                    {item.status === "booked" ? (
                      <>
                        <button
                          onClick={() => handleDirectArrival(item)}
                          disabled={busy}
                          className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-extrabold text-white hover:bg-emerald-700 disabled:opacity-40"
                          title="تسجيل وصول المريض وإرساله لقائمة الانتظار مباشرة"
                        >
                          🪑 وصل للعيادة
                        </button>
                        <button
                          onClick={() =>
                            act(() =>
                              fetch(`/api/appointments/${item.id}`, {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ action: "no_show" }),
                              }),
                            )
                          }
                          disabled={busy}
                          className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                        >
                          لم يحضر
                        </button>
                        <button
                          onClick={() =>
                            act(() =>
                              fetch(`/api/appointments/${item.id}`, {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ action: "cancel" }),
                              }),
                            )
                          }
                          disabled={busy}
                          className="rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-red-500 hover:bg-red-50 disabled:opacity-40"
                        >
                          إلغاء
                        </button>
                      </>
                    ) : null}

                    {/* حذف الموعد نهائيًا — المدير وحده (الملغى والمحجوز غير الواصل). */}
                    {admin && (item.status === "booked" || item.status === "cancelled" || item.status === "no_show") ? (
                      <button
                        onClick={() => {
                          if (
                            !window.confirm(
                              `حذف موعد ${item.patientName} نهائيًا؟\nالحذف يمحو الموعد من الجدول ويُسجَّل في التدقيق — بلا تراجع.`,
                            )
                          )
                            return;
                          void act(() =>
                            fetch(`/api/appointments/${item.id}`, {
                              method: "DELETE",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ reason: "حذف من صفحة المواعيد" }),
                            }),
                          );
                        }}
                        disabled={busy}
                        className="rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-bold text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-40"
                        title="حذف الموعد نهائيًا — للمدير؛ يُسجَّل في سجل التدقيق"
                      >
                        🗑 حذف
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          /* عرض أجندة الكراسي المتزامنة */
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {chairSchedules.map((cs) => (
              <div key={cs.chair} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
                <div className="mb-3 flex items-center justify-between border-b border-slate-100 pb-2.5">
                  <div className="flex items-center gap-2">
                    <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-navy-800 text-xs font-black text-white">
                      {cs.chair}
                    </span>
                    <h3 className="text-sm font-black text-navy-900">الكرسي رقم {cs.chair}</h3>
                  </div>
                  <span className="rounded-lg bg-slate-100 px-2.5 py-0.5 text-xs font-bold text-slate-600">
                    {cs.appointments.length} {cs.appointments.length === 1 ? "موعد" : "مواعيد"}
                  </span>
                </div>

                {cs.appointments.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-400">
                    لا توجد مواعيد لهذا الكرسي اليوم.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {cs.appointments.map((item) => (
                      <div
                        key={item.id}
                        className={`rounded-xl border p-3 transition-all ${
                          item.status === "cancelled" || item.status === "no_show"
                            ? "border-slate-200 bg-slate-50 opacity-60"
                            : "border-slate-200 bg-white hover:border-slate-300 shadow-2xs"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="rounded-md bg-navy-900 px-2 py-0.5 text-[11px] font-black text-white">
                            {item.scheduledTime}
                          </span>
                          <span
                            className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${
                              STATUS_COLOR[item.status] ?? "bg-slate-100 text-slate-700"
                            }`}
                          >
                            {STATUS_LABEL[item.status] ?? item.status}
                          </span>
                        </div>

                        <a
                          href={`/patients/${item.patientId}`}
                          className="mt-2 block truncate text-xs font-black text-navy-900 hover:text-navy-700"
                        >
                          {item.patientName}
                        </a>

                        {item.appointmentType ? (
                          <div className="mt-1">
                            <span
                              className={`inline-block rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${getAppointmentTypeBadge(
                                item.appointmentType,
                              )}`}
                            >
                              {getAppointmentTypeLabel(item.appointmentType)}
                            </span>
                          </div>
                        ) : null}

                        <p className="mt-1 text-[11px] text-slate-500">
                          ⏱ {item.durationMinutes} د
                          {item.patientPhone ? ` · 📞 ${item.patientPhone}` : ""}
                        </p>

                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2">
                          {item.status === "booked" && (
                            <button
                              type="button"
                              onClick={() => void handleDirectArrival(item)}
                              disabled={busy}
                              className="rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-emerald-700 transition-colors"
                              title="تحويل المريض مباشرة للكرسي وبدء الزيارة"
                            >
                              🪑 إدخال
                            </button>
                          )}
                          <ReminderButton item={item} onSent={() => void load(date)} />
                          <ConfirmationButton item={item} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* نافذة حجز موعد منبثقة */}
      <QuickAppointmentModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        onSuccess={() => {
          setShowAddModal(false);
          void load(date);
        }}
      />
    </main>
  );
}

function ConfirmationButton({ item }: { item: Appointment }) {
  const number = toWhatsAppNumber(item.patientPhone);
  if (!number) return null;
  const text = bookingConfirmationText(item);
  const link = `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
  return (
    <a
      href={link}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-xl border border-sky-300 bg-sky-50 px-2.5 py-1.5 text-xs font-bold text-sky-800 hover:bg-sky-100 transition-colors"
      title="إرسال رسالة تأكيد الحجز الفوري للمريض عبر واتساب"
    >
      📲 تأكيد
    </a>
  );
}

function ReminderButton({ item, onSent }: { item: Appointment; onSent: () => void }) {
  const link = whatsAppLink(item, item.status === "no_show" ? "missed" : "upcoming");
  if (!link) {
    return <span className="rounded-xl bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-400">بلا رقم</span>;
  }
  const reminded = Boolean(item.reminderSentAt);
  // قاعدة الاثنتي عشرة ساعة: الضغطة الثانية قبل مرور النافذة تسأل قبل أن تُرسل —
  // رسالتان في دقيقتين تقولان للمريض إن العيادة روبوت.
  const needsOverride = reminderNeedsOverride(item.reminderSentAt);
  return (
    <a
      href={link}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        if (needsOverride && !window.confirm("ذُكِّر هذا المريض قبل أقل من ١٢ ساعة. أرسل تذكيرًا ثانيًا رغم ذلك؟")) {
          event.preventDefault();
          return;
        }
        onSent();
      }}
      title={reminded && item.reminderSentAt ? `آخر تذكير: ${new Date(item.reminderSentAt).toLocaleString("ar", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "numeric" })}` : undefined}
      className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-opacity hover:opacity-90 ${
        needsOverride || reminded
          ? "border border-emerald-300 bg-emerald-50 text-emerald-700"
          : "bg-[#25D366] text-white shadow-2xs"
      }`}
    >
      {needsOverride ? "إعادة تذكير؟" : reminded ? "ذُكِّر ✓" : "💬 تذكير واتساب"}
    </a>
  );
}
