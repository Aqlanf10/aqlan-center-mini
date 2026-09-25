"use client";

import { use, useCallback, useEffect, useState } from "react";
import { CURRENCIES, CURRENCY_LABEL, formatMoney, isCurrency, type Currency } from "@/lib/money";
import { EXPENSE_CATEGORY_LABEL, type ExpenseCategory } from "@/lib/expenses";
import type { PartyCurrencyTotals } from "@/lib/party-statement";
import { friendlyDateLong } from "@/lib/reminders";
import { useSession } from "@/components/SessionProvider";
import PayBillForm from "@/components/finance/PayBillForm";

/**
 * كشف حساب جهة — مختبر أو مورّد أو طبيب.
 *
 * سطران يجيبان السؤال الذي يُسأل حين يأتي صاحب المختبر آخر الشهر: ما الذي علينا،
 * وما الذي دفعناه. وبينهما الفرق — وهو الرقم الذي يُتفاوض عليه.
 */

interface Payable {
  id: number; description: string; category: string;
  amountMinor: number; currency: Currency; exchangeRate: number;
  baseAmountMinor: number; labOrderId: number | null; dueDate: string | null; createdAt: string;
  partyName: string;
  /** (P0-2) المسدَّد والمتبقي بعملة الفاتورة — من لقطات السندات، لا يتحرّك بالسعر. */
  settledMinor: number; remainingMinor: number;
}
interface Expense {
  id: number; voucherNumber: string; category: ExpenseCategory;
  amountMinor: number; currency: Currency; baseAmountMinor: number;
  note: string | null; createdAt: string;
  payableId: number | null; payableCurrency: Currency | null; payableSettledMinor: number | null;
}

export default function PartyStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [payables, setPayables] = useState<Payable[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [totals, setTotals] = useState<PartyCurrencyTotals[]>([]);
  const [partyName, setPartyName] = useState("");
  const [base, setBase] = useState<Currency>("YER");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ description: "", amount: "", currency: "YER" as Currency, dueDate: "" });
  const [paying, setPaying] = useState<number | null>(null);
  const session = useSession();
  const isAdmin = session?.role === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/payables?partyId=${id}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setPayables(payload.payables as Payable[]);
      setExpenses(payload.expenses as Expense[]);
      setTotals(Array.isArray(payload.totals) ? payload.totals as PartyCurrencyTotals[] : []);
      setPartyName(typeof payload.party?.name === "string" ? payload.party.name : "");
      if (isCurrency(payload.baseCurrency)) setBase(payload.baseCurrency);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/payables", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partyId: Number(id), ...form }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّر الحفظ."); return; }
      setForm({ description: "", amount: "", currency: base, dueDate: "" });
      setAdding(false);
      setError(null);
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  /* (TD-05) لكل عملةٍ سطرها: كانت البطاقة تجمع مكافئات الريال اليمني لفواتير
     بالسعودي والدولار في رقمٍ واحد، وتحسبه من آخر ٢٠٠ سطرٍ فقط. الإجمالي الآن من
     الخادم لكل عملة، والمتبقي بعملة الالتزام من لقطات السداد. */
  const due = totals.filter((row) => row.remainingMinor !== 0);
  return (
    <main className="mx-auto max-w-3xl p-4 pb-24">
      <header className="mb-4">
        <h1 className="text-xl font-extrabold leading-tight">{partyName || "كشف حساب جهة"}</h1>
        <p className="text-xs text-slate-500">ما عليها وما دُفع لها</p>
        <nav className="mt-2 flex flex-wrap gap-1.5">
          <a href="/finance/parties" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">‹ الجهات</a>
          <a href="/finance" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">الصندوق</a>
          <a href={`/print/party/${id}`} target="_blank" rel="noopener"
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">🖨 طباعة الكشف</a>
        </nav>
      </header>

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      <section className={`mb-4 rounded-2xl border-2 p-4 text-center ${
        due.length > 0 ? "border-amber-300 bg-amber-50" : "border-emerald-300 bg-emerald-50"
      }`}>
        <p className="text-xl font-extrabold">
          {due.length > 0
            ? `علينا ${due.map((row) => formatMoney(row.remainingMinor, row.currency)).join(" + ")}`
            : "الحساب مسدّد"}
        </p>
        {totals.map((row) => (
          <p key={row.currency} className="mt-1 text-[11px] font-bold text-slate-500">
            {CURRENCY_LABEL[row.currency]}: التزامات {formatMoney(row.owedMinor, row.currency)}
            {" · "}مصروف {formatMoney(row.paidMinor, row.currency)}
            {row.unlinkedPaidMinor !== 0 ? ` (منه على الحساب ${formatMoney(row.unlinkedPaidMinor, row.currency)})` : ""}
          </p>
        ))}
      </section>

      {!adding ? (
        <button onClick={() => setAdding(true)}
          className="mb-4 w-full rounded-2xl bg-navy-800 py-2.5 text-sm font-extrabold text-white">
          + سجّل التزامًا (فاتورة مورّد أو عمل مختبر)
        </button>
      ) : (
        <form onSubmit={add} className="mb-4 rounded-2xl border border-navy-800 bg-white p-4">
          <input value={form.description} onChange={(e) => setForm((c) => ({ ...c, description: e.target.value }))}
            placeholder="البيان — مثل: فاتورة مواد يوليو" aria-label="البيان"
            className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
          <div className="mb-2 flex flex-wrap gap-2">
            <input value={form.amount} onChange={(e) => setForm((c) => ({ ...c, amount: e.target.value }))}
              placeholder="المبلغ" aria-label="المبلغ" inputMode="decimal" dir="ltr"
              className="min-w-[8rem] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
            <select value={form.currency} onChange={(e) => setForm((c) => ({ ...c, currency: e.target.value as Currency }))}
              aria-label="العملة" className="w-36 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
              {CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>{CURRENCY_LABEL[currency]}</option>
              ))}
            </select>
            <input type="date" value={form.dueDate} onChange={(e) => setForm((c) => ({ ...c, dueDate: e.target.value }))}
              aria-label="تاريخ الاستحقاق"
              className="w-40 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={busy || !form.description.trim() || !form.amount.trim()}
              className="flex-1 rounded-xl bg-navy-800 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
              احفظ
            </button>
            <button type="button" onClick={() => setAdding(false)}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-600">
              إلغاء
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : (
        <>
          <section className="mb-5" aria-label="الالتزامات">
            <h2 className="mb-2 text-sm font-bold">الالتزامات ({payables.length})</h2>
            {payables.length === 0 ? (
              <p className="rounded-2xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-400">
                لا التزامات مسجّلة.
              </p>
            ) : (
              <ul className="space-y-2">
                {payables.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white p-3">
                    <div className="min-w-[9rem] flex-1">
                      <p className="truncate text-sm font-extrabold">{row.description}</p>
                      <p className="text-[11px] text-slate-500">
                        {friendlyDateLong(row.createdAt.slice(0, 10))}
                        {row.labOrderId ? " · من أمر مختبر" : ""}
                        {row.dueDate ? ` · يستحق ${friendlyDateLong(row.dueDate)}` : ""}
                      </p>
                    </div>
                    <div className="text-left">
                      <p className="text-sm font-extrabold">{formatMoney(row.amountMinor, row.currency)}</p>
                      {row.currency !== base ? (
                        <p className="text-[11px] text-slate-400">= {formatMoney(row.baseAmountMinor, base)}</p>
                      ) : null}
                      <p className={`text-[11px] font-bold ${row.remainingMinor > 0 ? "text-amber-700" : "text-emerald-700"}`}>
                        {row.remainingMinor > 0 ? `متبقٍ ${formatMoney(row.remainingMinor, row.currency)}` : "مسدَّدة"}
                      </p>
                    </div>
                    {row.remainingMinor > 0 && paying !== row.id ? (
                      <button type="button" onClick={() => setPaying(row.id)}
                        className="shrink-0 rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-bold text-white">
                        سداد
                      </button>
                    ) : null}
                    {paying === row.id ? (
                      <PayBillForm partyId={Number(id)} payable={row} isAdmin={isAdmin}
                        onCancel={() => setPaying(null)}
                        onPaid={async () => { setPaying(null); await load(); }} />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="المدفوع">
            <h2 className="mb-2 text-sm font-bold">المدفوع ({expenses.length})</h2>
            {expenses.length === 0 ? (
              <p className="rounded-2xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-400">
                لم يُدفع شيء بعد.
              </p>
            ) : (
              <ul className="space-y-2">
                {expenses.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-3">
                    <div className="min-w-[9rem] flex-1">
                      <p className="text-sm font-extrabold">{EXPENSE_CATEGORY_LABEL[row.category] ?? row.category}</p>
                      <p className="text-[11px] text-slate-500">
                        {row.voucherNumber} · {friendlyDateLong(row.createdAt.slice(0, 10))}
                        {row.payableId !== null && row.payableCurrency && row.payableSettledMinor !== null
                          ? ` · خُصم من الفاتورة ${formatMoney(row.payableSettledMinor, row.payableCurrency)}` : ""}
                        {row.note ? ` · ${row.note}` : ""}
                      </p>
                    </div>
                    <p className="text-sm font-extrabold text-emerald-800">{formatMoney(row.amountMinor, row.currency)}</p>
                    <a href={`/print/voucher/${row.id}`} target="_blank" rel="noopener"
                      className="shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">
                      السند
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
