"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CURRENCIES,
  CURRENCY_LABEL,
  CURRENCY_SHORT,
  formatMoney,
  isCurrency,
  parseAmount,
  type Currency,
} from "@/lib/money";
import { useSetting } from "@/components/SettingsProvider";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABEL,
  categoryForParty,
  expectedInBox,
  type ExpenseCategory,
  type PartyKind,
} from "@/lib/expenses";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { PageHeader } from "@/components/PageHeader";
import { financeLinks } from "@/components/financeLinks";

/**
 * الصندوق: وردية واحدة مفتوحة، وجرد آخر اليوم.
 *
 * الوردية ليست بيروقراطية: بلا إغلاق يومي لا أحد يعرف أن الصندوق نقص، ويظهر النقص
 * بعد شهر رقمًا لا يُفسَّر. وبلا وردية مفتوحة لا تُقبل دفعة أصلًا — دفعةٌ خارج
 * الورديات مالٌ دخل ولا يظهر في أي إغلاق.
 *
 * والجرد **بالورق لا بالمكافئ**: من يعدّ الصندوق يعدّ دولارات ودولارات وريالات كلًّا
 * على حدة، فالمقارنة تجري لكل عملة وحدها.
 */

interface Shift {
  id: number;
  openedBy: string;
  openedAt: string;
  opening: Record<Currency, number>;
  closedBy: string | null;
  closedAt: string | null;
  counted: Record<Currency, number> | null;
  note: string | null;
  status: "open" | "closed";
}

interface Payment {
  id: number; receiptNumber: string; patientId: number; patientName: string;
  kind: "payment" | "refund"; amountMinor: number; currency: Currency;
  exchangeRate: number; baseAmountMinor: number; method: string; createdAt: string;
}

interface Expense {
  id: number; voucherNumber: string; category: ExpenseCategory;
  partyName: string | null; payeeText: string | null;
  amountMinor: number; currency: Currency; exchangeRate: number;
  baseAmountMinor: number; note: string | null; createdAt: string;
}

interface Party { id: number; name: string; kind: PartyKind; commissionPercent: number; isActive: boolean }

interface Feed {
  open: Shift | null;
  totals: { byCurrency: Record<Currency, number>; baseTotalMinor: number; paymentCount: number };
  expenseTotals: {
    byCategory: Record<ExpenseCategory, number>;
    byCurrency: Record<Currency, number>;
    baseTotalMinor: number;
    count: number;
  };
  payments: Payment[];
  expenses: Expense[];
  recent: Shift[];
}

const emptyAmounts = (): Record<Currency, string> => ({ YER: "", SAR: "", USD: "" });

export default function FinancePage() {
  const baseSetting = useSetting("finance.base_currency");
  const base: Currency = isCurrency(baseSetting) ? baseSetting : "YER";
  const today = useMemo(() => clinicDateString(new Date(), "Asia/Aden"), []);

  const [feed, setFeed] = useState<Feed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(emptyAmounts);
  const [counted, setCounted] = useState(emptyAmounts);
  const [note, setNote] = useState("");
  const [closing, setClosing] = useState(false);
  const [parties, setParties] = useState<Party[]>([]);
  const [spending, setSpending] = useState(false);
  const [expenseForm, setExpenseForm] = useState({
    category: "lab" as ExpenseCategory, partyId: "", payee: "",
    amount: "", currency: base as Currency, note: "",
  });
  const [lastVoucherId, setLastVoucherId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [response, partiesResponse] = await Promise.all([
        fetch("/api/shifts", { cache: "no-store" }),
        fetch("/api/parties", { cache: "no-store" }),
      ]);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setFeed(payload as Feed);
      if (partiesResponse.ok) setParties(await partiesResponse.json());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const expected = useMemo(() => {
    if (!feed?.open) return null;
    return expectedInBox(feed.open.opening, feed.totals.byCurrency, feed.expenseTotals.byCurrency);
  }, [feed]);

  const open = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/shifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opening }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّر فتح الوردية."); return; }
      setOpening(emptyAmounts());
      setError(null);
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  }, [busy, opening, load]);

  const spend = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(expenseForm),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّر تسجيل الصرف."); return; }
      setLastVoucherId((payload as { id: number }).id);
      setExpenseForm((current) => ({ ...current, amount: "", note: "", payee: "" }));
      setSpending(false);
      setError(null);
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  }, [busy, expenseForm, load]);

  const close = useCallback(async () => {
    if (busy || !feed?.open) return;
    setBusy(true);
    try {
      const response = await fetch("/api/shifts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: feed.open.id, counted, note }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّر الإغلاق."); return; }
      setCounted(emptyAmounts());
      setNote("");
      setClosing(false);
      setError(null);
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  }, [busy, feed, counted, note, load]);

  return (
    <main className="mx-auto max-w-3xl p-4 pb-24">
      <PageHeader
        title="الصندوق"
        subtitle={friendlyDateLong(today)}
        links={financeLinks("/finance")}
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {loading && !feed ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : !feed?.open ? (
        <section className="mb-5 rounded-2xl border-2 border-brand-orange bg-white p-4" aria-label="فتح الوردية">
          <h2 className="mb-1 text-sm font-bold">لا توجد وردية مفتوحة</h2>
          <p className="mb-3 text-xs leading-relaxed text-slate-500">
            لا يمكن قبض أي مبلغ قبل فتح الوردية. اكتب ما في الصندوق الآن — واتركه فارغًا
            إن كان صفرًا.
          </p>
          <div className="mb-3 grid gap-2 sm:grid-cols-3">
            {CURRENCIES.map((currency) => (
              <label key={currency} className="block">
                <span className="mb-1 block text-[11px] font-bold text-slate-500">{CURRENCY_LABEL[currency]}</span>
                <input
                  value={opening[currency]}
                  onChange={(event) => setOpening((current) => ({ ...current, [currency]: event.target.value }))}
                  inputMode="decimal"
                  dir="ltr"
                  placeholder="0"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue"
                />
              </label>
            ))}
          </div>
          <button onClick={open} disabled={busy}
            className="w-full rounded-xl bg-brand-orange py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
            افتح الوردية
          </button>
        </section>
      ) : (
        <>
          <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4" aria-label="الوردية المفتوحة">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="text-sm font-bold">وردية مفتوحة</span>
              <span className="text-[11px] font-bold text-slate-400">
                فتحها {feed.open.openedBy} · {new Date(feed.open.openedAt).toLocaleTimeString("ar-YE-u-nu-latn", { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <div className="mb-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-emerald-50 px-2 py-2">
                <p className="text-sm font-extrabold text-emerald-800">{formatMoney(feed.totals.baseTotalMinor, base)}</p>
                <p className="text-[11px] font-bold text-emerald-700">قُبض</p>
              </div>
              <div className="rounded-xl bg-red-50 px-2 py-2">
                <p className="text-sm font-extrabold text-red-700">{formatMoney(feed.expenseTotals.baseTotalMinor, base)}</p>
                <p className="text-[11px] font-bold text-red-600">صُرف</p>
              </div>
              <div className="rounded-xl bg-slate-100 px-2 py-2">
                <p className="text-sm font-extrabold">
                  {formatMoney(feed.totals.baseTotalMinor - feed.expenseTotals.baseTotalMinor, base)}
                </p>
                <p className="text-[11px] font-bold text-slate-600">الصافي</p>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {CURRENCIES.map((currency) => (
                <div key={currency} className="rounded-xl border border-slate-200 p-2 text-center">
                  <p className="text-sm font-extrabold">{formatMoney(expected?.[currency] ?? 0, currency)}</p>
                  <p className="text-[11px] text-slate-500">
                    {CURRENCY_LABEL[currency]} — المتوقَّع في الصندوق
                  </p>
                </div>
              ))}
            </div>

            {!closing ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {/* الصرف عملية يومية لا عملية خطر. كان بأحمر التلف، والأحمر الذي
                    يُضغط عشر مرات في اليوم يُفقد الأحمر معناه — فحين يظهر أحمرٌ
                    حقيقي (حذف، عكس قيد) لا يراه أحد. */}
                <button onClick={() => setSpending((open) => !open)}
                  className="flex-1 rounded-xl bg-navy-900 py-2.5 text-sm font-extrabold text-white hover:bg-navy-800">
                  {spending ? "إغلاق" : "سند صرف"}
                </button>
                <button onClick={() => setClosing(true)}
                  className="flex-1 rounded-xl border border-slate-300 bg-white py-2.5 text-sm font-bold text-slate-700">
                  إغلاق الوردية وجرد الصندوق
                </button>
              </div>
            ) : (
              <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="mb-2 text-xs font-bold text-slate-600">اعدد ما في الصندوق فعلًا:</p>
                <div className="mb-2 grid gap-2 sm:grid-cols-3">
                  {CURRENCIES.map((currency) => {
                    const countedMinor = parseAmount(counted[currency] || "0", currency);
                    const difference = countedMinor === null || !expected
                      ? null : countedMinor - expected[currency];
                    return (
                      <label key={currency} className="block">
                        <span className="mb-1 block text-[11px] font-bold text-slate-500">
                          {CURRENCY_SHORT[currency]} — المتوقَّع {formatMoney(expected?.[currency] ?? 0, currency)}
                        </span>
                        <input
                          value={counted[currency]}
                          onChange={(event) => setCounted((current) => ({ ...current, [currency]: event.target.value }))}
                          inputMode="decimal"
                          dir="ltr"
                          placeholder="0"
                          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                        />
                        {/* الفرق يظهر قبل الحفظ لا بعده: من يرى النقص وهو واقف عند
                            الصندوق يعيد العدّ؛ ومن يراه غدًا لا يستطيع شيئًا. */}
                        {difference !== null && difference !== 0 ? (
                          <span className={`mt-1 block text-[11px] font-bold ${difference < 0 ? "text-red-600" : "text-amber-600"}`}>
                            {difference < 0 ? "نقص" : "زيادة"} {formatMoney(Math.abs(difference), currency)}
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
                <input
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="ملاحظة (اختياري) — سبب الفرق مثلًا"
                  className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                />
                <div className="flex gap-2">
                  <button onClick={close} disabled={busy}
                    className="flex-1 rounded-xl bg-navy-800 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
                    أغلق الوردية
                  </button>
                  <button onClick={() => setClosing(false)}
                    className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-600">
                    إلغاء
                  </button>
                </div>
              </div>
            )}
          </section>

          {lastVoucherId ? (
            <div className="mb-4 rounded-2xl border border-emerald-300 bg-emerald-50 p-3 text-center">
              <p className="mb-2 text-sm font-bold text-emerald-800">سُجّل الصرف.</p>
              <a href={`/print/voucher/${lastVoucherId}`} target="_blank" rel="noopener"
                onClick={() => setLastVoucherId(null)}
                className="inline-block rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white">
                اطبع سند الصرف
              </a>
            </div>
          ) : null}

          {spending ? (
            <section className="mb-4 rounded-2xl border-2 border-navy-800 bg-white p-4" aria-label="سند صرف">
              <h2 className="mb-3 text-sm font-bold">سند صرف</h2>

              <label className="mb-2 block">
                <span className="mb-1 block text-[11px] font-bold text-slate-500">البند</span>
                <select
                  value={expenseForm.category}
                  onChange={(event) => setExpenseForm((current) => ({ ...current, category: event.target.value as ExpenseCategory }))}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                >
                  {EXPENSE_CATEGORIES.map((category) => (
                    <option key={category} value={category}>{EXPENSE_CATEGORY_LABEL[category]}</option>
                  ))}
                </select>
              </label>

              <label className="mb-2 block">
                <span className="mb-1 block text-[11px] font-bold text-slate-500">جهة الصرف</span>
                <select
                  value={expenseForm.partyId}
                  onChange={(event) => {
                    const party = parties.find((item) => String(item.id) === event.target.value);
                    setExpenseForm((current) => ({
                      ...current,
                      partyId: event.target.value,
                      // التصنيف يتبع نوع الجهة: من يختار مختبرًا يقصد مستحقات مختبر.
                      category: party ? categoryForParty(party.kind) : current.category,
                    }));
                  }}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                >
                  <option value="">— جهة غير مسجّلة —</option>
                  {parties.filter((party) => party.isActive).map((party) => (
                    <option key={party.id} value={party.id}>{party.name}</option>
                  ))}
                </select>
              </label>

              {!expenseForm.partyId ? (
                <input
                  value={expenseForm.payee}
                  onChange={(event) => setExpenseForm((current) => ({ ...current, payee: event.target.value }))}
                  placeholder="اسم المستفيد"
                  aria-label="اسم المستفيد"
                  className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                />
              ) : null}

              <div className="mb-2 flex flex-wrap gap-2">
                <input
                  value={expenseForm.amount}
                  onChange={(event) => setExpenseForm((current) => ({ ...current, amount: event.target.value }))}
                  placeholder="المبلغ" aria-label="المبلغ" inputMode="decimal" dir="ltr"
                  className="min-w-[8rem] flex-1 rounded-xl border border-slate-200 px-3 py-2.5 text-base font-bold"
                />
                <select
                  value={expenseForm.currency}
                  onChange={(event) => setExpenseForm((current) => ({ ...current, currency: event.target.value as Currency }))}
                  aria-label="العملة"
                  className="w-36 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm"
                >
                  {CURRENCIES.map((option) => (
                    <option key={option} value={option}>{CURRENCY_LABEL[option]}</option>
                  ))}
                </select>
              </div>

              <input
                value={expenseForm.note}
                onChange={(event) => setExpenseForm((current) => ({ ...current, note: event.target.value }))}
                placeholder="البيان (اختياري)"
                aria-label="البيان"
                className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />

              <button onClick={spend} disabled={busy || !expenseForm.amount.trim()}
                className="w-full rounded-xl bg-red-600 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
                سجّل الصرف واطبع السند
              </button>
            </section>
          ) : null}

          {feed.expenses.length > 0 ? (
            <section className="mb-5" aria-label="مصروفات الوردية">
              <h2 className="mb-2 text-sm font-bold">مصروفات الوردية ({feed.expenses.length})</h2>
              <ul className="space-y-2">
                {feed.expenses.map((expense) => (
                  <li key={expense.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-red-200 bg-red-50 p-3">
                    <div className="min-w-[9rem] flex-1">
                      <p className="truncate text-sm font-extrabold">{expense.partyName ?? expense.payeeText}</p>
                      <p className="text-[11px] text-slate-500">
                        {expense.voucherNumber} · {EXPENSE_CATEGORY_LABEL[expense.category]}
                        {expense.note ? ` · ${expense.note}` : ""}
                      </p>
                    </div>
                    <div className="text-left">
                      <p className="text-sm font-extrabold text-red-700">
                        −{formatMoney(expense.amountMinor, expense.currency)}
                      </p>
                      {expense.currency !== base ? (
                        <p className="text-[11px] text-slate-400">= {formatMoney(expense.baseAmountMinor, base)}</p>
                      ) : null}
                    </div>
                    <a href={`/print/voucher/${expense.id}`} target="_blank" rel="noopener"
                      className="shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">
                      طباعة
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="mb-5" aria-label="حركة الوردية">
            <h2 className="mb-2 text-sm font-bold">حركة الوردية ({feed.payments.length})</h2>
            {feed.payments.length === 0 ? (
              <p className="rounded-2xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-400">
                لم يُقبض شيء بعد.
              </p>
            ) : (
              <ul className="space-y-2">
                {feed.payments.map((payment) => (
                  <li key={payment.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl border p-3 ${
                    payment.kind === "refund" ? "border-red-200 bg-red-50" : "border-slate-200 bg-white"
                  }`}>
                    <div className="min-w-[9rem] flex-1">
                      <a href={`/patients/${payment.patientId}`} className="block truncate text-sm font-extrabold underline decoration-slate-300 underline-offset-4">
                        {payment.patientName}
                      </a>
                      <p className="text-[11px] text-slate-500">
                        {payment.receiptNumber} · {payment.kind === "refund" ? "استرداد" : "قبض"}
                        {payment.currency !== base ? ` · سعر ${payment.exchangeRate}` : ""}
                      </p>
                    </div>
                    <div className="text-left">
                      <p className={`text-sm font-extrabold ${payment.kind === "refund" ? "text-red-700" : ""}`}>
                        {payment.kind === "refund" ? "−" : ""}{formatMoney(payment.amountMinor, payment.currency)}
                      </p>
                      {payment.currency !== base ? (
                        <p className="text-[11px] text-slate-400">= {formatMoney(payment.baseAmountMinor, base)}</p>
                      ) : null}
                    </div>
                    <a
                      href={`/print/receipt/${payment.id}`}
                      target="_blank"
                      rel="noopener"
                      className="shrink-0 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-navy-800"
                    >
                      طباعة السند
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {feed?.recent?.length ? (
        <section aria-label="ورديات سابقة">
          <h2 className="mb-2 text-sm font-bold">ورديات سابقة</h2>
          <ul className="space-y-2">
            {feed.recent.filter((shift) => shift.status === "closed").slice(0, 8).map((shift) => (
              <li key={shift.id} className="rounded-2xl border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-bold">
                    {friendlyDateLong(shift.openedAt.slice(0, 10))} · {shift.openedBy}
                  </span>
                  <span className="text-[11px] text-slate-500">
                    أغلقها {shift.closedBy}
                  </span>
                </div>
                {shift.counted ? (
                  <p className="mt-1 text-[11px] text-slate-500">
                    الجرد: {CURRENCIES.filter((c) => shift.counted![c] > 0).map((c) => formatMoney(shift.counted![c], c)).join(" · ") || "صفر"}
                  </p>
                ) : null}
                {shift.note ? <p className="mt-1 text-[11px] text-slate-600">{shift.note}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
