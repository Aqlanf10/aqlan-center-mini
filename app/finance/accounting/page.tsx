"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatMoney, isCurrency, type Currency } from "@/lib/money";
import { useSetting } from "@/components/SettingsProvider";
import { friendlyDateLong } from "@/lib/reminders";
import { addDays, clinicDateString } from "@/lib/schedule";
import type { Account, AccountBalance, BalanceSheet, IncomeStatement } from "@/lib/accounting";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks } from "@/components/financeLinks";

/**
 * الدفاتر المحاسبية.
 *
 * ما يفصل «شاشات مالية» عن **نظام محاسبي**: كل حركة مال مقيَّدة في طرفين، وميزان
 * المراجعة يُثبت أن شيئًا لم يضع. صاحب العيادة لا يحتاج أن يقرأها كل يوم — لكن
 * وجودها يعني أن أي محاسب أو مدقّق يستطيع أن يفتح البرنامج ويعمل عليه فورًا، وأن
 * أرقام «الصافي» في التقرير اليومي مسنودة بدفاتر لا بجمع أعمدة.
 */

type Tab = "trial" | "income" | "sheet" | "ledger" | "manual";

interface Feed {
  from: string; to: string;
  accounts: Account[];
  balances: AccountBalance[];
  income: IncomeStatement;
  sheet: BalanceSheet;
  entryCount: number;
  baseCurrency: Currency;
}

interface LedgerRow {
  date: string; source: string; reference: string; description: string;
  debitMinor: number; creditMinor: number; balanceMinor: number;
}

const SOURCE_LABEL: Record<string, string> = {
  invoice: "فاتورة", payment: "قبض", refund: "استرداد",
  payable: "التزام", expense: "صرف", cash_diff: "فرق جرد", manual: "قيد يدوي",
};

export default function AccountingPage() {
  const baseSetting = useSetting("finance.base_currency");
  const today = useMemo(() => clinicDateString(new Date(), "Asia/Aden"), []);
  const monthStart = `${today.slice(0, 7)}-01`;

  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [tab, setTab] = useState<Tab>("trial");
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState("1101");
  const [ledger, setLedger] = useState<LedgerRow[]>([]);

  const base: Currency = feed?.baseCurrency ?? (isCurrency(baseSetting) ? baseSetting : "YER");

  const load = useCallback(async (start: string, end: string) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/accounting?from=${start}&to=${end}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setFeed(payload as Feed);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(from, to); }, [from, to, load]);

  useEffect(() => {
    if (tab !== "ledger") return;
    void (async () => {
      try {
        const response = await fetch(`/api/accounting?from=${from}&to=${to}&account=${account}`, { cache: "no-store" });
        if (response.ok) setLedger((await response.json()).rows as LedgerRow[]);
      } catch { /* الدفتر يبقى على آخر قراءة */ }
    })();
  }, [tab, account, from, to]);

  const totals = useMemo(() => {
    const debit = (feed?.balances ?? []).reduce((sum, row) => sum + row.debitMinor, 0);
    const credit = (feed?.balances ?? []).reduce((sum, row) => sum + row.creditMinor, 0);
    return { debit, credit, balanced: debit === credit };
  }, [feed]);

  return (
    <main className="mx-auto max-w-4xl p-4 pb-24">
      <PageHeader
        title="الدفاتر المحاسبية"
        subtitle="قيد مزدوج · ميزان مراجعة · قائمة دخل · ميزانية"
        links={financeLinks("/finance/accounting")}
      />

      <div className="mb-3 flex flex-wrap gap-1.5">
        {([["هذا الشهر", monthStart, today],
           ["الشهر الماضي", `${addDays(monthStart, -1).slice(0, 7)}-01`, addDays(monthStart, -1)],
           ["هذه السنة", `${today.slice(0, 4)}-01-01`, today]] as [string, string, string][]).map(([label, start, end]) => (
          <button key={label} onClick={() => { setFrom(start); setTo(end); }}
            className={`rounded-xl border px-3 py-1.5 text-xs font-bold ${
              from === start && to === end ? "border-navy-800 bg-navy-800 text-white" : "border-slate-200 bg-white text-slate-600"
            }`}>
            {label}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <label className="min-w-[8rem] flex-1">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">من</span>
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        </label>
        <label className="min-w-[8rem] flex-1">
          <span className="mb-1 block text-[11px] font-bold text-slate-500">إلى</span>
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        </label>
      </div>

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {([["trial", "ميزان المراجعة"], ["income", "قائمة الدخل"], ["sheet", "الميزانية"],
             ["ledger", "دفتر الأستاذ"], ["manual", "قيد يدوي"]] as [Tab, string][]).map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)}
              className={`rounded-xl border px-3 py-1.5 text-xs font-bold ${
                tab === key ? "border-brand-blue bg-brand-blue text-white" : "border-slate-200 bg-white text-slate-600"
              }`}>
              {label}
            </button>
          ))}
        </div>
        <a
          href="/finance/expense-categories"
          className="inline-flex items-center gap-1.5 rounded-xl border border-teal-300 bg-teal-50 px-3 py-1.5 text-xs font-bold text-teal-800 hover:bg-teal-100 transition shadow-2xs"
        >
          <span>⚡</span>
          <span>إعدادات الربط المحاسبي للمصروفات</span>
        </a>
      </div>

      {loading && !feed ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : !feed ? null : tab === "trial" ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="ميزان المراجعة">
          <div className={`mb-3 rounded-xl px-3 py-2 text-center text-sm font-bold ${
            totals.balanced ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"
          }`}>
            {totals.balanced
              ? `الميزان متوازن — ${feed.entryCount} قيدًا`
              : "الميزان لا يتوازن — راجع القيود اليدوية"}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-300 text-right text-[11px] font-bold text-slate-500">
                  <th className="py-2">الحساب</th>
                  <th className="py-2 text-left">مدين</th>
                  <th className="py-2 text-left">دائن</th>
                  <th className="py-2 text-left">الرصيد</th>
                </tr>
              </thead>
              <tbody>
                {feed.balances.map((row) => (
                  <tr key={row.code} className="border-b border-slate-100">
                    <td className="py-2">
                      <button onClick={() => { setAccount(row.code); setTab("ledger"); }}
                        className="text-right underline decoration-slate-300 underline-offset-4">
                        <span className="text-[11px] text-slate-400" dir="ltr">{row.code}</span> {row.name}
                      </button>
                    </td>
                    <td className="py-2 text-left tabular-nums">{row.debitMinor ? formatMoney(row.debitMinor, base) : "—"}</td>
                    <td className="py-2 text-left tabular-nums">{row.creditMinor ? formatMoney(row.creditMinor, base) : "—"}</td>
                    <td className="py-2 text-left font-bold tabular-nums">{formatMoney(row.balanceMinor, base)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-slate-800 font-extrabold">
                  <td className="py-2">المجموع</td>
                  <td className="py-2 text-left tabular-nums">{formatMoney(totals.debit, base)}</td>
                  <td className="py-2 text-left tabular-nums">{formatMoney(totals.credit, base)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      ) : tab === "income" ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="قائمة الدخل">
          <p className="mb-3 text-xs text-slate-500">
            على أساس الاستحقاق: الإيراد من الفواتير لا من التحصيل، والمصروف من الالتزامات
            لا من السداد.
          </p>
          <Line label="إيرادات الخدمات" value={formatMoney(feed.income.revenueMinor, base)} />
          <Line label="الخصومات الممنوحة" value={`− ${formatMoney(feed.income.discountMinor, base)}`} />
          <Line label="صافي الإيراد" value={formatMoney(feed.income.netRevenueMinor, base)} strong />
          <div className="my-3 border-t border-slate-200" />
          {feed.income.expenses.map((expense) => (
            <Line key={expense.code} label={expense.name} value={formatMoney(expense.amountMinor, base)} />
          ))}
          <Line label="إجمالي المصروفات" value={formatMoney(feed.income.totalExpensesMinor, base)} strong />
          <div className="my-3 border-t-2 border-slate-800" />
          <Line
            label={feed.income.netProfitMinor >= 0 ? "صافي الربح" : "صافي الخسارة"}
            value={formatMoney(Math.abs(feed.income.netProfitMinor), base)}
            strong
            tone={feed.income.netProfitMinor >= 0 ? "good" : "bad"}
          />
        </section>
      ) : tab === "sheet" ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="الميزانية">
          <h2 className="mb-2 text-sm font-bold">الأصول</h2>
          {feed.sheet.assets.map((row) => (
            <Line key={row.code} label={row.name} value={formatMoney(row.amountMinor, base)} />
          ))}
          <Line label="إجمالي الأصول" value={formatMoney(feed.sheet.totalAssetsMinor, base)} strong />

          <h2 className="mb-2 mt-4 text-sm font-bold">الخصوم</h2>
          {feed.sheet.liabilities.length === 0 ? (
            <p className="text-sm text-slate-400">لا خصوم.</p>
          ) : feed.sheet.liabilities.map((row) => (
            <Line key={row.code} label={row.name} value={formatMoney(row.amountMinor, base)} />
          ))}
          <Line label="إجمالي الخصوم" value={formatMoney(feed.sheet.totalLiabilitiesMinor, base)} strong />

          <h2 className="mb-2 mt-4 text-sm font-bold">حقوق الملكية</h2>
          {feed.sheet.equity.map((row) => (
            <Line key={row.code} label={row.name} value={formatMoney(row.amountMinor, base)} />
          ))}
          <Line label="أرباح الفترة" value={formatMoney(feed.sheet.retainedEarningsMinor, base)} />
          <Line label="إجمالي حقوق الملكية" value={formatMoney(feed.sheet.equityMinor, base)} strong />

          <div className="my-3 border-t-2 border-slate-800" />
          <div className={`rounded-xl px-3 py-2 text-center text-sm font-bold ${
            feed.sheet.differenceMinor === 0 ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"
          }`}>
            {feed.sheet.differenceMinor === 0
              ? "الميزانية متوازنة: الأصول = الخصوم + حقوق الملكية"
              : `الميزانية لا تتوازن بفارق ${formatMoney(feed.sheet.differenceMinor, base)}`}
          </div>
        </section>
      ) : tab === "ledger" ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="دفتر الأستاذ">
          <select value={account} onChange={(event) => setAccount(event.target.value)}
            aria-label="الحساب"
            className="mb-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
            {feed.accounts.map((item) => (
              <option key={item.code} value={item.code}>{item.code} — {item.name}</option>
            ))}
          </select>
          {ledger.length === 0 ? (
            <p className="text-center text-sm text-slate-400">لا حركة على هذا الحساب في هذه المدة.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-300 text-right text-[11px] font-bold text-slate-500">
                    <th className="py-2">التاريخ</th>
                    <th className="py-2">البيان</th>
                    <th className="py-2 text-left">مدين</th>
                    <th className="py-2 text-left">دائن</th>
                    <th className="py-2 text-left">الرصيد</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((row, index) => (
                    <tr key={`${row.reference}-${index}`} className="border-b border-slate-100">
                      <td className="py-2 text-[11px] whitespace-nowrap">{friendlyDateLong(row.date)}</td>
                      <td className="py-2">
                        <span className="block truncate">{row.description}</span>
                        <span className="text-[11px] text-slate-400" dir="ltr">
                          {SOURCE_LABEL[row.source] ?? row.source} {row.reference}
                        </span>
                      </td>
                      <td className="py-2 text-left tabular-nums">{row.debitMinor ? formatMoney(row.debitMinor, base) : "—"}</td>
                      <td className="py-2 text-left tabular-nums">{row.creditMinor ? formatMoney(row.creditMinor, base) : "—"}</td>
                      <td className="py-2 text-left font-bold tabular-nums">{formatMoney(row.balanceMinor, base)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
        <ManualEntryForm accounts={feed.accounts} onSaved={() => load(from, to)} today={today} />
      )}
    </main>
  );
}

function Line({ label, value, strong = false, tone }: {
  label: string; value: string; strong?: boolean; tone?: "good" | "bad";
}) {
  return (
    <div className={`flex justify-between gap-3 py-1 ${strong ? "font-extrabold" : ""} ${
      tone === "good" ? "text-emerald-800" : tone === "bad" ? "text-red-700" : ""
    }`}>
      <span className={strong ? "" : "text-slate-600"}>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function ManualEntryForm({ accounts, onSaved, today }: {
  accounts: Account[]; onSaved: () => void; today: string;
}) {
  const [date, setDate] = useState(today);
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState([
    { accountCode: accounts[0]?.code ?? "", amount: "", side: "debit" as "debit" | "credit" },
    { accountCode: accounts[1]?.code ?? "", amount: "", side: "credit" as "debit" | "credit" },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/accounting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, description, lines }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّر الحفظ."); return; }
      setError(null);
      setSaved(true);
      setDescription("");
      setLines(lines.map((line) => ({ ...line, amount: "" })));
      setTimeout(() => setSaved(false), 2500);
      onSaved();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="rounded-2xl border border-slate-200 bg-white p-4">
      <p className="mb-3 text-xs leading-relaxed text-slate-500">
        للتسويات وإعادة تقييم العملات والأرصدة الافتتاحية. قيود المستندات — الفواتير
        والسندات — تُرحَّل تلقائيًا ولا تُكتب هنا.
      </p>

      <div className="mb-2 flex flex-wrap gap-2">
        <input type="date" value={date} onChange={(event) => setDate(event.target.value)}
          aria-label="تاريخ القيد" className="w-40 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        <input value={description} onChange={(event) => setDescription(event.target.value)}
          placeholder="بيان القيد" aria-label="بيان القيد"
          className="min-w-[10rem] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
      </div>

      {lines.map((line, index) => (
        <div key={index} className="mb-2 flex flex-wrap gap-2">
          <select value={line.accountCode}
            onChange={(event) => setLines((current) => current.map((item, i) =>
              i === index ? { ...item, accountCode: event.target.value } : item))}
            aria-label="الحساب"
            className="min-w-[10rem] flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
            {accounts.map((account) => (
              <option key={account.code} value={account.code}>{account.code} — {account.name}</option>
            ))}
          </select>
          <select value={line.side}
            onChange={(event) => setLines((current) => current.map((item, i) =>
              i === index ? { ...item, side: event.target.value as "debit" | "credit" } : item))}
            aria-label="الجهة"
            className="w-24 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
            <option value="debit">مدين</option>
            <option value="credit">دائن</option>
          </select>
          <input value={line.amount}
            onChange={(event) => setLines((current) => current.map((item, i) =>
              i === index ? { ...item, amount: event.target.value } : item))}
            placeholder="المبلغ" aria-label="المبلغ" inputMode="decimal" dir="ltr"
            className="w-28 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
          {lines.length > 2 ? (
            <button type="button" onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
              className="rounded-xl border border-slate-300 px-3 text-sm font-bold text-slate-500">×</button>
          ) : null}
        </div>
      ))}

      <button type="button"
        onClick={() => setLines((current) => [...current, { accountCode: accounts[0]?.code ?? "", amount: "", side: "debit" }])}
        className="mb-3 rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-600">
        + طرف آخر
      </button>

      {error ? (
        <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : null}
      {saved ? (
        <p className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">حُفظ القيد ✓</p>
      ) : null}

      <button type="submit" disabled={busy || !description.trim()}
        className="w-full rounded-xl bg-navy-800 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
        احفظ القيد
      </button>
    </form>
  );
}
