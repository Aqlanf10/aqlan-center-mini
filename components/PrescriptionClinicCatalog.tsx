"use client";
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MEDICATION_CATALOG_KEY, EMPTY_MEDICATION_CATALOG, parseMedicationCatalog, catalogMedicationToDraft, type CatalogMedication } from '@/lib/medication-catalog';
import { useSessionActions } from './SessionProvider';
import type { RxItem } from '@/lib/prescription';
export function PrescriptionClinicCatalog({onSelect,disabled=false}:{onSelect:(item:RxItem)=>void;disabled?:boolean}) {
 const {session,ready}=useSessionActions();
 const owner=ready&&session?JSON.stringify([session.username,session.role,session.permissions]):'unavailable';
 return <ClinicCatalogEntries key={owner} onSelect={onSelect} disabled={disabled || owner==='unavailable'} owner={owner}/>;
}
function ClinicCatalogEntries({onSelect,disabled,owner}:{onSelect:(item:RxItem)=>void;disabled:boolean;owner:string}) {
 const active=useRef(false),disabledNow=useRef(disabled);
 useLayoutEffect(()=>{active.current=true;disabledNow.current=disabled;return()=>{active.current=false;};},[disabled]);
 const [entries,setEntries]=useState<CatalogMedication[]>([]),[query,setQuery]=useState(''),[error,setError]=useState('');
 useEffect(()=>{let live=true;const controller=new AbortController();if(owner==='unavailable')return;fetch('/api/settings',{cache:'no-store',signal:controller.signal}).then(async r=>{if(!r.ok)throw Error();const data=await r.json();const parsed=parseMedicationCatalog(data[MEDICATION_CATALOG_KEY]??EMPTY_MEDICATION_CATALOG);if(!parsed.ok)throw Error();if(live)setEntries(parsed.value.entries.filter(e=>e.enabled));}).catch(()=>{if(live)setError('تعذر تحميل إضافات المركز؛ الإدخال اليدوي متاح.');});return()=>{live=false;controller.abort();};},[owner]);
 return <details className="rounded-xl border p-3 text-sm"><summary className="cursor-pointer font-bold">أدوية المركز — من الإعدادات</summary><p className="my-2">تُنسخ البيانات إلى مسودة غير مؤكدة. راجع الجرعة المناسبة للمريض قبل الإصدار؛ لا اعتماد تلقائي.</p>{error&&<p role="status">{error}</p>}<label>بحث<input className="mx-2 rounded border p-2" value={query} onChange={e=>setQuery(e.target.value)}/></label>{entries.filter(e=>`${e.name} ${e.arabicName}`.toLowerCase().includes(query.toLowerCase())).map(e=><article key={e.id} className="my-2 rounded border p-3"><strong><bdi dir="ltr">{e.name}</bdi> — {e.arabicName}</strong><p>{e.form} · <bdi dir="ltr">{e.strength}</bdi> · {e.population==='child'?'أطفال':e.population==='adult'?'بالغون':'كبار وأطفال — مراجعة منفصلة'}</p><p>{e.indication}</p><p className="text-amber-900">{e.cautions}</p>{e.sourceUrl&&<a href={e.sourceUrl} target="_blank" rel="noreferrer" className="underline">المرجع</a>}<button type="button" disabled={disabled} className="mx-2 rounded border px-3 py-2" onClick={()=>{if(!active.current||disabledNow.current)return;const item=catalogMedicationToDraft(e);if(item)onSelect(item);}}>إضافة للمسودة للمراجعة</button></article>)}{!entries.length&&!error&&<p className="mt-2">لا توجد إضافات مفعلة للمركز.</p>}</details>;
}
