"use client";

import { useId } from "react";
import { formatAmount, formatMoney, parseAmount, type Currency } from "@/lib/money";
import { validateDebtRepaymentTerms, type DebtInstallment } from "@/lib/debt-installments";
import { generateMonthlyDebtSchedule, monthlyDueDate } from "@/lib/debt-monthly-schedule";

export interface DebtRepaymentDraft {
  mode: "full" | "installments";
  rows: { key: string; dueDate: string; amount: string; kind: DebtInstallment["kind"] }[];
  /** Draft controls only; readDebtRepaymentDraft serializes the actual rows. */
  generation?: {
    downPayment: string; downPaymentDate: string; months: string; firstMonthlyDate: string;
    generatedRemainingMinor?: number;
    expanded?: boolean;
    /** Controls have changed but their replacement rows have not been generated. */
    pendingChanges?: boolean;
  };
}

export function readDebtRepaymentDraft(draft: DebtRepaymentDraft, currency: Currency, remainingMinor: number) {
  if (draft.mode === "installments" && draft.generation?.pendingChanges) {
    return { ok: false as const, message: "تغيّرت إعدادات المقدمة أو الأقساط. اضغط «توليد جدول الأقساط» لتطبيقها قبل الحفظ؛ الجدول الحالي لم يتغيّر بعد." };
  }
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
  const firstDownPayment = value.rows[0]?.kind === "down_payment" ? value.rows[0] : null;
  const monthlyRows = value.rows.filter(row => row.kind === "installment" && row.amount.trim());
  const generation: NonNullable<DebtRepaymentDraft["generation"]> = value.generation ?? {
    downPayment: firstDownPayment?.amount ?? "", downPaymentDate: firstDownPayment?.dueDate ?? today,
    months: monthlyRows.length ? String(monthlyRows.length) : "12",
    firstMonthlyDate: monthlyRows[0]?.dueDate ?? monthlyDueDate(today, 1) ?? "",
  };
  const downPaymentMinor = generation.downPayment.trim() ? parseAmount(generation.downPayment, currency) : 0;
  const proposedRemainder = downPaymentMinor !== null && downPaymentMinor >= 0 && downPaymentMinor <= remainingMinor
    ? remainingMinor - downPaymentMinor : null;
  const generated = generateMonthlyDebtSchedule({ remainingMinor, downPaymentMinor: downPaymentMinor ?? -1,
    downPaymentDate: generation.downPaymentDate, monthCount: /^[1-9]\d*$/.test(generation.months) ? Number(generation.months) : NaN,
    firstMonthlyDate: generation.firstMonthlyDate });
  const changeGeneration = (patch: Partial<NonNullable<DebtRepaymentDraft["generation"]>>) => {
    if (!disabled) {
      const changed = (["downPayment", "downPaymentDate", "months", "firstMonthlyDate"] as const)
        .some(key => patch[key] !== undefined && patch[key] !== generation[key]);
      onChange({ ...value, generation: { ...generation, ...patch, pendingChanges: generation.pendingChanges || changed } });
    }
  };
  return <fieldset disabled={disabled} dir="rtl" data-testid="debt-repayment-editor" data-compact={compact} className="min-w-0 space-y-3 rounded-2xl border border-slate-200 bg-white p-3">
    <legend className="px-1 text-sm font-extrabold text-slate-900">طريقة سداد الاتفاق</legend>
    <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
      {([ ["full", "دفعة واحدة"], ["installments", "جدول أقساط"] ] as const).map(([mode,label]) =>
        <label key={mode} className={`flex min-h-[44px] min-w-0 cursor-pointer items-center gap-2 rounded-xl border p-3 text-sm font-bold ${value.mode === mode ? "border-sky-600 bg-sky-50 text-sky-900" : "border-slate-200"}`}>
          <input type="radio" name={group} value={mode} checked={value.mode === mode}
            disabled={disabled || mode === "installments" && remainingMinor <= 0}
            onChange={() => { if (!disabled) onChange({ ...value, mode, rows: mode === "installments" && !value.rows.length ? [newRow()] : value.rows }); }} />
          {label}
        </label>)}
    </div>
    <p className={compact ? "text-xs" : "text-sm"}>المتبقي الحالي الذي سيُوزّع: <strong>{formatMoney(remainingMinor,currency)}</strong></p>
    <p className="text-xs leading-6 text-slate-600">اختيار طريقة السداد لا يسجّل مبلغًا محصّلًا. التحصيل الفعلي يُثبت بسند قبض مستقل.</p>
    {value.mode === "installments" ? <>
      {generation.pendingChanges ? <p role="status" data-testid="schedule-generation-pending" className="text-sm font-bold text-amber-900">إعدادات التوزيع الجديدة لم تُطبّق بعد. اضغط «توليد جدول الأقساط» قبل الحفظ.</p> : null}
      <details open={generation.expanded !== false} aria-label="توزيع الأقساط الشهرية" className="min-w-0 space-y-3 rounded-xl border border-sky-100 bg-sky-50/60 p-3">
        <summary className="min-h-[44px] cursor-pointer text-sm font-bold" onClick={event=>{event.preventDefault();changeGeneration({expanded:generation.expanded===false});}}>
          {generation.expanded === false ? "إعادة توزيع المقدمة والأقساط الشهرية" : "المقدمة والأقساط الشهرية"}
        </summary>
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="min-w-0 text-xs font-bold">الدفعة المقدمة المقترحة ({currency})
            <input aria-label="مبلغ الدفعة المقدمة المقترحة" inputMode="decimal" dir="ltr" value={generation.downPayment}
              onChange={event => changeGeneration({ downPayment: event.target.value })} placeholder="0"
              className="mt-1 min-h-[44px] w-full min-w-0 rounded-xl border border-slate-200 bg-white px-2" />
          </label>
          <label className="min-w-0 text-xs font-bold">تاريخ المقدمة المقترحة
            <input aria-label="تاريخ الدفعة المقدمة المقترحة" type="date" value={generation.downPaymentDate}
              onChange={event => changeGeneration({ downPaymentDate: event.target.value })}
              className="mt-1 min-h-[44px] w-full min-w-0 rounded-xl border border-slate-200 bg-white px-2" />
          </label>
        </div>
        <p className="text-xs">المتبقي للتوزيع شهريًا: <strong data-testid="monthly-schedule-remainder">{proposedRemainder === null ? "راجع المقدمة" : formatMoney(proposedRemainder, currency)}</strong></p>
        <p className="text-xs leading-6 text-slate-600">المقدمة هنا مقترحة وغير محصّلة؛ إثبات قبضها يحتاج سندًا مستقلًا. إذا سبق تسجيل قبضها، لا تدخلها مرة ثانية: المتبقي الحالي أعلاه محسوب بعد التحصيل المثبت.</p>
        <div className="flex flex-wrap gap-2" aria-label="مدد الأقساط المقترحة">
          {[12, 15, 18].map(months => <button key={months} type="button" disabled={disabled || proposedRemainder === 0}
            aria-pressed={generation.months === String(months)} onClick={() => changeGeneration({ months: String(months) })}
            className="min-h-[44px] rounded-xl border border-sky-200 bg-white px-3 text-xs font-bold disabled:opacity-50">{months} شهرًا</button>)}
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="min-w-0 text-xs font-bold">عدد الأشهر (مخصص)
            <input aria-label="عدد الأشهر" type="number" min={1} max={downPaymentMinor && downPaymentMinor > 0 ? 59 : 60} step={1}
              value={generation.months} disabled={disabled || proposedRemainder === 0} onChange={event => changeGeneration({ months: event.target.value })}
              className="mt-1 min-h-[44px] w-full min-w-0 rounded-xl border border-slate-200 bg-white px-2" />
          </label>
          <label className="min-w-0 text-xs font-bold">أول استحقاق شهري
            <input aria-label="أول استحقاق شهري" type="date" value={generation.firstMonthlyDate} disabled={disabled || proposedRemainder === 0}
              min={downPaymentMinor && downPaymentMinor > 0 ? generation.downPaymentDate : undefined}
              onChange={event => changeGeneration({ firstMonthlyDate: event.target.value })}
              className="mt-1 min-h-[44px] w-full min-w-0 rounded-xl border border-slate-200 bg-white px-2" />
          </label>
        </div>
        {proposedRemainder === 0 ? <p className="text-xs">المقدمة المقترحة تغطي الدين؛ لن تُنشأ أقساط بمبلغ صفر.</p> : null}
        {!generated.ok ? <p role="alert" className="text-xs font-bold text-rose-800">{generated.message}</p> : null}
        <button type="button" disabled={disabled || !generated.ok} onClick={() => {
          if (disabled || !generated.ok) return;
          onChange({ mode: generated.terms.mode, rows: generated.terms.installments.map(row => ({ key: crypto.randomUUID(),
            dueDate: row.dueDate, amount: formatAmount(row.amountMinor, currency), kind: row.kind })),
            generation: { ...generation, generatedRemainingMinor: remainingMinor, expanded: false, pendingChanges: false } });
        }} className="min-h-[44px] rounded-xl bg-sky-800 px-3 text-sm font-bold text-white disabled:opacity-50">توليد جدول الأقساط</button>
        <p className="text-xs text-slate-600">تُطبّق المقدمة والأشهر عند التوليد. يمكنك تعديل كل مبلغ وتاريخ في الجدول أدناه، وإعادة التوليد تستبدل مواعيد المسودة.</p>
      </details>
      {generation.generatedRemainingMinor !== undefined && generation.generatedRemainingMinor !== remainingMinor
        ? <p role="status" className="text-xs font-bold text-amber-900">تغيّر مبلغ الدين؛ أعد توليد الأقساط أو عدّل المواعيد لتوزيع المتبقي الجديد.</p> : null}
      {!compact?<p className="text-xs leading-6 text-slate-600">أدخل المواعيد من الأقدم إلى الأحدث؛ الدفعة المقدمة المقترحة تكون أول موعد. يمكن جمع دفعات اليوم نفسه دون تغيير ترتيبها.</p>:null}
      <div className="space-y-2">
        {value.rows.map((row,index) => <div key={row.key} className="min-w-0 space-y-2 rounded-xl bg-slate-50 p-3">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <strong className="text-xs">{row.kind === "down_payment" ? "دفعة مقدمة مقترحة" : `القسط ${index+1-(firstDownPayment?1:0)}`}</strong>
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
          {index === 0 && value.generation?.generatedRemainingMinor === undefined ? <label className="flex min-h-[44px] items-center gap-2 text-xs">
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
