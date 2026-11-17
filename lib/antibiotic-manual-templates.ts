import { DOSE_REFERENCE_VERSION } from './medication-dose-profiles';
import type { RxItem } from './prescription';
export const ANTIBIOTIC_MANUAL_REGIMENS = {
 'amoxicillin-sdcep':{id:'amoxicillin',name:'Amoxicillin',strengthMg:500,form:'Oral capsule',amount:'1 capsule (500 mg)',frequency:'Three times daily',regimenMg24h:1500},
 'penicillin-v-sdcep':{id:'penicillin-v',name:'Phenoxymethylpenicillin',strengthMg:250,form:'Oral tablet',amount:'2 tablets (500 mg)',frequency:'Four times daily',regimenMg24h:2000},
 'metronidazole-sdcep':{id:'metronidazole',name:'Metronidazole',strengthMg:400,form:'Oral tablet',amount:'1 tablet (400 mg)',frequency:'Three times daily',regimenMg24h:1200},
} as const;
export type AntibioticManualProfile=keyof typeof ANTIBIOTIC_MANUAL_REGIMENS;
export function isAntibioticManualProfile(id:string):id is AntibioticManualProfile{return Object.hasOwn(ANTIBIOTIC_MANUAL_REGIMENS,id);}
export interface AntibioticManualInput {
 profileId:AntibioticManualProfile;referenceVersion:string;ageMonths:number;weightKg:number;
 ageWeightVerified:boolean;noLowWeightOrNutritionConcern:boolean;indication:'spreading-or-systemic-abscess'|'';
 productName:string;strengthMg:number;form:string;durationDays:number;reviewWithinDays:number;reviewPlan:string;
 actualProductAndLimitsMatched:boolean;sourceControlArranged:boolean;noEmergencyOrSevereInfection:boolean;
 allergyPathReviewed:boolean;noUnresolvedConditionOrInteraction:boolean;patientInstructionsReviewed:boolean;
 antibioticChoiceReviewed:boolean;
}
export type AntibioticManualResult={ok:false;problems:string[]}|{ok:true;item:RxItem;fingerprint:string};
// eslint-disable-next-line no-control-regex -- Reject unsafe control characters in clinician text.
const text=(v:unknown,max:number)=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(v);
/** Manual source-specific adult text transfer. No calculator, local product approval,
 * antibiotic selection, escalation, pediatric extrapolation or prophylaxis. Inputs
 * are clinician attestations, not a persisted product-label evidence record. */
export function prepareAntibioticManualDraft(input:AntibioticManualInput):AntibioticManualResult {
 const problems:string[]=[];
 if(!isAntibioticManualProfile(input.profileId))return {ok:false,problems:['لا يوجد قالب يدوي لهذا النظام.']};
 const regimen=ANTIBIOTIC_MANUAL_REGIMENS[input.profileId];
 if(input.referenceVersion!==DOSE_REFERENCE_VERSION)problems.push('تغير إصدار المرجع؛ أعد المراجعة.');
 if(!Number.isInteger(input.ageMonths)||input.ageMonths<216||input.ageMonths>1440||!Number.isFinite(input.weightKg)||input.weightKg<=0||input.weightKg>300||input.ageWeightVerified!==true)problems.push('تحقق من عمر بالغ ووزن حالي؛ لا نقل للأطفال أو استنتاج من سنة الميلاد.');
 if(input.noLowWeightOrNutritionConcern!==true)problems.push('نقص الوزن أو سوء التغذية أو غموض ملاءمة جرعة البالغ يحتاج مراجعة فردية خارج هذا النقل الثابت؛ لا حد وزن مخترع.');
 if(input.profileId==='amoxicillin-sdcep'&&input.weightKg<40)problems.push('هذا المسار الثابت للأموكسيسيلين لا يشمل وزنًا أقل من40kg؛ يلزم تقييم منفصل.');
 if(input.indication!=='spreading-or-systemic-abscess')problems.push('هذا المسار لخراج سني مع انتشار أو علامات جهازية يقيّمه الطبيب؛ ليس لكل ألم أو خلع أو وقاية.');
 if(input.sourceControlArranged!==true||input.noEmergencyOrSevereInfection!==true)problems.push('يلزم علاج السبب/التصريف وخطة المراجعة؛ الحالات الشديدة أو علامات الخطر خارج هذا القالب وتحتاج تقييم الإحالة.');
 if(!text(input.productName,100)||input.strengthMg!==regimen.strengthMg||input.form!==regimen.form||input.actualProductAndLimitsMatched!==true)problems.push('طابق المنتج الفعلي والمادة المفردة والقوة والطريق وحدود العمر والوزن والجرعة والمدة؛ لا افتراض لترخيص محلي أو بديل مكافئ.');
 if(input.allergyPathReviewed!==true||input.noUnresolvedConditionOrInteraction!==true||input.antibioticChoiceReviewed!==true)problems.push('راجع مسار الحساسية وسبب اختيار المضاد والكلى والكبد والحمل والرضاعة والتداخلات؛ أي قرار غير محسوم يبقى يدويًا خارج القالب.');
 if(!Number.isInteger(input.durationDays)||input.durationDays<3||input.durationDays>5||!Number.isInteger(input.reviewWithinDays)||input.reviewWithinDays<1||input.reviewWithinDays>3||!text(input.reviewPlan,120)||input.patientInstructionsReviewed!==true)problems.push('حدد3–5 أيام مع مراجعة خلال3 أيام وخطة صريحة وإرشادات الإيقاف والسلامة؛ لا مدة تلقائية.');
 if(problems.length)return {ok:false,problems};
 const foodAr=input.profileId==='penicillin-v-sdcep'?' يؤخذ قبل الطعام بـ30 دقيقة أو بعده بساعتين.':'';
 const foodEn=input.profileId==='penicillin-v-sdcep'?' Take 30 minutes before or 2 hours after food.':'';
 const metroAr=input.profileId==='metronidazole-sdcep'?' تجنب الكحول أثناء العلاج ولمدة48 ساعة على الأقل بعد آخر جرعة، أو أطول إن نصت النشرة أو الطبيب.':'';
 const metroEn=input.profileId==='metronidazole-sdcep'?' Avoid alcohol during treatment and for at least 48 hours after the final dose; follow a longer period if required by the product leaflet or clinician.':'';
 const instructions=`لعلاج الخراج السني مع انتشار أو علامات جهازية. وزع الجرعات بالتساوي خلال اليوم.${foodAr}${metroAr} المراجعة خلال${input.reviewWithinDays} أيام: ${input.reviewPlan.trim()}. اتبع قرار الطبيب في الموعد المحدد بشأن إيقاف الكورس أو إكماله بعد تقييم العدوى؛ لا تغيره بنفسك. تواصل عند عدم التحسن أو التفاقم. أوقف الدواء واطلب إسعافًا عند تورم الشفتين أو اللسان أو الحلق أو صعوبة التنفس بعد الدواء. اطلب إسعافًا طبيًا فورًا عند صعوبة التنفس أو البلع، تورم قاع الفم، انتشار سريع للتورم، صعوبة شديدة في فتح الفم أو علامات إنتان.`;
 const instructionsEn=`For dental abscess with spreading infection or systemic involvement. Space doses evenly throughout the day.${foodEn}${metroEn} Review within ${input.reviewWithinDays} days: ${input.reviewPlan.trim()}. At the scheduled review, follow the clinician’s advice about stopping or completing the course after assessment of the infection; do not change it yourself. Seek advice for no improvement or worsening. Stop the medicine and get emergency help for swelling of the lips, tongue or throat or breathing difficulty after taking it. Seek emergency medical help immediately for breathing or swallowing difficulty, floor-of-mouth swelling, rapidly spreading swelling, severe difficulty opening the mouth, or signs of sepsis.`;
 const item:RxItem={name:`${regimen.name} (${input.productName.trim()})`,dose:`${regimen.strengthMg} mg`,form:regimen.form,frequency:regimen.frequency,duration:`${input.durationDays} days; review within ${input.reviewWithinDays} days`,instructions,instructionsEn,selection:{id:regimen.id,amount:regimen.amount,confirmed:false,doseReview:{version:1,mode:'reference-only',profileId:input.profileId,referenceVersion:DOSE_REFERENCE_VERSION}}};
 return {ok:true,item,fingerprint:JSON.stringify(input)};
}
