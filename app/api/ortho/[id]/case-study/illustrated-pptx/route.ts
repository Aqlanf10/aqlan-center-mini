import {NextResponse} from 'next/server';
import {admitJourney,journeyRouteOwner,journeyRouteError,routeId,type JourneyRouteContext} from '@/lib/ortho-journey-route';
import {orthoQuery} from '@/lib/ortho-route-handler';
import {withIllustratedStudy} from '@/lib/ortho-study-illustrated-store';
import {renderIllustratedStudyPptx} from '@/lib/ortho-study-illustrated-pptx';
import {recordAudit} from '@/lib/db';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:JourneyRouteContext){
 const admission=await admitJourney(false);if(!admission.ok)return admission.response;
 const query=orthoQuery(request,['patientId','revisionId']),patientId=routeId(query?.get('patientId')),revisionId=routeId(query?.get('revisionId'));
 if(!query||!patientId||!revisionId)return journeyRouteError(400,'invalid_scope');
 const owner=await journeyRouteOwner(context,patientId,admission.session);if(!owner.ok)return owner.response;
 try{
  const rendered=await withIllustratedStudy({...owner,revisionId},async value=>{
   const bytes=await renderIllustratedStudyPptx(value);
   await recordAudit({actor:admission.session.username,action:'ortho.study_illustrated_export',entity:'ortho_case_study_revisions',entityId:revisionId,
    details:{format:'pptx',revisionHash:value.revisionHash,pages:value.pages.length,images:value.pages.filter(p=>p.image).length}});
   return bytes;
  });
  if(!rendered.ok)return journeyRouteError(rendered.status,rendered.code);
  return new NextResponse(rendered.output,{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
   'Content-Disposition':`attachment; filename="ortho-${owner.orthoCaseId}-revision-${rendered.value.version}-illustrated.pptx"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
 }catch{return journeyRouteError(409,'study_illustrated_unavailable','تعذر تصدير الدراسة المصورة كاملة. راجع الصور المختارة وصلاحياتها وحجم الدراسة؛ لم يُصدر ملف ناقص.');}
}
