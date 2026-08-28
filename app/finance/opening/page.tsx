"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney, isCurrency, type Currency } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { useSetting } from "@/components/SettingsProvider";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks } from "@/components/financeLinks";

/**
 * الأرصدة الافتتاحية — لوحة مراجعة لا لوحة إدخال.
 *
 * الإدخال مكانه ملف المريض نفسه، لأن رصيدًا افتتاحيًا يُكتب من قائمة عامة يُسند إلى
 * الاسم الخطأ بسهولة. وهذه الشاشة للسؤال الذي يُسأل مرة واحدة بعد إدخال البيانات
 * القديمة: **كم أدخلنا؟ وعلى كم مريضًا؟** — فمجموعٌ يخالف ما في الدفتر الورقي
 * يُكتشف اليوم لا بعد أن تُبنى عليه ستة أشهر من التقارير.
 */

interface OpeningRow {
  patientId: number;
  patientName: string;
  phone: string | null;
  amountMinor: number;
  asOfDate: string;
  note: string | null;
  createdBy: string | null;
}

export default function OpeningBalancesPage() {
  const baseSetting = useSetting("finance.base_currency");
  const fallbackBase: Currency = isCurrency(baseSetting) ? baseSetting : "YER";

  const [rows, setRows] = useState<OpeningRow[]>([]);
  const [base, setBase] = useState<Currency>(fallbackBase);
  const [totalMinor, setTotalMinor] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/opening-balances", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setRows(payload.balances as OpeningRow[]);
      setTotalMinor(payload.totalMinor as number);
      if (isCurrency(payload.baseCurrency)) setBase(payload.baseCurrency);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-5">
      <PageHeader
        title="الأرصدة الافتتاحية"
        subtitle="ما كان على المرضى قبل بدء العمل بالبرنامج"
        links={financeLinks("/finance/opening")}
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      <section className="mb-4 rounded-2xl border-2 border-navy-800 bg-white p-4 text-center">
        <p className="text-2xl font-extrabold">{formatMoney(totalMinor, base)}</p>
        <p className="mt-1 text-[11px] font-bold text-slate-500">
          على {rows.length} مريضًا — أُثبتت أصولًا افتتاحية لا إيرادًا
        </p>
      </section>

      <p className="mb-4 rounded-2xl border border-slate-200 bg-white p-3 text-[11px] font-bold leading-5 text-slate-500">
        الإدخال والتعديل من ملف المريض: افتح الملف ← تبويب «الحساب» ← «رصيد افتتاحي».
      </p>

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          لا أرصدة افتتاحية مُدخلة.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.patientId} className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white p-3">
              <div className="min-w-[9rem] flex-1">
                <a href={`/patients/${row.patientId}`}
                  className="block truncate text-sm font-extrabold underline decoration-slate-300 underline-offset-4">
                  {row.patientName}
                </a>
                <p className="truncate text-[11px] text-slate-500">
                  {friendlyDateLong(row.asOfDate)}
                  {row.note ? ` · ${row.note}` : ""}
                  {row.createdBy ? ` · أدخله ${row.createdBy}` : ""}
                </p>
              </div>
              <span className="shrink-0 text-sm font-extrabold">{formatMoney(row.amountMinor, base)}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
