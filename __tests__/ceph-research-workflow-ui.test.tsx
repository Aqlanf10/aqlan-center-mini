import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ResearchTracingWorkflow from '../components/ceph-research/ResearchTracingWorkflow';
describe('unmounted synthetic research surface', () => {
  it('is Arabic, explicitly nonclinical, and starts with gated marking and capture', () => {
    const html = renderToStaticMarkup(createElement(ResearchTracingWorkflow));
    expect(html).toContain('dir="rtl"'); expect(html).toContain('lang="ar"');
    expect(html).toContain('رسم اصطناعي'); expect(html).toContain('لا نتائج تشخيصية');
    expect(html).toContain('disabled=""'); expect(html).toContain('لا توجد لقطات');
    expect(html).toContain('noValidate=""'); expect(html).toContain('role="alert"');
    expect(html).not.toContain('type="file"'); expect(html).not.toContain('<img');
  });
});
