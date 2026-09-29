"use client";

import { useCallback, useEffect, useState } from "react";
import { CURRENCY_LABEL, formatMoney, isCurrency, type Currency } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks } from "@/components/financeLinks";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";

/**
 * العملات الأجنبية — عرض ترجمةٍ للعلم (TD-REG-028).
 *
 * الدفاتر صارت بعملاتها الأصلية: صندوق الريال السعودي بالريال السعودي، والدولار بالدولار. فلا
 * «إعادة تقييم» تُرحَّل داخل الدفاتر — ترحيل فرقٍ يمني على صندوقٍ سعودي يعيد الخلط الذي أُغلق.
 * تبقى هذه الشاشة لتجيب سؤالًا مشروعًا: كم يساوي ما نملكه من كل عملة **بسعر اليوم**؟ — رقمٌ
 * يُقرأ ولا يُرحَّل، بسعرٍ مذكور وتاريخٍ مذكور. وقيود إعادة التقييم القديمة تُسرد كما سُجّلت.
 */

interface Position {
  currency: Currency;
  cashMinor: number;
  clearingMinor: number;
  rate: number | null;
  translatedCashMinor: number | null;
  translatedClearingMinor: number | null;
}

interface HistoricalEntry {
  entryId: number;
  date: string;
  description: string;
  lines: { accountCode: string; currency: Currency; amountMinor: number; side: "debit" | "credit" }[];
}

interface Report {
  asOf: string;
  baseCurrency: Currency;
  mode: "translation_only";
  positions: Position[];
  historicalRevaluations: HistoricalEntry[];
}

export default function FxPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const asOf = clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
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

  const base: Currency = isCurrency(report?.baseCurrency) ? report.baseCurrency : "YER";

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-5">
      <PageHeader
        title="العملات الأجنبية"
        subtitle={`${report ? friendlyDateLong(report.asOf) : "…"} — ما نملكه من كل عملة، وقيمته بسعر اليوم للعلم`}
        links={financeLinks("/finance/fx")}
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      <p className="mb-4 rounded-2xl border border-slate-200 bg-white p-3 text-[11px] font-bold leading-5 text-slate-500">
        الدفاتر بعملاتها الأصلية: مئة دولار في الصندوق تبقى مئة دولار في الدفاتر أيًّا كان السعر، فلا يُرحَّل
        قيد «إعادة تقييم». القيمة بالريال اليمني أدناه <span className="text-navy-800">للعلم فقط وغير مرحَّلة</span>،
        بسعر الإعدادات المذكور. وإن لم يُضبط السعر لا تُعرض قيمة — لا سعر يُخمَّن.
      </p>

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ الحساب…</p>
      ) : !report || report.positions.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          لا عملات أجنبية في هذا النظام.
        </p>
      ) : (
        <ul className="space-y-3">
          {report.positions.map((position) => (
            <li key={position.currency} className="rounded-2xl border-2 border-slate-200 bg-white p-4" data-testid={`fx-${position.currency}`}>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-extrabold">{CURRENCY_LABEL[position.currency]}</h2>
                <span className="text-lg font-extrabold" dir="ltr">{formatMoney(position.cashMinor, position.currency)}</span>
              </div>
              <dl className="space-y-1 text-[11px] font-bold text-slate-600">
                <div className="flex justify-between">
                  <dt>في الصندوق والبنك (بالدفاتر، بعملته)</dt>
                  <dd dir="ltr">{formatMoney(position.cashMinor, position.currency)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>مركز مقاصة تحويل العملات بهذه العملة</dt>
                  <dd dir="ltr">{formatMoney(position.clearingMinor, position.currency)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>سعر الإعدادات</dt>
                  <dd dir="ltr">{position.rate ?? "غير مضبوط"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>قيمة النقد بسعر اليوم (للعلم — غير مرحَّلة)</dt>
                  <dd>{position.translatedCashMinor === null ? "—" : formatMoney(position.translatedCashMinor, base)}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}

      {report && report.historicalRevaluations.length > 0 ? (
        <section className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4" aria-label="قيود إعادة تقييم سابقة">
          <h2 className="mb-2 text-sm font-extrabold text-amber-900">قيود «إعادة تقييم» رُحّلت قبل الدفاتر بعملاتها</h2>
          <p className="mb-2 text-[11px] leading-5 text-amber-900">
            باقيةٌ كما سُجّلت (أسطرٌ بالريال اليمني) — لم تُحذف ولم تُعدَّل. إن رأى المحاسب عكسها فبقيدٍ يدوي مسبَّب
            من شاشة الدفاتر.
          </p>
          <ul className="space-y-1 text-[11px] text-amber-900">
            {report.historicalRevaluations.map((entry) => (
              <li key={entry.entryId}>
                <span className="font-bold">JM-{entry.entryId}</span> · {friendlyDateLong(entry.date)} · {entry.description} ·{" "}
                {entry.lines.map((line) => `${line.side === "debit" ? "مدين" : "دائن"} ${line.accountCode} ${formatMoney(line.amountMinor, line.currency)}`).join(" / ")}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
