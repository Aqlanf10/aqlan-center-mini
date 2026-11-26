import { ClinicalExam, ExamTriState, TriStateStatus } from '../types/ortho';

export interface QuickTriOption {
  valueAr: string;
  valueEn: string;
  status: TriStateStatus;
}

export interface QuickExamOption {
  valueAr: string;
  valueEn: string;
  status: ExamTriState;
}

export interface QuickTextOption {
  ar: string;
  en: string;
}

export type CoreQuestionKey =
  | 'medicalHistory'
  | 'dentalHistory'
  | 'medications'
  | 'allergies'
  | 'previousOrtho'
  | 'oralHabits'
  | 'functionalComplaints';

export type ExtraoralKey = Exclude<keyof ClinicalExam['extraoral'], 'notes'>;
export type IntraoralKey = Exclude<keyof ClinicalExam['intraoral'], 'notes'>;

export const CHIEF_COMPLAINT_PRESETS: QuickTextOption[] = [
  {
    ar: 'ازدحام وتراكب في الأسنان الأمامية',
    en: 'Anterior crowding and crooked teeth',
  },
  {
    ar: 'بروز الأسنان الأمامية العلوية وصعوبة إغلاق الشفتين',
    en: 'Protruded upper front teeth & lip incompetence',
  },
  {
    ar: 'وجود فراغات وتباعد بين الأسنان (فلجة)',
    en: 'Spacing / midline diastema between teeth',
  },
  {
    ar: 'بروز الفك السفلي / عضة معكوسة أمامية',
    en: 'Mandibular prognathism / anterior crossbite',
  },
  {
    ar: 'عضة مفتوحة أمامية وصعوبة في قضم الطعام',
    en: 'Anterior open bite & difficulty incising food',
  },
  {
    ar: 'عضة عميقة وإخفاء الأسنان السفلية',
    en: 'Deep bite / excessive vertical overlap',
  },
  {
    ar: 'تأخر بزوغ أو انطمار الناب / سن أمامي',
    en: 'Delayed eruption / impacted canine or incisor',
  },
  {
    ar: 'عدم تطابق الإطباق أو انحراف خط الوسط / الفك',
    en: 'Malocclusion / dental midline or mandibular shift',
  },
  {
    ar: 'انتكاس بعد علاج تقويمي سابق',
    en: 'Post-orthodontic relapse',
  },
];

export const EXPECTATIONS_PRESETS: QuickTextOption[] = [
  {
    ar: 'اصطفاف جمالي للأسنان وتحسين الابتسامة وتطابق العضة',
    en: 'Aesthetic alignment, improved smile & stable occlusion',
  },
  {
    ar: 'إرجاع البروز الأمامي وتحسين تناسق الشفتين والبروفايل',
    en: 'Reduce protrusion & improve lip posture/profile',
  },
  {
    ar: 'إغلاق الفراغات مع تثبيت طويل الأمد',
    en: 'Close spaces with long-term retention',
  },
  {
    ar: 'تصحيح العضة المعكوسة / المفتوحة بدون جراحة',
    en: 'Non-surgical crossbite / open bite correction',
  },
  {
    ar: 'إنزال السن المنطمر ورصفه في القوس السني',
    en: 'Guided eruption and alignment of impacted tooth',
  },
  {
    ar: 'تحسين المضغ وتخفيف آلام/طقطقة المفصل الفكي',
    en: 'Improve mastication & TMJ comfort',
  },
];

export const REFERRAL_PRESETS: QuickTextOption[] = [
  { ar: 'زيارة مباشرة / مواقع التواصل', en: 'Walk-in / Social Media' },
  { ar: 'توصية مريض سابق / العائلة', en: 'Patient / Family Referral' },
  { ar: 'إحالة من طبيب أسنان عام', en: 'General Dentist Referral' },
  { ar: 'إحالة من أخصائي أطفال / لثة / جراحة', en: 'Pediatric / Perio / OMFS Referral' },
];

export const QUESTIONNAIRE_QUICK_OPTIONS: Record<CoreQuestionKey, QuickTriOption[]> = {
  medicalHistory: [
    { valueAr: 'سليم طبياً — لا أمراض مزمنة', valueEn: 'Healthy — no systemic diseases', status: 'none' },
    { valueAr: 'الربو / حساسية الصدر', valueEn: 'Asthma / respiratory condition', status: 'recorded' },
    { valueAr: 'السكري (منضبط)', valueEn: 'Controlled Diabetes Mellitus', status: 'recorded' },
    { valueAr: 'ارتفاع ضغط الدم', valueEn: 'Hypertension', status: 'recorded' },
    { valueAr: 'اضطراب الغدة الدرقية', valueEn: 'Thyroid disorder', status: 'recorded' },
    { valueAr: 'فقر الدم / أنيميا', valueEn: 'Anemia', status: 'recorded' },
    { valueAr: 'مشكلة قلبية / يتطلب وقاية بمضاد حيوي', valueEn: 'Cardiac condition / antibiotic prophylaxis', status: 'recorded' },
    { valueAr: 'صرع / نوبات تشنج', valueEn: 'Epilepsy / seizures', status: 'recorded' },
    { valueAr: 'اضطراب تخثر الدم / سيولة', valueEn: 'Bleeding / coagulation disorder', status: 'recorded' },
  ],
  dentalHistory: [
    { valueAr: 'متابعة دورية — لا شكاوى سنية حادة', valueEn: 'Routine dental visits — no acute issues', status: 'recorded' },
    { valueAr: 'حشوات سابقة متعددة بحالة مستقرة', valueEn: 'Multiple stable restorations', status: 'recorded' },
    { valueAr: 'معالجة لبية (عصب) سابقة', valueEn: 'Previous endodontic (RCT) treatment', status: 'recorded' },
    { valueAr: 'خلع سابق / فقد مبكر لأسنان لبنية', valueEn: 'Previous extraction / premature primary loss', status: 'recorded' },
    { valueAr: 'إصابة / رض سابق للأسنان الأمامية', valueEn: 'History of anterior dental trauma', status: 'recorded' },
    { valueAr: 'تسوس أو التهاب لثة يحتاج علاجاً قبل التقويم', valueEn: 'Active caries/gingivitis needing pre-ortho care', status: 'recorded' },
    { valueAr: 'أول زيارة سنية — لا علاجات سابقة', valueEn: 'First dental visit — no prior dental work', status: 'none' },
  ],
  medications: [
    { valueAr: 'لا يتناول أي أدوية حالياً', valueEn: 'No current medications', status: 'none' },
    { valueAr: 'مسكنات ألم عند اللزوم فقط', valueEn: 'Occasional analgesics PRN', status: 'recorded' },
    { valueAr: 'بخاخ الربو / موسّع شعب', valueEn: 'Asthma inhaler / bronchodilator', status: 'recorded' },
    { valueAr: 'ثيروكسين (الغدة الدرقية)', valueEn: 'Levothyroxine (Thyroid)', status: 'recorded' },
    { valueAr: 'أدوية السكري / الأنسولين', valueEn: 'Antidiabetic medications / Insulin', status: 'recorded' },
    { valueAr: 'فيتامين د / كالسيوم / مكملات', valueEn: 'Vitamin D / Calcium / Supplements', status: 'recorded' },
    { valueAr: 'أدوية مؤثرة على العظم/الحركة (NSAIDs / Steroids / Bisphosphonates)', valueEn: 'Bone-modulating meds (NSAIDs/Steroids/Bisphosphonates)', status: 'recorded' },
  ],
  allergies: [
    { valueAr: 'لا توجد أي حساسية معروفة', valueEn: 'No known allergies (NKA)', status: 'none' },
    { valueAr: 'حساسية البنسلين / المضادات الحيوية', valueEn: 'Penicillin / Antibiotic allergy', status: 'recorded' },
    { valueAr: 'حساسية النيكل / المعادن (يلزم TMA / خالٍ من النيكل)', valueEn: 'Nickel / Metal allergy (use Ni-free/TMA)', status: 'recorded' },
    { valueAr: 'حساسية اللاتكس (استخدام مطاط وقفازات Non-Latex)', valueEn: 'Latex allergy (non-latex elastics/gloves)', status: 'recorded' },
    { valueAr: 'حساسية المسكنات (NSAIDs) أو التخدير الموضعي', valueEn: 'NSAIDs or local anesthetic allergy', status: 'recorded' },
    { valueAr: 'حساسية موسمية / غذائية', valueEn: 'Seasonal / Food allergy', status: 'recorded' },
  ],
  previousOrtho: [
    { valueAr: 'لا يوجد علاج تقويمي سابق', valueEn: 'No previous orthodontic treatment', status: 'none' },
    { valueAr: 'علاج تقويمي سابق مكتمل مع انتكاس (Relapse)', valueEn: 'Previous completed ortho with relapse', status: 'recorded' },
    { valueAr: 'علاج تقويمي سابق غير مكتمل', valueEn: 'Incomplete previous orthodontic treatment', status: 'recorded' },
    { valueAr: 'موسّع فكي أو جهاز وظيفي مبكر سابقاً', valueEn: 'Prior early expander or functional appliance', status: 'recorded' },
    { valueAr: 'تثبيت سابق / مراجعة مثبت مفكوك أو مكسور', valueEn: 'Previous retention / broken retainer', status: 'recorded' },
  ],
  oralHabits: [
    { valueAr: 'لا توجد عادات فموية ضارة', valueEn: 'No deleterious oral habits', status: 'none' },
    { valueAr: 'تنفس فموي (Mouth Breathing)', valueEn: 'Mouth breathing', status: 'recorded' },
    { valueAr: 'دفع اللسان أثناء البلع (Tongue Thrust)', valueEn: 'Tongue thrusting on swallow', status: 'recorded' },
    { valueAr: 'صرير الأسنان الليلي (Nocturnal Bruxism)', valueEn: 'Nocturnal bruxism / clenching', status: 'recorded' },
    { valueAr: 'مص الإصبع / الإبهام', valueEn: 'Thumb / digit sucking habit', status: 'recorded' },
    { valueAr: 'عض الشفة السفلى / قضم الأظافر أو الأقلام', valueEn: 'Lip biting / nail or pen biting', status: 'recorded' },
    { valueAr: 'تنفس فموي + دفع لسان معاً', valueEn: 'Combined mouth breathing & tongue thrust', status: 'recorded' },
  ],
  functionalComplaints: [
    { valueAr: 'لا توجد شكاوى في المفصل الفكي أو المضغ', valueEn: 'No TMJ or functional complaints', status: 'none' },
    { valueAr: 'طقطقة بالمفصل الفكي بدون ألم (Painless Clicking)', valueEn: 'Painless TMJ clicking', status: 'recorded' },
    { valueAr: 'ألم في المفصل الفكي أو عضلات المضغ', valueEn: 'TMJ or masticatory muscle pain', status: 'recorded' },
    { valueAr: 'انحراف الفك أو تحدد في فتح الفم', valueEn: 'Mandibular deviation or limited opening', status: 'recorded' },
    { valueAr: 'صعوبة في قضم الطعام الأمامي', valueEn: 'Difficulty incising food anteriorly', status: 'recorded' },
    { valueAr: 'صعوبة نطق بعض الحروف (لدغة لسانية)', valueEn: 'Speech articulation difficulty / lisp', status: 'recorded' },
  ],
};

export const EXTRAORAL_QUICK_OPTIONS: Record<ExtraoralKey, QuickExamOption[]> = {
  symmetry: [
    { valueAr: 'وجه متناسق (Symmetrical)', valueEn: 'Symmetrical', status: 'normal' },
    { valueAr: 'انحراف خفيف بالذقن لليمين', valueEn: 'Mild chin deviation to right', status: 'finding' },
    { valueAr: 'انحراف خفيف بالذقن لليسار', valueEn: 'Mild chin deviation to left', status: 'finding' },
    { valueAr: 'عدم تناسق وجهي واضح (Facial Asymmetry)', valueEn: 'Marked facial asymmetry', status: 'finding' },
  ],
  facialProportions: [
    { valueAr: 'أثلاث وجهية متوازنة (Mesofacial)', valueEn: 'Balanced facial thirds (Mesofacial)', status: 'normal' },
    { valueAr: 'زيادة الثلث السفلي (Dolichofacial / نمط عمودي)', valueEn: 'Increased lower facial height (Dolichofacial)', status: 'finding' },
    { valueAr: 'نقص الثلث السفلي (Brachyfacial / نمط أفقي)', valueEn: 'Decreased lower facial height (Brachyfacial)', status: 'finding' },
  ],
  profile: [
    { valueAr: 'بروفايل مستقيم متوازن (Straight)', valueEn: 'Straight balanced profile', status: 'normal' },
    { valueAr: 'محدب خفيف — تراجع ذقن خفيف (Mild Convex)', valueEn: 'Mildly convex profile', status: 'finding' },
    { valueAr: 'محدب واضح — صنف ثانٍ هيكلي (Convex)', valueEn: 'Markedly convex profile (Class II tendency)', status: 'finding' },
    { valueAr: 'مقعر — تقدم ذقن / تراجع علوي (Concave)', valueEn: 'Concave profile (Class III tendency)', status: 'finding' },
  ],
  lipCompetence: [
    { valueAr: 'شفتان متلاصقتان باسترخاء (Competent)', valueEn: 'Competent lips at rest', status: 'normal' },
    { valueAr: 'عدم كفاءة شفتين مع جهد بسيط (Potentially Competent)', valueEn: 'Potentially competent lips (mild gap)', status: 'finding' },
    { valueAr: 'شفتان غير كفوءتين مع شد ذقني (Incompetent / Mentalis Strain)', valueEn: 'Incompetent lips with mentalis strain', status: 'finding' },
    { valueAr: 'فرط نشاط العضلة الذقنية (Hyperactive Mentalis)', valueEn: 'Hyperactive mentalis muscle', status: 'finding' },
  ],
  smileArc: [
    { valueAr: 'قوس ابتسامة متناغم مع الشفة السفلى (Consonant)', valueEn: 'Consonant smile arc', status: 'normal' },
    { valueAr: 'قوس ابتسامة مسطح (Flat Smile Arc)', valueEn: 'Flat smile arc', status: 'finding' },
    { valueAr: 'قوس ابتسامة معكوس (Reverse Smile Arc)', valueEn: 'Reverse smile arc', status: 'finding' },
    { valueAr: 'ابتسامة غير متناظرة (Asymmetric Smile)', valueEn: 'Asymmetric smile cant', status: 'finding' },
  ],
  gingivalDisplay: [
    { valueAr: 'ظهور طبيعي للقواطع 1–2 مم عند الابتسامة', valueEn: 'Normal incisor/gingival display (1–2 mm)', status: 'normal' },
    { valueAr: 'ابتسامة لثوية خفيفة (2–3 مم)', valueEn: 'Mild gummy smile (2–3 mm)', status: 'finding' },
    { valueAr: 'ابتسامة لثوية واضحة (>3 مم Gummy Smile)', valueEn: 'Excessive gingival display (>3 mm)', status: 'finding' },
    { valueAr: 'نقص ظهور القواطع العلوية أثناء الابتسامة', valueEn: 'Reduced maxillary incisor display', status: 'finding' },
  ],
  tmjFunction: [
    { valueAr: 'سليم — بدون ألم أو طقطقة (فتح فم طبيعي)', valueEn: 'Normal — no pain, clicking, or deviation', status: 'normal' },
    { valueAr: 'طقطقة بالمفصل بدون ألم (Painless Clicking)', valueEn: 'Painless TMJ clicking', status: 'finding' },
    { valueAr: 'ألم مفصلي أو عضلي مع طقطقة (Symptomatic TMD)', valueEn: 'Symptomatic TMD (pain & clicking)', status: 'finding' },
    { valueAr: 'انحراف الفك أو تحدد فتح الفم (<35 مم)', valueEn: 'Mandibular deviation / limited opening', status: 'finding' },
  ],
};

export const EXTRAORAL_DEFAULT_NORMAL: Record<ExtraoralKey, QuickExamOption> = {
  symmetry: EXTRAORAL_QUICK_OPTIONS.symmetry[0],
  facialProportions: EXTRAORAL_QUICK_OPTIONS.facialProportions[0],
  profile: EXTRAORAL_QUICK_OPTIONS.profile[0],
  lipCompetence: EXTRAORAL_QUICK_OPTIONS.lipCompetence[0],
  smileArc: EXTRAORAL_QUICK_OPTIONS.smileArc[0],
  gingivalDisplay: EXTRAORAL_QUICK_OPTIONS.gingivalDisplay[0],
  tmjFunction: EXTRAORAL_QUICK_OPTIONS.tmjFunction[0],
};

export const INTRAORAL_QUICK_OPTIONS: Record<IntraoralKey, QuickExamOption[]> = {
  dentitionStage: [
    { valueAr: 'أسنان دائمة مكتملة (Permanent Dentition)', valueEn: 'Complete Permanent Dentition', status: 'normal' },
    { valueAr: 'أسنان مختلطة مبكرة (Early Mixed Dentition)', valueEn: 'Early Mixed Dentition', status: 'finding' },
    { valueAr: 'أسنان مختلطة متأخرة (Late Mixed Dentition)', valueEn: 'Late Mixed Dentition', status: 'finding' },
    { valueAr: 'أسنان لبنية (Primary Dentition)', valueEn: 'Primary Dentition', status: 'finding' },
    { valueAr: 'أسنان دائمة بدون الأرحاء الثالثة', valueEn: 'Permanent Dentition (3rd molars unerupted)', status: 'normal' },
  ],
  gingivalHealth: [
    { valueAr: 'لثة سليمة وعناية فموية جيدة', valueEn: 'Healthy gingiva & good oral hygiene', status: 'normal' },
    { valueAr: 'التهاب لثة خفيف وتراكم جير بسيط', valueEn: 'Mild gingivitis & plaque/calculus', status: 'finding' },
    { valueAr: 'التهاب لثة متوسط–شديد يتطلب تنظيفاً قبل التقويم', valueEn: 'Moderate/severe gingivitis — scaling needed', status: 'finding' },
    { valueAr: 'انحسار لثوي موضعي (Recession)', valueEn: 'Localized gingival recession', status: 'finding' },
    { valueAr: 'تضخم لثوي / فرط تصنع', valueEn: 'Gingival hyperplasia', status: 'finding' },
  ],
  molarRelRight: [
    { valueAr: 'صنف أول (Class I)', valueEn: 'Class I', status: 'normal' },
    { valueAr: 'صنف ثانٍ نصف وحدة (Class II 1/2 unit)', valueEn: 'Class II (End-on / 1/2 unit)', status: 'finding' },
    { valueAr: 'صنف ثانٍ كامل (Full Class II)', valueEn: 'Full Class II', status: 'finding' },
    { valueAr: 'صنف ثالث نصف وحدة (Class III 1/2 unit)', valueEn: 'Class III (1/2 unit)', status: 'finding' },
    { valueAr: 'صنف ثالث كامل (Full Class III)', valueEn: 'Full Class III', status: 'finding' },
    { valueAr: 'غير محدد (رحى مفقودة أو لم تبزغ)', valueEn: 'N/A (molar missing/unerupted)', status: 'not_applicable' },
  ],
  molarRelLeft: [
    { valueAr: 'صنف أول (Class I)', valueEn: 'Class I', status: 'normal' },
    { valueAr: 'صنف ثانٍ نصف وحدة (Class II 1/2 unit)', valueEn: 'Class II (End-on / 1/2 unit)', status: 'finding' },
    { valueAr: 'صنف ثانٍ كامل (Full Class II)', valueEn: 'Full Class II', status: 'finding' },
    { valueAr: 'صنف ثالث نصف وحدة (Class III 1/2 unit)', valueEn: 'Class III (1/2 unit)', status: 'finding' },
    { valueAr: 'صنف ثالث كامل (Full Class III)', valueEn: 'Full Class III', status: 'finding' },
    { valueAr: 'غير محدد (رحى مفقودة أو لم تبزغ)', valueEn: 'N/A (molar missing/unerupted)', status: 'not_applicable' },
  ],
  canineRelRight: [
    { valueAr: 'صنف أول (Class I)', valueEn: 'Class I', status: 'normal' },
    { valueAr: 'صنف ثانٍ نصف وحدة (Class II 1/2 unit)', valueEn: 'Class II (1/2 unit)', status: 'finding' },
    { valueAr: 'صنف ثانٍ كامل (Full Class II)', valueEn: 'Full Class II', status: 'finding' },
    { valueAr: 'صنف ثالث نصف وحدة (Class III 1/2 unit)', valueEn: 'Class III (1/2 unit)', status: 'finding' },
    { valueAr: 'صنف ثالث كامل (Full Class III)', valueEn: 'Full Class III', status: 'finding' },
    { valueAr: 'ناب عالي دهليزياً / منطمر / لم يبزغ', valueEn: 'High buccal / impacted / unerupted canine', status: 'finding' },
  ],
  canineRelLeft: [
    { valueAr: 'صنف أول (Class I)', valueEn: 'Class I', status: 'normal' },
    { valueAr: 'صنف ثانٍ نصف وحدة (Class II 1/2 unit)', valueEn: 'Class II (1/2 unit)', status: 'finding' },
    { valueAr: 'صنف ثانٍ كامل (Full Class II)', valueEn: 'Full Class II', status: 'finding' },
    { valueAr: 'صنف ثالث نصف وحدة (Class III 1/2 unit)', valueEn: 'Class III (1/2 unit)', status: 'finding' },
    { valueAr: 'صنف ثالث كامل (Full Class III)', valueEn: 'Full Class III', status: 'finding' },
    { valueAr: 'ناب عالي دهليزياً / منطمر / لم يبزغ', valueEn: 'High buccal / impacted / unerupted canine', status: 'finding' },
  ],
  overjetMm: [
    { valueAr: '2–3 مم (طبيعي)', valueEn: '2–3 mm (Normal)', status: 'normal' },
    { valueAr: '4–5 مم (بروز خفيف)', valueEn: '4–5 mm (Mildly increased)', status: 'finding' },
    { valueAr: '6–8 مم (بروز متوسط)', valueEn: '6–8 mm (Moderately increased)', status: 'finding' },
    { valueAr: '>8 مم (بروز شديد)', valueEn: '>8 mm (Severe overjet)', status: 'finding' },
    { valueAr: '0 مم (تلامس حد لحد Edge-to-Edge)', valueEn: '0 mm (Edge-to-Edge)', status: 'finding' },
    { valueAr: 'بروز معكوس (< 0 مم Reverse Overjet)', valueEn: '<0 mm (Reverse Overjet)', status: 'finding' },
  ],
  overbiteMm: [
    { valueAr: '2–3 مم / ~25% (طبيعي)', valueEn: '2–3 mm / ~25% (Normal)', status: 'normal' },
    { valueAr: '4 مم / ~45% (عضة عميقة خفيفة)', valueEn: '4 mm / ~45% (Mild deep bite)', status: 'finding' },
    { valueAr: '>5 مم / >60% (عضة عميقة متوسطة–شديدة)', valueEn: '>5 mm / >60% (Moderate/severe deep bite)', status: 'finding' },
    { valueAr: 'عضة عميقة راضّة للحنك (Impinging)', valueEn: 'Complete impinging deep bite', status: 'finding' },
    { valueAr: '0 مم (حد لحد)', valueEn: '0 mm (Edge-to-edge)', status: 'finding' },
    { valueAr: '< 0 مم (عضة مفتوحة)', valueEn: '<0 mm (Open bite)', status: 'finding' },
  ],
  midlineUpper: [
    { valueAr: 'متطابق مع منتصف الوجه (0 مم)', valueEn: 'Coincident with facial midline (0 mm)', status: 'normal' },
    { valueAr: 'منحرف لليمين 1–2 مم', valueEn: 'Shifted 1–2 mm to right', status: 'finding' },
    { valueAr: 'منحرف لليسار 1–2 مم', valueEn: 'Shifted 1–2 mm to left', status: 'finding' },
    { valueAr: 'منحرف لليمين ≥ 3 مم', valueEn: 'Shifted ≥3 mm to right', status: 'finding' },
    { valueAr: 'منحرف لليسار ≥ 3 مم', valueEn: 'Shifted ≥3 mm to left', status: 'finding' },
  ],
  midlineLower: [
    { valueAr: 'متطابق مع الخط العلوي والوجهي (0 مم)', valueEn: 'Coincident with upper & facial midline (0 mm)', status: 'normal' },
    { valueAr: 'منحرف لليمين 1–2 مم', valueEn: 'Shifted 1–2 mm to right', status: 'finding' },
    { valueAr: 'منحرف لليسار 1–2 مم', valueEn: 'Shifted 1–2 mm to left', status: 'finding' },
    { valueAr: 'منحرف لليمين ≥ 3 مم (انحراف وظيفي/هيكلي)', valueEn: 'Shifted ≥3 mm to right', status: 'finding' },
    { valueAr: 'منحرف لليسار ≥ 3 مم (انحراف وظيفي/هيكلي)', valueEn: 'Shifted ≥3 mm to left', status: 'finding' },
  ],
  crowdingUpper: [
    { valueAr: 'لا يوجد ازدحام (0 مم)', valueEn: 'No crowding (0 mm)', status: 'normal' },
    { valueAr: 'ازدحام خفيف (1–3 مم)', valueEn: 'Mild crowding (1–3 mm)', status: 'finding' },
    { valueAr: 'ازدحام متوسط (4–6 مم)', valueEn: 'Moderate crowding (4–6 mm)', status: 'finding' },
    { valueAr: 'ازدحام شديد (>6 مم)', valueEn: 'Severe crowding (>6 mm)', status: 'finding' },
    { valueAr: 'فراغات خفيفة (1–3 مم)', valueEn: 'Mild spacing (1–3 mm)', status: 'finding' },
    { valueAr: 'فراغات متوسطة–واسعة (>3 مم) / فلجة أمامية', valueEn: 'Moderate/generalized spacing (>3 mm)', status: 'finding' },
  ],
  crowdingLower: [
    { valueAr: 'لا يوجد ازدحام (0 مم)', valueEn: 'No crowding (0 mm)', status: 'normal' },
    { valueAr: 'ازدحام خفيف (1–3 مم)', valueEn: 'Mild crowding (1–3 mm)', status: 'finding' },
    { valueAr: 'ازدحام متوسط (4–6 مم)', valueEn: 'Moderate crowding (4–6 mm)', status: 'finding' },
    { valueAr: 'ازدحام شديد (>6 مم)', valueEn: 'Severe crowding (>6 mm)', status: 'finding' },
    { valueAr: 'فراغات خفيفة (1–3 مم)', valueEn: 'Mild spacing (1–3 mm)', status: 'finding' },
    { valueAr: 'فراغات متوسطة–واسعة (>3 مم)', valueEn: 'Moderate/generalized spacing (>3 mm)', status: 'finding' },
  ],
  crossbite: [
    { valueAr: 'لا توجد عضة معكوسة', valueEn: 'No crossbite present', status: 'normal' },
    { valueAr: 'عضة معكوسة أمامية (سن واحد / متعددة)', valueEn: 'Anterior crossbite (single/multiple)', status: 'finding' },
    { valueAr: 'عضة معكوسة خلفية أحادية الجانب — يمين (مع انحراف وظيفي)', valueEn: 'Unilateral posterior crossbite — Right', status: 'finding' },
    { valueAr: 'عضة معكوسة خلفية أحادية الجانب — يسار (مع انحراف وظيفي)', valueEn: 'Unilateral posterior crossbite — Left', status: 'finding' },
    { valueAr: 'عضة معكوسة خلفية ثنائية الجانب', valueEn: 'Bilateral posterior crossbite', status: 'finding' },
    { valueAr: 'عضة معكوسة أمامية وخلفية معاً', valueEn: 'Combined anterior & posterior crossbite', status: 'finding' },
    { valueAr: 'عضة مقصية (Scissor Bite / Brodie)', valueEn: 'Scissor bite (Brodie syndrome)', status: 'finding' },
  ],
  openBite: [
    { valueAr: 'لا توجد عضة مفتوحة', valueEn: 'No open bite present', status: 'normal' },
    { valueAr: 'عضة مفتوحة أمامية خفيفة (1–2 مم)', valueEn: 'Mild anterior open bite (1–2 mm)', status: 'finding' },
    { valueAr: 'عضة مفتوحة أمامية متوسطة–شديدة (≥ 3 مم)', valueEn: 'Moderate/severe anterior open bite (≥3 mm)', status: 'finding' },
    { valueAr: 'عضة مفتوحة جانبية / خلفية', valueEn: 'Lateral / posterior open bite', status: 'finding' },
  ],
  deepBite: [
    { valueAr: 'لا توجد عضة عميقة — قوس سبي مسطح (≤1.5 مم)', valueEn: 'Normal — flat Curve of Spee (≤1.5 mm)', status: 'normal' },
    { valueAr: 'قوس سبي متوسط العمق (2–3 مم)', valueEn: 'Moderate Curve of Spee (2–3 mm)', status: 'finding' },
    { valueAr: 'عضة عميقة مع قوس سبي عميق (>3 مم)', valueEn: 'Deep bite with accentuated Curve of Spee (>3 mm)', status: 'finding' },
    { valueAr: 'عضة عميقة راضّة للحنك / اللثة', valueEn: 'Palatal / gingival impinging deep bite', status: 'finding' },
  ],
  archFormUpper: [
    { valueAr: 'بيضاوي متناظر (Ovoid)', valueEn: 'Symmetrical Ovoid', status: 'normal' },
    { valueAr: 'مدبب / ضيق على شكل V (Tapered)', valueEn: 'Tapered / V-shaped', status: 'finding' },
    { valueAr: 'مربع عريض (Square)', valueEn: 'Broad Square', status: 'finding' },
    { valueAr: 'ضيق على شكل Ω / مضغوط جانبياً', valueEn: 'Constricted / Omega-shaped', status: 'finding' },
    { valueAr: 'قوس غير متناظر (Asymmetric)', valueEn: 'Asymmetric arch form', status: 'finding' },
  ],
  archFormLower: [
    { valueAr: 'بيضاوي متناظر (Ovoid)', valueEn: 'Symmetrical Ovoid', status: 'normal' },
    { valueAr: 'مدبب / ضيق على شكل V (Tapered)', valueEn: 'Tapered / V-shaped', status: 'finding' },
    { valueAr: 'مربع عريض (Square)', valueEn: 'Broad Square', status: 'finding' },
    { valueAr: 'غير متناظر (Asymmetric)', valueEn: 'Asymmetric arch form', status: 'finding' },
  ],
};

export const INTRAORAL_DEFAULT_NORMAL: Record<IntraoralKey, QuickExamOption> = {
  dentitionStage: INTRAORAL_QUICK_OPTIONS.dentitionStage[0],
  gingivalHealth: INTRAORAL_QUICK_OPTIONS.gingivalHealth[0],
  molarRelRight: INTRAORAL_QUICK_OPTIONS.molarRelRight[0],
  molarRelLeft: INTRAORAL_QUICK_OPTIONS.molarRelLeft[0],
  canineRelRight: INTRAORAL_QUICK_OPTIONS.canineRelRight[0],
  canineRelLeft: INTRAORAL_QUICK_OPTIONS.canineRelLeft[0],
  overjetMm: INTRAORAL_QUICK_OPTIONS.overjetMm[0],
  overbiteMm: INTRAORAL_QUICK_OPTIONS.overbiteMm[0],
  midlineUpper: INTRAORAL_QUICK_OPTIONS.midlineUpper[0],
  midlineLower: INTRAORAL_QUICK_OPTIONS.midlineLower[0],
  crowdingUpper: INTRAORAL_QUICK_OPTIONS.crowdingUpper[0],
  crowdingLower: INTRAORAL_QUICK_OPTIONS.crowdingLower[0],
  crossbite: INTRAORAL_QUICK_OPTIONS.crossbite[0],
  openBite: INTRAORAL_QUICK_OPTIONS.openBite[0],
  deepBite: INTRAORAL_QUICK_OPTIONS.deepBite[0],
  archFormUpper: INTRAORAL_QUICK_OPTIONS.archFormUpper[0],
  archFormLower: INTRAORAL_QUICK_OPTIONS.archFormLower[0],
};

export const EXTRAORAL_NOTES_PRESETS: QuickTextOption[] = [
  { ar: 'المريض متعاون جداً، تناسق وجهي جيد وتنفس أنفي طبيعي.', en: 'Cooperative patient, good facial balance and nasal breathing.' },
  { ar: 'لجام شفوي علوي منخفض مشدود عند الشد (Frenum pull إيجابي).', en: 'High/low maxillary labial frenum attachment with positive blanch test.' },
  { ar: 'لوحظ شد بالعضلة الذقنية (Mentalis strain) أثناء إغلاق الشفتين.', en: 'Mentalis muscle strain noted upon lip closure.' },
  { ar: 'صوت طقطقة خفيف بالمفصل دون ألم، يُنصح بتجنب القوى الثقيلة.', en: 'Mild painless TMJ click; avoid heavy intermaxillary forces.' },
];

export const INTRAORAL_NOTES_PRESETS: QuickTextOption[] = [
  { ar: 'انحراف وظيفي بالفك السفلي عند الإطباق من CR إلى CO بمقدار ~2 مم.', en: 'Functional mandibular shift ~2 mm from CR to CO.' },
  { ar: 'يلزم تنظيف الجير وعلاج اللثة والتسوس قبل تثبيت الحاصرات.', en: 'Scaling, oral hygiene reinforcement & restorative clearance needed prior to bonding.' },
  { ar: 'فقد مبكر لسن لبني مع ميلان الأرحاء الدائمة المجاورة.', en: 'Premature primary loss with mesial tipping of adjacent molar.' },
  { ar: 'امتصاص أو تآكل بالحدود القاطعة؛ يتطلب ضبط الارتفاع عند الإنهاء.', en: 'Incisal edge attrition noted; consider vertical leveling at finishing.' },
];

export const FDI_NOTE_PRESETS: QuickTextOption[] = [
  { ar: 'ميلان حنكي / لساني', en: 'Palatal / lingual inclination' },
  { ar: 'بزوغ دهليزي عالي', en: 'High labial eruption' },
  { ar: 'دوران أنسي / وحشي', en: 'Mesial / distal rotation' },
  { ar: 'انطمار حنكي / دهليزي', en: 'Palatal / buccal impaction' },
  { ar: 'نقص عرض تاجي (Peg-shaped)', en: 'Narrow / Peg-shaped crown' },
  { ar: 'تآكل بالحد القاطع', en: 'Incisal edge attrition' },
  { ar: 'حشوة كبيرة / تاج', en: 'Large restoration / crown' },
  { ar: 'متحرك / قريب السقوط', en: 'Mobile / exfoliating' },
];
