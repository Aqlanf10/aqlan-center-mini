import { expect, it } from 'vitest';
import { checkAssessmentDraftV2 } from '../lib/ortho-assessment-measurement-set-v2';
import { createPersistedAssessmentV2 } from '../lib/ortho-assessment-persisted-v2';
import { tanakaCommandV2 } from './fixtures/ortho-assessment-tanaka';
it('admits explicit Tanaka source-linked selections using the new version without relabeling old methods', () => {
 const draft = tanakaCommandV2().content;
 expect(checkAssessmentDraftV2(draft).ok).toBe(true);
 const saved = createPersistedAssessmentV2(draft);
 expect(saved).toMatchObject({ok:true,value:{verifierVersion:'ortho-assessment-payload-2.2.1'}});
});
