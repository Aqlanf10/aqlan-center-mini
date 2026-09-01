"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClinicName, useSetting } from "@/components/SettingsProvider";
import { CURRENCIES, CURRENCY_LABEL, isCurrency, type Currency } from "@/lib/money";
import { friendlyDateLong, toWhatsAppNumber } from "@/lib/reminders";
import { addDays, clinicDateString } from "@/lib/schedule";
import {
  LAB_FILTER_LABEL,
  LAB_STATUS_LABEL,
  WORK_TYPES,
  daysLate,
  filterOrders,
  labFollowUpText,
  labSummary,
  patientReadyText,
  sortByUrgency,
  type LabFilter,
  type LabOrder,
  type LabOrderStatus,
} from "@/lib/lab";
import { PageHeader, StatCard as Stat } from "@/components/PageHeader";

/**
 * أعمال المختبر ومعامل الأسنان — تتبع التراكيب، تسليم الأجهزة، والتواصل المباشر مع المعامل والمرضى.
 */

interface Patient {
  id: number;
  patientNumber: string;
  fullName: string;
  phone: string | null;
}

interface LabFeed {
  orders: LabOrder[];
  labs: { labName: string; labPhone: string | null }[];
}

const FILTERS: LabFilter[] = ["pending", "late", "outstanding", "received", "all"];

export default function LabPage() {
  const clinicName = useClinicName();
  const baseSettingValue = useSetting("finance.base_currency");
  const clinicPhone = useSetting("clinic.phone");
  const labDays = Number(useSetting("lab.default_days")) || 7;
  const [feed, setFeed] = useState<LabFeed>({ orders: [], labs: [] });
  const [filter, setFilter] = useState<LabFilter>("late");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const inFlight = useRef(false);

  // Search & Filter
  const [search, setSearch] = useState("");

  const today = useMemo(() => clinicDateString(new Date(), "Asia/Aden"), []);

  // Form State
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Patient[]>([]);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [labName, setLabName] = useState("");
  const [labPhone, setLabPhone] = useState("");
  const [labParties, setLabParties] = useState<{ id: number; name: string }[]>([]);
  const [partyId, setPartyId] = useState("");
  const [cost, setCost] = useState("");
  const [costCurrency, setCostCurrency] = useState<Currency>(
    isCurrency(baseSettingValue) ? baseSettingValue : "YER",
  );
  const [workType, setWorkType] = useState(WORK_TYPES[0]);
  const [details, setDetails] = useState("");
  const [toothNumber, setToothNumber] = useState("");
  const [sentDate, setSentDate] = useState(today);
  const [dueDate, setDueDate] = useState(() => addDays(today, labDays));

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const response = await fetch("/api/lab", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setFeed(payload as LabFeed);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/parties?kind=lab", { cache: "no-store" });
        if (response.ok) setLabParties(await response.json());
      } catch {
        /* تجاهل */
      }
    })();
  }, []);

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
        /* تجاهل */
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, patient]);

  const act = useCallback(
    async (run: () => Promise<Response>) => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setBusy(true);
      try {
        const response = await run();
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          setError(payload?.message ?? "تعذّر تنفيذ الإجراء.");
          await load(false);
          return false;
        }
        setError(null);
        await load(false);
        return true;
      } catch {
        setError("تعذّر الاتصال بالخادم.");
        return false;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [load],
  );

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!patient) {
        setError("اختر المريض من نتائج البحث.");
        return;
      }
      const fullDetails = toothNumber ? `السن ${toothNumber} - ${details}` : details;
      const ok = await act(() =>
        fetch("/api/lab", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            patientId: patient.id,
            labName,
            labPhone,
            workType,
            details: fullDetails,
            sentDate,
            dueDate,
            partyId: partyId || undefined,
            cost,
            costCurrency,
          }),
        }),
      );
      if (ok) {
        setPatient(null);
        setQuery("");
        setDetails("");
        setToothNumber("");
        setCost("");
        setSentDate(today);
        setDueDate(addDays(today, labDays));
        setAdding(false);
        setFilter("outstanding");
      }
    },
    [
      act,
      patient,
      toothNumber,
      details,
      labName,
      labPhone,
      workType,
      sentDate,
      dueDate,
      partyId,
      cost,
      costCurrency,
      today,
      labDays,
    ],
  );

  const updateOrderStatus = async (orderId: number, status: LabOrderStatus) => {
    await act(() =>
      fetch(`/api/lab/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }),
    );
  };

  const summary = useMemo(() => labSummary(feed.orders, today), [feed.orders, today]);

  const visible = useMemo(() => {
    let list = filterOrders(feed.orders, filter, today);
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter(
        (o) =>
          o.patientName.toLowerCase().includes(q) ||
          o.labName.toLowerCase().includes(q) ||
          o.workType.toLowerCase().includes(q) ||
          (o.details ?? "").toLowerCase().includes(q),
      );
    }
    return sortByUrgency(list, today);
  }, [feed.orders, filter, today, search]);

  return (
    <main className="mx-auto max-w-4xl p-4 pb-24">
      <PageHeader
        title="أعمال المختبر ومعامل الأسنان"
        subtitle="متابعة تراكيب الزيركون، البورسلين، والأجهزة التقويمية ومواعيد الاستلام والتسليم"
      >
        {!adding ? (
          <button
            onClick={() => setAdding(true)}
            className="rounded-xl bg-brand-orange px-4 py-2 text-xs font-extrabold text-white shadow-xs hover:opacity-90"
          >
            + إرسال عمل جديد للمختبر
          </button>
        ) : null}
      </PageHeader>

      {/* ملخص إحصاءات أعمال المختبر */}
      <section className="mb-4 grid grid-cols-3 gap-2" aria-label="ملخص المختبر">
        <Stat label="متأخرة عن الموعد" value={summary.late} tone={summary.late > 0 ? "bad" : "calm"} />
        <Stat label="تستحق اليوم" value={summary.dueToday} tone={summary.dueToday > 0 ? "warn" : "calm"} />
        <Stat label="وصلت بالعيادة جاهزة للتركيب" value={summary.waitingFitting} tone={summary.waitingFitting > 0 ? "warn" : "calm"} />
      </section>

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-xs font-bold text-red-700">
          {error}
        </p>
      ) : null}

      {/* نموذج إضافة عمل مخبري جديد */}
      {adding && (
        <form onSubmit={submit} className="mb-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-extrabold text-navy-900">+ تسجيل عمل مخبري جديد</h2>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="text-xs font-bold text-slate-500 hover:text-slate-700"
            >
              إلغاء ✕
            </button>
          </div>

          {patient ? (
            <div className="mb-3 flex items-center justify-between gap-2 rounded-xl border border-navy-800 bg-navy-50/50 px-3 py-2">
              <div>
                <span className="text-xs font-extrabold text-navy-900">{patient.fullName}</span>
                <span className="mr-2 text-[11px] text-slate-500">{patient.patientNumber}</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setPatient(null);
                  setQuery("");
                }}
                className="text-xs font-bold text-navy-800 hover:underline"
              >
                تغيير
              </button>
            </div>
          ) : (
            <div className="relative mb-3">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="ابحث عن المريض بالاسم أو رقم الملف…"
                aria-label="بحث عن المريض"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
              {matches.length > 0 ? (
                <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl">
                  {matches.map((match) => (
                    <li key={match.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setPatient(match);
                          setMatches([]);
                        }}
                        className="w-full px-3 py-2 text-right text-xs hover:bg-slate-50"
                      >
                        <span className="font-bold text-navy-900">{match.fullName}</span>
                        <span className="mr-2 text-slate-400">{match.patientNumber}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] font-bold text-slate-500">نوع العمل المخبري</label>
              <select
                value={workType}
                onChange={(event) => setWorkType(event.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
              >
                {WORK_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-bold text-slate-500">رقم السن / الأسنان</label>
              <input
                value={toothNumber}
                onChange={(e) => setToothNumber(e.target.value)}
                placeholder="مثال: 16 أو 21-22 أو فك كامل"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
            </div>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] font-bold text-slate-500">المختبر / المعمل</label>
              <input
                value={labName}
                onChange={(event) => setLabName(event.target.value)}
                list="labs"
                placeholder="اسم المختبر"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
              <datalist id="labs">
                {feed.labs.map((lab) => (
                  <option key={lab.labName} value={lab.labName} />
                ))}
              </datalist>
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-bold text-slate-500">جوال المختبر (للمتابعة عبر واتساب)</label>
              <input
                value={labPhone}
                onChange={(event) => setLabPhone(event.target.value)}
                dir="ltr"
                inputMode="tel"
                placeholder="رقم هاتف المختبر"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
            </div>
          </div>

          <div className="mt-3">
            <label className="mb-1 block text-[11px] font-bold text-slate-500">المواصفات واللون والتفاصيل</label>
            <input
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              placeholder="مثال: لون A2، حافة زيركون، تشريح عالي، مع دعامة مخصصة"
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
            />
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] font-bold text-slate-500">تاريخ الإرسال</label>
              <input
                type="date"
                value={sentDate}
                onChange={(e) => setSentDate(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-bold text-slate-500">تاريخ الاستحقاق المتوقع</label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
            </div>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] font-bold text-slate-500">التكلفة (اختياري)</label>
              <input
                type="number"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                placeholder="تكلفة المختبر"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-navy-800"
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-bold text-slate-500">العملة</label>
              <select
                value={costCurrency}
                onChange={(e) => setCostCurrency(e.target.value as Currency)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {CURRENCY_LABEL[c]} ({c})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={busy || !patient}
              className="rounded-xl bg-navy-800 px-5 py-2 text-xs font-bold text-white shadow-xs hover:opacity-90 disabled:opacity-40"
            >
              حفظ وإرسال الطلب
            </button>
          </div>
        </form>
      )}

      {/* شريط الفلترة والبحث */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-xs">
        <div className="flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-all ${
                filter === f
                  ? "bg-navy-800 text-white shadow-xs"
                  : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
              }`}
            >
              {LAB_FILTER_LABEL[f]}
            </button>
          ))}
        </div>

        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 بحث بالمريض أو المختبر…"
          className="w-full sm:w-56 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs outline-none focus:border-navy-800"
        />
      </div>

      {/* قائمة أعمال المختبر */}
      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-400">
          جارٍ تحميل أعمال المختبر…
        </p>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-xs text-slate-400">
          لا توجد أعمال تطابق الفلتر المحدد.
        </div>
      ) : (
        <ul className="space-y-3">
          {visible.map((order) => {
            const lateDays = daysLate(order, today);
            const isLate = lateDays > 0;
            const patientWa = toWhatsAppNumber(order.patientPhone);
            const labWa = toWhatsAppNumber(order.labPhone);

            // نصوص رسائل واتساب
            const patientMsg = patientReadyText(order, clinicName, clinicPhone);
            const labMsg = labFollowUpText(order, today, clinicName);

            return (
              <li
                key={order.id}
                className={`rounded-2xl border p-4 shadow-2xs transition-all ${
                  order.status === "delivered"
                    ? "border-slate-200 bg-slate-50/60 opacity-75"
                    : order.status === "received"
                    ? "border-emerald-200 bg-emerald-50/30"
                    : isLate
                    ? "border-red-300 bg-red-50/40"
                    : "border-slate-200 bg-white"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={`/patients/${order.patientId}`}
                        className="text-sm font-black text-navy-900 hover:underline underline-offset-4"
                      >
                        {order.patientName}
                      </a>
                      <span className="rounded-lg bg-navy-100 px-2 py-0.5 text-[11px] font-bold text-navy-900">
                        {order.workType}
                      </span>
                      {order.toothCode ? (
                        <span className="rounded-lg bg-navy-50 px-2 py-0.5 text-[10px] font-bold text-navy-800">
                          سن {order.toothCode}
                        </span>
                      ) : null}
                      {order.source === "auto" ? (
                        <span className="rounded-lg bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-800">
                          من الزيارة
                        </span>
                      ) : null}
                      {/* المختبرات السنية V2: الأرقام والألوان والأولوية والطبيب — سياق
                          العمل كما يقرؤه المختبر والطبيب على الطلب نفسه. */}
                      {order.toothNumbers ? (
                        <span className="rounded-lg bg-navy-50 px-2 py-0.5 text-[10px] font-bold text-navy-800">
                          أسنان: {order.toothNumbers}
                        </span>
                      ) : null}
                      {order.shade ? (
                        <span className="rounded-lg bg-violet-100 px-2 py-0.5 text-[10px] font-bold text-violet-800">
                          لون: {order.shade}
                        </span>
                      ) : null}
                      {order.priority === "urgent" || order.priority === "rush" ? (
                        <span className={`rounded-lg px-2 py-0.5 text-[10px] font-bold ${
                          order.priority === "rush" ? "bg-red-200 text-red-800" : "bg-amber-200 text-amber-900"
                        }`}>
                          {order.priority === "rush" ? "طارئ جدًا" : "عاجل"}
                        </span>
                      ) : null}
                      {order.doctorName ? (
                        <span className="rounded-lg bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                          {order.doctorName}
                        </span>
                      ) : null}
                      <span
                        className={`rounded-lg px-2 py-0.5 text-[10px] font-bold ${
                          order.status === "needed"
                            ? "bg-sky-100 text-sky-800"
                            : order.status === "in_progress"
                            ? "bg-violet-100 text-violet-800"
                            : order.status === "remake"
                            ? "bg-red-100 text-red-700"
                            : order.status === "delivered"
                            ? "bg-slate-200 text-slate-700"
                            : order.status === "received"
                            ? "bg-emerald-200 text-emerald-800"
                            : isLate
                            ? "bg-red-200 text-red-800"
                            : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        {order.status === "needed"
                          ? "لم يُرسل بعد — من إجراء الزيارة"
                          : order.status === "in_progress"
                          ? "قيد التصنيع في المعمل"
                          : order.status === "remake"
                          ? "إعادة تصنيع (Remake)"
                          : order.status === "delivered"
                          ? "تم التركيب للمريض ✓"
                          : order.status === "received"
                          ? "وصل للعيادة (بانتظار التركيب)"
                          : isLate
                          ? `متأخر ${lateDays} يوم`
                          : "عند المختبر"}
                      </span>
                    </div>

                    <p className="mt-1 text-xs text-slate-600">
                      معمل: <span className="font-bold text-navy-800">{order.labName}</span>
                      {order.details ? ` · ${order.details}` : ""}
                    </p>

                    <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                      {order.status === "needed" ? (
                        <span>أُنشئ من توقيع الزيارة — أكمل بيانات المختبر ثم أرسله</span>
                      ) : (
                        <span>تاريخ الإرسال: {order.sentDate}</span>
                      )}
                      <span>موعد الاستحقاق: {friendlyDateLong(order.dueDate)}</span>
                      {order.receivedAt ? <span>استُلم بتاريخ: {order.receivedAt}</span> : null}
                    </div>
                  </div>

                  {/* الإجراءات وتحديث الحالة وتنبيهات واتساب */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {order.status === "needed" && (
                      <>
                        <button
                          type="button"
                          onClick={() => updateOrderStatus(order.id, "sent")}
                          disabled={busy}
                          className="rounded-xl bg-sky-600 px-3 py-1.5 text-xs font-bold text-white shadow-2xs hover:bg-sky-700 disabled:opacity-40"
                        >
                          📦 أُرسل للمعمل
                        </button>
                        <button
                          type="button"
                          onClick={() => updateOrderStatus(order.id, "cancelled")}
                          disabled={busy}
                          className="rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                        >
                          إلغاء
                        </button>
                      </>
                    )}

                    {order.status === "sent" && (
                      <>
                        {/* المختبرات السنية V2: مراحل التصنيع تُرى كما يراها المعمل. */}
                        <button
                          type="button"
                          onClick={() => updateOrderStatus(order.id, "in_progress")}
                          disabled={busy}
                          className="rounded-xl border border-violet-300 bg-violet-50 px-2.5 py-1.5 text-xs font-bold text-violet-800 hover:bg-violet-100 disabled:opacity-40"
                        >
                          ⚙️ بدأ المعمل التصنيع
                        </button>
                        <button
                          type="button"
                          onClick={() => updateOrderStatus(order.id, "received")}
                          disabled={busy}
                          className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white shadow-2xs hover:bg-emerald-700 disabled:opacity-40"
                        >
                          ✓ تم الاستلام من المعمل
                        </button>
                      </>
                    )}

                    {order.status === "in_progress" && (
                      <button
                        type="button"
                        onClick={() => updateOrderStatus(order.id, "received")}
                        disabled={busy}
                        className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white shadow-2xs hover:bg-emerald-700 disabled:opacity-40"
                      >
                        ✓ تم الاستلام من المعمل
                      </button>
                    )}

                    {order.status === "received" && (
                      <>
                        {patientWa ? (
                          <a
                            href={`https://wa.me/${patientWa}?text=${encodeURIComponent(patientMsg)}`}
                            target="_blank"
                            rel="noopener"
                            className="rounded-xl bg-[#25D366] px-3 py-1.5 text-xs font-bold text-white shadow-2xs hover:opacity-90"
                          >
                            💬 إشعار المريض بالوصول
                          </a>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => updateOrderStatus(order.id, "delivered")}
                          disabled={busy}
                          className="rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-bold text-white shadow-2xs hover:opacity-90 disabled:opacity-40"
                        >
                          🦷 تم التركيب والتسليم
                        </button>
                        {/* المختبرات السنية V2: إعادة التصنيع — العمل المعيب يعود
                            للمعمل بطلبٍ جديد لا يُلغي الأثر القديم. */}
                        <button
                          type="button"
                          onClick={() => updateOrderStatus(order.id, "remake")}
                          disabled={busy}
                          className="rounded-xl border border-red-300 bg-red-50 px-2.5 py-1.5 text-xs font-bold text-red-700 hover:bg-red-100 disabled:opacity-40"
                        >
                          ↺ إعادة تصنيع
                        </button>
                      </>
                    )}

                    {order.status === "sent" && labWa && (
                      <a
                        href={`https://wa.me/${labWa}?text=${encodeURIComponent(labMsg)}`}
                        target="_blank"
                        rel="noopener"
                        className="rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
                      >
                        استعجال المعمل
                      </a>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
