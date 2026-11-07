'use client';
import { useLayoutEffect,useRef,useState } from 'react';
import { DOSE_REFERENCE_VERSION } from '@/lib/medication-dose-profiles';
import { prepareChlorhexidineManualDraft,type ChlorhexidineManualInput } from '@/lib/chlorhexidine-manual-template';
import type { RxItem } from '@/lib/prescription';

export function ChlorhexidineManualTemplate({onSelect,disabled=false}:{onSelect:(item:RxItem)=>void;disabled?:boolean}){
 const active=useRef(false),disabledNow=useRef(disabled),sent=useRef(false),intent=useRef(0);
 const [renderedIntent,setRenderedIntent]=useState(0),[fields,setFields]=useState<Record<string,string>>({}),[checks,setChecks]=useState<Record<string,boolean>>({}),[confirmation,setConfirmation]=useState<string|null>(null),[added,setAdded]=useState(false);
 useLayoutEffect(()=>{active.current=true;disabledNow.current=disabled;return()=>{active.current=false;};},[disabled]);
 const reset=()=>{intent.current++;setRenderedIntent(intent.current);setConfirmation(null);sent.current=false;setAdded(false);};
 const update=(key:string,value:string)=>{reset();setFields(previous=>({...previous,[key]:value}));};
 const tick=(key:string,value:boolean)=>{reset();setChecks(previous=>({...previous,[key]:value}));};
 const number=(s:string|undefined)=>s?.trim()?Number(s):NaN;
 const input:ChlorhexidineManualInput={referenceVersion:DOSE_REFERENCE_VERSION,ageMonths:number(fields.ageMonths),ageVerified:checks.ageVerified??false,indication:fields.indication==='gingivitis'?'gingivitis':'',productName:fields.productName??'',concentrationPercent:number(fields.concentrationPercent),route:fields.route==='oromucosal-rinse'?'oromucosal-rinse':'',readyToUseProductMatched:checks.readyToUseProductMatched??false,localProductReviewed:checks.localProductReviewed??false,noChlorhexidineOrExcipientAllergy:checks.noChlorhexidineOrExcipientAllergy??false,canRinseAndSpit:checks.canRinseAndSpit??false,hygieneAndWarningsReviewed:checks.hygieneAndWarningsReviewed??false,duration:fields.duration??'',reviewPlan:fields.reviewPlan??'',durationReviewed:checks.durationReviewed??false};
 const result=prepareChlorhexidineManualDraft(input);
 const field=(key:string,label:string,type='text',maxLength=120)=><label className="grid gap-1" key={key}>{label}<input aria-label={label} type={type} step={type==='number'?'any':undefined} maxLength={maxLength} value={fields[key]??''} onChange={e=>update(key,e.target.value)} className="rounded border p-2"/></label>;
 const check=(key:string,label:string)=><label className="block" key={key}><input type="checkbox" checked={checks[key]??false} onChange={e=>tick(key,e.target.checked)}/> {label}</label>;
 return <div className="space-y-3 rounded border p-3" data-manual-template="chlorhexidine-adult-gingivitis">
 <p className="font-bold">نقل قالب نصي للبالغ: غسول0.2% لالتهاب اللثة — ليس حساب جرعة</p>
 <p>المصدر البريطاني:10mL نحو دقيقة مرتين يوميًا ثم البصق. نحو شهر لالتهاب اللثة إرشاد مرجعي؛ حدد المدة وخطة المراجعة بنفسك. روابط المصدر تخص المثال البريطاني؛ مطابقة عبوة ونشرة المستحضر الفعلي إقرار الطبيب، وليست تحققًا آليًا أو توثيقًا مستقلًا للمنتج المحلي. لا إثبات لإتاحة أو ترخيص المنتج محليًا، ولا تحويل إلى0.12% أو مطهر الجلد أو نظام أطفال.</p>
 <div className="grid gap-3 sm:grid-cols-2">{field('ageMonths','العمر المتحقق بالأشهر المكتملة','number')}{field('productName','اسم غسول الفم الفعلي')}{field('concentrationPercent','تركيز الغسول % w/v كما على العبوة','number')}
 <label>الاستطباب<select aria-label="استطباب قالب الغسول" value={fields.indication??''} onChange={e=>update('indication',e.target.value)} className="m-2 rounded border p-2"><option value="">اختر بعد مراجعة المريض</option><option value="gingivitis">التهاب اللثة — مساعد للعناية الفموية</option></select></label>
 <label>الطريق<select aria-label="طريق قالب الغسول" value={fields.route??''} onChange={e=>update('route',e.target.value)} className="m-2 rounded border p-2"><option value="">تحقق من الطريق</option><option value="oromucosal-rinse">غسول فم للمضمضة والبصق</option></select></label>
 {field('duration','مدة الغسول التي اختارها الطبيب')}{field('reviewPlan','خطة مراجعة الغسول وإيقافه','text',200)}</div>
 {check('ageVerified','تحققت من العمر الدقيق؛ هذا النقل مقصور على البالغ')}
 {check('readyToUseProductMatched','طابقت العبوة والنشرة: كلورهكسيدين0.2% w/v غسول فم جاهز؛ النظام والتعليمات مطابقان لهذا المرجع')}
 {check('localProductReviewed','راجعت المنتج المحلي وإتاحته وصلاحية استخدامه؛ لم أفترضها من النشرة البريطانية')}
 {check('noChlorhexidineOrExcipientAllergy','تحققت من عدم وجود حساسية للكلورهكسيدين أو سواغات المنتج')}
 {check('canRinseAndSpit','تحققت من قدرة المريض على المضمضة والبصق دون بلع')}
 {check('hygieneAndWarningsReviewed','راجعت العناية الفموية والتصبغ وتغير الطعم والتهيج والفصل عن المعجون الأنيوني؛ لا حالة خاصة غير محسومة')}
 {check('durationReviewed','اخترت المدة وخطة المراجعة لهذا الاستطباب؛ لم أنقل مدة مصدر إلى استطباب مختلف')}
 {!result.ok?<ul role="status">{result.problems.map(p=><li key={p}>{p}</li>)}</ul>:<div className="rounded bg-sky-50 p-3"><p dir="ltr">{result.item.dose} · {result.item.selection?.amount} · {result.item.frequency} · {result.item.duration}</p><p>{result.item.instructions}</p><p>نص مرجعي مراجع يدويًا، لا نتيجة حساب. تعديل السطر مسموح ويحتاج تأكيدًا جديدًا قبل الإصدار.</p><label><input type="checkbox" checked={confirmation===result.fingerprint} onChange={e=>{if(active.current&&renderedIntent===intent.current)setConfirmation(e.target.checked?result.fingerprint:null);}}/> راجعت قالب الغسول والنص النهائي لهذا المريض</label></div>}
 <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled||added||!result.ok||confirmation!==result.fingerprint} onClick={()=>{if(!active.current||disabledNow.current||sent.current||renderedIntent!==intent.current||!result.ok||confirmation!==result.fingerprint)return;sent.current=true;setAdded(true);onSelect(result.item);}}>{added?'نُقل قالب الغسول — أكّد السطر قبل الإصدار':'نقل قالب الغسول إلى مسودة غير مؤكدة'}</button>
 </div>;
}
