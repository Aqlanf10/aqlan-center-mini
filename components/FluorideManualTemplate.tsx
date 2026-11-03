'use client';
import {useLayoutEffect,useRef,useState} from 'react';
import {DOSE_REFERENCE_VERSION} from '@/lib/medication-dose-profiles';
import {prepareFluorideManualDraft,type FluorideManualInput} from '@/lib/fluoride-manual-template';
import type {RxItem} from '@/lib/prescription';
export function FluorideManualTemplate({onSelect,disabled=false}:{onSelect:(item:RxItem)=>void;disabled?:boolean}){
 const active=useRef(false),disabledNow=useRef(disabled),sent=useRef(false),intent=useRef(0);
 const [renderedIntent,setRenderedIntent]=useState(0),[fields,setFields]=useState<Record<string,string>>({}),[checks,setChecks]=useState<Record<string,boolean>>({}),[confirmation,setConfirmation]=useState<string|null>(null),[added,setAdded]=useState(false);
 useLayoutEffect(()=>{active.current=true;disabledNow.current=disabled;return()=>{active.current=false;};},[disabled]);
 const reset=()=>{intent.current++;setRenderedIntent(intent.current);setConfirmation(null);sent.current=false;setAdded(false);};
 const update=(key:string,value:string)=>{reset();setFields(previous=>({...previous,[key]:value}));};
 const tick=(key:string,value:boolean)=>{reset();setChecks(previous=>({...previous,[key]:value}));};
 const num=(s:string|undefined)=>s?.trim()?Number(s):NaN;
 const input:FluorideManualInput={referenceVersion:DOSE_REFERENCE_VERSION,ageMonths:num(fields.ageMonths),ageVerified:checks.ageVerified??false,productName:fields.productName??'',fluoridePpm:num(fields.fluoridePpm),sodiumFluoridePercent:num(fields.sodiumFluoridePercent),form:fields.form==='toothpaste'?'toothpaste':'',indication:fields.indication==='high-caries-risk'?'high-caries-risk':'',duration:fields.duration??'',reviewPlan:fields.reviewPlan??'',fluorideSourcePlan:fields.fluorideSourcePlan??'',productLabelMatched:checks.productLabelMatched??false,canSpitAndSupervisionReviewed:checks.canSpitAndSupervisionReviewed??false,noIngredientOrExcipientContraindication:checks.noIngredientOrExcipientContraindication??false,totalFluorideAndOtherProductsReviewed:checks.totalFluorideAndOtherProductsReviewed??false,pregnancyLactationAndSpecialConditionsReviewed:checks.pregnancyLactationAndSpecialConditionsReviewed??false,durationAndInstructionsReviewed:checks.durationAndInstructionsReviewed??false};
 const result=prepareFluorideManualDraft(input);
 const field=(key:string,label:string,type='text',maxLength=100)=><label className="grid gap-1" key={key}>{label}<input aria-label={label} type={type} step={type==='number'?'any':undefined} maxLength={maxLength} value={fields[key]??''} onChange={e=>update(key,e.target.value)} className="rounded border p-2"/></label>;
 const check=(key:string,label:string)=><label className="block" key={key}><input type="checkbox" checked={checks[key]??false} onChange={e=>tick(key,e.target.checked)}/> {label}</label>;
 return <div data-manual-template="fluoride-toothpaste5000" className="space-y-3 rounded border p-3">
 <p className="font-bold">نقل يدوي اختياري لمعجون5000ppm من16سنة فأكثر — ليس حساب جرعة أو فلوريد كلي</p>
 <p>المصدرSDCEP ونشرة منتج بريطاني مثالان لا إثبات لتوافر أو ترخيص المنتج المحلي. طابق العبوة والنشرة الفعليتين.2cm نحو3دقائق ثلاث مرات بعد الطعام ثم البصق؛ لا تحويل إلىmg ولا افتراض كثافة. لا دمج تلقائي مع غسول أو مكملات فلوريد.</p>
 <div className="grid gap-3 sm:grid-cols-2">{field('ageMonths','عمر مستخدم المعجون بالأشهر المكتملة','number')}{field('productName','اسم معجون الفلوريد الفعلي')}{field('fluoridePpm','تركيز أيون الفلوريد ppm','number')}{field('sodiumFluoridePercent','فلوريد الصوديوم % w/w','number')}
 <label>الاستطباب<select aria-label="استطباب المعجون" value={fields.indication??''} onChange={e=>update('indication',e.target.value)} className="m-2 rounded border p-2"><option value="">اختر بعد التقييم</option><option value="high-caries-risk">خطر تسوس مرتفع يحتاج فلوريد موصوفًا</option></select></label>
 <label>المستحضر<select aria-label="شكل معجون الفلوريد" value={fields.form??''} onChange={e=>update('form',e.target.value)} className="m-2 rounded border p-2"><option value="">تحقق من الشكل</option><option value="toothpaste">معجون أسنان فقط</option></select></label>
 {field('duration','مدة المعجون التي اختارها الطبيب')}{field('reviewPlan','خطة متابعة الفلوريد','text',150)}{field('fluorideSourcePlan','الإجراءات المحددة لمصادر الفلوريد الحالية والجديدة والماء والملح','text',200)}</div>
 {check('ageVerified','تحققت من عمر16سنة فأكثر بدقة؛ ليس حدًا مستنتجًا من الوزن')}
 {check('productLabelMatched','طابقت النشرة والمنتج المحلي والمادة والقوة والشكل والتعليمات وعمر الاستخدام؛ لا ادعاء تحقق آلي من المنتج')}
 {check('canSpitAndSupervisionReviewed','تحققت من القدرة على البصق وعدم البلع والإشراف المناسب؛ لا خطر ابتلاع غير محسوم')}
 {check('noIngredientOrExcipientContraindication','راجعت حساسية المادة والسواغات، ومنها السوربيتول وعدم تحمل الفركتوز الوراثي إن كانا متعلقين بالمنتج؛ لا مانع غير محسوم')}
 {check('totalFluorideAndOtherProductsReviewed','قيّمت إجمالي مصادر الفلوريد والماء/الملح والمكملات والغسول والجل والورنيش مع نشرة المنتج؛ عالجت أي استعمال متزامن غير مسموح، ولا افتراض أن كل التركيبات آمنة')}
 {check('pregnancyLactationAndSpecialConditionsReviewed','راجعت الحمل والرضاعة والحالات الخاصة وموازنة المنفعة والخطر مع النشرة؛ لا قرار غير محسوم')}
 {check('durationAndInstructionsReviewed','اخترت المدة والمتابعة وراجعت التعليمات النهائية ونشرة المريض؛ كتبت الإجراءات المحددة لكل مصدر فلوريد حالي أو جديد والماء والملح، لا مجرد إقرار عام')}
 {!result.ok?<ul role="status">{result.problems.map(p=><li key={p}>{p}</li>)}</ul>:<div className="rounded bg-sky-50 p-3"><p dir="ltr">{result.item.dose} · {result.item.selection?.amount} · {result.item.frequency} · {result.item.duration}</p><p>{result.item.instructions}</p><p dir="ltr">{result.item.instructionsEn}</p><label><input type="checkbox" checked={confirmation===result.fingerprint} onChange={e=>{if(active.current&&renderedIntent===intent.current)setConfirmation(e.target.checked?result.fingerprint:null);}}/> راجعت قالب المعجون والنص النهائي لهذا المريض</label></div>}
 <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled||added||!result.ok||confirmation!==result.fingerprint} onClick={()=>{if(!active.current||disabledNow.current||sent.current||renderedIntent!==intent.current||!result.ok||confirmation!==result.fingerprint)return;sent.current=true;setAdded(true);onSelect(result.item);}}>{added?'نُقل قالب المعجون — أكّد السطر قبل الإصدار':'نقل قالب المعجون إلى مسودة غير مؤكدة'}</button>
 </div>;
}
