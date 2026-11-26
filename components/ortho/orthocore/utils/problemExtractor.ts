import {
  Language,
  MeasurementAnalysis,
  PatientCase,
  ProblemCategory,
  ProblemItem,
} from '../types/ortho';

export interface ExtractedProblem extends ProblemItem {
  sourceTag: 'diagnosis' | 'exam' | 'photo' | 'analysis';
  /** Keywords used to detect if an existing manual/seed problem already documents this exact issue */
  overlapTokens?: string[];
}

function isNormalClassification(val: string): boolean {
  const s = val.trim().toLowerCase();
  if (!s) return true;
  const normalMarkers = ['class i', 'صنف أول', 'صنف اول', 'متوازن', 'طبيعي', 'normal', 'mesofacial', 'balanced'];
  const abnormalMarkers = [
    'ii',
    'iii',
    'ثان',
    'ثالث',
    'خفيف',
    'شديد',
    'تراجع',
    'تقدم',
    'بروز',
    'ازدحام',
    'معكوس',
    'مفتوح',
    'عميق',
    'انحراف',
    'عدم',
    'مرتفع',
    'منخفض',
    'عالي',
    'high',
    'low',
    'open',
    'deep',
    'crowding',
    'crossbite',
    'asymmetry',
    'hyper',
    'hypo',
    'protrus',
    'retru',
    'div',
    'subdivision',
    'cusp',
  ];
  const hasAbnormal = abnormalMarkers.some((m) => s.includes(m));
  if (hasAbnormal) return false;
  return normalMarkers.some((m) => s.includes(m));
}

function getMetric(ana: MeasurementAnalysis | undefined, key: string): number | null {
  if (!ana) return null;
  const m = ana.metrics.find((x) => x.key === key);
  return m && typeof m.value === 'number' && !Number.isNaN(m.value) ? m.value : null;
}

/**
 * Extracts clinical problems automatically from:
 * 1) Clinical Diagnosis (skeletalClass, dentalClass, verticalPattern)
 * 2) Clinical Exam & FDI Tooth Chart (extraoral, intraoral findings & teeth status)
 * 3) Photo Analysis (Extraoral Frontal/Profile/Smile + Intraoral Frontal/Right/Left/Upper/Lower)
 * 4) Measurement Analyses (Cephalometric, Cast/Bolton, Mixed Dentition, CBCT)
 */
export function extractClinicalProblems(patient: PatientCase, lang: Language): ExtractedProblem[] {
  const out: ExtractedProblem[] = [];
  const isAr = lang === 'ar';

  const pushProblem = (p: ExtractedProblem) => {
    if (!out.some((x) => x.id === p.id)) {
      out.push(p);
    }
  };

  // ════════════════════════════════════════════════════════════════════════════
  // 1. DIAGNOSIS FIELDS
  // ════════════════════════════════════════════════════════════════════════════
  const diag = patient.diagnosis;

  if (diag.skeletalClass?.trim() && !isNormalClassification(diag.skeletalClass)) {
    const val = diag.skeletalClass.trim();
    const isClassIII = /iii|ثالث|3/i.test(val);
    const isClassII = !isClassIII && /ii|ثان|2/i.test(val);
    pushProblem({
      id: 'auto-diag-skeletal',
      sourceTag: 'diagnosis',
      category: 'skeletal',
      title: isAr ? `خلل هيكلي: ${val}` : `Skeletal Discrepancy: ${val}`,
      description: isAr
        ? 'تم إدراجه تلقائياً من التصنيف الهيكلي في سجل التشخيص السريري.'
        : 'Automatically derived from Skeletal Class in Clinical Diagnosis.',
      evidenceLinks: [
        {
          type: 'exam',
          refId: 'diag-skeletal',
          label: isAr ? `التشخيص الهيكلي: ${val}` : `Diagnosis Skeletal: ${val}`,
        },
      ],
      priority: 'high',
      status: 'active',
      overlapTokens: isClassIII
        ? ['صنف ثالث', 'class iii', 'هيكلي']
        : isClassII
        ? ['صنف ثان', 'class ii', 'هيكلي']
        : [val.toLowerCase()],
    });
  }

  if (diag.dentalClass?.trim() && !isNormalClassification(diag.dentalClass)) {
    const val = diag.dentalClass.trim();
    const isClassIII = /iii|ثالث|3/i.test(val);
    const isClassII = !isClassIII && /ii|ثان|2/i.test(val);
    pushProblem({
      id: 'auto-diag-dental',
      sourceTag: 'diagnosis',
      category: 'dental',
      title: isAr ? `سوء إطباق سني: ${val}` : `Dental Malocclusion: ${val}`,
      description: isAr
        ? 'تم إدراجه تلقائياً من التصنيف السني في التشخيص.'
        : 'Automatically derived from Dental Class in Clinical Diagnosis.',
      evidenceLinks: [
        {
          type: 'exam',
          refId: 'diag-dental',
          label: isAr ? `التصنيف السني: ${val}` : `Dental Class: ${val}`,
        },
      ],
      priority: 'high',
      status: 'active',
      overlapTokens: isClassIII
        ? ['صنف ثالث', 'class iii', 'سني', 'أرحاء']
        : isClassII
        ? ['صنف ثان', 'class ii', 'أرحاء']
        : [val.toLowerCase()],
    });
  }

  if (diag.verticalPattern?.trim() && !isNormalClassification(diag.verticalPattern)) {
    const val = diag.verticalPattern.trim();
    pushProblem({
      id: 'auto-diag-vertical',
      sourceTag: 'diagnosis',
      category: 'skeletal',
      title: isAr ? `اضطراب النمط العمودي: ${val}` : `Vertical Growth Pattern: ${val}`,
      description: isAr
        ? 'تم إدراجه تلقائياً من تقييم النمط العمودي في التشخيص.'
        : 'Automatically derived from Vertical Pattern in Clinical Diagnosis.',
      evidenceLinks: [
        {
          type: 'exam',
          refId: 'diag-vertical',
          label: isAr ? `النمط العمودي: ${val}` : `Vertical Pattern: ${val}`,
        },
      ],
      priority: 'medium',
      status: 'active',
      overlapTokens: ['عمودي', 'vertical', 'high angle', 'low angle', 'open', 'deep', val.toLowerCase()],
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 2. CLINICAL EXAM (EXTRAORAL + INTRAORAL + FDI CHART)
  // ════════════════════════════════════════════════════════════════════════════
  const eo = patient.clinicalExam.extraoral;
  const io = patient.clinicalExam.intraoral;

  const eoRules: Array<{
    key: keyof typeof eo;
    id: string;
    category: ProblemCategory;
    titleAr: (v: string) => string;
    titleEn: (v: string) => string;
    priority: 'high' | 'medium' | 'low';
    labelAr: string;
    labelEn: string;
    overlapTokens?: string[];
  }> = [
    {
      key: 'symmetry',
      id: 'auto-exam-eo-symmetry',
      category: 'skeletal',
      titleAr: (v) => `عدم تناظر وجهي: ${v}`,
      titleEn: (v) => `Facial Asymmetry: ${v}`,
      priority: 'high',
      labelAr: 'الفحص خارج الفم — تناسق الوجه',
      labelEn: 'Extraoral Exam — Symmetry',
      overlapTokens: ['تناظر', 'تماثل', 'asymmetry'],
    },
    {
      key: 'facialProportions',
      id: 'auto-exam-eo-proportions',
      category: 'skeletal',
      titleAr: (v) => `اختلال الأثلاث الوجهية: ${v}`,
      titleEn: (v) => `Facial Proportions Discrepancy: ${v}`,
      priority: 'medium',
      labelAr: 'الفحص خارج الفم — النسب الوجهية',
      labelEn: 'Extraoral Exam — Facial Proportions',
      overlapTokens: ['أثلاث', 'ثلث', 'proportions'],
    },
    {
      key: 'profile',
      id: 'auto-exam-eo-profile',
      category: 'soft_tissue',
      titleAr: (v) => `تغير في البروفايل الجانبي: ${v}`,
      titleEn: (v) => `Facial Profile Finding: ${v}`,
      priority: 'medium',
      labelAr: 'الفحص خارج الفم — البروفايل',
      labelEn: 'Extraoral Exam — Profile',
      overlapTokens: ['بروفايل', 'profile', 'محدب', 'مقعر', 'convex', 'concave'],
    },
    {
      key: 'lipCompetence',
      id: 'auto-exam-eo-lips',
      category: 'soft_tissue',
      titleAr: (v) => `مشكلة وضع/كفاءة الشفتين: ${v}`,
      titleEn: (v) => `Lip Posture / Competence Issue: ${v}`,
      priority: 'medium',
      labelAr: 'الفحص خارج الفم — الشفتان',
      labelEn: 'Extraoral Exam — Lips',
      overlapTokens: ['شفة', 'شفتين', 'incompetent', 'lip'],
    },
    {
      key: 'smileArc',
      id: 'auto-exam-eo-smile',
      category: 'soft_tissue',
      titleAr: (v) => `ملاحظة قوس الابتسامة: ${v}`,
      titleEn: (v) => `Smile Arc Finding: ${v}`,
      priority: 'low',
      labelAr: 'الفحص خارج الفم — قوس الابتسامة',
      labelEn: 'Extraoral Exam — Smile Arc',
      overlapTokens: ['قوس الابتسامة', 'smile arc'],
    },
    {
      key: 'gingivalDisplay',
      id: 'auto-exam-eo-gingiva',
      category: 'soft_tissue',
      titleAr: (v) => `ظهور لثوي غير متناسق: ${v}`,
      titleEn: (v) => `Gingival Display Finding: ${v}`,
      priority: 'medium',
      labelAr: 'الفحص خارج الفم — اللثة والابتسامة',
      labelEn: 'Extraoral Exam — Gingival Display',
      overlapTokens: ['ابتسامة لثوية', 'gummy', 'gingival display'],
    },
    {
      key: 'tmjFunction',
      id: 'auto-exam-eo-tmj',
      category: 'functional',
      titleAr: (v) => `اضطراب المفصل الفكي (TMJ): ${v}`,
      titleEn: (v) => `TMJ Functional Finding: ${v}`,
      priority: 'medium',
      labelAr: 'فحص المفصل الفكي (TMJ)',
      labelEn: 'Extraoral Exam — TMJ',
      overlapTokens: ['مفصل', 'طقطقة', 'tmj', 'clicking'],
    },
  ];

  for (const r of eoRules) {
    const field = eo[r.key];
    if (typeof field !== 'string' && field.status === 'finding') {
      const valText = field.value.trim() || (isAr ? 'نتيجة سريرية' : 'Clinical finding');
      const isUrgent = /ألم|تحدد|شديد|pain|lock|deviat/i.test(valText);
      pushProblem({
        id: r.id,
        sourceTag: 'exam',
        category: r.category,
        title: isAr ? r.titleAr(valText) : r.titleEn(valText),
        description: field.note?.trim() || (isAr ? 'ملاحظة مسجلة أثناء الفحص السريري خارج الفم.' : 'Recorded during extraoral clinical exam.'),
        evidenceLinks: [{ type: 'exam', refId: r.id, label: `${isAr ? r.labelAr : r.labelEn}: ${valText}` }],
        priority: isUrgent ? 'high' : r.priority,
        status: 'active',
        overlapTokens: r.overlapTokens,
      });
    }
  }

  // Intraoral Molar & Canine relationships (combined cleanly R/L)
  if (io.molarRelRight.status === 'finding' || io.molarRelLeft.status === 'finding') {
    const rVal = io.molarRelRight.value || '—';
    const lVal = io.molarRelLeft.value || '—';
    pushProblem({
      id: 'auto-exam-io-molar',
      sourceTag: 'exam',
      category: 'dental',
      title: isAr
        ? `انحراف علاقة الأرحاء (يمين: ${rVal} / يسار: ${lVal})`
        : `Abnormal Molar Relationship (R: ${rVal} / L: ${lVal})`,
      description: isAr ? 'عدم انتظام علاقة الأرحاء الأولى المسجلة في الفحص داخل الفم.' : 'Recorded molar discrepancy on intraoral exam.',
      evidenceLinks: [
        { type: 'exam', refId: 'exam-molar', label: isAr ? `الأرحاء: ${rVal} | ${lVal}` : `Molars: ${rVal} | ${lVal}` },
      ],
      priority: 'high',
      status: 'active',
      overlapTokens: ['أرحاء', 'molar', 'class ii', 'class iii'],
    });
  }

  if (io.canineRelRight.status === 'finding' || io.canineRelLeft.status === 'finding') {
    const rVal = io.canineRelRight.value || '—';
    const lVal = io.canineRelLeft.value || '—';
    pushProblem({
      id: 'auto-exam-io-canine',
      sourceTag: 'exam',
      category: 'dental',
      title: isAr
        ? `انحراف علاقة الأنياب (يمين: ${rVal} / يسار: ${lVal})`
        : `Abnormal Canine Relationship (R: ${rVal} / L: ${lVal})`,
      description: isAr ? 'عدم تطابق علاقة الأنياب الصنف الأول.' : 'Recorded canine discrepancy on intraoral exam.',
      evidenceLinks: [
        { type: 'exam', refId: 'exam-canine', label: isAr ? `الأنياب: ${rVal} | ${lVal}` : `Canines: ${rVal} | ${lVal}` },
      ],
      priority: 'high',
      status: 'active',
      overlapTokens: ['أنياب', 'canine'],
    });
  }

  if (io.overjetMm.status === 'finding') {
    const v = io.overjetMm.value.trim() || '—';
    pushProblem({
      id: 'auto-exam-io-overjet',
      sourceTag: 'exam',
      category: 'dental',
      title: isAr ? `خلل البروز الأفقي (Overjet: ${v})` : `Overjet Discrepancy (${v})`,
      description: io.overjetMm.note || (isAr ? 'زيادة أو نقص/انعكاس في البروز الأفقي للأسنان الأمامية.' : 'Abnormal horizontal incisor overjet.'),
      evidenceLinks: [{ type: 'exam', refId: 'exam-overjet', label: `Overjet: ${v}` }],
      priority: 'medium',
      status: 'active',
      overlapTokens: ['overjet', 'بروز أفقي', 'بروز علوي'],
    });
  }

  if (io.deepBite.status === 'finding' || io.overbiteMm.status === 'finding') {
    const v = io.deepBite.status === 'finding' && io.deepBite.value ? io.deepBite.value : io.overbiteMm.value || '—';
    const isOpenMentioned = /مفتوح|open/i.test(v);
    if (!isOpenMentioned) {
      pushProblem({
        id: 'auto-exam-io-overbite',
        sourceTag: 'exam',
        category: 'dental',
        title: isAr ? `عضة عميقة / زيادة التغطية العمودية (${v})` : `Deep Bite / Overbite Finding (${v})`,
        description: io.deepBite.note || io.overbiteMm.note || (isAr ? 'زيادة التغطية العمودية للقواطع مع تعمق محتمل في قوس سبي.' : 'Increased vertical incisor overlap.'),
        evidenceLinks: [{ type: 'exam', refId: 'exam-overbite', label: `Overbite / Deep Bite: ${v}` }],
        priority: 'medium',
        status: 'active',
        overlapTokens: ['عميقة', 'deep bite', 'overbite', 'تغطية عمودية'],
      });
    }
  }

  if (io.openBite.status === 'finding') {
    const v = io.openBite.value.trim() || (isAr ? 'عضة مفتوحة' : 'Open bite');
    pushProblem({
      id: 'auto-exam-io-openbite',
      sourceTag: 'exam',
      category: 'dental',
      title: isAr ? `عضة مفتوحة: ${v}` : `Open Bite: ${v}`,
      description: io.openBite.note || (isAr ? 'انعدام التلامس الإطباقي العمودي المسجل بالفحص السريري.' : 'Recorded vertical open bite.'),
      evidenceLinks: [{ type: 'exam', refId: 'exam-openbite', label: `Open Bite: ${v}` }],
      priority: 'high',
      status: 'active',
      overlapTokens: ['مفتوحة', 'open bite'],
    });
  }

  if (io.midlineUpper.status === 'finding' || io.midlineLower.status === 'finding') {
    const uVal = io.midlineUpper.value || (isAr ? '—' : '—');
    const lVal = io.midlineLower.value || (isAr ? '—' : '—');
    pushProblem({
      id: 'auto-exam-io-midline',
      sourceTag: 'exam',
      category: 'dental',
      title: isAr
        ? `انحراف الخط المتوسط (علوي: ${uVal} / سفلي: ${lVal})`
        : `Dental Midline Deviation (U: ${uVal} / L: ${lVal})`,
      description: isAr ? 'عدم تطابق الخط المتوسط السني مع الوجهي أو بين الفكين.' : 'Midline shift recorded in intraoral exam.',
      evidenceLinks: [{ type: 'exam', refId: 'exam-midline', label: `Midline U:${uVal} L:${lVal}` }],
      priority: 'medium',
      status: 'active',
      overlapTokens: ['خط متوسط', 'الخط المتوسط', 'midline'],
    });
  }

  if (io.crowdingUpper.status === 'finding') {
    const v = io.crowdingUpper.value.trim() || '—';
    const isSpacing = /فراغ|فلجة|spacing|diastema/i.test(v);
    pushProblem({
      id: 'auto-exam-io-crowd-u',
      sourceTag: 'exam',
      category: 'dental',
      title: isAr
        ? `${isSpacing ? 'فراغات' : 'ازدحام'} القوس العلوي (${v})`
        : `Upper Arch ${isSpacing ? 'Spacing' : 'Crowding'} (${v})`,
      description: io.crowdingUpper.note || (isAr ? 'تفاوت في المساحة المتاحة بالفك العلوي.' : 'Upper arch length-tooth size discrepancy.'),
      evidenceLinks: [{ type: 'exam', refId: 'exam-crowd-u', label: isAr ? `علوي: ${v}` : `Upper: ${v}` }],
      priority: 'high',
      status: 'active',
      overlapTokens: isSpacing ? ['فراغ', 'spacing', 'diastema'] : ['ازدحام', 'تراكب', 'crowding'],
    });
  }

  if (io.crowdingLower.status === 'finding') {
    const v = io.crowdingLower.value.trim() || '—';
    const isSpacing = /فراغ|فلجة|spacing|diastema/i.test(v);
    pushProblem({
      id: 'auto-exam-io-crowd-l',
      sourceTag: 'exam',
      category: 'dental',
      title: isAr
        ? `${isSpacing ? 'فراغات' : 'ازدحام'} القوس السفلي (${v})`
        : `Lower Arch ${isSpacing ? 'Spacing' : 'Crowding'} (${v})`,
      description: io.crowdingLower.note || (isAr ? 'تفاوت في المساحة المتاحة بالفك السفلي.' : 'Lower arch length-tooth size discrepancy.'),
      evidenceLinks: [{ type: 'exam', refId: 'exam-crowd-l', label: isAr ? `سفلي: ${v}` : `Lower: ${v}` }],
      priority: 'high',
      status: 'active',
      overlapTokens: isSpacing ? ['فراغ', 'spacing'] : ['ازدحام', 'تراكب', 'crowding'],
    });
  }

  if (io.crossbite.status === 'finding') {
    const v = io.crossbite.value.trim() || (isAr ? 'عضة معكوسة' : 'Crossbite');
    pushProblem({
      id: 'auto-exam-io-crossbite',
      sourceTag: 'exam',
      category: 'dental',
      title: isAr ? `عضة معكوسة: ${v}` : `Crossbite: ${v}`,
      description: io.crossbite.note || (isAr ? 'تراكب معكوس أمامي أو خلفي يستدعي التوسيع أو التصحيح الفردي.' : 'Anterior or posterior crossbite noted on exam.'),
      evidenceLinks: [{ type: 'exam', refId: 'exam-crossbite', label: `Crossbite: ${v}` }],
      priority: 'high',
      status: 'active',
      overlapTokens: ['معكوسة', 'crossbite'],
    });
  }

  if (io.gingivalHealth.status === 'finding') {
    const v = io.gingivalHealth.value.trim() || (isAr ? 'التهاب لثوي' : 'Gingival issue');
    pushProblem({
      id: 'auto-exam-io-gingiva',
      sourceTag: 'exam',
      category: 'functional',
      title: isAr ? `مشكلة لثوية / نسج داعمة: ${v}` : `Periodontal / Gingival Finding: ${v}`,
      description: io.gingivalHealth.note || (isAr ? 'يتطلب تهيئة لثوية وعناية فموية قبل التثبيت.' : 'Requires periodontal management prior to appliance bonding.'),
      evidenceLinks: [{ type: 'exam', refId: 'exam-gingiva', label: v }],
      priority: 'high',
      status: 'active',
      overlapTokens: ['لثوية', 'التهاب لث', 'gingiv', 'periodont'],
    });
  }

  if (io.archFormUpper.status === 'finding' || io.archFormLower.status === 'finding') {
    const uV = io.archFormUpper.status === 'finding' ? io.archFormUpper.value : '';
    const lV = io.archFormLower.status === 'finding' ? io.archFormLower.value : '';
    const summary = [uV && `${isAr ? 'علوي' : 'U'}: ${uV}`, lV && `${isAr ? 'سفلي' : 'L'}: ${lV}`].filter(Boolean).join(' · ');
    pushProblem({
      id: 'auto-exam-io-archform',
      sourceTag: 'exam',
      category: 'dental',
      title: isAr ? `شذوذ / تضيق شكل القوس (${summary})` : `Arch Form Discrepancy (${summary})`,
      description: isAr ? 'عدم تناسق أو تضيق في شكل القوس السني.' : 'Abnormal or constricted arch form.',
      evidenceLinks: [{ type: 'exam', refId: 'exam-archform', label: summary }],
      priority: 'medium',
      status: 'active',
      overlapTokens: ['ضيق القوس', 'مستدق', 'constricted', 'tapered'],
    });
  }

  // FDI Chart notable teeth
  const fdiEntries = Object.values(patient.clinicalExam.fdiChart || {});
  const impacted = fdiEntries.filter((t) => t.status === 'impacted').map((t) => `#${t.fdi}`);
  const missing = fdiEntries.filter((t) => t.status === 'missing').map((t) => `#${t.fdi}`);
  const extractPlanned = fdiEntries.filter((t) => t.status === 'extract_planned').map((t) => `#${t.fdi}`);
  const caries = fdiEntries.filter((t) => t.status === 'caries').map((t) => `#${t.fdi}`);

  if (impacted.length > 0) {
    pushProblem({
      id: 'auto-fdi-impacted',
      sourceTag: 'exam',
      category: 'dental',
      title: isAr ? `أسنان منطمرة: ${impacted.join('، ')}` : `Impacted Teeth: ${impacted.join(', ')}`,
      description: isAr ? 'مرصودة في مخطط FDI — تتطلب مسار بزوغ أو كشف جراحي/جر تقويمي.' : 'Marked impacted on FDI chart.',
      evidenceLinks: [{ type: 'exam', refId: 'fdi-impacted', label: `FDI: ${impacted.join(', ')}` }],
      priority: 'high',
      status: 'active',
      overlapTokens: ['منطمر', 'impacted'],
    });
  }
  if (extractPlanned.length > 0) {
    pushProblem({
      id: 'auto-fdi-extract',
      sourceTag: 'exam',
      category: 'dental',
      title: isAr ? `أسنان مقترحة/مخططة للخلع: ${extractPlanned.join('، ')}` : `Teeth Planned for Extraction: ${extractPlanned.join(', ')}`,
      description: isAr ? 'مسجلة في مخطط FDI كحالات خلع علاجي.' : 'Marked for extraction on FDI chart.',
      evidenceLinks: [{ type: 'exam', refId: 'fdi-extract', label: `FDI: ${extractPlanned.join(', ')}` }],
      priority: 'high',
      status: 'active',
      overlapTokens: ['خلع', 'extract'],
    });
  }
  if (missing.length > 0) {
    pushProblem({
      id: 'auto-fdi-missing',
      sourceTag: 'exam',
      category: 'dental',
      title: isAr ? `أسنان مفقودة / غير موجودة: ${missing.join('، ')}` : `Missing Teeth: ${missing.join(', ')}`,
      description: isAr ? 'مسجلة كمفقودة في مخطط FDI — يُقيّم التعويض أو إغلاق المسافة.' : 'Marked missing on FDI chart.',
      evidenceLinks: [{ type: 'exam', refId: 'fdi-missing', label: `FDI: ${missing.join(', ')}` }],
      priority: 'medium',
      status: 'active',
      overlapTokens: ['مفقود', 'missing'],
    });
  }
  if (caries.length > 0) {
    pushProblem({
      id: 'auto-fdi-caries',
      sourceTag: 'exam',
      category: 'dental',
      title: isAr ? `نخور / تسوس يتطلب ترميماً: ${caries.join('، ')}` : `Carious Teeth Requiring Restoration: ${caries.join(', ')}`,
      description: isAr ? 'يجب معالجة التسوسات تحفظياً قبل أو بالتزامن مع المعالجة التقويمية.' : 'Must be restored prior to orthodontic bonding.',
      evidenceLinks: [{ type: 'exam', refId: 'fdi-caries', label: `FDI: ${caries.join(', ')}` }],
      priority: 'medium',
      status: 'active',
      overlapTokens: ['تسوس', 'نخور', 'caries'],
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 3. PHOTO ANALYSIS (EXTRAORAL + INTRAORAL)
  // ════════════════════════════════════════════════════════════════════════════
  const latestPhotoByMode = new Map<string, MeasurementAnalysis>();
  for (const a of patient.analyses) {
    if (a.analysisType === 'photo_analysis' && a.photoViewMode && !latestPhotoByMode.has(a.photoViewMode)) {
      latestPhotoByMode.set(a.photoViewMode, a);
    }
  }

  // 3A. Extraoral Frontal
  const pFrontal = latestPhotoByMode.get('frontal');
  if (pFrontal) {
    const lower3 = getMetric(pFrontal, 'FACIAL_LOWER_THIRD');
    if (lower3 !== null && (lower3 > 37 || lower3 < 29)) {
      pushProblem({
        id: 'auto-photo-frontal-lower3',
        sourceTag: 'photo',
        category: 'skeletal',
        title: isAr
          ? `${lower3 > 37 ? 'زيادة' : 'نقص'} ارتفاع الثلث الوجهي السفلي (${lower3}%)`
          : `${lower3 > 37 ? 'Increased' : 'Reduced'} Lower Facial Third (${lower3}%)`,
        description: isAr ? 'مستخرج من تحليل الصورة الوجهية الأمامية (Norm 33% ± 3%).' : 'Derived from Frontal Photo Analysis.',
        evidenceLinks: [{ type: 'analysis', refId: pFrontal.id, label: `Frontal Photo: ${lower3}%` }],
        priority: 'medium',
        status: 'active',
      });
    }
    const cant = getMetric(pFrontal, 'COMMISSURE_CANT');
    if (cant !== null && cant > 2.5) {
      pushProblem({
        id: 'auto-photo-frontal-cant',
        sourceTag: 'photo',
        category: 'soft_tissue',
        title: isAr ? `ميلان مستوى الشفتين / الإطباق الأمامي (${cant}°)` : `Lip Commissure Cant (${cant}°)`,
        description: isAr ? 'عدم توازي خط الشفتين مع خط الحدقتين في تحليل الصورة الأمامية.' : 'Commissure line diverges from interpupillary line.',
        evidenceLinks: [{ type: 'analysis', refId: pFrontal.id, label: `Cant: ${cant}°` }],
        priority: 'medium',
        status: 'active',
      });
    }
    const midShift = getMetric(pFrontal, 'MIDLINE_SHIFT_PHOTO');
    if (midShift !== null && midShift > 1.5) {
      pushProblem({
        id: 'auto-photo-frontal-midline',
        sourceTag: 'photo',
        category: 'dental',
        title: isAr ? `انحراف الخط المتوسط السني عن الوجهي (${midShift} مم)` : `Dental-to-Facial Midline Shift (${midShift} mm)`,
        description: isAr ? 'انحراف يتجاوز 1.5 مم في تحليل الوجه الأمامي.' : 'Exceeds 1.5 mm threshold on frontal photo.',
        evidenceLinks: [{ type: 'analysis', refId: pFrontal.id, label: `Midline Shift: ${midShift} mm` }],
        priority: 'medium',
        status: 'active',
        overlapTokens: ['خط متوسط', 'midline'],
      });
    }
  }

  // 3B. Extraoral Profile
  const pProfile = latestPhotoByMode.get('profile');
  if (pProfile) {
    const conv = getMetric(pProfile, 'PHOTO_CONVEXITY');
    if (conv !== null && (conv > 16 || conv < 6)) {
      pushProblem({
        id: 'auto-photo-profile-convexity',
        sourceTag: 'photo',
        category: 'soft_tissue',
        title: isAr
          ? `${conv > 16 ? 'تحدب بروفايل زائد (Class II tendency)' : 'بروفايل مسطح/مقعر (Class III tendency)'} (${conv}°)`
          : `${conv > 16 ? 'Convex Facial Profile' : 'Concave/Flat Facial Profile'} (${conv}°)`,
        description: isAr ? 'مستخرج من زاوية G-Sn-Pog′ في تحليل البروفايل الجانبي.' : 'Derived from G-Sn-Pog′ angle in Profile Photo Analysis.',
        evidenceLinks: [{ type: 'analysis', refId: pProfile.id, label: `Convexity: ${conv}°` }],
        priority: 'medium',
        status: 'active',
        overlapTokens: conv > 16 ? ['محدب', 'convex', 'class ii'] : ['مقعر', 'concave', 'class iii'],
      });
    }
    const nla = getMetric(pProfile, 'PHOTO_NASOLABIAL');
    if (nla !== null && (nla < 90 || nla > 112)) {
      pushProblem({
        id: 'auto-photo-profile-nla',
        sourceTag: 'photo',
        category: 'soft_tissue',
        title: isAr
          ? `زاوية أنفية شفوية ${nla < 90 ? 'حادة' : 'منفرجة'} (${nla}°)`
          : `${nla < 90 ? 'Acute' : 'Obtuse'} Nasolabial Angle (${nla}°)`,
        description: isAr ? 'مهم لتخطيط إرجاع القواطع أو تفادي التراجع الشفوي عند الخلع.' : 'Relevant to incisor retraction and lip support planning.',
        evidenceLinks: [{ type: 'analysis', refId: pProfile.id, label: `NLA: ${nla}°` }],
        priority: 'low',
        status: 'active',
      });
    }
    const lsE = getMetric(pProfile, 'PHOTO_LS_E');
    const liE = getMetric(pProfile, 'PHOTO_LI_E');
    if ((lsE !== null && (lsE > -1 || lsE < -7)) || (liE !== null && (liE > 1 || liE < -5))) {
      pushProblem({
        id: 'auto-photo-profile-lips',
        sourceTag: 'photo',
        category: 'soft_tissue',
        title: isAr
          ? `انحراف بروز الشفاه عن خط Ricketts E (Ls: ${lsE ?? '—'} / Li: ${liE ?? '—'} مم)`
          : `Lip Protrusion/Retrusion to E-Line (Ls: ${lsE ?? '—'} / Li: ${liE ?? '—'} mm)`,
        description: isAr ? 'خروج وضع الشفاه عن النطاق الجمالي في تحليل البروفايل.' : 'Lip position outside Ricketts E-Line norm.',
        evidenceLinks: [{ type: 'analysis', refId: pProfile.id, label: `E-Line Ls:${lsE ?? '—'} Li:${liE ?? '—'}` }],
        priority: 'medium',
        status: 'active',
      });
    }
  }

  // 3C. Extraoral Smile
  const pSmile = latestPhotoByMode.get('smile');
  if (pSmile) {
    const corr = getMetric(pSmile, 'BUCCAL_CORRIDOR');
    if (corr !== null && corr > 20) {
      pushProblem({
        id: 'auto-photo-smile-corridor',
        sourceTag: 'photo',
        category: 'soft_tissue',
        title: isAr ? `ممر شدقي عريض بالابتسامة (${corr}%)` : `Wide Buccal Corridor (${corr}%)`,
        description: isAr ? 'يوحي بتضيق عرض القوس العلوي — يُوصى بتقييم التوسيع.' : 'Suggests transverse maxillary constriction.',
        evidenceLinks: [{ type: 'analysis', refId: pSmile.id, label: `Buccal Corridor: ${corr}%` }],
        priority: 'medium',
        status: 'active',
      });
    }
    const gummy = getMetric(pSmile, 'GINGIVAL_DISPLAY_MM');
    if (gummy !== null && gummy > 3.0) {
      pushProblem({
        id: 'auto-photo-smile-gummy',
        sourceTag: 'photo',
        category: 'soft_tissue',
        title: isAr ? `ابتسامة لثوية زائدة (${gummy} مم)` : `Excessive Gingival Display / Gummy Smile (${gummy} mm)`,
        description: isAr ? 'ظهور لثوي يتجاوز 3 مم عند الابتسامة الكاملة.' : 'Gingival display exceeds 3.0 mm during full smile.',
        evidenceLinks: [{ type: 'analysis', refId: pSmile.id, label: `Gingival Display: ${gummy} mm` }],
        priority: 'medium',
        status: 'active',
      });
    }
    const incDisp = getMetric(pSmile, 'INCISOR_DISPLAY_PCT');
    if (incDisp !== null && incDisp < 75) {
      pushProblem({
        id: 'auto-photo-smile-incisor',
        sourceTag: 'photo',
        category: 'soft_tissue',
        title: isAr ? `انخفاض ظهور القاطع العلوي أثناء الابتسام (${incDisp}%)` : `Reduced Incisor Display on Smile (${incDisp}%)`,
        description: isAr ? 'ابتسامة منخفضة (<75% من تاج #11).' : 'Less than 75% upper incisor crown display.',
        evidenceLinks: [{ type: 'analysis', refId: pSmile.id, label: `Incisor Display: ${incDisp}%` }],
        priority: 'medium',
        status: 'active',
      });
    }
    const smileArc = getMetric(pSmile, 'SMILE_ARC_PARALLEL');
    if (smileArc !== null && smileArc > 7) {
      pushProblem({
        id: 'auto-photo-smile-arc',
        sourceTag: 'photo',
        category: 'soft_tissue',
        title: isAr ? `تسطح قوس الابتسامة (تفاوت ${smileArc}°)` : `Flattened Smile Arc (${smileArc}° divergence)`,
        description: isAr ? 'عدم توازي انحناء الحواف القاطعة العلوية مع الشفة السفلى.' : 'Upper incisal curve diverges from lower lip curvature.',
        evidenceLinks: [{ type: 'analysis', refId: pSmile.id, label: `Smile Arc Diff: ${smileArc}°` }],
        priority: 'low',
        status: 'active',
      });
    }
    const smileMid = getMetric(pSmile, 'SMILE_MIDLINE_SHIFT');
    if (smileMid !== null && smileMid > 1.5) {
      pushProblem({
        id: 'auto-photo-smile-midline',
        sourceTag: 'photo',
        category: 'dental',
        title: isAr ? `انحراف الخط المتوسط بالابتسامة (${smileMid} مم)` : `Smile Midline Deviation (${smileMid} mm)`,
        description: isAr ? 'إزاحة بين الخط المتوسط السني والنثرة الوجهية.' : 'Dental midline offset from philtrum.',
        evidenceLinks: [{ type: 'analysis', refId: pSmile.id, label: `Smile Midline: ${smileMid} mm` }],
        priority: 'medium',
        status: 'active',
        overlapTokens: ['خط متوسط', 'midline'],
      });
    }
  }

  // 3D. Intraoral Frontal Photo
  const pIoFront = latestPhotoByMode.get('intraoral_frontal');
  if (pIoFront) {
    const midMm = getMetric(pIoFront, 'INTRA_MIDLINE_DEV_MM');
    const midPct = getMetric(pIoFront, 'INTRA_MIDLINE_DEV_PCT');
    if ((midMm !== null && midMm > 1.5) || (midMm === null && midPct !== null && midPct > 18)) {
      const descVal = midMm !== null ? `${midMm} mm` : `${midPct}%`;
      pushProblem({
        id: 'auto-photo-io-frontal-midline',
        sourceTag: 'photo',
        category: 'dental',
        title: isAr ? `انحراف الخط المتوسط بين الفكين في الصورة داخل الفم (${descVal})` : `Intraoral Inter-Arch Midline Shift (${descVal})`,
        description: isAr ? 'عدم تطابق الخط المتوسط العلوي 11-21 مع السفلي 41-31.' : 'Upper and lower dental midlines do not coincide.',
        evidenceLinks: [{ type: 'analysis', refId: pIoFront.id, label: `Intraoral Frontal: ${descVal}` }],
        priority: 'medium',
        status: 'active',
        overlapTokens: ['خط متوسط', 'midline'],
      });
    }
    const cant = getMetric(pIoFront, 'INTRA_OCCLUSAL_CANT');
    if (cant !== null && cant > 2.5) {
      pushProblem({
        id: 'auto-photo-io-frontal-cant',
        sourceTag: 'photo',
        category: 'dental',
        title: isAr ? `ميلان المستوى الإطباقي الأمامي بالصورة (${cant}°)` : `Anterior Occlusal Cant on Photo (${cant}°)`,
        description: isAr ? 'اختلاف مستوى الأنياب العلوية #13 و #23 يتجاوز 2.5°.' : 'Canine occlusal plane cant exceeds 2.5°.',
        evidenceLinks: [{ type: 'analysis', refId: pIoFront.id, label: `Occlusal Cant: ${cant}°` }],
        priority: 'medium',
        status: 'active',
      });
    }
    const obPct = getMetric(pIoFront, 'INTRA_OVERBITE_PCT');
    const obMm = getMetric(pIoFront, 'INTRA_OVERBITE_MM');
    if ((obPct !== null && (obPct > 45 || obPct < 5)) || (obMm !== null && (obMm > 4.0 || obMm < 0.5))) {
      const isDeep = (obPct !== null && obPct > 45) || (obMm !== null && obMm > 4.0);
      const valStr = [obPct !== null ? `${obPct}%` : '', obMm !== null ? `${obMm} mm` : ''].filter(Boolean).join(' / ');
      pushProblem({
        id: 'auto-photo-io-frontal-overbite',
        sourceTag: 'photo',
        category: 'dental',
        title: isAr
          ? `${isDeep ? 'عضة عميقة' : 'عضة مفتوحة / حد لحد'} بتحليل الصورة الأمامية (${valStr})`
          : `${isDeep ? 'Deep Bite' : 'Open / Edge-to-Edge Bite'} on Intraoral Photo (${valStr})`,
        description: isAr ? 'مستخرج من تحليل صورة داخل الفم الأمامية.' : 'Derived from Intraoral Frontal photogrammetry.',
        evidenceLinks: [{ type: 'analysis', refId: pIoFront.id, label: `Intraoral Overbite: ${valStr}` }],
        priority: 'high',
        status: 'active',
        overlapTokens: isDeep ? ['عميقة', 'deep bite', 'overbite'] : ['مفتوحة', 'open bite'],
      });
    }
    const gold = getMetric(pIoFront, 'INTRA_GOLDEN_RATIO');
    if (gold !== null && gold < 58) {
      pushProblem({
        id: 'auto-photo-io-frontal-peg',
        sourceTag: 'photo',
        category: 'dental',
        title: isAr ? `ضيق القاطع الرباعي #12 مقارنة بـ #11 (${gold}%)` : `Narrow / Peg Lateral Incisor Ratio (${gold}%)`,
        description: isAr ? 'نسبة عرض #12/#11 أقل من 58% — قد يتطلب بناء تجميلي بعد الرصف.' : 'Lateral-to-central width ratio <58%.',
        evidenceLinks: [{ type: 'analysis', refId: pIoFront.id, label: `#12/#11 Ratio: ${gold}%` }],
        priority: 'low',
        status: 'active',
      });
    }
    const zenith = getMetric(pIoFront, 'INTRA_ZENITH_CANT');
    if (zenith !== null && zenith > 2.5) {
      pushProblem({
        id: 'auto-photo-io-frontal-zenith',
        sourceTag: 'photo',
        category: 'soft_tissue',
        title: isAr ? `تفاوت السمت اللثوي الأمامي #11-#21 (${zenith}°)` : `Gingival Zenith Asymmetry (${zenith}°)`,
        description: isAr ? 'اختلاف ارتفاع الهامش اللثوي بين الثنيتين العلويتين.' : 'Asymmetric gingival margin heights on centrals.',
        evidenceLinks: [{ type: 'analysis', refId: pIoFront.id, label: `Zenith Cant: ${zenith}°` }],
        priority: 'low',
        status: 'active',
      });
    }
  }

  // 3E. Intraoral Right & Left Buccal Photos
  (['intraoral_right', 'intraoral_left'] as const).forEach((sideMode) => {
    const pSide = latestPhotoByMode.get(sideMode);
    if (!pSide) return;
    const sideAr = sideMode === 'intraoral_right' ? 'يمين' : 'يسار';
    const sideEn = sideMode === 'intraoral_right' ? 'Right' : 'Left';

    const molarOff = getMetric(pSide, 'INTRA_MOLAR_SAGITTAL_MM');
    if (molarOff !== null && Math.abs(molarOff) > 1.5) {
      const cls = molarOff > 1.5 ? 'Class II' : 'Class III';
      pushProblem({
        id: `auto-photo-${sideMode}-molar`,
        sourceTag: 'photo',
        category: 'dental',
        title: isAr ? `انحراف علاقة الأرحاء ${sideAr} (${cls} · ${molarOff} مم)` : `${sideEn} Molar Discrepancy (${cls} · ${molarOff} mm)`,
        description: isAr ? `قياس فوتوغرافي سهمي لحدبة U6MB وميزاب L6 في جهة ${sideAr}.` : `Buccal photo sagittal molar offset on ${sideEn}.`,
        evidenceLinks: [{ type: 'analysis', refId: pSide.id, label: `${sideEn} Molar: ${molarOff} mm` }],
        priority: 'high',
        status: 'active',
        overlapTokens: ['أرحاء', 'molar', cls.toLowerCase()],
      });
    }

    const canOff = getMetric(pSide, 'INTRA_CANINE_SAGITTAL_MM');
    if (canOff !== null && Math.abs(canOff) > 1.0) {
      const cls = canOff > 1.0 ? 'Class II' : 'Class III';
      pushProblem({
        id: `auto-photo-${sideMode}-canine`,
        sourceTag: 'photo',
        category: 'dental',
        title: isAr ? `انحراف علاقة الأنياب ${sideAr} (${cls} · ${canOff} مم)` : `${sideEn} Canine Discrepancy (${cls} · ${canOff} mm)`,
        description: isAr ? `إزاحة ذروة الناب العلوي عن الفراغ السفلي 3-4.` : `Sagittal canine offset on ${sideEn} buccal photo.`,
        evidenceLinks: [{ type: 'analysis', refId: pSide.id, label: `${sideEn} Canine: ${canOff} mm` }],
        priority: 'high',
        status: 'active',
        overlapTokens: ['أنياب', 'canine'],
      });
    }

    const oj = getMetric(pSide, 'INTRA_BUCCAL_OJ_MM');
    if (oj !== null && (oj > 4.0 || oj < 0.5)) {
      pushProblem({
        id: `auto-photo-${sideMode}-oj`,
        sourceTag: 'photo',
        category: 'dental',
        title: isAr
          ? `${oj > 4 ? 'زيادة البروز الأفقي' : 'عضة معكوسة أمامية / حد لحد'} بتحليل ${sideAr} (${oj} مم)`
          : `${oj > 4 ? 'Increased Overjet' : 'Reverse/Edge Overjet'} on ${sideEn} Photo (${oj} mm)`,
        description: isAr ? 'مستخرج من قياس الصورة الجانبية داخل الفم.' : 'Measured from intraoral buccal photograph.',
        evidenceLinks: [{ type: 'analysis', refId: pSide.id, label: `Photo Overjet: ${oj} mm` }],
        priority: 'high',
        status: 'active',
        overlapTokens: oj > 4 ? ['overjet', 'بروز'] : ['معكوس', 'crossbite'],
      });
    }

    const u1Inc = getMetric(pSide, 'INTRA_U1_INCLINATION');
    if (u1Inc !== null && (u1Inc < 52 || u1Inc > 70)) {
      pushProblem({
        id: `auto-photo-${sideMode}-u1`,
        sourceTag: 'photo',
        category: 'dental',
        title: isAr
          ? `${u1Inc < 52 ? 'ميلان أمامي زائد' : 'انكفاء'} للقاطع العلوي بصورة ${sideAr} (${u1Inc}°)`
          : `${u1Inc < 52 ? 'Proclined' : 'Retroclined'} Upper Incisor on ${sideEn} Photo (${u1Inc}°)`,
        description: isAr ? 'الزاوية المحورية للقاطع العلوي بالنسبة لمستوى الإطباق.' : 'Incisor axial inclination relative to occlusal plane.',
        evidenceLinks: [{ type: 'analysis', refId: pSide.id, label: `U1-OP: ${u1Inc}°` }],
        priority: 'medium',
        status: 'active',
      });
    }
  });

  // 3F. Intraoral Upper & Lower Occlusal Photos
  (['intraoral_upper', 'intraoral_lower'] as const).forEach((archMode) => {
    const pOcc = latestPhotoByMode.get(archMode);
    if (!pOcc) return;
    const isUp = archMode === 'intraoral_upper';
    const archAr = isUp ? 'العلوي' : 'السفلي';
    const archEn = isUp ? 'Upper' : 'Lower';

    const icw = getMetric(pOcc, 'OCC_INTERCANINE_W');
    const ipw = getMetric(pOcc, 'OCC_INTERPREMOLAR_W');
    const imw = getMetric(pOcc, 'OCC_INTERMOLAR_W');
    const constrictedParts: string[] = [];
    if (icw !== null && icw < (isUp ? 31 : 23)) constrictedParts.push(`3-3: ${icw} mm`);
    if (ipw !== null && ipw < (isUp ? 35 : 28)) constrictedParts.push(`4-4: ${ipw} mm`);
    if (imw !== null && imw < (isUp ? 43 : 37)) constrictedParts.push(`6-6: ${imw} mm`);

    if (constrictedParts.length > 0) {
      pushProblem({
        id: `auto-photo-${archMode}-constriction`,
        sourceTag: 'photo',
        category: 'dental',
        title: isAr
          ? `تضيق عرضي في القوس ${archAr} (${constrictedParts.join(' · ')})`
          : `${archEn} Transverse Arch Constriction (${constrictedParts.join(' · ')})`,
        description: isAr ? 'مستخرج من التحليل الإطباقي للصورة داخل الفم.' : 'Derived from occlusal arch photogrammetry.',
        evidenceLinks: [{ type: 'analysis', refId: pOcc.id, label: `${archEn} Occlusal: ${constrictedParts.join(', ')}` }],
        priority: 'high',
        status: 'active',
      });
    }

    const asym = getMetric(pOcc, 'OCC_TRANSVERSE_SYMMETRY');
    if (asym !== null && asym > 8) {
      pushProblem({
        id: `auto-photo-${archMode}-asym`,
        sourceTag: 'photo',
        category: 'dental',
        title: isAr ? `عدم تناظر عرضي للقوس ${archAr} (${asym}%)` : `${archEn} Transverse Arch Asymmetry (${asym}%)`,
        description: isAr ? 'تفاوت بعد الأرحاء يمين ويسار عن الخط الناصف للقوس.' : 'Left/right arch width asymmetry across midline.',
        evidenceLinks: [{ type: 'analysis', refId: pOcc.id, label: `Asymmetry: ${asym}%` }],
        priority: 'medium',
        status: 'active',
      });
    }

    const ratio = getMetric(pOcc, 'OCC_ARCH_RATIO');
    if (ratio !== null && ratio < 62) {
      pushProblem({
        id: `auto-photo-${archMode}-tapered`,
        sourceTag: 'photo',
        category: 'dental',
        title: isAr ? `قوس ${archAr} مستدق وضيق أمامياً (${ratio}%)` : `Tapered / V-Shaped ${archEn} Arch (${ratio}%)`,
        description: isAr ? 'نسبة 3-3 إلى 6-6 أقل من 62% تشير لتضيق أمامي.' : 'Intercanine/intermolar ratio <62%.',
        evidenceLinks: [{ type: 'analysis', refId: pOcc.id, label: `3-3/6-6: ${ratio}%` }],
        priority: 'medium',
        status: 'active',
      });
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 4. CEPHALOMETRIC & CAST/MIXED ANALYSES
  // ════════════════════════════════════════════════════════════════════════════
  const latestCeph = patient.analyses.find((a) => a.analysisType === 'cephalometric');
  if (latestCeph) {
    const anb = getMetric(latestCeph, 'ANB');
    if (anb !== null && (anb > 4 || anb < 0)) {
      pushProblem({
        id: 'auto-ana-ceph-anb',
        sourceTag: 'analysis',
        category: 'skeletal',
        title: isAr
          ? `تفاوت هيكلي سهمي (ANB = ${anb}° · ${anb > 4 ? 'Class II' : 'Class III'})`
          : `Sagittal Skeletal Discrepancy (ANB = ${anb}° · ${anb > 4 ? 'Class II' : 'Class III'})`,
        description: isAr ? 'مستخرج من التحليل السيفالومتري.' : 'Derived from Cephalometric Analysis.',
        evidenceLinks: [{ type: 'analysis', refId: latestCeph.id, label: `Ceph ANB: ${anb}°` }],
        priority: 'high',
        status: 'active',
        overlapTokens: anb > 4 ? ['صنف ثان', 'class ii', 'anb'] : ['صنف ثالث', 'class iii', 'anb'],
      });
    }
    const fma = getMetric(latestCeph, 'FMA');
    if (fma !== null && (fma > 28 || fma < 22)) {
      pushProblem({
        id: 'auto-ana-ceph-fma',
        sourceTag: 'analysis',
        category: 'skeletal',
        title: isAr
          ? `${fma > 28 ? 'نمو عمودي زائد High Angle' : 'نمو أفقي Low Angle'} (FMA = ${fma}°)`
          : `${fma > 28 ? 'Hyperdivergent' : 'Hypodivergent'} Vertical Pattern (FMA = ${fma}°)`,
        description: isAr ? 'زاوية المستوى الفكي السفلي FMA خارج المعدل الطبيعي (22°–28°).' : 'FMA outside 22°–28° norm.',
        evidenceLinks: [{ type: 'analysis', refId: latestCeph.id, label: `Ceph FMA: ${fma}°` }],
        priority: 'medium',
        status: 'active',
      });
    }
    const impa = getMetric(latestCeph, 'IMPA');
    if (impa !== null && (impa > 96 || impa < 84)) {
      pushProblem({
        id: 'auto-ana-ceph-impa',
        sourceTag: 'analysis',
        category: 'dental',
        title: isAr
          ? `${impa > 96 ? 'بروز/تقدم' : 'انكفاء'} القواطع السفلية (IMPA = ${impa}°)`
          : `${impa > 96 ? 'Proclined' : 'Retroclined'} Lower Incisors (IMPA = ${impa}°)`,
        description: isAr ? 'مستخرج من قياس IMPA السيفالومتري.' : 'Derived from IMPA cephalometric measurement.',
        evidenceLinks: [{ type: 'analysis', refId: latestCeph.id, label: `Ceph IMPA: ${impa}°` }],
        priority: 'medium',
        status: 'active',
      });
    }
  }

  const latestCast = patient.analyses.find((a) => a.analysisType === 'cast_bolton');
  if (latestCast) {
    const uDisc = getMetric(latestCast, 'SPACE_DISC_U') ?? getMetric(latestCast, 'UPPER_SPACE_DISC');
    const lDisc = getMetric(latestCast, 'CAREY_NET_L') ?? getMetric(latestCast, 'SPACE_DISC_L') ?? getMetric(latestCast, 'LOWER_SPACE_DISC');
    if (uDisc !== null && uDisc < -1.5) {
      pushProblem({
        id: 'auto-ana-cast-space-u',
        sourceTag: 'analysis',
        category: 'dental',
        title: isAr ? `عجز مساحة علوي بتحليل القوالب (${uDisc} مم)` : `Upper Arch Space Deficit on Cast (${uDisc} mm)`,
        description: isAr ? 'نقص مسافة مقاس يدوياً/رقمياً في القوس العلوي.' : 'Upper arch perimeter space deficit.',
        evidenceLinks: [{ type: 'analysis', refId: latestCast.id, label: `Upper Space: ${uDisc} mm` }],
        priority: 'high',
        status: 'active',
        overlapTokens: ['ازدحام', 'عجز', 'نقص مسافة', 'crowding'],
      });
    }
    if (lDisc !== null && lDisc < -1.5) {
      pushProblem({
        id: 'auto-ana-cast-space-l',
        sourceTag: 'analysis',
        category: 'dental',
        title: isAr ? `عجز مساحة سفلي بتحليل كاري/القوالب (${lDisc} مم)` : `Lower Arch Space Deficit on Cast (${lDisc} mm)`,
        description: isAr ? 'نقص مسافة في القوس السفلي يستدعي خطة كسب المساحة أو الخلع.' : 'Lower Carey space deficit.',
        evidenceLinks: [{ type: 'analysis', refId: latestCast.id, label: `Lower Space: ${lDisc} mm` }],
        priority: 'high',
        status: 'active',
        overlapTokens: ['ازدحام', 'سفلي', 'crowding'],
      });
    }
    const boltonAntRatio = getMetric(latestCast, 'BOLTON_ANT');
    if (boltonAntRatio !== null && (boltonAntRatio > 79.5 || boltonAntRatio < 74.8)) {
      pushProblem({
        id: 'auto-ana-cast-bolton',
        sourceTag: 'analysis',
        category: 'dental',
        title: isAr
          ? `تفاوت نسبة بولتون الأمامية (${boltonAntRatio}% — ${boltonAntRatio > 79.5 ? 'زيادة سفلية' : 'زيادة علوية'})`
          : `Anterior Bolton Discrepancy (${boltonAntRatio}%)`,
        description: isAr
          ? 'عدم تناسق عرض الأسنان الأمامية العلوية والسفلية (Norm: 77.2% ± 1.65%).'
          : 'Anterior tooth-size ratio outside normal range.',
        evidenceLinks: [{ type: 'analysis', refId: latestCast.id, label: `Bolton Ant: ${boltonAntRatio}%` }],
        priority: 'medium',
        status: 'active',
        overlapTokens: ['بولتون', 'bolton'],
      });
    }
  }

  const latestMixed = patient.analyses.find((a) => a.analysisType === 'mixed_dentition');
  if (latestMixed) {
    const mU = getMetric(latestMixed, 'MOYERS_DISC_U') ?? getMetric(latestMixed, 'HUCKABA_DISC_U');
    const mL = getMetric(latestMixed, 'MOYERS_DISC_L') ?? getMetric(latestMixed, 'HUCKABA_DISC_L');
    if ((mU !== null && mU < -1.5) || (mL !== null && mL < -1.5)) {
      pushProblem({
        id: 'auto-ana-mixed-space',
        sourceTag: 'analysis',
        category: 'dental',
        title: isAr
          ? `عجز مسافة متوقع بالأسنان المختلطة (علوي: ${mU ?? '—'} / سفلي: ${mL ?? '—'} مم)`
          : `Predicted Mixed Dentition Space Deficit (U: ${mU ?? '—'} / L: ${mL ?? '—'} mm)`,
        description: isAr ? 'نقص مسافة لبزوغ الأنياب والضواحك الدائمة.' : 'Insufficient leeway/arch space for permanent successors.',
        evidenceLinks: [{ type: 'analysis', refId: latestMixed.id, label: `Mixed Space U:${mU ?? '—'} L:${mL ?? '—'}` }],
        priority: 'high',
        status: 'active',
        overlapTokens: ['ازدحام', 'مختلط', 'عجز مسافة', 'crowding'],
      });
    }
  }

  return out;
}

function isCoveredByManualProblem(autoProb: ExtractedProblem, manualProblems: ProblemItem[]): boolean {
  if (!autoProb.overlapTokens || autoProb.overlapTokens.length === 0) return false;
  for (const mp of manualProblems) {
    if (mp.category !== autoProb.category) continue;
    const hay = `${mp.title} ${mp.description} ${mp.evidenceLinks.map((e) => e.label).join(' ')}`.toLowerCase();
    if (autoProb.overlapTokens.some((tok) => hay.includes(tok.toLowerCase()))) {
      return true;
    }
  }
  return false;
}

/**
 * Synchronizes auto-extracted clinical problems into patient.problems while:
 * - Preserving all manually entered problems untouched
 * - Respecting dismissed auto-problem IDs (unless ignoreDismissed=true)
 * - Updating active auto-problems if underlying findings change
 * - Preserving clinician-modified status ('improving' | 'resolved') & custom priority
 */
export function syncAutoProblems(
  patient: PatientCase,
  lang: Language,
  options?: { ignoreDismissed?: boolean },
): { nextProblems: ProblemItem[]; nextDismissed: string[]; changed: boolean } {
  const existing = patient.problems || [];
  const manualProblems = existing.filter((p) => !p.id.startsWith('auto-'));
  const existingAutoMap = new Map(existing.filter((p) => p.id.startsWith('auto-')).map((p) => [p.id, p]));
  const dismissed = options?.ignoreDismissed ? new Set<string>() : new Set(patient.dismissedAutoProblemIds || []);

  const extracted = extractClinicalProblems(patient, lang);
  const extractedMap = new Map(extracted.map((e) => [e.id, e]));

  const nextAuto: ProblemItem[] = [];

  for (const ext of extracted) {
    if (dismissed.has(ext.id)) continue;
    const prev = existingAutoMap.get(ext.id);
    if (!prev && isCoveredByManualProblem(ext, manualProblems)) {
      continue;
    }
    const { sourceTag: _s, overlapTokens: _o, ...cleanProb } = ext;
    if (prev) {
      nextAuto.push({
        ...cleanProb,
        priority: prev.priority,
        status: prev.status,
      });
    } else {
      nextAuto.push(cleanProb);
    }
  }

  // Retain resolved/improving auto-problems even if the finding normalized during treatment
  for (const [id, prev] of existingAutoMap.entries()) {
    if (!extractedMap.has(id) && !dismissed.has(id) && prev.status !== 'active') {
      nextAuto.push(prev);
    }
  }

  const nextProblems = [...manualProblems, ...nextAuto];
  const nextDismissed = Array.from(dismissed);

  const prevStr = JSON.stringify(existing);
  const nextStr = JSON.stringify(nextProblems);
  const dismissedChanged =
    JSON.stringify(patient.dismissedAutoProblemIds || []) !== JSON.stringify(nextDismissed);

  return {
    nextProblems,
    nextDismissed,
    changed: prevStr !== nextStr || dismissedChanged,
  };
}
