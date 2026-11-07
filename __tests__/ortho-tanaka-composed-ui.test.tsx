import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { OrthoAssessmentMeasurementsV2 } from '../components/OrthoAssessmentMeasurementsV2';
import { editMeasurementPayloadV2 } from '../lib/ortho-assessment-measurement-editor-v2';
import { tanakaCommandV2 } from './fixtures/ortho-assessment-tanaka';
it('renders source-linked predictions with the existing permanent measurement guidance and no writes', () => {
 const draft = editMeasurementPayloadV2(tanakaCommandV2().content)!;
 const before=JSON.stringify(draft), onChange=vi.fn();
 const html=renderToStaticMarkup(createElement(OrthoAssessmentMeasurementsV2,{draft,onChange,sources:[]}));
 expect(html).toContain('Tanaka');
 expect(html).toContain('تقدير الناب والضاحكين لكل جهة');
 expect(html).toContain('ortho-model-2.2.1');
 expect(html).toContain('غير معتمد سريريًا');
 expect(html).toContain('Permanent dentition protocol');
 expect(html).toContain('لا تُضف عرض الرحى الأولى');
 expect(JSON.stringify(draft)).toBe(before); expect(onChange).not.toHaveBeenCalled();
});
