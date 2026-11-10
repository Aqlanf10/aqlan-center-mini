import type { JourneyOwnerInput } from '@/lib/ortho-case-journey-authority';
import { getOrthoCaseStudy } from '@/lib/ortho-case-study-store';
import { withIllustratedStudy } from '@/lib/ortho-study-illustrated-store';
import { fullStudyPresentation } from '@/lib/ortho-study-full-layout';
import { FULL_STUDY_PRINT, prepareFullStudyPrint } from '@/lib/ortho-study-full-print';
import { getSettingsSafe, recordAudit } from '@/lib/db';
import { OrthoFullStudyPrintPages } from './OrthoFullStudyPrintPages';

/** Staged replacement: not connected to the production print route until review.
 * All async projection/settings/audit work is inside the existing final-read gate. */
export default async function OrthoFullStudyPrint(input: JourneyOwnerInput & { revisionId: number }) {
  const result = await (async () => {
    const saved = await getOrthoCaseStudy({ ...input, exportAccess: true });
    if (!saved.ok || !saved.revision) return null;
    const revision = saved.revision;
    return withIllustratedStudy(input, async verified => {
      const projection = await fullStudyPresentation(revision, saved, verified);
      const value = prepareFullStudyPrint(projection);
      const settings = await getSettingsSafe();
      await recordAudit({ actor: input.session.username, action: 'ortho.study_illustrated_export',
        entity: 'ortho_case_study_revisions', entityId: input.revisionId,
        details: { format: 'print-preview', renderer: FULL_STUDY_PRINT.renderer, revisionHash: value.revisionHash,
          sourceProjectionHash: value.sourceProjectionHash, pages: value.sheets.length,
          images: value.sheets.flatMap(sheet => sheet.elements).filter(element => element.kind === 'image').length } });
      return { value, settings };
    });
  })().catch(() => null);
  if (!result?.ok) return <main dir="rtl" className="p-6"><h1>تعذر تجهيز الدراسة المصورة كاملة</h1><p>راجع النسخة والصور وصلاحيات الوصول أو أعد المحاولة بعد انتهاء المعاينة. لم تُجهز نسخة جزئية للطباعة.</p></main>;
  return <OrthoFullStudyPrintPages value={result.output.value} settings={result.output.settings} />;
}
