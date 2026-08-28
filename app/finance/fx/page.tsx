"use client";

import { useCallback, useEffect, useState } from "react";
import { CURRENCY_LABEL, formatMoney, isCurrency, type Currency } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks } from "@/components/financeLinks";

/**
 * إعادة تقييم النقد الأجنبي.
 *
 * شاشة مراجعة قبل الترحيل لا زر يُضغط: تُعرض الوحدات المحتفظ بها، وقيمتها في
 * الدفاتر، والسعر الضمني فيها، وسعر اليوم — ثم يُرحَّل الفرق بقرار.
 *
 * والسعر الضمني هو أهم عمود فيها: سعرٌ يبدو غير منطقي يعني خللًا في القيود لا فرق
 * صرف، وترحيلُ الفرق حينها يدفن الخلل في حساب فروقات الصرف بدل أن يُصلَح.
 */

interface Position {
  currency: Currency;
  heldMinor: number;
  bookValueMinor: number;
  rate: number;
  revaluedMinor: number;
  differenceMinor: number;
  impliedRate: number | null;
}

interface Report {
  asOf: string;
  baseCurrency: Currency;
  positions: Position[];
  totalDifferenceMinor: number;
}

export default function FxPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const asOf = clinicDateString(new Date(), "Asia/Aden");
      const response = await fetch(`/api/finance/fx?asOf=${asOf}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setReport(payload as Report);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const post = useCallback(async (currency: Currency) => {
    if (busy || !report) return;
    setBusy(true);
    setDone(null);
    try {
      const response = await fetch("/api/finance/fx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency, asOf: report.asOf }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر الترحيل.");
      setDone(`رُحّل قيد إعادة تقييم ${CURRENCY_LABEL[currency]}.`);
      setError(null);
      await load();
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : "تعذّر الترحيل.");
    } finally {
      setBusy(false);
    }
  }, [busy, report, load]);

  const base: Currency = isCurrency(report?.baseCurrency) ? report.baseCurrency : "YER";

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-5">
      <PageHeader
        title="إعادة تقييم العملات"
        subtitle={`${report ? friendlyDateLong(report.asOf) : "…"} — ما في الصندوق من عملات بسعر اليوم`}
        links={financeLinks("/finance/fx")}
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}
      {done ? (
        <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-bold text-emerald-800">{done}</p>
      ) : null}

      <p className="mb-4 rounded-2xl border border-slate-200 bg-white p-3 text-[11px] font-bold leading-5 text-slate-500">
        الدولار الذي قُبض بسعرٍ قديم يبقى في الدفاتر بسعره — وهذا صحيح للحركة، خطأ
        للرصيد. إعادة التقييم تُصحّح <span className="text-navy-800">الرصيد وحده</span>،
        ولا تمسّ أي سند قُبض أو صُرف. والفرق يدخل حساب «فروقات أسعار الصرف» في قائمة الدخل.
      </p>

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ الحساب…</p>
      ) : !report || report.positions.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          لا عملات أجنبية في هذا النظام.
        </p>
      ) : (
        <ul className="space-y-3">
          {report.positions.map((position) => {
            const gain = position.differenceMinor > 0;
            const nothing = position.differenceMinor === 0;
            return (
              <li key={position.currency} className={`rounded-2xl border-2 p-4 ${
                nothing ? "border-slate-200 bg-white"
                  : gain ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50"
              }`}>
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-sm font-extrabold">{CURRENCY_LABEL[position.currency]}</h2>
                  <span className="text-lg font-extrabold" dir="ltr">
                    {formatMoney(position.heldMinor, position.currency)}
                  </span>
                </div>

                <dl className="mb-3 space-y-1 text-[11px] font-bold text-slate-600">
                  <div className="flex justify-between">
                    <dt>في الدفاتر (بأسعار أيامه)</dt>
                    <dd>{formatMoney(position.bookValueMinor, base)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>بسعر اليوم ({position.rate || "—"})</dt>
                    <dd>{formatMoney(position.revaluedMinor, base)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>السعر الضمني في الدفاتر</dt>
                    <dd dir="ltr">{position.impliedRate ?? "—"}</dd>
                  </div>
                </dl>

                <p className={`mb-3 text-center text-sm font-extrabold ${
                  nothing ? "text-slate-500" : gain ? "text-emerald-800" : "text-amber-900"
                }`}>
                  {nothing
                    ? "لا فرق — الدفاتر مطابقة لسعر اليوم"
                    : `${gain ? "ربح" : "خسارة"} تغيّر سعر ${formatMoney(Math.abs(position.differenceMinor), base)}`}
                </p>

                <button onClick={() => void post(position.currency)}
                  disabled={busy || nothing || position.rate <= 0}
                  className="w-full rounded-xl bg-navy-800 py-2.5 text-sm font-extrabold text-white disabled:opacity-40">
                  رحّل الفرق قيدًا
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
