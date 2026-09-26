"use client";

import { useEffect, useState } from "react";
import { CURRENCIES, CURRENCY_LABEL, type Currency } from "@/lib/money";

/**
 * (DAY1 — قرار المالك) «مريض سابق عليه مبلغ من قبل النظام» في تسجيل المريض: الرصيد السابق
 * يُرسل مع الملف في الطلب نفسه (`openingBalance`) — والخادم يتحقق من الصلاحية والمبلغ قبل
 * إنشاء الملف. يظهر لمن يسمح له الخادم (`/api/opening-balances/access`) — فإطفاء المدير
 * للإعداد يُخفيه عن الاستقبال؛ عملةٌ أخرى تُضاف من ملف المريض ← الحساب.
 */
export interface PreviousBalance {
  enabled: boolean;
  amount: string;
  currency: Currency;
  note: string;
}

export const EMPTY_PREVIOUS_BALANCE: PreviousBalance = { enabled: false, amount: "", currency: "YER", note: "" };

/** جسم `openingBalance` للطلب — أو لا شيء إن لم يُطلب. */
export function previousBalancePayload(value: PreviousBalance): { openingBalance?: Record<string, unknown> } {
  if (!value.enabled || !value.amount.trim()) return {};
  return { openingBalance: { amount: value.amount.trim(), currency: value.currency, note: value.note.trim() || null } };
}

export function PreviousBalanceFields({ value, onChange }: {
  value: PreviousBalance;
  onChange: (next: PreviousBalance) => void;
}) {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/opening-balances/access", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((access: { add?: boolean } | null) => { if (!cancelled) setAllowed(Boolean(access?.add)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  if (!allowed) return null;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-2.5">
      <label className="flex items-center gap-2 text-xs font-bold text-amber-900">
        <input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />
        مريض سابق عليه مبلغ من قبل النظام (رصيد سابق)
      </label>
      {value.enabled ? (
        <div className="mt-2 space-y-2">
          <div className="flex gap-2">
            <input
              value={value.amount}
              onChange={(e) => onChange({ ...value, amount: e.target.value })}
              inputMode="decimal"
              dir="ltr"
              placeholder="المبلغ"
              aria-label="مبلغ الرصيد السابق"
              className="min-w-0 flex-1 rounded-xl border border-amber-300 bg-white px-3 py-2 text-sm font-bold outline-none focus:border-navy-800"
            />
            <select
              value={value.currency}
              onChange={(e) => onChange({ ...value, currency: e.target.value as Currency })}
              aria-label="عملة الرصيد السابق"
              className="rounded-xl border border-amber-300 bg-white px-2 py-2 text-xs font-bold"
            >
              {CURRENCIES.map((currency) => <option key={currency} value={currency}>{CURRENCY_LABEL[currency]}</option>)}
            </select>
          </div>
          <input
            value={value.note}
            onChange={(e) => onChange({ ...value, note: e.target.value })}
            placeholder="ملاحظة (اختياري) — مثل: متبقٍ من تقويم 2024"
            aria-label="ملاحظة الرصيد السابق"
            className="w-full rounded-xl border border-amber-200 bg-white px-3 py-2 text-xs outline-none focus:border-navy-800"
          />
          <p className="text-[10px] font-semibold text-amber-800">
            يدخل حساب المريض ومديونيته، ولا يُحسب إيرادًا لهذه الفترة. عملةٌ أخرى تُضاف من ملفه ← الحساب.
          </p>
        </div>
      ) : null}
    </div>
  );
}
