import type {JourneyOwnerInput} from '@/lib/ortho-case-journey-authority';
import {withIllustratedStudy} from '@/lib/ortho-study-illustrated-store';
import {STUDY_ILLUSTRATED_RENDERER} from '@/lib/ortho-study-illustrated';
import {OrthoStudyPrintButton} from '@/components/OrthoStudyPrintButton';
import {recordAudit,getSettingsSafe} from '@/lib/db';
import {PrintHeader} from '@/components/PrintHeader';
export default async function IllustratedStudyPrint({session,orthoCaseId,patientId,revisionId}:JourneyOwnerInput&{revisionId:number}){
 const result=await withIllustratedStudy({session,orthoCaseId,patientId,revisionId},async value=>value.pages.map(page=>({...page,image:page.image?{...page.image,png:new Uint8Array(),dataUrl:`data:image/png;base64,${Buffer.from(page.image.png).toString('base64')}`}:undefined}))).catch(()=>null);
 if(!result||!result.ok)return <main dir="rtl" className="p-6"><h1>تعذر تجهيز الدراسة المصورة كاملة</h1><p>راجع النسخة والصور وصلاحيات الوصول أو أعد المحاولة بعد انتهاء المعاينة. لم تُجهز نسخة جزئية للطباعة.</p></main>;
 const value=result.value,settings=await getSettingsSafe();
 await recordAudit({actor:session.username,action:'ortho.study_illustrated_export',entity:'ortho_case_study_revisions',entityId:revisionId,details:{format:'print-preview',revisionHash:value.revisionHash,pages:value.pages.length,images:value.pages.filter(p=>p.image).length}});
 return <main dir="rtl" className="study-illustrated mx-auto max-w-5xl bg-white text-slate-900">
  <style>{`@media print { @page { size: A4 landscape; margin: 10mm; } .study-illustrated .study-sheet { height: 185mm; break-after: page; break-inside: avoid; border: 0; padding: 0; } .study-illustrated .study-sheet:last-child { break-after: auto; } .study-illustrated .study-image { max-height: 100mm; } }`}</style>
  <div className="print:hidden space-y-2 p-5"><h1 className="text-xl font-bold">دراسة الحالة — نسخة سريرية مصورة</h1><p>تتضمن النص والصور المختارة في النسخة المحفوظة. راجع الصفحات ثم احفظها PDF من نافذة الطباعة. هذه النسخة ليست مجهولة الهوية للنشر التعليمي.</p><OrthoStudyPrintButton /></div>
  {result.output.map((page,index)=><section key={index} className="study-sheet mb-5 flex min-h-[600px] flex-col border p-6 print:mb-0 print:min-h-0">
   <PrintHeader settings={settings} title={page.title} compact strictIdentity />
   <p className="my-2 text-sm">الحالة {value.caseId} · الإصدار {value.version} · {value.kind==='draft'?'مسودة':'نسخة موثقة'} · محفوظة في <bdi dir="ltr" data-study-captured-at>{value.capturedAt}</bdi></p>
   {page.image?<figure className="flex-1 text-center">
    {/* Already processed private PNG, with the exact saved crop baked in. */}
    <img className="study-image print-watermark-protected mx-auto max-h-[450px] max-w-full object-contain" src={page.image.dataUrl} width={page.image.frame.width} height={page.image.frame.height} alt={`صورة محفوظة ${page.image.use.useId}`} />
    <figcaption className="mt-2 break-words text-sm">{page.lines.join(' • ')}</figcaption>
    {page.image.resolutionWarning&&<p className="text-sm">دقة الأصل أقل من حجم الإطار؛ راجع وضوح الصورة.</p>}
   </figure>:<div className="flex-1 space-y-1 text-base leading-6">{page.lines.map((line,n)=><p key={n} dir="auto" className="whitespace-pre-wrap break-words">{line||'\u00a0'}</p>)}</div>}
   <footer className="mt-3 border-t pt-2 text-xs"><p><bdi dir="ltr">{index+1} / {value.pages.length}</bdi> · المراجع: {page.sourceKeys.join('، ')||'لا يوجد'}</p><p dir="ltr" className="break-all">{STUDY_ILLUSTRATED_RENDERER} · SHA256: {value.revisionHash}</p>
    {page.image&&<p dir="ltr" className="break-all">Source: {page.image.sourceSha256} · Render: {page.image.renditionSha256}</p>}
   </footer>
  </section>)}
 </main>;
}
