import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import research from '../lib/medication-dose-reference-data.json';
import { DOSE_REFERENCE_VERSION, doseCalculationRule, doseProfileCalculationBlocker } from '../lib/medication-dose-profiles';

describe('reference-only clinical metadata corrections', () => {
  it('states the detailed label pediatric co-amoxiclav boundary without activating adult routing', () => {
    // DailyMed section 2.2 routes patients weighing 40 kg or more to adult recommendations.
    const profile = research.profiles.find(p => p.id === 'coamoxiclav-child-label-q12')!;
    expect(profile.population_reference).toBe('12 أسبوعًا فأكثر وأقل من 40 kg؛ عند 40 kg فأكثر يُراجع مسار البالغ وفق نشرة المنتج، ولا تحويل تلقائي.');
    expect(profile.source_ids).toEqual(['COAMOX_LABEL']);
  });

  it('preserves prior benzydamine advice and distinguishes NSAID advice from asthma caution', () => {
    // Benzydamine 0.15% mouthwash SmPC section 4.4; not a new contraindication classification.
    expect(research.warnings.benzydamine.text_ar).toBe('حساسيةالمنتج؛ تحقق منالسواغات والكحول، لا يستخدمغسول≤12سنة، لايبلع؛ الحمل/الرضاعة حسبالنشرة. لا يُنصح به عند فرط الحساسية للأسبرين أو مضادات الالتهاب غير الستيرويدية، ويستلزم الحذر عند وجود ربو حالي أو سابق.');
    expect(research.warnings.benzydamine.sources).toEqual(['BENZ_LABEL']);
  });

  it('keeps both corrected profiles reference-only at adult and pediatric boundaries', () => {
    for (const id of ['coamoxiclav-child-label-q12', 'benzydamine-rinse-label']) {
      for (const ageMonths of [3, 156, 216]) expect(doseCalculationRule(id, ageMonths)).toBeUndefined();
      expect(doseProfileCalculationBlocker(id)).toBeTruthy();
    }
  });

  it('preserves the 24 references, exactly six numeric adapters and existing reference version', () => {
    expect(research.profiles).toHaveLength(24);
    expect(research.profiles.filter(p => doseCalculationRule(p.id)).map(p => p.id)).toEqual([
      'paracetamol-adult-sdcep', 'paracetamol-child-aapd', 'ibuprofen-adult-sdcep',
      'ibuprofen-child-sdcep', 'amoxicillin-child-aapd-q8', 'amoxicillin-child-aapd-q12',
    ]);
    expect(DOSE_REFERENCE_VERSION).toBe('2026-11-01.expansion.1');
  });

  it('changes no other reference metadata, numeric regimen, source or warning', () => {
    const unchanged = structuredClone(research);
    unchanged.profiles.find(p => p.id === 'coamoxiclav-child-label-q12')!.population_reference = '__text_correction__';
    unchanged.warnings.benzydamine.text_ar = '__text_correction__';
    expect(createHash('sha256').update(JSON.stringify(unchanged)).digest('hex')).toBe('23eed7c51ca8f4297aa51e1f18300f5b973ef8aacdd184b5ad9cf155da9d29e2');
  });
});
