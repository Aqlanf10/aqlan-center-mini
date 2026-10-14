"use client";

import { useId } from "react";
import { formatMoney, parseAmount, type Currency } from "@/lib/money";
import { validateDebtRepaymentTerms, type DebtInstallment } from "@/lib/debt-installments";

export interface DebtRepaymentDraft {
  mode: "full" | "installments";
  rows: { key: string; dueDate: string; amount: string; kind: DebtInstallment["kind"] }[];
}

export function readDebtRepaymentDraft(draft: DebtRepaymentDraft, currency: Currency, remainingMinor: number) {
  return validateDebtRepaymentTerms({ mode: draft.mode, installments: draft.mode === "full" ? []
    : draft.rows.map(row => ({ dueDate: row.dueDate, amountMinor: parseAmount(row.amount,currency), kind: row.kind })) },remainingMinor);
}

/** Controlled editor only. The owning invoice/agreement command must persist its
 * validated terms atomically; this component never writes a receipt or debt. */
export function DebtRepaymentEditor({ value, onChange, currency, remainingMinor, today, disabled = false, compact = false }: {
  value: DebtRepaymentDraft; onChange: (value: DebtRepaymentDraft) => void;
  currency: Currency; remainingMinor: number; today: string; disabled?: boolean; compact?: boolean;
}) {
  const group = useId();
  const checked = readDebtRepaymentDraft(value,currency,remainingMinor);
  const amounts = value.rows.map(row => parseAmount(row.amount,currency));
  const total = amounts.every(amount => amount !== null && amount > 0)
    ? amounts.reduce<number>((sum,amount) => sum + (amount ?? 0),0) : null;
  const safeTotal = total !== null && Number.isSafeInteger(total) ? total : null;
  const changeRow = (key: string, patch: Partial<DebtRepaymentDraft["rows"][number]>) => {
    if (!disabled) onChange({ ...value, rows: value.rows.map(row => row.key === key ? { ...row, ...patch } : row) });
  };
  const newRow = () => ({ key: crypto.randomUUID(), dueDate: value.rows.at(-1)?.dueDate || today, amount: "", kind: "installment" as const });
  return <fieldset disabled={disabled} dir="rtl" data-testid="debt-repayment-editor" data-compact={compact} className="min-w-0 space-y-3 rounded-2xl border border-slate-200 bg-white p-3">
    <legend className="px-1 text-sm font-extrabold text-slate-900">طريقة سداد الاتفاق</legend>
    <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
      {([ ["full", "دفعة واحدة"], ["installments", "جدول أقساط"] ] as const).map(([mode,label]) =>
        <label key={mode} className={`flex min-h-[44px] min-w-0 cursor-pointer items-center gap-2 rounded-xl border p-3 text-sm font-bold ${value.mode === mode ? "border-sky-600 bg-sky-50 text-sky-900" : "border-slate-200"}`}>
          <input type="radio" name={group} value={mode} checked={value.mode === mode}
            disabled={disabled || mode === "installments" && remainingMinor <= 0}
            onChange={() => { if (!disabled) onChange({ mode, rows: mode === "installments" && !value.rows.length ? [newRow()] : value.rows }); }} />
          {label}
        </label>)}
    </div>
    {!compact?<p className="text-sm">الدين الذي سيُسدَّد: <strong>{formatMoney(remainingMinor,currency)}</strong></p>:null}
    <p className="text-xs leading-6 text-slate-600">اختيار طريقة السداد لا يسجّل مبلغًا محصّلًا. التحصيل الفعلي يُثبت بسند قبض مستقل.</p>
    {value.mode === "installments" ? <>
      {!compact?<p className="text-xs leading-6 text-slate-600">أدخل المواعيد من الأقدم إلى الأحدث؛ الدفعة المقدمة المقترحة تكون أول موعد. يمكن جمع دفعات اليوم نفسه دون تغيير ترتيبها.</p>:null}
      <div className="space-y-2">
        {value.rows.map((row,index) => <div key={row.key} className="min-w-0 space-y-2 rounded-xl bg-slate-50 p-3">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <strong className="text-xs">{row.kind === "down_payment" ? "دفعة مقدمة مقترحة" : `القسط ${index+1}`}</strong>
            <button type="button" disabled={disabled} onClick={() => { if (!disabled) onChange({ ...value, rows: value.rows.filter(item => item.key !== row.key) }); }}
              aria-label={`حذف موعد السداد ${index+1}`} className="min-h-[44px] shrink-0 rounded-lg px-3 text-xs font-bold text-rose-800">حذف</button>
          </div>
          <div data-testid="debt-repayment-row-fields" className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="min-w-0 text-xs font-bold">تاريخ السداد
              <input aria-label={`تاريخ السداد ${index+1}`} type="date" min={index > 0 ? value.rows[index-1].dueDate || undefined : undefined} value={row.dueDate} onChange={event => changeRow(row.key,{ dueDate:event.target.value })}
                className="mt-1 min-h-[44px] w-full min-w-0 max-w-full rounded-xl border border-slate-200 bg-white px-2" />
            </label>
            <label className="min-w-0 text-xs font-bold">المبلغ ({currency})
              <input aria-label={`مبلغ السداد ${index+1}`} inputMode="decimal" dir="ltr" value={row.amount} onChange={event => changeRow(row.key,{ amount:event.target.value })}
                className="mt-1 min-h-[44px] w-full min-w-0 max-w-full rounded-xl border border-slate-200 bg-white px-2 text-start" />
            </label>
          </div>
          {index === 0 ? <label className="flex min-h-[44px] items-center gap-2 text-xs">
            <input type="checkbox" checked={row.kind === "down_payment"} onChange={event => changeRow(row.key,{ kind:event.target.checked ? "down_payment" : "installment" })} />
            {compact?"دفعة مقدمة مقترحة (غير محصّلة)":"هذا الموعد دفعة مقدمة مقترحة، لم تُحصّل بعد"}
          </label> : null}
        </div>)}
      </div>
      <button type="button" disabled={disabled || value.rows.length >= 60} onClick={() => { if (!disabled && value.rows.length < 60) onChange({ ...value, rows:[...value.rows,newRow()] }); }}
        className="min-h-[44px] rounded-xl border border-slate-200 px-3 text-sm font-bold disabled:opacity-50">إضافة موعد سداد</button>
      <div aria-live="polite" className="space-y-1 text-xs">
        <p>مجموع المواعيد: <strong>{safeTotal === null ? "راجع المبالغ" : formatMoney(safeTotal,currency)}</strong></p>
        {safeTotal !== null ? <p>{safeTotal <= remainingMinor ? "المتبقي للتوزيع" : "الزيادة عن الدين"}: <strong>{formatMoney(Math.abs(remainingMinor-safeTotal),currency)}</strong></p> : null}
        {!checked.ok ? <p role="alert" className="font-bold text-rose-800">{checked.message}</p> : <p className="font-bold text-emerald-800">المواعيد موزعة على الدين المتبقي كاملًا.</p>}
      </div>
    </> : null}
  </fieldset>;
}
