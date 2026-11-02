'use client';
import { useCallback,useLayoutEffect,useRef,useState } from 'react';
import { useSessionActions } from './SessionProvider';
import { DOSE_REFERENCES,DOSE_REFERENCE_SOURCES,DOSE_REFERENCE_WARNINGS,DOSE_REFERENCE_VERSION,doseCalculationRule,doseProfileCalculationBlocker } from '@/lib/medication-dose-profiles';
import { parseDoseReviewInput,parseDoseReviewInputV2,reviewMedicationDose } from '@/lib/medication-dose-review';
import { createCalculatedDoseProvenance,calculatedDoseFields } from '@/lib/medication-dose-provenance';
import type { RxItem } from '@/lib/prescription';

const factLabels:Record<string,string>={
 times_per_day:'مرات في اليوم',minimum_interval_hours:'أقل فاصل بالساعات',interval_hours:'الفاصل بالساعات',interval_hours_range:'نطاق الفاصل بالساعات',as_needed:'عند الحاجة',divisions_per_day:'تقسيم الجرعة اليومية',times_per_day_by_age:'المرات حسب العمر',mg_per_24h:'حد mg خلال24ساعة',mg_per_kg_24h:'حد mg/kg خلال24ساعة',mg_per_single_dose:'حد الجرعة المفردة mg',maximum_administrations_24h:'أقصى مرات خلال24ساعة',max_administrations_24h:'أقصى مرات خلال24ساعة',example_days:'مدة المثال بالأيام — ليست اختيارًا تلقائيًا',range_days:'نطاق المدة بالأيام',review_day:'يوم المراجعة',stop:'شرط الإيقاف',selection:'اختيار المدة',total_days:'مجموع الأيام',reference_days:'أيام المرجع',continuation:'الاستمرار والمراجعة',example_total_days:'أيام المثال الكلية',adult:'بالغ',day1:'اليوم الأول',days2to5:'الأيام2–5',later_days:'الأيام التالية',amoxicillin:'مكوّن الأموكسيسيلين',clavulanate:'مكوّن الكلافولانات',routine_derived_mg_24h:'المجموع اليومي المشتق من النظام — ليس سقفًا عالميًا',regimen_derived_mg_24h:'المجموع اليومي المشتق — ليس سقفًا عالميًا',not_systemic_maximum:'ليس حدًا دوائيًا جهازيًا',not_global_maximum:'ليس سقفًا عامًا',no_mg_conversion:'لا تحويل إلىmg',mg_per_rinse:'mg في المضمضة',rinse_seconds:'ثواني المضمضة',brushing_seconds:'ثواني التفريش',timing:'التوقيت',max_unsupervised_days:'أقصى أيام دون إشراف',gingivitis:'التهاب اللثة',other_indications:'استطبابات أخرى',schedule:'الجدول',limits:'حدود المرجع والمجاميع',duration:'المدة والمراجعة'
};
function ReferenceFacts({value}:{value:unknown}) {
 if(value===null||value===undefined)return <span className="text-amber-900">غير محدد هنا — يحتاج قرارًا موثقًا، لا قيمة افتراضية</span>;
 if(typeof value==='boolean')return <span>{value?'نعم':'لا'}</span>;
 if(Array.isArray(value))return <bdi dir="ltr">{value.join(' – ')}</bdi>;
 if(typeof value==='object')return <dl className="my-1 space-y-1 border-s-2 ps-3">{Object.entries(value).map(([key,item])=><div key={key}><dt className="font-medium">{factLabels[key]??key.replaceAll('_',' ')}</dt><dd><ReferenceFacts value={item}/></dd></div>)}</dl>;
 return <bdi>{String(value)}</bdi>;
}
type Props={onSelect:(item:RxItem)=>void;disabled?:boolean};
export function PrescriptionDoseProfiles(props:Props) {
 const {session,ready}=useSessionActions();
 const owner=ready&&session?JSON.stringify([session.username,session.role,session.permissions]):'unavailable';
 return <DoseProfileChooser key={owner} {...props} disabled={props.disabled||owner==='unavailable'}/>;
}
function DoseProfileChooser({onSelect,disabled=false}:Props) {
 const [profileId,setProfileId]=useState('');
 const reference=DOSE_REFERENCES.find(p=>p.id===profileId);
 return <details className="rounded-xl border border-sky-200 p-3 text-sm" data-dose-profile-review="source-specific"><summary className="cursor-pointer font-bold">الجرعات والتعليمات حسب الاستطباب والمرجع — مراجعة الطبيب</summary>
 <p className="my-2">اختر النظام بنفسك. لا اختيار مضاد تلقائي، ولا خلط مدة أو سقف من مرجع آخر. ستة محولات عددية للمراجعة فقط؛ بقية الملفات تعرض مرجعها ونقص التحويل صراحة.</p>
 <label>الملف المرجعي<select aria-label="الملف المرجعي للجرعة" value={profileId} onChange={e=>setProfileId(e.target.value)} className="m-2 max-w-full rounded border p-2"><option value="">اختر الاستطباب والنظام</option>{DOSE_REFERENCES.map(p=><option key={p.id} value={p.id}>{p.generic_name} — {p.id} — {p.indication_reference}</option>)}</select></label>
 {reference&&<section key={reference.id} className="space-y-2"><p>{reference.population_reference}</p><p>{reference.indication_reference}</p><p>{reference.notes}</p><dl><dt>أساس الجرعة</dt><dd dir="ltr">{reference.dose_basis}</dd><dt>الجرعة المرجعية — ليست اختيارًا تلقائيًا</dt><dd><ReferenceFacts value={reference.reference_dose}/></dd><dt>الجدول والحدود والمدة</dt><dd><ReferenceFacts value={{schedule:reference.reference_schedule,limits:reference.reference_limits,duration:reference.duration_reference}}/></dd></dl>
 <ul>{reference.warning_ids.map(id=><li key={id} className="text-amber-900">{DOSE_REFERENCE_WARNINGS[id as keyof typeof DOSE_REFERENCE_WARNINGS]?.text_ar}</li>)}</ul>
 <ul>{reference.source_ids.map(id=>{const source=DOSE_REFERENCE_SOURCES.find(s=>s.id===id);return source?<li key={id}><a href={source.url} target="_blank" rel="noreferrer" className="underline">{source.title}</a> — {source.version}</li>:null;})}</ul>
 {doseCalculationRule(reference.id)?<DoseProfileForm key={reference.id} profileId={reference.id} onSelect={onSelect} disabled={disabled}/>:<p role="status" className="rounded bg-amber-50 p-2">{doseProfileCalculationBlocker(reference.id)}</p>}
 </section>}
 </details>;
}
const numeric=(value:string)=>value.trim()===''?NaN:Number(value);
export function DoseProfileForm({profileId,onSelect,disabled=false}:Props&{profileId:string}) {
 const rule=doseCalculationRule(profileId)!;
 const active=useRef(false),disabledNow=useRef(disabled),sent=useRef(false),intent=useRef(0);
 const [renderedIntent,setRenderedIntent]=useState(0);
 useLayoutEffect(()=>{active.current=true;disabledNow.current=disabled;return()=>{active.current=false;};},[disabled]);
 const [fields,setFields]=useState<Record<string,string>>({}),[checks,setChecks]=useState<Record<string,boolean>>({}),[confirmed,setConfirmed]=useState<string|null>(null),[added,setAdded]=useState(false);
 const update=useCallback((key:string,value:string)=>{intent.current++;setRenderedIntent(intent.current);setFields(previous=>({...previous,[key]:value}));setConfirmed(null);sent.current=false;setAdded(false);},[setAdded,setConfirmed]);
 const tick=useCallback((key:string,value:boolean)=>{intent.current++;setRenderedIntent(intent.current);setChecks(previous=>({...previous,[key]:value}));setConfirmed(null);sent.current=false;setAdded(false);},[setAdded,setConfirmed]);
 const raw={profileId,referenceVersion:DOSE_REFERENCE_VERSION,indication:fields.indication??'',ageMonths:numeric(fields.ageMonths??''),ageVerified:checks.ageVerified??false,weightKg:numeric(fields.weightKg??''),currentWeightVerified:checks.weightVerified??false,selectedDose:numeric(fields.selectedDose??''),administrationsPer24h:numeric(fields.administrations??''),scheduleKind:rule.scheduleKind,intervalHours:numeric(fields.interval??''),durationDays:numeric(fields.duration??''),reviewPlan:fields.reviewPlan??'',product:{name:fields.productName??'',ingredientId:fields.ingredientId??'',formulation:'single-ingredient',labelUrl:fields.labelUrl??'',kind:fields.kind??'',strengthMg:numeric(fields.strength??''),...(fields.kind==='oral-liquid'?{perMl:numeric(fields.perMl??''),measurementIncrementMl:numeric(fields.increment??'')}:{}),minimumAgeMonths:numeric(fields.productMinAge??''),labelVerified:checks.labelVerified??false,...(rule.requiresProductSchedule?{minimumIntervalHours:numeric(fields.labelInterval??''),maxAdministrationsPer24h:numeric(fields.labelCount??'')}:{}),...(fields.singleMax?.trim()?{singleMaxMg:numeric(fields.singleMax)}:{})},otherSameIngredientMg24h:numeric(fields.otherMg??''),specialPopulationOrInteraction:!(checks.noSpecialPopulation??false),antibioticIndicationReviewed:checks.antibioticReviewed??false};
 const input=(rule.requiresProductSchedule?parseDoseReviewInputV2:parseDoseReviewInput)(raw),review=input?reviewMedicationDose(input):null;
 const provenance=input&&review?.ok?createCalculatedDoseProvenance(input):null;
 const preview=provenance?calculatedDoseFields(provenance):null;
 const textField=(key:string,label:string,type='text')=><label key={key} className="grid gap-1">{label}<input aria-label={label} type={type} step={type==='number'?'any':undefined} value={fields[key]??''} onChange={e=>update(key,e.target.value)} className="rounded border p-2"/></label>;
 const checkbox=(key:string,label:string)=><label key={key} className="block"><input type="checkbox" checked={checks[key]??false} onChange={e=>tick(key,e.target.checked)}/> {label}</label>;
 return <div className="space-y-3 rounded border p-3" data-dose-form={profileId}>
 <p>{rule.scopeNote}</p><p>نوع الجدول: <bdi>{rule.scheduleKind}</bdi>. {rule.scheduleKind==='prn-max'?'عدد الجرعات حد أقصى عند الحاجة، وليس مواعيد إلزامية.':'لا تغير نوع الجدول داخل النظام.'}</p>
 <div className="grid gap-3 sm:grid-cols-2">{textField('indication','الاستطباب المراجع')}{textField('ageMonths','العمر بأشهر مكتملة من تاريخ الميلاد','number')}{textField('weightKg','الوزن الحالي kg','number')}{textField('selectedDose',`المقدار المختار ${rule.basis}`,'number')}{textField('administrations',rule.scheduleKind==='prn-max'?'أقصى عدد جرعات عند الحاجة خلال24ساعة':'عدد الجرعات خلال24ساعة','number')}{textField('interval','الفاصل الأدنى بالساعات','number')}{textField('duration','المدة المختارة بالأيام','number')}{textField('reviewPlan','خطة المراجعة والإيقاف')}{textField('productName','اسم المستحضر الفعلي')}
 <label>مادة المنتج<select aria-label="مادة المنتج" value={fields.ingredientId??''} onChange={e=>update('ingredientId',e.target.value)} className="m-2 rounded border p-2"><option value="">تحقق من المادة المفردة</option><option value="paracetamol">Paracetamol</option><option value="amoxicillin">Amoxicillin</option><option value="ibuprofen">Ibuprofen</option></select></label>
 <label>الشكل والطريق<select aria-label="الشكل والطريق" value={fields.kind??''} onChange={e=>update('kind',e.target.value)} className="m-2 rounded border p-2"><option value="">اختر المنتج</option><option value="oral-liquid">معلق فموي mg/mL</option><option value="tablet">قرص فموي mg/tablet</option></select></label>
 {textField('strength','قوة المنتج mg','number')}{fields.kind==='oral-liquid'&&textField('perMl','حجم المقام mL بعد التحضير','number')}{fields.kind==='oral-liquid'&&textField('increment','تدريج أداة القياس mL','number')}{textField('labelUrl','رابط نشرة المستحضر HTTPS','url')}{textField('productMinAge','أدنى عمر للمنتج بالأشهر وفق النشرة','number')}{rule.requiresProductSchedule&&textField('labelInterval','أقل فاصل بالساعات من نشرة المنتج','number')}{rule.requiresProductSchedule&&textField('labelCount','أقصى عدد جرعات خلال24ساعة من نشرة المنتج','number')}{textField('singleMax',rule.requiresLabelSingleMax?'حد الجرعة المفردة mg من النشرة — مطلوب':'حد مفرد إضافي mg من النشرة إن وجد','number')}{textField('otherMg','المادة نفسها من جميع المصادر الأخرى mg/24h — اكتب0 بعد التحقق','number')}
 </div>
 {checkbox('ageVerified','تحققت من العمر الدقيق؛ لم أستنتجه من سنة الميلاد فقط')}{checkbox('weightVerified','تحققت من الوزن الحالي لهذا المريض')}{checkbox('labelVerified','راجعت المادة والشكل والقوة وعمر المنتج وأداة القياس من النشرة الفعلية')}{checkbox('noSpecialPopulation','راجعت الحساسية والتداخلات والحالات الخاصة؛ لا تحتاج الحالة تعديلًا خارج هذا الملف')}{rule.antibiotic&&checkbox('antibioticReviewed','قررت استطباب المضاد ومعالجة السبب؛ لا مضاد تلقائي للألم أو الخلع')}
 {!review&&<p role="status">أكمل المدخلات الصريحة؛ لا جرعة أو تركيز أو مدة افتراضية.</p>}{review&&!review.ok&&<ul role="alert">{review.problems.map(problem=><li key={problem}>{problem}</li>)}</ul>}
 {review?.ok&&preview&&<div className="rounded bg-sky-50 p-3"><p dir="ltr">{review.formula}</p><p dir="ltr">{preview.amount} · {review.mgPer24h} mg/24h including other sources</p><p dir="ltr">{preview.frequency} · {preview.duration}</p><p>{preview.instructions}</p><p>تحقق حسابي ضمن الملف، وليس شهادة ملاءمة سريرية. لا تقريب تلقائي. التعديل اليدوي لاحقًا يزيل وصف «محسوب» ويتطلب تأكيدًا جديدًا.</p><label><input type="checkbox" checked={confirmed===review.fingerprint} onChange={e=>{if(active.current&&renderedIntent===intent.current)setConfirmed(e.target.checked?review.fingerprint:null);}}/> راجعت هذه المدخلات والنتيجة والتعليمات لهذا المريض</label></div>}
 <button type="button" disabled={disabled||added||!review?.ok||confirmed!==review.fingerprint} onClick={()=>{if(!active.current||disabledNow.current||sent.current||renderedIntent!==intent.current||!input||!review?.ok||confirmed!==review.fingerprint||!provenance||!preview)return;sent.current=true;setAdded(true);const {amount,...fields}=preview;onSelect({...fields,selection:{id:rule.medicationId,amount,confirmed:false,doseReview:provenance}});}} className="rounded border px-3 py-2 disabled:opacity-50">{added?'نُقلت للمسودة — راجع السطر قبل الإصدار':'نقل الجرعة والتعليمات إلى مسودة غير مؤكدة'}</button>
 </div>;
}
