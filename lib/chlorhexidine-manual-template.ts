import { DOSE_REFERENCE_VERSION } from './medication-dose-profiles';
import type { RxItem } from './prescription';

export interface ChlorhexidineManualInput {
 referenceVersion:string; ageMonths:number; ageVerified:boolean;
 indication:'gingivitis'|''; productName:string;
 concentrationPercent:number; route:'oromucosal-rinse'|'';
 readyToUseProductMatched:boolean; localProductReviewed:boolean;
 noChlorhexidineOrExcipientAllergy:boolean; canRinseAndSpit:boolean;
 hygieneAndWarningsReviewed:boolean; duration:string; reviewPlan:string;
 durationReviewed:boolean;
}
export type ChlorhexidineManualResult={ok:false;problems:string[]}|{ok:true;item:RxItem;fingerprint:string};
// eslint-disable-next-line no-control-regex -- Reject unsafe control characters in clinician text.
const text=(v:unknown,max:number)=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(v);
/** A clinician-selected TEXT template, not a calculator or server dosing authority.
 * Current source-specific numeric adapters and immutable v1/v2 shapes stay unchanged.
 * No product lookup, local registration claim, dosage conversion or default duration. */
export function prepareChlorhexidineManualDraft(input:ChlorhexidineManualInput):ChlorhexidineManualResult {
 const problems:string[]=[];
 if(input.referenceVersion!==DOSE_REFERENCE_VERSION)problems.push('تغير إصدار المرجع؛ أعد المراجعة.');
 if(!Number.isInteger(input.ageMonths)||input.ageMonths<216||input.ageMonths>1440||input.ageVerified!==true)problems.push('هذا القالب للبالغ المتحقق من عمره فقط؛ لا تحويل تلقائي للأطفال.');
 if(input.indication!=='gingivitis')problems.push('اختر التهاب اللثة المراجع؛ لا تُنقل مدة هذا المثال لاستطباب آخر.');
 if(!text(input.productName,120)||input.concentrationPercent!==0.2||input.route!=='oromucosal-rinse'||input.readyToUseProductMatched!==true||input.localProductReviewed!==true)problems.push('تحقق من المنتج الفعلي: غسول فم جاهز0.2% w/v، وليس مطهر جلد أو بديلًا تلقائيًا؛ تحقق من النشرة والمنتج المحلي.');
 if(input.noChlorhexidineOrExcipientAllergy!==true)problems.push('حساسية الكلورهكسيدين أو السواغات تمنع هذا القالب.');
 if(input.canRinseAndSpit!==true)problems.push('تحقق من القدرة على المضمضة والبصق دون بلع.');
 if(input.hygieneAndWarningsReviewed!==true)problems.push('راجع العناية الفموية والتحذيرات والتصبغ والطعم والفصل عن معجون الأسنان.');
 if(!text(input.duration,120)||!text(input.reviewPlan,200)||input.durationReviewed!==true)problems.push('حدد المدة وخطة المراجعة صراحة؛ نحو شهر إرشاد المصدر لالتهاب اللثة وليس مدة تلقائية.');
 if(problems.length)return {ok:false,problems};
 const item:RxItem={name:`Chlorhexidine digluconate (${input.productName.trim()})`,dose:'0.2% w/v',form:'Oromucosal rinse — ready to use',frequency:'Twice daily',duration:input.duration.trim(),
  instructions:`تمضمض بـ10mL لمدة نحو دقيقة ثم ابصق؛ لا تبلع. استخدم معجون الأسنان قبله مع شطف الفم بينهما أو في وقت آخر. أوقفه واستشر المختص عند التهيج؛ اطلب مساعدة عاجلة عند التورم أو صعوبة التنفس. خطة المراجعة: ${input.reviewPlan.trim()}`,
  instructionsEn:`Rinse with 10 mL for about 1 minute, then spit out; do not swallow. After using toothpaste, rinse your mouth before this mouthwash, or use toothpaste at a different time. Stop and seek advice for irritation; seek urgent help for swelling or breathing difficulty. Review: ${input.reviewPlan.trim()}`,
  selection:{id:'chlorhexidine',amount:'10 mL per rinse',confirmed:false,doseReview:{version:1,mode:'reference-only',profileId:'chlorhexidine-02-label',referenceVersion:DOSE_REFERENCE_VERSION}}};
 return {ok:true,item,fingerprint:JSON.stringify([input.referenceVersion,input.ageMonths,input.ageVerified,input.indication,input.productName,input.concentrationPercent,input.route,input.readyToUseProductMatched,input.localProductReviewed,input.noChlorhexidineOrExcipientAllergy,input.canRinseAndSpit,input.hygieneAndWarningsReviewed,input.duration,input.reviewPlan,input.durationReviewed])};
}
