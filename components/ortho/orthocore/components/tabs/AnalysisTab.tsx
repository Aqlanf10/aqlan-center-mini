"use client";
import React, { useMemo, useState } from 'react';
import {
  Camera,
  ClipboardEdit,
  Crosshair,
  FileBox,
  Save,
  Scan,
  Table,
} from 'lucide-react';
import { AnalysisMetric, Language, MeasurementAnalysis, PatientCase, RecordStage, UserRole } from '../../types/ortho';
import { tr } from '../../i18n/translations';
import {
  MixedDentitionInputs,
  MoyersConfidence,
  computeBoltonAndSpace,
  computeMixedDentitionSuite,
  computePermanentModelSuite,
} from '../../utils/orthoMath';
import { CephTracingStudio } from '../CephTracingStudio';
import { PhotoAnalysisStudio } from '../PhotoAnalysisStudio';
import { Model3DViewer, ScannerMeasurementItem } from '../Model3DViewer';
import { CbctStudio } from '../CbctStudio';

interface AnalysisTabProps {
  patient: PatientCase;
  lang: Language;
  role: UserRole;
  actorName: string;
  onChange: (next: PatientCase, timelineMsg?: { ar: string; en: string }) => void;
}

type AnalysisSubMode = 'ceph' | 'photo' | 'manual' | 'scanner' | 'cbct' | 'compare';

type ManualCephDomain = 'sagittal' | 'vertical' | 'dental_u' | 'dental_l' | 'soft';

interface ManualCephField {
  key: string;
  domain: ManualCephDomain;
  labelAr: string;
  labelEn: string;
  unit: 'deg' | 'mm';
  normRange: string;
  minNorm: number;
  maxNorm: number;
  scaleMin: number;
  scaleMax: number;
  highInterp: string;
  lowInterp: string;
}

const MANUAL_CEPH_FIELDS: ManualCephField[] = [
  { key: 'SNA', domain: 'sagittal', labelAr: 'زاوية SNA (وضع الفك العلوي)', labelEn: 'SNA Angle', unit: 'deg', normRange: '82° ± 2°', minNorm: 80, maxNorm: 84, scaleMin: 70, scaleMax: 94, highInterp: 'تقدم فك علوي', lowInterp: 'تراجع فك علوي' },
  { key: 'SNB', domain: 'sagittal', labelAr: 'زاوية SNB (وضع الفك السفلي)', labelEn: 'SNB Angle', unit: 'deg', normRange: '80° ± 2°', minNorm: 78, maxNorm: 82, scaleMin: 68, scaleMax: 92, highInterp: 'تقدم فك سفلي', lowInterp: 'تراجع فك سفلي' },
  { key: 'ANB', domain: 'sagittal', labelAr: 'زاوية ANB (العلاقة الهيكلية)', labelEn: 'ANB Angle', unit: 'deg', normRange: '2° ± 2°', minNorm: 0, maxNorm: 4, scaleMin: -6, scaleMax: 10, highInterp: 'صنف هيكلي ثانٍ (Class II)', lowInterp: 'صنف هيكلي ثالث (Class III)' },
  { key: 'WITS_MM', domain: 'sagittal', labelAr: 'تقييم ويتس (Wits AO-BO)', labelEn: 'Wits Appraisal', unit: 'mm', normRange: '0 ± 2 mm', minNorm: -2, maxNorm: 2, scaleMin: -8, scaleMax: 10, highInterp: 'علاقة Class II', lowInterp: 'علاقة Class III' },
  { key: 'FMA', domain: 'vertical', labelAr: 'زاوية FMA (فرانكفورت - الفك السفلي)', labelEn: 'FMA Angle', unit: 'deg', normRange: '25° ± 3°', minNorm: 22, maxNorm: 28, scaleMin: 12, scaleMax: 42, highInterp: 'نمو عمودي زائد', lowInterp: 'نمو أفقي' },
  { key: 'SN_GOGN', domain: 'vertical', labelAr: 'زاوية SN-GoGn', labelEn: 'SN-GoGn Angle', unit: 'deg', normRange: '32° ± 4°', minNorm: 28, maxNorm: 36, scaleMin: 18, scaleMax: 48, highInterp: 'زاوية فكية عالية', lowInterp: 'زاوية فكية منخفضة' },
  { key: 'U1_SN', domain: 'dental_u', labelAr: 'ميل القواطع العلوية U1-SN', labelEn: 'U1 to SN', unit: 'deg', normRange: '104° ± 4°', minNorm: 100, maxNorm: 108, scaleMin: 85, scaleMax: 125, highInterp: 'بروز أمامي للعلوي', lowInterp: 'انكفاء للعلوي' },
  { key: 'U1_NA_DEG', domain: 'dental_u', labelAr: 'زاوية U1-NA', labelEn: 'U1 to NA (deg)', unit: 'deg', normRange: '22° ± 4°', minNorm: 18, maxNorm: 26, scaleMin: 6, scaleMax: 40, highInterp: 'بروز محوري علوي', lowInterp: 'انكفاء علوي' },
  { key: 'U1_NA_MM', domain: 'dental_u', labelAr: 'بروز U1-NA (مم)', labelEn: 'U1 to NA (mm)', unit: 'mm', normRange: '4 mm ± 2', minNorm: 2, maxNorm: 6, scaleMin: -2, scaleMax: 12, highInterp: 'تقدم بدني علوي', lowInterp: 'تراجع بدني علوي' },
  { key: 'IMPA', domain: 'dental_l', labelAr: 'ميل القواطع السفلية IMPA', labelEn: 'IMPA Angle', unit: 'deg', normRange: '90° ± 5°', minNorm: 85, maxNorm: 95, scaleMin: 75, scaleMax: 112, highInterp: 'بروز القواطع السفلية', lowInterp: 'انكفاء السفلية' },
  { key: 'L1_NB_DEG', domain: 'dental_l', labelAr: 'زاوية L1-NB', labelEn: 'L1 to NB (deg)', unit: 'deg', normRange: '25° ± 4°', minNorm: 21, maxNorm: 29, scaleMin: 10, scaleMax: 42, highInterp: 'بروز سفلي', lowInterp: 'انكفاء سفلي' },
  { key: 'L1_NB_MM', domain: 'dental_l', labelAr: 'بروز L1-NB (مم)', labelEn: 'L1 to NB (mm)', unit: 'mm', normRange: '4 mm ± 2', minNorm: 2, maxNorm: 6, scaleMin: -2, scaleMax: 12, highInterp: 'تقدم بدني سفلي', lowInterp: 'تراجع بدني سفلي' },
  { key: 'INTERINCISAL', domain: 'dental_l', labelAr: 'الزاوية بين القواطع', labelEn: 'Interincisal Angle', unit: 'deg', normRange: '130° ± 5°', minNorm: 125, maxNorm: 135, scaleMin: 105, scaleMax: 155, highInterp: 'انكفاء القواطع', lowInterp: 'بروز ثنائي القواطع' },
  { key: 'NASOLABIAL', domain: 'soft', labelAr: 'الزاوية الأنفية الشفوية', labelEn: 'Nasolabial Angle', unit: 'deg', normRange: '95° – 110°', minNorm: 95, maxNorm: 110, scaleMin: 70, scaleMax: 135, highInterp: 'منفرجة', lowInterp: 'حادة' },
  { key: 'LS_ELINE', domain: 'soft', labelAr: 'الشفة العليا لخط E', labelEn: 'Upper Lip to E-Line', unit: 'mm', normRange: '-4 mm ± 2', minNorm: -6, maxNorm: -2, scaleMin: -10, scaleMax: 6, highInterp: 'بروز الشفة العليا', lowInterp: 'تراجع الشفة العليا' },
  { key: 'LI_ELINE', domain: 'soft', labelAr: 'الشفة السفلى لخط E', labelEn: 'Lower Lip to E-Line', unit: 'mm', normRange: '-2 mm ± 2', minNorm: -4, maxNorm: 0, scaleMin: -8, scaleMax: 8, highInterp: 'بروز الشفة السفلى', lowInterp: 'تراجع الشفة السفلى' },
];

const MANUAL_CEPH_DOMAIN_GROUPS: Array<{ id: ManualCephDomain; code: string; ar: string; en: string }> = [
  { id: 'sagittal', code: '01', ar: 'العلاقة الهيكلية السهمية (Sagittal Skeletal)', en: '01. Sagittal Skeletal Relationship' },
  { id: 'vertical', code: '02', ar: 'نمط النمو العمودي (Vertical Pattern)', en: '02. Vertical Growth Pattern' },
  { id: 'dental_u', code: '03', ar: 'القواطع العلوية (Maxillary Dentition)', en: '03. Maxillary Dentition' },
  { id: 'dental_l', code: '04', ar: 'القواطع السفلية والعلاقة بين القواطع', en: '04. Mandibular & Interincisal' },
  { id: 'soft', code: '05', ar: 'تحليل الأنسجة الرخوة والشفاه (Soft Tissue)', en: '05. Soft Tissue Profile' },
];


export const AnalysisTab: React.FC<AnalysisTabProps> = ({ patient, lang, role, actorName, onChange }) => {
  const [subMode, setSubMode] = useState<AnalysisSubMode>('ceph');
  const [stage, setStage] = useState<RecordStage>('T0');

  // Bolton & 3D Scanner integrated state
  const existingBolton = patient.analyses.find((a) => a.analysisType === 'cast_bolton');
  const [toothWidths, setToothWidths] = useState<Record<string, number>>(
    existingBolton?.toothWidths || {
      '16': 10.0, '15': 6.8, '14': 7.0, '13': 7.8, '12': 6.6, '11': 8.7,
      '21': 8.7, '22': 6.7, '23': 7.8, '24': 7.0, '25': 6.8, '26': 10.0,
      '46': 11.0, '45': 7.1, '44': 7.0, '43': 6.8, '42': 5.9, '41': 5.4,
      '31': 5.4, '32': 5.9, '33': 6.8, '34': 7.0, '35': 7.1, '36': 11.0,
    },
  );
  const [spaceU, setSpaceU] = useState<number>(existingBolton?.spaceAvailableUpper ?? 70.5);
  const [spaceL, setSpaceL] = useState<number>(existingBolton?.spaceAvailableLower ?? 62.5);
  const [lastSyncedTooth, setLastSyncedTooth] = useState<{ fdi: string; mm: number } | null>(null);

  // Dentition Stage & Scientific Lab Section in Manual Measurements
  const existingMixed = patient.analyses.find((a) => a.analysisType === 'mixed_dentition');
  const [manualLabView, setManualLabView] = useState<'permanent' | 'mixed' | 'ceph'>(() => {
    const examStageVal = patient.clinicalExam.intraoral.dentitionStage.value.toLowerCase();
    if (existingMixed && !existingBolton) return 'mixed';
    if (examStageVal.includes('مختلط') || examStageVal.includes('mixed')) return 'mixed';
    return 'permanent';
  });

  // Manual Cast Caliper Measurements (for Permanent Dentition comprehensive analyses)
  const getSavedMetricVal = (key: string, fallback: string) => {
    const m = existingBolton?.metrics.find((x) => x.key === key);
    return m && m.value !== null && m.value !== undefined ? String(m.value) : fallback;
  };
  const [manualCast, setManualCast] = useState<{
    intercanineU: string;
    intercanineL: string;
    interpremolarU: string;
    premolarDiameterPmdU: string;
    intermolarU: string;
    intermolarL: string;
    anteriorArchLenU: string;
    premolarBasalWidthU: string;
    curveOfSpee: string;
    overjet: string;
    overbite: string;
    little1: string;
    little2: string;
    little3: string;
    little4: string;
    little5: string;
    fl42: string;
    fl41: string;
    fl31: string;
    fl32: string;
  }>(() => ({
    intercanineU: getSavedMetricVal('CAST_ICW_U', '34.0'),
    intercanineL: getSavedMetricVal('CAST_ICW_L', '26.0'),
    interpremolarU: getSavedMetricVal('CAST_IPW_U', '36.5'),
    premolarDiameterPmdU: getSavedMetricVal('ASHLEY_PMD', '41.0'),
    intermolarU: getSavedMetricVal('CAST_IMW_U', '47.5'),
    intermolarL: getSavedMetricVal('CAST_IMW_L', '41.5'),
    anteriorArchLenU: getSavedMetricVal('KORKHAUS_LU', '18.5'),
    premolarBasalWidthU: getSavedMetricVal('ASHLEY_PMBAW', '43.0'),
    curveOfSpee: getSavedMetricVal('CAST_SPEE', '2.0'),
    overjet: getSavedMetricVal('CAST_OJ', '3.0'),
    overbite: getSavedMetricVal('CAST_OB', '2.5'),
    little1: '1.0',
    little2: '1.2',
    little3: '1.5',
    little4: '1.0',
    little5: '0.8',
    fl42: '6.3',
    fl41: '6.0',
    fl31: '6.0',
    fl32: '6.3',
  }));

  // Mixed Dentition Comprehensive Inputs
  const [mixedInput, setMixedInput] = useState<MixedDentitionInputs>(() => {
    const saved = existingMixed?.mixedDentitionData;
    const num = (k: string, def: number) => (saved && typeof saved[k] === 'number' ? (saved[k] as number) : def);
    return {
      sex: saved?.sex === 'male' || saved?.sex === 'female' ? saved.sex : patient.gender,
      moyersConfidence: ([50, 75, 85, 95].includes(Number(saved?.moyersConfidence))
        ? Number(saved?.moyersConfidence)
        : 75) as MoyersConfidence,
      spaceMode: saved?.spaceMode === 'arch_perimeter' ? 'arch_perimeter' : 'quadrant',
      archPerimeterU: num('archPerimeterU', 73.4),
      archPerimeterL: num('archPerimeterL', 64.6),
      canineSource: saved?.canineSource === 'predicted' ? 'predicted' : 'radiographic',
      w12: num('w12', 6.6),
      w11: num('w11', 8.6),
      w21: num('w21', 8.6),
      w22: num('w22', 6.6),
      w42: num('w42', 5.9),
      w41: num('w41', 5.4),
      w31: num('w31', 5.4),
      w32: num('w32', 5.9),
      primaryUpperIncisorsSum: num('primaryUpperIncisorsSum', 23.0),
      primaryLowerIncisorsSum: num('primaryLowerIncisorsSum', 16.5),
      spaceUR: num('spaceUR', 21.5),
      spaceUL: num('spaceUL', 21.5),
      spaceLR: num('spaceLR', 21.0),
      spaceLL: num('spaceLL', 21.0),
      primaryCdeUR: num('primaryCdeUR', 23.5),
      primaryCdeUL: num('primaryCdeUL', 23.5),
      primaryCdeLR: num('primaryCdeLR', 24.5),
      primaryCdeLL: num('primaryCdeLL', 24.5),
      castRefToothUR: num('castRefToothUR', 8.8),
      castRefToothUL: num('castRefToothUL', 8.8),
      castRefToothLR: num('castRefToothLR', 9.8),
      castRefToothLL: num('castRefToothLL', 9.8),
      xrayRefToothUR: num('xrayRefToothUR', 9.3),
      xrayRefToothUL: num('xrayRefToothUL', 9.3),
      xrayRefToothLR: num('xrayRefToothLR', 10.3),
      xrayRefToothLL: num('xrayRefToothLL', 10.3),
      xrayCanineUR: num('xrayCanineUR', 8.2),
      xrayCanineUL: num('xrayCanineUL', 8.2),
      xrayCanineLR: num('xrayCanineLR', 7.2),
      xrayCanineLL: num('xrayCanineLL', 7.2),
      xrayPmUR: num('xrayPmUR', 14.4),
      xrayPmUL: num('xrayPmUL', 14.4),
      xrayPmLR: num('xrayPmLR', 14.6),
      xrayPmLL: num('xrayPmLL', 14.6),
      xrayMagFactor: num('xrayMagFactor', 0.95),
      intercanineU: num('intercanineU', 31.0),
      intercanineL: num('intercanineL', 25.0),
      intermolarU: num('intermolarU', 45.0),
      intermolarL: num('intermolarL', 40.0),
      overjet: num('overjet', 3.0),
      overbite: num('overbite', 2.5),
    };
  });

  // Manual Cephalometric Numeric Entry (for pre-measured radiology printouts)
  const existingCeph = patient.analyses.find((a) => a.analysisType === 'cephalometric');
  const [manualCephValues, setManualCephValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of MANUAL_CEPH_FIELDS) {
      const m = existingCeph?.metrics.find((x) => x.key === f.key);
      if (m && m.value !== null && m.value !== undefined) {
        init[f.key] = String(m.value);
      }
    }
    return init;
  });

  const boltonStats = useMemo(
    () => computeBoltonAndSpace(toothWidths, spaceU, spaceL),
    [toothWidths, spaceU, spaceL],
  );

  const permSuite = useMemo(
    () =>
      computePermanentModelSuite(toothWidths, spaceU, spaceL, {
        intercanineU: Number(manualCast.intercanineU) || 0,
        intercanineL: Number(manualCast.intercanineL) || 0,
        interpremolarU: Number(manualCast.interpremolarU) || 0,
        premolarDiameterPmdU: Number(manualCast.premolarDiameterPmdU) || 0,
        intermolarU: Number(manualCast.intermolarU) || 0,
        intermolarL: Number(manualCast.intermolarL) || 0,
        anteriorArchLenU: Number(manualCast.anteriorArchLenU) || 0,
        premolarBasalWidthU: Number(manualCast.premolarBasalWidthU) || 0,
        curveOfSpee: Number(manualCast.curveOfSpee) || 0,
        overjet: Number(manualCast.overjet) || 0,
        overbite: Number(manualCast.overbite) || 0,
        littleContacts: [
          Number(manualCast.little1) || 0,
          Number(manualCast.little2) || 0,
          Number(manualCast.little3) || 0,
          Number(manualCast.little4) || 0,
          Number(manualCast.little5) || 0,
        ],
        flWidths: {
          '42': Number(manualCast.fl42) || 0,
          '41': Number(manualCast.fl41) || 0,
          '31': Number(manualCast.fl31) || 0,
          '32': Number(manualCast.fl32) || 0,
        },
      }),
    [toothWidths, spaceU, spaceL, manualCast],
  );

  const mixedSuite = useMemo(() => computeMixedDentitionSuite(mixedInput), [mixedInput]);

  const default3dMedia = useMemo(
    () => patient.media.find((m) => m.mediaKind === 'model3d' && m.stage === stage) ||
      patient.media.find((m) => m.mediaKind === 'model3d') ||
      null,
    [patient.media, stage],
  );

  const defaultDicomMedia = useMemo(
    () => patient.media.find((m) => m.mediaKind === 'dicom' && m.stage === stage) ||
      patient.media.find((m) => m.mediaKind === 'dicom') ||
      null,
    [patient.media, stage],
  );

  const handleSaveBolton = (includeManualCast = false) => {
    const version = patient.analyses.filter((a) => a.analysisType === 'cast_bolton').length + 1;
    const rawCastMetrics: Array<AnalysisMetric | null> = includeManualCast
      ? [
          manualCast.intercanineU
            ? {
                key: 'CAST_ICW_U',
                labelAr: 'العرض بين الأنياب العلوي (3-3 U)',
                labelEn: 'Upper Intercanine Width',
                value: Number(manualCast.intercanineU),
                unit: 'mm',
                normRange: '34 ± 2 mm',
                formulaDesc: 'قياس بالفرجار اليدوي على القالب',
                interpretation: `${manualCast.intercanineU} mm`,
                requiresCalibration: true,
              }
            : null,
          manualCast.intercanineL
            ? {
                key: 'CAST_ICW_L',
                labelAr: 'العرض بين الأنياب السفلي (3-3 L)',
                labelEn: 'Lower Intercanine Width',
                value: Number(manualCast.intercanineL),
                unit: 'mm',
                normRange: '26 ± 1.5 mm',
                formulaDesc: 'قياس بالفرجار اليدوي على القالب',
                interpretation: `${manualCast.intercanineL} mm`,
                requiresCalibration: true,
              }
            : null,
          manualCast.interpremolarU
            ? {
                key: 'CAST_IPW_U',
                labelAr: 'العرض بين الضواحك العلوي (4-4 U)',
                labelEn: 'Upper Interpremolar Width (4-4)',
                value: Number(manualCast.interpremolarU),
                unit: 'mm',
                normRange: `Pont: ${permSuite.pontPremolarIdeal} mm`,
                formulaDesc: 'الحفرة الوحشية للضاحكين الأولين (Distal pits 14–24)',
                interpretation: `فرق بونت: ${permSuite.pontPremolarDiff > 0 ? '+' : ''}${permSuite.pontPremolarDiff} مم`,
                requiresCalibration: true,
              }
            : null,
          manualCast.intermolarU
            ? {
                key: 'CAST_IMW_U',
                labelAr: 'العرض بين الأضراس العلوي (6-6 U)',
                labelEn: 'Upper Intermolar Width (6-6)',
                value: Number(manualCast.intermolarU),
                unit: 'mm',
                normRange: `Pont: ${permSuite.pontMolarIdeal} mm`,
                formulaDesc: 'الحفرة الأنسية للضرسين الأولين (Mesial pits 16–26)',
                interpretation: `فرق بونت: ${permSuite.pontMolarDiff > 0 ? '+' : ''}${permSuite.pontMolarDiff} مم`,
                requiresCalibration: true,
              }
            : null,
          manualCast.intermolarL
            ? {
                key: 'CAST_IMW_L',
                labelAr: 'العرض بين الأضراس السفلي (6-6 L)',
                labelEn: 'Lower Intermolar Width',
                value: Number(manualCast.intermolarL),
                unit: 'mm',
                normRange: '41 ± 2.5 mm',
                formulaDesc: 'قياس بالفرجار اليدوي على القالب',
                interpretation: `${manualCast.intermolarL} mm`,
                requiresCalibration: true,
              }
            : null,
          {
            key: 'PONT_44_IDEAL',
            labelAr: 'بونت المتوقع 4-4 (Pont Premolar)',
            labelEn: "Pont's Ideal 4-4 Width",
            value: permSuite.pontPremolarIdeal,
            unit: 'mm',
            normRange: 'SI × 100 / 80 (+1–2 mm relapse)',
            formulaDesc: `SI=${permSuite.siUpper} mm · Linder-Harth: ${permSuite.linderPremolarIdeal} mm`,
            interpretation: permSuite.pontPremolarDiff < -1 ? 'توسعة أمامية مطلوبة (+1–2 مم وقاية للارتداد)' : 'عرض ضاحكي مناسب',
            requiresCalibration: true,
          },
          {
            key: 'PONT_66_IDEAL',
            labelAr: 'بونت المتوقع 6-6 (Pont Molar)',
            labelEn: "Pont's Ideal 6-6 Width",
            value: permSuite.pontMolarIdeal,
            unit: 'mm',
            normRange: 'SI × 100 / 64 (+1–2 mm relapse)',
            formulaDesc: `Linder-Harth: ${permSuite.linderMolarIdeal} mm`,
            interpretation: permSuite.pontMolarDiff < -1 ? 'توسعة خلفية مطلوبة (+1–2 مم وقاية للارتداد)' : 'عرض ضرس مناسب',
            requiresCalibration: true,
          },
          {
            key: 'KORKHAUS_LU',
            labelAr: 'طول القوس الأمامي كوركهاوس (Korkhaus Lu)',
            labelEn: 'Korkhaus Anterior Arch Length',
            value: Number(manualCast.anteriorArchLenU) || null,
            unit: 'mm',
            normRange: `Ideal: ${permSuite.korkhausIdealLu} mm`,
            formulaDesc: 'SI × 100 / 160',
            interpretation:
              permSuite.korkhausDiff > 1.5
                ? 'بروز أمامي علوي (+)'
                : permSuite.korkhausDiff < -1.5
                ? 'تراجع/انكفاء أمامي (-)'
                : 'طول قوس أمامي متزن',
            requiresCalibration: true,
          },
          manualCast.premolarDiameterPmdU
            ? {
                key: 'ASHLEY_PMD',
                labelAr: 'عرض الضواحك آشلي-هاو (PMD 14–24)',
                labelEn: 'Ashley-Howe Premolar Diameter (PMD)',
                value: Number(manualCast.premolarDiameterPmdU),
                unit: 'mm',
                normRange: `PMBAW > PMD (Δ ${permSuite.ashleyExpansionDiff > 0 ? '+' : ''}${permSuite.ashleyExpansionDiff} mm)`,
                formulaDesc: 'رؤوس الحدبات الدهليزية للضواحك الأولى (Buccal cusps 14–24)',
                interpretation: permSuite.ashleyInferenceI,
                requiresCalibration: true,
              }
            : null,
          {
            key: 'ASHLEY_PMBAW',
            labelAr: 'عرض القاعدة الذروية (Ashley-Howe PMBAW)',
            labelEn: 'Ashley-Howe Basal Arch Width',
            value: Number(manualCast.premolarBasalWidthU) || null,
            unit: 'mm',
            normRange: 'PMBAW% > 44%',
            formulaDesc: 'الحفرة النابية فوق الضاحك الأول (Canine fossa 14–24)',
            interpretation: permSuite.ashleyInferenceI,
            requiresCalibration: true,
          },
          {
            key: 'ASHLEY_HOWE_PCT',
            labelAr: 'نسبة آشلي-هاو (Ashley-Howe %)',
            labelEn: 'Ashley-Howe Basal Ratio',
            value: permSuite.ashleyHowePct,
            unit: '%',
            normRange: '> 44% (Non-Ex)',
            formulaDesc: 'PMBAW / TTM (Sum 16..26) × 100',
            interpretation: `${permSuite.ashleyHoweCategory} · ${permSuite.ashleyInferenceI}`,
            requiresCalibration: false,
          },
          {
            key: 'LITTLE_IRREG',
            labelAr: "مؤشر ليتل لعدم الانتظام (Little's Index)",
            labelEn: "Little's Irregularity Index",
            value: permSuite.littleSum,
            unit: 'mm',
            normRange: '0 – 3 mm (Minimal)',
            formulaDesc: 'مجموع إزاحة نقاط التماس الخمس السفلية',
            interpretation: permSuite.littleSeverity,
            requiresCalibration: true,
          },
          {
            key: 'PECK_41',
            labelAr: 'مؤشر بيك وبيك #41 (Peck & Peck)',
            labelEn: 'Peck & Peck Index #41',
            value: permSuite.peck41,
            unit: '%',
            normRange: '88% – 92%',
            formulaDesc: 'MD / FL × 100',
            interpretation:
              permSuite.peck41 === null ? '—' : permSuite.peck41 > 92 ? 'مناسب للبرد الجانبي (IPR)' : 'ضمن النسبة المثالية',
            requiresCalibration: false,
          },
          {
            key: 'PECK_31',
            labelAr: 'مؤشر بيك وبيك #31 (Peck & Peck)',
            labelEn: 'Peck & Peck Index #31',
            value: permSuite.peck31,
            unit: '%',
            normRange: '88% – 92%',
            formulaDesc: 'MD / FL × 100',
            interpretation:
              permSuite.peck31 === null ? '—' : permSuite.peck31 > 92 ? 'مناسب للبرد الجانبي (IPR)' : 'ضمن النسبة المثالية',
            requiresCalibration: false,
          },
          {
            key: 'PECK_42',
            labelAr: 'مؤشر بيك وبيك #42 (Peck & Peck)',
            labelEn: 'Peck & Peck Index #42',
            value: permSuite.peck42,
            unit: '%',
            normRange: '90% – 95%',
            formulaDesc: 'MD / FL × 100',
            interpretation:
              permSuite.peck42 === null ? '—' : permSuite.peck42 > 95 ? 'مناسب للبرد الجانبي (IPR)' : 'ضمن النسبة المثالية',
            requiresCalibration: false,
          },
          {
            key: 'PECK_32',
            labelAr: 'مؤشر بيك وبيك #32 (Peck & Peck)',
            labelEn: 'Peck & Peck Index #32',
            value: permSuite.peck32,
            unit: '%',
            normRange: '90% – 95%',
            formulaDesc: 'MD / FL × 100',
            interpretation:
              permSuite.peck32 === null ? '—' : permSuite.peck32 > 95 ? 'مناسب للبرد الجانبي (IPR)' : 'ضمن النسبة المثالية',
            requiresCalibration: false,
          },
          {
            key: 'CAREY_NET_L',
            labelAr: 'تحليل كاري السفلي الصافي (Carey Net)',
            labelEn: "Carey's Net Lower Discrepancy",
            value: permSuite.careyNetLower,
            unit: 'mm',
            normRange: '0 ± 1 mm',
            formulaDesc: 'Space Available (6M–6M) − Sum(45..35) − Spee Compensation',
            interpretation: permSuite.careyPlan,
            requiresCalibration: true,
          },
          manualCast.curveOfSpee
            ? {
                key: 'CAST_SPEE',
                labelAr: 'عمق قوس سبي (Curve of Spee)',
                labelEn: 'Curve of Spee Depth',
                value: Number(manualCast.curveOfSpee),
                unit: 'mm',
                normRange: '0 – 2.0 mm',
                formulaDesc: 'قياس يدوي على القالب السفلي',
                interpretation: Number(manualCast.curveOfSpee) > 2 ? 'قوس سبي عميق' : 'ضمن الطبيعي',
                requiresCalibration: true,
              }
            : null,
          manualCast.overjet
            ? {
                key: 'CAST_OJ',
                labelAr: 'التراكب الأفقي (Overjet)',
                labelEn: 'Manual Overjet',
                value: Number(manualCast.overjet),
                unit: 'mm',
                normRange: '2 – 3 mm',
                formulaDesc: 'قياس يدوي بالمسطرة/الفرجار',
                interpretation: `${manualCast.overjet} mm`,
                requiresCalibration: true,
              }
            : null,
          manualCast.overbite
            ? {
                key: 'CAST_OB',
                labelAr: 'التراكب العمودي (Overbite)',
                labelEn: 'Manual Overbite',
                value: Number(manualCast.overbite),
                unit: 'mm',
                normRange: '2 – 3 mm',
                formulaDesc: 'قياس يدوي بالمسطرة/الفرجار',
                interpretation: `${manualCast.overbite} mm`,
                requiresCalibration: true,
              }
            : null,
        ]
      : [];
    const extraCastMetrics: AnalysisMetric[] = rawCastMetrics.filter((x): x is AnalysisMetric => x !== null);

    const newAnalysis: MeasurementAnalysis = {
      id: `ana-bolton-${Date.now()}`,
      version,
      stage,
      analysisType: 'cast_bolton',
      dentitionType: 'permanent',
      templateName: includeManualCast
        ? tr(
            lang,
            'تحاليل الأسنان الدائمة الكاملة (بولتون / بونت / ليندر-هارث / كوركهاوس / آشلي-هاو / ليتل / بيك / كاري)',
            'Complete Permanent Dentition Analyses (Bolton, Pont, Linder-Harth, Korkhaus, Ashley-Howe, Little, Peck, Carey)',
          )
        : 'Bolton & 3D Arch Space Discrepancy',
      normSource: includeManualCast
        ? 'Bolton, Pont, Linder-Harth, Korkhaus, Ashley-Howe, Little, Peck & Peck, Carey'
        : 'Bolton (1958) — Anterior 77.2%, Overall 91.3%',
      calibrationValid: true,
      calibrationSource: includeManualCast
        ? tr(lang, 'إدخال يدوي شامل للأسنان الدائمة (mm)', 'Comprehensive Permanent Dentition Manual Entry (mm)')
        : tr(lang, 'قياسات الأسنان (مم / مسح ثلاثي الأبعاد)', 'Direct mm / 3D Scanner Tooth Widths'),
      landmarks: {},
      toothWidths,
      spaceAvailableUpper: spaceU,
      spaceAvailableLower: spaceL,
      metrics: [
        {
          key: 'BOLTON_ANT',
          labelAr: 'نسبة بولتون الأمامية (6 أسنان)',
          labelEn: 'Bolton Anterior Ratio',
          value: boltonStats.anteriorRatio,
          unit: '%',
          normRange: '77.2% ± 1.65%',
          formulaDesc: 'Lower 6 / Upper 6 × 100',
          interpretation:
            boltonStats.anteriorRatio === null
              ? '—'
              : `${boltonStats.anteriorExcessArch === 'lower' ? 'زيادة سفلية' : 'زيادة علوية'} (${boltonStats.anteriorExcess} مم)`,
          requiresCalibration: false,
        },
        {
          key: 'BOLTON_ALL',
          labelAr: 'نسبة بولتون الكلية (12 سن)',
          labelEn: 'Bolton Overall Ratio',
          value: boltonStats.overallRatio,
          unit: '%',
          normRange: '91.3% ± 1.91%',
          formulaDesc: 'Lower 12 / Upper 12 × 100',
          interpretation:
            boltonStats.overallRatio === null
              ? '—'
              : Math.abs(boltonStats.overallRatio - 91.3) <= 1.91
              ? `ضمن النطاق الطبيعي (${boltonStats.overallExcess} مم)`
              : `${boltonStats.overallExcessArch === 'lower' ? 'زيادة سفلية كلية' : 'زيادة علوية كلية'} (${boltonStats.overallExcess} مم)`,
          requiresCalibration: false,
        },
        {
          key: 'SPACE_DISC_U',
          labelAr: 'فرق المسافة العلوي (Arch Perimeter 5–5)',
          labelEn: 'Upper Space Discrepancy (5–5)',
          value: boltonStats.upperDiscrepancy,
          unit: 'mm',
          normRange: '0 mm ± 1 mm',
          formulaDesc: 'Space Available (6M–6M) − Sum(15..25)',
          interpretation: permSuite.upperArchPlan,
          requiresCalibration: true,
        },
        {
          key: 'SPACE_DISC_L',
          labelAr: 'فرق المسافة السفلي (Carey 5–5)',
          labelEn: 'Lower Space Discrepancy (5–5)',
          value: boltonStats.lowerDiscrepancy,
          unit: 'mm',
          normRange: '0 mm ± 1 mm',
          formulaDesc: 'Space Available (6M–6M) − Sum(45..35)',
          interpretation: permSuite.careyPlan,
          requiresCalibration: true,
        },
        ...extraCastMetrics,
      ],
      examiner: actorName,
      createdAt: new Date().toISOString(),
      approvedBy: role === 'doctor' ? actorName : undefined,
      approvedAt: role === 'doctor' ? new Date().toISOString() : undefined,
    };
    onChange(
      { ...patient, analyses: [newAnalysis, ...patient.analyses] },
      {
        ar: includeManualCast
          ? `حفظ حزمة تحاليل الأسنان الدائمة الكاملة (${stage})`
          : `حفظ تحليل بولتون والنماذج (${stage})`,
        en: includeManualCast
          ? `Saved Complete Permanent Dentition Analyses (${stage})`
          : `Saved Bolton Analysis (${stage})`,
      },
    );
  };

  const handleSaveMixedDentition = () => {
    const version = patient.analyses.filter((a) => a.analysisType === 'mixed_dentition').length + 1;
    const sexLabel = mixedInput.sex === 'male' ? 'ذكر Male' : 'أنثى Female';
    const metrics: AnalysisMetric[] = [
      {
        key: 'SPACE_AVAIL_U',
        labelAr: 'المساحة المتاحة الخلفية/الكلية علوي (Space Avail U)',
        labelEn: 'Upper Space Available (Post / Arch)',
        value: mixedSuite.totalPostSpaceUpper,
        unit: 'mm',
        normRange: `Arch: ${mixedSuite.totalSpaceAvailUpper} mm`,
        formulaDesc: `UR (${mixedSuite.effectiveSpaceUR}) + UL (${mixedSuite.effectiveSpaceUL})`,
        interpretation: `محيط القوس الكلي: ${mixedSuite.totalSpaceAvailUpper} مم`,
        requiresCalibration: true,
      },
      {
        key: 'SPACE_AVAIL_L',
        labelAr: 'المساحة المتاحة الخلفية/الكلية سفلي (Space Avail L)',
        labelEn: 'Lower Space Available (Post / Arch)',
        value: mixedSuite.totalPostSpaceLower,
        unit: 'mm',
        normRange: `Arch: ${mixedSuite.totalSpaceAvailLower} mm`,
        formulaDesc: `LR (${mixedSuite.effectiveSpaceLR}) + LL (${mixedSuite.effectiveSpaceLL})`,
        interpretation: `محيط القوس الكلي: ${mixedSuite.totalSpaceAvailLower} مم`,
        requiresCalibration: true,
      },
      {
        key: 'UNERUPTED_CANINE_U',
        labelAr: 'عرض الناب العلوي غير البازغ (3) — المعتمد',
        labelEn: 'Unerupted Upper Canine (3) Width',
        value: Number(((mixedSuite.effCanineUR + mixedSuite.effCanineUL) / 2).toFixed(1)),
        unit: 'mm',
        normRange: `Pred: ${mixedSuite.predictedCanineU} mm`,
        formulaDesc: mixedInput.canineSource === 'predicted' ? 'Incisor-based Prediction' : 'Huckaba True X-Ray (3)',
        interpretation: `X-ray UR/UL: ${mixedSuite.huckabaTrueCanineUR}/${mixedSuite.huckabaTrueCanineUL} مم`,
        requiresCalibration: true,
      },
      {
        key: 'UNERUPTED_CANINE_L',
        labelAr: 'عرض الناب السفلي غير البازغ (3) — المعتمد',
        labelEn: 'Unerupted Lower Canine (3) Width',
        value: Number(((mixedSuite.effCanineLR + mixedSuite.effCanineLL) / 2).toFixed(1)),
        unit: 'mm',
        normRange: `Pred: ${mixedSuite.predictedCanineL} mm`,
        formulaDesc: mixedInput.canineSource === 'predicted' ? 'Incisor-based Prediction' : 'Huckaba True X-Ray (3)',
        interpretation: `X-ray LR/LL: ${mixedSuite.huckabaTrueCanineLR}/${mixedSuite.huckabaTrueCanineLL} مم`,
        requiresCalibration: true,
      },
      {
        key: 'MIXED_LOWER4_SUM',
        labelAr: 'مجموع القواطع السفلية الأربعة (42–32)',
        labelEn: 'Sum of Lower 4 Incisors',
        value: mixedSuite.sumLowerIncisors,
        unit: 'mm',
        normRange: '21.0 – 24.0 mm',
        formulaDesc: '42 + 41 + 31 + 32',
        interpretation: `جنس: ${sexLabel}`,
        requiresCalibration: true,
      },
      {
        key: 'MOYERS_DISC_U',
        labelAr: `فرق المسافة العلوي بمويرز (${mixedInput.moyersConfidence}%)`,
        labelEn: 'Moyers Total Upper Discrepancy',
        value: mixedSuite.moyersTotalUpperDisc,
        unit: 'mm',
        normRange: `Pred/Quad: ${mixedSuite.moyersUpperQuad} mm`,
        formulaDesc: `(UR ${mixedSuite.moyersDiscUR}) + (UL ${mixedSuite.moyersDiscUL})`,
        interpretation: mixedSuite.moyersTotalUpperDisc < 0 ? 'عجز مساحة علوي متوقع' : 'مسافة علوية كافية',
        requiresCalibration: true,
      },
      {
        key: 'MOYERS_DISC_L',
        labelAr: `فرق المسافة السفلي بمويرز (${mixedInput.moyersConfidence}%)`,
        labelEn: 'Moyers Total Lower Discrepancy',
        value: mixedSuite.moyersTotalLowerDisc,
        unit: 'mm',
        normRange: `Pred/Quad: ${mixedSuite.moyersLowerQuad} mm`,
        formulaDesc: `(LR ${mixedSuite.moyersDiscLR}) + (LL ${mixedSuite.moyersDiscLL})`,
        interpretation: mixedSuite.moyersTotalLowerDisc < 0 ? 'عجز مساحة سفلي متوقع' : 'مسافة سفلية كافية',
        requiresCalibration: true,
      },
      {
        key: 'TJ_DISC_U',
        labelAr: 'تاناكا وجونستون — فرق العلوي',
        labelEn: 'Tanaka-Johnston Upper Discrepancy',
        value: mixedSuite.tjTotalUpperDisc,
        unit: 'mm',
        normRange: `Quad Pred: ${mixedSuite.tjUpperQuad} mm`,
        formulaDesc: '(Sum Lower 4 / 2) + 11.0 per side',
        interpretation: mixedSuite.tjTotalUpperDisc < 0 ? 'عجز علوي حسب تاناكا-جونستون' : 'مسافة كافية',
        requiresCalibration: true,
      },
      {
        key: 'TJ_DISC_L',
        labelAr: 'تاناكا وجونستون — فرق السفلي',
        labelEn: 'Tanaka-Johnston Lower Discrepancy',
        value: mixedSuite.tjTotalLowerDisc,
        unit: 'mm',
        normRange: `Quad Pred: ${mixedSuite.tjLowerQuad} mm`,
        formulaDesc: '(Sum Lower 4 / 2) + 10.5 per side',
        interpretation: mixedSuite.tjTotalLowerDisc < 0 ? 'عجز سفلي حسب تاناكا-جونستون' : 'مسافة كافية',
        requiresCalibration: true,
      },
      {
        key: 'NANCE_RAD_U',
        labelAr: 'نانس بالأشعة (1947) — فرق العلوي (UR+UL)',
        labelEn: 'Nance Radiographic Upper Discrepancy (1947)',
        value: mixedSuite.nanceRadTotalUpperDisc,
        unit: 'mm',
        normRange: `X-ray 3+4+5: ${mixedSuite.nanceRadPredUR}/${mixedSuite.nanceRadPredUL} mm`,
        formulaDesc: 'Space Avail − Raw X-ray(3+4+5)',
        interpretation: mixedSuite.nanceRadTotalUpperDisc < 0 ? 'عجز علوي بالأشعة المباشرة (نانس)' : 'مسافة علوية كافية (نانس)',
        requiresCalibration: true,
      },
      {
        key: 'NANCE_RAD_L',
        labelAr: 'نانس بالأشعة (1947) — فرق السفلي (LR+LL)',
        labelEn: 'Nance Radiographic Lower Discrepancy (1947)',
        value: mixedSuite.nanceRadTotalLowerDisc,
        unit: 'mm',
        normRange: `X-ray 3+4+5: ${mixedSuite.nanceRadPredLR}/${mixedSuite.nanceRadPredLL} mm`,
        formulaDesc: 'Space Avail − Raw X-ray(3+4+5)',
        interpretation: mixedSuite.nanceRadTotalLowerDisc < 0 ? 'عجز سفلي بالأشعة المباشرة (نانس)' : 'مسافة سفلية كافية (نانس)',
        requiresCalibration: true,
      },
      {
        key: 'HUCKABA_DISC_U',
        labelAr: 'تحليل هوكابا (Huckaba) — فرق العلوي (UR+UL)',
        labelEn: 'Huckaba Upper Discrepancy (1964)',
        value: mixedSuite.huckabaTotalUpperDisc,
        unit: 'mm',
        normRange: `True 3+4+5: ${mixedSuite.huckabaPredUR}/${mixedSuite.huckabaPredUL} mm`,
        formulaDesc: 'X_true = (M_true × X_xray) / M_xray',
        interpretation: mixedSuite.huckabaTotalUpperDisc < 0 ? 'عجز مساحة علوي شعاعياً (هوكابا)' : 'مسافة علوية كافية (هوكابا)',
        requiresCalibration: true,
      },
      {
        key: 'HUCKABA_DISC_L',
        labelAr: 'تحليل هوكابا (Huckaba) — فرق السفلي (LR+LL)',
        labelEn: 'Huckaba Lower Discrepancy (1964)',
        value: mixedSuite.huckabaTotalLowerDisc,
        unit: 'mm',
        normRange: `True 3+4+5: ${mixedSuite.huckabaPredLR}/${mixedSuite.huckabaPredLL} mm`,
        formulaDesc: 'X_true = (M_true × X_xray) / M_xray',
        interpretation: mixedSuite.huckabaTotalLowerDisc < 0 ? 'عجز مساحة سفلي شعاعياً (هوكابا)' : 'مسافة سفلية كافية (هوكابا)',
        requiresCalibration: true,
      },
      {
        key: 'HIXON_LR',
        labelAr: 'هيكسون وأولدفادر — سفلي يمين (LR)',
        labelEn: 'Hixon & Oldfather Lower Right Disc',
        value: mixedSuite.hixonDiscLR,
        unit: 'mm',
        normRange: `Pred: ${mixedSuite.hixonPredLR} mm`,
        formulaDesc: 'Hixon-Oldfather Table (1958): Cast(I1+I2) + X-ray(4+5)',
        interpretation: mixedSuite.hixonDiscLR < 0 ? 'عجز يمين سفلي شعاعياً' : 'كفاية مساحة يمين',
        requiresCalibration: true,
      },
      {
        key: 'HIXON_LL',
        labelAr: 'هيكسون وأولدفادر — سفلي يسار (LL)',
        labelEn: 'Hixon & Oldfather Lower Left Disc',
        value: mixedSuite.hixonDiscLL,
        unit: 'mm',
        normRange: `Pred: ${mixedSuite.hixonPredLL} mm`,
        formulaDesc: 'Hixon-Oldfather Table (1958): Cast(I1+I2) + X-ray(4+5)',
        interpretation: mixedSuite.hixonDiscLL < 0 ? 'عجز يسار سفلي شعاعياً' : 'كفاية مساحة يسار',
        requiresCalibration: true,
      },
      {
        key: 'STALEY_KERBER_L',
        labelAr: 'ستالي وكيربر — سفلي إجمالي (LR+LL)',
        labelEn: 'Staley & Kerber Lower Total Disc',
        value: Number((mixedSuite.staleyDiscLR + mixedSuite.staleyDiscLL).toFixed(1)),
        unit: 'mm',
        normRange: `Pred: ${mixedSuite.staleyPredLR}/${mixedSuite.staleyPredLL} mm`,
        formulaDesc: '0.7158×(I1+I2 + X-ray 4+5) + 2.1267',
        interpretation:
          mixedSuite.staleyDiscLR + mixedSuite.staleyDiscLL < 0 ? 'عجز سفلي (Staley-Kerber)' : 'مسافة كافية',
        requiresCalibration: true,
      },
      {
        key: 'NANCE_LEEWAY_U',
        labelAr: 'فضاء نانس الفائض العلوي (Leeway U)',
        labelEn: 'Nance Upper Leeway Space (Both Sides)',
        value: mixedSuite.totalUpperLeeway,
        unit: 'mm',
        normRange: '~ 1.8 mm (0.9/side)',
        formulaDesc: '(c+d+e) − True(3+4+5)',
        interpretation: mixedSuite.totalUpperLeeway > 0 ? 'فضاء فائض متاح بالعلوي' : 'انعدام فضاء فائض علوي',
        requiresCalibration: true,
      },
      {
        key: 'NANCE_LEEWAY_L',
        labelAr: 'فضاء نانس الفائض السفلي (Leeway L)',
        labelEn: 'Nance Lower Leeway Space (Both Sides)',
        value: mixedSuite.totalLowerLeeway,
        unit: 'mm',
        normRange: '~ 3.4 mm (1.7/side)',
        formulaDesc: '(c+d+e) − True(3+4+5)',
        interpretation: mixedSuite.totalLowerLeeway > 0 ? 'فضاء فائض سفلي لحل الازدحام' : 'فضاء فائض منخفض',
        requiresCalibration: true,
      },
      {
        key: 'INCISOR_LIAB_U',
        labelAr: 'عجز القواطع العلوي (Incisor Liability U)',
        labelEn: 'Upper Incisor Liability',
        value: mixedSuite.upperIncisorLiability,
        unit: 'mm',
        normRange: '~ 7.6 mm',
        formulaDesc: 'Perm(12..22) − Primary(52..62)',
        interpretation: `${mixedSuite.upperIncisorLiability} مم فرق حجم القواطع`,
        requiresCalibration: true,
      },
      {
        key: 'INCISOR_LIAB_L',
        labelAr: 'عجز القواطع السفلي (Incisor Liability L)',
        labelEn: 'Lower Incisor Liability',
        value: mixedSuite.lowerIncisorLiability,
        unit: 'mm',
        normRange: '~ 6.0 mm',
        formulaDesc: 'Perm(42..32) − Primary(82..72)',
        interpretation: `${mixedSuite.lowerIncisorLiability} مم فرق حجم القواطع`,
        requiresCalibration: true,
      },
    ];

    const newAnalysis: MeasurementAnalysis = {
      id: `ana-mixed-${Date.now()}`,
      version,
      stage,
      analysisType: 'mixed_dentition',
      dentitionType: 'mixed',
      templateName: tr(
        lang,
        `تحاليل الأسنان المختلطة الكاملة (مويرز ${mixedInput.moyersConfidence}% / تاناكا-جونستون / هوكابا / هيكسون-أولدفادر / ستالي-كيربر / نانس)`,
        `Complete Mixed Dentition Analyses (Moyers ${mixedInput.moyersConfidence}%, Tanaka-Johnston, Huckaba, Hixon-Oldfather, Staley-Kerber, Nance)`,
      ),
      normSource: `Moyers (1988, ${mixedInput.moyersConfidence}%), Tanaka & Johnston (1974), Huckaba (1964), Hixon & Oldfather, Staley & Kerber, Nance`,
      calibrationValid: true,
      calibrationSource: tr(lang, 'إدخال يدوي + تصحيح هوكابا للأشعة (mm)', 'Manual Cast & Huckaba Radiographic Correction (mm)'),
      landmarks: {},
      mixedDentitionData: {
        sex: mixedInput.sex,
        moyersConfidence: mixedInput.moyersConfidence,
        spaceMode: mixedInput.spaceMode,
        archPerimeterU: mixedInput.archPerimeterU,
        archPerimeterL: mixedInput.archPerimeterL,
        canineSource: mixedInput.canineSource,
        w12: mixedInput.w12,
        w11: mixedInput.w11,
        w21: mixedInput.w21,
        w22: mixedInput.w22,
        w42: mixedInput.w42,
        w41: mixedInput.w41,
        w31: mixedInput.w31,
        w32: mixedInput.w32,
        primaryUpperIncisorsSum: mixedInput.primaryUpperIncisorsSum,
        primaryLowerIncisorsSum: mixedInput.primaryLowerIncisorsSum,
        spaceUR: mixedInput.spaceUR,
        spaceUL: mixedInput.spaceUL,
        spaceLR: mixedInput.spaceLR,
        spaceLL: mixedInput.spaceLL,
        primaryCdeUR: mixedInput.primaryCdeUR,
        primaryCdeUL: mixedInput.primaryCdeUL,
        primaryCdeLR: mixedInput.primaryCdeLR,
        primaryCdeLL: mixedInput.primaryCdeLL,
        castRefToothUR: mixedInput.castRefToothUR,
        castRefToothUL: mixedInput.castRefToothUL,
        castRefToothLR: mixedInput.castRefToothLR,
        castRefToothLL: mixedInput.castRefToothLL,
        xrayRefToothUR: mixedInput.xrayRefToothUR,
        xrayRefToothUL: mixedInput.xrayRefToothUL,
        xrayRefToothLR: mixedInput.xrayRefToothLR,
        xrayRefToothLL: mixedInput.xrayRefToothLL,
        xrayCanineUR: mixedInput.xrayCanineUR,
        xrayCanineUL: mixedInput.xrayCanineUL,
        xrayCanineLR: mixedInput.xrayCanineLR,
        xrayCanineLL: mixedInput.xrayCanineLL,
        xrayPmUR: mixedInput.xrayPmUR,
        xrayPmUL: mixedInput.xrayPmUL,
        xrayPmLR: mixedInput.xrayPmLR,
        xrayPmLL: mixedInput.xrayPmLL,
        xrayMagFactor: mixedInput.xrayMagFactor,
        intercanineU: mixedInput.intercanineU,
        intercanineL: mixedInput.intercanineL,
        intermolarU: mixedInput.intermolarU,
        intermolarL: mixedInput.intermolarL,
        overjet: mixedInput.overjet,
        overbite: mixedInput.overbite,
      },
      metrics,
      examiner: actorName,
      createdAt: new Date().toISOString(),
      approvedBy: role === 'doctor' ? actorName : undefined,
      approvedAt: role === 'doctor' ? new Date().toISOString() : undefined,
    };

    onChange(
      { ...patient, analyses: [newAnalysis, ...patient.analyses] },
      {
        ar: `حفظ حزمة تحاليل الأسنان المختلطة + هوكابا (${stage})`,
        en: `Saved Complete Mixed Dentition & Huckaba Analyses (${stage})`,
      },
    );
  };

  const handleSaveManualCeph = () => {
    const version = patient.analyses.filter((a) => a.analysisType === 'cephalometric').length + 1;
    const metrics: AnalysisMetric[] = MANUAL_CEPH_FIELDS.map((f) => {
      const raw = manualCephValues[f.key];
      const val = raw !== undefined && raw.trim() !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : null;
      let interp = 'غير مدخل';
      if (val !== null) {
        interp = val > f.maxNorm ? f.highInterp : val < f.minNorm ? f.lowInterp : 'ضمن المعدل الطبيعي';
      }
      return {
        key: f.key,
        labelAr: f.labelAr,
        labelEn: f.labelEn,
        value: val,
        unit: f.unit,
        normRange: f.normRange,
        formulaDesc: tr(lang, 'إدخال يدوي مباشر من تقرير الأشعة', 'Manual Cephalometric Entry'),
        interpretation: interp,
        requiresCalibration: f.unit === 'mm',
      };
    });

    const newAnalysis: MeasurementAnalysis = {
      id: `ana-ceph-man-${Date.now()}`,
      version,
      stage,
      analysisType: 'cephalometric',
      analysisSystem: 'manual',
      templateName: tr(lang, 'إدخال قياسات السيفالومتري اليدوي', 'Manual Cephalometric Measurements'),
      normSource: 'Steiner / Tweed / Ricketts (Manual Entry)',
      calibrationValid: true,
      calibrationSource: tr(lang, 'إدخال رقمي يدوي مباشر', 'Direct Manual Value Entry'),
      landmarks: {},
      metrics,
      examiner: actorName,
      createdAt: new Date().toISOString(),
      approvedBy: role === 'doctor' ? actorName : undefined,
      approvedAt: role === 'doctor' ? new Date().toISOString() : undefined,
    };
    onChange(
      { ...patient, analyses: [newAnalysis, ...patient.analyses] },
      { ar: `حفظ قياسات السيفالومتري اليدوية ${stage} (v${version})`, en: `Saved Manual Ceph Measurements ${stage} (v${version})` },
    );
  };

  const handleSaveScannerSuite = (items: ScannerMeasurementItem[], label: string) => {
    const version = patient.analyses.filter((a) => a.analysisType === 'model3d_mesh').length + 1;
    const newAnalysis: MeasurementAnalysis = {
      id: `ana-scan-${Date.now()}`,
      version,
      stage,
      analysisType: 'model3d_mesh',
      templateName: label,
      normSource: '1:1 Intraoral 3D Scanner Coordinates (STL/OBJ mm)',
      linkedMediaId: default3dMedia?.id,
      calibrationValid: true,
      calibrationSource: '3D Scanner Mesh (1:1 mm)',
      landmarks: {},
      scannerMetrics: items.map((it) => ({
        key: it.kind.toUpperCase(),
        labelAr: it.labelAr,
        labelEn: it.labelEn,
        value: it.valueMm,
        unit: 'mm',
      })),
      metrics: items.map((it, idx) => ({
        key: `SCAN_${it.kind.toUpperCase()}_${idx + 1}`,
        labelAr: it.labelAr,
        labelEn: it.labelEn,
        value: it.valueMm,
        unit: 'mm',
        normRange: 'قياس مسح 3D مباشر',
        formulaDesc: 'Euclidean 3D Distance on Intraoral Mesh',
        interpretation: `${it.valueMm} mm`,
        requiresCalibration: true,
      })),
      examiner: actorName,
      createdAt: new Date().toISOString(),
      approvedBy: role === 'doctor' ? actorName : undefined,
      approvedAt: role === 'doctor' ? new Date().toISOString() : undefined,
    };
    onChange(
      { ...patient, analyses: [newAnalysis, ...patient.analyses] },
      { ar: `حفظ قياسات الماسح الضوئي 3D (${stage})`, en: `Saved 3D Scanner Measurements (${stage})` },
    );
  };

  const upperTeeth = ['16', '15', '14', '13', '12', '11', '21', '22', '23', '24', '25', '26'];
  const lowerTeeth = ['46', '45', '44', '43', '42', '41', '31', '32', '33', '34', '35', '36'];
  const cephHistory = patient.analyses.filter((a) => a.analysisType === 'cephalometric');

  const navItems: Array<{ id: AnalysisSubMode; ar: string; en: string; icon: React.ReactNode }> = [
    {
      id: 'manual',
      ar: 'القياسات اليدوية وبولتون',
      en: 'Manual Cast & Ceph',
      icon: <ClipboardEdit className="w-3.5 h-3.5" />,
    },
    {
      id: 'ceph',
      ar: 'رسم السيفالومتري',
      en: 'Ceph Tracing Studio',
      icon: <Crosshair className="w-3.5 h-3.5" />,
    },
    {
      id: 'photo',
      ar: 'تحليل الصور السريرية',
      en: 'Photo Analysis',
      icon: <Camera className="w-3.5 h-3.5" />,
    },
    {
      id: 'scanner',
      ar: 'الماسح الضوئي 3D وبولتون',
      en: '3D Scanner & Bolton',
      icon: <FileBox className="w-3.5 h-3.5" />,
    },
    {
      id: 'cbct',
      ar: 'السي بي سي تي (CBCT)',
      en: 'CBCT 3D MPR',
      icon: <Scan className="w-3.5 h-3.5" />,
    },
    {
      id: 'compare',
      ar: 'المقارنة والسجل',
      en: 'Compare & History',
      icon: <Table className="w-3.5 h-3.5" />,
    },
  ];

  return (
    <div className="space-y-5">
      {/* Unified Aqlan Studio Navigation Strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-navy-200 rounded-xl p-2">
        <div className="flex flex-wrap items-center gap-1">
          {navItems.map((item) => {
            const active = subMode === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSubMode(item.id)}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-navy-900 text-white shadow-sm'
                    : 'text-navy-600 hover:bg-navy-50 hover:text-navy-900'
                }`}
              >
                <span className={active ? 'text-brand-orange' : 'text-navy-400'}>{item.icon}</span>
                <span>{lang === 'ar' ? item.ar : item.en}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 text-xs px-2">
          <span className="text-navy-500 font-medium">{tr(lang, 'المرحلة:', 'Stage:')}</span>
          <select
            value={stage}
            onChange={(e) => setStage(e.target.value as RecordStage)}
            className="px-2.5 py-1.5 border border-navy-200 rounded-lg bg-navy-50 font-mono text-xs font-semibold text-navy-900"
          >
            <option value="T0">T0</option>
            <option value="T1">T1</option>
            <option value="T2">T2</option>
            <option value="T3">T3</option>
          </select>
        </div>
      </div>

      {/* 0. Scientific Manual Diagnostic Workstation */}
      {subMode === 'manual' && (
        <div className="space-y-4">
          {/* Zone 1: Unified Clinical Control Ribbon */}
          <div className="bg-navy-900 text-white rounded-xl border border-navy-800 px-4 py-3 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 text-xs text-navy-300 font-mono tabular-nums">
                <span>STAGE {stage}</span>
                <span>·</span>
                <span>{tr(lang, 'مختبر القياسات اليدوية المعايرة', 'CALIBRATED MANUAL BIOMETRICS LAB')}</span>
                <span>·</span>
                <span>mm / deg</span>
              </div>
              <h3 className="text-sm font-bold text-white">
                {tr(
                  lang,
                  'نظام التحليل التقويمي اليدوي (القوالب الجبسية · الأسنان المختلطة · السيفالومتري الرقمي)',
                  'Manual Orthodontic Biometrics Suite (Permanent Casts · Mixed Dentition · Cephalometrics)',
                )}
              </h3>
            </div>

            {/* 3-Protocol Segmented Selector */}
            <div className="flex flex-wrap items-center gap-1 bg-navy-950/80 p-1 rounded-lg border border-navy-700">
              {(
                [
                  {
                    id: 'permanent',
                    code: '01',
                    ar: 'الأسنان الدائمة (8 تحاليل)',
                    en: 'Permanent Cast (8)',
                  },
                  {
                    id: 'mixed',
                    code: '02',
                    ar: 'الأسنان المختلطة (7 تحاليل)',
                    en: 'Mixed Dentition (7)',
                  },
                  {
                    id: 'ceph',
                    code: '03',
                    ar: 'السيفالومتري اليدوي (16 قياساً)',
                    en: 'Manual Ceph (16)',
                  },
                ] as const
              ).map((tab) => {
                const active = manualLabView === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setManualLabView(tab.id)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors flex items-center gap-1.5 ${
                      active
                        ? 'bg-brand-orange text-navy-950 font-bold'
                        : 'text-navy-200 hover:bg-navy-800 hover:text-white'
                    }`}
                  >
                    <span className={`font-mono text-[11px] ${active ? 'text-navy-950/70' : 'text-navy-400'}`}>
                      {tab.code}
                    </span>
                    <span>{lang === 'ar' ? tab.ar : tab.en}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ================================================================= */}
          {/* PROTOCOL 01: PERMANENT DENTITION SPLIT WORKSTATION (8 ANALYSES)    */}
          {/* ================================================================= */}
          {manualLabView === 'permanent' && (
            <div className="space-y-4">
              {/* Protocol Action Strip */}
              <div className="bg-white border border-navy-200 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-navy-600">
                  <span className="font-bold text-navy-900">
                    {tr(lang, 'بروتوكول الأسنان الدائمة الكامل', 'Permanent Dentition Protocol')}
                  </span>
                  <span className="mx-2 text-navy-300">·</span>
                  <span>
                    {tr(
                      lang,
                      'بولتون · كاري · بونت · ليندر-هارث · كوركهاوس · آشلي-هاو · ليتل · بيك وبيك',
                      'Bolton · Carey · Pont · Linder-Harth · Korkhaus · Ashley-Howe · Little · Peck & Peck',
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleSaveBolton(true)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-navy-900 hover:bg-navy-800 text-white text-xs font-semibold rounded-lg transition-colors"
                >
                  <Save className="w-3.5 h-3.5 text-brand-orange" />
                  <span>{tr(lang, 'حفظ حزمة الأسنان الدائمة (8 تحاليل)', 'Save Permanent Analyses')}</span>
                </button>
              </div>

              {/* Asymmetric 2-Column Split Console: Input Protocol vs Live Empirical Report */}
              <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
                {/* LEFT/START COLUMN: Calibrated Input Parameter Sheet */}
                <div className="xl:col-span-6 bg-white border border-navy-200 rounded-xl divide-y divide-navy-200 overflow-hidden">
                  {/* Step 01: Mesiodistal Odontogram Matrix */}
                  <div className="p-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-[11px] font-mono font-bold text-brand-blue">01 / ODONTOGRAM</span>
                        <h4 className="text-xs font-bold text-navy-900 mt-0.5">
                          {tr(lang, 'مصفوفة العرض الأنسي الوحشي للأسنان الدائمة (mm)', 'Mesiodistal Tooth Width Matrix (mm)')}
                        </h4>
                      </div>
                      <span className="text-[11px] font-mono tabular-nums text-navy-500">
                        SI(12–22) = <strong className="text-navy-900">{permSuite.siUpper}</strong> mm
                      </span>
                    </div>

                    {/* Upper Arch Matrix */}
                    <div className="border border-navy-200 rounded-lg overflow-hidden">
                      <div className="bg-navy-50 px-3 py-2 border-b border-navy-200 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-navy-900">{tr(lang, 'القوس العلوي (16–26)', 'Maxillary Arch (16–26)')}</span>
                          <span className="text-[11px] font-mono tabular-nums text-navy-500">
                            U6={boltonStats.u6} · U10(5–5)={boltonStats.u10} · U12={boltonStats.u12} mm
                          </span>
                        </div>
                        <label className="flex items-center gap-1.5 text-[11px] text-navy-700">
                          <span>{tr(lang, 'المساحة المتاحة (6M–6M):', 'Avail. Space (6M–6M):')}</span>
                          <input
                            type="number"
                            step="0.5"
                            value={spaceU}
                            onChange={(e) => setSpaceU(Number(e.target.value))}
                            className="w-16 px-1.5 py-0.5 border border-navy-300 rounded font-mono tabular-nums text-xs text-center bg-white font-semibold text-navy-900"
                          />
                          <span className="text-navy-400 font-mono">mm</span>
                        </label>
                      </div>
                      <div className="grid grid-cols-6 sm:grid-cols-12 divide-x divide-navy-100 bg-white" dir="ltr">
                        {upperTeeth.map((fdi) => (
                          <label
                            key={fdi}
                            className={`p-1.5 text-center block ${
                              ['13', '12', '11', '21', '22', '23'].includes(fdi) ? 'bg-navy-50/40' : ''
                            }`}
                          >
                            <span className="block text-[10px] font-mono text-navy-500 mb-1">{fdi}</span>
                            <input
                              type="number"
                              step="0.1"
                              value={toothWidths[fdi] ?? ''}
                              onChange={(e) => setToothWidths({ ...toothWidths, [fdi]: Number(e.target.value) })}
                              className="w-full py-1 text-[11px] text-center font-mono tabular-nums border border-navy-200 rounded bg-white text-navy-900 focus:border-brand-blue focus:outline-none"
                            />
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* Lower Arch Matrix */}
                    <div className="border border-navy-200 rounded-lg overflow-hidden">
                      <div className="bg-navy-50 px-3 py-2 border-b border-navy-200 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-navy-900">{tr(lang, 'القوس السفلي (46–36)', 'Mandibular Arch (46–36)')}</span>
                          <span className="text-[11px] font-mono tabular-nums text-navy-500">
                            L6={boltonStats.l6} · L10(5–5)={boltonStats.l10} · L12={boltonStats.l12} mm
                          </span>
                        </div>
                        <label className="flex items-center gap-1.5 text-[11px] text-navy-700">
                          <span>{tr(lang, 'المساحة المتاحة (6M–6M):', 'Avail. Space (6M–6M):')}</span>
                          <input
                            type="number"
                            step="0.5"
                            value={spaceL}
                            onChange={(e) => setSpaceL(Number(e.target.value))}
                            className="w-16 px-1.5 py-0.5 border border-navy-300 rounded font-mono tabular-nums text-xs text-center bg-white font-semibold text-navy-900"
                          />
                          <span className="text-navy-400 font-mono">mm</span>
                        </label>
                      </div>
                      <div className="grid grid-cols-6 sm:grid-cols-12 divide-x divide-navy-100 bg-white" dir="ltr">
                        {lowerTeeth.map((fdi) => (
                          <label
                            key={fdi}
                            className={`p-1.5 text-center block ${
                              ['43', '42', '41', '31', '32', '33'].includes(fdi) ? 'bg-navy-50/40' : ''
                            }`}
                          >
                            <span className="block text-[10px] font-mono text-navy-500 mb-1">{fdi}</span>
                            <input
                              type="number"
                              step="0.1"
                              value={toothWidths[fdi] ?? ''}
                              onChange={(e) => setToothWidths({ ...toothWidths, [fdi]: Number(e.target.value) })}
                              className="w-full py-1 text-[11px] text-center font-mono tabular-nums border border-navy-200 rounded bg-white text-navy-900 focus:border-brand-blue focus:outline-none"
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Step 02: Cast Caliper Transverse, Sagittal & Basal Table */}
                  <div className="p-4 space-y-3">
                    <div>
                      <span className="text-[11px] font-mono font-bold text-brand-blue">02 / ARCH & BASAL CALIPER</span>
                      <h4 className="text-xs font-bold text-navy-900 mt-0.5">
                        {tr(lang, 'قياسات الفرجار المستعرضة والقاعدية والإطباقية على القالب', 'Transverse, Sagittal & Basal Cast Dimensions')}
                      </h4>
                    </div>

                    <div className="border border-navy-200 rounded-lg overflow-hidden">
                      <table className="w-full text-xs">
                        <thead className="bg-navy-50 border-b border-navy-200 text-navy-600">
                          <tr>
                            <th className="py-2 px-3 text-start font-semibold">{tr(lang, 'البعد التشريحي', 'Anatomical Dimension')}</th>
                            <th className="py-2 px-3 text-start font-semibold hidden sm:table-cell">{tr(lang, 'النقاط المرجعية', 'Reference Landmarks')}</th>
                            <th className="py-2 px-3 text-end font-semibold">{tr(lang, 'القيمة (mm)', 'Value (mm)')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-navy-100">
                          {(
                            [
                              ['intercanineU', 'عرض بين الأنياب العلوي (3-3 U)', 'Upper 3-3 Width', 'Cusp tips 13–23'],
                              ['intercanineL', 'عرض بين الأنياب السفلي (3-3 L)', 'Lower 3-3 Width', 'Cusp tips 43–33'],
                              ['interpremolarU', 'عرض الضواحك العلوي (4-4 Pont)', 'Upper 4-4 (Pont)', 'Distal pit 14–24'],
                              ['premolarDiameterPmdU', 'عرض الضواحك (Ashley-Howe PMD)', 'Ashley-Howe PMD', 'Buccal cusp tips 14–24'],
                              ['intermolarU', 'عرض الأضراس العلوي (6-6 Pont)', 'Upper 6-6 (Pont)', 'Mesial pit 16–26'],
                              ['intermolarL', 'عرض الأضراس السفلي (6-6 L)', 'Lower 6-6 Width', 'Central fossa 46–36'],
                              ['anteriorArchLenU', 'طول القوس الأمامي Lu (Korkhaus)', 'Korkhaus Length Lu', '11/21 labial ⊥ 4-4 line'],
                              ['premolarBasalWidthU', 'عرض القاعدة الذروية (Ashley-Howe)', 'Ashley-Howe PMBAW', 'Canine fossa above 14–24'],
                              ['curveOfSpee', 'عمق قوس سبي (Carey / Spee)', 'Curve of Spee', 'Max cusp-to-plane depth'],
                              ['overjet', 'التراكب الأفقي (Overjet)', 'Overjet', 'Labial U1 – Labial L1'],
                              ['overbite', 'التراكب العمودي (Overbite)', 'Overbite', 'Vertical overlap U1/L1'],
                            ] as const
                          ).map(([key, ar, en, landmark]) => (
                            <tr key={key} className="hover:bg-navy-50/40">
                              <td className="py-1.5 px-3 font-medium text-navy-900">{lang === 'ar' ? ar : en}</td>
                              <td className="py-1.5 px-3 text-[11px] font-mono text-navy-400 hidden sm:table-cell">{landmark}</td>
                              <td className="py-1.5 px-3 text-end">
                                <div className="inline-flex items-center gap-1.5">
                                  <input
                                    type="number"
                                    step="0.5"
                                    value={manualCast[key]}
                                    onChange={(e) => setManualCast((prev) => ({ ...prev, [key]: e.target.value }))}
                                    className="w-20 px-2 py-1 border border-navy-200 rounded font-mono tabular-nums text-xs text-center bg-white text-navy-900 focus:border-brand-blue focus:outline-none"
                                  />
                                  <span className="text-[10px] font-mono text-navy-400">mm</span>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Step 03: Little's 5 Contacts + Peck & Peck FL */}
                  <div className="p-4 space-y-4">
                    <div>
                      <span className="text-[11px] font-mono font-bold text-brand-blue">03 / ANTERIOR IRREGULARITY & CROWN SHAPE</span>
                      <h4 className="text-xs font-bold text-navy-900 mt-0.5">
                        {tr(lang, 'إزاحة نقاط التماس (Little) والسماكة الدهليزية-اللسانية (Peck & Peck)', "Little's Contacts & Peck & Peck Faciolingual Widths")}
                      </h4>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="border border-navy-200 rounded-lg p-3 space-y-2 bg-navy-50/30">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-navy-900">{tr(lang, 'نقاط تماس ليتل (5)', "Little's 5 Contacts")}</span>
                          <span className="font-mono tabular-nums font-bold text-brand-orange">{permSuite.littleSum} mm</span>
                        </div>
                        <div className="grid grid-cols-5 gap-1.5" dir="ltr">
                          {(
                            [
                              ['little1', '43-42'],
                              ['little2', '42-41'],
                              ['little3', '41-31'],
                              ['little4', '31-32'],
                              ['little5', '32-33'],
                            ] as const
                          ).map(([k, lbl]) => (
                            <label key={k} className="text-center">
                              <span className="block text-[10px] font-mono text-navy-500 mb-0.5">{lbl}</span>
                              <input
                                type="number"
                                step="0.1"
                                min="0"
                                value={manualCast[k]}
                                onChange={(e) => setManualCast((p) => ({ ...p, [k]: e.target.value }))}
                                className="w-full py-1 border border-navy-200 rounded text-[11px] text-center font-mono tabular-nums bg-white"
                              />
                            </label>
                          ))}
                        </div>
                      </div>

                      <div className="border border-navy-200 rounded-lg p-3 space-y-2 bg-navy-50/30">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-navy-900">{tr(lang, 'سماكة بيك FL (42–32)', 'Peck & Peck FL Widths')}</span>
                          <span className="text-[10px] font-mono text-navy-500">C: 88–92% | L: 90–95%</span>
                        </div>
                        <div className="grid grid-cols-4 gap-1.5" dir="ltr">
                          {(
                            [
                              ['fl42', '42', permSuite.peck42],
                              ['fl41', '41', permSuite.peck41],
                              ['fl31', '31', permSuite.peck31],
                              ['fl32', '32', permSuite.peck32],
                            ] as const
                          ).map(([k, fdi, ratio]) => (
                            <label key={k} className="text-center">
                              <span className="block text-[10px] font-mono text-navy-500 mb-0.5">
                                #{fdi} · {ratio ?? '—'}%
                              </span>
                              <input
                                type="number"
                                step="0.1"
                                min="3"
                                value={manualCast[k]}
                                onChange={(e) => setManualCast((p) => ({ ...p, [k]: e.target.value }))}
                                className="w-full py-1 border border-navy-200 rounded text-[11px] text-center font-mono tabular-nums bg-white"
                              />
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* RIGHT/END COLUMN: Empirical 8-Analysis Diagnostic Report */}
                <div className="xl:col-span-6 bg-white border border-navy-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 bg-navy-50 border-b border-navy-200 flex items-center justify-between">
                    <div>
                      <span className="text-[11px] font-mono font-bold text-navy-500">DIAGNOSTIC OUTPUT</span>
                      <h4 className="text-xs font-bold text-navy-900">
                        {tr(lang, 'التقرير التحليلي الفوري للأسنان الدائمة (8 مؤشرات سريرية)', 'Live Permanent Dentition Diagnostic Matrix (8 Analyses)')}
                      </h4>
                    </div>
                    <span className="text-[11px] font-mono text-navy-500">n = 8</span>
                  </div>

                  {/* Top 4 Telemetry Cells */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-navy-200 border-b border-navy-200">
                    <div className="p-3">
                      <span className="block text-[10px] font-mono text-navy-500 uppercase">Bolton Ant (6)</span>
                      <div className="mt-1 flex items-baseline gap-1">
                        <span className="text-xl font-bold font-mono tabular-nums text-navy-900">
                          {boltonStats.anteriorRatio ?? '—'}
                        </span>
                        <span className="text-xs font-mono text-navy-400">%</span>
                      </div>
                      <span className="text-[11px] text-navy-600 block mt-0.5">
                        {boltonStats.anteriorExcessArch === 'lower'
                          ? tr(lang, `زيادة سفلية ${boltonStats.anteriorExcess} مم`, `Mand +${boltonStats.anteriorExcess}mm`)
                          : tr(lang, `زيادة علوية ${boltonStats.anteriorExcess} مم`, `Max +${boltonStats.anteriorExcess}mm`)}
                      </span>
                    </div>

                    <div className="p-3">
                      <span className="block text-[10px] font-mono text-navy-500 uppercase">Bolton All (12)</span>
                      <div className="mt-1 flex items-baseline gap-1">
                        <span className="text-xl font-bold font-mono tabular-nums text-navy-900">
                          {boltonStats.overallRatio ?? '—'}
                        </span>
                        <span className="text-xs font-mono text-navy-400">%</span>
                      </div>
                      <span className="text-[11px] text-navy-600 block mt-0.5">
                        {boltonStats.overallExcessArch === 'lower'
                          ? tr(lang, `زيادة سفلية ${boltonStats.overallExcess} مم`, `Mand +${boltonStats.overallExcess}mm`)
                          : tr(lang, `زيادة علوية ${boltonStats.overallExcess} مم`, `Max +${boltonStats.overallExcess}mm`)}
                      </span>
                    </div>

                    <div className="p-3">
                      <span className="block text-[10px] font-mono text-navy-500 uppercase">Carey Net (L)</span>
                      <div className="mt-1 flex items-baseline gap-1">
                        <span
                          className={`text-xl font-bold font-mono tabular-nums ${
                            permSuite.careyNetLower < -1 ? 'text-rose-700' : permSuite.careyNetLower < 0 ? 'text-amber-700' : 'text-emerald-700'
                          }`}
                        >
                          {permSuite.careyNetLower > 0 ? `+${permSuite.careyNetLower}` : permSuite.careyNetLower}
                        </span>
                        <span className="text-xs font-mono text-navy-400">mm</span>
                      </div>
                      <span className="text-[11px] text-navy-500 block mt-0.5">
                        U(5–5): {boltonStats.upperDiscrepancy > 0 ? `+${boltonStats.upperDiscrepancy}` : boltonStats.upperDiscrepancy} mm
                      </span>
                    </div>

                    <div className="p-3">
                      <span className="block text-[10px] font-mono text-navy-500 uppercase">Little&apos;s Index</span>
                      <div className="mt-1 flex items-baseline gap-1">
                        <span
                          className={`text-xl font-bold font-mono tabular-nums ${
                            permSuite.littleSum > 6 ? 'text-rose-700' : permSuite.littleSum > 3 ? 'text-amber-700' : 'text-emerald-700'
                          }`}
                        >
                          {permSuite.littleSum}
                        </span>
                        <span className="text-xs font-mono text-navy-400">mm</span>
                      </div>
                      <span className="text-[11px] text-navy-500 block mt-0.5 truncate">{permSuite.littleSeverity}</span>
                    </div>
                  </div>

                  {/* Structured 8-Row Clinical Analysis Table */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-navy-50/70 border-b border-navy-200 text-navy-600">
                        <tr>
                          <th className="py-2 px-3 text-start font-semibold">{tr(lang, '# التحليل والمعادلة', '# Analysis & Formula')}</th>
                          <th className="py-2 px-3 text-end font-semibold">{tr(lang, 'المقاس', 'Measured')}</th>
                          <th className="py-2 px-3 text-end font-semibold">{tr(lang, 'المثالي', 'Norm / Ideal')}</th>
                          <th className="py-2 px-3 text-start font-semibold">{tr(lang, 'التفسير السريري', 'Clinical Finding')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-navy-100">
                        {/* 1. Bolton Anterior */}
                        <tr>
                          <td className="py-2.5 px-3">
                            <span className="font-bold text-navy-900">01. Bolton Anterior (6)</span>
                            <span className="block text-[10px] font-mono text-navy-400">L6 ({boltonStats.l6}) / U6 ({boltonStats.u6}) × 100</span>
                          </td>
                          <td className="py-2.5 px-3 text-end font-mono tabular-nums font-bold text-navy-900">
                            {boltonStats.anteriorRatio ?? '—'}%
                          </td>
                          <td className="py-2.5 px-3 text-end font-mono tabular-nums text-navy-500">77.2 ± 1.65%</td>
                          <td className="py-2.5 px-3">
                            {boltonStats.anteriorRatio !== null && Math.abs(boltonStats.anteriorRatio - 77.2) <= 1.65 ? (
                              <span className="text-emerald-700 font-medium">✓ {tr(lang, 'تناسب أمامي متوازن', 'Balanced anterior ratio')}</span>
                            ) : (
                              <span className="text-amber-700 font-medium">
                                ▲ {boltonStats.anteriorExcessArch === 'lower' ? tr(lang, 'فائض سني سفلي', 'Mand. excess') : tr(lang, 'فائض سني علوي', 'Max. excess')} ({boltonStats.anteriorExcess} mm)
                              </span>
                            )}
                          </td>
                        </tr>

                        {/* 2. Bolton Overall */}
                        <tr>
                          <td className="py-2.5 px-3">
                            <span className="font-bold text-navy-900">02. Bolton Overall (12)</span>
                            <span className="block text-[10px] font-mono text-navy-400">L12 ({boltonStats.l12}) / U12 ({boltonStats.u12}) × 100</span>
                          </td>
                          <td className="py-2.5 px-3 text-end font-mono tabular-nums font-bold text-navy-900">
                            {boltonStats.overallRatio ?? '—'}%
                          </td>
                          <td className="py-2.5 px-3 text-end font-mono tabular-nums text-navy-500">91.3 ± 1.91%</td>
                          <td className="py-2.5 px-3">
                            {boltonStats.overallRatio !== null && Math.abs(boltonStats.overallRatio - 91.3) <= 1.91 ? (
                              <span className="text-emerald-700 font-medium">✓ {tr(lang, 'ضمن النطاق الطبيعي', 'Within norm')} ({boltonStats.overallExcess} mm)</span>
                            ) : (
                              <span className="text-amber-700 font-medium">
                                ▲ {boltonStats.overallExcessArch === 'lower' ? tr(lang, 'زيادة سفلية كلية', 'Mandibular excess') : tr(lang, 'زيادة علوية كلية', 'Maxillary excess')} ({boltonStats.overallExcess} mm)
                              </span>
                            )}
                          </td>
                        </tr>

                        {/* 3. Upper Arch Perimeter & Carey Space / Spee */}
                        <tr>
                          <td className="py-2.5 px-3">
                            <span className="font-bold text-navy-900">03. Arch Perimeter &amp; Carey (5–5)</span>
                            <span className="block text-[10px] font-mono text-navy-400">U10 {boltonStats.u10} · L10 {boltonStats.l10} · Spee -{permSuite.speeSpaceNeeded}</span>
                          </td>
                          <td className="py-2.5 px-3 text-end font-mono tabular-nums font-bold text-navy-900">
                            U {boltonStats.upperDiscrepancy} / L {permSuite.careyNetLower} mm
                          </td>
                          <td className="py-2.5 px-3 text-end font-mono tabular-nums text-navy-500">0 ± 1.0 mm</td>
                          <td className="py-2.5 px-3 space-y-0.5">
                            <span className={`block ${boltonStats.upperDiscrepancy < -2.5 ? 'text-rose-700 font-medium' : boltonStats.upperDiscrepancy < 0 ? 'text-amber-700 font-medium' : 'text-emerald-700 font-medium'}`}>
                              U: {permSuite.upperArchPlan}
                            </span>
                            <span className={`block ${permSuite.careyNetLower < -2.5 ? 'text-rose-700 font-medium' : permSuite.careyNetLower < 0 ? 'text-amber-700 font-medium' : 'text-emerald-700 font-medium'}`}>
                              L: {permSuite.careyPlan}
                            </span>
                          </td>
                        </tr>

                        {/* 4. Pont's Index */}
                        <tr>
                          <td className="py-2.5 px-3">
                            <span className="font-bold text-navy-900">04. Pont&apos;s Index (4-4 / 6-6)</span>
                            <span className="block text-[10px] font-mono text-navy-400">SI×100/80 · SI×100/64 (+1–2 mm)</span>
                          </td>
                          <td className="py-2.5 px-3 text-end font-mono tabular-nums font-bold text-navy-900">
                            {manualCast.interpremolarU} / {manualCast.intermolarU}
                          </td>
                          <td className="py-2.5 px-3 text-end font-mono tabular-nums text-navy-500">
                            {permSuite.pontPremolarIdeal} / {permSuite.pontMolarIdeal}
                          </td>
                          <td className="py-2.5 px-3 space-y-0.5">
                            <span className={`block ${permSuite.pontPremolarDiff < -1 || permSuite.pontMolarDiff < -1 ? 'text-amber-700 font-medium' : 'text-emerald-700 font-medium'}`}>
                              Δ 4-4: {permSuite.pontPremolarDiff > 0 ? '+' : ''}{permSuite.pontPremolarDiff} · 6-6: {permSuite.pontMolarDiff > 0 ? '+' : ''}{permSuite.pontMolarDiff} mm
                            </span>
                            <span className="block text-[10px] text-navy-400">
                              {tr(lang, 'يُضاف +1–2 مم وقاية للارتداد', '+1–2 mm overexpansion advised')}
                            </span>
                          </td>
                        </tr>

                        {/* 5. Linder-Harth Index */}
                        <tr>
                          <td className="py-2.5 px-3">
                            <span className="font-bold text-navy-900">05. Linder-Harth Index</span>
                            <span className="block text-[10px] font-mono text-navy-400">SI×100/85 · SI×100/65</span>
                          </td>
                          <td className="py-2.5 px-3 text-end font-mono tabular-nums font-bold text-navy-900">
                            {manualCast.interpremolarU} / {manualCast.intermolarU}
                          </td>
                          <td className="py-2.5 px-3 text-end font-mono tabular-nums text-navy-500">
                            {permSuite.linderPremolarIdeal} / {permSuite.linderMolarIdeal}
                          </td>
                          <td className="py-2.5 px-3">
                            <span className={permSuite.linderPremolarDiff < -1 || permSuite.linderMolarDiff < -1 ? 'text-amber-700 font-medium' : 'text-emerald-700 font-medium'}>
                              Δ 4-4: {permSuite.linderPremolarDiff > 0 ? '+' : ''}{permSuite.linderPremolarDiff} · 6-6: {permSuite.linderMolarDiff > 0 ? '+' : ''}{permSuite.linderMolarDiff} mm
                            </span>
                          </td>
                        </tr>

                        {/* 6. Korkhaus Anterior Length */}
                        <tr>
                          <td className="py-2.5 px-3">
                            <span className="font-bold text-navy-900">06. Korkhaus Ant. Length (Lu)</span>
                            <span className="block text-[10px] font-mono text-navy-400">SI × 100 / 160</span>
                          </td>
                          <td className="py-2.5 px-3 text-end font-mono tabular-nums font-bold text-navy-900">
                            {manualCast.anteriorArchLenU} mm
                          </td>
                          <td className="py-2.5 px-3 text-end font-mono tabular-nums text-navy-500">
                            {permSuite.korkhausIdealLu} mm
                          </td>
                          <td className="py-2.5 px-3">
                            <span className={Math.abs(permSuite.korkhausDiff) > 1.5 ? 'text-amber-700 font-medium' : 'text-emerald-700 font-medium'}>
                              {permSuite.korkhausDiff > 1.5
                                ? `▲ ${tr(lang, 'بروز أمامي', 'Proclined')} (+${permSuite.korkhausDiff} mm)`
                                : permSuite.korkhausDiff < -1.5
                                ? `▼ ${tr(lang, 'تراجع أمامي', 'Retroclined')} (${permSuite.korkhausDiff} mm)`
                                : `✓ ${tr(lang, 'طول أمامي متوازن', 'Balanced Lu')}`}
                            </span>
                          </td>
                        </tr>

                        {/* 7. Ashley-Howe Basal Index (Inference I & II) */}
                        <tr>
                          <td className="py-2.5 px-3">
                            <span className="font-bold text-navy-900">07. Ashley-Howe (Inf. I &amp; II)</span>
                            <span className="block text-[10px] font-mono text-navy-400">PMBAW vs PMD · PMBAW/TTM×100</span>
                          </td>
                          <td className="py-2.5 px-3 text-end font-mono tabular-nums font-bold text-navy-900">
                            {permSuite.ashleyHowePct ?? '—'}%
                          </td>
                          <td className="py-2.5 px-3 text-end font-mono tabular-nums text-navy-500">&gt; 44.0%</td>
                          <td className="py-2.5 px-3 space-y-0.5">
                            <span className={`block text-[11px] font-medium ${permSuite.ashleyExpansionPossible ? 'text-emerald-700' : 'text-amber-700'}`}>
                              Inf I: {permSuite.ashleyInferenceI}
                            </span>
                            <span className={`block ${permSuite.ashleyHowePct !== null && permSuite.ashleyHowePct < 37 ? 'text-rose-700 font-medium' : permSuite.ashleyHowePct !== null && permSuite.ashleyHowePct <= 44 ? 'text-amber-700 font-medium' : 'text-emerald-700 font-medium'}`}>
                              Inf II: {permSuite.ashleyHoweCategory}
                            </span>
                          </td>
                        </tr>

                        {/* 8. Little's & Peck & Peck */}
                        <tr>
                          <td className="py-2.5 px-3">
                            <span className="font-bold text-navy-900">08. Little&apos;s &amp; Peck-Peck</span>
                            <span className="block text-[10px] font-mono text-navy-400">∑5 Contacts · MD/FL %</span>
                          </td>
                          <td className="py-2.5 px-3 text-end font-mono tabular-nums font-bold text-navy-900">
                            {permSuite.littleSum} mm
                          </td>
                          <td className="py-2.5 px-3 text-end font-mono tabular-nums text-navy-500">0–3mm · C88–92/L90–95%</td>
                          <td className="py-2.5 px-3 space-y-0.5">
                            <span className="block text-navy-800 font-medium">{permSuite.littleSeverity}</span>
                            <span className="block text-[10px] font-mono text-navy-500">
                              MD/FL: #42 {permSuite.peck42 ?? '—'}% · #41 {permSuite.peck41 ?? '—'}% · #31 {permSuite.peck31 ?? '—'}% · #32 {permSuite.peck32 ?? '—'}%
                            </span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================= */}
          {/* PROTOCOL 02: MIXED DENTITION SPLIT WORKSTATION (7 ANALYSES)       */}
          {/* ================================================================= */}
          {manualLabView === 'mixed' && (
            <div className="space-y-4">
              {/* Protocol Action & Calibration Ribbon */}
              <div className="bg-white border border-navy-200 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-4 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-navy-600">{tr(lang, 'الجنس:', 'Sex:')}</span>
                    <div className="inline-flex border border-navy-200 rounded-md overflow-hidden">
                      {(['male', 'female'] as const).map((sx) => (
                        <button
                          key={sx}
                          type="button"
                          onClick={() => setMixedInput((p) => ({ ...p, sex: sx }))}
                          className={`px-2.5 py-1 text-xs font-semibold ${
                            mixedInput.sex === sx ? 'bg-navy-900 text-white' : 'bg-white text-navy-700 hover:bg-navy-50'
                          }`}
                        >
                          {sx === 'male' ? tr(lang, 'ذكر', 'M') : tr(lang, 'أنثى', 'F')}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-navy-600">{tr(lang, 'ثقة مويرز:', 'Moyers %:')}</span>
                    <div className="inline-flex border border-navy-200 rounded-md overflow-hidden">
                      {([50, 75, 85, 95] as const).map((conf) => (
                        <button
                          key={conf}
                          type="button"
                          onClick={() => setMixedInput((p) => ({ ...p, moyersConfidence: conf }))}
                          className={`px-2 py-1 text-xs font-mono font-bold ${
                            mixedInput.moyersConfidence === conf
                              ? 'bg-brand-orange text-navy-950'
                              : 'bg-white text-navy-700 hover:bg-navy-50'
                          }`}
                        >
                          {conf}%
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-navy-600">{tr(lang, 'مصدر الناب (3):', 'Canine (3):')}</span>
                    <div className="inline-flex border border-navy-200 rounded-md overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setMixedInput((p) => ({ ...p, canineSource: 'radiographic' }))}
                        className={`px-2.5 py-1 text-xs font-semibold ${
                          mixedInput.canineSource === 'radiographic'
                            ? 'bg-navy-900 text-white'
                            : 'bg-white text-navy-700 hover:bg-navy-50'
                        }`}
                      >
                        {tr(lang, 'قياس الأشعة (هوكابا)', 'X-ray (Huckaba)')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setMixedInput((p) => ({ ...p, canineSource: 'predicted' }))}
                        className={`px-2.5 py-1 text-xs font-semibold ${
                          mixedInput.canineSource === 'predicted'
                            ? 'bg-navy-900 text-white'
                            : 'bg-white text-navy-700 hover:bg-navy-50'
                        }`}
                      >
                        {tr(lang, 'التنبؤ الحسابي', 'Predicted')}
                      </button>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleSaveMixedDentition}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-navy-900 hover:bg-navy-800 text-white text-xs font-semibold rounded-lg"
                >
                  <Save className="w-3.5 h-3.5 text-brand-orange" />
                  <span>{tr(lang, 'حفظ تحاليل الأسنان المختلطة (8 تحاليل)', 'Save Mixed Dentition Analyses (8)')}</span>
                </button>
              </div>

              {/* Asymmetric Split Console */}
              <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
                {/* LEFT/START COLUMN: Incisors + Space Available + Huckaba 4-Quadrant Matrix */}
                <div className="xl:col-span-6 bg-white border border-navy-200 rounded-xl divide-y divide-navy-200 overflow-hidden">
                  {/* Step 01: Permanent & Primary Incisors */}
                  <div className="p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="text-[11px] font-mono font-bold text-brand-blue">01 / INCISOR LIABILITY & PREDICTORS</span>
                        <h4 className="text-xs font-bold text-navy-900 mt-0.5">
                          {tr(lang, 'عرض القواطع الدائمة واللبنية (مفتاح مويرز وتاناكا والتنبؤ بالناب)', 'Permanent & Primary Incisors (Moyers, Tanaka & Canine Key)')}
                        </h4>
                      </div>
                      <span className="text-[11px] font-mono tabular-nums text-navy-600">
                        {tr(lang, 'تنبؤ الناب:', 'Pred 3:')} U <strong>{mixedSuite.predictedCanineU}</strong> / L <strong>{mixedSuite.predictedCanineL}</strong> mm
                      </span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="border border-navy-200 rounded-lg p-3 space-y-2.5 bg-navy-50/30">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-navy-900">{tr(lang, 'السفلية الدائمة (42–32)', 'Lower Perm (42–32)')}</span>
                          <span className="font-mono tabular-nums font-bold text-brand-orange">∑ = {mixedSuite.sumLowerIncisors} mm</span>
                        </div>
                        <div className="grid grid-cols-4 gap-1.5" dir="ltr">
                          {(['w42', 'w41', 'w31', 'w32'] as const).map((k) => (
                            <label key={k} className="text-center">
                              <span className="block text-[10px] font-mono text-navy-500 mb-0.5">{k.slice(1)}</span>
                              <input
                                type="number"
                                step="0.1"
                                value={mixedInput[k]}
                                onChange={(e) => setMixedInput((p) => ({ ...p, [k]: Number(e.target.value) }))}
                                className="w-full py-1 border border-navy-200 rounded text-xs text-center font-mono tabular-nums bg-white"
                              />
                            </label>
                          ))}
                        </div>
                        <label className="flex items-center justify-between text-[11px] text-navy-600 pt-1 border-t border-navy-200/70">
                          <span>{tr(lang, 'مجموع اللبنية (82–72):', 'Primary Sum (82–72):')}</span>
                          <span className="inline-flex items-center gap-1">
                            <input
                              type="number"
                              step="0.5"
                              value={mixedInput.primaryLowerIncisorsSum}
                              onChange={(e) => setMixedInput((p) => ({ ...p, primaryLowerIncisorsSum: Number(e.target.value) }))}
                              className="w-16 px-1.5 py-0.5 border border-navy-300 rounded font-mono tabular-nums text-xs text-center bg-white"
                            />
                            <span className="font-mono text-navy-400">mm</span>
                          </span>
                        </label>
                      </div>

                      <div className="border border-navy-200 rounded-lg p-3 space-y-2.5 bg-navy-50/30">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-navy-900">{tr(lang, 'العلوية الدائمة (12–22)', 'Upper Perm (12–22)')}</span>
                          <span className="font-mono tabular-nums font-bold text-navy-900">∑ = {mixedSuite.sumUpperIncisors} mm</span>
                        </div>
                        <div className="grid grid-cols-4 gap-1.5" dir="ltr">
                          {(['w12', 'w11', 'w21', 'w22'] as const).map((k) => (
                            <label key={k} className="text-center">
                              <span className="block text-[10px] font-mono text-navy-500 mb-0.5">{k.slice(1)}</span>
                              <input
                                type="number"
                                step="0.1"
                                value={mixedInput[k]}
                                onChange={(e) => setMixedInput((p) => ({ ...p, [k]: Number(e.target.value) }))}
                                className="w-full py-1 border border-navy-200 rounded text-xs text-center font-mono tabular-nums bg-white"
                              />
                            </label>
                          ))}
                        </div>
                        <label className="flex items-center justify-between text-[11px] text-navy-600 pt-1 border-t border-navy-200/70">
                          <span>{tr(lang, 'مجموع اللبنية (52–62):', 'Primary Sum (52–62):')}</span>
                          <span className="inline-flex items-center gap-1">
                            <input
                              type="number"
                              step="0.5"
                              value={mixedInput.primaryUpperIncisorsSum}
                              onChange={(e) => setMixedInput((p) => ({ ...p, primaryUpperIncisorsSum: Number(e.target.value) }))}
                              className="w-16 px-1.5 py-0.5 border border-navy-300 rounded font-mono tabular-nums text-xs text-center bg-white"
                            />
                            <span className="font-mono text-navy-400">mm</span>
                          </span>
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* Step 02: Space Available Method (Quadrant Direct vs Brass-Wire Arch Perimeter) */}
                  <div className="p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="text-[11px] font-mono font-bold text-brand-blue">02 / SPACE AVAILABLE PROTOCOL</span>
                        <h4 className="text-xs font-bold text-navy-900 mt-0.5">
                          {tr(lang, 'قياس المساحة المتاحة (Space Available — وحشي 2 ← أنسي 6 أو محيط القوس 6–6)', 'Space Available Method (Quadrant Segment vs Full Arch Perimeter)')}
                        </h4>
                      </div>
                      <div className="inline-flex border border-navy-200 rounded-md overflow-hidden text-[11px]">
                        <button
                          type="button"
                          onClick={() => setMixedInput((p) => ({ ...p, spaceMode: 'quadrant' }))}
                          className={`px-2.5 py-1 font-semibold ${
                            mixedInput.spaceMode === 'quadrant' ? 'bg-navy-900 text-white' : 'bg-white text-navy-700 hover:bg-navy-50'
                          }`}
                        >
                          {tr(lang, 'مباشر للأرباع (UR/UL/LR/LL)', 'Direct Quadrants')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setMixedInput((p) => ({ ...p, spaceMode: 'arch_perimeter' }))}
                          className={`px-2.5 py-1 font-semibold ${
                            mixedInput.spaceMode === 'arch_perimeter' ? 'bg-navy-900 text-white' : 'bg-white text-navy-700 hover:bg-navy-50'
                          }`}
                        >
                          {tr(lang, 'محيط القوس بالسلك (6–6)', 'Arch Perimeter (6–6)')}
                        </button>
                      </div>
                    </div>

                    {mixedInput.spaceMode === 'arch_perimeter' ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-navy-50/50 border border-navy-200 rounded-lg p-3 text-xs">
                        <label className="space-y-1">
                          <span className="font-bold text-navy-900 block">
                            {tr(lang, 'محيط القوس العلوي الكلي (أنسي 16 ← 26):', 'Upper Arch Perimeter (16M–26M):')}
                          </span>
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              step="0.5"
                              value={mixedInput.archPerimeterU}
                              onChange={(e) => setMixedInput((p) => ({ ...p, archPerimeterU: Number(e.target.value) }))}
                              className="w-24 px-2 py-1 border border-navy-300 rounded font-mono tabular-nums text-xs bg-white font-semibold"
                            />
                            <span className="text-[11px] font-mono text-navy-500">
                              → {tr(lang, 'لكل ربع:', 'Quad:')} <strong>{mixedSuite.effectiveSpaceUR}</strong> mm
                            </span>
                          </div>
                        </label>
                        <label className="space-y-1">
                          <span className="font-bold text-navy-900 block">
                            {tr(lang, 'محيط القوس السفلي الكلي (أنسي 46 ← 36):', 'Lower Arch Perimeter (46M–36M):')}
                          </span>
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              step="0.5"
                              value={mixedInput.archPerimeterL}
                              onChange={(e) => setMixedInput((p) => ({ ...p, archPerimeterL: Number(e.target.value) }))}
                              className="w-24 px-2 py-1 border border-navy-300 rounded font-mono tabular-nums text-xs bg-white font-semibold"
                            />
                            <span className="text-[11px] font-mono text-navy-500">
                              → {tr(lang, 'لكل ربع:', 'Quad:')} <strong>{mixedSuite.effectiveSpaceLR}</strong> mm
                            </span>
                          </div>
                        </label>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-navy-50/50 border border-navy-200 rounded-lg text-[11px] font-mono tabular-nums text-navy-700">
                        <span>
                          {tr(lang, 'المساحة الخلفية المتاحة:', 'Post. Space Avail:')} U <strong>{mixedSuite.totalPostSpaceUpper}</strong> · L <strong>{mixedSuite.totalPostSpaceLower}</strong> mm
                        </span>
                        <span>
                          {tr(lang, 'محيط القوس الإجمالي:', 'Total Arch Space:')} U <strong>{mixedSuite.totalSpaceAvailUpper}</strong> · L <strong>{mixedSuite.totalSpaceAvailLower}</strong> mm
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Step 03: 4-Quadrant Measurements & Huckaba Matrix */}
                  <div className="p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="text-[11px] font-mono font-bold text-brand-blue">03 / HUCKABA & QUADRANT RADIOLOGY MATRIX</span>
                        <h4 className="text-xs font-bold text-navy-900 mt-0.5">
                          {tr(
                            lang,
                            'المساحة المتاحة، اللبنية (c+d+e)، المرجع لهوكابا (d/e)، الناب (3) والضواحك (4+5) بالأشعة',
                            'Available Space, Primary c+d+e, Huckaba Ref Tooth (M_true / M_xray), Canine (3) & Premolars (4+5)',
                          )}
                        </h4>
                      </div>
                    </div>

                    <div className="overflow-x-auto border border-navy-200 rounded-lg">
                      <table className="w-full text-[11px]">
                        <thead className="bg-navy-50 text-navy-700 border-b border-navy-200">
                          <tr>
                            <th className="py-2 px-2 text-start">{tr(lang, 'الربع', 'Quad')}</th>
                            <th className="py-2 px-1.5 text-center">{tr(lang, 'المساحة المتاحة', 'Space Avail')}</th>
                            <th className="py-2 px-1.5 text-center">{tr(lang, 'لبنية c+d+e', 'c+d+e')}</th>
                            <th className="py-2 px-1.5 text-center">{tr(lang, 'مرجع القالب M', 'Cast M_true')}</th>
                            <th className="py-2 px-1.5 text-center">{tr(lang, 'مرجع الأشعة M′', 'X-ray M_xray')}</th>
                            <th className="py-2 px-1.5 text-center">{tr(lang, 'الناب 3 أشعة (حقيقي)', 'X-ray 3 (True)')}</th>
                            <th className="py-2 px-1.5 text-center">{tr(lang, 'الضواحك 4+5 (حقيقي)', 'X-ray 4+5 (True)')}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-navy-100 font-mono tabular-nums">
                          {(
                            [
                              ['UR', 'spaceUR', 'primaryCdeUR', 'castRefToothUR', 'xrayRefToothUR', 'xrayCanineUR', 'xrayPmUR', mixedSuite.effectiveSpaceUR, mixedSuite.huckabaTrueCanineUR, mixedSuite.corrPmUR],
                              ['UL', 'spaceUL', 'primaryCdeUL', 'castRefToothUL', 'xrayRefToothUL', 'xrayCanineUL', 'xrayPmUL', mixedSuite.effectiveSpaceUL, mixedSuite.huckabaTrueCanineUL, mixedSuite.corrPmUL],
                              ['LR', 'spaceLR', 'primaryCdeLR', 'castRefToothLR', 'xrayRefToothLR', 'xrayCanineLR', 'xrayPmLR', mixedSuite.effectiveSpaceLR, mixedSuite.huckabaTrueCanineLR, mixedSuite.corrPmLR],
                              ['LL', 'spaceLL', 'primaryCdeLL', 'castRefToothLL', 'xrayRefToothLL', 'xrayCanineLL', 'xrayPmLL', mixedSuite.effectiveSpaceLL, mixedSuite.huckabaTrueCanineLL, mixedSuite.corrPmLL],
                            ] as const
                          ).map(([q, spK, cdeK, mTrueK, mXrayK, canK, pmK, effSp, true3, true45]) => (
                            <tr key={q}>
                              <td className="py-2 px-2 font-bold text-navy-900">{q}</td>
                              <td className="py-2 px-1 text-center">
                                {mixedInput.spaceMode === 'arch_perimeter' ? (
                                  <span className="inline-block w-14 py-1 bg-navy-50 border border-navy-200 rounded text-navy-900 font-bold">
                                    {effSp}
                                  </span>
                                ) : (
                                  <input
                                    type="number"
                                    step="0.5"
                                    value={mixedInput[spK]}
                                    onChange={(e) => setMixedInput((p) => ({ ...p, [spK]: Number(e.target.value) }))}
                                    className="w-14 px-1 py-1 border border-navy-200 rounded text-center bg-white"
                                  />
                                )}
                              </td>
                              <td className="py-2 px-1 text-center">
                                <input
                                  type="number"
                                  step="0.5"
                                  value={mixedInput[cdeK]}
                                  onChange={(e) => setMixedInput((p) => ({ ...p, [cdeK]: Number(e.target.value) }))}
                                  className="w-14 px-1 py-1 border border-navy-200 rounded text-center bg-white"
                                />
                              </td>
                              <td className="py-2 px-1 text-center">
                                <input
                                  type="number"
                                  step="0.1"
                                  value={mixedInput[mTrueK]}
                                  onChange={(e) => setMixedInput((p) => ({ ...p, [mTrueK]: Number(e.target.value) }))}
                                  className="w-13 px-1 py-1 border border-navy-200 rounded text-center bg-white"
                                />
                              </td>
                              <td className="py-2 px-1 text-center">
                                <input
                                  type="number"
                                  step="0.1"
                                  value={mixedInput[mXrayK]}
                                  onChange={(e) => setMixedInput((p) => ({ ...p, [mXrayK]: Number(e.target.value) }))}
                                  className="w-13 px-1 py-1 border border-navy-200 rounded text-center bg-white"
                                />
                              </td>
                              <td className="py-2 px-1 text-center">
                                <div className="inline-flex flex-col items-center">
                                  <input
                                    type="number"
                                    step="0.1"
                                    value={mixedInput[canK]}
                                    onChange={(e) => setMixedInput((p) => ({ ...p, [canK]: Number(e.target.value) }))}
                                    className="w-13 px-1 py-1 border border-navy-200 rounded text-center bg-white"
                                  />
                                  <span className="text-[9px] text-brand-blue mt-0.5">{true3} mm</span>
                                </div>
                              </td>
                              <td className="py-2 px-1 text-center">
                                <div className="inline-flex flex-col items-center">
                                  <input
                                    type="number"
                                    step="0.1"
                                    value={mixedInput[pmK]}
                                    onChange={(e) => setMixedInput((p) => ({ ...p, [pmK]: Number(e.target.value) }))}
                                    className="w-14 px-1 py-1 border border-navy-200 rounded text-center bg-white"
                                  />
                                  <span className="text-[9px] text-navy-500 mt-0.5">{true45} mm</span>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-[11px] text-navy-500">
                      {tr(
                        lang,
                        'معادلة هوكابا (Huckaba 1964): العرض الحقيقي = (عرض السن اللبني المرجعي على القالب M_true × عرض السن بالأشعة) ÷ عرض المرجع بالأشعة M_xray',
                        'Huckaba Formula (1964): True Width = (Cast Primary Ref M_true × X-ray Tooth) / X-ray Primary Ref M_xray',
                      )}
                    </p>
                  </div>

                  {/* Step 04: Arch Widths & Occlusal */}
                  <div className="p-4 space-y-2.5">
                    <span className="text-[11px] font-mono font-bold text-brand-blue">04 / ARCH WIDTHS & OCCLUSION</span>
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-xs">
                      {(
                        [
                          ['intercanineU', '3-3 U'],
                          ['intercanineL', '3-3 L'],
                          ['intermolarU', '6-6 U'],
                          ['intermolarL', '6-6 L'],
                          ['overjet', 'Overjet'],
                          ['overbite', 'Overbite'],
                        ] as const
                      ).map(([k, lbl]) => (
                        <label key={k} className="block">
                          <span className="block text-[10px] font-mono text-navy-500 mb-1">{lbl}</span>
                          <input
                            type="number"
                            step="0.5"
                            value={mixedInput[k]}
                            onChange={(e) => setMixedInput((p) => ({ ...p, [k]: Number(e.target.value) }))}
                            className="w-full px-1.5 py-1 border border-navy-200 rounded text-center font-mono tabular-nums bg-white"
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                </div>

                {/* RIGHT/END COLUMN: Live Empirical Mixed Dentition Matrix */}
                <div className="xl:col-span-6 bg-white border border-navy-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 bg-navy-50 border-b border-navy-200 flex items-center justify-between">
                    <div>
                      <span className="text-[11px] font-mono font-bold text-navy-500">MIXED DENTITION DIAGNOSTICS</span>
                      <h4 className="text-xs font-bold text-navy-900">
                        {tr(lang, 'نتائج التنبؤ بالمساحة عبر الأرباع الأربعة (8 تحاليل تشمل هوكابا ونانس والناب)', 'Cross-Method Quadrant Discrepancy Matrix (8 Analyses incl. Huckaba, Nance & Canine)')}
                      </h4>
                    </div>
                    <span className="text-[11px] font-mono text-navy-500">n = 8</span>
                  </div>

                  {/* Top 4 Telemetry Cells */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-navy-200 border-b border-navy-200">
                    <div className="p-3">
                      <span className="block text-[10px] font-mono text-navy-500">SPACE AVAIL (POST)</span>
                      <div className="mt-1 font-mono tabular-nums text-sm font-bold text-navy-900">
                        U: {mixedSuite.totalPostSpaceUpper} mm
                      </div>
                      <div className="font-mono tabular-nums text-sm font-bold text-navy-700">
                        L: {mixedSuite.totalPostSpaceLower} mm
                      </div>
                    </div>

                    <div className="p-3">
                      <span className="block text-[10px] font-mono text-navy-500">HUCKABA (1964)</span>
                      <div className="mt-1 font-mono tabular-nums text-sm font-bold text-navy-900">
                        U: {mixedSuite.huckabaTotalUpperDisc > 0 ? `+${mixedSuite.huckabaTotalUpperDisc}` : mixedSuite.huckabaTotalUpperDisc}
                      </div>
                      <div className={`font-mono tabular-nums text-sm font-bold ${mixedSuite.huckabaTotalLowerDisc < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                        L: {mixedSuite.huckabaTotalLowerDisc > 0 ? `+${mixedSuite.huckabaTotalLowerDisc}` : mixedSuite.huckabaTotalLowerDisc} mm
                      </div>
                    </div>

                    <div className="p-3">
                      <span className="block text-[10px] font-mono text-navy-500">MOYERS ({mixedInput.moyersConfidence}%)</span>
                      <div className="mt-1 font-mono tabular-nums text-sm font-bold text-navy-900">
                        U: {mixedSuite.moyersTotalUpperDisc > 0 ? `+${mixedSuite.moyersTotalUpperDisc}` : mixedSuite.moyersTotalUpperDisc}
                      </div>
                      <div className={`font-mono tabular-nums text-sm font-bold ${mixedSuite.moyersTotalLowerDisc < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                        L: {mixedSuite.moyersTotalLowerDisc > 0 ? `+${mixedSuite.moyersTotalLowerDisc}` : mixedSuite.moyersTotalLowerDisc} mm
                      </div>
                    </div>

                    <div className="p-3">
                      <span className="block text-[10px] font-mono text-navy-500">NANCE LEEWAY</span>
                      <div className="mt-1 flex items-baseline gap-1">
                        <span className="text-lg font-bold font-mono tabular-nums text-brand-blue">
                          {mixedSuite.totalLowerLeeway}
                        </span>
                        <span className="text-[11px] font-mono text-navy-400">mm (L)</span>
                      </div>
                      <span className="text-[11px] font-mono text-navy-500 block">U: {mixedSuite.totalUpperLeeway} mm</span>
                    </div>
                  </div>

                  {/* Quadrant Results Comparison Table */}
                  <div className="overflow-x-auto border-b border-navy-200">
                    <table className="w-full text-xs">
                      <thead className="bg-navy-900 text-white">
                        <tr>
                          <th className="py-2 px-3 text-start">{tr(lang, 'طريقة التنبؤ', 'Method & Predicted 3+4+5')}</th>
                          <th className="py-2 px-2 text-center">UR</th>
                          <th className="py-2 px-2 text-center">UL</th>
                          <th className="py-2 px-2 text-center">LR</th>
                          <th className="py-2 px-2 text-center">LL</th>
                          <th className="py-2 px-3 text-end">{tr(lang, 'الإجمالي U / L', 'Total U / L')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-navy-100 font-mono tabular-nums">
                        <tr>
                          <td className="py-2.5 px-3 font-sans">
                            <span className="font-bold text-navy-900 block">
                              01. Moyers ({mixedInput.moyersConfidence}% · {mixedInput.sex === 'male' ? tr(lang, 'ذكر', 'M') : tr(lang, 'أنثى', 'F')})
                            </span>
                            <span className="text-[10px] font-mono text-navy-500">
                              Pred 3+4+5: U {mixedSuite.moyersUpperQuad} / L {mixedSuite.moyersLowerQuad} mm
                            </span>
                          </td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.moyersDiscUR < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.moyersDiscUR}</td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.moyersDiscUL < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.moyersDiscUL}</td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.moyersDiscLR < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.moyersDiscLR}</td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.moyersDiscLL < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.moyersDiscLL}</td>
                          <td className="py-2 px-3 text-end font-bold text-navy-900">
                            {mixedSuite.moyersTotalUpperDisc} / {mixedSuite.moyersTotalLowerDisc}
                          </td>
                        </tr>

                        <tr>
                          <td className="py-2.5 px-3 font-sans">
                            <span className="font-bold text-navy-900 block">02. Tanaka &amp; Johnston</span>
                            <span className="text-[10px] font-mono text-navy-500">
                              Pred 3+4+5: U {mixedSuite.tjUpperQuad} / L {mixedSuite.tjLowerQuad} mm
                            </span>
                          </td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.tjDiscUR < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.tjDiscUR}</td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.tjDiscUL < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.tjDiscUL}</td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.tjDiscLR < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.tjDiscLR}</td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.tjDiscLL < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.tjDiscLL}</td>
                          <td className="py-2 px-3 text-end font-bold text-navy-900">
                            {mixedSuite.tjTotalUpperDisc} / {mixedSuite.tjTotalLowerDisc}
                          </td>
                        </tr>

                        <tr>
                          <td className="py-2.5 px-3 font-sans">
                            <span className="font-bold text-navy-900 block">03. Nance Radiographic (1947)</span>
                            <span className="text-[10px] font-mono text-navy-500">
                              Raw X-ray 3+4+5: {mixedSuite.nanceRadPredUR}/{mixedSuite.nanceRadPredUL} · {mixedSuite.nanceRadPredLR}/{mixedSuite.nanceRadPredLL}
                            </span>
                          </td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.nanceRadDiscUR < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.nanceRadDiscUR}</td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.nanceRadDiscUL < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.nanceRadDiscUL}</td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.nanceRadDiscLR < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.nanceRadDiscLR}</td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.nanceRadDiscLL < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.nanceRadDiscLL}</td>
                          <td className="py-2 px-3 text-end font-bold text-navy-900">
                            {mixedSuite.nanceRadTotalUpperDisc} / {mixedSuite.nanceRadTotalLowerDisc}
                          </td>
                        </tr>

                        <tr className="bg-amber-50/40">
                          <td className="py-2.5 px-3 font-sans">
                            <span className="font-bold text-navy-900 block">
                              04. Huckaba (1964) — {mixedInput.canineSource === 'predicted' ? tr(lang, 'ناب متنبأ', 'Pred 3') : tr(lang, 'ناب أشعة', 'X-ray 3')}
                            </span>
                            <span className="text-[10px] font-mono text-navy-500">
                              True 3+4+5: {mixedSuite.huckabaPredUR}/{mixedSuite.huckabaPredUL} · {mixedSuite.huckabaPredLR}/{mixedSuite.huckabaPredLL}
                            </span>
                          </td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.huckabaDiscUR < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.huckabaDiscUR}</td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.huckabaDiscUL < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.huckabaDiscUL}</td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.huckabaDiscLR < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.huckabaDiscLR}</td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.huckabaDiscLL < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.huckabaDiscLL}</td>
                          <td className="py-2 px-3 text-end font-bold text-navy-900">
                            {mixedSuite.huckabaTotalUpperDisc} / {mixedSuite.huckabaTotalLowerDisc}
                          </td>
                        </tr>

                        <tr>
                          <td className="py-2.5 px-3 font-sans">
                            <span className="font-bold text-navy-900 block">05. Hixon &amp; Oldfather (X-Ray)</span>
                            <span className="text-[10px] font-mono text-navy-500">
                              Chart (1958): L {mixedSuite.hixonPredLR} / {mixedSuite.hixonPredLL} mm
                            </span>
                          </td>
                          <td className="py-2 px-2 text-center text-navy-300">—</td>
                          <td className="py-2 px-2 text-center text-navy-300">—</td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.hixonDiscLR < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.hixonDiscLR}</td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.hixonDiscLL < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.hixonDiscLL}</td>
                          <td className="py-2 px-3 text-end font-bold text-navy-900">
                            L: {Number((mixedSuite.hixonDiscLR + mixedSuite.hixonDiscLL).toFixed(1))}
                          </td>
                        </tr>

                        <tr>
                          <td className="py-2.5 px-3 font-sans">
                            <span className="font-bold text-navy-900 block">06. Staley &amp; Kerber (X-Ray)</span>
                            <span className="text-[10px] font-mono text-navy-500">
                              Eq (1980): L {mixedSuite.staleyPredLR} / {mixedSuite.staleyPredLL} mm
                            </span>
                          </td>
                          <td className="py-2 px-2 text-center text-navy-300">—</td>
                          <td className="py-2 px-2 text-center text-navy-300">—</td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.staleyDiscLR < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.staleyDiscLR}</td>
                          <td className={`py-2 px-2 text-center font-bold ${mixedSuite.staleyDiscLL < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{mixedSuite.staleyDiscLL}</td>
                          <td className="py-2 px-3 text-end font-bold text-navy-900">
                            L: {Number((mixedSuite.staleyDiscLR + mixedSuite.staleyDiscLL).toFixed(1))}
                          </td>
                        </tr>

                        <tr className="bg-navy-50/60">
                          <td className="py-2.5 px-3 font-sans">
                            <span className="font-bold text-navy-900 block">07. Nance Leeway Space</span>
                            <span className="text-[10px] font-mono text-navy-500">Primary(c+d+e) − True(3+4+5)</span>
                          </td>
                          <td className="py-2 px-2 text-center font-bold text-brand-blue">{mixedSuite.leewayUR}</td>
                          <td className="py-2 px-2 text-center font-bold text-brand-blue">{mixedSuite.leewayUL}</td>
                          <td className="py-2 px-2 text-center font-bold text-brand-blue">{mixedSuite.leewayLR}</td>
                          <td className="py-2 px-2 text-center font-bold text-brand-blue">{mixedSuite.leewayLL}</td>
                          <td className="py-2 px-3 text-end font-bold text-navy-900">
                            {mixedSuite.totalUpperLeeway} / {mixedSuite.totalLowerLeeway}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  {/* 07. Unerupted Canine (3) Comparison & Incisor Liability */}
                  <div className="p-4 space-y-3 bg-navy-50/40 text-xs">
                    <div className="border border-navy-200 rounded-lg p-3 bg-white">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-bold text-navy-900">
                          {tr(lang, 'تقييم الناب غير البازغ (3) — الأشعة مقابل التنبؤ الحسابي', 'Unerupted Canine (3) — Radiographic Huckaba vs Predicted')}
                        </span>
                        <span className="text-[11px] font-mono text-navy-500">
                          Mag (M/M′): {mixedSuite.huckabaMagUR} · {mixedSuite.huckabaMagUL} · {mixedSuite.huckabaMagLR} · {mixedSuite.huckabaMagLL}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2 font-mono tabular-nums text-[11px]">
                        <div className="p-2 bg-navy-50 rounded border border-navy-100">
                          <span className="text-navy-500 block">UR #13</span>
                          <strong className="text-navy-900">{mixedSuite.huckabaTrueCanineUR} mm</strong>
                          <span className="block text-[10px] text-navy-400">Pred: {mixedSuite.predictedCanineU}</span>
                        </div>
                        <div className="p-2 bg-navy-50 rounded border border-navy-100">
                          <span className="text-navy-500 block">UL #23</span>
                          <strong className="text-navy-900">{mixedSuite.huckabaTrueCanineUL} mm</strong>
                          <span className="block text-[10px] text-navy-400">Pred: {mixedSuite.predictedCanineU}</span>
                        </div>
                        <div className="p-2 bg-navy-50 rounded border border-navy-100">
                          <span className="text-navy-500 block">LR #43</span>
                          <strong className="text-navy-900">{mixedSuite.huckabaTrueCanineLR} mm</strong>
                          <span className="block text-[10px] text-navy-400">Pred: {mixedSuite.predictedCanineL}</span>
                        </div>
                        <div className="p-2 bg-navy-50 rounded border border-navy-100">
                          <span className="text-navy-500 block">LL #33</span>
                          <strong className="text-navy-900">{mixedSuite.huckabaTrueCanineLL} mm</strong>
                          <span className="block text-[10px] text-navy-400">Pred: {mixedSuite.predictedCanineL}</span>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="border border-navy-200 rounded-lg p-3 bg-white">
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-navy-900">08. {tr(lang, 'عجز القواطع العلوي', 'Upper Incisor Liability')}</span>
                          <span className="font-mono font-bold text-navy-900">{mixedSuite.upperIncisorLiability} mm</span>
                        </div>
                        <p className="text-[11px] text-navy-500 mt-1">
                          {tr(lang, 'المتوسط القياسي ~ 7.6 مم (يعوّض بنمو بين الأنياب وبروز القواطع العلوية)', 'Textbook norm ~7.6 mm (compensated by intercanine growth & labial inclination)')}
                        </p>
                      </div>
                      <div className="border border-navy-200 rounded-lg p-3 bg-white">
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-navy-900">08. {tr(lang, 'عجز القواطع السفلي', 'Lower Incisor Liability')}</span>
                          <span className="font-mono font-bold text-navy-900">{mixedSuite.lowerIncisorLiability} mm</span>
                        </div>
                        <p className="text-[11px] text-navy-500 mt-1">
                          {tr(lang, 'المتوسط القياسي ~ 6.0 مم (يُستفاد من فضاء نانس الفائض السفلي للحفاظ على المسافة)', 'Textbook norm ~6.0 mm (preserved via lower E-space / lingual arch)')}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================= */}
          {/* PROTOCOL 03: MANUAL CEPHALOMETRIC WORKSHEET (16 METRICS / 5 DOMAINS)*/}
          {/* ================================================================= */}
          {manualLabView === 'ceph' && (() => {
            const filledCount = MANUAL_CEPH_FIELDS.filter((f) => {
              const v = manualCephValues[f.key];
              return v !== undefined && v.trim() !== '' && !Number.isNaN(Number(v));
            }).length;

            const anbVal = manualCephValues.ANB?.trim() ? Number(manualCephValues.ANB) : null;
            const fmaVal = manualCephValues.FMA?.trim() ? Number(manualCephValues.FMA) : null;
            const impaVal = manualCephValues.IMPA?.trim() ? Number(manualCephValues.IMPA) : null;

            return (
              <div className="space-y-4">
                {/* Protocol Action & Live Ceph Synthesis Header */}
                <div className="bg-white border border-navy-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
                  <div className="flex flex-wrap items-center gap-6 text-xs">
                    <div>
                      <span className="block text-[10px] font-mono text-navy-400">ENTERED METRICS</span>
                      <span className="font-mono font-bold text-sm text-navy-900 tabular-nums">{filledCount} / {MANUAL_CEPH_FIELDS.length}</span>
                    </div>
                    <div className="h-7 w-px bg-navy-200 hidden sm:block" />
                    <div>
                      <span className="block text-[10px] font-mono text-navy-400">SAGITTAL CLASS (ANB)</span>
                      <span className="font-bold text-navy-900">
                        {anbVal === null || Number.isNaN(anbVal)
                          ? '—'
                          : anbVal > 4
                          ? `Class II (${anbVal}°)`
                          : anbVal < 0
                          ? `Class III (${anbVal}°)`
                          : `Class I (${anbVal}°)`}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[10px] font-mono text-navy-400">VERTICAL (FMA)</span>
                      <span className="font-bold text-navy-900">
                        {fmaVal === null || Number.isNaN(fmaVal)
                          ? '—'
                          : fmaVal > 28
                          ? tr(lang, `عمودي (${fmaVal}°)`, `High Angle (${fmaVal}°)`)
                          : fmaVal < 22
                          ? tr(lang, `أفقي (${fmaVal}°)`, `Low Angle (${fmaVal}°)`)
                          : tr(lang, `متوازن (${fmaVal}°)`, `Normo (${fmaVal}°)`)}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[10px] font-mono text-navy-400">LOWER INCISOR (IMPA)</span>
                      <span className="font-bold text-navy-900">
                        {impaVal === null || Number.isNaN(impaVal)
                          ? '—'
                          : impaVal > 95
                          ? tr(lang, `متقدم (${impaVal}°)`, `Proclined (${impaVal}°)`)
                          : impaVal < 85
                          ? tr(lang, `منكفئ (${impaVal}°)`, `Retroclined (${impaVal}°)`)
                          : tr(lang, `طبيعي (${impaVal}°)`, `Normal (${impaVal}°)`)}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setManualCephValues({})}
                      className="px-3 py-2 border border-navy-200 text-navy-700 hover:bg-navy-50 text-xs font-semibold rounded-lg"
                    >
                      {tr(lang, 'تفريغ الحقول', 'Clear')}
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveManualCeph}
                      className="inline-flex items-center gap-1.5 px-4 py-2 bg-navy-900 hover:bg-navy-800 text-white text-xs font-semibold rounded-lg"
                    >
                      <Save className="w-3.5 h-3.5 text-brand-orange" />
                      <span>{tr(lang, 'حفظ قياسات السيفالومتري اليدوية', 'Save Manual Ceph')}</span>
                    </button>
                  </div>
                </div>

                {/* Categorized 5-Domain Cephalometric Tables */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                  {MANUAL_CEPH_DOMAIN_GROUPS.map((group) => {
                    const fields = MANUAL_CEPH_FIELDS.filter((f) => f.domain === group.id);
                    return (
                      <div
                        key={group.id}
                        className={`bg-white border border-navy-200 rounded-xl overflow-hidden ${
                          group.id === 'soft' ? 'lg:col-span-2' : ''
                        }`}
                      >
                        <div className="px-4 py-2.5 bg-navy-50 border-b border-navy-200 flex items-center justify-between">
                          <h4 className="text-xs font-bold text-navy-900">
                            {lang === 'ar' ? `${group.code}. ${group.ar}` : group.en}
                          </h4>
                          <span className="text-[10px] font-mono text-navy-400">{fields.length} metrics</span>
                        </div>
                        <table className="w-full text-xs">
                          <thead className="border-b border-navy-100 text-navy-500 text-[11px]">
                            <tr>
                              <th className="py-2 px-3 text-start font-medium">{tr(lang, 'القياس', 'Parameter')}</th>
                              <th className="py-2 px-2 text-center font-medium">{tr(lang, 'الطبيعي', 'Norm')}</th>
                              <th className="py-2 px-2 text-center font-medium">{tr(lang, 'القيمة', 'Value')}</th>
                              <th className="py-2 px-3 text-start font-medium hidden sm:table-cell">{tr(lang, 'الانحراف والتشخيص', 'Deviation & Interpretation')}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-navy-100">
                            {fields.map((f) => {
                              const raw = manualCephValues[f.key] ?? '';
                              const num = raw.trim() !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : null;
                              const isOut = num !== null && (num > f.maxNorm || num < f.minNorm);
                              const statusText =
                                num === null
                                  ? tr(lang, 'غير مدخل', 'Not entered')
                                  : num > f.maxNorm
                                  ? `▲ ${f.highInterp}`
                                  : num < f.minNorm
                                  ? `▼ ${f.lowInterp}`
                                  : `✓ ${tr(lang, 'ضمن الطبيعي', 'Normal')}`;

                              const span = Math.max(1, f.scaleMax - f.scaleMin);
                              const normLeftPct = Math.max(0, Math.min(100, ((f.minNorm - f.scaleMin) / span) * 100));
                              const normWidthPct = Math.max(4, Math.min(100 - normLeftPct, ((f.maxNorm - f.minNorm) / span) * 100));
                              const valPct = num !== null ? Math.max(2, Math.min(98, ((num - f.scaleMin) / span) * 100)) : null;

                              return (
                                <tr key={f.key} className="hover:bg-navy-50/40">
                                  <td className="py-2 px-3 font-medium text-navy-900">
                                    {lang === 'ar' ? f.labelAr : f.labelEn}
                                  </td>
                                  <td className="py-2 px-2 text-center font-mono tabular-nums text-[11px] text-navy-500 whitespace-nowrap">
                                    {f.normRange}
                                  </td>
                                  <td className="py-2 px-2 text-center">
                                    <div className="inline-flex items-center gap-1">
                                      <input
                                        type="number"
                                        step="0.5"
                                        value={raw}
                                        placeholder="—"
                                        onChange={(e) => {
                                          const val = e.target.value;
                                          setManualCephValues((prev) => {
                                            const next = { ...prev, [f.key]: val };
                                            if ((f.key === 'SNA' || f.key === 'SNB') && next.SNA && next.SNB) {
                                              const snaN = Number(next.SNA);
                                              const snbN = Number(next.SNB);
                                              if (!Number.isNaN(snaN) && !Number.isNaN(snbN)) {
                                                next.ANB = String(Number((snaN - snbN).toFixed(1)));
                                              }
                                            }
                                            return next;
                                          });
                                        }}
                                        className="w-16 px-1.5 py-1 border border-navy-300 rounded bg-white font-mono tabular-nums text-xs text-center font-semibold text-navy-900 focus:border-brand-blue focus:outline-none"
                                      />
                                      <span className="text-[10px] font-mono text-navy-400">
                                        {f.unit === 'deg' ? '°' : 'mm'}
                                      </span>
                                    </div>
                                  </td>
                                  <td className="py-2 px-3 hidden sm:table-cell">
                                    <div className="space-y-1">
                                      <div className="relative h-1.5 bg-navy-100 rounded-full overflow-hidden" dir="ltr">
                                        <div
                                          className="absolute top-0 bottom-0 bg-emerald-200"
                                          style={{ left: `${normLeftPct}%`, width: `${normWidthPct}%` }}
                                        />
                                        {valPct !== null && (
                                          <div
                                            className={`absolute top-0 bottom-0 w-1.5 rounded-full -translate-x-1/2 ${
                                              isOut ? 'bg-brand-orange' : 'bg-emerald-700'
                                            }`}
                                            style={{ left: `${valPct}%` }}
                                          />
                                        )}
                                      </div>
                                      <span
                                        className={`block text-[11px] font-medium ${
                                          num === null ? 'text-navy-400' : isOut ? 'text-amber-700' : 'text-emerald-700'
                                        }`}
                                      >
                                        {statusText}
                                      </span>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* 1. Cephalometric Tracing Studio */}
      {subMode === 'ceph' && (
        <CephTracingStudio
          patient={patient}
          stage={stage}
          lang={lang}
          role={role}
          actorName={actorName}
          onChange={onChange}
        />
      )}

      {/* 2. Clinical Photo Analysis Studio */}
      {subMode === 'photo' && (
        <PhotoAnalysisStudio
          patient={patient}
          stage={stage}
          lang={lang}
          role={role}
          actorName={actorName}
          onChange={onChange}
        />
      )}

      {/* 3. 3D Intraoral Scanner + Synced Bolton & Space Discrepancy */}
      {subMode === 'scanner' && (
        <div className="space-y-5">
          <Model3DViewer
            open={true}
            embedded={true}
            lang={lang}
            initialUrl={default3dMedia?.originalUrl}
            title={
              default3dMedia
                ? `${default3dMedia.title} — ${tr(lang, 'وحدة قياس الماسح الضوئي', '3D Scanner Measurement Studio')}`
                : undefined
            }
            onToothWidthMeasured={(fdi, widthMm) => {
              setToothWidths((prev) => ({ ...prev, [fdi]: widthMm }));
              setLastSyncedTooth({ fdi, mm: widthMm });
            }}
            onSaveSuite={handleSaveScannerSuite}
          />

          {/* Integrated Bolton & Space Discrepancy Workbench */}
          <div className="bg-white border border-navy-200 rounded-xl p-5 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-navy-900">
                  {tr(lang, 'تحليل بولتون والمسافة المرتبط بالماسح الضوئي (mm)', 'Scanner-Linked Bolton Ratio & Arch Space Discrepancy')}
                </h3>
                <p className="text-xs text-navy-500 mt-0.5">
                  {lastSyncedTooth
                    ? tr(
                        lang,
                        `تم ترحيل قياس السن #${lastSyncedTooth.fdi} من الماسح الضوئي تلقائياً (${lastSyncedTooth.mm} مم)`,
                        `Synced Tooth #${lastSyncedTooth.fdi} from 3D scanner (${lastSyncedTooth.mm} mm)`,
                      )
                    : tr(
                        lang,
                        'المرجع: Bolton (1958) — استخدم أداة "عرض سن لبولتون" في الماسح أعلاه أو أدخل القيم مباشرة بالمليمتر',
                        'Bolton (1958) — measure directly on the 3D scanner above or edit values manually',
                      )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleSaveBolton(false)}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-navy-900 hover:bg-navy-800 text-white text-xs font-semibold rounded-lg"
              >
                <Save className="w-4 h-4 text-brand-orange" />
                <span>{tr(lang, 'حفظ تحليل بولتون والمسافة', 'Save Bolton Analysis')}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 border border-navy-200 rounded-lg space-y-3 bg-navy-50/40">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-navy-900">
                    {tr(lang, 'الفك العلوي (16–26) بالملم', 'Upper Arch Widths (mm)')}
                  </span>
                  <label className="text-xs text-navy-600 flex items-center gap-1.5">
                    <span>{tr(lang, 'المساحة المتاحة (6M–6M):', 'Space Available (6M–6M):')}</span>
                    <input
                      type="number"
                      step="0.5"
                      value={spaceU}
                      onChange={(e) => setSpaceU(Number(e.target.value))}
                      className="w-20 px-2 py-1 border border-navy-300 rounded font-mono tabular-nums text-xs bg-white"
                    />
                  </label>
                </div>
                <div className="grid grid-cols-6 gap-2" dir="ltr">
                  {upperTeeth.map((fdi) => (
                    <div key={fdi} className="text-center">
                      <span className="block text-[11px] font-mono text-navy-500 mb-0.5">{fdi}</span>
                      <input
                        type="number"
                        step="0.1"
                        value={toothWidths[fdi] ?? ''}
                        onChange={(e) => setToothWidths({ ...toothWidths, [fdi]: Number(e.target.value) })}
                        className={`w-full px-1.5 py-1 text-xs text-center font-mono tabular-nums border rounded bg-white ${
                          lastSyncedTooth?.fdi === fdi ? 'border-brand-orange ring-1 ring-brand-orange' : 'border-navy-200'
                        }`}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-4 border border-navy-200 rounded-lg space-y-3 bg-navy-50/40">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-navy-900">
                    {tr(lang, 'الفك السفلي (46–36) بالملم', 'Lower Arch Widths (mm)')}
                  </span>
                  <label className="text-xs text-navy-600 flex items-center gap-1.5">
                    <span>{tr(lang, 'المساحة المتاحة (6M–6M):', 'Space Available (6M–6M):')}</span>
                    <input
                      type="number"
                      step="0.5"
                      value={spaceL}
                      onChange={(e) => setSpaceL(Number(e.target.value))}
                      className="w-20 px-2 py-1 border border-navy-300 rounded font-mono tabular-nums text-xs bg-white"
                    />
                  </label>
                </div>
                <div className="grid grid-cols-6 gap-2" dir="ltr">
                  {lowerTeeth.map((fdi) => (
                    <div key={fdi} className="text-center">
                      <span className="block text-[11px] font-mono text-navy-500 mb-0.5">{fdi}</span>
                      <input
                        type="number"
                        step="0.1"
                        value={toothWidths[fdi] ?? ''}
                        onChange={(e) => setToothWidths({ ...toothWidths, [fdi]: Number(e.target.value) })}
                        className={`w-full px-1.5 py-1 text-xs text-center font-mono tabular-nums border rounded bg-white ${
                          lastSyncedTooth?.fdi === fdi ? 'border-brand-orange ring-1 ring-brand-orange' : 'border-navy-200'
                        }`}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-1">
              <div className="p-3.5 bg-navy-50 border border-navy-200 rounded-lg">
                <p className="text-xs text-navy-500">{tr(lang, 'نسبة بولتون الأمامية', 'Bolton Anterior')}</p>
                <p className="text-xl font-bold font-mono tabular-nums text-navy-900 mt-1">{boltonStats.anteriorRatio ?? '—'}%</p>
                <p className="text-[11px] text-navy-500 mt-0.5">
                  {boltonStats.anteriorExcessArch === 'lower'
                    ? tr(lang, `زيادة سفلية ${boltonStats.anteriorExcess} مم`, `Mand +${boltonStats.anteriorExcess}mm`)
                    : tr(lang, `زيادة علوية ${boltonStats.anteriorExcess} مم`, `Max +${boltonStats.anteriorExcess}mm`)}
                </p>
              </div>
              <div className="p-3.5 bg-navy-50 border border-navy-200 rounded-lg">
                <p className="text-xs text-navy-500">{tr(lang, 'نسبة بولتون الكلية', 'Bolton Overall')}</p>
                <p className="text-xl font-bold font-mono tabular-nums text-navy-900 mt-1">{boltonStats.overallRatio ?? '—'}%</p>
                <p className="text-[11px] text-navy-500 mt-0.5">
                  {boltonStats.overallExcessArch === 'lower'
                    ? tr(lang, `زيادة سفلية ${boltonStats.overallExcess} مم`, `Mand +${boltonStats.overallExcess}mm`)
                    : tr(lang, `زيادة علوية ${boltonStats.overallExcess} مم`, `Max +${boltonStats.overallExcess}mm`)}
                </p>
              </div>
              <div className="p-3.5 bg-navy-50 border border-navy-200 rounded-lg">
                <p className="text-xs text-navy-500">{tr(lang, 'فرق المسافة العلوي (5–5)', 'Upper Discrepancy (5–5)')}</p>
                <p className={`text-xl font-bold font-mono tabular-nums mt-1 ${boltonStats.upperDiscrepancy < 0 ? 'text-accent-700' : 'text-emerald-700'}`}>
                  {boltonStats.upperDiscrepancy} mm
                </p>
                <p className="text-[11px] text-navy-500 mt-0.5 font-mono tabular-nums">Req (5–5): {boltonStats.u10} mm</p>
              </div>
              <div className="p-3.5 bg-navy-50 border border-navy-200 rounded-lg">
                <p className="text-xs text-navy-500">{tr(lang, 'فرق المسافة السفلي (5–5)', 'Lower Discrepancy (5–5)')}</p>
                <p className={`text-xl font-bold font-mono tabular-nums mt-1 ${boltonStats.lowerDiscrepancy < 0 ? 'text-accent-700' : 'text-emerald-700'}`}>
                  {boltonStats.lowerDiscrepancy} mm
                </p>
                <p className="text-[11px] text-navy-500 mt-0.5 font-mono tabular-nums">Req (5–5): {boltonStats.l10} mm</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. CBCT 3D Multi-Planar DICOM Suite */}
      {subMode === 'cbct' && (
        <CbctStudio
          patient={patient}
          stage={stage}
          lang={lang}
          role={role}
          actorName={actorName}
          initialUrl={defaultDicomMedia?.originalUrl}
          onChange={onChange}
        />
      )}

      {/* 5. Longitudinal Comparison & Saved History */}
      {subMode === 'compare' && (
        <div className="space-y-6">
          <div className="bg-white border border-navy-200 rounded-xl p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-bold text-navy-900">
              <Table className="w-4 h-4 text-brand-orange" />
              <span>{tr(lang, 'مقارنة التحليلات المحفوظة عبر مراحل العلاج', 'Longitudinal Analyses Comparison & Versions')}</span>
            </div>

            {patient.analyses.length === 0 ? (
              <p className="text-xs text-navy-500">{tr(lang, 'لا توجد تحليلات محفوظة بعد.', 'No saved analyses yet.')}</p>
            ) : (
              <div className="space-y-5">
                {cephHistory.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-navy-200 text-navy-500">
                          <th className="py-2 text-start">{tr(lang, 'القياس السيفالومتري', 'Ceph Metric')}</th>
                          {cephHistory.map((a) => (
                            <th key={a.id} className="py-2 text-end font-mono tabular-nums">
                              {a.stage} (v{a.version})
                            </th>
                          ))}
                          <th className="py-2 text-end">{tr(lang, 'المرجع', 'Norm')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-navy-100">
                        {cephHistory[0].metrics.map((m) => (
                          <tr key={m.key}>
                            <td className="py-2 font-medium text-navy-900">{lang === 'ar' ? m.labelAr : m.labelEn}</td>
                            {cephHistory.map((a) => {
                              const match = a.metrics.find((x) => x.key === m.key);
                              return (
                                <td key={a.id} className="py-2 text-end font-mono tabular-nums text-navy-900">
                                  {match?.value !== null && match?.value !== undefined ? `${match.value} ${m.unit}` : '—'}
                                </td>
                              );
                            })}
                            <td className="py-2 text-end font-mono tabular-nums text-navy-500">{m.normRange}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="pt-4 border-t border-navy-100 space-y-2.5">
                  <h4 className="text-xs font-bold text-navy-800">
                    {tr(lang, 'سجل جميع الدراسات والتحليلات المحفوظة (سيفالومتري / صور / 3D / CBCT)', 'All Saved Diagnostic Analyses')}
                  </h4>
                  {patient.analyses.map((a) => (
                    <div
                      key={a.id}
                      className="p-3.5 bg-navy-50/60 border border-navy-200 rounded-xl space-y-2 text-xs"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <span className="font-bold text-navy-900">{a.templateName}</span>
                          <span className="mx-2 text-navy-300">·</span>
                          <span className="font-mono tabular-nums text-navy-600">{a.stage} · v{a.version}</span>
                          <p className="text-[11px] text-navy-500 mt-0.5">
                            {a.examiner} · {a.createdAt.slice(0, 10)} · {a.calibrationSource}
                          </p>
                        </div>
                        <span className="font-mono text-[11px] text-navy-800 font-semibold">
                          {a.approvedBy ? `${tr(lang, 'معتمد:', 'Approved:')} ${a.approvedBy}` : tr(lang, 'مسودة', 'Draft')}
                        </span>
                      </div>

                      {a.metrics.length > 0 && (
                        <div className="flex flex-wrap gap-3 pt-1.5 border-t border-navy-100 text-[11px]">
                          {a.metrics
                            .filter((m) => m.value !== null)
                            .slice(0, 6)
                            .map((m) => (
                              <span key={m.key} className="text-navy-700 font-mono tabular-nums">
                                <span className="font-sans text-navy-500">{lang === 'ar' ? m.labelAr : m.labelEn}:</span>{' '}
                                <strong className="text-navy-900">
                                  {m.value} {m.unit}
                                </strong>
                              </span>
                            ))}
                        </div>
                      )}
                      {a.cbctFindings?.notes && (
                        <p className="text-[11px] text-navy-600">{a.cbctFindings.notes}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
