"use client";

import { useMemo, useState } from "react";
import { CURRENCY_LABEL, formatMoney, type Currency } from "@/lib/money";
import type { LegacyArrangementCadence } from "@/lib/legacy-balance-arrangements";

export interface LegacyOpeningPosition {
  currency: Currency;
  openingMinor: number;
  settledMinor: number;
  remainingMinor: number;
}

export interface LegacyArrangementView {
  id: number;
  currency: Currency;
  cadence: LegacyArrangementCadence;
  installmentMinor: number;
  startingDueMinor: number;
  firstDueDate: string | null;
  note: string | null;
  progress: {
    currentOpeningDueMinor: number;
    paidSinceStartMinor: number;
    arrangementRemainingMinor: number;
    suggestedMinor: number;
    overdueMinor: number;
    nextDueDate: string | null;
    nextDueAmountMinor: number;
    completed: boolean;
  };
}

export function LegacyBalanceArrangementPanel(props: {
  patientId: number;
  openingPositions: LegacyOpeningPosition[];
  arrangements: LegacyArrangementView[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const { patientId, openingPositions, arrangements, canManage, onChanged } = props;
  const [creating, setCreating] = useState(false);
  const [currency, setCurrency] = useState<Currency>("YER");
  const [cadence, setCadence] = useState<LegacyArrangementCadence>("per_visit");
  const [amount, setAmount] = useState("");
  const [firstDueDate, setFirstDueDate] = useState("");
  const [note, setNote] = useState("");
  const [cancelFor, setCancelFor] = useState<number | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeCurrencies = useMemo(() => new Set(arrangements.map((item) => item.currency)), [arrangements]);
  const eligible = useMemo(() => openingPositions
    .filter((opening) => opening.remainingMinor > 0)
    .filter((opening) => !activeCurrencies.has(opening.currency)), [openingPositions, activeCurrencies]);

  const startCreate = () => {
    const first = eligible[0]?.currency ?? "YER";
    setCurrency(first);
    setCadence("per_visit");
    setAmount("");
    setFirstDueDate("");
    setNote("");
    setError(null);
    setCreating(true);
  };

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/patients/${patientId}/legacy-balance-arrangement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currency,
          cadence,
          installmentAmount: amount,
          ...(cadence === "monthly" && firstDueDate ? { firstDueDate } : {}),
          note,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر إنشاء ترتيب القسط.");
        return;
      }
      setCreating(false);
      setError(null);
      onChanged();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (arrangementId: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/patients/${patientId}/legacy-balance-arrangement`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ arrangementId, reason: cancelReason }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر إلغاء الترتيب.");
        return;
      }
      setCancelFor(null);
      setCancelReason("");
      setError(null);
      onChanged();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  if (arrangements.length === 0 && (!canManage || eligible.length === 0)) return null;

  return (
    <section className="mb-3 rounded-2xl border border-sky-200 bg-sky-50/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-extrabold text-navy-900">ترتيب تحصيل الرصيد السابق</h3>
          <p className="text-[11px] text-slate-500">جدولة تحصيل فقط — لا تنشئ فاتورة أو دينًا جديدًا.</p>
        </div>
        {canManage && eligible.length > 0 && !creating ? (
          <button type="button" onClick={startCreate}
            className="rounded-xl bg-navy-800 px-3 py-2 text-xs font-bold text-white">
            + ترتيب قسط
          </button>
        ) : null}
      </div>

      {error ? <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-700">{error}</p> : null}

      <div className="mt-2 space-y-2">
        {arrangements.map((arrangement) => (
          <div key={arrangement.id} className="rounded-xl border border-sky-200 bg-white p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-xs font-extrabold text-navy-900">
                  {CURRENCY_LABEL[arrangement.currency]} — {arrangement.cadence === "per_visit" ? "مع كل زيارة" : "شهري"}
                </p>
                <p className="mt-1 text-[11px] text-slate-600">
                  المتبقي من الرصيد القديم: <b>{formatMoney(arrangement.progress.arrangementRemainingMinor, arrangement.currency)}</b>
                  {" · "}القسط المقترح: <b>{formatMoney(arrangement.progress.suggestedMinor, arrangement.currency)}</b>
                </p>
                {arrangement.cadence === "monthly" ? (
                  <p className="mt-1 text-[11px] text-slate-600">
                    {arrangement.progress.overdueMinor > 0
                      ? <>متأخر: <b className="text-amber-700">{formatMoney(arrangement.progress.overdueMinor, arrangement.currency)}</b></>
                      : "لا يوجد متأخر"}
                    {arrangement.progress.nextDueDate ? ` · الاستحقاق: ${arrangement.progress.nextDueDate}` : ""}
                  </p>
                ) : null}
                {arrangement.progress.completed ? (
                  <p className="mt-1 text-[11px] font-bold text-emerald-700">الرصيد القديم مسدّد.</p>
                ) : null}
                {arrangement.note ? <p className="mt-1 text-[11px] text-slate-500">{arrangement.note}</p> : null}
              </div>
              {canManage && !arrangement.progress.completed ? (
                <button type="button" onClick={() => { setCancelFor(arrangement.id); setCancelReason(""); }}
                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600">
                  تغيير/إلغاء
                </button>
              ) : null}
            </div>
            {cancelFor === arrangement.id ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)}
                  placeholder="سبب الإلغاء أو تغيير قيمة القسط"
                  className="min-w-[220px] flex-1 rounded-lg border border-slate-200 px-3 py-2 text-xs" />
                <button type="button" disabled={busy || cancelReason.trim().length < 3}
                  onClick={() => void cancel(arrangement.id)}
                  className="rounded-lg bg-red-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40">
                  تأكيد الإلغاء
                </button>
                <button type="button" onClick={() => setCancelFor(null)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold">رجوع</button>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {creating ? (
        <div className="mt-3 grid gap-2 rounded-xl border border-sky-200 bg-white p-3 md:grid-cols-2">
          <label className="text-xs font-bold text-slate-700">
            العملة
            <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2">
              {eligible.map((opening) => (
                <option key={opening.currency} value={opening.currency}>{CURRENCY_LABEL[opening.currency]}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-bold text-slate-700">
            طريقة التحصيل
            <select value={cadence} onChange={(e) => setCadence(e.target.value as LegacyArrangementCadence)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2">
              <option value="per_visit">مع كل زيارة</option>
              <option value="monthly">شهري</option>
            </select>
          </label>
          <label className="text-xs font-bold text-slate-700">
            قيمة القسط
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal"
              placeholder="مثال: 30000"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
          </label>
          {cadence === "monthly" ? (
            <label className="text-xs font-bold text-slate-700">
              أول استحقاق
              <input type="date" value={firstDueDate} onChange={(e) => setFirstDueDate(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
            </label>
          ) : <div />}
          <label className="text-xs font-bold text-slate-700 md:col-span-2">
            ملاحظة
            <input value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="مثال: 30 ألف مع كل عودة تقويم"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" />
          </label>
          <div className="flex gap-2 md:col-span-2">
            <button type="button" disabled={busy || !amount.trim()} onClick={() => void create()}
              className="rounded-lg bg-brand-orange px-4 py-2 text-xs font-bold text-white disabled:opacity-40">
              حفظ الترتيب
            </button>
            <button type="button" onClick={() => setCreating(false)}
              className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-bold">إلغاء</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
