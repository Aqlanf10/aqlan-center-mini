import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToothPicker } from '../components/ToothPicker';
import { Odontogram } from '../components/dental/Odontogram';
import { LabDentalChart } from '../components/LabDentalChart';
import { PERMANENT_UPPER, PERMANENT_LOWER, PRIMARY_UPPER, PRIMARY_LOWER } from '../lib/dental';

const render = (value = '') => renderToStaticMarkup(<div dir="rtl"><LabDentalChart value={value} readOnly /></div>);
describe('shared anatomical orientation in an Arabic document', () => {
  it('pins entire permanent arches LTR, not just individual quadrants', () => {
    const html = render('11(Crown), 21(Pontic), 41(Abutment)');
    for (const teeth of [PERMANENT_UPPER, PERMANENT_LOWER]) {
      expect(html).toContain(`data-dental-arch="${teeth.join(',')}" dir="ltr"`);
    }
    expect(html).toContain('aria-pressed="true"');
  });
  it('shows selected primary teeth without silently defaulting to permanent-only', () => {
    const html = render('51(Crown), 71(Pontic)');
    for (const teeth of [PRIMARY_UPPER, PRIMARY_LOWER]) {
      expect(html).toContain(`data-dental-arch="${teeth.join(',')}" dir="ltr"`);
    }
    expect(html).toContain('FDI: 51');
    expect(html).toContain('FDI: 71');
  });
  it('keeps existing plan and clinical charts on exactly the same canonical rows', () => {
    for (const chart of [<ToothPicker value={[51]} onChange={() => {}} />, <Odontogram chart={new Map()} selected={[51]} onPick={() => {}} showPrimary />]) {
      const html = renderToStaticMarkup(<div dir="rtl">{chart}</div>);
      for (const teeth of [PERMANENT_UPPER, PERMANENT_LOWER, PRIMARY_UPPER, PRIMARY_LOWER]) {
        expect(html).toContain(`data-dental-arch="${teeth.join(',')}" dir="ltr"`);
      }
    }
  });
  it('warns about old invalid FDI codes without silently converting or deleting them', () => {
    const html = render('19(Pontic), 20(Pontic), 21(Abutment)');
    expect(html).toContain('أرقام أسنان محفوظة غير معيارية');
    expect(html).toContain('19، 20');
    expect(html).not.toContain('data-tooth-code="19"');
    expect(html).toContain('data-tooth-code="21"');
  });

});
