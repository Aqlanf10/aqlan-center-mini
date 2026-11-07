"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSession } from './SessionProvider';
import { PHOTO_VIEW_LABEL } from '@/lib/ortho-photos';
import { PHOTO_COMPARISON_LIMITS, readPhotoComparison, type ComparisonPhoto, type PhotoComparisonRead } from '@/lib/ortho-photo-comparison';

type Props = {patientId:number;orthoCaseId:number;photosVisible?:boolean;readVersion?:number;ownerIdentity?:object;active?:()=>boolean};
type Read = Extract<PhotoComparisonRead,{ok:true}>;
const allowed = () => true;
export function OrthoComparison(props:Props) {
 const session=useSession();
 const authority=JSON.stringify([session?.userId,session?.username,session?.role,session?.permissions??null]);
 return <Comparison key={`${props.patientId}:${props.orthoCaseId}:${authority}`} {...props} authority={authority}/>;
}
async function readBody(response:Response,signal:AbortSignal):Promise<unknown>{
 if(response.redirected||response.status!==200||!response.headers.get('content-type')?.includes('application/json')){await response.body?.cancel();throw Error('read');}
 const length=response.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>PHOTO_COMPARISON_LIMITS.bytes)){await response.body?.cancel();throw Error('size');}
 const reader=response.body?.getReader();if(!reader)throw Error('body');
 const chunks:Uint8Array[]=[];let size=0;const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 try{while(true){const part=await reader.read();if(signal.aborted)throw Error('abort');if(part.done)break;size+=part.value.byteLength;if(size>PHOTO_COMPARISON_LIMITS.bytes)throw Error('size');chunks.push(part.value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});}
}
function Comparison({patientId,orthoCaseId,photosVisible,readVersion,ownerIdentity,active=allowed,authority}:Props&{authority:string}){
 const [reload,setReload]=useState(0);
 const token=useMemo(()=>({patientId,orthoCaseId,authority,photosVisible,readVersion,ownerIdentity,reload}),[patientId,orthoCaseId,authority,photosVisible,readVersion,ownerIdentity,reload]);
 const committed=useRef<object|null>(null),latest=useRef(active);
 useLayoutEffect(()=>{latest.current=active;});
 useLayoutEffect(()=>{committed.current=token;return()=>{if(committed.current===token)committed.current=null;};},[token]);
 const [view,setView]=useState<{token:object;data:Read|null;error:string|null}|null>(null);
 const [choice,setChoice]=useState<{read:Read;ids:Record<string,number>}|null>(null);
 const current=()=>committed.current===token&&latest.current()&&photosVisible!==false;
 const rendered=useMemo(()=>({token,view,choice}),[token,view,choice]);
 const shown=useRef<object|null>(null);
 useLayoutEffect(()=>{shown.current=rendered;return()=>{if(shown.current===rendered)shown.current=null;};},[rendered]);
 const currentRender=()=>current()&&shown.current===rendered;
 useEffect(()=>{
  if(photosVisible===false||!latest.current())return;
  const controller=new AbortController();let live=true;
  const owned=()=>live&&committed.current===token&&latest.current();
  const timeout=setTimeout(()=>{controller.abort();if(owned())setView({token,data:null,error:'انتهت مهلة قراءة الصور. لم تُعرض قراءة سابقة؛ يمكنك إعادة المحاولة صراحة.'});},15000);
  void(async()=>{try{
   const response=await fetch(`/api/patients/${patientId}/documents`,{cache:'no-store',credentials:'same-origin',redirect:'error',signal:controller.signal});
   const raw=await readBody(response,controller.signal),data=readPhotoComparison(raw,{patientId,orthoCaseId});
   if(!data.ok)throw Error('invalid');if(owned()&&!controller.signal.aborted)setView({token,data,error:null});
  }catch{if(owned()&&!controller.signal.aborted)setView({token,data:null,error:'تعذرت قراءة الصور أو التحقق من صلاحيتها. لا يعني ذلك عدم وجود صور.'});}finally{clearTimeout(timeout);}})();
  return()=>{live=false;clearTimeout(timeout);controller.abort();};
 },[token,patientId,orthoCaseId,photosVisible]);
 if(photosVisible===false||!active())return <p role="status">صور الجلسات محجوبة حسب صلاحياتك. لا يمكن تحديد وجود الصور أو مقارنة مراحلها من هذا العرض.</p>;
 const data=view?.token===token?view.data:null,error=view?.token===token?view.error:null;
 const invalidate=()=>{if(currentRender()&&view?.token===token){shown.current=null;setView({token,data:null,error:'تعذر عرض مصدر الصورة. حُجبت القراءة الحالية؛ حدّث للتحقق من الصلاحية والمصدر.'});}};
 const groups=data?[...data.columns.map(c=>({key:c.stage,label:c.label,candidates:c.candidates,featured:c.featured,basis:c.selection})),{key:'unknown',label:'مرحلة غير مسجلة',candidates:data.unassigned,featured:null,basis:'manual'}]:[];
 return <section aria-label="مقارنة الصور المسجلة" className="space-y-3">
 <h4 className="font-bold">مقارنة الصور بحسب المرحلة المسجلة</h4>
 <p className="text-xs">تصنيف توثيقي، لا يثبت تقدم العلاج أو الحضور. تاريخ الرفع ليس تاريخ التقاط الصورة. لم تُستنتج مرحلة أو تواريخ مفقودة.</p>
 <button type="button" className="min-h-11 rounded border px-3" onClick={()=>{if(currentRender()){shown.current=null;setReload(v=>v+1);}}}>تحديث قراءة الصور</button>
 {error?<p role="alert">{error}</p>:!data?<p role="status">جارٍ التحقق من الصور…</p>:<>
 <p>{data.columns.reduce((sum,c)=>sum+c.count,0)+data.unassigned.length} صورة مسجلة قابلة للعرض في هذه الحالة</p>
 <p className="text-xs">تُستبعد الصور المخفية والمؤرشفة والسجلات غير التابعة لهذه الحالة؛ غيابها هنا لا يثبت عدم وجود توثيق سابق.</p>
 <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{groups.filter(g=>g.candidates.length).map(group=>{
 const explicit=choice?.read===data?choice.ids[group.key]:undefined;
 const photo=explicit===undefined?group.featured:group.candidates.find(p=>p.id===explicit)??null;
 const selected=(p:ComparisonPhoto)=>`#${p.id} · ${p.title} · ${p.takenOn??'تاريخ الالتقاط غير معلوم'}`;
 return <section key={group.key} className="min-w-0 rounded border p-2"><h5 className="font-bold">{group.label}</h5>
 <p>{group.candidates.length} صورة</p>
 <p className="text-xs">{explicit!==undefined?'اختيار يدوي للعرض، دون استنتاج ترتيب سريري.':group.basis==='recorded_date'?'اختيار حسب الوجهة المسجلة أولاً، ثم الأقدم للبداية أو الأحدث للمراحل الأخرى بحسب تاريخ الالتقاط المسجل.':group.basis==='single_unknown_date'?'مرشح واحد ضمن أولوية الوجهة؛ تاريخ الالتقاط غير معلوم.':'اختر صورة صراحة؛ لا تُحسم التواريخ المجهولة أو المتساوية بوقت الرفع.'}</p>
 <label className="block">صورة {group.label}<select className="min-h-11 w-full min-w-0 border" value={explicit??''} onChange={event=>{if(!currentRender()||view?.data!==data)return;const value=event.target.value,id=Number(value);if(value!==''&&!group.candidates.some(p=>p.id===id))return;shown.current=null;setChoice(old=>{const ids={...(old?.read===data?old.ids:{})};if(value==='')delete ids[group.key];else ids[group.key]=id;return {read:data,ids};});}}><option value="">{group.featured?'الاختيار التوثيقي الموضح أعلاه':'اختر صورة…'}</option>{group.candidates.map(p=><option key={p.id} value={p.id}>{selected(p)}</option>)}</select></label>
 {photo&&<><p className="break-words">{selected(photo)}</p><p>الوجهة المسجلة: {photo.view?PHOTO_VIEW_LABEL[photo.view]:'غير معلومة'}</p><p>وقت الرفع فقط: <bdi dir="ltr">{photo.uploadedAt}</bdi></p><p className="whitespace-pre-wrap break-words">{photo.note??'لا ملاحظة مصدر مسجلة'}</p>
 <a href={`/api/documents/${photo.id}`} target="_blank" rel="noopener noreferrer" onClick={event=>{if(!currentRender()||view?.data!==data)event.preventDefault();}}><img key={`${photo.id}:${reload}`} src={`/api/documents/${photo.id}`} alt={`الصورة المسجلة #${photo.id} · ${group.label}`} onError={invalidate} className="aspect-square w-full rounded object-contain"/></a></>}
 </section>;})}</div></>}
 </section>;
}
