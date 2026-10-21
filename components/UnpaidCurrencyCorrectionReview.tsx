'use client';

import { useState } from 'react';
import { CURRENCIES, CURRENCY_LABEL, type Currency } from '@/lib/money';
import { evaluateWrongCurrencyAmounts, type CurrencyCorrectionSource, type WrongCurrencyIntent } from '@/lib/invoice-currency-intent';

/** Unmounted review-only UI candidate. No fetch, journal write, or activation
 * callback exists. Switching modes retains entered strings; no rates or target
 * price defaults are invented. Closing/hiding is controlled by the parent. */
export function UnpaidCurrencyCorrectionReview({ source }: { source: CurrencyCorrectionSource }) {
  const [target, setTarget] = useState<Currency | ''>('');
  const [mode, setMode] = useState<WrongCurrencyIntent['mode'] | ''>('');
  const [reason, setReason] = useState('');
  const [discount, setDiscount] = useState('');
  const [prices, setPrices] = useState<Record<number, string>>({});
  let review = '';
  if (target && mode) {
    try {
      const common = { version: 1 as const, purpose: 'wrong-currency' as const, fromCurrency: source.currency, toCurrency: target, reason };
      const intent: WrongCurrencyIntent = mode === 'preserve-numerals' ? { ...common, mode } : {
        ...common, mode, discount, lines: source.lines.map(line => ({ itemId: line.itemId, unitPrice: prices[line.itemId] ?? '' })),
      };
      const amounts = evaluateWrongCurrencyAmounts(source, intent);
      review = `صافي المبلغ المستهدف بوحداته الصغرى: ${amounts.targetNetMinor} ${target}`;
    } catch { review = 'أكمل السبب والمبالغ الدقيقة دون تقريب أو تخمين.'; }
  }
  return <section dir="rtl" aria-label="مراجعة تصحيح عملة فاتورة غير مسددة">
    <p role="status">تصحيح العملة غير مفعّل بعد. هذه مراجعة فقط ولا ترسل أي عملية.</p>
    <p>خاص بفاتورة أصلية مستقلة بلا أي سند أو استرداد أو ارتباط بخطة أو علاج أو جدول. الخادم وحده يتحقق من الأهلية. هذا تصحيح عملة وليس صرفاً أو تحويل سعر.</p>
    <label>العملة المستهدفة<select value={target} onChange={event => setTarget(event.target.value as Currency | '')}>
      <option value="">اختر صراحةً</option>{CURRENCIES.filter(currency => currency !== source.currency).map(currency => <option key={currency} value={currency}>{CURRENCY_LABEL[currency]}</option>)}
    </select></label>
    <label>طريقة مراجعة المبالغ<select value={mode} onChange={event => setMode(event.target.value as WrongCurrencyIntent['mode'] | '')}>
      <option value="">اختر صراحةً</option><option value="preserve-numerals">إبقاء الأرقام نفسها بالعملة الصحيحة</option><option value="reviewed-target-amounts">إدخال مبالغ مستهدفة تمت مراجعتها</option>
    </select></label>
    <label>سبب التصحيح<input value={reason} maxLength={300} onChange={event => setReason(event.target.value)} /></label>
    {mode === 'reviewed-target-amounts' && <fieldset><legend>المبالغ المستهدفة دون تحويل تلقائي</legend>
      {source.lines.map(line => <label key={line.itemId}>سعر الوحدة للبند {line.itemId}<input inputMode="decimal" value={prices[line.itemId] ?? ''} onChange={event => setPrices(current => ({ ...current, [line.itemId]: event.target.value }))} /></label>)}
      <label>الخصم المستهدف<input inputMode="decimal" value={discount} onChange={event => setDiscount(event.target.value)} /></label>
    </fieldset>}
    {review && <p aria-live="polite">{review}</p>}
    <button type="button" disabled>التنفيذ غير مفعّل</button>
  </section>;
}
