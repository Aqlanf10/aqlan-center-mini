"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  CURRENCIES,
  CURRENCY_LABEL,
  CURRENCY_SHORT,
  formatMoney,
  parseAmount,
  type Currency,
} from "@/lib/money";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABEL,
  categoryForParty,
  type ExpenseCategory,
  type PartyKind,
} from "@/lib/expenses";
import { friendlyDateLong } from "@/lib/reminders";

export interface ShiftData {
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

export interface PaymentItem {
  id: number;
  receiptNumber: string;
  patientId: number;
  patientName: string;
  kind: "payment" | "refund";
  amountMinor: number;
  currency: Currency;
  exchangeRate: number;
  baseAmountMinor: number;
  method: string;
  createdAt: string;
}

export interface ExpenseItem {
  id: number;
  voucherNumber: string;
  category: ExpenseCategory;
  partyName: string | null;
  payeeText: string | null;
  amountMinor: number;
  currency: Currency;
  exchangeRate: number;
  baseAmountMinor: number;
  note: string | null;
  createdAt: string;
}

export interface PartyItem {
  id: number;
  name: string;
  kind: PartyKind;
  commissionPercent: number;
  isActive: boolean;
}

interface CashShiftTabProps {
  shift: ShiftData | null;
  payments: PaymentItem[];
  expenses: ExpenseItem[];
  recentShifts: ShiftData[];
  expectedInBox: Record<Currency, number> | null;
  baseCurrency: Currency;
  parties: PartyItem[];
  isAdmin: boolean;
  busy: boolean;
  onOpenShift: (opening: Record<Currency, string>) => Promise<void>;
  onCloseShift: (counted: Record<Currency, string>, note: string) => Promise<void>;
  onCreateExpense: (form: {
    category: ExpenseCategory;
    partyId: string;
    payee: string;
    amount: string;
    currency: Currency;
    note: string;
  }) => Promise<number | void>;
  onRemoveExpense: (voucherId: number, voucherNumber: string) => Promise<void>;
  onOpenQuickCollect: () => void;
  lastVoucherId: number | null;
  onClearLastVoucher: () => void;
  lastReceiptId: number | null;
  onClearLastReceipt: () => void;
  spending: boolean;
  setSpending: React.Dispatch<React.SetStateAction<boolean>>;
  closing: boolean;
  setClosing: React.Dispatch<React.SetStateAction<boolean>>;
}

const emptyAmounts = (): Record<Currency, string> => ({ YER: "", SAR: "", USD: "" });

export function CashShiftTab({
  shift,
  payments,
  expenses,
  recentShifts,
  expectedInBox,
  baseCurrency,
  parties,
  isAdmin,
  busy,
  onOpenShift,
  onCloseShift,
  onCreateExpense,
  onRemoveExpense,
  onOpenQuickCollect,
  lastVoucherId,
  onClearLastVoucher,
  lastReceiptId,
  onClearLastReceipt,
  spending,
  setSpending,
  closing,
  setClosing,
}: CashShiftTabProps) {
  // نماذج الإدخال
  const [opening, setOpening] = useState(emptyAmounts);
  const [counted, setCounted] = useState(emptyAmounts);
  const [closeNote, setCloseNote] = useState("");

  const [expenseForm, setExpenseForm] = useState({
    category: "lab" as ExpenseCategory,
    partyId: "",
    payee: "",
    amount: "",
    currency: baseCurrency,
    note: "",
  });

  // تصفية حركات الصندوق
  const [txFilter, setTxFilter] = useState<"all" | "payments" | "expenses">("all");
  const [searchQuery, setSearchQuery] = useState("");

  // تصفية المعاملات حسب البحث والنوع
  const filteredPayments = useMemo(() => {
    if (txFilter === "expenses") return [];
    if (!searchQuery.trim()) return payments;
    const q = searchQuery.toLowerCase();
    return payments.filter(
      (p) =>
        p.patientName.toLowerCase().includes(q) ||
        p.receiptNumber.toLowerCase().includes(q)
    );
  }, [payments, txFilter, searchQuery]);

  const filteredExpenses = useMemo(() => {
    if (txFilter === "payments") return [];
    if (!searchQuery.trim()) return expenses;
    const q = searchQuery.toLowerCase();
    return expenses.filter(
      (e) =>
        (e.partyName && e.partyName.toLowerCase().includes(q)) ||
        (e.payeeText && e.payeeText.toLowerCase().includes(q)) ||
        e.voucherNumber.toLowerCase().includes(q) ||
        (e.note && e.note.toLowerCase().includes(q))
    );
  }, [expenses, txFilter, searchQuery]);

  const totalTxCount = filteredPayments.length + filteredExpenses.length;

  return (
    <div className="space-y-6">
      {/* إشعارات الإجراءات الناجحة الأخيرة */}
      {lastReceiptId ? (
        <div className="flex items-center justify-between rounded-2xl border border-emerald-300 bg-emerald-50 p-3.5 text-emerald-900 shadow-xs">
          <div className="flex items-center gap-2">
            <span className="text-xl">✅</span>
            <p className="text-xs sm:text-sm font-bold">
              تم إصدار سند القبض بنجاح وتحديث رصيد الصندوق الفعلي.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={`/print/receipt/${lastReceiptId}`}
              target="_blank"
              rel="noopener"
              className="rounded-xl bg-emerald-700 px-3 py-1.5 text-xs font-black text-white hover:bg-emerald-800"
            >
              طباعة السند 🖨️
            </a>
            <button
              type="button"
              onClick={onClearLastReceipt}
              className="rounded-lg p-1 text-emerald-700 hover:bg-emerald-200/50"
            >
              ✕
            </button>
          </div>
        </div>
      ) : null}

      {lastVoucherId ? (
        <div className="flex items-center justify-between rounded-2xl border border-rose-300 bg-rose-50 p-3.5 text-rose-900 shadow-xs">
          <div className="flex items-center gap-2">
            <span className="text-xl">🧾</span>
            <p className="text-xs sm:text-sm font-bold">
              تم تسجيل سند الصرف النثري بنجاح وخصمه من رصيد الصندوق.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={`/print/voucher/${lastVoucherId}`}
              target="_blank"
              rel="noopener"
              className="rounded-xl bg-rose-700 px-3 py-1.5 text-xs font-black text-white hover:bg-rose-800"
            >
              طباعة سند الصرف 🖨️
            </a>
            <button
              type="button"
              onClick={onClearLastVoucher}
              className="rounded-lg p-1 text-rose-700 hover:bg-rose-200/50"
            >
              ✕
            </button>
          </div>
        </div>
      ) : null}

      {/* إذا كان الصندوق مغلقاً: نموذج فتح الوردية */}
      {!shift ? (
        <section
          aria-label="فتح الوردية"
          className="rounded-3xl border-2 border-brand-orange bg-white p-6 shadow-sm"
        >
          <div className="mb-4 flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-900 text-2xl">
              🔐
            </span>
            <div>
              <h2 className="text-base sm:text-lg font-black text-navy-900">
                الصندوق مغلق — فتح وردية عمل جديدة
              </h2>
              <p className="text-xs text-slate-500 font-medium">
                وثّق عهدة الصندوق النقدية الافتتاحية لبدء استقبال المرضى وتحصيل الدفعات وتسجيل الصرف
              </p>
            </div>
          </div>

          <p className="mb-4 text-xs leading-relaxed text-slate-600">
            أدخل النقد الفعلي المتواجد في درج الصندوق الآن لكل عملة (اترك الحقل فارغاً أو صفراً إذا
            لم يوجد رصيد افتتاحي):
          </p>

          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            {CURRENCIES.map((currency) => (
              <label
                key={currency}
                className="block rounded-2xl border border-slate-200 bg-slate-50/70 p-3.5 transition-colors focus-within:border-brand-orange focus-within:bg-white"
              >
                <span className="mb-1.5 block text-xs font-black text-navy-900">
                  {CURRENCY_LABEL[currency]} ({CURRENCY_SHORT[currency]})
                </span>
                <input
                  value={opening[currency]}
                  onChange={(e) =>
                    setOpening((curr) => ({ ...curr, [currency]: e.target.value }))
                  }
                  inputMode="decimal"
                  dir="ltr"
                  placeholder="0.00"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-base font-mono font-bold text-navy-900 outline-none focus:border-brand-orange"
                />
              </label>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void onOpenShift(opening)}
            disabled={busy}
            className="w-full rounded-2xl bg-brand-orange py-3 text-sm font-black text-white shadow-xs hover:brightness-105 disabled:opacity-50 transition-all"
          >
            {busy ? "جارٍ فتح الوردية…" : "افتح وردية الصندوق الآن 🚀"}
          </button>
        </section>
      ) : (
        /* الوردية المفتوحة والبيانات اللحظية */
        <section
          aria-label="الوردية المفتوحة الحالية"
          className="rounded-3xl border border-slate-200 bg-white p-5 shadow-xs"
        >
          {/* ترويسة بطاقة الوردية */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-3 w-3 rounded-full bg-emerald-500 animate-pulse" />
              <div>
                <h3 className="text-sm font-black text-navy-900">وردية الصندوق المفتوحة</h3>
                <p className="text-xs text-slate-500">
                  المسؤول: <span className="font-bold text-navy-900">{shift.openedBy}</span> · فُتحت
                  الساعة:{" "}
                  {new Date(shift.openedAt).toLocaleTimeString("ar-YE-u-nu-latn", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onOpenQuickCollect}
                className="flex items-center gap-1 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-black text-white shadow-xs hover:bg-emerald-700"
              >
                <span>+</span>
                <span>سند قبض</span>
              </button>

              <button
                type="button"
                onClick={() => setSpending((s) => !s)}
                className={`flex items-center gap-1 rounded-xl px-3 py-1.5 text-xs font-bold transition-colors ${
                  spending
                    ? "bg-rose-100 text-rose-800"
                    : "border border-slate-200 bg-white text-rose-700 hover:bg-rose-50"
                }`}
              >
                <span>{spending ? "إلغاء الصرف" : "+ سند صرف"}</span>
              </button>

              <button
                type="button"
                onClick={() => setClosing((c) => !c)}
                className={`flex items-center gap-1 rounded-xl px-3 py-1.5 text-xs font-bold transition-colors ${
                  closing
                    ? "bg-amber-100 text-amber-900"
                    : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                <span>🔒</span>
                <span>{closing ? "إلغاء الجرد" : "إغلاق الوردية"}</span>
              </button>
            </div>
          </div>

          {/* أرصدة العملات المتوقعة بالدرج */}
          <div className="grid gap-2.5 sm:grid-cols-3">
            {CURRENCIES.map((currency) => (
              <div
                key={currency}
                className="rounded-2xl border border-slate-200/80 bg-slate-50/60 p-3 text-center transition-colors"
              >
                <span className="text-[11px] font-bold text-slate-500">
                  {CURRENCY_LABEL[currency]} المتوقع بالصندوق
                </span>
                <p className="mt-1 text-base font-mono font-black text-navy-900">
                  {formatMoney(expectedInBox?.[currency] ?? 0, currency)}
                </p>
                <div className="mt-1 flex items-center justify-center gap-2 text-[10px] text-slate-400 font-mono">
                  <span>عهد: {formatMoney(shift.opening[currency] || 0, currency)}</span>
                </div>
              </div>
            ))}
          </div>

          {/* نموذج تسجيل سند صرف نثري جديد */}
          {spending ? (
            <div className="mt-4 rounded-2xl border-2 border-rose-300 bg-rose-50/40 p-4">
              <h4 className="mb-3 text-xs font-black text-rose-900">
                تسجيل سند صرف نثري جديد من الصندوق
              </h4>
              <div className="grid gap-2.5 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[11px] font-bold text-slate-600">بند المصروف</span>
                  <select
                    value={expenseForm.category}
                    onChange={(e) =>
                      setExpenseForm((curr) => ({
                        ...curr,
                        category: e.target.value as ExpenseCategory,
                      }))
                    }
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold"
                  >
                    {EXPENSE_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {EXPENSE_CATEGORY_LABEL[cat] || cat}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1 block text-[11px] font-bold text-slate-600">
                    الجهة أو المورد المستفيد
                  </span>
                  <select
                    value={expenseForm.partyId}
                    onChange={(e) => {
                      const party = parties.find((p) => String(p.id) === e.target.value);
                      setExpenseForm((curr) => ({
                        ...curr,
                        partyId: e.target.value,
                        category: party ? categoryForParty(party.kind) : curr.category,
                      }));
                    }}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold"
                  >
                    <option value="">— جهة غير مسجلة / مستفيد مباشر —</option>
                    {parties
                      .filter((p) => p.isActive)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </label>
              </div>

              {!expenseForm.partyId ? (
                <div className="mt-2.5">
                  <input
                    value={expenseForm.payee}
                    onChange={(e) => setExpenseForm((curr) => ({ ...curr, payee: e.target.value }))}
                    placeholder="اسم المستفيد المباشر"
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
                  />
                </div>
              ) : null}

              <div className="mt-2.5 flex flex-wrap gap-2">
                <input
                  value={expenseForm.amount}
                  onChange={(e) => setExpenseForm((curr) => ({ ...curr, amount: e.target.value }))}
                  placeholder="المبلغ"
                  inputMode="decimal"
                  dir="ltr"
                  className="min-w-[7rem] flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-mono font-bold"
                />
                <select
                  value={expenseForm.currency}
                  onChange={(e) =>
                    setExpenseForm((curr) => ({ ...curr, currency: e.target.value as Currency }))
                  }
                  className="w-32 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold"
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {CURRENCY_LABEL[c]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-2.5">
                <input
                  value={expenseForm.note}
                  onChange={(e) => setExpenseForm((curr) => ({ ...curr, note: e.target.value }))}
                  placeholder="البيان ومبرر الصرف بالتفصيل"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
                />
              </div>

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    await onCreateExpense(expenseForm);
                    setExpenseForm({
                      category: "lab",
                      partyId: "",
                      payee: "",
                      amount: "",
                      currency: baseCurrency,
                      note: "",
                    });
                  }}
                  disabled={busy || !expenseForm.amount.trim()}
                  className="flex-1 rounded-xl bg-rose-700 py-2.5 text-xs font-black text-white hover:bg-rose-800 disabled:opacity-50"
                >
                  {busy ? "جارٍ الصرف…" : "سجّل الصرف واطبع السند 🖨️"}
                </button>
                <button
                  type="button"
                  onClick={() => setSpending(false)}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-100"
                >
                  إلغاء
                </button>
              </div>
            </div>
          ) : null}

          {/* نموذج جرد وإغلاق الوردية */}
          {closing ? (
            <div className="mt-4 rounded-2xl border-2 border-amber-300 bg-amber-50/40 p-4">
              <h4 className="mb-2 text-xs font-black text-amber-950">
                مطابقة وجرد النقد الفعلي وإغلاق الوردية
              </h4>
              <p className="mb-3 text-[11px] text-slate-600">
                أدخل المبالغ النقدية الموجودة فعلياً في الدرج الآن للتحقق من الفارق المحاسبي:
              </p>

              <div className="mb-3 grid gap-2.5 sm:grid-cols-3">
                {CURRENCIES.map((currency) => {
                  const countedMinor = parseAmount(counted[currency] || "0", currency);
                  const difference =
                    countedMinor === null || !expectedInBox
                      ? null
                      : countedMinor - expectedInBox[currency];

                  return (
                    <label
                      key={currency}
                      className="block rounded-xl border border-slate-200 bg-white p-2.5"
                    >
                      <span className="mb-1 block text-[10px] font-bold text-slate-500">
                        {CURRENCY_SHORT[currency]} — المتوقع:{" "}
                        {formatMoney(expectedInBox?.[currency] ?? 0, currency)}
                      </span>
                      <input
                        value={counted[currency]}
                        onChange={(e) =>
                          setCounted((curr) => ({ ...curr, [currency]: e.target.value }))
                        }
                        inputMode="decimal"
                        dir="ltr"
                        placeholder="0.00"
                        className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-mono font-bold text-navy-900"
                      />
                      {difference !== null && difference !== 0 ? (
                        <span
                          className={`mt-1 block text-[11px] font-black ${
                            difference < 0 ? "text-rose-600" : "text-amber-600"
                          }`}
                        >
                          {difference < 0 ? "عجز / نقص" : "زيادة"}{" "}
                          {formatMoney(Math.abs(difference), currency)}
                        </span>
                      ) : difference === 0 ? (
                        <span className="mt-1 block text-[10px] font-bold text-emerald-700">
                          ✓ مطابق تماماً
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>

              <input
                value={closeNote}
                onChange={(e) => setCloseNote(e.target.value)}
                placeholder="ملاحظة الإقفال (اختياري) — سبب الفارق أو رقم الإيداع البنكي"
                className="mb-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
              />

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void onCloseShift(counted, closeNote)}
                  disabled={busy}
                  className="flex-1 rounded-xl bg-navy-900 py-2.5 text-xs font-black text-white hover:bg-navy-800 disabled:opacity-50"
                >
                  {busy ? "جارٍ الإغلاق وترحيل القيود…" : "تأكيد إغلاق الوردية وترحيل الجرد 🔒"}
                </button>
                <button
                  type="button"
                  onClick={() => setClosing(false)}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-100"
                >
                  إلغاء
                </button>
              </div>
            </div>
          ) : null}
        </section>
      )}

      {/* حركات وسجلات الصندوق لليوم */}
      <section aria-label="حركات الصندوق اليوم" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setTxFilter("all")}
              className={`rounded-lg px-3 py-1 text-xs font-bold transition-all ${
                txFilter === "all" ? "bg-white text-navy-900 shadow-2xs" : "text-slate-600 hover:text-navy-900"
              }`}
            >
              الكل ({payments.length + expenses.length})
            </button>
            <button
              type="button"
              onClick={() => setTxFilter("payments")}
              className={`rounded-lg px-3 py-1 text-xs font-bold transition-all ${
                txFilter === "payments"
                  ? "bg-white text-emerald-800 shadow-2xs"
                  : "text-slate-600 hover:text-emerald-700"
              }`}
            >
              سندات القبض ({payments.length})
            </button>
            <button
              type="button"
              onClick={() => setTxFilter("expenses")}
              className={`rounded-lg px-3 py-1 text-xs font-bold transition-all ${
                txFilter === "expenses"
                  ? "bg-white text-rose-800 shadow-2xs"
                  : "text-slate-600 hover:text-rose-700"
              }`}
            >
              سندات الصرف ({expenses.length})
            </button>
          </div>

          <div className="w-full sm:w-64">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="بحث باسم المريض أو رقم السند…"
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium outline-none focus:border-navy-500"
            />
          </div>
        </div>

        {totalTxCount === 0 ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-400">
            {searchQuery
              ? "لا توجد نتائج مطابقة لبحثك في حركات هذه الوردية."
              : "لم تُسجل أي حركة مالية في هذه الوردية بعد."}
          </div>
        ) : (
          <div className="space-y-2">
            {/* عرض سندات القبض */}
            {filteredPayments.map((payment) => (
              <div
                key={`p-${payment.id}`}
                className={`flex flex-wrap items-center justify-between gap-2.5 rounded-2xl border p-3 transition-colors ${
                  payment.kind === "refund"
                    ? "border-rose-200 bg-rose-50/60"
                    : "border-slate-200/90 bg-white hover:border-slate-300"
                }`}
              >
                <div className="min-w-[9rem] flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-md px-1.5 py-0.5 text-[10px] font-black ${
                        payment.kind === "refund"
                          ? "bg-rose-100 text-rose-800"
                          : "bg-emerald-100 text-emerald-800"
                      }`}
                    >
                      {payment.kind === "refund" ? "استرداد" : "قبض"}
                    </span>
                    <Link
                      href={`/patients/${payment.patientId}`}
                      className="text-xs font-black text-navy-900 hover:text-brand-orange underline decoration-slate-200 hover:decoration-brand-orange"
                    >
                      {payment.patientName}
                    </Link>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-500 font-mono">
                    سند #{payment.receiptNumber} · {payment.method === "cash" ? "نقدًا" : "تحويل"}
                    {payment.currency !== baseCurrency
                      ? ` · سعر ${payment.exchangeRate}`
                      : ""}
                  </p>
                </div>

                <div className="text-left">
                  <p
                    className={`text-sm font-mono font-black ${
                      payment.kind === "refund" ? "text-rose-700" : "text-emerald-800"
                    }`}
                  >
                    {payment.kind === "refund" ? "−" : "+"}
                    {formatMoney(payment.amountMinor, payment.currency)}
                  </p>
                  {payment.currency !== baseCurrency ? (
                    <p className="text-[10px] font-mono text-slate-400">
                      = {formatMoney(payment.baseAmountMinor, baseCurrency)}
                    </p>
                  ) : null}
                </div>

                <div className="flex items-center gap-1.5">
                  <a
                    href={`/print/receipt/${payment.id}`}
                    target="_blank"
                    rel="noopener"
                    className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800 hover:bg-slate-50 transition-colors"
                  >
                    طباعة
                  </a>
                </div>
              </div>
            ))}

            {/* عرض سندات الصرف */}
            {filteredExpenses.map((expense) => (
              <div
                key={`e-${expense.id}`}
                className="flex flex-wrap items-center justify-between gap-2.5 rounded-2xl border border-rose-200/80 bg-rose-50/50 p-3"
              >
                <div className="min-w-[9rem] flex-1">
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-rose-200/80 px-1.5 py-0.5 text-[10px] font-black text-rose-900">
                      صرف نثري
                    </span>
                    <span className="text-xs font-black text-navy-900">
                      {expense.partyName ?? expense.payeeText}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-500 font-mono">
                    سند #{expense.voucherNumber} · {EXPENSE_CATEGORY_LABEL[expense.category] || expense.category}
                    {expense.note ? ` · ${expense.note}` : ""}
                  </p>
                </div>

                <div className="text-left">
                  <p className="text-sm font-mono font-black text-rose-700">
                    −{formatMoney(expense.amountMinor, expense.currency)}
                  </p>
                  {expense.currency !== baseCurrency ? (
                    <p className="text-[10px] font-mono text-slate-400">
                      = {formatMoney(expense.baseAmountMinor, baseCurrency)}
                    </p>
                  ) : null}
                </div>

                <div className="flex items-center gap-1.5">
                  <a
                    href={`/print/voucher/${expense.id}`}
                    target="_blank"
                    rel="noopener"
                    className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800 hover:bg-slate-50 transition-colors"
                  >
                    طباعة
                  </a>
                  {isAdmin ? (
                    <button
                      type="button"
                      onClick={() => void onRemoveExpense(expense.id, expense.voucherNumber)}
                      disabled={busy}
                      className="rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-[11px] font-bold text-slate-400 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                      title="حذف سند الصرف للمدير"
                    >
                      🗑
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* سجل الورديات المغلقة السابقة */}
      {recentShifts.length > 0 ? (
        <section aria-label="الورديات السابقة" className="border-t border-slate-200 pt-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs font-black text-navy-900">
              سجل الورديات السابقة المغلقة
            </h3>
            <Link
              href="/finance/reconciliation"
              className="text-xs font-bold text-brand-blue hover:underline"
            >
              سجل المطابقة الكامل والتسويات ↗
            </Link>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {recentShifts
              .filter((s) => s.status === "closed")
              .slice(0, 4)
              .map((s) => (
                <div
                  key={s.id}
                  className="rounded-2xl border border-slate-200 bg-white p-3 text-xs shadow-2xs"
                >
                  <div className="flex items-center justify-between font-bold text-navy-900">
                    <span>{friendlyDateLong(s.openedAt.slice(0, 10))}</span>
                    <span className="text-[10px] text-slate-500 font-normal">
                      فتحها {s.openedBy} · أغلقها {s.closedBy}
                    </span>
                  </div>
                  {s.counted ? (
                    <p className="mt-1 font-mono text-[11px] text-slate-600">
                      الجرد:{" "}
                      {CURRENCIES.filter((c) => s.counted![c] > 0)
                        .map((c) => formatMoney(s.counted![c], c))
                        .join(" · ") || "صفر"}
                    </p>
                  ) : null}
                  {s.note ? (
                    <p className="mt-1 text-[11px] text-slate-500">ملاحظة: {s.note}</p>
                  ) : null}
                </div>
              ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
