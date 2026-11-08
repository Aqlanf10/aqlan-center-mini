import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { compareSavedDiagnoses, type DiagnosisComparisonEntry } from "../lib/ortho-diagnosis-comparison";
import { OrthoDiagnosisComparison } from "../components/OrthoDiagnosisComparison";
const entry = (id: number, content: Record<string, string | null>): DiagnosisComparisonEntry => ({ id, version: id === 1 ? 2 : 9, orthoCaseId: 21, content, label: null, createdAt: '2026-11-06T01:02:03.000Z', createdBy: 'Synthetic recorder' });
function html(left: DiagnosisComparisonEntry, right: DiagnosisComparisonEntry) {
  const comparison = compareSavedDiagnoses([left, right], { orthoCaseId: 21, leftId: left.id, rightId: right.id });
  if (!comparison.ok) throw Error('Invalid synthetic comparison');
  return renderToStaticMarkup(createElement(OrthoDiagnosisComparison, { comparison }));
}
describe('saved diagnosis comparison presentation', () => {
  it('distinguishes absent, null, empty, whitespace, and exact text without carryforward', () => {
    const left = entry(1, { skeletal: null, dental: '', note: '  \n ', unknown: 'Recorded <finding>' });
    const right = entry(2, { skeletal: '', note: '  \n ', crowding: 'Different field' });
    const before = JSON.stringify([left, right]), output = html(left, right);
    for (const value of ['الحقل غير موجود', 'قيمة null محفوظة', 'نص فارغ محفوظ', '  \n ', 'Recorded &lt;finding&gt;', 'unknown', 'Different field', 'متطابق نصيًا وحالةً', 'مختلف نصيًا أو في حالة التسجيل']) expect(output).toContain(value);
    expect(JSON.stringify([left, right])).toBe(before); expect(output).toContain('بلا استكمال'); expect(output).toContain('ليست تقييمًا سريريًا');
  });
  it('retains selected entry order, IDs, nonadjacent versions and exact recorded timestamps/authors', () => {
    const a = entry(1, {}), b = entry(2, {}); b.label = ''; b.createdBy = '<script>actor</script>';
    const output = html(b, a);
    expect(output.indexOf('نسخة 9')).toBeLessThan(output.indexOf('نسخة 2'));
    expect(output).toContain('2026-11-06T01:02:03.000Z'); expect(output).toContain('&lt;script&gt;actor'); expect(output).not.toContain('<script>');
    expect(output).toContain('الفجوات لا تثبت فقدان'); expect(output).toContain('غير مسجّل (null)'); expect(output).toContain('نص فارغ محفوظ');
    expect(output).toContain('لا توجد مفاتيح'); expect(output).not.toMatch(/<(?:form|button|input|select|textarea|a)\b/);
  });
  it('renders prototype-like unknown keys as literal evidence, not inherited labels', () => {
    const content = JSON.parse('{"__proto__":"one","constructor":"two","toString":null}') as Record<string,string|null>;
    const output = html(entry(1, content), entry(2, {}));
    expect(output).toContain('__proto__'); expect(output).toContain('constructor'); expect(output).toContain('toString');
    expect(output).toContain('حقل محفوظ آخر'); expect(output).not.toContain('[object Object]');
  });
});
