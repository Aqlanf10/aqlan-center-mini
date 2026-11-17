'use client';
import {useLayoutEffect,useRef,useState} from 'react';
import {DOSE_REFERENCE_VERSION} from '@/lib/medication-dose-profiles';
import {ANTIBIOTIC_MANUAL_REGIMENS,prepareAntibioticManualDraft,type AntibioticManualInput,type AntibioticManualProfile} from '@/lib/antibiotic-manual-templates';
import type {RxItem} from '@/lib/prescription';
export function AntibioticManualTemplate({profileId,onSelect,disabled=false}:{profileId:AntibioticManualProfile;onSelect:(item:RxItem)=>void;disabled?:boolean}){
 const active=useRef(false),disabledNow=useRef(disabled),sent=useRef(false),intent=useRef(0);
 const [renderedIntent,setRenderedIntent]=useState(0),[fields,setFields]=useState<Record<string,string>>({}),[checks,setChecks]=useState<Record<string,boolean>>({}),[confirmation,setConfirmation]=useState<string|null>(null),[added,setAdded]=useState(false);
 useLayoutEffect(()=>{active.current=true;disabledNow.current=disabled;return()=>{active.current=false;};},[disabled]);
 const reset=()=>{intent.current++;setRenderedIntent(intent.current);setConfirmation(null);sent.current=false;setAdded(false);};
 const update=(key:string,value:string)=>{reset();setFields(previous=>({...previous,[key]:value}));};
 const tick=(key:string,value:boolean)=>{reset();setChecks(previous=>({...previous,[key]:value}));};
 const number=(s:string|undefined)=>s?.trim()?Number(s):NaN;
 const r=ANTIBIOTIC_MANUAL_REGIMENS[profileId];
 const input:AntibioticManualInput={profileId,referenceVersion:DOSE_REFERENCE_VERSION,ageMonths:number(fields.ageMonths),weightKg:number(fields.weightKg),ageWeightVerified:checks.ageWeightVerified??false,noLowWeightOrNutritionConcern:checks.noLowWeightOrNutritionConcern??false,indication:fields.indication==='spreading-or-systemic-abscess'?'spreading-or-systemic-abscess':'',productName:fields.productName??'',strengthMg:number(fields.strengthMg),form:fields.form??'',durationDays:number(fields.durationDays),reviewWithinDays:number(fields.reviewWithinDays),reviewPlan:fields.reviewPlan??'',actualProductAndLimitsMatched:checks.actualProductAndLimitsMatched??false,sourceControlArranged:checks.sourceControlArranged??false,noEmergencyOrSevereInfection:checks.noEmergencyOrSevereInfection??false,allergyPathReviewed:checks.allergyPathReviewed??false,noUnresolvedConditionOrInteraction:checks.noUnresolvedConditionOrInteraction??false,patientInstructionsReviewed:checks.patientInstructionsReviewed??false,antibioticChoiceReviewed:checks.antibioticChoiceReviewed??false};
 const result=prepareAntibioticManualDraft(input);
 const field=(key:string,label:string,type='text',maxLength=120)=><label className="grid gap-1" key={key}>{label}<input aria-label={label} type={type} step={type==='number'?'any':undefined} maxLength={maxLength} value={fields[key]??''} onChange={e=>update(key,e.target.value)} className="rounded border p-2"/></label>;
 const check=(key:string,label:string)=><label className="block" key={key}><input type="checkbox" checked={checks[key]??false} onChange={e=>tick(key,e.target.checked)}/> {label}</label>;
 return <div data-manual-template={profileId} className="space-y-3 rounded border p-3">
 <p className="font-bold">قالب بالغ اختياري: <bdi>{r.name}</bdi> وفق SDCEP — نقل نص لا حساب جرعة</p>
 <p dir="ltr">{r.strengthMg} mg · {r.amount} · {r.frequency} · {r.regimenMg24h} mg/day for this regimen, NOT a universal maximum.</p>
 <p>هذا مثال بريطاني لا إثبات لتسجيل أو توافر منتج محلي. طابق المنتج وحدوده لكل مريض؛ المطابقة إقرار الطبيب وليست تحققًا آليًا أو سجلًا مستقلًا لنشرة المنتج.3–5 أيام مع مراجعة خلال3 أيام وقرار الإيقاف أو الإكمال بعد تقييم الطبيب في المراجعة: لا علامات عدوى مستمرة، تحسن الألم، أكل وشرب طبيعيان ولا علامات خطر. استمرار العدوى يحتاج قرار إكمال/إعادة تقييم، وعلامات الخطر إحالة طارئة. لا يُدمج بشرط ADA «24 ساعة بعد زوال الأعراض». ليس مسار أطفال أو وقاية أو عدوى شديدة.</p>
 <div className="grid gap-3 sm:grid-cols-2">
 {field('ageMonths','عمر بالغ بالأشهر المكتملة','number')}{field('weightKg','وزن بالغ حالي kg','number')}{field('productName','اسم مستحضر المضاد الفعلي','text',100)}{field('strengthMg','قوة وحدة المستحضر mg','number')}
 <label>الاستطباب<select aria-label="استطباب قالب المضاد" value={fields.indication??''} onChange={e=>update('indication',e.target.value)} className="m-2 rounded border p-2"><option value="">اختر بعد الفحص</option><option value="spreading-or-systemic-abscess">خراج سني مع انتشار أو علامات جهازية</option></select></label>
 <label>الشكل والطريق<select aria-label="شكل قالب المضاد" value={fields.form??''} onChange={e=>update('form',e.target.value)} className="m-2 rounded border p-2"><option value="">طابق المنتج</option><option value="Oral capsule">كبسولة فموية</option><option value="Oral tablet">قرص فموي</option></select></label>
 {field('durationDays','مدة المضاد المختارة بالأيام (3–5)','number')}{field('reviewWithinDays','المراجعة خلال عدد أيام (1–3)','number')}{field('reviewPlan','موعد وخطة مراجعة المضاد')}
 </div>
 {check('ageWeightVerified','تحققت من عمر ووزن هذا البالغ؛ لا بيانات افتراضية')}
 {check('noLowWeightOrNutritionConcern','قيّمت نقص الوزن والتغذية وملاءمة نظام البالغ؛ لا حاجة لتعديل فردي أو قرار غير محسوم. هذا إقرار سريري وليس تحققًا عدديًا للوزن')}
 {check('actualProductAndLimitsMatched','طابقت المادة المفردة والشكل والقوة والجرعة والتكرار والمدة وحدود العمر والوزن مع نشرة المنتج الفعلي وصلاحية استعماله محليًا؛ لا حد أقل غير محسوم')}
 {check('sourceControlArranged','حددت علاج السبب والتصريف أو الإحالة المناسبة؛ المضاد لا يستبدل العلاج السني')}
 {check('noEmergencyOrSevereInfection','لا عدوى شديدة أو انتشار سريع أو صعوبة بلع/تنفس أو تورم قاع الفم أو تقييد فم شديد أو إنتان؛ الحالات الخطرة خارج هذا القالب')}
 {check('allergyPathReviewed',profileId==='metronidazole-sdcep'?'تحققت من حساسية البنسلين كسبب اختيار البديل ومن عدم حساسية الميترونيدازول/النيتروإيميدازول أو السواغات؛ ليس إضافة تلقائية لمضاد آخر':'تحققت من عدم حساسية البنسلين أو السواغات أو تفاعل فوري شديد لبيتا لاكتام آخر؛ لا قصة حساسية غير محسومة')}
 {check('noUnresolvedConditionOrInteraction',profileId==='metronidazole-sdcep'?'لا وارفارين أو تداخل غير محسوم؛ راجعت الكبد والكلى والحمل والرضاعة والأمراض العصبية ونشرة المنتج، ولا تعديل خاص مطلوب':'راجعت الكلى والكبد والحمل والرضاعة والوارفارين وبقية الأدوية؛ لا حالة خاصة أو تداخل يحتاج تعديلًا خارج المثال')}
 {check('antibioticChoiceReviewed',profileId==='amoxicillin-sdcep'?'قررت أن الالتزام بنظام البنسلين V الضيق أصعب، وأن الأموكسيسيلين مناسب وفق هذا المسار؛ ليس اختيارًا تلقائيًا':'قررت ملاءمة هذا المضاد لهذا الاستطباب تحديدًا بعد الفحص؛ ليس علاجًا تلقائيًا للألم أو الخلع')}
 {check('patientInstructionsReviewed',profileId==='metronidazole-sdcep'?'راجعت التعليمات النهائية والمراجعة والإيقاف والطوارئ ونشرة المريض، ومنها تجنب الكحول أثناء العلاج و48 ساعة على الأقل بعده؛ طابقت النشرة الفعلية وأي مدة أطول مطلوبة':'راجعت التعليمات النهائية وموعد المراجعة وقرار الإيقاف أو الإكمال والطوارئ ونشرة المريض')}
 {!result.ok?<ul role="status">{result.problems.map(p=><li key={p}>{p}</li>)}</ul>:<div className="rounded bg-sky-50 p-3"><p dir="ltr">{result.item.name} · {result.item.dose} · {result.item.selection?.amount} · {result.item.frequency} · {result.item.duration}</p><p>{result.item.instructions}</p><p dir="ltr">{result.item.instructionsEn}</p><label><input type="checkbox" checked={confirmation===result.fingerprint} onChange={e=>{if(active.current&&renderedIntent===intent.current)setConfirmation(e.target.checked?result.fingerprint:null);}}/> راجعت قالب المضاد والنص النهائي لهذا المريض</label></div>}
 <button type="button" className="rounded border px-3 py-2 disabled:opacity-50" disabled={disabled||added||!result.ok||confirmation!==result.fingerprint} onClick={()=>{if(!active.current||disabledNow.current||sent.current||renderedIntent!==intent.current||!result.ok||confirmation!==result.fingerprint)return;sent.current=true;setAdded(true);onSelect(result.item);}}>{added?'نُقل قالب المضاد — أكّد السطر قبل الإصدار':'نقل قالب المضاد إلى مسودة غير مؤكدة'}</button>
 </div>;
}
