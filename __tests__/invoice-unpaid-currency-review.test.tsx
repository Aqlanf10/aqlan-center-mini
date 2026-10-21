import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { UnpaidCurrencyCorrectionReview } from '../components/UnpaidCurrencyCorrectionReview';
import type { Currency } from '../lib/money';
it.each(['YER', 'SAR', 'USD'] as Currency[])('offers only distinct %s target currencies with no default or activation', currency => {
  const markup = renderToStaticMarkup(createElement(UnpaidCurrencyCorrectionReview, { source: { patientId: 1, invoiceId: 2, sourceHash: 'a'.repeat(64), currency, totalMinor: 100, discountMinor: 0, lines: [{ itemId: 3, quantity: 1, unitPriceMinor: 100 }] } }));
  expect(markup).not.toContain(`value="${currency}"`);
  expect(markup).toContain('disabled=""'); expect(markup).toContain('غير مفعّل'); expect(markup).toContain('ليست صرفاً'.replace('ليست', 'ليس'));
  expect(markup).toContain('value="" selected=""');
});
