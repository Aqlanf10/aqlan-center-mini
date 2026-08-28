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
} from "@/lib/lab";
import { PageHeader } from "@/components/PageHeader";
import { StatCard as Stat } from "@/components/PageHeader";

/**
 * أعمال المختبر — «تراكم التراكيب» بنصّ كلام المالك.
 *
 * مشكلة مختلفة عن الزحمة والمواعيد: لا أحد يشتكي منها في الصالة، بل تظهر يوم يجلس
 * المريض على الكرسي ليركّب تاجه فيُكتشف أنه لم يصل — وقد قُطع له وعدٌ بيوم. فالشاشة
 * تفتح على **المتأخر** لا على «الكل»: القائمة التي لا يكون أعلاها أهمّها تُقرأ مرة
 * ثم تُهجَر.
 */

interface Patient { id: number; patientNumber: string; fullName: string; phone: string | null }
interface LabFeed { orders: LabOrder[]; labs: { labName: string; labPhone: string | null }[] }

const FILTERS: LabFilter[] = ["late", "outstanding", "received", "all"];

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

  // اليوم بتوقيت العيادة لا بـUTC: بعد التاسعة مساءً بغرينتش يكون التاريخ في تعز قد
  // انتقل، فيُحسب عمل يستحق غدًا كأنه متأخر — أو العكس.
  const today = useMemo(() => clinicDateString(new Date(), "Asia/Aden"), []);

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

  useEffect(() => { void load(true); }, [load]);

  // المختبرات المسجّلة كجهات: التكلفة لا تُسجَّل إلا عليها، وإلا صارت رقمًا بلا
  // مَن يُطالَب به.
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/parties?kind=lab", { cache: "no-store" });
        if (response.ok) setLabParties(await response.json());
      } catch { /* القائمة تبقى فارغة والتكلفة تبقى اختيارية */ }
    })();
  }, []);

  useEffect(() => {
    if (patient || query.trim().length < 2) { setMatches([]); return; }
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/patients?q=${encodeURIComponent(query.trim())}`, { cache: "no-store" });
        if (response.ok) setMatches(await response.json());
      } catch { /* بحث فاشل يترك القائمة كما هي */ }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, patient]);

  const act = useCallback(async (run: () => Promise<Response>) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await run();
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّر تنفيذ الإجراء."); await load(false); return false; }
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
  }, [load]);

  const submit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!patient) { setError("اختر المريض من نتائج البحث."); return; }
    const ok = await act(() => fetch("/api/lab", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        patientId: patient.id, labName, labPhone, workType, details, sentDate, dueDate,
        partyId: partyId || undefined, cost, costCurrency,
      }),
    }));
    if (ok) {
      setPatient(null); setQuery(""); setDetails(""); setCost("");
      setSentDate(today); setDueDate(addDays(today, labDays));
      setAdding(false);
      setFilter("outstanding");
    }
  }, [act, patient, labName, labPhone, workType, details, sentDate, dueDate, today, labDays, partyId, cost, costCurrency]);

  const summary = useMemo(() => labSummary(feed.orders, today), [feed.orders, today]);
  const visible = useMemo(
    () => sortByUrgency(filterOrders(feed.orders, filter, today), today),
    [feed.orders, filter, today],
  );

  return (
    <main className="mx-auto max-w-3xl p-4 pb-24">
      <PageHeader
        title="أعمال المختبر"
        subtitle="التراكيب والأجهزة — ما تأخّر أولًا"
      />

      <section className="mb-4 grid grid-cols-3 gap-2" aria-label="ملخص المختبر">
        <Stat label="متأخرة" value={summary.late} tone={summary.late > 0 ? "bad" : "calm"} />
        <Stat label="تستحق اليوم" value={summary.dueToday} tone={summary.dueToday > 0 ? "warn" : "calm"} />
        <Stat label="وصلت ولم تُركّب" value={summary.waitingFitting} tone={summary.waitingFitting > 0 ? "warn" : "calm"} />
      </section>

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {!adding ? (
        <button
          onClick={() => setAdding(true)}
          className="mb-4 w-full rounded-2xl bg-brand-orange py-3 text-sm font-extrabold text-white"
        >
          + أرسلت عملًا للمختبر
        </button>
      ) : (
        <form onSubmit={submit} className="mb-5 rounded-2xl border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-bold">عمل جديد</h2>

          {patient ? (
            <div className="mb-3 flex items-center justify-between gap-2 rounded-xl border border-brand-blue bg-white px-3 py-2">
              <span className="truncate text-sm font-bold">{patient.fullName}</span>
              <button type="button" onClick={() => { setPatient(null); setQuery(""); }} className="text-xs font-bold text-slate-500">تغيير</button>
            </div>
          ) : (
            <>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="ابحث عن المريض بالاسم أو الرقم"
                aria-label="بحث عن المريض"
                className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue"
              />
              {matches.length > 0 ? (
                <ul className="mb-3 space-y-1">
                  {matches.map((match) => (
                    <li key={match.id}>
                      <button
                        type="button"
                        onClick={() => { setPatient(match); setMatches([]); }}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-right text-sm"
                      >
                        {match.fullName}
                        <span className="mr-2 text-xs text-slate-400">{match.patientNumber}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}

          <label className="mb-1 block text-[11px] font-bold text-slate-500">نوع العمل</label>
          <select
            value={workType}
            onChange={(event) => setWorkType(event.target.value)}
            className="mb-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            {WORK_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>

          <label className="mb-1 block text-[11px] font-bold text-slate-500">المختبر</label>
          <input
            value={labName}
            onChange={(event) => setLabName(event.target.value)}
            list="labs"
            placeholder="اسم المختبر"
            className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
          <datalist id="labs">
            {feed.labs.map((lab) => <option key={lab.labName} value={lab.labName} />)}
          </datalist>
          <input
            value={labPhone}
            onChange={(event) => setLabPhone(event.target.value)}
            dir="ltr"
            inputMode="tel"
            placeholder="جوال المختبر (للمتابعة بواتساب)"
            className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />

          <input
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            placeholder="تفاصيل — مثل: 6 علوي يمين، لون A2"
            className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />

          <label className="mb-1 block text-[11px] font-bold text-slate-500">المختبر المسجّل (لتسجيل التكلفة عليه)</label>
          <select
            value={partyId}
            onChange={(event) => {
              setPartyId(event.target.value);
              const party = labParties.find((item) => String(item.id) === event.target.value);
              if (party) setLabName(party.name);
            }}
            className="mb-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">— بلا تسجيل تكلفة —</option>
            {labParties.map((party) => (
              <option key={party.id} value={party.id}>{party.name}</option>
            ))}
          </select>

          {partyId ? (
            <div className="mb-3 flex flex-wrap gap-2">
              <input
                value={cost}
                onChange={(event) => setCost(event.target.value)}
                placeholder="تكلفة العمل"
                aria-label="تكلفة العمل"
                inputMode="decimal"
                dir="ltr"
                className="min-w-[8rem] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
              <select
                value={costCurrency}
                onChange={(event) => setCostCurrency(event.target.value as Currency)}
                aria-label="عملة التكلفة"
                className="w-36 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
              >
                {CURRENCIES.map((currency) => (
                  <option key={currency} value={currency}>{CURRENCY_LABEL[currency]}</option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="mb-3 flex flex-wrap gap-2">
            <label className="min-w-[8rem] flex-1">
              <span className="mb-1 block text-[11px] font-bold text-slate-500">أُرسل في</span>
              <input
                type="date"
                value={sentDate}
                onChange={(event) => { setSentDate(event.target.value); setDueDate(addDays(event.target.value, labDays)); }}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </label>
            <label className="min-w-[8rem] flex-1">
              <span className="mb-1 block text-[11px] font-bold text-slate-500">موعد التسليم</span>
              <input
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </label>
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !patient || !labName.trim()}
              className="flex-1 rounded-xl bg-brand-orange py-2.5 text-sm font-extrabold text-white disabled:opacity-50"
            >
              احفظ
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-600"
            >
              إلغاء
            </button>
          </div>
        </form>
      )}

      <div className="mb-3 flex flex-wrap gap-1.5">
        {FILTERS.map((option) => (
          <button
            key={option}
            onClick={() => setFilter(option)}
            className={`rounded-xl border px-3 py-1.5 text-xs font-bold ${
              filter === option ? "border-navy-800 bg-navy-800 text-white" : "border-slate-200 bg-white text-slate-600"
            }`}
          >
            {LAB_FILTER_LABEL[option]}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : visible.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          {filter === "late" ? "لا يوجد عمل متأخر. " : "لا توجد أعمال في هذه القائمة."}
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((order) => (
            <OrderCard key={order.id} order={order} today={today} busy={busy} act={act}
              clinicName={clinicName} clinicPhone={clinicPhone} />
          ))}
        </ul>
      )}
    </main>
  );
}

function OrderCard({ order, today, busy, act, clinicName, clinicPhone }: {
  order: LabOrder;
  today: string;
  busy: boolean;
  act: (run: () => Promise<Response>) => Promise<boolean>;
  clinicName: string;
  clinicPhone: string;
}) {
  const late = daysLate(order, today);
  const labNumber = toWhatsAppNumber(order.labPhone);
  const patientNumber = toWhatsAppNumber(order.patientPhone);

  const setStatus = (status: string) => act(() => fetch(`/api/lab/${order.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  }));

  const postpone = (days: number) => act(() => fetch(`/api/lab/${order.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dueDate: addDays(today, days) }),
  }));

  return (
    <li className={`rounded-2xl border p-3 ${
      late > 0 ? "border-red-300 bg-red-50"
        : order.status === "received" ? "border-emerald-300 bg-emerald-50"
        : "border-slate-200 bg-white"
    }`}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-[10rem] flex-1">
          <a href={`/patients/${order.patientId}`} className="block truncate text-base font-extrabold underline decoration-slate-300 underline-offset-4">
            {order.patientName}
          </a>
          <p className="text-sm font-bold text-navy-800">
            {order.workType}{order.details ? ` — ${order.details}` : ""}
          </p>
          <p className="text-xs text-slate-500">
            {order.labName} · التسليم {friendlyDateLong(order.dueDate)} · {LAB_STATUS_LABEL[order.status]}
          </p>
        </div>
        {late > 0 ? (
          <span className="shrink-0 rounded-full bg-red-500 px-2.5 py-1 text-xs font-extrabold text-white">
            متأخر {late} {late === 1 ? "يوم" : "أيام"}
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {order.status === "sent" ? (
          <>
            <button onClick={() => setStatus("received")} disabled={busy}
              className="rounded-xl bg-navy-800 px-3 py-2 text-xs font-bold text-white disabled:opacity-40">
              وصل العيادة
            </button>
            {labNumber ? (
              <a
                href={`https://wa.me/${labNumber}?text=${encodeURIComponent(labFollowUpText(order, today, clinicName))}`}
                target="_blank"
                rel="noopener"
                className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white"
              >
                تابِع المختبر
              </a>
            ) : (
              <span className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-400">
                بلا رقم مختبر
              </span>
            )}
            <button onClick={() => postpone(3)} disabled={busy}
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-600 disabled:opacity-40">
              وعد بعد ٣ أيام
            </button>
          </>
        ) : null}

        {order.status === "received" ? (
          <>
            <button onClick={() => setStatus("delivered")} disabled={busy}
              className="rounded-xl bg-navy-800 px-3 py-2 text-xs font-bold text-white disabled:opacity-40">
              رُكّب للمريض
            </button>
            {patientNumber ? (
              <a
                href={`https://wa.me/${patientNumber}?text=${encodeURIComponent(patientReadyText(order, clinicName, clinicPhone))}`}
                target="_blank"
                rel="noopener"
                className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white"
              >
                أبلغ المريض
              </a>
            ) : null}
          </>
        ) : null}
      </div>
    </li>
  );
}

