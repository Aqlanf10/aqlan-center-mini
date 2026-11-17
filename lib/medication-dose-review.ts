import { doseCalculationRule, doseReference, DOSE_REFERENCE_VERSION } from './medication-dose-profiles';

export interface DoseReviewInput {
  profileId: string;
  referenceVersion: string;
  indication: string;
  /** Completed months from verified date of birth, never birthYear alone. */
  ageMonths: number;
  ageVerified: boolean;
  weightKg: number;
  currentWeightVerified: boolean;
  selectedDose: number;
  administrationsPer24h: number;
  scheduleKind: 'times-per-day' | 'prn-max' | 'fixed-interval';
  intervalHours: number;
  durationDays: number;
  reviewPlan: string;
  /** Exact product label; no concentration or age limit is inferred from a name. */
  product: { name: string; ingredientId: 'paracetamol' | 'amoxicillin'; formulation: 'single-ingredient'; labelUrl: string; kind: 'oral-liquid' | 'tablet'; strengthMg: number; perMl?: number; measurementIncrementMl?: number; minimumAgeMonths: number; labelVerified: boolean; singleMaxMg?: number };
  otherSameIngredientMg24h: number;
  specialPopulationOrInteraction: boolean;
  antibioticIndicationReviewed: boolean;
}
export interface DoseReviewInputV2 extends Omit<DoseReviewInput,'product'> {
 product: Omit<DoseReviewInput['product'],'ingredientId'> & {
  ingredientId:'paracetamol'|'amoxicillin'|'ibuprofen';
  minimumIntervalHours:number;
  maxAdministrationsPer24h:number;
 };
}
export type AnyDoseReviewInput=DoseReviewInput|DoseReviewInputV2;
export type DoseReviewResult = { ok:false; problems:string[] } | { ok:true; mgPerDose:number; mgPer24h:number; mlPerDose:number|null; tabletsPerDose:number|null; formula:string; fingerprint:string; referenceId:string; referenceVersion:string };
const positive = (value: number) => Number.isFinite(value) && value > 0;
const boundedText = (value: unknown, max: number) => typeof value==='string' && !!value.trim() && value.length<=max;
/** A mathematical preview inside one source regimen, NOT clinical approval.
 * No default values, silent capping/rounding, regimen mixing, or prescription side effects. */
export function reviewMedicationDose(input: AnyDoseReviewInput): DoseReviewResult {
  const rule=doseCalculationRule(input.profileId,input.ageMonths), reference=doseReference(input.profileId);
  const problems:string[]=[];
  if(!rule || !reference) return {ok:false,problems:['لا يوجد محول عددي مراجع لهذا الملف.']};
  if(input.referenceVersion!==DOSE_REFERENCE_VERSION) problems.push('تغير إصدار المرجع؛ أعد المراجعة.');
  if(!boundedText(input.indication,500)||!boundedText(input.reviewPlan,500)) problems.push('وثّق الاستطباب وخطة المراجعة.');
  if(!Number.isInteger(input.ageMonths)||input.ageVerified!==true||!positive(input.ageMonths)||input.ageMonths>1440 || (rule.ageMonths.minExclusive ? input.ageMonths<=rule.ageMonths.min : input.ageMonths<rule.ageMonths.min) || (rule.ageMonths.maxExclusive!==undefined && input.ageMonths>=rule.ageMonths.maxExclusive)) problems.push('العمر خارج نطاق هذا الملف أو غير موثق بدقة.');
  if(rule.weightRequired && (!positive(input.weightKg)||input.weightKg>300||input.currentWeightVerified!==true)) problems.push('أدخل وزنًا حاليًا متحققًا؛ لا وزن افتراضي.');
  if(rule.weightBelowKg!==undefined && input.weightKg>=rule.weightBelowKg) problems.push('الوزن خارج النطاق؛ لا تحويل تلقائي إلى نظام البالغ.');
  if(rule.profileId==='paracetamol-adult-sdcep' && input.weightKg<50) problems.push('وزن أقل من50kg يحتاج نظامًا مراجعًا منفصلًا.');
  if(!positive(input.selectedDose)||input.selectedDose<rule.range[0]||input.selectedDose>rule.range[1]) problems.push('اختر مقدارًا داخل نطاق المرجع نفسه.');
  if(input.scheduleKind!==rule.scheduleKind) problems.push('نوع الجدول لا يطابق الملف؛ حدPRN ليس جرعات مجدولة.');
  if(!Number.isInteger(input.administrationsPer24h)||!rule.administrations.includes(input.administrationsPer24h)) problems.push('عدد الجرعات لا يطابق النظام.');
  if(!positive(input.intervalHours)||input.intervalHours<rule.minimumIntervalHours||input.intervalHours>24||(rule.maximumIntervalHours!==undefined&&input.intervalHours>rule.maximumIntervalHours)||input.administrationsPer24h*input.intervalHours>24) problems.push('الفاصل وعدد الجرعات غير متوافقين.');
  if(rule.scheduleKind==='fixed-interval' && input.administrationsPer24h*input.intervalHours!==24) problems.push('الجدول الثابت لا يغطي24ساعة بصورة متسقة.');
  if(rule.basis==='mg/kg/day' && input.intervalHours!==rule.minimumIntervalHours) problems.push('لا تغير فاصل النظام اليومي المختار.');
  if(!Number.isInteger(input.durationDays)||input.durationDays<1||input.durationDays>30) problems.push('اختر مدة صريحة ومراجعة؛ النطاق1–30 حد إدخال لا توصية طبية.');
  if(rule.sourceDurationDays!==undefined && input.durationDays!==rule.sourceDurationDays) problems.push('مدة مثال هذا المصدر5أيام؛ أي تغيير يُكتب يدويًا خارج ادعاء حساب هذا النظام.');
  const p=input.product;
  if(!p||!boundedText(p.name,160)||!['oral-liquid','tablet'].includes(p.kind)||p.labelVerified!==true||!positive(p.strengthMg)||p.strengthMg>10000||(p.kind==='oral-liquid' && (!positive(p.perMl??NaN)||(p.perMl??0)>1000||!positive(p.measurementIncrementMl??NaN)||(p.measurementIncrementMl??0)>(p.perMl??0)))||!Number.isFinite(p.minimumAgeMonths)||p.minimumAgeMonths<0||input.ageMonths<p.minimumAgeMonths) problems.push('تحقق من المنتج الفعلي وتركيزه بعد التحضير وعمره؛ لا تحويلmg/g أوunits أو نسبة مركب في هذا المحول.');
  if(p?.ingredientId!==rule.medicationId||p?.formulation!=='single-ingredient') problems.push('مادة المستحضر أو تركيبه لا يطابقان الملف؛ لا تبديل مادة أو مركب.');
  try { const url=new URL(p?.labelUrl??''); if(url.protocol!=='https:'||url.username||url.password) throw Error(); } catch { problems.push('يلزم مرجع نشرة المنتج الفعلي للتحقق من المادة والقوة.'); }
  if(rule.profileId==='paracetamol-adult-sdcep' && (p?.kind!=='tablet'||p.strengthMg!==500)) problems.push('هذا مثال أقراص500mg؛ لا استبدال الشكل أو التركيز داخل الملف.');
  if(rule.medicationId==='amoxicillin' && p?.kind!=='oral-liquid') problems.push('محول الأطفال الحالي للمعلق الفموي بتركيز متحقق فقط.');
  if(rule.requiresProductSchedule || (p && 'minimumIntervalHours' in p)) {
    if(!p||!('minimumIntervalHours' in p)||!positive(Number(p.minimumIntervalHours))||Number(p.minimumIntervalHours)>24||input.intervalHours<Number(p.minimumIntervalHours)) problems.push('الفاصل الأدنى الموثق من نشرة المنتج مفقود أو متجاوز.');
    if(!p||!('maxAdministrationsPer24h' in p)||!Number.isInteger(p.maxAdministrationsPer24h)||Number(p.maxAdministrationsPer24h)<1||Number(p.maxAdministrationsPer24h)>24||input.administrationsPer24h>Number(p.maxAdministrationsPer24h)) problems.push('عدد الجرعات يتجاوز حد نشرة المنتج أو لم يوثق.');
  }
  if(rule.profileId==='ibuprofen-adult-sdcep'&&(p?.kind!=='tablet'||p.strengthMg!==400)) problems.push('مثال البالغ الحالي لأقراص400mg فقط.');
  if(rule.medicationId==='ibuprofen'&&input.otherSameIngredientMg24h!==0) problems.push('مصدر إيبوبروفين آخر يتطلب مراجعة موحدة خارج هذا المثال.');
  if(rule.requiresLabelSingleMax && (!positive(p?.singleMaxMg ?? NaN))) problems.push('حد الجرعة المفردة من نشرة المنتج مفقود؛ لا يُستنتج.');
  if(!Number.isFinite(input.otherSameIngredientMg24h)||input.otherSameIngredientMg24h<0) problems.push('كمية المادة نفسها من مصادر أخرى مجهولة؛ لا تعاملها كصفر.');
  if(input.specialPopulationOrInteraction!==false) problems.push('حالة خاصة أو تداخل يحتاج مراجعة خارج هذا المحول؛ لا تعديل تلقائي.');
  if(rule.antibiotic && input.antibioticIndicationReviewed!==true) problems.push('المضاد يتطلب قرار استطباب ومراجعة الطبيب؛ ليس علاجًا تلقائيًا للألم.');
  if(problems.length) return {ok:false,problems};
  const mgPerDose=rule.basis==='mg/dose'?input.selectedDose:input.selectedDose*input.weightKg/(rule.basis==='mg/kg/day'?input.administrationsPer24h:1);
  const mgPer24h=mgPerDose*input.administrationsPer24h+input.otherSameIngredientMg24h;
  const singleLimits=[rule.singleMaxMg,p.singleMaxMg].filter((x):x is number=>x!==undefined);
  if(singleLimits.some(limit=>!positive(limit)||mgPerDose>limit)) problems.push('تجاوز حد الجرعة المفردة؛ لا تخفيض صامت.');
  if(rule.dailyMaxMg!==undefined && mgPer24h>rule.dailyMaxMg) problems.push('تجاوز الحد اليومي المطلق.');
  if(rule.dailyMaxMgPerKg!==undefined && mgPer24h>rule.dailyMaxMgPerKg*input.weightKg) problems.push('تجاوز الحد اليومي بحسب الوزن.');
  if(rule.antibiotic && input.otherSameIngredientMg24h!==0) problems.push('يوجد مصدر آخر للمادة؛ يلزم توحيد النظام يدويًا.');
  const mlPerDose=p.kind==='oral-liquid'?mgPerDose*p.perMl!/p.strengthMg:null;
  const measurementTicks=mlPerDose===null?null:mlPerDose/p.measurementIncrementMl!;
  if(measurementTicks!==null&&(!positive(measurementTicks)||!Number.isSafeInteger(Math.round(measurementTicks))||Math.round(measurementTicks)<1||Math.abs(measurementTicks-Math.round(measurementTicks))>1e-8)) problems.push('الحجم لا يطابق تدريج أداة القياس؛ لا تقريب تلقائي للجرعة.');
  const tabletsPerDose=p.kind==='tablet'?mgPerDose/p.strengthMg:null;
  if(tabletsPerDose!==null && !Number.isInteger(tabletsPerDose)) problems.push('تقسيم القرص غير مدعوم دون منتج وأداة موثقين؛ لا تقريب تلقائي.');
  if(!positive(mgPerDose)||!positive(mgPer24h)||(mlPerDose!==null&&!positive(mlPerDose))) problems.push('نتيجة غير صالحة.');
  if(problems.length) return {ok:false,problems};
  // Stable full input binding, not an authority token. Server-side issuer must still
  // enforce clinical confirmation and permissions. No rounded dose is returned.
  const fingerprint=JSON.stringify([DOSE_REFERENCE_VERSION,input.profileId,input.indication,input.ageMonths,input.ageVerified,input.weightKg,input.currentWeightVerified,input.selectedDose,input.administrationsPer24h,input.scheduleKind,input.intervalHours,input.durationDays,input.reviewPlan,p.name,p.ingredientId,p.formulation,p.labelUrl,p.kind,p.strengthMg,p.perMl??null,p.measurementIncrementMl??null,p.minimumAgeMonths,p.labelVerified,p.singleMaxMg??null,input.otherSameIngredientMg24h,input.specialPopulationOrInteraction,input.antibioticIndicationReviewed,...('minimumIntervalHours' in p?[p.minimumIntervalHours,p.maxAdministrationsPer24h]:[])]);
  return {ok:true,mgPerDose,mgPer24h,mlPerDose,tabletsPerDose,formula:rule.basis==='mg/kg/day'?`${input.selectedDose} mg/kg/day × ${input.weightKg} kg ÷ ${input.administrationsPer24h} = ${mgPerDose} mg/dose`:rule.basis==='mg/kg/dose'?`${input.selectedDose} mg/kg/dose × ${input.weightKg} kg = ${mgPerDose} mg/dose`:`${mgPerDose} mg/dose`,fingerprint,referenceId:input.profileId,referenceVersion:DOSE_REFERENCE_VERSION};
}

const inputKeys=['profileId','referenceVersion','indication','ageMonths','ageVerified','weightKg','currentWeightVerified','selectedDose','administrationsPer24h','scheduleKind','intervalHours','durationDays','reviewPlan','product','otherSameIngredientMg24h','specialPopulationOrInteraction','antibioticIndicationReviewed'];
const productKeys=['name','ingredientId','formulation','labelUrl','kind','strengthMg','perMl','measurementIncrementMl','minimumAgeMonths','labelVerified','singleMaxMg'];
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** Immutable v1 transport shape: do not narrow this parser when clinical rules
 * change. New schema requires a new version/parser; saved v1 history must survive.
 * Current semantics belong only in reviewMedicationDose, never this shape parser. */
export function parseDoseReviewInput(value:unknown):DoseReviewInput|null {
  if(!object(value)||Object.keys(value).some(k=>!inputKeys.includes(k))||inputKeys.some(k=>!(k in value))||!object(value.product))return null;
  const p=value.product;
  if(Object.keys(p).some(k=>!productKeys.includes(k))||['name','ingredientId','formulation','labelUrl','kind','strengthMg','minimumAgeMonths','labelVerified'].some(k=>!(k in p)))return null;
  if(['profileId','referenceVersion','indication','scheduleKind','reviewPlan'].some(k=>typeof value[k]!=='string'||String(value[k]).length>500))return null;
  if(['ageMonths','weightKg','selectedDose','administrationsPer24h','intervalHours','durationDays','otherSameIngredientMg24h'].some(k=>typeof value[k]!=='number'||!Number.isFinite(value[k])))return null;
  if(['ageVerified','currentWeightVerified','specialPopulationOrInteraction','antibioticIndicationReviewed'].some(k=>typeof value[k]!=='boolean')||typeof p.labelVerified!=='boolean')return null;
  if(['name','ingredientId','formulation','labelUrl','kind'].some(k=>typeof p[k]!=='string'||String(p[k]).length>500))return null;
  if(['strengthMg','minimumAgeMonths'].some(k=>typeof p[k]!=='number'||!Number.isFinite(p[k]))||['perMl','measurementIncrementMl','singleMaxMg'].some(k=>k in p&&(typeof p[k]!=='number'||!Number.isFinite(p[k]))))return null;
  if(!['times-per-day','prn-max','fixed-interval'].includes(String(value.scheduleKind))||!['paracetamol','amoxicillin'].includes(String(p.ingredientId))||p.formulation!=='single-ingredient'||!['oral-liquid','tablet'].includes(String(p.kind)))return null;
  // Fixed key order makes both command and acknowledgement stable across transport order.
  const result=Object.fromEntries(inputKeys.map(k=>[k,k==='product'?Object.fromEntries(productKeys.filter(key=>key in p).map(key=>[key,typeof p[key]==='string'?(p[key] as string).trim():p[key]])):typeof value[k]==='string'?(value[k] as string).trim():value[k]])) as unknown as DoseReviewInput;
  if(new TextEncoder().encode(JSON.stringify(result)).length>6000)return null;
  return result;
}

// Immutable v2 shape is separate: never widen or narrow saved v1 parsing.
const productKeysV2=[...productKeys,'minimumIntervalHours','maxAdministrationsPer24h'];
export function parseDoseReviewInputV2(value:unknown):DoseReviewInputV2|null {
  if(!object(value)||Object.keys(value).some(k=>!inputKeys.includes(k))||inputKeys.some(k=>!(k in value))||!object(value.product))return null;
  const p=value.product;
  if(Object.keys(p).some(k=>!productKeysV2.includes(k))||['name','ingredientId','formulation','labelUrl','kind','strengthMg','minimumAgeMonths','labelVerified','minimumIntervalHours','maxAdministrationsPer24h'].some(k=>!(k in p)))return null;
  if(['profileId','referenceVersion','indication','scheduleKind','reviewPlan'].some(k=>typeof value[k]!=='string'||String(value[k]).length>500))return null;
  if(['ageMonths','weightKg','selectedDose','administrationsPer24h','intervalHours','durationDays','otherSameIngredientMg24h'].some(k=>typeof value[k]!=='number'||!Number.isFinite(value[k])))return null;
  if(['ageVerified','currentWeightVerified','specialPopulationOrInteraction','antibioticIndicationReviewed'].some(k=>typeof value[k]!=='boolean')||typeof p.labelVerified!=='boolean')return null;
  if(['name','ingredientId','formulation','labelUrl','kind'].some(k=>typeof p[k]!=='string'||String(p[k]).length>500))return null;
  if(['strengthMg','minimumAgeMonths','minimumIntervalHours','maxAdministrationsPer24h'].some(k=>typeof p[k]!=='number'||!Number.isFinite(p[k]))||['perMl','measurementIncrementMl','singleMaxMg'].some(k=>k in p&&(typeof p[k]!=='number'||!Number.isFinite(p[k]))))return null;
  if(!['times-per-day','prn-max','fixed-interval'].includes(String(value.scheduleKind))||!['paracetamol','amoxicillin','ibuprofen'].includes(String(p.ingredientId))||p.formulation!=='single-ingredient'||!['oral-liquid','tablet'].includes(String(p.kind)))return null;
  // Fixed key order makes both command and acknowledgement stable across transport order.
  const result=Object.fromEntries(inputKeys.map(k=>[k,k==='product'?Object.fromEntries(productKeysV2.filter(key=>key in p).map(key=>[key,typeof p[key]==='string'?(p[key] as string).trim():p[key]])):typeof value[k]==='string'?(value[k] as string).trim():value[k]])) as unknown as DoseReviewInputV2;
  if(new TextEncoder().encode(JSON.stringify(result)).length>6000)return null;
  return result;
}
