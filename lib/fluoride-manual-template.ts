import {DOSE_REFERENCE_VERSION} from './medication-dose-profiles';
import type {RxItem} from './prescription';
export interface FluorideManualInput {
 referenceVersion:string;ageMonths:number;ageVerified:boolean;productName:string;
 fluoridePpm:number;sodiumFluoridePercent:number;form:'toothpaste'|'';indication:'high-caries-risk'|'';
 duration:string;reviewPlan:string;fluorideSourcePlan:string;productLabelMatched:boolean;canSpitAndSupervisionReviewed:boolean;
 noIngredientOrExcipientContraindication:boolean;totalFluorideAndOtherProductsReviewed:boolean;
 pregnancyLactationAndSpecialConditionsReviewed:boolean;durationAndInstructionsReviewed:boolean;
}
// eslint-disable-next-line no-control-regex -- Keep authored text safe and bounded.
const text=(v:unknown,max:number)=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(v);
export function prepareFluorideManualDraft(i:FluorideManualInput):{ok:false;problems:string[]}|{ok:true;item:RxItem;fingerprint:string}{
 const problems:string[]=[];
 if(i.referenceVersion!==DOSE_REFERENCE_VERSION)problems.push('تغير المرجع؛ أعد المراجعة.');
 if(!Number.isInteger(i.ageMonths)||i.ageMonths<192||i.ageMonths>1440||i.ageVerified!==true)problems.push('هذا المثال من16سنة فأكثر بعمر متحقق؛ لا للأطفال الأصغر.');
 if(i.indication!=='high-caries-risk')problems.push('حدد خطر التسوس المرتفع وحاجة المريض لمعجون عالي الفلوريد بعد تقييم الطبيب.');
 if(!text(i.productName,100)||i.fluoridePpm!==5000||i.sodiumFluoridePercent!==1.1||i.form!=='toothpaste'||i.productLabelMatched!==true)problems.push('طابق المنتج الفعلي: معجون5000ppm فلوريد/1.1% w/w فلوريد صوديوم؛ لا غسول أو معجون2800 أو افتراض ترخيص محلي.');
 if(i.canSpitAndSupervisionReviewed!==true||i.noIngredientOrExcipientContraindication!==true||i.totalFluorideAndOtherProductsReviewed!==true||i.pregnancyLactationAndSpecialConditionsReviewed!==true)problems.push('يلزم تقييم القدرة على البصق والإشراف والحساسية والسواغات وجميع مصادر الفلوريد والحمل/الرضاعة؛ لا نقل مع قرار غير محسوم.');
 if(!text(i.duration,100)||!text(i.reviewPlan,150)||!text(i.fluorideSourcePlan,200)||i.durationAndInstructionsReviewed!==true)problems.push('اختر المدة وخطة المتابعة والتعليمات صراحة؛ لا مدة وقائية افتراضية.');
 if(problems.length)return {ok:false,problems};
 const item:RxItem={name:`Sodium fluoride (${i.productName.trim()})`,dose:'5000 ppm fluoride (1.1% w/w sodium fluoride)',form:'Toothpaste — dental use only',frequency:'Three times daily after meals',duration:i.duration.trim(),instructions:`ضع شريطًا بطول2cm على الفرشاة ونظف الأسنان نحو3 دقائق بعد الطعام ثلاث مرات يوميًا، ثم ابصق ولا تبلع. لا تشارك هذا المعجون الموصوف. احفظه بعيدًا عن نظر ومتناول الأطفال. عند ابتلاع كمية كبيرة أو الاشتباه بتسمم، بما في ذلك ابتلاع طفل للمعجون، اطلب مشورة طبية فورًا دون انتظار الأعراض وخذ العبوة أو النشرة معك؛ لا تحاول إحداث القيء. اتبع خطة الطبيب لجميع مصادر الفلوريد الحالية والجديدة بما فيها الماء والملح والمستحضرات الأخرى؛ لا تجمعها من نفسك. الإجراءات المحددة لمصادر الفلوريد: ${i.fluorideSourcePlan.trim()}. اتبع تعليمات المنتج. المتابعة: ${i.reviewPlan.trim()}.`,instructionsEn:`Apply a 2 cm ribbon to the toothbrush and brush for about 3 minutes after meals three times daily, then spit out; do not swallow. Do not share this prescribed toothpaste. Keep out of the sight and reach of children. If a large amount is swallowed or poisoning is suspected, including a child swallowing the toothpaste, seek medical advice immediately without waiting for symptoms and take the pack or leaflet with you; do not try to induce vomiting. Follow the clinician’s plan for all existing and new fluoride sources, including water, salt and other products; do not combine them yourself. Specific fluoride-source actions: ${i.fluorideSourcePlan.trim()}. Follow the product instructions. Follow-up: ${i.reviewPlan.trim()}.`,selection:{id:'sodium-fluoride',amount:'2 cm ribbon per brushing',confirmed:false,doseReview:{version:1,mode:'reference-only',profileId:'fluoride-toothpaste5000',referenceVersion:DOSE_REFERENCE_VERSION}}};
 return {ok:true,item,fingerprint:JSON.stringify(i)};
}
