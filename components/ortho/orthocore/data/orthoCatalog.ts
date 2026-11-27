import {
  ClinicVisit,
  ElasticClass,
  OrthoPhase,
  PatientCase,
  SlotSize,
} from '../types/ortho';

/* ═══════════════════════════════════════════════════════════════════════════
   ١) مراحل العلاج السريري والمطاطات (من منطق عقلان سنتر مني)
   ═══════════════════════════════════════════════════════════════════════════ */

export const ORTHO_PHASES: Array<{
  id: OrthoPhase;
  ar: string;
  en: string;
  hintAr: string;
  hintEn: string;
}> = [
  {
    id: 'aligning',
    ar: 'التسوية والمحاذاة',
    en: 'Leveling & Aligning',
    hintAr: 'فكّ الازدحام وتسوية المستوى — أسلاك مرنة (NiTi / CuNiTi)',
    hintEn: 'Resolve crowding and level arches using light flexible NiTi/CuNiTi wires',
  },
  {
    id: 'working',
    ar: 'المرحلة العاملة',
    en: 'Working / Space Closure',
    hintAr: 'إغلاق الفراغات وتصحيح العلاقة — أسلاك فولاذية أو مستطيلة صلبة',
    hintEn: 'Space closure, torque control & sagittal correction on rigid SS/TMA wires',
  },
  {
    id: 'finishing',
    ar: 'الإنهاء',
    en: 'Finishing & Detailing',
    hintAr: 'التفاصيل والإطباق النهائي وتعديل الجذور (TMA / Braided / SS)',
    hintEn: 'Root paralleling, occlusal settling & micro-aesthetics',
  },
  {
    id: 'retention',
    ar: 'التثبيت',
    en: 'Retention & Follow-up',
    hintAr: 'بعد فكّ الجهاز — المثبّتات الثابتة والمتحركة والمتابعة الدورية',
    hintEn: 'Post-debond fixed/removable retainers & periodic stability checks',
  },
];

export const ELASTIC_CLASSES: Array<{ id: ElasticClass; ar: string; en: string }> = [
  { id: 'none', ar: 'بلا مطاطات', en: 'No Elastics' },
  { id: 'class_ii', ar: 'صنف ثانٍ (Class II)', en: 'Class II Elastics' },
  { id: 'class_iii', ar: 'صنف ثالث (Class III)', en: 'Class III Elastics' },
  { id: 'vertical', ar: 'عمودية (Vertical / Settling)', en: 'Vertical / Settling' },
  { id: 'triangle', ar: 'مثلّثة (Triangle)', en: 'Triangular Elastics' },
  { id: 'box', ar: 'صندوقية (Box Elastics)', en: 'Box Elastics' },
  { id: 'cross', ar: 'متصالبة (Crossbite)', en: 'Cross-Arch Elastics' },
];

/* ═══════════════════════════════════════════════════════════════════════════
   ٢) الكتالوج الموسّع للأسلاك (Archwires Catalog)
   ═══════════════════════════════════════════════════════════════════════════ */

export type WireAlloyGroup =
  | 'niti_round'
  | 'cunini_thermal'
  | 'niti_rect'
  | 'rcs_niti'
  | 'ss_round'
  | 'ss_rect'
  | 'twistflex'
  | 'tma'
  | 'coated'
  | 'utility';

export interface ArchwireCatalogItem {
  code: string;
  alloyGroup: WireAlloyGroup;
  alloyLabel: string;
  crossSection: 'round' | 'rectangular';
  slots: Array<'018' | '022'>;
  phase: OrthoPhase;
  indicationAr: string;
  indicationEn: string;
}

export const WIRE_ALLOY_LABELS: Record<WireAlloyGroup, { ar: string; en: string }> = {
  niti_round: { ar: 'NiTi مستدير فائق المرونة', en: 'Superelastic Round NiTi' },
  cunini_thermal: { ar: 'CuNiTi حراري (Thermal)', en: 'Thermal Copper-NiTi' },
  niti_rect: { ar: 'NiTi مستطيل', en: 'Rectangular NiTi' },
  rcs_niti: { ar: 'قوس سبي معكوس (RCS NiTi)', en: 'Reverse Curve of Spee (RCS)' },
  ss_round: { ar: 'فولاذ مستدير (SS Round)', en: 'Stainless Steel Round' },
  ss_rect: { ar: 'فولاذ مستطيل (SS Rect / Posted)', en: 'Stainless Steel Rectangular' },
  twistflex: { ar: 'أسلاك مجدولة (Twistflex / Braided)', en: 'Multi-Strand Twistflex / Braided' },
  tma: { ar: 'تيتانيوم-موليبدنوم (TMA / Beta-Ti)', en: 'TMA (Beta-Titanium)' },
  coated: { ar: 'أسلاك تجميلية مطلية (Coated)', en: 'Tooth-Colored Coated' },
  utility: { ar: 'أسلاك جزئية / وظيفية (Utility / GUMMETAL)', en: 'Utility / Sectional / Gummetal' },
};

export const ARCHWIRE_CATALOG: ArchwireCatalogItem[] = [
  // NiTi Round
  { code: '0.012 NiTi', alloyGroup: 'niti_round', alloyLabel: 'NiTi', crossSection: 'round', slots: ['018', '022'], phase: 'aligning', indicationAr: 'رصف أولي لطيف للازدحام الشديد واللثة الحساسة', indicationEn: 'Gentle initial alignment for severe crowding' },
  { code: '0.014 NiTi', alloyGroup: 'niti_round', alloyLabel: 'NiTi', crossSection: 'round', slots: ['018', '022'], phase: 'aligning', indicationAr: 'رصف وتسوية قياسية لبداية الحالات', indicationEn: 'Standard initial leveling and aligning' },
  { code: '0.016 NiTi', alloyGroup: 'niti_round', alloyLabel: 'NiTi', crossSection: 'round', slots: ['018', '022'], phase: 'aligning', indicationAr: 'استكمال الرصف والتحكم بالدورانات قبل المستطيل', indicationEn: 'Complete alignment & rotation correction' },
  { code: '0.018 NiTi', alloyGroup: 'niti_round', alloyLabel: 'NiTi', crossSection: 'round', slots: ['022'], phase: 'aligning', indicationAr: 'تهيئة شكل القوس قبل الانتقال للأسلاك المستطيلة', indicationEn: 'Arch form consolidation prior to rectangular wires' },

  // Thermal Copper NiTi
  { code: '0.013 CuNiTi 35°C', alloyGroup: 'cunini_thermal', alloyLabel: 'CuNiTi', crossSection: 'round', slots: ['018', '022'], phase: 'aligning', indicationAr: 'حراري خفيف جداً للحاصرات ذاتية الربط والازدحام الشديد', indicationEn: 'Ultra-light thermal wire for self-ligating severe crowding' },
  { code: '0.014 CuNiTi 35°C', alloyGroup: 'cunini_thermal', alloyLabel: 'CuNiTi', crossSection: 'round', slots: ['018', '022'], phase: 'aligning', indicationAr: 'قوة مستمرة خفيفة نشطة بحرارة الفم', indicationEn: 'Body-heat activated light continuous force' },
  { code: '0.016 CuNiTi 35°C', alloyGroup: 'cunini_thermal', alloyLabel: 'CuNiTi', crossSection: 'round', slots: ['018', '022'], phase: 'aligning', indicationAr: 'رصف متقدم وتصحيح دورانات لطيف', indicationEn: 'Progressive thermal aligning' },
  { code: '0.018 CuNiTi 35°C', alloyGroup: 'cunini_thermal', alloyLabel: 'CuNiTi', crossSection: 'round', slots: ['022'], phase: 'aligning', indicationAr: 'توسيع القوس (Damon Broad/Standard)', indicationEn: 'Arch development prior to rectangular thermal' },
  { code: '0.014×0.025 CuNiTi', alloyGroup: 'cunini_thermal', alloyLabel: 'CuNiTi', crossSection: 'rectangular', slots: ['022'], phase: 'aligning', indicationAr: 'تحكم مبكر بالعزم (Torque) مع مرونة حرارية', indicationEn: 'Early torque expression with thermal comfort' },
  { code: '0.018×0.025 CuNiTi', alloyGroup: 'cunini_thermal', alloyLabel: 'CuNiTi', crossSection: 'rectangular', slots: ['022'], phase: 'working', indicationAr: 'توسيع وعزم متكامل (نظام Damon)', indicationEn: 'Full arch development & torque expression' },

  // Rectangular NiTi
  { code: '0.016×0.016 NiTi', alloyGroup: 'niti_rect', alloyLabel: 'NiTi', crossSection: 'rectangular', slots: ['018', '022'], phase: 'aligning', indicationAr: 'انتقال مبدئي لمراقبة العزم بدون صلابة زائدة', indicationEn: 'Square NiTi transition wire' },
  { code: '0.016×0.022 NiTi', alloyGroup: 'niti_rect', alloyLabel: 'NiTi', crossSection: 'rectangular', slots: ['018', '022'], phase: 'aligning', indicationAr: 'تعبئة الشق 0.018 أو رصف متقدم في شق 0.022', indicationEn: 'Primary rectangular NiTi transition' },
  { code: '0.017×0.025 NiTi', alloyGroup: 'niti_rect', alloyLabel: 'NiTi', crossSection: 'rectangular', slots: ['018', '022'], phase: 'working', indicationAr: 'تحكم عزمي وتصحيح ميل الجذور قبل الفولاذ', indicationEn: 'Intermediate torque & root control' },
  { code: '0.019×0.025 NiTi', alloyGroup: 'niti_rect', alloyLabel: 'NiTi', crossSection: 'rectangular', slots: ['022'], phase: 'working', indicationAr: 'تمهيد أخير قبل 0.019×0.025 فولاذ في شق 0.022', indicationEn: 'Final NiTi before 19×25 SS working wire' },
  { code: '0.021×0.025 NiTi', alloyGroup: 'niti_rect', alloyLabel: 'NiTi', crossSection: 'rectangular', slots: ['022'], phase: 'working', indicationAr: 'تعبئة شبه كاملة للشق للتعبير الأقصى للوصفة', indicationEn: 'Full-slot NiTi torque expression' },

  // Reverse Curve of Spee (RCS)
  { code: '0.016 RCS NiTi', alloyGroup: 'rcs_niti', alloyLabel: 'RCS NiTi', crossSection: 'round', slots: ['018', '022'], phase: 'aligning', indicationAr: 'فتح العضة العميقة المبكر وتسطيح قوس سبي', indicationEn: 'Early bite opening & Curve of Spee leveling' },
  { code: '0.016×0.022 RCS NiTi', alloyGroup: 'rcs_niti', alloyLabel: 'RCS NiTi', crossSection: 'rectangular', slots: ['018', '022'], phase: 'working', indicationAr: 'فتح العضة العميقة مع الحفاظ على عزم القواطع', indicationEn: 'Bite opening with anterior torque control' },
  { code: '0.017×0.025 RCS NiTi', alloyGroup: 'rcs_niti', alloyLabel: 'RCS NiTi', crossSection: 'rectangular', slots: ['018', '022'], phase: 'working', indicationAr: 'تسوية عميقة متقدمة للعضة المغلقة', indicationEn: 'Intermediate deep bite leveling' },
  { code: '0.019×0.025 RCS NiTi', alloyGroup: 'rcs_niti', alloyLabel: 'RCS NiTi', crossSection: 'rectangular', slots: ['022'], phase: 'working', indicationAr: 'فتح عضة عميقة قوي مع تعبئة شق 0.022', indicationEn: 'Heavy bite-opening & torque in 022 slot' },

  // Stainless Steel Round
  { code: '0.016 SS', alloyGroup: 'ss_round', alloyLabel: 'SS', crossSection: 'round', slots: ['018', '022'], phase: 'working', indicationAr: 'انزلاق الأنياب على سلك مستدير، تدوير الأرحاء، مطاط خفيف', indicationEn: 'Sliding mechanics, arch coordination & stabilization' },
  { code: '0.018 SS', alloyGroup: 'ss_round', alloyLabel: 'SS', crossSection: 'round', slots: ['018', '022'], phase: 'working', indicationAr: 'توسيع/تثبيت القوس والانزلاق دون تحكم عزمي أمامي', indicationEn: 'Arch stability & canine retraction on round wire' },
  { code: '0.020 SS', alloyGroup: 'ss_round', alloyLabel: 'SS', crossSection: 'round', slots: ['022'], phase: 'working', indicationAr: 'قوة تثبيت عالية لحركات التوسيع والمطاطات', indicationEn: 'Rigid round stabilizing archwire' },

  // Stainless Steel Rectangular & Posted
  { code: '0.016×0.022 SS', alloyGroup: 'ss_rect', alloyLabel: 'SS', crossSection: 'rectangular', slots: ['018', '022'], phase: 'working', indicationAr: 'سلك عامل رئيسي في شق 0.018 / انزلاق متوسط في 0.022', indicationEn: 'Main working wire in 018 slot / sliding in 022' },
  { code: '0.017×0.025 SS', alloyGroup: 'ss_rect', alloyLabel: 'SS', crossSection: 'rectangular', slots: ['018', '022'], phase: 'working', indicationAr: 'إنهاء شق 0.018 أو سلك انزلاق مثالي في شق 0.022', indicationEn: 'Full 018 working/finishing or low-friction 022 sliding' },
  { code: '0.019×0.025 SS', alloyGroup: 'ss_rect', alloyLabel: 'SS', crossSection: 'rectangular', slots: ['022'], phase: 'working', indicationAr: 'السلك العامل القياسي لإغلاق الفراغات وتثبيت العزم في 0.022', indicationEn: 'Gold standard 022 working wire for space closure & torque' },
  { code: '0.019×0.025 SS Posted (بخطافات)', alloyGroup: 'ss_rect', alloyLabel: 'SS Posted', crossSection: 'rectangular', slots: ['022'], phase: 'working', indicationAr: 'سلك عامل مزود بخطافات أمامية لإرجاع المجموعة الأمامية (En-Masse)', indicationEn: 'Pre-posted working wire for en-masse retraction & TADs' },
  { code: '0.021×0.025 SS', alloyGroup: 'ss_rect', alloyLabel: 'SS', crossSection: 'rectangular', slots: ['022'], phase: 'finishing', indicationAr: 'تعبئة كاملة لشق 0.022 للتحكم التام أو الجراحة التقويمية', indicationEn: 'Full-dimension 022 stabilization / orthognathic surgical wire' },

  // TMA Beta-Titanium
  { code: '0.016×0.022 TMA', alloyGroup: 'tma', alloyLabel: 'TMA', crossSection: 'rectangular', slots: ['018', '022'], phase: 'finishing', indicationAr: 'إنهاء وثنيات دقيقة (1st/2nd/3rd order bends) في شق 0.018', indicationEn: 'Detailing & finishing bends in 018 slot' },
  { code: '0.017×0.025 TMA', alloyGroup: 'tma', alloyLabel: 'TMA', crossSection: 'rectangular', slots: ['018', '022'], phase: 'finishing', indicationAr: 'إنهاء وتعديل الإطباق + عزم انتقائي وحساسية النيكل', indicationEn: 'Finishing, nickel-free option & loop mechanics' },
  { code: '0.019×0.025 TMA', alloyGroup: 'tma', alloyLabel: 'TMA', crossSection: 'rectangular', slots: ['022'], phase: 'finishing', indicationAr: 'إنهاء مثالي في شق 0.022 مع قدرة عالية على الثني والضبط', indicationEn: 'Standard 022 finishing & detailing wire' },

  // Twistflex / Braided
  { code: '0.0155 Twistflex', alloyGroup: 'twistflex', alloyLabel: 'Twistflex', crossSection: 'round', slots: ['018', '022'], phase: 'aligning', indicationAr: 'بدء لطيف جداً في الأسنان ذات الامتصاص الجذري أو المشدودة', indicationEn: 'Coaxial gentle initial wire for compromised periodontium' },
  { code: '0.0175 Braided SS', alloyGroup: 'twistflex', alloyLabel: 'Braided', crossSection: 'round', slots: ['018', '022'], phase: 'finishing', indicationAr: 'تثبيت وتقارب الإطباق (Settling) بالمطاط العمودي', indicationEn: 'Occlusal settling with vertical elastics' },
  { code: '0.016×0.022 Braided SS', alloyGroup: 'twistflex', alloyLabel: 'Braided', crossSection: 'rectangular', slots: ['018', '022'], phase: 'finishing', indicationAr: 'إنهاء مرن يحفظ العزم مع حرية حركة عمودية للإطباق', indicationEn: 'Flexible rectangular wire for final occlusal settling' },
  { code: '0.019×0.025 Braided SS', alloyGroup: 'twistflex', alloyLabel: 'Braided', crossSection: 'rectangular', slots: ['022'], phase: 'finishing', indicationAr: 'إنهاء إطباقي نهائي بالمطاط الصندوقي/المثلث في شق 0.022', indicationEn: 'Final 022 settling wire with box/triangle elastics' },

  // Coated Aesthetic
  { code: '0.014 Coated NiTi (تجميلي)', alloyGroup: 'coated', alloyLabel: 'Coated NiTi', crossSection: 'round', slots: ['018', '022'], phase: 'aligning', indicationAr: 'سلك أبيض/تجميلي للحاصرات الخزفية والياقوتية', indicationEn: 'Tooth-colored coated aligning wire for ceramic brackets' },
  { code: '0.016 Coated NiTi (تجميلي)', alloyGroup: 'coated', alloyLabel: 'Coated NiTi', crossSection: 'round', slots: ['018', '022'], phase: 'aligning', indicationAr: 'رصف تجميلي أبيض', indicationEn: 'Aesthetic coated progressive alignment' },
  { code: '0.016×0.022 Coated NiTi', alloyGroup: 'coated', alloyLabel: 'Coated NiTi', crossSection: 'rectangular', slots: ['018', '022'], phase: 'working', indicationAr: 'سلك مستطيل أبيض تجميلي', indicationEn: 'Aesthetic coated rectangular NiTi' },

  // Utility / Sectional
  { code: '0.016×0.022 Blue Elgiloy Utility', alloyGroup: 'utility', alloyLabel: 'Utility', crossSection: 'rectangular', slots: ['018', '022'], phase: 'working', indicationAr: 'سلك ريكيتس لغرس/بزوغ القواطع (Intrusion / Utility Arch)', indicationEn: 'Ricketts utility arch for true incisor intrusion/advancement' },
  { code: '0.017×0.025 CNA Intrusion Arch', alloyGroup: 'utility', alloyLabel: 'CNA', crossSection: 'rectangular', slots: ['018', '022'], phase: 'working', indicationAr: 'قوس غرس أمامي غير احتكاكي (Connecticut Intrusion Arch)', indicationEn: 'True anterior intrusion or molar tip-back arch' },
  { code: 'Sectional Canine Retraction T-Loop', alloyGroup: 'utility', alloyLabel: 'TMA Loop', crossSection: 'rectangular', slots: ['018', '022'], phase: 'working', indicationAr: 'سلك جزئي بدون احتكاك لإرجاع الأنياب بعروة T-Loop', indicationEn: 'Frictionless segmented T-loop retraction' },
  { code: 'Aligner Stage / No Wire', alloyGroup: 'utility', alloyLabel: 'Aligner', crossSection: 'round', slots: ['018', '022'], phase: 'aligning', indicationAr: 'حالة مصففات شفافة أو قبل تركيب الأسلاك', indicationEn: 'Clear aligner stage or pre-bonding' },
];

export const DEFAULT_WIRE_SEQUENCE: Record<'018' | '022', string[]> = {
  '022': [
    '0.012 NiTi',
    '0.014 NiTi',
    '0.016 NiTi',
    '0.016×0.022 NiTi',
    '0.017×0.025 NiTi',
    '0.019×0.025 NiTi',
    '0.019×0.025 SS',
    '0.019×0.025 TMA',
  ],
  '018': [
    '0.012 NiTi',
    '0.014 NiTi',
    '0.016 NiTi',
    '0.016×0.022 NiTi',
    '0.016×0.022 SS',
    '0.017×0.025 TMA',
  ],
};

export function suggestNextWire(slot: SlotSize, currentWire: string | null | undefined): string | null {
  const normalizedSlot: '018' | '022' = slot === '018' ? '018' : '022';
  const seq = DEFAULT_WIRE_SEQUENCE[normalizedSlot];
  if (!currentWire || currentWire.includes('لا يوجد')) return seq[0];
  const clean = currentWire.replace(/\s+/g, '').replace('x', '×').toLowerCase();
  const idx = seq.findIndex((w) => w.replace(/\s+/g, '').toLowerCase() === clean);
  if (idx >= 0 && idx < seq.length - 1) return seq[idx + 1];
  // Check without leading zero: e.g. "014 NiTi" vs "0.014 NiTi"
  const idxAlt = seq.findIndex((w) => {
    const short = w.replace(/0\./g, '').replace(/\s+/g, '').toLowerCase();
    return short === clean;
  });
  if (idxAlt >= 0 && idxAlt < seq.length - 1) return seq[idxAlt + 1];
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   ٣) الكتالوج الموسّع للأجهزة التقويمية (Appliances Catalog)
   ═══════════════════════════════════════════════════════════════════════════ */

export type ApplianceCategoryId =
  | 'fixed_labial'
  | 'lingual_aligners'
  | 'expansion_orthopedic'
  | 'functional'
  | 'removable_space';

export interface ApplianceCatalogItem {
  id: string;
  category: ApplianceCategoryId;
  ar: string;
  en: string;
  usesArchwires: boolean;
  defaultSlot: SlotSize;
  prescriptions: string[];
  protocolAr: string;
  protocolEn: string;
}

export const APPLIANCE_CATEGORIES: Record<ApplianceCategoryId, { ar: string; en: string }> = {
  fixed_labial: { ar: 'الأجهزة الثابتة الدهليزية (Brackets)', en: 'Fixed Labial Bracket Systems' },
  lingual_aligners: { ar: 'الأجهزة اللسانية والمصففات الشفافة', en: 'Lingual & Clear Aligners' },
  expansion_orthopedic: { ar: 'أجهزة التوسيع وتعديل النمو الهيكلي', en: 'Expansion & Orthopedic Appliances' },
  functional: { ar: 'الأجهزة الوظيفية (تصحيح الفك السفلي)', en: 'Functional Appliances (Class II/III)' },
  removable_space: { ar: 'المتحركة، كسر العادات وحفظ المسافة', en: 'Removable, Habit & Space Maintainers' },
};

export const APPLIANCE_CATALOG: ApplianceCatalogItem[] = [
  // Fixed Labial
  {
    id: 'mbt_metal',
    category: 'fixed_labial',
    ar: 'حاصرات معدنية تقليدية (MBT)',
    en: 'Conventional Metal Brackets (MBT)',
    usesArchwires: true,
    defaultSlot: '022',
    prescriptions: ['MBT 0.022', 'MBT 0.018', 'Low Profile MBT'],
    protocolAr: 'ربط تقليدي مطاطي أو سلكي، متابعة كل 4 أسابيع',
    protocolEn: 'Elastomeric/steel ties, routine activation every 4 weeks',
  },
  {
    id: 'roth_metal',
    category: 'fixed_labial',
    ar: 'حاصرات معدنية تقليدية (Roth)',
    en: 'Conventional Metal Brackets (Roth)',
    usesArchwires: true,
    defaultSlot: '022',
    prescriptions: ['Roth 0.022', 'Roth 0.018'],
    protocolAr: 'مناسب للسيطرة على البروز والتصحيح الفردي',
    protocolEn: 'Classic Roth prescription torque/tip values',
  },
  {
    id: 'self_ligating_passive',
    category: 'fixed_labial',
    ar: 'حاصرات ذاتية الربط سلبية (Damon / Passive SL)',
    en: 'Passive Self-Ligating (Damon / PSL)',
    usesArchwires: true,
    defaultSlot: '022',
    prescriptions: ['Damon Q2 0.022', 'Damon Clear 2', 'Pitts 21'],
    protocolAr: 'أسلاك CuNiTi واسعة في المراحل الأولى، متابعة كل 6–8 أسابيع',
    protocolEn: 'Low-friction broad CuNiTi sequence, 6–8 week intervals',
  },
  {
    id: 'self_ligating_active',
    category: 'fixed_labial',
    ar: 'حاصرات ذاتية الربط نشطة (Interactive / Active SL)',
    en: 'Active/Interactive Self-Ligating',
    usesArchwires: true,
    defaultSlot: '022',
    prescriptions: ['CCO / In-Ovation R 0.022', 'Empower 0.022', '0.018 Interactive'],
    protocolAr: 'تحكم فعّال بالمشبك المرن في مرحلتي العمل والإنهاء',
    protocolEn: 'Active spring clip engagement for working/finishing torque',
  },
  {
    id: 'ceramic_aesthetic',
    category: 'fixed_labial',
    ar: 'حاصرات خزفية أو ياقوتية تجميلية (Ceramic / Sapphire)',
    en: 'Ceramic / Sapphire Aesthetic Brackets',
    usesArchwires: true,
    defaultSlot: '022',
    prescriptions: ['Clarity Advanced 0.022', 'Sapphire Monocrystalline', 'Ceramic Upper 5-5 + Metal Lower'],
    protocolAr: 'أسلاك مطلية بالبداية وفولاذ معزز في مرحلة السحب، حماية المينا عند الفك',
    protocolEn: 'Careful debonding protocol; coated NiTi initially',
  },
  {
    id: 'two_by_four',
    category: 'fixed_labial',
    ar: 'جهاز جزئي مبكر للإطباق المختلط (2×4 Appliance)',
    en: '2×4 Interceptive Fixed Appliance',
    usesArchwires: true,
    defaultSlot: '022',
    prescriptions: ['2×4 Upper', '2×4 Upper & Lower'],
    protocolAr: 'تركيب على الأرحاء الدائمة الأولى والقواطع الأربعة الدائمة فقط',
    protocolEn: 'Brackets on 4 permanent incisors + bands/tubes on first molars',
  },

  // Lingual & Aligners
  {
    id: 'clear_aligners_full',
    category: 'lingual_aligners',
    ar: 'مصففات شفافة شاملة (Clear Aligners — Full)',
    en: 'Clear Aligners (Comprehensive)',
    usesArchwires: false,
    defaultSlot: 'other',
    prescriptions: ['Invisalign Comprehensive', 'Spark / Angel / ClearCorrect', 'In-House 3D Printed'],
    protocolAr: 'ارتداء 22 ساعة يومياً، تغيير المصفف كل 7–10 أيام مع مرفقات تجميلية',
    protocolEn: '22 hrs/day wear, 7–10 day tray changes with composite attachments',
  },
  {
    id: 'lingual_fixed',
    category: 'lingual_aligners',
    ar: 'تقويم لساني داخلي (Lingual System)',
    en: 'Lingual Fixed Brackets',
    usesArchwires: true,
    defaultSlot: '018',
    prescriptions: ['Incognito 0.018 Custom', '2D Lingual Social 6'],
    protocolAr: 'قوس أسلاك مشروم/مخصص لسانياً مع مراعاة قصر المسافة بين الحاصرات',
    protocolEn: 'Custom mushroom archwires, careful torque & vertical control',
  },

  // Expansion & Orthopedic
  {
    id: 'hyrax_rpe',
    category: 'expansion_orthopedic',
    ar: 'موسّع فكي علوي سريع (Hyrax / RPE)',
    en: 'Hyrax Rapid Palatal Expander (RPE)',
    usesArchwires: false,
    defaultSlot: 'other',
    prescriptions: ['Hyrax 4-Band', 'Bonded Acrylic RPE', 'Fan-Type Expander'],
    protocolAr: 'تنشيط ربع لفة (0.25 مم) مرة أو مرتين يومياً لمدة 14–21 يوماً ثم تثبيت 4–6 أشهر',
    protocolEn: '1–2 quarter-turns/day (0.25–0.5mm) for 2–3 wks, then 4–6 mo retention',
  },
  {
    id: 'marpe_mse',
    category: 'expansion_orthopedic',
    ar: 'موسّع عظمي مدعوم بزراعات صغيرة (MARPE / MSE)',
    en: 'Mini-Implant Assisted Expander (MARPE/MSE)',
    usesArchwires: false,
    defaultSlot: 'other',
    prescriptions: ['MSE-II (4 Palatal TADs)', 'Custom Hybrid MARPE'],
    protocolAr: 'توسيع هيكلي للبالغين بدون جراحة عبر 4 زراعات حنكية صغيرة',
    protocolEn: 'Skeletal midpalatal suture split via 4 palatal bicortical TADs',
  },
  {
    id: 'quad_helix',
    category: 'expansion_orthopedic',
    ar: 'موسّع كواد هيلكس البطيء وتدوير الأرحاء (Quad Helix)',
    en: 'Quad Helix / Bi-Helix Slow Expander',
    usesArchwires: false,
    defaultSlot: 'other',
    prescriptions: ['Fixed Soldered Quad Helix', 'Removable Lingual Sheath QH'],
    protocolAr: 'توسيع سني-سنخي بطيء وتصحيح دوران الأرحاء العلوية',
    protocolEn: 'Slow dentoalveolar expansion & molar derotation',
  },
  {
    id: 'facemask_protraction',
    category: 'expansion_orthopedic',
    ar: 'قناع وجهي لتقديم الفك العلوي (Facemask + RPE)',
    en: 'Reverse-Pull Facemask (Protraction)',
    usesArchwires: false,
    defaultSlot: 'other',
    prescriptions: ['Petit Facemask 400-500g/side', 'Delaire Type'],
    protocolAr: 'ارتداء 12–14 ساعة يومياً بقوة 400–500 غرام/جهة مع بروتوكول Alt-RAMEC أو RPE',
    protocolEn: '12–14 hrs/day wear, 400–500g per side with Hyrax hooks',
  },
  {
    id: 'headgear',
    category: 'expansion_orthopedic',
    ar: 'جهاز السحب خارج الفم (Headgear)',
    en: 'Orthopedic Headgear (Cervical / High-Pull)',
    usesArchwires: false,
    defaultSlot: 'other',
    prescriptions: ['High-Pull Headgear', 'Cervical Facebow', 'Combi-Pull'],
    protocolAr: 'كبح نمو الفك العلوي أو الحفاظ على الارتكاز الخلفي 12–14 ساعة يومياً',
    protocolEn: 'Maxillary growth restraint / distal molar anchorage 12–14 hrs/day',
  },

  // Functional
  {
    id: 'twin_block',
    category: 'functional',
    ar: 'جهاز توين بلوك الوظيفي (Twin Block)',
    en: 'Clark Twin Block Functional Appliance',
    usesArchwires: false,
    defaultSlot: 'other',
    prescriptions: ['Standard Twin Block + Expansion Screw', 'High-Pull Twin Block'],
    protocolAr: 'ارتداء مستمر 20+ ساعة لتحفيز تقدم الفك السفلي في حالات الصنف الثاني النامية',
    protocolEn: 'Full-time wear (20+ hrs/day) with midline screw activation',
  },
  {
    id: 'forsus_fatigue',
    category: 'functional',
    ar: 'نابض فورسوس الثابت لتصحيح الصنف الثاني (Forsus FRD)',
    en: 'Forsus Fatigue Resistant Device (Fixed Class II)',
    usesArchwires: true,
    defaultSlot: '022',
    prescriptions: ['Forsus EZ2', 'L-Pin Module on 0.019×0.025 SS'],
    protocolAr: 'يُركّب على سلك صلب 0.019×0.025 SS مع ربط رقم 8 لمنع تباعد الأسنان',
    protocolEn: 'Mounted on rigid 19×25 SS with figure-8 consolidation & -torque lower',
  },
  {
    id: 'herbst_appliance',
    category: 'functional',
    ar: 'جهاز هيربست الثابت (Herbst Appliance)',
    en: 'Fixed Herbst Class II Corrector',
    usesArchwires: false,
    defaultSlot: 'other',
    prescriptions: ['Band/Crown Herbst', 'Cast Splint Herbst'],
    protocolAr: 'جهاز ثابت لا يعتمد على تعاون المريض لتصحيح تراجع الفك السفلي',
    protocolEn: 'Fixed rigid telescope jumper; progressive mandibular advancement',
  },

  // Removable & Habit / Space
  {
    id: 'hawley_active',
    category: 'removable_space',
    ar: 'جهاز متحرك نشط بنوابض/مسمار (Active Hawley Plate)',
    en: 'Active Removable Plate (Z-Spring / Jackscrew)',
    usesArchwires: false,
    defaultSlot: 'other',
    prescriptions: ['Anterior Crossbite Bite-Plane + Z-Spring', 'Schwarz Expansion Plate'],
    protocolAr: 'لتصحيح عضة معكوسة سنية واحدة أو توسيع خفيف لدى الأطفال',
    protocolEn: 'Single-tooth crossbite tipping or mild pediatric expansion',
  },
  {
    id: 'habit_breaker_crib',
    category: 'removable_space',
    ar: 'حاجز اللسان وكاسر عادة المص (Tongue Crib / Bluegrass)',
    en: 'Tongue Crib / Habit Breaker / Bluegrass',
    usesArchwires: false,
    defaultSlot: 'other',
    prescriptions: ['Fixed Soldered Tongue Crib', 'Palatal Tongue Spurs'],
    protocolAr: 'منع دفع اللسان أو مص الأصابع لإغلاق العضة المفتوحة الأمامية',
    protocolEn: 'Eliminates thumb-sucking / tongue-thrust habit for open bite closure',
  },
  {
    id: 'space_maintainer_bandloop',
    category: 'removable_space',
    ar: 'حافظ مسافة ثابت (Band & Loop / Distal Shoe)',
    en: 'Fixed Space Maintainer (Band & Loop)',
    usesArchwires: false,
    defaultSlot: 'other',
    prescriptions: ['Unilateral Band & Loop', 'Bilateral Nance / LLHA'],
    protocolAr: 'الحفاظ على مسافة الفقد المبكر للأسنان اللبنية لحين بزوغ الدائم',
    protocolEn: 'Preserves leeway/arch perimeter after premature primary loss',
  },
];

/* ═══════════════════════════════════════════════════════════════════════════
   ٤) الكتالوج الموسّع للأجهزة المساعدة والارتكاز والميكانيكا (Auxiliaries)
   ═══════════════════════════════════════════════════════════════════════════ */

export type AuxiliaryCategoryId =
  | 'tads'
  | 'anchorage'
  | 'springs_chains'
  | 'bite_modifiers'
  | 'elastics_ipr';

export interface AuxiliaryCatalogItem {
  id: string;
  category: AuxiliaryCategoryId;
  ar: string;
  en: string;
  defaultSpec: string;
  siteHintAr: string;
  siteHintEn: string;
}

export const AUXILIARY_CATEGORIES: Record<AuxiliaryCategoryId, { ar: string; en: string }> = {
  tads: { ar: 'الزراعات التقويمية المؤقتة (TADs / Mini-Implants)', en: 'TADs & Skeletal Anchorage' },
  anchorage: { ar: 'أجهزة الارتكاز الثابتة داخل الفم', en: 'Intraoral Fixed Anchorage' },
  springs_chains: { ar: 'النوابض والسلاسل والمُلحقات الميكانيكية', en: 'Coils, Power Chains & Springs' },
  bite_modifiers: { ar: 'رافعات وكتل تعديل العضة (Bite Modifiers)', en: 'Bite Turbos & Occlusal Modifiers' },
  elastics_ipr: { ar: 'المطاطات بين الفكين وبرد المينا (IPR)', en: 'Elastics & Interproximal Reduction' },
};

export const AUXILIARY_CATALOG: AuxiliaryCatalogItem[] = [
  // TADs
  { id: 'tad_interradicular', category: 'tads', ar: 'زراعة تقويمية بين الجذور (Interradicular TAD)', en: 'Interradicular Mini-Implant (TAD)', defaultSpec: '1.6 × 8 mm Ti-Alloy', siteHintAr: 'مثال: بين 15-16 و 25-26 للإرجاع الأقصى', siteHintEn: 'e.g., Between U5-U6 buccal' },
  { id: 'tad_izc', category: 'tads', ar: 'زراعة القوس الوجني (IZC Bone Screw)', en: 'Infrazygomatic Crest (IZC) Screw', defaultSpec: '2.0 × 12 mm Stainless Steel', siteHintAr: 'لإرجاع القوس العلوي كاملاً أو غرس الأرحاء', siteHintEn: 'For total maxillary arch distalization / intrusion' },
  { id: 'tad_buccal_shelf', category: 'tads', ar: 'زراعة الرف الشدقي السفلي (Buccal Shelf Screw)', en: 'Mandibular Buccal Shelf Screw', defaultSpec: '2.0 × 12 mm Stainless Steel', siteHintAr: 'مقابل الضرس 36/46 لتصحيح الصنف الثالث بدون خلع', siteHintEn: 'Lateral to lower 6/7 for full-arch distalization' },
  { id: 'tad_palatal', category: 'tads', ar: 'زراعة حنكية (Palatal TAD / Beneslider / Frog)', en: 'Palatal Paramedian TAD', defaultSpec: '2.0 × 9 mm Palatal TAD', siteHintAr: 'سقف الحنك لإرجاع الأرحاء أو تثبيت الميزالايزر', siteHintEn: 'Anterior palate for distalization / mesialization' },

  // Anchorage
  { id: 'tpa_fixed', category: 'anchorage', ar: 'قوس حنكي معترض (TPA — Transpalatal Arch)', en: 'Transpalatal Arch (TPA)', defaultSpec: '0.036" SS Soldered/Removable', siteHintAr: 'تثبيت عرض الأرحاء 16-26 ومنع دورانها', siteHintEn: '16-26 molar rotation/width stabilization' },
  { id: 'nance_button', category: 'anchorage', ar: 'قوس نانس الحنكي (Nance Holding Arch)', en: 'Nance Palatal Holding Arch', defaultSpec: '0.036" SS + Acrylic Palatal Button', siteHintAr: 'ارتكاز أمامي-خلفي علوي عند خلع الضواحك', siteHintEn: 'Anterior-posterior molar anchorage (Upper)' },
  { id: 'llha_arch', category: 'anchorage', ar: 'قوس لساني سفلي مثبت (LLHA)', en: 'Lower Lingual Holding Arch (LLHA)', defaultSpec: '0.036" SS Bands on 36-46', siteHintAr: 'حفظ مسافة الليوي (Leeway) ومنع ميلان الأرحاء للأمام', siteHintEn: 'Leeway preservation & lower molar anchorage' },
  { id: 'lip_bumper', category: 'anchorage', ar: 'مصد الشفة السفلي (Lip Bumper)', en: 'Lower Lip Bumper', defaultSpec: '0.045" Wire + Acrylic Shield', siteHintAr: 'تخفيف ضغط الشفة السفلى وتوسيع/تأخير الأرحاء', siteHintEn: 'Shields lip pressure & uprighting molars' },

  // Springs & Chains
  { id: 'power_chain_closed', category: 'springs_chains', ar: 'سلسلة مطاطية متصلة/قصيرة (Power Chain)', en: 'Elastomeric Power Chain (Closed/Short)', defaultSpec: 'Clear / Silver — Short or Continuous', siteHintAr: 'إغلاق الفراغات المتبقية أو تجميع الأسنان الأمامية', siteHintEn: 'Space closure / consolidation' },
  { id: 'open_coil_niti', category: 'springs_chains', ar: 'نابض مفتوح لفتح المسافة (NiTi Open Coil Spring)', en: 'NiTi Open Coil Spring', defaultSpec: '0.010 × 0.030" Cut +2mm', siteHintAr: 'فتح مسافة لسن منطمر أو قاطع جانبي ضيق', siteHintEn: 'Create arch space for blocked/impacted tooth' },
  { id: 'closed_coil_niti', category: 'springs_chains', ar: 'نابض مغلق للسحب المستمر (NiTi Closed Coil)', en: 'NiTi Closed Coil Spring (TAD/Hook)', defaultSpec: '150g Light / 200g Medium', siteHintAr: 'سحب بقوة ثابتة لإغلاق مسافة الخلع أو من TAD', siteHintEn: 'Constant light force space closure' },
  { id: 'cantilever_canine', category: 'springs_chains', ar: 'نابض ذراع لبزوغ الناب المنطمر (Ballista / Cantilever)', en: 'TMA Cantilever / Ballista Impaction Spring', defaultSpec: '0.017×0.025 TMA Sectional', siteHintAr: 'بزوغ الناب المنطمر بعيداً عن القاعدة الأساسية', siteHintEn: 'Targeted traction for impacted canine' },
  { id: 'uprighting_spring', category: 'springs_chains', ar: 'نابض تعديل ميلان الضرس (Molar Uprighting Spring)', en: 'TMA Molar Uprighting Spring', defaultSpec: '0.017×0.025 TMA Helix', siteHintAr: 'تعديل ضرس 37/47 المائل قبل التركيبات أو الغلق', siteHintEn: 'Upright mesially tipped 2nd molar' },
  { id: 'laceback_tieback', category: 'springs_chains', ar: 'ربط خلفي مانع للبروز (Lacebacks / Active Tie-backs)', en: 'Lacebacks & Active Tie-Backs', defaultSpec: '0.010" SS Ligature / Module', siteHintAr: 'منع اندفاع القواطع أثناء الرصف الأولي (MBT)', siteHintEn: 'Prevent incisor proclination during alignment' },
  { id: 'lingual_buttons', category: 'springs_chains', ar: 'أزرار لسانية / خطافات كبس (Lingual Buttons & Crimp Hooks)', en: 'Lingual Buttons, Cleats & Crimpable Hooks', defaultSpec: 'Stainless Steel / Composite', siteHintAr: 'تعديل الدوران الحاد، سحب مطاط متصالب، أو ربط TAD', siteHintEn: 'Crossbite elastics, couple-force rotation, TAD hooks' },
  { id: 'kobayashi_hooks', category: 'springs_chains', ar: 'خطافات كوباياشي ووصلات التدوير (Kobayashi / Rotation Wedge)', en: 'Kobayashi Ties & Rotation Wedges', defaultSpec: '0.012" SS Pre-formed', siteHintAr: 'تعليق مطاطات الإطباق على الحاصرات غير المزودة بخطاف', siteHintEn: 'Elastic attachment & precision rotation' },

  // Bite Modifiers
  { id: 'anterior_bite_turbo', category: 'bite_modifiers', ar: 'رافعات عضة أمامية (Anterior Bite Turbos)', en: 'Anterior Bite Turbos (Palatal U1)', defaultSpec: 'Composite / Metal on 11, 21', siteHintAr: 'فتح العضة العميقة وحماية الحاصرات السفلية من الكسر', siteHintEn: 'Open deep bite & disclude lower brackets' },
  { id: 'posterior_bite_block', category: 'bite_modifiers', ar: 'كتل عضة خلفية لرفع الإطباق (Posterior Bite Blocks)', en: 'Posterior Occlusal Bite Blocks / Build-ups', defaultSpec: 'Blue Triad/GIC on 16, 26 or 36, 46', siteHintAr: 'تحرير العضة المعكوسة الأمامية أو غرس الأرحاء في العضة المفتوحة', siteHintEn: 'Crossbite unlocking or vertical intrusion' },
  { id: 'anterior_bite_plate', category: 'bite_modifiers', ar: 'لوح عضة أمامي متحرك (Anterior Bite Plate)', en: 'Removable Anterior Bite Plane', defaultSpec: 'Acrylic Flat Plane behind 13–23', siteHintAr: 'بزوغ الأرحاء الخلفية وتصحيح العضة العميقة الصعبة', siteHintEn: 'Posterior extrusion in low-angle deep bite' },

  // Elastics & IPR
  { id: 'ipr_stripping', category: 'elastics_ipr', ar: 'برد مينا تجميلي مدروس (Interproximal Reduction — IPR)', en: 'Interproximal Reduction (IPR)', defaultSpec: 'Diamond Strip / Bur (e.g. 0.25–0.5mm/contact)', siteHintAr: 'حل الازدحام الخفيف وموازنة نسبة بولتون والمثلثات السوداء', siteHintEn: 'Mild crowding relief & Bolton/black-triangle correction' },
  { id: 'intermaxillary_elastics', category: 'elastics_ipr', ar: 'مطاطات تصحيحية بين الفكين (Intermaxillary Elastics)', en: 'Intraoral Latex/Non-Latex Elastics', defaultSpec: '3/16" or 1/4" · 3.5–4.5 oz (20 hrs/day)', siteHintAr: 'Class II / Class III / Vertical Settling / Crossbite', siteHintEn: 'Sagittal, vertical or midline correction' },
];

/* ═══════════════════════════════════════════════════════════════════════════
   ٥) دوال مساعدة لصفحة اليوم ومتابعة التقويم (FlowBoard & Follow-up Logic)
   ═══════════════════════════════════════════════════════════════════════════ */

export function getTodayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDaysIso(baseDate: string, days: number): string {
  const dt = new Date(`${baseDate}T12:00:00`);
  dt.setDate(dt.getDate() + days);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function daysBetweenIso(from: string, to: string): number {
  const start = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const end = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((end - start) / 86_400_000);
}

export function minutesSince(iso: string | null | undefined, now: Date): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 60_000));
}

export type WaitLevel = 'calm' | 'warning' | 'critical';

export function waitLevel(minutes: number, warning = 15, critical = 30): WaitLevel {
  if (minutes >= critical) return 'critical';
  if (minutes >= warning) return 'warning';
  return 'calm';
}

export function waitingRows(visits: ClinicVisit[], now: Date, warning = 15, critical = 30) {
  return visits
    .filter((v) => v.status === 'waiting')
    .map((v) => {
      const waitedMinutes = minutesSince(v.arrivedAt, now);
      return { visit: v, waitedMinutes, level: waitLevel(waitedMinutes, warning, critical) };
    })
    .sort((a, b) => b.waitedMinutes - a.waitedMinutes);
}

export function chairRows(chairCount: number, visits: ClinicVisit[], now: Date) {
  const seated = visits.filter((v) => v.status === 'in_chair');
  const called = visits.filter((v) => v.status === 'called');
  return Array.from({ length: Math.max(1, chairCount) }, (_, idx) => {
    const chair = idx + 1;
    const occupant = seated.find((v) => v.chair === chair) ?? null;
    const calledFor = occupant ? null : called.find((v) => v.chair === chair) ?? null;
    return {
      chair,
      occupant,
      calledFor,
      busyMinutes: occupant ? minutesSince(occupant.seatedAt, now) : 0,
    };
  });
}

export function firstFreeChair(chairCount: number, visits: ClinicVisit[]): number | null {
  const held = new Set<number>();
  for (const v of visits) {
    if (v.chair !== null && (v.status === 'in_chair' || v.status === 'called')) held.add(v.chair);
  }
  for (let c = 1; c <= chairCount; c += 1) {
    if (!held.has(c)) return c;
  }
  return null;
}

export function daySummary(chairCount: number, visits: ClinicVisit[], now: Date) {
  const waiting = waitingRows(visits, now);
  const held = new Set<number>();
  for (const v of visits) {
    if (v.chair !== null && (v.status === 'in_chair' || v.status === 'called')) held.add(v.chair);
  }
  return {
    waiting: waiting.length,
    called: visits.filter((v) => v.status === 'called').length,
    inChair: visits.filter((v) => v.status === 'in_chair').length,
    done: visits.filter((v) => v.status === 'done').length,
    longestWaitMinutes: waiting[0]?.waitedMinutes ?? 0,
    freeChairs: Math.max(0, chairCount - held.size),
  };
}

export function calledVisits(visits: ClinicVisit[]): ClinicVisit[] {
  return visits
    .filter((v) => v.status === 'called')
    .sort((a, b) => (b.calledAt ?? '').localeCompare(a.calledAt ?? ''));
}

export function getPatientCurrentWires(patient: PatientCase): { upper: string; lower: string; lastDate: string | null } {
  const latestWithWire = patient.sessions.find((s) => s.archwireUpper || s.archwireLower);
  const latestSession = patient.sessions[0];
  return {
    upper: latestWithWire?.archwireUpper || patient.treatmentPlan.mechanotherapy.wireSequenceUpper?.[0] || patient.treatmentPlan.mechanotherapy.wireSequence[0] || '',
    lower: latestWithWire?.archwireLower || patient.treatmentPlan.mechanotherapy.wireSequenceLower?.[0] || patient.treatmentPlan.mechanotherapy.wireSequence[0] || '',
    lastDate: latestSession?.date || null,
  };
}

export function inferOrthoPhase(patient: PatientCase): OrthoPhase {
  if (patient.treatmentPlan.mechanotherapy.orthoPhase) return patient.treatmentPlan.mechanotherapy.orthoPhase;
  const latestSessionPhase = patient.sessions[0]?.orthoPhase;
  if (latestSessionPhase) return latestSessionPhase;
  if (patient.stage === 'retention' || patient.stage === 'completed') return 'retention';
  if (patient.stage === 'finishing') return 'finishing';
  const wires = getPatientCurrentWires(patient);
  if (wires.upper.includes('SS') || wires.upper.includes('0.019') || wires.upper.includes('0.017')) return 'working';
  return 'aligning';
}

export type FollowupBucket =
  | 'today'
  | 'tomorrow'
  | 'this_week'
  | 'no_appointment'
  | 'overdue'
  | 'lapsed_4'
  | 'lapsed_6'
  | 'lapsed_8'
  | 'retention'
  | 'upcoming';

export const FOLLOWUP_BUCKETS: Array<{
  id: FollowupBucket;
  ar: string;
  en: string;
  tone: 'navy' | 'amber' | 'red' | 'emerald' | 'slate';
}> = [
  { id: 'today', ar: 'اليوم', en: 'Today', tone: 'navy' },
  { id: 'tomorrow', ar: 'غدًا', en: 'Tomorrow', tone: 'navy' },
  { id: 'this_week', ar: 'هذا الأسبوع', en: 'This Week', tone: 'navy' },
  { id: 'no_appointment', ar: 'بدون موعد قادم', en: 'No Next Appt', tone: 'amber' },
  { id: 'overdue', ar: 'تجاوزوا موعدهم', en: 'Overdue Appt', tone: 'red' },
  { id: 'lapsed_4', ar: 'منذ ٤ أسابيع', en: '4+ Weeks Since Adj', tone: 'amber' },
  { id: 'lapsed_6', ar: 'منذ ٦ أسابيع', en: '6+ Weeks Since Adj', tone: 'red' },
  { id: 'lapsed_8', ar: 'منذ ٨ أسابيع+', en: '8+ Weeks Since Adj', tone: 'red' },
  { id: 'retention', ar: 'حالات التثبيت', en: 'Retention Cases', tone: 'emerald' },
  { id: 'upcoming', ar: 'مواعيد قادمة', en: 'Upcoming', tone: 'slate' },
];

export interface FollowupClassified {
  patient: PatientCase;
  buckets: FollowupBucket[];
  daysSinceLast: number | null;
  lastDate: string | null;
  upperWire: string;
  lowerWire: string;
  phase: OrthoPhase;
}

export function classifyPatientsForFollowup(patients: PatientCase[], today: string): FollowupClassified[] {
  return patients
    .filter((p) => p.stage !== 'completed')
    .map((p) => {
      const buckets: FollowupBucket[] = [];
      const wires = getPatientCurrentWires(p);
      const since = wires.lastDate || p.createdAt.slice(0, 10);
      const daysSinceLast = since ? daysBetweenIso(since, today) : null;

      if (p.nextAppointmentDate) {
        const offset = daysBetweenIso(today, p.nextAppointmentDate);
        if (offset === 0) buckets.push('today');
        else if (offset === 1) buckets.push('tomorrow');
        else if (offset >= 2 && offset <= 7) buckets.push('this_week');
        else if (offset > 7) buckets.push('upcoming');
        else if (offset < 0) buckets.push('overdue');
      } else {
        buckets.push('no_appointment');
      }

      if (daysSinceLast !== null) {
        if (daysSinceLast >= 56) buckets.push('lapsed_8');
        else if (daysSinceLast >= 42) buckets.push('lapsed_6');
        else if (daysSinceLast >= 28) buckets.push('lapsed_4');
      }

      if (p.stage === 'retention') buckets.push('retention');

      return {
        patient: p,
        buckets,
        daysSinceLast,
        lastDate: wires.lastDate,
        upperWire: wires.upper,
        lowerWire: wires.lower,
        phase: inferOrthoPhase(p),
      };
    });
}

export function sinceAdjustmentText(days: number | null, lang: 'ar' | 'en' = 'ar'): string {
  if (days === null) return lang === 'ar' ? 'بلا شدّات بعد' : 'No adjustments yet';
  if (days <= 0) return lang === 'ar' ? 'اليوم' : 'Today';
  const weeks = Math.floor(days / 7);
  if (lang === 'en') {
    if (weeks < 1) return `${days}d ago`;
    return `${weeks}w ago`;
  }
  if (weeks < 1) return days === 1 ? 'قبل يوم' : days === 2 ? 'قبل يومين' : `قبل ${days} أيام`;
  if (weeks === 1) return 'قبل أسبوع';
  if (weeks === 2) return 'قبل أسبوعين';
  return `قبل ${weeks} أسابيع`;
}
