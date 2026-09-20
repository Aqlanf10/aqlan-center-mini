"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CLINIC_BASE_CURRENCY, CURRENCIES, CURRENCY_LABEL, formatMoney, isCurrency, type Currency } from "@/lib/money";
import { useClinicName, useSetting } from "@/components/SettingsProvider";
import { toWhatsAppNumber } from "@/lib/reminders";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks } from "@/components/financeLinks";

/**
 * مديونية المرضى.
 *
 * الرقم الذي يعرف به صاحب العيادة كم من ماله عند الناس — ومعه **عمر الدين**: مئة
 * ألف عمرها أسبوع تُحصَّل بمكالمة، ومئة ألف عمرها سنة غالبًا لن تعود. وبلا العمر
 * تبدو المديونية رقمًا واحدًا لا يُتصرَّف فيه.
 *
 * ولكل مدين زر واتساب برسالة **مهذّبة**: المطالبة بلهجة جافة تخسر المريض والمبلغ
 * معًا؛ ورسالةٌ تذكّر بلطف تُحصِّل أكثر مما يُظنّ.
 */

interface DebtRow {
  patientId: number; patientName: string; phone: string | null;
  /** (P-01/D-1) عملة الصف — دلو واحد؛ المريض بعملتين يظهر صفين. */
  currency: Currency;
  billedMinor: number; openingMinor: number; collectedMinor: number; dueMinor: number;
  oldestUnpaidDate: string | null; ageDays: number;
}

const BUCKETS: [string, number, number][] = [
  ["أقل من شهر", 0, 30],
  ["١ – ٣ أشهر", 31, 90],
  ["٣ – ٦ أشهر", 91, 180],
  ["أكثر من ٦ أشهر", 181, Number.MAX_SAFE_INTEGER],
];

export default function DebtsPage() {
  // (TD-05) الأساس دستوري من الكود.
  const baseSetting = CLINIC_BASE_CURRENCY;
  const clinicName = useClinicName();
  const clinicPhone = useSetting("clinic.phone");
  const [base, setBase] = useState<Currency>(baseSetting);
  const [rows, setRows] = useState<DebtRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bucket, setBucket] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/finance/debts", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setRows(payload.rows as DebtRow[]);
      if (isCurrency(payload.baseCurrency)) setBase(payload.baseCurrency);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // (P-01/D-1) الإجماليات داخل كل عملة — لا رقمٌ واحد يمزج الدلاء.
  const totals = useMemo(() => {
    const perBucket = BUCKETS.map(() => ({ YER: 0, SAR: 0, USD: 0 }) as Record<Currency, number>);
    const total = { YER: 0, SAR: 0, USD: 0 } as Record<Currency, number>;
    for (const row of rows) {
      total[row.currency] += row.dueMinor;
      const index = BUCKETS.findIndex(([, min, max]) => row.ageDays >= min && row.ageDays <= max);
      if (index >= 0) perBucket[index][row.currency] += row.dueMinor;
    }
    return { perBucket, total };
  }, [rows]);

  const bucketText = (index: number): string =>
    CURRENCIES.map((currency) => ({ currency, value: totals.perBucket[index][currency] }))
      .filter(({ value }) => value !== 0)
      .map(({ currency, value }) => formatMoney(value, currency))
      .join(" · ") || "—";

  const totalText = CURRENCIES
    .filter((currency) => totals.total[currency] !== 0)
    .map((currency) => formatMoney(totals.total[currency], currency))
    .join(" · ") || "—";

  const visible = useMemo(() => {
    if (bucket === null) return rows;
    const [, min, max] = BUCKETS[bucket];
    return rows.filter((row) => row.ageDays >= min && row.ageDays <= max);
  }, [rows, bucket]);

  return (
    <main className="mx-auto max-w-3xl p-4 pb-24">
      <PageHeader
        title="مديونية المرضى"
        subtitle="كم من مال العيادة عند الناس — ومنذ متى"
        links={financeLinks("/finance/debts")}
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}


      <section className="mb-4 rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 text-center">
        <p className="text-2xl font-extrabold text-amber-900">{totalText}</p>
        <p className="mt-1 text-[11px] font-bold text-amber-800">
          إجمالي المديونية في {rows.length} صفًا ({new Set(rows.map((row) => row.patientId)).size} مريضًا) — كل عملة بدلوها
        </p>
      </section>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {BUCKETS.map(([label], index) => (
          <button key={label} onClick={() => setBucket(bucket === index ? null : index)}
            className={`rounded-2xl border p-3 text-center ${
              bucket === index ? "border-navy-800 bg-navy-800 text-white" : "border-slate-200 bg-white"
            }`}>
            <p className="text-sm font-extrabold">{bucketText(index)}</p>
            <p className="text-[11px] font-bold opacity-70">{label}</p>
          </button>
        ))}
      </div>

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : visible.length === 0 ? (
        <p className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center text-sm font-bold text-emerald-800">
          {rows.length === 0 ? "لا مديونية على أحد." : "لا مديونية في هذه الفئة."}
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((row) => {
            const number = toWhatsAppNumber(row.phone);
            const text = [
              `السلام عليكم ${row.patientName}،`,
              ``,
              `تذكير من ${clinicName} برصيد مستحق قدره ${formatMoney(row.dueMinor, row.currency)}.`,
              `يسعدنا استقبالكم في أي وقت لتسويته أو ترتيب دفعات تناسبكم.`,
              ``,
              `للتواصل: ${clinicPhone}`,
            ].join("\n");
            return (
              <li key={`${row.patientId}-${row.currency}`} className={`flex flex-wrap items-center gap-2 rounded-2xl border p-3 ${
                row.ageDays > 180 ? "border-red-300 bg-red-50" : "border-slate-200 bg-white"
              }`}>
                <div className="min-w-[9rem] flex-1">
                  <a href={`/patients/${row.patientId}`} className="block truncate text-sm font-extrabold underline decoration-slate-300 underline-offset-4">
                    {row.patientName}
                  </a>
                  <p className="text-[11px] text-slate-500">
                    مفوتر {formatMoney(row.billedMinor, row.currency)} · محصّل {formatMoney(row.collectedMinor, row.currency)}
                    {row.openingMinor > 0 ? ` · افتتاحي ${formatMoney(row.openingMinor, row.currency)}` : ""}
                    {row.ageDays > 0 ? ` · منذ ${row.ageDays} يومًا` : ""}
                  </p>
                </div>
                <span className="shrink-0 text-[10px] font-bold text-slate-500">{CURRENCY_LABEL[row.currency]}</span>
                <span className="shrink-0 text-sm font-extrabold">{formatMoney(row.dueMinor, row.currency)}</span>
                {number ? (
                  <a href={`https://wa.me/${number}?text=${encodeURIComponent(text)}`}
                    target="_blank" rel="noopener"
                    className="shrink-0 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white">
                    تذكير
                  </a>
                ) : (
                  <span className="shrink-0 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-amber-600">
                    بلا رقم
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
