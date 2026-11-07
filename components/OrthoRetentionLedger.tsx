"use client";
import { useEffect, useRef, useState } from "react";
import OrthoRetentionInstructions from "./OrthoRetentionInstructions";
import OrthoRetentionDeviceDossiers from "./OrthoRetentionDeviceDossiers";
import { verifyRetentionDocumentChoices } from "@/lib/ortho-retention-client";
import type { RetentionDocumentWitness } from "@/lib/ortho-retention-document-witness";
import type { RetentionLedgerRead } from '@/lib/ortho-retention-client';
import type { RetentionPersistenceCommand } from '@/lib/ortho-retention-command';
import type { RetentionEvent, RetentionEventArch, RetentionDeviceRef } from '@/lib/ortho-retention-events';
const field='mt-1 w-full min-w-0 rounded-lg border border-slate-300 bg-white p-2 text-sm';
const button='min-h-11 rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-40';
import { RetentionEventDetails, kinds, arches, observations, states, provenance } from "./OrthoRetentionEventDetails";
export { RetentionEventDetails } from "./OrthoRetentionEventDetails";
export function newRetentionEvent(kind:RetentionEvent['kind']):RetentionEvent {
 const base={occurrence:{occurredOn:null,dateProvenance:'unknown' as const,sourceNote:''},note:'',documentIds:[]};
 const device={deviceId:0,expectedDeviceRevisionId:0};
 const delivery={deviceType:'' as 'other',description:'',extent:'',labOrderId:null};
 switch(kind){
 case 'debond':return {...base,kind,extent:''};
 case 'device_delivery':return {...base,...delivery,kind};
 case 'device_replacement':return {...base,...delivery,kind,replaces:device};
 case 'device_repair':return {...base,kind,device,description:''};
 case 'device_status_change':return {...base,kind,device,status:'unknown'};
 case 'followup_intent':return {...base,kind,device:null,dueOn:null,intervalDays:null,scope:''};
 case 'device_review':return {...base,kind,device,observations:Object.fromEntries(Object.keys(observations).map(k=>[k,{state:'not_assessed',note:''}])) as Extract<RetentionEvent,{kind:'device_review'}>['observations']};
 }
}
/** Fetch only explicit picker requests. Choices are scoped metadata, never image URLs.
 * A late or paginated reply cannot replace the witnesses already frozen in a draft. */
export function RetentionDocumentPicker({data,draft,blocked,update}:{data:RetentionLedgerRead;draft:RetentionPersistenceCommand;blocked:boolean;update(next:RetentionPersistenceCommand):void}) {
 const [request,setRequest]=useState<{afterId?:number;sequence:number}|null>(null);
 const [loaded,setLoaded]=useState<{owner:RetentionLedgerRead;page:ReturnType<typeof verifyRetentionDocumentChoices>}|null>(null);
 const page=loaded?.owner===data?loaded.page:null;
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 const current=useRef({data,blocked});current.current={data,blocked};
 useEffect(()=>{
  if(!request||blocked)return;
  let active=true;const controller=new AbortController();
  const valid=()=>active&&!controller.signal.aborted&&current.current.data===data&&!current.current.blocked;
  const timer=setTimeout(()=>controller.abort(),20000);
  setBusy(true);setLoaded(null);setError('');
  void(async()=>{try{
   const response=await fetch(`/api/ortho/${data.scope.orthoCaseId}/retention-ledger/documents?patientId=${data.scope.patientId}${request.afterId===undefined?'':`&afterId=${request.afterId}`}`,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
   if(!valid())return;
   if(response.status!==200||response.redirected||!response.headers.get('cache-control')?.split(',').some(v=>v.trim().toLowerCase()==='no-store'))throw Error('document_choices_unavailable');
   const text=await response.text();if(!valid())return;
   if(new TextEncoder().encode(text).length>2*1024*1024)throw Error('document_choices_limit');
   const verified=verifyRetentionDocumentChoices(JSON.parse(text),data,request.afterId);
   if(valid())setLoaded({owner:data,page:verified});
  }catch{if(active&&current.current.data===data)setError('تعذر التحقق من مصادر المستندات؛ لا تُغيّر الشواهد المحفوظة.');}
  finally{clearTimeout(timer);if(active)setBusy(false);}})();
  return()=>{active=false;clearTimeout(timer);controller.abort();};
 },[data,request,blocked]);
 const select=(w:RetentionDocumentWitness)=>{
  if(blocked||current.current.blocked||current.current.data!==data)return;
  const old=draft.expectedDocuments.find(x=>x.id===w.id);
  const documentIds=draft.content.documentIds.includes(w.id)?draft.content.documentIds:[...draft.content.documentIds,w.id];
  if(documentIds.length>30)return;
  const witnesses=old?draft.expectedDocuments.map(x=>x.id===w.id?w:x):[...draft.expectedDocuments,w];
  const expectedDocuments=documentIds.flatMap(id=>witnesses.filter(x=>x.id===id));
  update({...draft,expectedDocuments,content:{...draft.content,documentIds}});
 };
 return <div className="space-y-2"><p>مراجع مستندات الحالة: الشاهد يُثبت عند الاختيار، ولا يتغير مع إعادة القراءة.</p>
 <button type="button" className={button} disabled={blocked||busy} onClick={()=>setRequest({sequence:(request?.sequence??0)+1})}>اختيار مستندات الحالة</button>
 {error&&<p role="alert">{error}</p>}
 {page&&!blocked&&page.items.map(item=><button type="button" className={button} key={item.witness.id} onClick={()=>select(item.witness)}>اختيار الشاهد الحالي للمستند #{item.witness.id}: {item.title}</button>)}
 {page?.nextCursor&&!blocked&&<button type="button" className={button} disabled={busy} onClick={()=>setRequest({afterId:page.nextCursor!,sequence:(request?.sequence??0)+1})}>صفحة المستندات التالية</button>}
 {draft.content.documentIds.map(id=><button key={id} type="button" className={button} disabled={blocked} onClick={()=>{if(!blocked)update({...draft,expectedDocuments:draft.expectedDocuments.filter(w=>w.id!==id),content:{...draft.content,documentIds:draft.content.documentIds.filter(i=>i!==id)}});}}>إزالة مرجع #{id} من هذه المسودة</button>)}
 </div>;
}
export default function OrthoRetentionLedger({data,draft,writable,busy,uncertain,update,discard,save}:{data:RetentionLedgerRead;draft:RetentionPersistenceCommand|null;writable:boolean;busy:boolean;uncertain:boolean;update(next:RetentionPersistenceCommand):void;discard():void;save():void}) {
 const blocked=!writable||busy||uncertain;
 const content=(c:RetentionEvent)=>{if(draft&&!blocked)update({...draft,content:c});};
 const start=(kind:RetentionEvent['kind'],arch:RetentionEventArch)=>{if(!draft&&!blocked)update({schemaVersion:2,clientRequestId:crypto.randomUUID(),expectedHeadId:data.headId,reason:'',arch,supersedesEntryId:null,archCorrectionReason:null,expectedDocuments:[],content:newRetentionEvent(kind)});};
 const e=draft?.content;
 const ref=e?('device' in e?e.device:e.kind==='device_replacement'?e.replaces:null):null;
 const deviceChanged=!!ref?.deviceId&&!data.devices.some(d=>d.deviceId===ref.deviceId&&d.lastEventId===ref.expectedDeviceRevisionId&&d.arch===draft?.arch);
 const pickDevice=(r:RetentionDeviceRef|null)=>{if(!e)return;if(e.kind==='device_replacement'&&r)content({...e,replaces:r});else if(e.kind==='followup_intent')content({...e,device:r});else if('device' in e&&r)content({...e,device:r});};
 return <section aria-label="سجل التثبيت الوثائقي" data-testid="ortho-retention-ledger" className="min-w-0 space-y-3 rounded-xl border p-3">
 <h4 className="font-bold">سجل التثبيت الوثائقي</h4><p className="text-xs">الأحداث توثيق مستقل لكل فك وجهاز. التسليم لا يثبت الاستخدام أو الالتزام، وفك التقويم لا يثبت اكتمال العلاج. لا تُغيّر هذه الأحداث مرحلة الحالة ولا تنشئ موعداً أو فاتورة.</p>
 <OrthoRetentionInstructions data={data}/>
 {!data.writable&&<p role="status">السجل للقراءة فقط في الحالة أو الصلاحية الحالية.</p>}
 <OrthoRetentionDeviceDossiers data={data}/>
 {!draft&&writable&&(['upper','lower','legacy_unknown'] as const).map(arch=><details key={arch}><summary className="min-h-11 cursor-pointer py-3">إضافة حدث للفك {arches[arch]}</summary><div className="flex flex-wrap gap-2">{(Object.keys(kinds) as RetentionEvent['kind'][]).map(k=><button key={k} type="button" className={button} disabled={blocked} aria-label={`${kinds[k]} للفك ${arches[arch]}`} onClick={()=>start(k,arch)}>{kinds[k]}</button>)}</div></details>)}
 {draft&&e&&<fieldset disabled={blocked} className="space-y-3 border p-3"><legend>{kinds[e.kind]} · الفك {arches[draft.arch]}{draft.supersedesEntryId!==null?` · تصحيح #${draft.supersedesEntryId}`:''}</legend>
 {draft.expectedHeadId!==data.headId&&<p role="alert">تغير السجل؛ راجع التاريخ قبل إعداد طلب جديد. لا تُحدّث مراجع الأجهزة تلقائياً.</p>}
 <label className="block">الفك<select className={field} value={draft.arch} onChange={v=>update({...draft,arch:v.target.value as RetentionEventArch,archCorrectionReason:null})}>{Object.entries(arches).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
 {draft.supersedesEntryId!==null&&data.history.find(h=>h.id===draft.supersedesEntryId)?.content.arch!==draft.arch&&<label className="block">سبب تصحيح الفك<input className={field} value={draft.archCorrectionReason??''} maxLength={500} onChange={v=>update({...draft,archCorrectionReason:v.target.value||null})}/></label>}
 <label className="block">مصدر التاريخ<select className={field} value={e.occurrence.dateProvenance} onChange={v=>content({...e,occurrence:{...e.occurrence,dateProvenance:v.target.value as typeof e.occurrence.dateProvenance,occurredOn:v.target.value==='unknown'?null:e.occurrence.occurredOn}})}>{Object.entries(provenance).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
 {e.occurrence.dateProvenance!=='unknown'&&<label className="block">تاريخ الحدث<input type="date" className={field} value={e.occurrence.occurredOn??''} onChange={v=>content({...e,occurrence:{...e.occurrence,occurredOn:v.target.value||null}})}/></label>}
 <label className="block">مصدر توثيق التاريخ<input className={field} maxLength={1000} value={e.occurrence.sourceNote} onChange={v=>content({...e,occurrence:{...e.occurrence,sourceNote:v.target.value}})}/></label>
 {('device' in e||e.kind==='device_replacement')&&<><label className="block">الجهاز المرجعي<select className={field} value={ref?.deviceId??0} disabled={draft.supersedesEntryId!==null} onChange={v=>{const d=data.devices.find(d=>d.deviceId===Number(v.target.value));pickDevice(d?{deviceId:d.deviceId,expectedDeviceRevisionId:d.lastEventId}:null);}}><option value={0}>{e.kind==='followup_intent'?'متابعة للفك دون جهاز محدد':'اختر جهازاً موثق التسليم'}</option>{data.devices.filter(d=>d.arch===draft.arch||d.deviceId===ref?.deviceId).map(d=><option key={d.deviceId} value={d.deviceId}>#{d.deviceId} · {d.delivery.description} · النسخة #{d.lastEventId}</option>)}</select></label>{deviceChanged&&<p role="alert">تغير مرجع الجهاز أو الفك. راجع النسخة الحالية صراحةً؛ لا يُعاد ربط الحدث بجهاز آخر.</p>}{ref&&<button type="button" className={button} onClick={()=>{const d=data.devices.find(d=>d.deviceId===ref.deviceId&&d.arch===draft.arch);if(d)pickDevice({deviceId:d.deviceId,expectedDeviceRevisionId:d.lastEventId});}}>راجعت الجهاز نفسه؛ تحديث مرجع نسخته</button>}</>}
 {'deviceType' in e&&<label className="block">نوع المثبت<select className={field} value={e.deviceType} onChange={v=>content({...e,deviceType:v.target.value as typeof e.deviceType})}><option value="">اختر النوع الموثق</option><option value="fixed">ثابت</option><option value="removable">متحرك</option><option value="other">آخر</option></select></label>}
 {'extent' in e&&<label className="block">النطاق الموثق<input className={field} maxLength={500} value={e.extent} onChange={v=>content({...e,extent:v.target.value})}/></label>}
 {'description' in e&&<label className="block">الوصف<input className={field} maxLength={e.kind==='device_repair'?4000:1000} value={e.description} onChange={v=>content({...e,description:v.target.value})}/></label>}
 {e.kind==='device_status_change'&&<label className="block">الحالة الموثقة<select className={field} value={e.status} onChange={v=>content({...e,status:v.target.value as typeof e.status})}>{(['unknown','in_use','not_in_use','lost','removed'] as const).map(s=><option key={s} value={s}>{states[s]}</option>)}</select></label>}
 {e.kind==='device_review'&&(Object.keys(observations) as (keyof typeof observations)[]).map(k=><div key={k}><label>{observations[k]}<select className={field} value={e.observations[k].state} onChange={v=>content({...e,observations:{...e.observations,[k]:{...e.observations[k],state:v.target.value}}})}><option value="not_assessed">لم يُقيّم</option><option value="unknown">غير معلوم</option><option value="recorded">موثق</option></select></label><label>ملاحظة {observations[k]}<input className={field} maxLength={1000} value={e.observations[k].note} onChange={v=>content({...e,observations:{...e.observations,[k]:{...e.observations[k],note:v.target.value}}})}/></label></div>)}
 {e.kind==='followup_intent'&&<><p>نية متابعة فقط؛ لا تسجّل حضوراً أو اكتمالاً.</p><label className="block">نطاق المتابعة<input className={field} maxLength={1000} value={e.scope} onChange={v=>content({...e,scope:v.target.value})}/></label><label className="block">التاريخ المقصود<input type="date" className={field} value={e.dueOn??''} onChange={v=>content({...e,dueOn:v.target.value||null})}/></label><label className="block">الفترة الموثقة بالأيام<input type="number" min={1} max={3650} step={1} className={field} value={e.intervalDays??''} onChange={v=>content({...e,intervalDays:v.target.value===''?null:Number(v.target.value)})}/></label></>}
 <label className="block">ملاحظة الحدث<textarea className={field} maxLength={4000} value={e.note} onChange={v=>content({...e,note:v.target.value})}/></label>
 {e.documentIds.some(id=>!draft.expectedDocuments.some(w=>w.id===id))&&<p role="alert">المصدر التاريخي بلا شاهد هوية محفوظ؛ اختر كل مستند صراحةً لتوثيق هويته الحالية للتصحيح. لا يثبت الاختيار هوية المصدر التاريخية.</p>}
 {e.documentIds.length>0&&<p>المراجع المحفوظة: {e.documentIds.join('، ')}. تبقى هوياتها الأصلية دون تحديث تلقائي.</p>}
 <RetentionDocumentPicker data={data} draft={draft} blocked={blocked} update={update}/>
 <label className="block">سبب التوثيق أو التصحيح<input className={field} maxLength={500} value={draft.reason} onChange={v=>update({...draft,reason:v.target.value})}/></label>
 <button type="button" className={button} disabled={draft.expectedHeadId!==data.headId||deviceChanged} onClick={save}>حفظ حدث التثبيت</button>
 {draft.expectedHeadId!==data.headId&&<button type="button" className={button} onClick={()=>update({...draft,expectedHeadId:data.headId,clientRequestId:crypto.randomUUID()})}>راجعت الأحداث الجديدة؛ إعداد طلب جديد</button>}
 </fieldset>}
 {draft&&<button type="button" className={button} disabled={busy||uncertain||!writable} onClick={discard}>إغلاق المسودة غير المرسلة</button>}
 <details><summary className="min-h-11 py-3">التاريخ الكامل والتصحيحات ({data.history.length})</summary>{data.history.map(h=><article key={h.id} className="space-y-2 border-b py-3"><p>#{h.id} · الفك {arches[h.content.arch]} · توثيق {h.createdAt} · {h.createdBy}</p><p>{h.reason}</p>{h.content.supersedesEntryId!==null&&<p>تصحيح الحدث #{h.content.supersedesEntryId} · {h.content.archCorrectionReason}</p>}<RetentionEventDetails event={h.content.payload}/>{data.sourceMatches.filter(s=>s.entryId===h.id).map(s=><p key={s.documentId}>مستند #{s.documentId}: {s.identityMatch===true?'هويته مطابقة للشاهد المحفوظ':s.identityMatch===false?'تغير مصدر المستند؛ لم تُستبدل الأدلة المحفوظة':'لا يوجد شاهد هوية تاريخي مثبت'}</p>)}
 {data.currentEvents.some(e=>e.id===h.id)?<button type="button" className={button} disabled={blocked||!!draft} onClick={()=>{if(blocked||draft)return;update({schemaVersion:2,clientRequestId:crypto.randomUUID(),expectedHeadId:data.headId,reason:'',arch:h.content.arch,supersedesEntryId:h.id,archCorrectionReason:null,content:structuredClone(h.content.payload),expectedDocuments:'documentWitnesses' in h.content?structuredClone(h.content.documentWitnesses):[]});}}>تصحيح هذا الحدث مع إبقاء أصله</button>:<p>نسخة تاريخية حلّ تصحيح موثق مكانها.</p>}</article>)}</details>
 </section>;
}
