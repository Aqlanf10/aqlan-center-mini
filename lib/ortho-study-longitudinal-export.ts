/** Display-only appendix from the same validated saved revision as the export.
 * No current norms, measurements, calibration, or source fallback are read. */
import {projectStudyLongitudinalEligibility} from './ortho-study-longitudinal';
import {longitudinalPairs,longitudinalStageReasons,longitudinalPolicy,STUDY_LONGITUDINAL_SOURCE_BOUND_POLICY} from './ortho-study-longitudinal-contract';
import {studyLongitudinalReasonText} from './ortho-study-longitudinal-labels';
import type {JourneyScope} from './ortho-case-journey-records';
import type {StudyRevision} from './ortho-case-study-history';
import type {StudySavedContent} from './ortho-case-study-capture';
import type {StudyTextPage} from './ortho-study-text-export';
export function studyLongitudinalExportPages(revision:StudyRevision<StudySavedContent>,scope:JourneyScope):StudyTextPage[]{
 const exportedKeys=new Set(revision.content.authored.panels.filter(panel=>panel.included&&panel.state==='available').flatMap(panel=>panel.sourceKeys));
 const cephKeys=new Set(revision.content.authored.sources.filter(source=>source.kind==='ceph_study'&&exportedKeys.has(source.key)).map(source=>source.key));
 if(!revision.content.authored.groups.some(group=>/^T[1-4]$/.test(group.phase??'')&&group.sourceKeys.some(key=>cephKeys.has(key))))return [];
 const review=projectStudyLongitudinalEligibility(revision,scope);
 // Filter before deriving pairs/reasons. Excluded sources must not leak via
 // reference names, image hashes, or an ambiguity reason on an included stage.
 const stages=review.stages.flatMap(stage=>{
  const sources=stage.sources.filter(source=>cephKeys.has(source.key));
  return sources.length?[{...stage,sources,reasons:longitudinalStageReasons(sources)}]:[];
 });
 const title='أهلية المقارنة السيفالومترية';
 const policyVersion=longitudinalPolicy(stages);
 const pages:StudyTextPage[]=[{title,sourceKeys:stages.flatMap(stage=>stage.sources.map(source=>source.key)),lines:[
  policyVersion===STUDY_LONGITUDINAL_SOURCE_BOUND_POLICY
   ?'الفروق العددية محجوبة: تطابق هوية المصدر لا يثبت ما شاهده الطبيب ولا يثبت قابلية القياسات للمقارنة. تحتفظ الأدلة السابقة بحدودها الأصلية.'
   :'الفروق العددية محجوبة: دليل الإكمال الثابت لا يثبت أن المصدر هو الذي شاهده الطبيب؛ والالتقاطات القديمة تفتقر إلى دليل محدد النسخة.',
  'غياب الدليل لا يعني فرقًا يساوي صفرًا. ترتيب المراحل أو اكتمال السجل لا يثبتان تحسنًا سريريًا أو قابلية المقارنة.',
  `سياسة العرض: ${policyVersion}`,
  ...longitudinalPairs(stages).map(pair=>`${pair.from} → ${pair.to}: الفرق العددي غير متاح؛ يلزم تقييم الطبيب بعد التحقق من أصل القياسات.`),
 ]}];
 for(const stage of stages){
  const lines:string[]=[];
  for(const source of stage.sources){
   lines.push(`المصدر السيفالومتري المحفوظ #${source.id}`,`بصمة الالتقاط SHA256: ${source.contentHash}`);
   if(source.captureState==='available'){
    lines.push(`${source.completion?'رمز المجموعة المرجعية المحفوظ':'اسم المجموعة المرجعية المسجل، وليس نسختها'}: ${source.referenceSetKey||'غير مسجل'}`,
     `تاريخ التقاط الصورة المسجل: ${source.acquisitionDate??'غير معروف'}`,
     source.completion?.schemaVersion===2?studyLongitudinalReasonText('clinical_comparability_not_validated','ar')
      :source.completion?'دليل الإكمال: سجل مصدر ثابت متحقق السلامة؛ لا يثبت أنه المصدر الذي شاهده الطبيب.':'دليل الإكمال: التقاط قديم غير محدد النسخة؛ لا يُعاد تفسيره باستخدام القيم المرجعية الحالية.');
    if(source.completion){const c=source.completion;lines.push(`بصمة دليل الإكمال SHA256: ${c.witnessSha256}`,`وقت ختم الدليل: ${c.sealedAt}`,
     `نسخة المرجع المحفوظة: ${c.referenceSet.version}`,`بصمة المرجع SHA256: ${c.referenceSet.sha256}`,
     `المعايرة المحفوظة الدقيقة: ${JSON.stringify(c.calibration)}`,`حدود هوية المصدر: ${c.sourceIdentityMeaning}`,
     ...c.algorithms.map(a=>`الخوارزمية المحفوظة: ${a.id}؛ النسخة: ${a.version}؛ SHA256: ${a.sourceSha256}؛ نسخة الحساب: ${a.calculationVersion??'غير مسجلة'}؛ التقريب: ${a.rounding}`));
     if(c.schemaVersion===2)lines.push(`نسخة بنية دليل الإكمال المحفوظ: ${c.schemaVersion}`,`هوية المصدر المرسلة المتطابقة عند الإكمال: ${JSON.stringify(c.sourceReview)}`);}
    if(source.image)lines.push(`مستند الصورة #${source.image.documentId} • ${source.image.state==='available'?'متاح في الالتقاط':'مُزال في الالتقاط'}`,`بصمة الصورة SHA256: ${source.image.contentHash}`);
   }
  }
  lines.push(...stage.reasons.map(reason=>studyLongitudinalReasonText(reason,'ar')));
  pages.push({title:`${title} ${stage.stage}`,lines,sourceKeys:stage.sources.map(source=>source.key)});
 }
 return pages;
}
