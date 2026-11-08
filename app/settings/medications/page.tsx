"use client";
import Link from 'next/link';
import { useSessionActions } from '@/components/SessionProvider';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MEDICATION_CATALOG_KEY as KEY, EMPTY_MEDICATION_CATALOG, parseMedicationCatalog, type CatalogMedication, type MedicationCatalog } from '@/lib/medication-catalog';
const blank = ():CatalogMedication => ({id:crypto.randomUUID(),revision:1,enabled:true,name:'',arabicName:'',form:'',strength:'',population:'both',amount:'',frequency:'',duration:'',instructionsAr:'',instructionsEn:'',indication:'',cautions:'',sourceUrl:''});
const labels = {name:'الاسم العلمي بالإنجليزية',arabicName:'الاسم بالعربية',form:'الشكل الدوائي وطريق الاستخدام',strength:'قوة المنتج أو تركيزه ووحدته (mg/tablet أو units/mL أو %)',amount:'مقدار الجرعة ووحدتها لكل مرة — اختياري',frequency:'الفاصل والتكرار — اختياري',duration:'المدة والمراجعة — اختياري',instructionsAr:'تعليمات عربية',instructionsEn:'تعليمات إنجليزية',indication:'الاستطباب وحدود الاستخدام',cautions:'التحذيرات وموانع الاستخدام',sourceUrl:'رابط المرجع أو نشرة المنتج (HTTPS)'} as const;
export default function MedicationsSettings() {
 const {session,ready}=useSessionActions();
 const owner=ready&&session?JSON.stringify([session.userId,session.username,session.role,session.permissions]):'unavailable';
 return <MedicationsEditor key={owner} owner={owner} username={session?.username??null}/>;
}
function MedicationsEditor({owner,username}:{owner:string;username:string|null}) {
 const generation=useRef(0);
 const active=useRef(false),sequence=useRef(0),sending=useRef(false),request=useRef<AbortController|null>(null);
 useLayoutEffect(()=>{const life=generation;life.current++;active.current=true;return()=>{active.current=false;life.current++;request.current?.abort();};},[]);
 const [catalog,setCatalog]=useState<MedicationCatalog>({schemaVersion:1,entries:[]});
 const [version,setVersion]=useState<string|null>(null),[loaded,setLoaded]=useState(false),[canEdit,setCanEdit]=useState(false);
 const [draft,setDraft]=useState<CatalogMedication|null>(null),[reason,setReason]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[search,setSearch]=useState('');
 const reload=useCallback(async () => {
  if(!active.current || !username || owner==='unavailable') return;
  const seq=++sequence.current;request.current?.abort();const controller=new AbortController();request.current=controller;
  const life=generation.current;
  const current=()=>active.current && generation.current===life && sequence.current===seq;
  try {const [r,me]=await Promise.all([fetch("/api/settings",{cache:'no-store',signal:controller.signal}),fetch('/api/auth/me',{cache:'no-store',signal:controller.signal})]);
   if(!current()) return;
   if(!r.ok || !me.ok) throw Error('تعذر تحميل الدليل أو الصلاحيات.');
   const data=await r.json(), actor=await me.json(), parsed=parseMedicationCatalog(data[KEY]??EMPTY_MEDICATION_CATALOG);
   if(!current()) return;
   if(actor.username!==username) throw Error('تغيّرت الجلسة؛ حدّث الصفحة.');
   if(!parsed.ok) throw Error(parsed.message);
   setCatalog(parsed.value);setVersion(data.__versions?.[KEY]??null);setCanEdit(actor.role==='admin');setLoaded(true);
  } catch(e) {if(!current())return;setMessage(e instanceof Error?e.message:'تعذر التحميل.');}
 },[owner,username]);
 useEffect(()=>{void Promise.resolve().then(reload);},[reload]);
 async function save() {
  if(!active.current || !draft || !loaded || sending.current || !canEdit) return;
  const old=catalog.entries.find(e=>e.id===draft.id);
  const changed=old && Object.keys(labels).some(k=>old[k as keyof CatalogMedication]!==draft[k as keyof CatalogMedication]) || old && (old.enabled!==draft.enabled || old.population!==draft.population);
  const entry={...draft,revision:old?old.revision+(changed?1:0):1};
  const next={schemaVersion:1 as const,entries:old?catalog.entries.map(e=>e.id===entry.id?entry:e):[...catalog.entries,entry]};
  const parsed=parseMedicationCatalog(JSON.stringify(next));
  if(!parsed.ok || !reason.trim()) {setMessage(parsed.ok?'اكتب سبب الإضافة أو التعديل.':parsed.message);return;}
  sending.current=true;setBusy(true);setMessage('');
  const intent=draft.id, life=generation.current;
  const current=()=>active.current && generation.current===life;
  try {const response=await fetch("/api/settings",{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({[KEY]:JSON.stringify(next),__versions:{[KEY]:version},__reason:reason,__expectedActor:username})});
   const data=await response.json(); if(!current())return; if(!response.ok) throw Error(data.message??'تعذر الحفظ.');
   setDraft(current=>current?.id===intent?null:current);setReason('');setLoaded(false);await reload();if(!current())return;setMessage('حُفظ الدليل وسجل التعديل. الوصفات السابقة لم تتغير.');
  } catch(e){if(!current())return;setMessage(e instanceof Error?e.message:'تعذر الحفظ؛ راجع الدليل قبل المحاولة.');}finally{sending.current=false;if(current())setBusy(false);}
 }
 return <main dir="rtl" className="mx-auto max-w-5xl space-y-5 p-5">
  <Link href="/settings" className="underline">الإعدادات</Link><h1 className="text-2xl font-bold">دليل أدوية الوصفات</h1>
  <p className="rounded-xl border border-amber-200 bg-amber-50 p-4">إضافة الدواء لا تعتمد جرعته لأي مريض. يراجع الطبيب العمر والوزن والحساسية والاستطباب والمنتج والجرعة عند كتابة الوصفة. لا حساب تلقائي ولا اختيار مضاد تلقائي. التعطيل يمنع الاختيار الجديد ولا يغيّر الوصفات المحفوظة.</p>
  <p role="status" aria-live="polite">{message}</p>
  <div className="flex flex-wrap gap-3"><label>بحث<input className="mx-2 rounded border p-2" value={search} onChange={e=>setSearch(e.target.value)}/></label><button type="button" disabled={!loaded||!canEdit||busy||!!draft} className="rounded bg-sky-800 px-4 py-2 text-white disabled:opacity-50" onClick={()=>{if(!active.current||!loaded||sending.current||draft)return;setDraft(blank());setReason('');}}>إضافة دواء</button><button type="button" className="rounded border px-4 py-2" disabled={busy||!!draft} onClick={()=>{if(sending.current||draft)return;setLoaded(false);void reload();}}>تحديث الدليل</button><Link href="/settings/history" className="p-2 underline">سجل التغييرات</Link></div>
  {!loaded&&<p>لم يكتمل تحميل الدليل.</p>}{loaded&&!canEdit&&<p>عرض فقط؛ تعديل الدليل يحتاج صلاحية إدارة الإعدادات.</p>}
  {catalog.entries.filter(e=>`${e.name} ${e.arabicName}`.toLowerCase().includes(search.toLowerCase())).map(e=><article key={e.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"><div><h2 className="font-bold"><bdi dir="ltr">{e.name}</bdi> — {e.arabicName}</h2><p>{e.form} · <bdi dir="ltr">{e.strength}</bdi> · {e.enabled?'متاح للاختيار':'معطّل'} · إصدار {e.revision}</p></div><button type="button" disabled={!loaded||!canEdit||busy||!!draft} className="rounded border px-4 py-2" onClick={()=>{if(!active.current||!loaded||sending.current||draft)return;setDraft({...e});setReason('');}}>تعديل / تعطيل</button></article>)}
  {loaded&&!catalog.entries.length&&<p>لا توجد إضافات للمركز بعد. المراجع العلمية منفصلة داخل نافذة الوصفة.</p>}
  {draft&&<p>أكمل التعديل أو ألغِه قبل تحديث الدليل أو فتح دواء آخر.</p>}
  {draft&&<fieldset disabled={busy} className="space-y-4 rounded-xl border-2 border-sky-800 p-5"><h2 className="text-xl font-bold">بيانات الدواء</h2><div className="grid gap-4 md:grid-cols-2">{Object.entries(labels).map(([key,label])=><label key={key} className="flex flex-col gap-1">{label}<input dir={['name','strength','sourceUrl','instructionsEn'].includes(key)?'ltr':'rtl'} className="rounded border p-2" value={String(draft[key as keyof CatalogMedication])} maxLength={['instructionsAr','instructionsEn','cautions'].includes(key)?1000:200} onChange={e=>setDraft({...draft,[key]:e.target.value})}/></label>)}</div><label>الفئة<select className="mx-2 rounded border p-2" value={draft.population} onChange={e=>setDraft({...draft,population:e.target.value as CatalogMedication['population']})}><option value="both">كبار وأطفال — مراجعة منفصلة</option><option value="adult">بالغ</option><option value="child">طفل</option></select></label><label className="block"><input type="checkbox" checked={draft.enabled} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/> متاح للاختيار الجديد</label><label className="block">سبب التغيير<input className="mx-2 rounded border p-2" value={reason} onChange={e=>setReason(e.target.value)} maxLength={500}/></label><div className="flex gap-3"><button type="button" disabled={busy} onClick={()=>void save()} className="rounded bg-sky-800 px-4 py-2 text-white">{busy?'جارٍ الحفظ…':'حفظ التغيير'}</button><button type="button" disabled={busy} onClick={()=>{if(!active.current||sending.current)return;setDraft(null);}} className="rounded border px-4 py-2">إلغاء</button></div></fieldset>}
 </main>;
}
