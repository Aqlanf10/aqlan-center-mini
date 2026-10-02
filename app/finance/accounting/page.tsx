"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CLINIC_BASE_CURRENCY, formatMoney, parseAmount, type Currency } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { addDays, clinicDateString } from "@/lib/schedule";
import type { Account, AccountBalance, BalanceSheet, IncomeStatement } from "@/lib/accounting";
import type { AccountLedgerRow, AccountPeriodSummary } from "@/lib/accounting-reports";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks } from "@/components/financeLinks";
import { useSession } from "@/components/SessionProvider";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";

/**
 * الدفاتر المحاسبية.
 *
 * ما يفصل «شاشات مالية» عن **نظام محاسبي**: كل حركة مال مقيَّدة في طرفين، وميزان
 * المراجعة يُثبت أن شيئًا لم يضع. صاحب العيادة لا يحتاج أن يقرأها كل يوم — لكن
 * وجودها يعني أن أي محاسب أو مدقّق يستطيع أن يفتح البرنامج ويعمل عليه فورًا، وأن
 * أرقام «الصافي» في التقرير اليومي مسنودة بدفاتر لا بجمع أعمدة.
 *
 * (TD-REG-028) الدفاتر **بعملاتها الأصلية**: كل سطرٍ بعملته، وميزان كل عملة وقائمة دخلها
 * وميزانيتها مستقلة — ولا مجموع يجمع ريالًا يمنيًا مع سعودي أو دولار.
 */

type Tab = "trial" | "income" | "sheet" | "ledger" | "manual";

interface Feed {
  from: string; to: string;
  accounts: Account[];
  currencies: Currency[];
  balances: AccountBalance[];
  cumulativeBalances: AccountBalance[];
  accountSummaries: AccountPeriodSummary[];
  statements: { currency: Currency; income: IncomeStatement; sheet: BalanceSheet }[];
  entryCount: number;
  baseCurrency: Currency;
}

interface LedgerFeed {
  from: string; to: string; account: string; currency: Currency;
  rows: AccountLedgerRow[];
  openingBalanceMinor: number;
  periodDebitMinor: number;
  periodCreditMinor: number;
  closingBalanceMinor: number;
}

const SOURCE_LABEL: Record<string, string> = {
  invoice: "فاتورة", payment: "قبض", refund: "استرداد",
  payable: "التزام", expense: "صرف", expense_void: "إبطال صرف", cash_diff: "فرق جرد", manual: "قيد يدوي",
  opening: "رصيد افتتاحي", opening_payable: "دَين سابق", opening_advance: "رصيد مقدَّم سابق",
};

const CURRENCY_LABEL: Record<Currency, string> = { YER: "ريال يمني", SAR: "ريال سعودي", USD: "دولار" };
const ALL_CURRENCIES: Currency[] = ["YER", "SAR", "USD"];

export default function AccountingPage() {
  const readOnly = useSession()?.role === "accountant";
  // (TD-05) الأساس دستوري من الكود.
  const baseSetting = CLINIC_BASE_CURRENCY;
  const today = useMemo(() => clinicDateString(new Date(), CLINIC_ZONE_FALLBACK), []);
  const monthStart = `${today.slice(0, 7)}-01`;

  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [tab, setTab] = useState<Tab>("trial");
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState("1101");
  const [ledgerFeed, setLedgerFeed] = useState<LedgerFeed | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const loadSequence = useRef(0);
  // (TD-REG-028) العملة المعروضة في قائمة الدخل والميزانية ودفتر الأستاذ — لا عرض ممزوج.
  const [currency, setCurrency] = useState<Currency>(baseSetting);
  // Match the API's empty-date defaults before requesting or matching a feed.
  const effectiveFrom = from || monthStart;
  const effectiveTo = to || today;
  const [start, end] = effectiveFrom <= effectiveTo ? [effectiveFrom, effectiveTo] : [effectiveTo, effectiveFrom];

  const load = useCallback(async (start: string, end: string) => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const response = await fetch(`/api/accounting?from=${start}&to=${end}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      if (sequence !== loadSequence.current) return;
      setFeed(payload as Feed);
      setError(null);
    } catch (loadError) {
      if (sequence !== loadSequence.current) return;
      setFeed(null);
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(start, end); }, [start, end, load]);

  useEffect(() => {
    if (tab !== "ledger") return;
    let cancelled = false;
    void (async () => {
      setLedgerLoading(true);
      setLedgerError(null);
      try {
        const response = await fetch(`/api/accounting?from=${start}&to=${end}&account=${account}&currency=${currency}`, { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحميل دفتر الأستاذ.");
        if (!cancelled) setLedgerFeed(payload as LedgerFeed);
      } catch (loadError) {
        if (!cancelled) {
          setLedgerFeed(null);
          setLedgerError(loadError instanceof Error ? loadError.message : "تعذّر تحميل دفتر الأستاذ.");
        }
      } finally {
        if (!cancelled) setLedgerLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tab, account, currency, start, end]);
  const currentFeed = feed?.from === start && feed.to === end;
  const currentLedger = ledgerFeed?.from === start && ledgerFeed.to === end
    && ledgerFeed.account === account && ledgerFeed.currency === currency ? ledgerFeed : null;
  const ledger = currentLedger?.rows ?? [];

  /* ميزان كل عملة وحده: مجموع مدينها ودائنها — لا مجموع عابر للعملات. */
  const trialByCurrency = useMemo(() => ALL_CURRENCIES
    .map((code) => {
      const rows = (feed?.accountSummaries ?? []).filter((row) => row.currency === code);
      const debit = rows.reduce((sum, row) => sum + (row.currency === code ? row.periodDebitMinor : 0), 0);
      const credit = rows.reduce((sum, row) => sum + (row.currency === code ? row.periodCreditMinor : 0), 0);
      return { currency: code, rows, debit, credit, balanced: debit === credit };
    })
    .filter((group) => group.rows.length > 0), [feed]);
  const allBalanced = trialByCurrency.every((group) => group.balanced);
  const statement = feed?.statements.find((item) => item.currency === currency) ?? null;

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
             ["ledger", "دفتر الأستاذ"], ...(!readOnly ? [["manual", "قيد يدوي"]] : [])] as [Tab, string][]).map(([key, label]) => (
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

      {loading || (feed && !currentFeed) ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : !feed ? null : tab === "trial" ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="ميزان المراجعة">
          <div className={`mb-3 rounded-xl px-3 py-2 text-center text-sm font-bold ${
            allBalanced ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"
          }`}>
            {allBalanced
              ? `حركة الفترة متوازنة في كل عملة — ${feed.entryCount} قيدًا`
              : "الميزان لا يتوازن — راجع القيود اليدوية"}
          </div>
          {trialByCurrency.length === 0 ? (
            <p className="text-center text-sm text-slate-400">لا قيود حتى تاريخ التقرير.</p>
          ) : trialByCurrency.map((group) => (
            <div key={group.currency} className="mb-5 overflow-x-auto" data-testid={`trial-${group.currency}`}>
              <h3 className="mb-1 text-sm font-extrabold text-navy-900">ميزان المراجعة — {CURRENCY_LABEL[group.currency]}</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-300 text-right text-[11px] font-bold text-slate-500">
                    <th className="py-2">الحساب</th>
                    <th className="py-2">العملة</th>
                    <th className="py-2 text-left">رصيد أول المدة</th>
                    <th className="py-2 text-left">مدين الفترة</th>
                    <th className="py-2 text-left">دائن الفترة</th>
                    <th className="py-2 text-left">رصيد آخر المدة</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={`${row.code}-${row.currency}`} className="border-b border-slate-100">
                      <td className="py-2">
                        <button onClick={() => { setAccount(row.code); setCurrency(row.currency); setTab("ledger"); }}
                          className="text-right underline decoration-slate-300 underline-offset-4">
                          <span className="text-[11px] text-slate-400" dir="ltr">{row.code}</span> {row.name}
                        </button>
                      </td>
                      <td className="py-2 text-[11px] text-slate-500">{row.currency}</td>
                      <td className="py-2 text-left tabular-nums">{formatMoney(row.openingBalanceMinor, row.currency)}</td>
                      <td className="py-2 text-left tabular-nums">{row.periodDebitMinor ? formatMoney(row.periodDebitMinor, row.currency) : "—"}</td>
                      <td className="py-2 text-left tabular-nums">{row.periodCreditMinor ? formatMoney(row.periodCreditMinor, row.currency) : "—"}</td>
                      <td className="py-2 text-left font-bold tabular-nums">{formatMoney(row.closingBalanceMinor, row.currency)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-slate-800 font-extrabold">
                    <td className="py-2">حركة الفترة — {CURRENCY_LABEL[group.currency]}</td>
                    <td />
                    <td />
                    <td className="py-2 text-left tabular-nums">{formatMoney(group.debit, group.currency)}</td>
                    <td className="py-2 text-left tabular-nums">{formatMoney(group.credit, group.currency)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
          <p className="text-[11px] leading-relaxed text-slate-500">
            الأرصدة بإشارة طبيعة الحساب، من {feed.from} إلى {feed.to}. كل عملة ميزانها وحدها. الدفع بعملةٍ يسدّد دَينًا بأخرى يمرّ بحساب «مقاصة تحويل العملات» (1901)
            بالمبلغين المسجَّلين على السند — فلا سعر يُخمَّن ولا رقم يجمع عملتين.
          </p>
        </section>
      ) : tab === "income" || tab === "sheet" ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label={tab === "income" ? "قائمة الدخل" : "الميزانية"}>
          <CurrencyTabs value={currency} onChange={setCurrency} available={feed.statements.map((item) => item.currency)} />
          {!statement ? (
            <p className="text-center text-sm text-slate-400">لا قيود بـ{CURRENCY_LABEL[currency]} في هذه المدة.</p>
          ) : tab === "income" ? (
            <>
              <p className="mb-3 text-xs text-slate-500">
                بـ{CURRENCY_LABEL[currency]} وحده. على أساس الاستحقاق: الإيراد من الفواتير لا من التحصيل، والمصروف من
                الالتزامات لا من السداد. من {feed.from} إلى {feed.to}.
              </p>
              <Line label="إيرادات الخدمات" value={formatMoney(statement.income.revenueMinor, currency)} />
              <Line label="الخصومات الممنوحة" value={`− ${formatMoney(statement.income.discountMinor, currency)}`} />
              <Line label="صافي الإيراد" value={formatMoney(statement.income.netRevenueMinor, currency)} strong />
              <div className="my-3 border-t border-slate-200" />
              {statement.income.expenses.map((expense) => (
                <Line key={expense.code} label={expense.name} value={formatMoney(expense.amountMinor, currency)} />
              ))}
              <Line label="إجمالي المصروفات" value={formatMoney(statement.income.totalExpensesMinor, currency)} strong />
              <div className="my-3 border-t-2 border-slate-800" />
              <Line
                label={statement.income.netProfitMinor >= 0 ? "صافي الربح" : "صافي الخسارة"}
                value={formatMoney(Math.abs(statement.income.netProfitMinor), currency)}
                strong
                tone={statement.income.netProfitMinor >= 0 ? "good" : "bad"}
              />
            </>
          ) : (
            <>
              <p className="mb-3 text-xs text-slate-500">أرصدة تراكمية حتى {feed.to}، تشمل ما قبل بداية الفترة المختارة.</p>
              <h2 className="mb-2 text-sm font-bold">الأصول — {CURRENCY_LABEL[currency]}</h2>
              {statement.sheet.assets.map((row) => (
                <Line key={row.code} label={row.name} value={formatMoney(row.amountMinor, currency)} />
              ))}
              <Line label="إجمالي الأصول" value={formatMoney(statement.sheet.totalAssetsMinor, currency)} strong />

              <h2 className="mb-2 mt-4 text-sm font-bold">الخصوم</h2>
              {statement.sheet.liabilities.length === 0 ? (
                <p className="text-sm text-slate-400">لا خصوم.</p>
              ) : statement.sheet.liabilities.map((row) => (
                <Line key={row.code} label={row.name} value={formatMoney(row.amountMinor, currency)} />
              ))}
              <Line label="إجمالي الخصوم" value={formatMoney(statement.sheet.totalLiabilitiesMinor, currency)} strong />

              <h2 className="mb-2 mt-4 text-sm font-bold">حقوق الملكية</h2>
              {statement.sheet.equity.map((row) => (
                <Line key={row.code} label={row.name} value={formatMoney(row.amountMinor, currency)} />
              ))}
              <Line label="الأرباح المتراكمة حتى تاريخ الميزانية" value={formatMoney(statement.sheet.retainedEarningsMinor, currency)} />
              <Line label="إجمالي حقوق الملكية" value={formatMoney(statement.sheet.equityMinor, currency)} strong />

              <div className="my-3 border-t-2 border-slate-800" />
              <div className={`rounded-xl px-3 py-2 text-center text-sm font-bold ${
                statement.sheet.differenceMinor === 0 ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"
              }`}>
                {statement.sheet.differenceMinor === 0
                  ? `الميزانية متوازنة بـ${CURRENCY_LABEL[currency]}: الأصول = الخصوم + حقوق الملكية`
                  : `الميزانية لا تتوازن بفارق ${formatMoney(statement.sheet.differenceMinor, currency)}`}
              </div>
            </>
          )}
        </section>
      ) : tab === "ledger" ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="دفتر الأستاذ">
          <div className="mb-3 flex flex-wrap gap-2">
            <select value={account} onChange={(event) => setAccount(event.target.value)}
              aria-label="الحساب"
              className="min-w-[12rem] flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
              {feed.accounts.map((item) => (
                <option key={item.code} value={item.code}>{item.code} — {item.name}</option>
              ))}
            </select>
            <select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)}
              aria-label="العملة"
              className="w-32 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
              {ALL_CURRENCIES.map((code) => <option key={code} value={code}>{CURRENCY_LABEL[code]}</option>)}
            </select>
          </div>
          {ledgerLoading ? (
            <p className="text-center text-sm text-slate-400">جارٍ تحميل دفتر الأستاذ…</p>
          ) : ledgerError ? (
            <p role="alert" className="text-sm text-red-700">{ledgerError}</p>
          ) : currentLedger ? <>
          <div className="mb-3 rounded-xl bg-slate-50 p-3 text-sm" data-testid="ledger-period-summary">
            <Line label="رصيد أول المدة" value={formatMoney(currentLedger.openingBalanceMinor, currency)} />
            <Line label="مدين الفترة" value={formatMoney(currentLedger.periodDebitMinor, currency)} />
            <Line label="دائن الفترة" value={formatMoney(currentLedger.periodCreditMinor, currency)} />
            <Line label="رصيد آخر المدة" value={formatMoney(currentLedger.closingBalanceMinor, currency)} strong />
          </div>
          <p className="mb-3 text-[11px] text-slate-500">الحركات من {currentLedger.from} إلى {currentLedger.to}. ترتيب حركات اليوم الواحد حسب المصدر والمرجع، وليس حسب وقت حدوثها.</p>
          {ledger.length === 0 ? (
            <p className="text-center text-sm text-slate-400">لا حركة على هذا الحساب بـ{CURRENCY_LABEL[currency]} في هذه المدة.</p>
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
                      <td className="py-2 text-left tabular-nums">{row.debitMinor ? formatMoney(row.debitMinor, row.currency) : "—"}</td>
                      <td className="py-2 text-left tabular-nums">{row.creditMinor ? formatMoney(row.creditMinor, row.currency) : "—"}</td>
                      <td className="py-2 text-left font-bold tabular-nums">{formatMoney(row.balanceMinor, row.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </> : null}
        </section>
      ) : (
        readOnly ? null : <ManualEntryForm accounts={feed.accounts} onSaved={() => load(start, end)} today={today} baseCurrency={feed.baseCurrency} />
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

/** (TD-REG-028) اختيار عملة القائمة — لا عرض ممزوج. */
function CurrencyTabs({ value, onChange, available }: {
  value: Currency; onChange: (currency: Currency) => void; available: Currency[];
}) {
  return (
    <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="العملة">
      {ALL_CURRENCIES.map((code) => (
        <button key={code} type="button" role="tab" aria-selected={value === code} onClick={() => onChange(code)}
          className={`rounded-xl border px-3 py-1.5 text-xs font-bold ${
            value === code ? "border-navy-800 bg-navy-800 text-white" : "border-slate-200 bg-white text-slate-600"
          } ${available.includes(code) ? "" : "opacity-60"}`}>
          {CURRENCY_LABEL[code]}
        </button>
      ))}
    </div>
  );
}

type DraftLine = { accountCode: string; currency: Currency; amount: string; side: "debit" | "credit" };

function ManualEntryForm({ accounts, onSaved, today, baseCurrency }: {
  accounts: Account[]; onSaved: () => void; today: string; baseCurrency: Currency;
}) {
  const [date, setDate] = useState(today);
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([
    { accountCode: accounts[0]?.code ?? "", currency: baseCurrency, amount: "", side: "debit" },
    { accountCode: accounts[1]?.code ?? "", currency: baseCurrency, amount: "", side: "credit" },
  ]);
  /* (TD-REG-028) توازن كل عملة قبل الإرسال — للإرشاد فقط؛ الخادم يرفض غير المتوازن على أي حال. */
  const imbalance = useMemo(() => ALL_CURRENCIES
    .map((code) => {
      const net = lines
        .filter((line) => line.currency === code)
        .reduce((sum, line) => sum + (parseAmount(line.amount, code) ?? 0) * (line.side === "debit" ? 1 : -1), 0);
      return { currency: code, net };
    })
    .filter((row) => row.net !== 0), [lines]);
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
        للتسويات والأرصدة الافتتاحية. قيود المستندات — الفواتير والسندات — تُرحَّل تلقائيًا ولا
        تُكتب هنا. لكل سطرٍ عملته، ويجب أن يتوازن القيد داخل كل عملة على حدة. القيد يُحفظ ولا
        يُعدَّل بعد ذلك — الخطأ يُصحَّح بقيدٍ عاكس.
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
          <select value={line.currency}
            onChange={(event) => setLines((current) => current.map((item, i) =>
              i === index ? { ...item, currency: event.target.value as Currency } : item))}
            aria-label="العملة"
            className="w-28 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
            {ALL_CURRENCIES.map((code) => <option key={code} value={code}>{CURRENCY_LABEL[code]}</option>)}
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
        onClick={() => setLines((current) => [...current, { accountCode: accounts[0]?.code ?? "", currency: baseCurrency, amount: "", side: "debit" }])}
        className="mb-3 rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-600">
        + طرف آخر
      </button>

      {imbalance.length > 0 ? (
        <p className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          غير متوازن: {imbalance.map((row) => `${CURRENCY_LABEL[row.currency]} ${row.net > 0 ? "مدين" : "دائن"} بفارق ${formatMoney(Math.abs(row.net), row.currency)}`).join(" · ")}
        </p>
      ) : null}
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
