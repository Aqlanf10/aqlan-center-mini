import { AnalysisMetric, PatientCase } from '../types/ortho';
import { REQUIRED_T0_VIEWS } from '../i18n/translations';

export interface Point2D {
  x: number;
  y: number;
}

export type CephSystemId = 'all' | 'steiner' | 'tweed' | 'ricketts' | 'mcnamara' | 'jarabak';
export type PhotoModeId =
  | 'frontal'
  | 'profile'
  | 'smile'
  | 'intraoral_frontal'
  | 'intraoral_right'
  | 'intraoral_left'
  | 'intraoral_upper'
  | 'intraoral_lower';

export interface LandmarkDef {
  key: string;
  ar: string;
  en: string;
  group: 'cranial' | 'skeletal' | 'dental' | 'soft';
  hintAr: string;
  hintEn: string;
}

export const CEPH_LANDMARKS_CATALOG: LandmarkDef[] = [
  // Cranial Base
  { key: 'S', ar: 'S (السرج التركي)', en: 'S (Sella)', group: 'cranial', hintAr: 'مركز الحفرة النخامية Sella Turcica', hintEn: 'Center of sella turcica' },
  { key: 'N', ar: 'N (الأنفي العظمي)', en: 'N (Nasion)', group: 'cranial', hintAr: 'أعمق نقطة أمامية عند الدرز الجبهي الأنفي', hintEn: 'Most anterior point of frontonasal suture' },
  { key: 'Po', ar: 'Po (المسم السمعي)', en: 'Po (Porion)', group: 'cranial', hintAr: 'أعلى نقطة في الصماخ السمعي الظاهر', hintEn: 'Superior border of external auditory meatus' },
  { key: 'Or', ar: 'Or (الحجاج)', en: 'Or (Orbitale)', group: 'cranial', hintAr: 'أدنى نقطة في الحافة السفلية للحجاج', hintEn: 'Lowest point on inferior orbital rim' },
  { key: 'Ba', ar: 'Ba (البازيون)', en: 'Ba (Basion)', group: 'cranial', hintAr: 'أدنى نقطة أمامية في الثقبة العظمى', hintEn: 'Most inferior-posterior point of occipital base' },
  { key: 'Ar', ar: 'Ar (المفصلي)', en: 'Ar (Articulare)', group: 'cranial', hintAr: 'تقاطع قاعدة الجمجمة مع الحافة الخلفية للعنق اللقمي', hintEn: 'Intersection of cranial base and posterior ramus' },
  { key: 'Co', ar: 'Co (اللقمي)', en: 'Co (Condylion)', group: 'cranial', hintAr: 'أعلى وأخلف نقطة في رأس لقمة الفك السفلي', hintEn: 'Most superior-posterior point of condylar head' },

  // Maxilla & Mandible
  { key: 'ANS', ar: 'ANS (الشوكة الأنفية الأمامية)', en: 'ANS (Ant. Nasal Spine)', group: 'skeletal', hintAr: 'طرف الشوكة الأنفية الأمامية للفك العلوي', hintEn: 'Tip of anterior nasal spine' },
  { key: 'PNS', ar: 'PNS (الشوكة الأنفية الخلفية)', en: 'PNS (Post. Nasal Spine)', group: 'skeletal', hintAr: 'الطرف الخلفي للحنك الصلب', hintEn: 'Posterior tip of hard palate' },
  { key: 'A', ar: 'A (نقطة A)', en: 'A (Subspinale)', group: 'skeletal', hintAr: 'أعمق نقطة في تقعر الفك العلوي تحت ANS', hintEn: 'Deepest point on anterior maxillary concavity' },
  { key: 'B', ar: 'B (نقطة B)', en: 'B (Supramentale)', group: 'skeletal', hintAr: 'أعمق نقطة في تقعر الفك السفلي فوق الذقن', hintEn: 'Deepest point on anterior mandibular concavity' },
  { key: 'Pog', ar: 'Pog (البوغونيون)', en: 'Pog (Pogonion)', group: 'skeletal', hintAr: 'أبرز نقطة أمامية في الارتفاق الذقني العظمي', hintEn: 'Most anterior point on bony chin symphysis' },
  { key: 'Gn', ar: 'Gn (الغناثيون)', en: 'Gn (Gnathion)', group: 'skeletal', hintAr: 'أدنى وأمام نقطة في الذقن العظمي بين Pog و Me', hintEn: 'Most anterior-inferior point of bony chin' },
  { key: 'Me', ar: 'Me (الذقن السفلي)', en: 'Me (Menton)', group: 'skeletal', hintAr: 'أدنى نقطة في الارتفاق الذقني العظمي', hintEn: 'Lowest point on mandibular symphysis' },
  { key: 'Go', ar: 'Go (زاوية الفك)', en: 'Go (Gonion)', group: 'skeletal', hintAr: 'منصّف الزاوية بين الفرع الصاعد وجسم الفك', hintEn: 'Most posterior-inferior point of mandibular angle' },

  // Dentition
  { key: 'U1Tip', ar: 'U1 Tip (حد القاطع العلوي)', en: 'U1 Incisal Edge', group: 'dental', hintAr: 'الحافة القاطعة للثنية العلوية الأكثر بروزاً', hintEn: 'Incisal edge of most prominent upper central incisor' },
  { key: 'U1Apex', ar: 'U1 Apex (ذروة العلوي)', en: 'U1 Root Apex', group: 'dental', hintAr: 'ذروة جذر الثنية العلوية', hintEn: 'Root apex of upper central incisor' },
  { key: 'L1Tip', ar: 'L1 Tip (حد القاطع السفلي)', en: 'L1 Incisal Edge', group: 'dental', hintAr: 'الحافة القاطعة للثنية السفلية الأكثر بروزاً', hintEn: 'Incisal edge of most prominent lower central incisor' },
  { key: 'L1Apex', ar: 'L1 Apex (ذروة السفلي)', en: 'L1 Root Apex', group: 'dental', hintAr: 'ذروة جذر الثنية السفلية', hintEn: 'Root apex of lower central incisor' },
  { key: 'U6', ar: 'U6 (الضرس العلوي الأول)', en: 'U6 (Upper Molar Cusp)', group: 'dental', hintAr: 'حدبة الإطباق المتوسطة للضرس العلوي الأول', hintEn: 'Mesial occlusal cusp contact of upper first molar' },
  { key: 'L6', ar: 'L6 (الضرس السفلي الأول)', en: 'L6 (Lower Molar Cusp)', group: 'dental', hintAr: 'حدبة الإطباق المتوسطة للضرس السفلي الأول', hintEn: 'Mesial occlusal cusp contact of lower first molar' },

  // Soft Tissue
  { key: 'Pn', ar: 'Pn (ذروة الأنف)', en: 'Pn (Pronasale)', group: 'soft', hintAr: 'أبرز نقطة أمامية في أرنبة الأنف', hintEn: 'Most prominent anterior tip of the nose' },
  { key: 'Col', ar: 'Col (عميد الأنف)', en: 'Col (Columella)', group: 'soft', hintAr: 'النقطة السفلية لعميد الأنف لحساب الزاوية الأنفية الشفوية', hintEn: 'Inferior border of nasal columella' },
  { key: 'Sn', ar: 'Sn (تحت الأنف)', en: 'Sn (Subnasale)', group: 'soft', hintAr: 'التقاء قاعدة الأنف مع الشفة العليا', hintEn: 'Junction of nasal columella and upper lip' },
  { key: 'Ls', ar: 'Ls (الشفة العليا)', en: 'Ls (Labrale Superius)', group: 'soft', hintAr: 'أبرز نقطة أمامية في حافة الشفة العليا', hintEn: 'Most anterior point of upper lip vermilion' },
  { key: 'Li', ar: 'Li (الشفة السفلى)', en: 'Li (Labrale Inferius)', group: 'soft', hintAr: 'أبرز نقطة أمامية في حافة الشفة السفلى', hintEn: 'Most anterior point of lower lip vermilion' },
  { key: 'PogS', ar: "Pog' (ذقن رخوة)", en: "Pog' (Soft Pogonion)", group: 'soft', hintAr: 'أبرز نقطة أمامية في الأنسجة الرخوة للذقن', hintEn: 'Most anterior point on soft tissue chin' },
];

export const CEPH_NORM_BANDS: Record<string, { min: number; max: number; scaleMin: number; scaleMax: number }> = {
  SNA: { min: 80, max: 84, scaleMin: 70, scaleMax: 94 },
  SNB: { min: 78, max: 82, scaleMin: 68, scaleMax: 92 },
  ANB: { min: 0, max: 4, scaleMin: -6, scaleMax: 10 },
  WITS_MM: { min: -2, max: 2, scaleMin: -8, scaleMax: 10 },
  FMA: { min: 22, max: 28, scaleMin: 12, scaleMax: 42 },
  SN_GOGN: { min: 28, max: 36, scaleMin: 18, scaleMax: 48 },
  U1_SN: { min: 100, max: 108, scaleMin: 85, scaleMax: 125 },
  U1_NA_DEG: { min: 18, max: 26, scaleMin: 6, scaleMax: 40 },
  U1_NA_MM: { min: 2, max: 6, scaleMin: -2, scaleMax: 12 },
  IMPA: { min: 85, max: 95, scaleMin: 75, scaleMax: 112 },
  FMIA: { min: 62, max: 70, scaleMin: 45, scaleMax: 85 },
  L1_NB_DEG: { min: 21, max: 29, scaleMin: 10, scaleMax: 42 },
  L1_NB_MM: { min: 2, max: 6, scaleMin: -2, scaleMax: 12 },
  INTERINCISAL: { min: 125, max: 135, scaleMin: 105, scaleMax: 155 },
  JARABAK_SUM: { min: 390, max: 402, scaleMin: 375, scaleMax: 415 },
  GONIAL_ANGLE: { min: 120, max: 134, scaleMin: 105, scaleMax: 148 },
  NASOLABIAL: { min: 90, max: 110, scaleMin: 70, scaleMax: 135 },
  LS_ELINE: { min: -6, max: -2, scaleMin: -10, scaleMax: 6 },
  LI_ELINE: { min: -4, max: 0, scaleMin: -8, scaleMax: 8 },
};

/**
 * Computes signed angle (in degrees, 0..180) at vertex B formed by rays B->A and B->C
 */
export function angleThreePoints(a: Point2D, b: Point2D, c: Point2D): number {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const dot = v1x * v2x + v1y * v2y;
  const mag1 = Math.hypot(v1x, v1y);
  const mag2 = Math.hypot(v2x, v2y);
  if (mag1 === 0 || mag2 === 0) return 0;
  const cosTheta = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
  return Number(((Math.acos(cosTheta) * 180) / Math.PI).toFixed(1));
}

/**
 * Computes acute/obtuse angle between two directed lines (p1->p2) and (p3->p4)
 */
export function angleBetweenLines(p1: Point2D, p2: Point2D, p3: Point2D, p4: Point2D): number {
  const v1x = p2.x - p1.x;
  const v1y = p2.y - p1.y;
  const v2x = p4.x - p3.x;
  const v2y = p4.y - p3.y;
  const dot = v1x * v2x + v1y * v2y;
  const m1 = Math.hypot(v1x, v1y);
  const m2 = Math.hypot(v2x, v2y);
  if (m1 === 0 || m2 === 0) return 0;
  const cosTheta = Math.max(-1, Math.min(1, dot / (m1 * m2)));
  return Number(((Math.acos(cosTheta) * 180) / Math.PI).toFixed(1));
}

/**
 * Perpendicular signed distance from point P to line (A -> B) in mm (scaled by image dimensions)
 */
export function pointToLineDistanceMm(
  p: Point2D,
  lineA: Point2D,
  lineB: Point2D,
  imgWidthPx: number,
  imgHeightPx: number,
  pixelsPerMm: number | null,
): number | null {
  if (!pixelsPerMm || pixelsPerMm <= 0) return null;
  const px = p.x * imgWidthPx;
  const py = p.y * imgHeightPx;
  const ax = lineA.x * imgWidthPx;
  const ay = lineA.y * imgHeightPx;
  const bx = lineB.x * imgWidthPx;
  const by = lineB.y * imgHeightPx;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const distPx = ((px - ax) * dy - (py - ay) * dx) / len;
  return Number((distPx / pixelsPerMm).toFixed(1));
}

/**
 * Distance between two normalized landmarks in mm (requires valid calibration)
 */
export function distanceMm(
  p1: Point2D,
  p2: Point2D,
  imgWidthPx: number,
  imgHeightPx: number,
  pixelsPerMm: number | null,
): number | null {
  if (!pixelsPerMm || pixelsPerMm <= 0) return null;
  const dx = (p2.x - p1.x) * imgWidthPx;
  const dy = (p2.y - p1.y) * imgHeightPx;
  return Number((Math.hypot(dx, dy) / pixelsPerMm).toFixed(1));
}

/**
 * Computes Wits Appraisal (AO - BO along Functional Occlusal Plane) in mm.
 * Positive when AO is anterior to BO (Class II skeletal tendency).
 */
function computeWitsMm(
  A: Point2D,
  B: Point2D,
  opP1: Point2D,
  opP2: Point2D,
  N: Point2D,
  S: Point2D,
  pixelsPerMm: number | null,
): number | null {
  if (!pixelsPerMm || pixelsPerMm <= 0) return null;
  // Determine anterior direction from S -> N vector
  let dirX = opP2.x - opP1.x;
  let dirY = opP2.y - opP1.y;
  const len = Math.hypot(dirX, dirY);
  if (len === 0) return null;
  dirX /= len;
  dirY /= len;
  const snX = N.x - S.x;
  const snY = N.y - S.y;
  if (dirX * snX + dirY * snY < 0) {
    dirX = -dirX;
    dirY = -dirY;
  }
  const projA = (A.x - opP1.x) * dirX + (A.y - opP1.y) * dirY;
  const projB = (B.x - opP1.x) * dirX + (B.y - opP1.y) * dirY;
  return Number(((projA - projB) / pixelsPerMm).toFixed(1));
}

/**
 * Computes multi-system cephalometric metrics (Steiner, Tweed, Ricketts, McNamara, Jarabak)
 * preserving full backward-compatibility with existing 16-point landmark data.
 */
export function computeCephalometricMetrics(
  landmarks: Record<string, Point2D>,
  imgW = 1000,
  imgH = 1000,
  pixelsPerMm: number | null = null,
  system: CephSystemId = 'all',
): AnalysisMetric[] {
  const px = (key: string): Point2D | null => {
    const pt = landmarks[key];
    return pt ? { x: pt.x * imgW, y: pt.y * imgH } : null;
  };

  const S = px('S');
  const N = px('N');
  const Po = px('Po');
  const Or = px('Or');
  const Ba = px('Ba');
  const Ar = px('Ar');
  const Co = px('Co');
  const ANS = px('ANS');
  const PNS = px('PNS');
  const A = px('A');
  const B = px('B');
  const Pog = px('Pog');
  const Gn = px('Gn');
  const Me = px('Me');
  const Go = px('Go');
  const U1Tip = px('U1Tip');
  const U1Apex = px('U1Apex');
  const L1Tip = px('L1Tip');
  const L1Apex = px('L1Apex');
  const U6 = px('U6');
  const L6 = px('L6');
  const Pn = px('Pn');
  const Col = px('Col');
  const Sn = px('Sn');
  const Ls = px('Ls');
  const Li = px('Li');
  const PogS = px('PogS');

  const sna = S && N && A ? angleThreePoints(S, N, A) : null;
  const snb = S && N && B ? angleThreePoints(S, N, B) : null;
  const anb = sna !== null && snb !== null ? Number((sna - snb).toFixed(1)) : null;

  const occRear = U6 && L6 ? { x: (U6.x + L6.x) / 2, y: (U6.y + L6.y) / 2 } : U6 || L6;
  const occFront = U1Tip && L1Tip ? { x: (U1Tip.x + L1Tip.x) / 2, y: (U1Tip.y + L1Tip.y) / 2 } : U1Tip || L1Tip;
  const witsMm =
    A && B && S && N && occRear && occFront
      ? computeWitsMm(A, B, occRear, occFront, N, S, pixelsPerMm)
      : null;

  const fma = Po && Or && Go && Me ? angleBetweenLines(Po, Or, Go, Me) : null;
  const snGoGn = S && N && Go && (Gn || Me) ? angleBetweenLines(S, N, Go, (Gn || Me)!) : null;
  const impa =
    L1Tip && L1Apex && Go && Me
      ? Number((180 - angleBetweenLines(L1Apex, L1Tip, Go, Me)).toFixed(1))
      : null;
  const fmia = fma !== null && impa !== null ? Number((180 - fma - impa).toFixed(1)) : null;

  const u1Sn =
    U1Tip && U1Apex && S && N
      ? Number((180 - angleBetweenLines(S, N, U1Apex, U1Tip)).toFixed(1))
      : null;
  const u1NaDeg = U1Tip && U1Apex && N && A ? angleBetweenLines(N, A, U1Apex, U1Tip) : null;
  const u1NaMm =
    landmarks.U1Tip && landmarks.N && landmarks.A
      ? pointToLineDistanceMm(landmarks.U1Tip, landmarks.N, landmarks.A, imgW, imgH, pixelsPerMm)
      : null;

  const l1NbDeg = L1Tip && L1Apex && N && B ? angleBetweenLines(N, B, L1Apex, L1Tip) : null;
  const l1NbMm =
    landmarks.L1Tip && landmarks.N && landmarks.B
      ? pointToLineDistanceMm(landmarks.L1Tip, landmarks.N, landmarks.B, imgW, imgH, pixelsPerMm)
      : null;

  const interincisal =
    U1Tip && U1Apex && L1Tip && L1Apex
      ? angleBetweenLines(U1Tip, U1Apex, L1Tip, L1Apex)
      : null;

  const saddleAngle = N && S && Ar ? angleThreePoints(N, S, Ar) : null;
  const articularAngle = S && Ar && Go ? angleThreePoints(S, Ar, Go) : null;
  const gonialAngle = Ar && Go && Me ? angleThreePoints(Ar, Go, Me) : null;
  const jarabakSum =
    saddleAngle !== null && articularAngle !== null && gonialAngle !== null
      ? Number((saddleAngle + articularAngle + gonialAngle).toFixed(1))
      : null;

  const coA =
    landmarks.Co && landmarks.A ? distanceMm(landmarks.Co, landmarks.A, imgW, imgH, pixelsPerMm) : null;
  const coGn =
    landmarks.Co && (landmarks.Gn || landmarks.Me)
      ? distanceMm(landmarks.Co, (landmarks.Gn || landmarks.Me)!, imgW, imgH, pixelsPerMm)
      : null;
  const lafh =
    landmarks.ANS && landmarks.Me ? distanceMm(landmarks.ANS, landmarks.Me, imgW, imgH, pixelsPerMm) : null;

  const facialAxis =
    Ba && N && S && (Gn || Pog || Me)
      ? Number((angleBetweenLines(Ba, N, S, (Gn || Pog || Me)!)).toFixed(1))
      : null;

  const nasolabial = Col && Sn && Ls ? angleThreePoints(Col, Sn, Ls) : null;

  const lowerLipELine =
    Li && Pn && PogS && landmarks['Li'] && landmarks['Pn'] && landmarks['PogS']
      ? pointToLineDistanceMm(landmarks['Li'], landmarks['Pn'], landmarks['PogS'], imgW, imgH, pixelsPerMm)
      : null;

  const upperLipELine =
    Ls && Pn && PogS && landmarks['Ls'] && landmarks['Pn'] && landmarks['PogS']
      ? pointToLineDistanceMm(landmarks['Ls'], landmarks['Pn'], landmarks['PogS'], imgW, imgH, pixelsPerMm)
      : null;

  const allMetrics: Array<AnalysisMetric & { systems: CephSystemId[] }> = [
    {
      key: 'SNA',
      systems: ['all', 'steiner'],
      labelAr: 'زاوية SNA (وضع الفك العلوي)',
      labelEn: 'SNA Angle (Maxillary Position)',
      value: sna,
      unit: 'deg',
      normRange: '82° ± 2°',
      formulaDesc: 'الزاوية بين خط قاعدة الجمجمة S-N وخط N-A',
      interpretation:
        sna === null ? 'ناقص معالم (S, N, A)' : sna > 84 ? 'تقدم فك علوي' : sna < 80 ? 'تراجع فك علوي' : 'ضمن المعدل الطبيعي',
      requiresCalibration: false,
    },
    {
      key: 'SNB',
      systems: ['all', 'steiner'],
      labelAr: 'زاوية SNB (وضع الفك السفلي)',
      labelEn: 'SNB Angle (Mandibular Position)',
      value: snb,
      unit: 'deg',
      normRange: '80° ± 2°',
      formulaDesc: 'الزاوية بين خط قاعدة الجمجمة S-N وخط N-B',
      interpretation:
        snb === null ? 'ناقص معالم (S, N, B)' : snb > 82 ? 'تقدم فك سفلي' : snb < 78 ? 'تراجع فك سفلي' : 'ضمن المعدل الطبيعي',
      requiresCalibration: false,
    },
    {
      key: 'ANB',
      systems: ['all', 'steiner'],
      labelAr: 'زاوية ANB (العلاقة الهيكلية)',
      labelEn: 'ANB Angle (Skeletal Class)',
      value: anb,
      unit: 'deg',
      normRange: '2° ± 2°',
      formulaDesc: 'الفرق الحسابي SNA − SNB لتحديد الصنف الهيكلي السهمي',
      interpretation:
        anb === null ? 'ناقص معالم' : anb > 4 ? 'صنف هيكلي ثانٍ (Class II)' : anb < 0 ? 'صنف هيكلي ثالث (Class III)' : 'صنف هيكلي أول (Class I)',
      requiresCalibration: false,
    },
    {
      key: 'WITS_MM',
      systems: ['all', 'steiner', 'ricketts'],
      labelAr: 'تقييم ويتس (Wits Appraisal AO-BO)',
      labelEn: 'Wits Appraisal (AO-BO)',
      value: witsMm,
      unit: 'mm',
      normRange: '0 ± 2 mm',
      formulaDesc: 'إسقاط النقطتين A و B عمودياً على مستوى الإطباق الوظيفي',
      interpretation:
        witsMm === null
          ? 'يتطلب U6/L6 ومعايرة'
          : witsMm > 2
          ? 'تقدم نسبي علوي (Class II)'
          : witsMm < -2
          ? 'تقدم نسبي سفلي (Class III)'
          : 'علاقة إطباقية متوازنة',
      requiresCalibration: true,
    },
    {
      key: 'FMA',
      systems: ['all', 'tweed', 'ricketts'],
      labelAr: 'زاوية FMA (المستوى الفكي السفلي)',
      labelEn: 'FMA (Frankfort Mandibular Plane)',
      value: fma,
      unit: 'deg',
      normRange: '25° ± 3°',
      formulaDesc: 'الزاوية بين مستوى فرانكفورت Po-Or والمستوى الفكي Go-Me',
      interpretation:
        fma === null ? 'ناقص معالم' : fma > 28 ? 'نمو عمودي زائد (Hyperdivergent)' : fma < 22 ? 'نمو أفقي (Hypodivergent)' : 'نمط عمودي متوازن',
      requiresCalibration: false,
    },
    {
      key: 'SN_GOGN',
      systems: ['all', 'steiner', 'jarabak'],
      labelAr: 'زاوية SN-GoGn (ميلان الفك لقاعدة الجمجمة)',
      labelEn: 'SN to Go-Gn Angle',
      value: snGoGn,
      unit: 'deg',
      normRange: '32° ± 4°',
      formulaDesc: 'الزاوية بين خط S-N ومستوى الفك السفلي Go-Gn/Me',
      interpretation:
        snGoGn === null ? 'ناقص معالم' : snGoGn > 36 ? 'زاوية عالية (High Angle)' : snGoGn < 28 ? 'زاوية منخفضة (Low Angle)' : 'متوازن',
      requiresCalibration: false,
    },
    {
      key: 'U1_SN',
      systems: ['all', 'steiner'],
      labelAr: 'ميل القواطع العلوية U1-SN',
      labelEn: 'U1 to SN Inclination',
      value: u1Sn,
      unit: 'deg',
      normRange: '104° ± 4°',
      formulaDesc: 'الزاوية الخلفية السفلية لمحور القاطع العلوي مع خط S-N',
      interpretation:
        u1Sn === null ? 'ناقص معالم' : u1Sn > 108 ? 'بروز/ميلان أمامي للعلوي' : u1Sn < 100 ? 'انكفاء للعلوي' : 'ميلان طبيعي',
      requiresCalibration: false,
    },
    {
      key: 'U1_NA_DEG',
      systems: ['all', 'steiner'],
      labelAr: 'زاوية U1-NA (ميل القاطع العلوي)',
      labelEn: 'U1 to NA (deg)',
      value: u1NaDeg,
      unit: 'deg',
      normRange: '22° ± 4°',
      formulaDesc: 'الزاوية بين محور الثنية العلوية وخط N-A',
      interpretation:
        u1NaDeg === null ? 'ناقص معالم' : u1NaDeg > 26 ? 'بروز محوري علوي' : u1NaDeg < 18 ? 'تراجع محوري علوي' : 'ميل طبيعي',
      requiresCalibration: false,
    },
    {
      key: 'U1_NA_MM',
      systems: ['all', 'steiner'],
      labelAr: 'بروز U1-NA (مم)',
      labelEn: 'U1 to NA (mm)',
      value: u1NaMm !== null ? Math.abs(u1NaMm) : null,
      unit: 'mm',
      normRange: '4 mm ± 2',
      formulaDesc: 'المسافة الخطية من الحافة القاطعة العلوية إلى خط N-A',
      interpretation:
        u1NaMm === null ? 'يتطلب معايرة' : Math.abs(u1NaMm) > 6 ? 'تقدم بدني للقاطع العلوي' : Math.abs(u1NaMm) < 2 ? 'تراجع بدني' : 'موضع طبيعي',
      requiresCalibration: true,
    },
    {
      key: 'IMPA',
      systems: ['all', 'tweed'],
      labelAr: 'ميل القواطع السفلية IMPA',
      labelEn: 'IMPA (Lower Incisor to Mandibular Plane)',
      value: impa,
      unit: 'deg',
      normRange: '90° ± 5°',
      formulaDesc: 'مثلث تويد: زاوية القاطع السفلي مع المستوى الفكي Go-Me',
      interpretation:
        impa === null ? 'ناقص معالم' : impa > 95 ? 'تقدم/ميلان أمامي للسفلي' : impa < 85 ? 'انكفاء للسفلي' : 'ميلان طبيعي',
      requiresCalibration: false,
    },
    {
      key: 'FMIA',
      systems: ['all', 'tweed'],
      labelAr: 'زاوية FMIA (مثلث تويد)',
      labelEn: 'FMIA (Frankfort Mandibular Incisor)',
      value: fmia,
      unit: 'deg',
      normRange: '65° ± 4°',
      formulaDesc: 'تكميلي لمثلث تويد (180 − FMA − IMPA)',
      interpretation:
        fmia === null ? 'ناقص معالم' : fmia < 60 ? 'بروز قاطعي سفلي' : fmia > 70 ? 'تراجع قاطعي سفلي' : 'توازن مثالي (Tweed)',
      requiresCalibration: false,
    },
    {
      key: 'L1_NB_DEG',
      systems: ['all', 'steiner'],
      labelAr: 'زاوية L1-NB (ميل القاطع السفلي)',
      labelEn: 'L1 to NB (deg)',
      value: l1NbDeg,
      unit: 'deg',
      normRange: '25° ± 4°',
      formulaDesc: 'الزاوية بين محور الثنية السفلية وخط N-B',
      interpretation:
        l1NbDeg === null ? 'ناقص معالم' : l1NbDeg > 29 ? 'بروز سفلي' : l1NbDeg < 21 ? 'انكفاء سفلي' : 'ميل طبيعي',
      requiresCalibration: false,
    },
    {
      key: 'L1_NB_MM',
      systems: ['all', 'steiner'],
      labelAr: 'بروز L1-NB (مم)',
      labelEn: 'L1 to NB (mm)',
      value: l1NbMm !== null ? Math.abs(l1NbMm) : null,
      unit: 'mm',
      normRange: '4 mm ± 2',
      formulaDesc: 'المسافة الخطية من الحافة القاطعة السفلية إلى خط N-B',
      interpretation:
        l1NbMm === null ? 'يتطلب معايرة' : Math.abs(l1NbMm) > 6 ? 'تقدم أمامي للقواطع السفلية' : 'ضمن النطاق الطبيعي',
      requiresCalibration: true,
    },
    {
      key: 'INTERINCISAL',
      systems: ['all', 'steiner', 'ricketts'],
      labelAr: 'الزاوية بين القواطع (Interincisal)',
      labelEn: 'Interincisal Angle',
      value: interincisal,
      unit: 'deg',
      normRange: '130° ± 5°',
      formulaDesc: 'الزاوية بين المحور الطولي للقاطع العلوي والسفلي',
      interpretation:
        interincisal === null ? 'ناقص معالم' : interincisal < 125 ? 'بروز ثنائي القواطع' : interincisal > 136 ? 'انكفاء القواطع (عضة عميقة محتملة)' : 'زاوية متوازنة',
      requiresCalibration: false,
    },
    {
      key: 'CO_A',
      systems: ['all', 'mcnamara'],
      labelAr: 'الطول الفعال للفك العلوي Co-A',
      labelEn: 'Effective Maxillary Length (Co-A)',
      value: coA,
      unit: 'mm',
      normRange: '85–95 mm',
      formulaDesc: 'تحليل ماكنمارا: المسافة من اللقمة Co إلى نقطة A',
      interpretation: coA === null ? 'يتطلب Co و A ومعايرة' : coA < 83 ? 'قصور علوي هيكلي' : coA > 98 ? 'زيادة طول علوي' : 'طول علوي متناسب',
      requiresCalibration: true,
    },
    {
      key: 'CO_GN',
      systems: ['all', 'mcnamara'],
      labelAr: 'الطول الفعال للفك السفلي Co-Gn',
      labelEn: 'Effective Mandibular Length (Co-Gn)',
      value: coGn,
      unit: 'mm',
      normRange: '110–126 mm',
      formulaDesc: 'تحليل ماكنمارا: المسافة من اللقمة Co إلى الذقن Gn',
      interpretation: coGn === null ? 'يتطلب Co و Gn ومعايرة' : coGn < 108 ? 'صغر فك سفلي' : coGn > 130 ? 'ضخامة فك سفلي' : 'طول سفلي متناسب',
      requiresCalibration: true,
    },
    {
      key: 'LAFH',
      systems: ['all', 'mcnamara'],
      labelAr: 'ارتفاع الوجه الأمامي السفلي ANS-Me',
      labelEn: 'Lower Anterior Facial Height (ANS-Me)',
      value: lafh,
      unit: 'mm',
      normRange: '62–70 mm',
      formulaDesc: 'المسافة بين الشوكة الأنفية الأمامية ANS والذقن Me',
      interpretation: lafh === null ? 'يتطلب ANS و Me ومعايرة' : lafh > 72 ? 'زيادة ارتفاع الثلث السفلي' : lafh < 60 ? 'نقص ارتفاع الثلث السفلي' : 'ارتفاع سفلي متوازن',
      requiresCalibration: true,
    },
    {
      key: 'SADDLE_ANGLE',
      systems: ['all', 'jarabak'],
      labelAr: 'زاوية السرج التركي (N-S-Ar)',
      labelEn: 'Saddle Angle (N-S-Ar)',
      value: saddleAngle,
      unit: 'deg',
      normRange: '123° ± 5°',
      formulaDesc: 'تحليل جاراباك: علاقة المفصل بقاعدة الجمجمة الخلفية',
      interpretation: saddleAngle === null ? 'يتطلب Ba/Ar' : saddleAngle > 128 ? 'توضع خلفي للمفصل (نمو خلفي)' : 'ضمن المعدل',
      requiresCalibration: false,
    },
    {
      key: 'ARTICULAR_ANGLE',
      systems: ['all', 'jarabak'],
      labelAr: 'الزاوية المفصلية (S-Ar-Go)',
      labelEn: 'Articular Angle (S-Ar-Go)',
      value: articularAngle,
      unit: 'deg',
      normRange: '143° ± 6°',
      formulaDesc: 'تحليل جاراباك: زاوية ميل الفرع الصاعد بالنسبة لقاعدة الجمجمة',
      interpretation: articularAngle === null ? 'يتطلب Ar' : articularAngle > 149 ? 'ميل خلفي للفك' : 'ميل متوازن',
      requiresCalibration: false,
    },
    {
      key: 'GONIAL_ANGLE',
      systems: ['all', 'jarabak'],
      labelAr: 'زاوية الفك السفلي (Ar-Go-Me)',
      labelEn: 'Gonial Angle (Ar-Go-Me)',
      value: gonialAngle,
      unit: 'deg',
      normRange: '128° ± 6°',
      formulaDesc: 'تحليل جاراباك: الزاوية بين الفرع الصاعد وجسم الفك السفلي',
      interpretation: gonialAngle === null ? 'يتطلب Ar, Go, Me' : gonialAngle > 134 ? 'منفرجة (اتجاه عمودي)' : gonialAngle < 120 ? 'حادة (عضة عميقة)' : 'طبيعية',
      requiresCalibration: false,
    },
    {
      key: 'JARABAK_SUM',
      systems: ['all', 'jarabak'],
      labelAr: 'مجموع زوايا جاراباك (Sum of Björk)',
      labelEn: 'Jarabak / Björk Sum',
      value: jarabakSum,
      unit: 'deg',
      normRange: '396° ± 6°',
      formulaDesc: 'مجموع (N-S-Ar + S-Ar-Go + Ar-Go-Me) للتنبؤ باتجاه النمو',
      interpretation:
        jarabakSum === null
          ? 'يتطلب N, S, Ar, Go, Me'
          : jarabakSum > 402
          ? 'نمو عمودي مع عقارب الساعة (CW)'
          : jarabakSum < 390
          ? 'نمو أفقي عكس عقارب الساعة (CCW)'
          : 'نمو متوازن',
      requiresCalibration: false,
    },
    {
      key: 'FACIAL_AXIS',
      systems: ['all', 'ricketts'],
      labelAr: 'محور الوجه Ricketts (Ba-N / S-Gn)',
      labelEn: 'Ricketts Facial Axis',
      value: facialAxis,
      unit: 'deg',
      normRange: '90° ± 3°',
      formulaDesc: 'زاوية محور النمو الوجهي نسبة لخط Ba-N',
      interpretation: facialAxis === null ? 'يتطلب Ba و Gn' : facialAxis < 86 ? 'دوران سفلي خلفي' : 'اتجاه نمو متوازن',
      requiresCalibration: false,
    },
    {
      key: 'NASOLABIAL',
      systems: ['all', 'ricketts'],
      labelAr: 'الزاوية الأنفية الشفوية (Nasolabial)',
      labelEn: 'Nasolabial Angle (Col-Sn-Ls)',
      value: nasolabial,
      unit: 'deg',
      normRange: '95° – 110°',
      formulaDesc: 'الزاوية بين عميد الأنف Col وتحت الأنف Sn والشفة العليا Ls',
      interpretation: nasolabial === null ? 'يتطلب Col, Sn, Ls' : nasolabial < 90 ? 'حادة (بروز شفوي علوي)' : nasolabial > 112 ? 'منفرجة (تراجع شفوي)' : 'متناسقة',
      requiresCalibration: false,
    },
    {
      key: 'LS_ELINE',
      systems: ['all', 'ricketts'],
      labelAr: 'الشفة العليا لخط Ricketts E',
      labelEn: 'Upper Lip to E-Line',
      value: upperLipELine,
      unit: 'mm',
      normRange: '-4 mm ± 2',
      formulaDesc: 'المسافة العمودية من Ls إلى خط Pn-Pog′ (تتطلب معايرة المقياس)',
      interpretation:
        upperLipELine === null ? 'يتطلب معايرة مقياس الصورة' : upperLipELine > -1 ? 'بروز الشفة العليا' : 'ضمن الحدود الجمالية',
      requiresCalibration: true,
    },
    {
      key: 'LI_ELINE',
      systems: ['all', 'ricketts'],
      labelAr: 'الشفة السفلى لخط Ricketts E',
      labelEn: 'Lower Lip to E-Line',
      value: lowerLipELine,
      unit: 'mm',
      normRange: '-2 mm ± 2',
      formulaDesc: 'المسافة العمودية من Li إلى خط Pn-Pog′ (تتطلب معايرة المقياس)',
      interpretation:
        lowerLipELine === null ? 'يتطلب معايرة مقياس الصورة' : lowerLipELine > 1 ? 'بروز الشفة السفلى' : 'ضمن الحدود الجمالية',
      requiresCalibration: true,
    },
  ];

  if (system === 'all') {
    return allMetrics.map(({ systems: _s, ...m }) => m);
  }
  return allMetrics.filter((m) => m.systems.includes(system)).map(({ systems: _s, ...m }) => m);
}

/**
 * Clinical Photo Analysis Catalog & Metrics Calculator
 */
export interface PhotoLandmarkDef {
  key: string;
  ar: string;
  en: string;
  hintAr: string;
}

export const PHOTO_LANDMARKS_CATALOG: Record<PhotoModeId, PhotoLandmarkDef[]> = {
  frontal: [
    { key: 'Tr', ar: 'Tr (منبت الشعر)', en: 'Tr (Trichion)', hintAr: 'حافة الجبهة العليا' },
    { key: 'G', ar: 'G (المقطب Glabella)', en: 'G (Glabella)', hintAr: 'منتصف ما بين الحاجبين' },
    { key: 'Sn', ar: 'Sn (تحت الأنف)', en: 'Sn (Subnasale)', hintAr: 'قاعدة الأنف' },
    { key: 'MeS', ar: "Me' (أسفل الذقن)", en: "Me' (Soft Menton)", hintAr: 'أدنى نقطة في الذقن' },
    { key: 'PuR', ar: 'PuR (حدقة اليمين)', en: 'Right Pupil', hintAr: 'مركز حدقة العين اليمنى' },
    { key: 'PuL', ar: 'PuL (حدقة اليسار)', en: 'Left Pupil', hintAr: 'مركز حدقة العين اليسرى' },
    { key: 'AlR', ar: 'AlR (جناح الأنف يمين)', en: 'Right Alare', hintAr: 'الحافة الخارجية اليمنى للأنف' },
    { key: 'AlL', ar: 'AlL (جناح الأنف يسار)', en: 'Left Alare', hintAr: 'الحافة الخارجية اليسرى للأنف' },
    { key: 'ChR', ar: 'ChR (زاوية الفم يمين)', en: 'Right Cheilion', hintAr: 'الزاوية اليمنى للشفتين' },
    { key: 'ChL', ar: 'ChL (زاوية الفم يسار)', en: 'Left Cheilion', hintAr: 'الزاوية اليسرى للشفتين' },
    { key: 'MidDental', ar: 'خط المنتصف السني', en: 'Upper Dental Midline', hintAr: 'خط التماس بين الثنيتين 11-21' },
  ],
  profile: [
    { key: 'G', ar: 'G (المقطب)', en: 'G (Glabella)', hintAr: 'أبرز نقطة جبهية بين الحاجبين' },
    { key: 'Pn', ar: 'Pn (ذروة الأنف)', en: 'Pn (Pronasale)', hintAr: 'طرف الأنف الأمامي' },
    { key: 'Col', ar: 'Col (عميد الأنف)', en: 'Col (Columella)', hintAr: 'الحافة السفلية لعميد الأنف' },
    { key: 'Sn', ar: 'Sn (تحت الأنف)', en: 'Sn (Subnasale)', hintAr: 'زاوية التقاء الأنف بالشفة' },
    { key: 'Ls', ar: 'Ls (الشفة العليا)', en: 'Ls (Upper Lip)', hintAr: 'أبرز نقطة بالشفة العليا' },
    { key: 'Li', ar: 'Li (الشفة السفلى)', en: 'Li (Lower Lip)', hintAr: 'أبرز نقطة بالشفة السفلى' },
    { key: 'BS', ar: "B' (ثنية الذقن)", en: "B' (Mentolabial Sulcus)", hintAr: 'أعمق نقطة بين الشفة السفلى والذقن' },
    { key: 'PogS', ar: "Pog' (ذقن رخوة)", en: "Pog' (Soft Pogonion)", hintAr: 'أبرز نقطة أمامية في الذقن' },
  ],
  smile: [
    { key: 'ChR', ar: 'ChR (زاوية الابتسامة يمين)', en: 'Right Smile Commissure', hintAr: 'أقصى زاوية فم يمين أثناء الابتسام' },
    { key: 'ChL', ar: 'ChL (زاوية الابتسامة يسار)', en: 'Left Smile Commissure', hintAr: 'أقصى زاوية فم يسار أثناء الابتسام' },
    { key: 'DentR', ar: 'DentR (آخر سن ظاهر يمين)', en: 'Right Buccal Tooth Edge', hintAr: 'الحافة الدهليزية لأبعد ضاحك/ضرس ظاهر يميناً' },
    { key: 'DentL', ar: 'DentL (آخر سن ظاهر يسار)', en: 'Left Buccal Tooth Edge', hintAr: 'الحافة الدهليزية لأبعد ضاحك/ضرس ظاهر يساراً' },
    { key: 'LipUpper', ar: 'الحافة السفلية للشفة العليا', en: 'Upper Lip Lower Border', hintAr: 'حد الشفة العليا فوق الثنية 11' },
    { key: 'Ging11', ar: 'السمت اللثوي 11', en: 'Gingival Zenith #11', hintAr: 'الحافة اللثوية للثنية 11' },
    { key: 'U1Edge', ar: 'الحافة القاطعة 11', en: 'Incisal Edge #11', hintAr: 'الحافة القاطعة للثنية العلوية 11' },
    { key: 'CanineL', ar: 'ذروة الناب 23', en: 'Canine Tip #23', hintAr: 'ذروة حدبة الناب العلوي لقوس الابتسامة' },
    { key: 'LipLower', ar: 'الشفة السفلى أسفل 11', en: 'Lower Lip Border', hintAr: 'الحافة العليا للشفة السفلى' },
    { key: 'FaceMid', ar: 'المنتصف الوجهي', en: 'Philtrum / Facial Midline', hintAr: 'منتصف النثرة الوجهية' },
    { key: 'DentMid', ar: 'المنتصف السني 11-21', en: 'Dental Midline 11-21', hintAr: 'خط التماس بين 11 و 21' },
  ],
  intraoral_frontal: [
    { key: 'UMid', ar: 'UMid (الخط المتوسط العلوي)', en: 'Upper Midline (11-21)', hintAr: 'نقطة التماس بين الثنيتين العلويتين 11-21' },
    { key: 'LMid', ar: 'LMid (الخط المتوسط السفلي)', en: 'Lower Midline (41-31)', hintAr: 'نقطة التماس بين الثنيتين السفليتين 41-31' },
    { key: 'UCanR', ar: 'UCanR (ذروة الناب #13)', en: 'Upper Right Canine #13', hintAr: 'ذروة الناب العلوي الأيمن لقياس ميلان مستوى الإطباق' },
    { key: 'UCanL', ar: 'UCanL (ذروة الناب #23)', en: 'Upper Left Canine #23', hintAr: 'ذروة الناب العلوي الأيسر لقياس ميلان مستوى الإطباق' },
    { key: 'Zen11', ar: 'Zen11 (السمت اللثوي #11)', en: 'Gingival Zenith #11', hintAr: 'أعلى نقطة في الهامش اللثوي للثنية #11' },
    { key: 'Zen21', ar: 'Zen21 (السمت اللثوي #21)', en: 'Gingival Zenith #21', hintAr: 'أعلى نقطة في الهامش اللثوي للثنية #21' },
    { key: 'U1Edge', ar: 'U1Edge (حافة #11 القاطعة)', en: 'Incisal Edge #11', hintAr: 'الحافة القاطعة للثنية العلوية #11' },
    { key: 'L1Edge', ar: 'L1Edge (حافة #41 القاطعة)', en: 'Incisal Edge #41', hintAr: 'الحافة القاطعة للثنية السفلية #41 (أو تقدير موضعها تحت #11)' },
    { key: 'Ging41', ar: 'Ging41 (لثة #41)', en: 'Gingival Margin #41', hintAr: 'الحافة اللثوية السفلية للثنية #41 لحساب نسبة التغطية' },
    { key: 'W11R', ar: 'W11R (وحشي #11)', en: 'Distal #11', hintAr: 'أعرض نقطة يمنى للثنية #11' },
    { key: 'W11L', ar: 'W11L (أنسي #11)', en: 'Mesial #11', hintAr: 'أعرض نقطة يسرى للثنية #11' },
    { key: 'W12R', ar: 'W12R (وحشي #12)', en: 'Distal #12', hintAr: 'الحافة الوحشية للرباعية #12' },
    { key: 'W12L', ar: 'W12L (أنسي #12)', en: 'Mesial #12', hintAr: 'الحافة الأنسية للرباعية #12' },
  ],
  intraoral_right: [
    { key: 'U6MB', ar: 'U6MB (حدبة الضرس #16)', en: 'Upper #16 MB Cusp', hintAr: 'الحدبة الأنسية الدهليزية للضرس العلوي الأول الأيمن #16' },
    { key: 'L6Groove', ar: 'L6Groove (ميزاب الضرس #46)', en: 'Lower #46 Buccal Groove', hintAr: 'الميزاب الدهليزي للضرس السفلي الأول الأيمن #46' },
    { key: 'U3Tip', ar: 'U3Tip (ذروة الناب #13)', en: 'Upper Canine #13 Tip', hintAr: 'ذروة حدبة الناب العلوي الأيمن #13' },
    { key: 'L34Embr', ar: 'L34Embr (بين 43 و 44)', en: 'Lower 43-44 Embrasure', hintAr: 'المسافة البينية بين الناب #43 والضاحك #44' },
    { key: 'U1Axis', ar: 'U1Axis (عنق #11)', en: 'Cervical Axis #11', hintAr: 'نقطة عنق التاج الدهليزي للثنية #11 لتحديد محور الميل' },
    { key: 'U1Lab', ar: 'U1Lab (حافة #11 الدهليزية)', en: 'Labial Edge #11', hintAr: 'أبرز نقطة في الحافة القاطعة للثنية #11' },
    { key: 'L1Lab', ar: 'L1Lab (حافة #41 الدهليزية)', en: 'Labial Edge #41', hintAr: 'الحافة القاطعة الدهليزية للثنية السفلية #41' },
  ],
  intraoral_left: [
    { key: 'U6MB', ar: 'U6MB (حدبة الضرس #26)', en: 'Upper #26 MB Cusp', hintAr: 'الحدبة الأنسية الدهليزية للضرس العلوي الأول الأيسر #26' },
    { key: 'L6Groove', ar: 'L6Groove (ميزاب الضرس #36)', en: 'Lower #36 Buccal Groove', hintAr: 'الميزاب الدهليزي للضرس السفلي الأول الأيسر #36' },
    { key: 'U3Tip', ar: 'U3Tip (ذروة الناب #23)', en: 'Upper Canine #23 Tip', hintAr: 'ذروة حدبة الناب العلوي الأيسر #23' },
    { key: 'L34Embr', ar: 'L34Embr (بين 33 و 34)', en: 'Lower 33-34 Embrasure', hintAr: 'المسافة البينية بين الناب #33 والضاحك #34' },
    { key: 'U1Axis', ar: 'U1Axis (عنق #21)', en: 'Cervical Axis #21', hintAr: 'نقطة عنق التاج الدهليزي للثنية #21 لتحديد محور الميل' },
    { key: 'U1Lab', ar: 'U1Lab (حافة #21 الدهليزية)', en: 'Labial Edge #21', hintAr: 'أبرز نقطة في الحافة القاطعة للثنية #21' },
    { key: 'L1Lab', ar: 'L1Lab (حافة #31 الدهليزية)', en: 'Labial Edge #31', hintAr: 'الحافة القاطعة الدهليزية للثنية السفلية #31' },
  ],
  intraoral_upper: [
    { key: 'IncMid', ar: 'IncMid (الخط المتوسط 11-21)', en: 'Incisive Papilla / 11-21', hintAr: 'منتصف الحليمة القاطعة بين 11 و 21' },
    { key: 'PalMid', ar: 'PalMid (الرفاء الحنكي الخلفي)', en: 'Posterior Palatal Raphe', hintAr: 'نقطة خلفية على الخط الناصف الحنكي' },
    { key: 'IncEdge', ar: 'IncEdge (ذروة قوس القواطع)', en: 'Anterior Incisal Arch Apex', hintAr: 'أمامي نقطة على قوس الحواف القاطعة 11-21' },
    { key: 'C3R', ar: 'C3R (ناب علوي يمين #13)', en: 'Upper Right Canine #13', hintAr: 'ذروة الناب العلوي الأيمن #13' },
    { key: 'C3L', ar: 'C3L (ناب علوي يسار #23)', en: 'Upper Left Canine #23', hintAr: 'ذروة الناب العلوي الأيسر #23' },
    { key: 'P4R', ar: 'P4R (ضاحك أول يمين #14)', en: 'Upper Right 1st Premolar #14', hintAr: 'الحفرة المركزية للضاحك العلوي #14' },
    { key: 'P4L', ar: 'P4L (ضاحك أول يسار #24)', en: 'Upper Left 1st Premolar #24', hintAr: 'الحفرة المركزية للضاحك العلوي #24' },
    { key: 'M6R', ar: 'M6R (ضرس أول يمين #16)', en: 'Upper Right 1st Molar #16', hintAr: 'الحفرة الأنسية المركزية للضرس #16' },
    { key: 'M6L', ar: 'M6L (ضرس أول يسار #26)', en: 'Upper Left 1st Molar #26', hintAr: 'الحفرة الأنسية المركزية للضرس #26' },
  ],
  intraoral_lower: [
    { key: 'IncMid', ar: 'IncMid (الخط المتوسط 41-31)', en: 'Lower Midline 41-31', hintAr: 'نقطة التماس بين الثنيتين السفليتين 41-31' },
    { key: 'PalMid', ar: 'PalMid (منتصف اللسان الخلفي)', en: 'Posterior Lingual Midline', hintAr: 'نقطة مرجعية خلفية على الخط الناصف لقاع الفم' },
    { key: 'IncEdge', ar: 'IncEdge (ذروة قوس القواطع)', en: 'Lower Incisal Arch Apex', hintAr: 'أمامي نقطة على قوس القواطع السفلية' },
    { key: 'C3R', ar: 'C3R (ناب سفلي يمين #43)', en: 'Lower Right Canine #43', hintAr: 'ذروة الناب السفلي الأيمن #43' },
    { key: 'C3L', ar: 'C3L (ناب سفلي يسار #33)', en: 'Lower Left Canine #33', hintAr: 'ذروة الناب السفلي الأيسر #33' },
    { key: 'P4R', ar: 'P4R (ضاحك أول يمين #44)', en: 'Lower Right 1st Premolar #44', hintAr: 'الحدبة الدهليزية للضاحك السفلي #44' },
    { key: 'P4L', ar: 'P4L (ضاحك أول يسار #34)', en: 'Lower Left 1st Premolar #34', hintAr: 'الحدبة الدهليزية للضاحك السفلي #34' },
    { key: 'M6R', ar: 'M6R (ضرس أول يمين #46)', en: 'Lower Right 1st Molar #46', hintAr: 'الحفرة المركزية للضرس السفلي #46' },
    { key: 'M6L', ar: 'M6L (ضرس أول يسار #36)', en: 'Lower Left 1st Molar #36', hintAr: 'الحفرة المركزية للضرس السفلي #36' },
  ],
};

export function computePhotoMetrics(
  mode: PhotoModeId,
  landmarks: Record<string, Point2D>,
  imgW = 1000,
  imgH = 1000,
  pixelsPerMm: number | null = null,
): AnalysisMetric[] {
  const px = (k: string): Point2D | null => {
    const p = landmarks[k];
    return p ? { x: p.x * imgW, y: p.y * imgH } : null;
  };

  if (mode === 'frontal') {
    const Tr = px('Tr');
    const G = px('G');
    const Sn = px('Sn');
    const MeS = px('MeS');
    const PuR = px('PuR');
    const PuL = px('PuL');
    const ChR = px('ChR');
    const ChL = px('ChL');
    const AlR = px('AlR');
    const AlL = px('AlL');
    const MidDental = px('MidDental');

    const totalH = Tr && MeS ? Math.abs(MeS.y - Tr.y) : null;
    const upperPct = Tr && G && totalH ? Number(((Math.abs(G.y - Tr.y) / totalH) * 100).toFixed(1)) : null;
    const midPct = G && Sn && totalH ? Number(((Math.abs(Sn.y - G.y) / totalH) * 100).toFixed(1)) : null;
    const lowerPct = Sn && MeS && totalH ? Number(((Math.abs(MeS.y - Sn.y) / totalH) * 100).toFixed(1)) : null;

    const cantAngle =
      PuR && PuL && ChR && ChL ? angleBetweenLines(PuR, PuL, ChR, ChL) : null;

    const midlineShiftMm =
      PuR && PuL && MidDental && pixelsPerMm && pixelsPerMm > 0
        ? Number(
            (
              Math.abs(MidDental.x - (PuR.x + PuL.x) / 2) /
              pixelsPerMm
            ).toFixed(1),
          )
        : null;

    const alarToCommissureRatio =
      AlR && AlL && ChR && ChL
        ? Number(((Math.hypot(ChR.x - ChL.x, ChR.y - ChL.y) / Math.max(1, Math.hypot(AlR.x - AlL.x, AlR.y - AlL.y))) * 100).toFixed(0))
        : null;

    return [
      {
        key: 'FACIAL_UPPER_THIRD',
        labelAr: 'نسبة الثلث الوجهي العلوي (Tr-G)',
        labelEn: 'Upper Facial Third (%)',
        value: upperPct,
        unit: '%',
        normRange: '33% ± 3%',
        formulaDesc: 'نسبة ارتفاع الجبهة إلى الارتفاع الوجهي الكلي',
        interpretation: upperPct === null ? 'حدد Tr, G, Me′' : Math.abs(upperPct - 33.3) <= 3.5 ? 'متناسق' : 'تفاوت نسبي بالثلث العلوي',
        requiresCalibration: false,
      },
      {
        key: 'FACIAL_MID_THIRD',
        labelAr: 'نسبة الثلث الوجهي الأوسط (G-Sn)',
        labelEn: 'Middle Facial Third (%)',
        value: midPct,
        unit: '%',
        normRange: '33% ± 3%',
        formulaDesc: 'نسبة الارتفاع بين الحاجبين وقاعدة الأنف',
        interpretation: midPct === null ? 'حدد G, Sn, Me′' : Math.abs(midPct - 33.3) <= 3.5 ? 'متناسق' : 'تفاوت بالثلث الأوسط',
        requiresCalibration: false,
      },
      {
        key: 'FACIAL_LOWER_THIRD',
        labelAr: 'نسبة الثلث الوجهي السفلي (Sn-Me′)',
        labelEn: 'Lower Facial Third (%)',
        value: lowerPct,
        unit: '%',
        normRange: '33% ± 3%',
        formulaDesc: 'نسبة ارتفاع الثلث الفكي السفلي إلى الارتفاع الكلي',
        interpretation:
          lowerPct === null
            ? 'حدد Sn, Me′'
            : lowerPct > 37
            ? 'زيادة في الثلث السفلي (نمط وجه طويل)'
            : lowerPct < 29
            ? 'نقص في الثلث السفلي (عضة عميقة محتملة)'
            : 'تناسق وجهي مثالي',
        requiresCalibration: false,
      },
      {
        key: 'COMMISSURE_CANT',
        labelAr: 'زاوية ميلان مستوى الشفتين (Cant Angle)',
        labelEn: 'Interpupillary vs Commissure Cant',
        value: cantAngle,
        unit: 'deg',
        normRange: '0° – 2°',
        formulaDesc: 'الزاوية بين الخط المار بالحدقتين والخط بين زاويتي الفم',
        interpretation: cantAngle === null ? 'حدد PuR/PuL و ChR/ChL' : cantAngle > 2.5 ? 'ميلان ملحوظ بمستوى الشفة/الإطباق' : 'توازي أفقي سليم',
        requiresCalibration: false,
      },
      {
        key: 'MIDLINE_SHIFT_PHOTO',
        labelAr: 'انحراف الخط المتوسط السني عن الوجهي',
        labelEn: 'Dental to Facial Midline Shift',
        value: midlineShiftMm,
        unit: 'mm',
        normRange: '0 – 1 mm',
        formulaDesc: 'المسافة الأفقية بين الخط المتوسط السني ومنتصف الحدقتين',
        interpretation: midlineShiftMm === null ? 'يتطلب معايرة الصورة' : midlineShiftMm > 1.5 ? 'انحراف خط متوسط سني' : 'تطابق جيد',
        requiresCalibration: true,
      },
      {
        key: 'NOSE_MOUTH_RATIO',
        labelAr: 'نسبة عرض الفم إلى عرض الأنف',
        labelEn: 'Commissure to Alar Width Ratio',
        value: alarToCommissureRatio,
        unit: '%',
        normRange: '140% – 160%',
        formulaDesc: 'عرض زاويتي الفم ÷ عرض جناحي الأنف × 100',
        interpretation: alarToCommissureRatio === null ? 'حدد AlR/AlL و ChR/ChL' : 'نسبة تناسق عرض الابتسامة',
        requiresCalibration: false,
      },
    ];
  }

  if (mode === 'profile') {
    const G = px('G');
    const Pn = px('Pn');
    const Col = px('Col');
    const Sn = px('Sn');
    const Ls = px('Ls');
    const Li = px('Li');
    const BS = px('BS');
    const PogS = px('PogS');

    const nasolabial = Col && Sn && Ls ? angleThreePoints(Col, Sn, Ls) : null;
    const mentolabial = Li && BS && PogS ? angleThreePoints(Li, BS, PogS) : null;
    const facialConvexity = G && Sn && PogS ? Number((180 - angleThreePoints(G, Sn, PogS)).toFixed(1)) : null;
    const lsE =
      landmarks.Ls && landmarks.Pn && landmarks.PogS
        ? pointToLineDistanceMm(landmarks.Ls, landmarks.Pn, landmarks.PogS, imgW, imgH, pixelsPerMm)
        : null;
    const liE =
      landmarks.Li && landmarks.Pn && landmarks.PogS
        ? pointToLineDistanceMm(landmarks.Li, landmarks.Pn, landmarks.PogS, imgW, imgH, pixelsPerMm)
        : null;

    return [
      {
        key: 'PHOTO_CONVEXITY',
        labelAr: 'زاوية تحدب البروفايل الرخو (G-Sn-Pog′)',
        labelEn: 'Soft-Tissue Facial Convexity',
        value: facialConvexity,
        unit: 'deg',
        normRange: '12° ± 4°',
        formulaDesc: 'انحراف زاوية G-Sn-Pog′ عن الاستقامة (180° − ∠G-Sn-Pog′)',
        interpretation:
          facialConvexity === null
            ? 'حدد G, Sn, Pog′'
            : facialConvexity > 16
            ? 'بروفايل محدب (Class II tendency)'
            : facialConvexity < 6
            ? 'بروفايل مستقيم / مقعر (Class III tendency)'
            : 'بروفايل متناسق',
        requiresCalibration: false,
      },
      {
        key: 'PHOTO_NASOLABIAL',
        labelAr: 'الزاوية الأنفية الشفوية (Nasolabial)',
        labelEn: 'Nasolabial Angle',
        value: nasolabial,
        unit: 'deg',
        normRange: '95° – 110°',
        formulaDesc: 'الزاوية بين Col و Sn و Ls',
        interpretation:
          nasolabial === null
            ? 'حدد Col, Sn, Ls'
            : nasolabial < 90
            ? 'زاوية حادة (تقدم شفة علوية)'
            : nasolabial > 112
            ? 'زاوية منفرجة (تجنب خلع يراجع الشفة)'
            : 'ضمن الحدود الجمالية',
        requiresCalibration: false,
      },
      {
        key: 'PHOTO_MENTOLABIAL',
        labelAr: 'الزاوية الذقنية الشفوية (Mentolabial)',
        labelEn: 'Mentolabial Fold Angle',
        value: mentolabial,
        unit: 'deg',
        normRange: '120° – 135°',
        formulaDesc: 'الزاوية بين Li و B′ و Pog′',
        interpretation:
          mentolabial === null
            ? 'حدد Li, B′, Pog′'
            : mentolabial < 112
            ? 'ثنية ذقنية عميقة (عضة عميقة)'
            : 'انسياب ذقني متزن',
        requiresCalibration: false,
      },
      {
        key: 'PHOTO_LS_E',
        labelAr: 'بروز الشفة العليا لخط Ricketts E',
        labelEn: 'Upper Lip to E-Line (Photo)',
        value: lsE,
        unit: 'mm',
        normRange: '-4 mm ± 2',
        formulaDesc: 'المسافة من Ls لخط Pn-Pog′',
        interpretation: lsE === null ? 'يتطلب معايرة الصورة' : lsE > -1 ? 'بروز شفة عليا' : 'متوازن',
        requiresCalibration: true,
      },
      {
        key: 'PHOTO_LI_E',
        labelAr: 'بروز الشفة السفلى لخط Ricketts E',
        labelEn: 'Lower Lip to E-Line (Photo)',
        value: liE,
        unit: 'mm',
        normRange: '-2 mm ± 2',
        formulaDesc: 'المسافة من Li لخط Pn-Pog′',
        interpretation: liE === null ? 'يتطلب معايرة الصورة' : liE > 1 ? 'بروز شفة سفلى' : 'متوازن',
        requiresCalibration: true,
      },
    ];
  }

  if (mode === 'smile') {
    const ChR = px('ChR');
    const ChL = px('ChL');
    const DentR = px('DentR');
    const DentL = px('DentL');
    const LipUpper = px('LipUpper');
    const Ging11 = px('Ging11');
    const U1Edge = px('U1Edge');
    const CanineL = px('CanineL');
    const LipLower = px('LipLower');
    const FaceMid = px('FaceMid');
    const DentMid = px('DentMid');

    const commW = ChR && ChL ? Math.hypot(ChR.x - ChL.x, ChR.y - ChL.y) : null;
    const dentW = DentR && DentL ? Math.hypot(DentR.x - DentL.x, DentR.y - DentL.y) : null;
    const buccalCorridorPct =
      commW && dentW && commW > 0 ? Number((((commW - dentW) / commW) * 100).toFixed(1)) : null;

    const crownH = Ging11 && U1Edge ? Math.abs(U1Edge.y - Ging11.y) : null;
    const incisorDisplayPct =
      LipUpper && U1Edge && crownH && crownH > 0
        ? Number(Math.min(130, Math.max(0, ((U1Edge.y - LipUpper.y) / crownH) * 100)).toFixed(0))
        : null;

    const gingivalDisplayMm =
      LipUpper && Ging11 && pixelsPerMm && pixelsPerMm > 0
        ? Number(((Ging11.y - LipUpper.y) / pixelsPerMm).toFixed(1))
        : null;

    const smileArcDiffDeg =
      U1Edge && CanineL && LipLower && ChL
        ? angleBetweenLines(U1Edge, CanineL, LipLower, ChL)
        : null;

    const smileMidShiftMm =
      FaceMid && DentMid && pixelsPerMm && pixelsPerMm > 0
        ? Number((Math.abs(DentMid.x - FaceMid.x) / pixelsPerMm).toFixed(1))
        : null;

    return [
      {
        key: 'BUCCAL_CORRIDOR',
        labelAr: 'نسبة الممر الشدقي (Buccal Corridor)',
        labelEn: 'Buccal Corridor Ratio',
        value: buccalCorridorPct,
        unit: '%',
        normRange: '10% – 16%',
        formulaDesc: '(عرض زاويتي الفم − عرض الأسنان الظاهرة) ÷ عرض زاويتي الفم × 100',
        interpretation:
          buccalCorridorPct === null
            ? 'حدد ChR/ChL و DentR/DentL'
            : buccalCorridorPct > 20
            ? 'ممر شدقي عريض (قوس علوي ضيق يحتاج توسيع)'
            : buccalCorridorPct < 6
            ? 'ابتسامة عريضة جداً (ممر شدقي ضيق)'
            : 'ممر شدقي مثالي',
        requiresCalibration: false,
      },
      {
        key: 'INCISOR_DISPLAY_PCT',
        labelAr: 'نسبة ظهور القاطع العلوي أثناء الابتسامة',
        labelEn: 'Maxillary Incisor Display (%)',
        value: incisorDisplayPct,
        unit: '%',
        normRange: '85% – 105%',
        formulaDesc: 'الجزء الظاهر من تاج #11 أسفل الشفة العليا مقارنة بارتفاع التاج',
        interpretation:
          incisorDisplayPct === null
            ? 'حدد LipUpper, Ging11, U1Edge'
            : incisorDisplayPct < 75
            ? 'ظهور قاطعي منخفض (ابتسامة منخفضة)'
            : 'ظهور قاطعي كامل وحيوي',
        requiresCalibration: false,
      },
      {
        key: 'GINGIVAL_DISPLAY_MM',
        labelAr: 'مقدار ظهور اللثة (Gingival Display)',
        labelEn: 'Gingival Display at Smile',
        value: gingivalDisplayMm,
        unit: 'mm',
        normRange: '0 – 2.0 mm',
        formulaDesc: 'المسافة العمودية بين الشفة العليا والسمت اللثوي #11',
        interpretation:
          gingivalDisplayMm === null
            ? 'يتطلب معايرة الصورة'
            : gingivalDisplayMm > 3
            ? 'ابتسامة لثوية (Gummy Smile)'
            : gingivalDisplayMm < 0
            ? 'تغطية جزئية للتيجان (0 مم لثة)'
            : 'ظهور لثوي مثالي',
        requiresCalibration: true,
      },
      {
        key: 'SMILE_ARC_PARALLEL',
        labelAr: 'توازي قوس الابتسامة مع الشفة السفلى',
        labelEn: 'Smile Arc Divergence',
        value: smileArcDiffDeg,
        unit: 'deg',
        normRange: '0° – 6°',
        formulaDesc: 'الفرق الزاوي بين منحنى القواطع-الأنياب وانحناء الشفة السفلى',
        interpretation:
          smileArcDiffDeg === null
            ? 'حدد U1Edge, CanineL, LipLower, ChL'
            : smileArcDiffDeg <= 7
            ? 'قوس ابتسامة متوافق ومحدب (Consonant)'
            : 'قوس ابتسامة مسطح نسبياً',
        requiresCalibration: false,
      },
      {
        key: 'SMILE_MIDLINE_SHIFT',
        labelAr: 'انحراف الخط المتوسط بالابتسامة',
        labelEn: 'Smile Dental-to-Philtrum Shift',
        value: smileMidShiftMm,
        unit: 'mm',
        normRange: '0 – 1.5 mm',
        formulaDesc: 'الإزاحة الأفقية بين النثرة الوجهية ومنتصف 11-21',
        interpretation: smileMidShiftMm === null ? 'يتطلب معايرة' : smileMidShiftMm > 2 ? 'انحراف ملحوظ' : 'تطابق جمالي جيد',
        requiresCalibration: true,
      },
    ];
  }

  if (mode === 'intraoral_frontal') {
    const UMid = px('UMid');
    const LMid = px('LMid');
    const UCanR = px('UCanR');
    const UCanL = px('UCanL');
    const Zen11 = px('Zen11');
    const Zen21 = px('Zen21');
    const U1Edge = px('U1Edge');
    const L1Edge = px('L1Edge');
    const Ging41 = px('Ging41');
    const W11R = px('W11R');
    const W11L = px('W11L');
    const W12R = px('W12R');
    const W12L = px('W12L');

    const midDevMm =
      UMid && LMid && pixelsPerMm && pixelsPerMm > 0
        ? Number((Math.abs(UMid.x - LMid.x) / pixelsPerMm).toFixed(1))
        : null;
    const w11Px = W11R && W11L ? Math.hypot(W11R.x - W11L.x, W11R.y - W11L.y) : null;
    const w12Px = W12R && W12L ? Math.hypot(W12R.x - W12L.x, W12R.y - W12L.y) : null;
    const midDevPct =
      UMid && LMid && w11Px && w11Px > 0
        ? Number(((Math.abs(UMid.x - LMid.x) / w11Px) * 100).toFixed(0))
        : null;

    const occlusalCant =
      UCanR && UCanL
        ? Number(((Math.atan2(Math.abs(UCanL.y - UCanR.y), Math.max(1, Math.abs(UCanL.x - UCanR.x))) * 180) / Math.PI).toFixed(1))
        : null;

    const zenithCant =
      Zen11 && Zen21
        ? Number(((Math.atan2(Math.abs(Zen21.y - Zen11.y), Math.max(1, Math.abs(Zen21.x - Zen11.x))) * 180) / Math.PI).toFixed(1))
        : null;

    const lowerCrownH = L1Edge && Ging41 ? Math.abs(Ging41.y - L1Edge.y) : null;
    const overbitePct =
      U1Edge && L1Edge && lowerCrownH && lowerCrownH > 0
        ? Number(Math.max(-50, Math.min(120, ((U1Edge.y - L1Edge.y) / lowerCrownH) * 100)).toFixed(0))
        : null;
    const overbiteMm =
      U1Edge && L1Edge && pixelsPerMm && pixelsPerMm > 0
        ? Number(((U1Edge.y - L1Edge.y) / pixelsPerMm).toFixed(1))
        : null;

    const goldenRatioPct =
      w11Px && w12Px && w11Px > 0 ? Number(((w12Px / w11Px) * 100).toFixed(1)) : null;

    return [
      {
        key: 'INTRA_MIDLINE_DEV_MM',
        labelAr: 'تطابق الخط المتوسط السني (علوي/سفلي)',
        labelEn: 'Upper-to-Lower Midline Deviation (mm)',
        value: midDevMm,
        unit: 'mm',
        normRange: '0 – 1.0 mm',
        formulaDesc: 'الإزاحة الأفقية بين الخط المتوسط العلوي 11-21 والسفلي 41-31',
        interpretation:
          midDevMm === null
            ? 'يتطلب معايرة الصورة وتحديد UMid/LMid'
            : midDevMm > 1.5
            ? 'انحراف خط متوسط بين الفكين'
            : 'تطابق خط متوسط سليم',
        requiresCalibration: true,
      },
      {
        key: 'INTRA_MIDLINE_DEV_PCT',
        labelAr: 'نسبة انحراف الخط المتوسط لعرض #11',
        labelEn: 'Midline Deviation (% of #11 Width)',
        value: midDevPct,
        unit: '%',
        normRange: '0% – 15%',
        formulaDesc: 'حساب نسبي لانحراف الخط المتوسط دون حاجة لمعايرة',
        interpretation:
          midDevPct === null
            ? 'حدد UMid/LMid و W11R/W11L'
            : midDevPct > 18
            ? 'انحراف خط متوسط واضح (>1.5 مم تقديرياً)'
            : 'متوافق سريرياً',
        requiresCalibration: false,
      },
      {
        key: 'INTRA_OCCLUSAL_CANT',
        labelAr: 'ميلان المستوى الإطباقي الأمامي (Occlusal Cant)',
        labelEn: 'Anterior Occlusal Plane Cant',
        value: occlusalCant,
        unit: 'deg',
        normRange: '0° – 2.0°',
        formulaDesc: 'الزاوية بين الخط الواصل لذروتي النابين #13-#23 والأفق',
        interpretation:
          occlusalCant === null
            ? 'حدد UCanR و UCanL'
            : occlusalCant > 2.5
            ? 'ميلان بالمستوى الإطباقي الأمامي'
            : 'استواء إطباقي متوازن',
        requiresCalibration: false,
      },
      {
        key: 'INTRA_OVERBITE_PCT',
        labelAr: 'نسبة التغطية العمودية (Overbite %)',
        labelEn: 'Overbite Coverage (%)',
        value: overbitePct,
        unit: '%',
        normRange: '15% – 35%',
        formulaDesc: 'نسبة تغطية الحافة القاطعة العلوية #11 لتاج الثنية السفلية #41',
        interpretation:
          overbitePct === null
            ? 'حدد U1Edge, L1Edge, Ging41'
            : overbitePct > 45
            ? 'عضة عميقة (Deep Bite)'
            : overbitePct < 5
            ? 'عضة مفتوحة / حد لحد (Open / Edge-to-Edge)'
            : 'تغطية عمودية طبيعية',
        requiresCalibration: false,
      },
      {
        key: 'INTRA_OVERBITE_MM',
        labelAr: 'التغطية العمودية بالملم (Overbite mm)',
        labelEn: 'Overbite (mm)',
        value: overbiteMm,
        unit: 'mm',
        normRange: '1.5 – 3.5 mm',
        formulaDesc: 'المسافة العمودية بين الحافة القاطعة #11 و #41',
        interpretation:
          overbiteMm === null
            ? 'يتطلب معايرة الصورة'
            : overbiteMm > 4.0
            ? 'عضة عميقة زائدة'
            : overbiteMm < 0.5
            ? 'نقص التغطية / عضة مفتوحة'
            : 'ضمن المعدل الطبيعي',
        requiresCalibration: true,
      },
      {
        key: 'INTRA_GOLDEN_RATIO',
        labelAr: 'نسبة عرض الرباعية إلى الثنية (#12 / #11)',
        labelEn: 'Lateral-to-Central Incisor Width Ratio',
        value: goldenRatioPct,
        unit: '%',
        normRange: '62% – 74%',
        formulaDesc: 'عرض #12 الظاهري ÷ عرض #11 × 100 (التناسب الجمالي الذهبي)',
        interpretation:
          goldenRatioPct === null
            ? 'حدد W11R/L و W12R/L'
            : goldenRatioPct < 58
            ? 'رباعية ضيقة / وتدية (Peg Lateral محتمل)'
            : goldenRatioPct > 80
            ? 'رباعية عريضة نسبياً'
            : 'تناسب جمالي متزن',
        requiresCalibration: false,
      },
      {
        key: 'INTRA_ZENITH_CANT',
        labelAr: 'تماثل السمت اللثوي (#11 مقابل #21)',
        labelEn: 'Gingival Zenith Level Symmetry',
        value: zenithCant,
        unit: 'deg',
        normRange: '0° – 2.0°',
        formulaDesc: 'تساوي مستوى الحافة اللثوية للثنيتين العلويتين',
        interpretation:
          zenithCant === null ? 'حدد Zen11 و Zen21' : zenithCant > 2.5 ? 'عدم تماثل بمستوى اللثة الأمامية' : 'تماثل لثوي جيد',
        requiresCalibration: false,
      },
    ];
  }

  if (mode === 'intraoral_right' || mode === 'intraoral_left') {
    const U6MB = px('U6MB');
    const L6Groove = px('L6Groove');
    const U3Tip = px('U3Tip');
    const L34Embr = px('L34Embr');
    const U1Axis = px('U1Axis');
    const U1Lab = px('U1Lab');
    const L1Lab = px('L1Lab');

    const refRear = U6MB;
    const refFront = U3Tip || U1Lab;
    let dirX = 0;
    let dirY = 0;
    let hasDir = false;
    if (refRear && refFront) {
      const dx = refFront.x - refRear.x;
      const dy = refFront.y - refRear.y;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        dirX = dx / len;
        dirY = dy / len;
        hasDir = true;
      }
    }

    const molarOffsetMm =
      hasDir && U6MB && L6Groove && pixelsPerMm && pixelsPerMm > 0
        ? Number((((U6MB.x - L6Groove.x) * dirX + (U6MB.y - L6Groove.y) * dirY) / pixelsPerMm).toFixed(1))
        : null;

    const canineOffsetMm =
      hasDir && U3Tip && L34Embr && pixelsPerMm && pixelsPerMm > 0
        ? Number((((U3Tip.x - L34Embr.x) * dirX + (U3Tip.y - L34Embr.y) * dirY) / pixelsPerMm).toFixed(1))
        : null;

    const buccalOverjetMm =
      hasDir && U1Lab && L1Lab && pixelsPerMm && pixelsPerMm > 0
        ? Number((((U1Lab.x - L1Lab.x) * dirX + (U1Lab.y - L1Lab.y) * dirY) / pixelsPerMm).toFixed(1))
        : null;

    const u1OcclusalAngle =
      U1Axis && U1Lab && refRear && refFront
        ? angleBetweenLines(U1Lab, U1Axis, refFront, refRear)
        : null;

    const sideLabel = mode === 'intraoral_right' ? 'يمين' : 'يسار';

    return [
      {
        key: 'INTRA_MOLAR_SAGITTAL_MM',
        labelAr: `انحراف علاقة الأرحاء (${sideLabel})`,
        labelEn: `Sagittal Molar Relationship (${mode === 'intraoral_right' ? 'Right' : 'Left'})`,
        value: molarOffsetMm,
        unit: 'mm',
        normRange: '0 ± 1.5 mm (Class I)',
        formulaDesc: 'الإزاحة السهمية بين حدبة U6MB وميزاب L6 على محور الإطباق',
        interpretation:
          molarOffsetMm === null
            ? 'يتطلب معايرة وتحديد U6MB/L6Groove'
            : molarOffsetMm > 1.5
            ? 'ميل لصنف ثانٍ (Class II Molar)'
            : molarOffsetMm < -1.5
            ? 'ميل لصنف ثالث (Class III Molar)'
            : 'علاقة أرحاء صنف أول (Class I)',
        requiresCalibration: true,
      },
      {
        key: 'INTRA_CANINE_SAGITTAL_MM',
        labelAr: `انحراف علاقة الأنياب (${sideLabel})`,
        labelEn: `Sagittal Canine Relationship (${mode === 'intraoral_right' ? 'Right' : 'Left'})`,
        value: canineOffsetMm,
        unit: 'mm',
        normRange: '0 ± 1.0 mm (Class I)',
        formulaDesc: 'الإزاحة السهمية بين ذروة الناب العلوي والفراغ بين 3-4 السفلي',
        interpretation:
          canineOffsetMm === null
            ? 'يتطلب معايرة وتحديد U3Tip/L34Embr'
            : canineOffsetMm > 1.0
            ? 'علاقة أنياب صنف ثانٍ (Class II)'
            : canineOffsetMm < -1.0
            ? 'علاقة أنياب صنف ثالث (Class III)'
            : 'علاقة أنياب صنف أول (Class I)',
        requiresCalibration: true,
      },
      {
        key: 'INTRA_BUCCAL_OJ_MM',
        labelAr: 'البروز الأفقي (Overjet بالصورة الجانبية)',
        labelEn: 'Lateral Photo Overjet (mm)',
        value: buccalOverjetMm,
        unit: 'mm',
        normRange: '1.5 – 3.5 mm',
        formulaDesc: 'المسافة السهمية بين السطح الدهليزي للثنية العلوية والسفلية',
        interpretation:
          buccalOverjetMm === null
            ? 'يتطلب معايرة وتحديد U1Lab/L1Lab'
            : buccalOverjetMm > 4.0
            ? 'زيادة البروز الأفقي (Increased Overjet)'
            : buccalOverjetMm < 0.5
            ? 'عضة معكوسة أمامية / حد لحد (Reverse/Edge Overjet)'
            : 'بروز أفقي طبيعي',
        requiresCalibration: true,
      },
      {
        key: 'INTRA_U1_INCLINATION',
        labelAr: 'ميلان محور القاطع العلوي لمستوى الإطباق',
        labelEn: 'Upper Incisor Inclination to Occlusal Plane',
        value: u1OcclusalAngle,
        unit: 'deg',
        normRange: '56° – 66°',
        formulaDesc: 'الزاوية بين محور الثنية العلوية الظاهري ومستوى الإطباق',
        interpretation:
          u1OcclusalAngle === null
            ? 'حدد U1Axis, U1Lab, U6MB, U3Tip'
            : u1OcclusalAngle < 52
            ? 'ميلان أمامي زائد للقواطع (Proclined U1)'
            : u1OcclusalAngle > 70
            ? 'انكفاء / استقامة القواطع (Retroclined U1)'
            : 'ميلان إطباقي متوازن',
        requiresCalibration: false,
      },
    ];
  }

  // intraoral_upper or intraoral_lower (Occlusal Arch Analysis)
  const IncMid = px('IncMid');
  const PalMid = px('PalMid');
  const IncEdge = px('IncEdge');
  const C3R = px('C3R');
  const C3L = px('C3L');
  const P4R = px('P4R');
  const P4L = px('P4L');
  const M6R = px('M6R');
  const M6L = px('M6L');

  const isUpper = mode === 'intraoral_upper';
  const icwMm =
    landmarks.C3R && landmarks.C3L ? distanceMm(landmarks.C3R, landmarks.C3L, imgW, imgH, pixelsPerMm) : null;
  const ipwMm =
    landmarks.P4R && landmarks.P4L ? distanceMm(landmarks.P4R, landmarks.P4L, imgW, imgH, pixelsPerMm) : null;
  const imwMm =
    landmarks.M6R && landmarks.M6L ? distanceMm(landmarks.M6R, landmarks.M6L, imgW, imgH, pixelsPerMm) : null;

  const archDepthMm =
    landmarks.IncEdge && landmarks.M6R && landmarks.M6L && pixelsPerMm && pixelsPerMm > 0
      ? (() => {
          const d = pointToLineDistanceMm(landmarks.IncEdge, landmarks.M6R, landmarks.M6L, imgW, imgH, pixelsPerMm);
          return d !== null ? Number(Math.abs(d).toFixed(1)) : null;
        })()
      : null;

  const icwPx = C3R && C3L ? Math.hypot(C3R.x - C3L.x, C3R.y - C3L.y) : null;
  const imwPx = M6R && M6L ? Math.hypot(M6R.x - M6L.x, M6R.y - M6L.y) : null;
  const archRatioPct =
    icwPx && imwPx && imwPx > 0 ? Number(((icwPx / imwPx) * 100).toFixed(1)) : null;

  const transverseAsymPct = (() => {
    if (!IncMid || !PalMid || !M6R || !M6L) return null;
    const dx = PalMid.x - IncMid.x;
    const dy = PalMid.y - IncMid.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return null;
    const dR = Math.abs(((M6R.x - IncMid.x) * dy - (M6R.y - IncMid.y) * dx) / len);
    const dL = Math.abs(((M6L.x - IncMid.x) * dy - (M6L.y - IncMid.y) * dx) / len);
    const avg = (dR + dL) / 2;
    if (avg <= 0) return null;
    return Number(((Math.abs(dR - dL) / avg) * 100).toFixed(1));
  })();

  return [
    {
      key: 'OCC_INTERCANINE_W',
      labelAr: isUpper ? 'العرض بين الأنياب العلوية (13-23)' : 'العرض بين الأنياب السفلية (43-33)',
      labelEn: isUpper ? 'Upper Intercanine Width (3-3)' : 'Lower Intercanine Width (3-3)',
      value: icwMm,
      unit: 'mm',
      normRange: isUpper ? '32 – 37 mm' : '24 – 28 mm',
      formulaDesc: 'المسافة المباشرة بين ذروتي النابين يمين ويسار',
      interpretation:
        icwMm === null
          ? 'يتطلب معايرة وتحديد C3R/C3L'
          : icwMm < (isUpper ? 31 : 23)
          ? 'ضيق في المسافة بين الأنياب'
          : 'عرض أنياب مناسب',
      requiresCalibration: true,
    },
    {
      key: 'OCC_INTERPREMOLAR_W',
      labelAr: isUpper ? 'العرض بين الضواحك العلوية (14-24)' : 'العرض بين الضواحك السفلية (44-34)',
      labelEn: isUpper ? 'Upper Interpremolar Width (4-4)' : 'Lower Interpremolar Width (4-4)',
      value: ipwMm,
      unit: 'mm',
      normRange: isUpper ? '36 – 43 mm' : '29 – 35 mm',
      formulaDesc: 'المسافة العرضية على مستوى الضواحك الأولى',
      interpretation:
        ipwMm === null
          ? 'يتطلب معايرة وتحديد P4R/P4L'
          : ipwMm < (isUpper ? 35 : 28)
          ? 'تضيق عرضي عند الضواحك'
          : 'عرض ضواحك متوازن',
      requiresCalibration: true,
    },
    {
      key: 'OCC_INTERMOLAR_W',
      labelAr: isUpper ? 'العرض بين الأضراس الأولى (16-26)' : 'العرض بين الأضراس الأولى (46-36)',
      labelEn: isUpper ? 'Upper Intermolar Width (6-6)' : 'Lower Intermolar Width (6-6)',
      value: imwMm,
      unit: 'mm',
      normRange: isUpper ? '44 – 52 mm' : '38 – 46 mm',
      formulaDesc: 'المسافة العرضية بين الأرحاء الأولى يمين ويسار',
      interpretation:
        imwMm === null
          ? 'يتطلب معايرة وتحديد M6R/M6L'
          : imwMm < (isUpper ? 43 : 37)
          ? 'تضيق خلفي في القوس (يستدعي تقييم التوسيع)'
          : 'عرض خلفي طبيعي',
      requiresCalibration: true,
    },
    {
      key: 'OCC_ARCH_DEPTH',
      labelAr: 'طول / عمق القوس السني الأمامي',
      labelEn: 'Anterior Arch Depth (Incisal to 6-6)',
      value: archDepthMm,
      unit: 'mm',
      normRange: '26 – 34 mm',
      formulaDesc: 'البعد العمودي من ذروة القواطع إلى خط الأرحاء 6-6',
      interpretation: archDepthMm === null ? 'يتطلب معايرة وتحديد IncEdge و M6' : 'عمق القوس الإطباقي',
      requiresCalibration: true,
    },
    {
      key: 'OCC_ARCH_RATIO',
      labelAr: 'مؤشر شكل القوس (نسبة 3-3 / 6-6)',
      labelEn: 'Arch Form Ratio (Intercanine / Intermolar)',
      value: archRatioPct,
      unit: '%',
      normRange: '65% – 78%',
      formulaDesc: 'نسبة العرض بين الأنياب إلى العرض بين الأرحاء (بدون معايرة)',
      interpretation:
        archRatioPct === null
          ? 'حدد C3R/L و M6R/L'
          : archRatioPct < 62
          ? 'قوس مستدق الشكل (Tapered / V-Shaped Arch)'
          : archRatioPct > 81
          ? 'قوس عريض / مربع أمامياً (Square Arch)'
          : 'قوس بيضاوي متناسق (Ovoid Arch)',
      requiresCalibration: false,
    },
    {
      key: 'OCC_TRANSVERSE_SYMMETRY',
      labelAr: 'تفاوت التناظر العرضي يمين/يسار',
      labelEn: 'Transverse Arch Asymmetry (%)',
      value: transverseAsymPct,
      unit: '%',
      normRange: '0% – 6%',
      formulaDesc: 'الفرق النسبي لبعد الأرحاء يمين ويسار عن الخط الناصف',
      interpretation:
        transverseAsymPct === null
          ? 'حدد IncMid, PalMid, M6R, M6L'
          : transverseAsymPct > 8
          ? 'عدم تناظر عرضي ملحوظ في القوس'
          : 'تناظر عرضي سليم',
      requiresCalibration: false,
    },
  ];
}

/**
 * Bolton Tooth-Size & Arch Space Discrepancy Analysis
 * - Bolton Anterior Ratio = L6 / U6 * 100 (Norm: 77.2% ± 1.65%)
 * - Bolton Overall Ratio  = L12 / U12 * 100 (Norm: 91.3% ± 1.91%)
 * - Upper Arch Perimeter / Lower Carey Space Required = 10 teeth mesial to 1st permanent molars (54321 | 12345)
 */
export function computeBoltonAndSpace(
  toothWidths: Record<string, number>,
  spaceAvailableUpper: number,
  spaceAvailableLower: number,
) {
  const upper6 = ['13', '12', '11', '21', '22', '23'];
  const lower6 = ['43', '42', '41', '31', '32', '33'];
  const upper10 = ['15', '14', '13', '12', '11', '21', '22', '23', '24', '25'];
  const lower10 = ['45', '44', '43', '42', '41', '31', '32', '33', '34', '35'];
  const upper12 = ['16', '15', '14', '13', '12', '11', '21', '22', '23', '24', '25', '26'];
  const lower12 = ['46', '45', '44', '43', '42', '41', '31', '32', '33', '34', '35', '36'];

  const sum = (keys: string[]) => keys.reduce((acc, k) => acc + (Number(toothWidths[k]) || 0), 0);

  const u6 = sum(upper6);
  const l6 = sum(lower6);
  const u10 = sum(upper10);
  const l10 = sum(lower10);
  const u12 = sum(upper12);
  const l12 = sum(lower12);

  const anteriorRatio = u6 > 0 ? Number(((l6 / u6) * 100).toFixed(1)) : null;
  const overallRatio = u12 > 0 ? Number(((l12 / u12) * 100).toFixed(1)) : null;

  // Bolton Anterior Excess (mm): norm 77.2%
  const anteriorExcess =
    anteriorRatio !== null
      ? anteriorRatio > 77.2
        ? Number((l6 - (u6 * 77.2) / 100).toFixed(1))
        : Number((u6 - (l6 * 100) / 77.2).toFixed(1))
      : null;

  // Bolton Overall Excess (mm): norm 91.3%
  const overallExcess =
    overallRatio !== null
      ? overallRatio > 91.3
        ? Number((l12 - (u12 * 91.3) / 100).toFixed(1))
        : Number((u12 - (l12 * 100) / 91.3).toFixed(1))
      : null;

  // Arch Perimeter (Upper 15..25) & Carey's (Lower 45..35): Space Available (6M-6M) - Sum10
  const upperDiscrepancy = Number((spaceAvailableUpper - u10).toFixed(1));
  const lowerDiscrepancy = Number((spaceAvailableLower - l10).toFixed(1));

  return {
    u6: Number(u6.toFixed(1)),
    l6: Number(l6.toFixed(1)),
    u10: Number(u10.toFixed(1)),
    l10: Number(l10.toFixed(1)),
    u12: Number(u12.toFixed(1)),
    l12: Number(l12.toFixed(1)),
    anteriorRatio,
    overallRatio,
    anteriorExcess,
    anteriorExcessArch: anteriorRatio !== null ? (anteriorRatio > 77.2 ? 'lower' : 'upper') : null,
    overallExcess,
    overallExcessArch: overallRatio !== null ? (overallRatio > 91.3 ? 'lower' : 'upper') : null,
    upperDiscrepancy,
    lowerDiscrepancy,
  };
}

/**
 * Permanent Dentition Comprehensive Model Analyses Suite:
 * Bolton, Upper Arch Perimeter, Carey's Lower Discrepancy, Pont's Index,
 * Linder-Harth, Korkhaus, Ashley-Howe (Inference I & II), Little's Index, Peck & Peck
 */
export interface PermanentCastInputs {
  intercanineU: number;
  intercanineL: number;
  interpremolarU: number; // Pont's MPV: Distal pit 14 to Distal pit 24
  premolarDiameterPmdU: number; // Ashley-Howe PMD: Buccal cusp tip 14 to Buccal cusp tip 24
  intermolarU: number; // Pont's MMV: Mesial pit 16 to Mesial pit 26
  intermolarL: number;
  anteriorArchLenU: number; // Korkhaus Lu (labial of 11/21 perpendicular to 4-4 line)
  premolarBasalWidthU: number; // Ashley-Howe PMBAW (canine fossa to opposite canine fossa)
  curveOfSpee: number;
  overjet: number;
  overbite: number;
  // Little's Irregularity Index (5 mandibular contact point displacements in mm)
  littleContacts: [number, number, number, number, number];
  // Peck & Peck Faciolingual widths of lower incisors (42, 41, 31, 32)
  flWidths: Record<'42' | '41' | '31' | '32', number>;
}

function classifyArchLengthDiscrepancy(disc: number): string {
  if (disc >= 0) return 'مسافة كافية / فراغات — بدون خلع';
  const deficit = Math.abs(disc);
  if (deficit <= 2.5) return 'عجز بسيط (0–2.5 مم) — برد جانبي (IPR / Stripping)';
  if (deficit <= 5.0) return 'عجز متوسط (2.5–5 مم) — حالة حدّية / خلع ضواحك ثانية';
  return 'عجز شديد (>5 مم) — يوصى بخلع الضواحك الأولى غالباً';
}

export function computePermanentModelSuite(
  toothWidths: Record<string, number>,
  spaceAvailableUpper: number,
  spaceAvailableLower: number,
  cast: PermanentCastInputs,
) {
  const bolton = computeBoltonAndSpace(toothWidths, spaceAvailableUpper, spaceAvailableLower);

  // Sum of Upper 4 Incisors (SI = 12 + 11 + 21 + 22)
  const siUpper = Number(
    (['12', '11', '21', '22'].reduce((s, k) => s + (Number(toothWidths[k]) || 0), 0)).toFixed(1),
  );

  // 1. Pont's Index (CPV 4-4 = SI * 100 / 80, CMV 6-6 = SI * 100 / 64; +1–2 mm overexpansion advised for relapse)
  const pontPremolarIdeal = siUpper > 0 ? Number(((siUpper * 100) / 80).toFixed(1)) : 0;
  const pontMolarIdeal = siUpper > 0 ? Number(((siUpper * 100) / 64).toFixed(1)) : 0;
  const pontPremolarDiff = Number((cast.interpremolarU - pontPremolarIdeal).toFixed(1));
  const pontMolarDiff = Number((cast.intermolarU - pontMolarIdeal).toFixed(1));

  // 2. Linder-Harth Index (CPV = SI * 100 / 85, CMV = SI * 100 / 65)
  const linderPremolarIdeal = siUpper > 0 ? Number(((siUpper * 100) / 85).toFixed(1)) : 0;
  const linderMolarIdeal = siUpper > 0 ? Number(((siUpper * 100) / 65).toFixed(1)) : 0;
  const linderPremolarDiff = Number((cast.interpremolarU - linderPremolarIdeal).toFixed(1));
  const linderMolarDiff = Number((cast.intermolarU - linderMolarIdeal).toFixed(1));

  // 3. Korkhaus Analysis (Anterior Arch Length Lu = SI * 100 / 160)
  const korkhausIdealLu = siUpper > 0 ? Number(((siUpper * 100) / 160).toFixed(1)) : 0;
  const korkhausDiff = Number((cast.anteriorArchLenU - korkhausIdealLu).toFixed(1));

  // 4. Ashley-Howe Analysis
  // Inference I: Compare PMBAW vs PMD (buccal cusp tips 14-24)
  const ashleyExpansionDiff = Number((cast.premolarBasalWidthU - cast.premolarDiameterPmdU).toFixed(1));
  const ashleyExpansionPossible = cast.premolarBasalWidthU > cast.premolarDiameterPmdU;
  const ashleyInferenceI =
    cast.premolarBasalWidthU > 0 && cast.premolarDiameterPmdU > 0
      ? ashleyExpansionPossible
        ? `توسيع القوس ممكن (PMBAW ${cast.premolarBasalWidthU} > PMD ${cast.premolarDiameterPmdU})`
        : `توسيع القوس غير ممكن (PMBAW ${cast.premolarBasalWidthU} ≤ PMD ${cast.premolarDiameterPmdU})`
      : '—';

  // Inference II: PMBAW% = (PMBAW * 100) / TTM (TTM = u12)
  const ashleyHowePct =
    bolton.u12 > 0 ? Number(((cast.premolarBasalWidthU / bolton.u12) * 100).toFixed(1)) : null;
  const ashleyHoweCategory =
    ashleyHowePct === null
      ? '—'
      : ashleyHowePct < 37
      ? 'عجز قاعدة ذروية (<37%) — يميل للخلع'
      : ashleyHowePct <= 44
      ? 'حدّي (37–44%) — Borderline'
      : 'قاعدة ذروية كافية (>44%) — بدون خلع غالباً';

  // 5. Little's Irregularity Index (Sum of 5 lower anterior contact displacements)
  const littleSum = Number(cast.littleContacts.reduce((acc, v) => acc + (Number(v) || 0), 0).toFixed(1));
  const littleSeverity =
    littleSum === 0
      ? 'اصطفاف مثالي (0)'
      : littleSum <= 3
      ? 'عدم انتظام بسيط (1–3)'
      : littleSum <= 6
      ? 'عدم انتظام متوسط (4–6)'
      : littleSum <= 9
      ? 'عدم انتظام شديد (7–9)'
      : 'عدم انتظام شديد جداً (>10)';

  // 6. Peck & Peck Ratio (MD / FL * 100) — Centrals ideal 88–92%, Laterals ideal 90–95%
  const peckRatio = (fdi: '42' | '41' | '31' | '32') => {
    const md = Number(toothWidths[fdi]) || 0;
    const fl = Number(cast.flWidths[fdi]) || 0;
    return fl > 0 ? Number(((md / fl) * 100).toFixed(1)) : null;
  };
  const peck41 = peckRatio('41');
  const peck31 = peckRatio('31');
  const peck42 = peckRatio('42');
  const peck32 = peckRatio('32');

  // 7. Upper Arch Perimeter (u10) & Lower Carey's Analysis (l10 + Curve of Spee compensation)
  const speeSpaceNeeded = cast.curveOfSpee > 1 ? Number(((cast.curveOfSpee - 1) * 0.5 + 0.5).toFixed(1)) : 0;
  const careyNetLower = Number((bolton.lowerDiscrepancy - speeSpaceNeeded).toFixed(1));
  const upperArchPlan = classifyArchLengthDiscrepancy(bolton.upperDiscrepancy);
  const careyPlan = classifyArchLengthDiscrepancy(careyNetLower);

  return {
    bolton,
    siUpper,
    pontPremolarIdeal,
    pontMolarIdeal,
    pontPremolarDiff,
    pontMolarDiff,
    linderPremolarIdeal,
    linderMolarIdeal,
    linderPremolarDiff,
    linderMolarDiff,
    korkhausIdealLu,
    korkhausDiff,
    ashleyExpansionDiff,
    ashleyExpansionPossible,
    ashleyInferenceI,
    ashleyHowePct,
    ashleyHoweCategory,
    littleSum,
    littleSeverity,
    peck41,
    peck31,
    peck42,
    peck32,
    speeSpaceNeeded,
    careyNetLower,
    upperArchPlan,
    careyPlan,
  };
}

/**
 * Mixed Dentition Probability & Prediction Analyses Suite:
 * Moyers (1988) Probability Tables (M/F, 50/75/85/95%), Tanaka & Johnston (1974),
 * Nance Mixed Dentition Radiographic (1947), Huckaba (1964), Hixon & Oldfather (1958),
 * Staley & Kerber (1980), Nance Leeway Space, Incisor Liability
 */
export type MoyersConfidence = 50 | 75 | 85 | 95;

// Keys: Sum of Lower 4 Permanent Incisors (19.5 .. 25.5 step 0.5 mm)
const MOYERS_INCISOR_SUMS = [19.5, 20.0, 20.5, 21.0, 21.5, 22.0, 22.5, 23.0, 23.5, 24.0, 24.5, 25.0, 25.5];

// Exact Moyers (1988) Probability Table values (Proffit Table 11-4 / Dr. Aqlan Slides 50 & 56)
const MOYERS_TABLES: Record<'male' | 'female', Record<'upper' | 'lower', Record<MoyersConfidence, number[]>>> = {
  male: {
    upper: {
      50: [19.7, 19.9, 20.2, 20.4, 20.7, 20.9, 21.2, 21.5, 21.7, 22.0, 22.2, 22.5, 22.7],
      75: [20.3, 20.5, 20.8, 21.0, 21.3, 21.5, 21.8, 22.0, 22.3, 22.5, 22.8, 23.0, 23.3],
      85: [20.6, 20.9, 21.1, 21.3, 21.6, 21.8, 22.1, 22.3, 22.6, 22.8, 23.1, 23.3, 23.6],
      95: [21.2, 21.4, 21.6, 21.9, 22.1, 22.3, 22.6, 22.8, 23.1, 23.4, 23.6, 23.9, 24.1],
    },
    lower: {
      50: [19.5, 19.7, 20.0, 20.2, 20.4, 20.6, 20.9, 21.1, 21.3, 21.5, 21.7, 22.0, 22.2],
      75: [20.4, 20.6, 20.8, 21.0, 21.2, 21.4, 21.6, 21.9, 22.1, 22.3, 22.5, 22.8, 23.0],
      85: [20.8, 21.0, 21.2, 21.4, 21.6, 21.9, 22.1, 22.3, 22.5, 22.7, 23.0, 23.2, 23.4],
      95: [21.6, 21.8, 22.0, 22.2, 22.4, 22.6, 22.8, 23.0, 23.2, 23.5, 23.7, 23.9, 24.2],
    },
  },
  female: {
    upper: {
      50: [19.6, 19.8, 19.9, 20.1, 20.2, 20.3, 20.5, 20.6, 20.8, 20.9, 21.0, 21.2, 21.3],
      75: [20.4, 20.5, 20.6, 20.8, 20.9, 21.0, 21.2, 21.3, 21.5, 21.6, 21.8, 21.9, 22.0],
      85: [20.8, 20.9, 21.0, 21.1, 21.3, 21.4, 21.5, 21.7, 21.8, 22.0, 22.1, 22.3, 22.4],
      95: [21.4, 21.6, 21.7, 21.8, 21.9, 22.0, 22.2, 22.3, 22.5, 22.6, 22.8, 22.9, 23.1],
    },
    lower: {
      50: [18.7, 19.0, 19.2, 19.5, 19.8, 20.0, 20.3, 20.5, 20.8, 21.1, 21.3, 21.6, 21.8],
      75: [19.6, 19.8, 20.1, 20.3, 20.6, 20.8, 21.1, 21.3, 21.6, 21.9, 22.1, 22.4, 22.7],
      85: [20.0, 20.3, 20.5, 20.7, 21.0, 21.2, 21.5, 21.8, 22.0, 22.3, 22.6, 22.8, 23.1],
      95: [20.8, 21.0, 21.2, 21.5, 21.7, 22.0, 22.2, 22.5, 22.7, 23.0, 23.3, 23.6, 23.9],
    },
  },
};

function interpolateMoyers(
  sumLower4: number,
  sex: 'male' | 'female',
  arch: 'upper' | 'lower',
  confidence: MoyersConfidence,
): number {
  const arr = MOYERS_TABLES[sex][arch][confidence];
  if (sumLower4 <= MOYERS_INCISOR_SUMS[0]) {
    const slope = (arr[1] - arr[0]) / 0.5;
    return Number((arr[0] + (sumLower4 - MOYERS_INCISOR_SUMS[0]) * slope).toFixed(1));
  }
  const last = MOYERS_INCISOR_SUMS.length - 1;
  if (sumLower4 >= MOYERS_INCISOR_SUMS[last]) {
    const slope = (arr[last] - arr[last - 1]) / 0.5;
    return Number((arr[last] + (sumLower4 - MOYERS_INCISOR_SUMS[last]) * slope).toFixed(1));
  }
  for (let i = 0; i < last; i++) {
    const x0 = MOYERS_INCISOR_SUMS[i];
    const x1 = MOYERS_INCISOR_SUMS[i + 1];
    if (sumLower4 >= x0 && sumLower4 <= x1) {
      const t = (sumLower4 - x0) / (x1 - x0);
      return Number((arr[i] + t * (arr[i + 1] - arr[i])).toFixed(1));
    }
  }
  return arr[last];
}

// Hixon & Oldfather (1958) Original Lower Quadrant Table: Measured = Cast(I1+I2) + Radiographic(4+5)
const HIXON_MEASURED_KEYS = [23, 24, 25, 26, 27, 28, 29, 30];
const HIXON_ESTIMATED_345 = [18.4, 19.0, 19.7, 20.3, 21.0, 21.6, 22.3, 22.9];

function interpolateHixonOldfather(measuredVal: number): number {
  if (measuredVal <= HIXON_MEASURED_KEYS[0]) {
    const slope = HIXON_ESTIMATED_345[1] - HIXON_ESTIMATED_345[0];
    return Number((HIXON_ESTIMATED_345[0] + (measuredVal - HIXON_MEASURED_KEYS[0]) * slope).toFixed(1));
  }
  const last = HIXON_MEASURED_KEYS.length - 1;
  if (measuredVal >= HIXON_MEASURED_KEYS[last]) {
    const slope = HIXON_ESTIMATED_345[last] - HIXON_ESTIMATED_345[last - 1];
    return Number((HIXON_ESTIMATED_345[last] + (measuredVal - HIXON_MEASURED_KEYS[last]) * slope).toFixed(1));
  }
  for (let i = 0; i < last; i++) {
    const x0 = HIXON_MEASURED_KEYS[i];
    const x1 = HIXON_MEASURED_KEYS[i + 1];
    if (measuredVal >= x0 && measuredVal <= x1) {
      const t = (measuredVal - x0) / (x1 - x0);
      return Number((HIXON_ESTIMATED_345[i] + t * (HIXON_ESTIMATED_345[i + 1] - HIXON_ESTIMATED_345[i])).toFixed(1));
    }
  }
  return HIXON_ESTIMATED_345[last];
}

export interface MixedDentitionInputs {
  sex: 'male' | 'female';
  moyersConfidence: MoyersConfidence;
  // Space Available input method: direct per-quadrant (distal of 2 to mesial of 6) vs full arch perimeter (6M to 6M)
  spaceMode: 'quadrant' | 'arch_perimeter';
  archPerimeterU: number;
  archPerimeterL: number;
  // Unerupted Canine (3) source for Huckaba total 3+4+5: radiograph measurement vs regression prediction from L4
  canineSource: 'radiographic' | 'predicted';
  // Permanent incisors mesiodistal (mm)
  w12: number;
  w11: number;
  w21: number;
  w22: number;
  w42: number;
  w41: number;
  w31: number;
  w32: number;
  // Primary incisors sum (for Incisor Liability)
  primaryUpperIncisorsSum: number;
  primaryLowerIncisorsSum: number;
  // Available quadrant space (distal of 2 to mesial of 6) in mm
  spaceUR: number;
  spaceUL: number;
  spaceLR: number;
  spaceLL: number;
  // Primary c+d+e widths per quadrant (for Nance Leeway Space)
  primaryCdeUR: number;
  primaryCdeUL: number;
  primaryCdeLR: number;
  primaryCdeLL: number;
  // Huckaba (1964) Reference Primary Tooth (d or e) true width on cast (M_true) & apparent width on X-ray (M_xray)
  castRefToothUR: number;
  castRefToothUL: number;
  castRefToothLR: number;
  castRefToothLL: number;
  xrayRefToothUR: number;
  xrayRefToothUL: number;
  xrayRefToothLR: number;
  xrayRefToothLL: number;
  // Radiographic width of unerupted canine (3) per quadrant (mm)
  xrayCanineUR: number;
  xrayCanineUL: number;
  xrayCanineLR: number;
  xrayCanineLL: number;
  // Radiographic width of unerupted premolars (4+5) per quadrant (mm)
  xrayPmUR: number;
  xrayPmUL: number;
  xrayPmLR: number;
  xrayPmLL: number;
  // Fallback magnification factor when Huckaba reference tooth widths are omitted
  xrayMagFactor: number;
  // Cast transverse/occlusal measurements in mixed dentition
  intercanineU: number;
  intercanineL: number;
  intermolarU: number;
  intermolarL: number;
  overjet: number;
  overbite: number;
}

export function computeMixedDentitionSuite(inp: MixedDentitionInputs) {
  const sumUpperIncisors = Number((inp.w12 + inp.w11 + inp.w21 + inp.w22).toFixed(1));
  const sumLowerIncisors = Number((inp.w42 + inp.w41 + inp.w31 + inp.w32).toFixed(1));
  const lowerRightInc = Number((inp.w42 + inp.w41).toFixed(1));
  const lowerLeftInc = Number((inp.w31 + inp.w32).toFixed(1));

  // 0. Effective Space Available per quadrant & full arch
  const derivedPostU = Number(Math.max(0, (inp.archPerimeterU - sumUpperIncisors) / 2).toFixed(1));
  const derivedPostL = Number(Math.max(0, (inp.archPerimeterL - sumLowerIncisors) / 2).toFixed(1));
  const effectiveSpaceUR = inp.spaceMode === 'arch_perimeter' ? derivedPostU : inp.spaceUR;
  const effectiveSpaceUL = inp.spaceMode === 'arch_perimeter' ? derivedPostU : inp.spaceUL;
  const effectiveSpaceLR = inp.spaceMode === 'arch_perimeter' ? derivedPostL : inp.spaceLR;
  const effectiveSpaceLL = inp.spaceMode === 'arch_perimeter' ? derivedPostL : inp.spaceLL;

  const totalSpaceAvailUpper =
    inp.spaceMode === 'arch_perimeter'
      ? Number(inp.archPerimeterU.toFixed(1))
      : Number((sumUpperIncisors + effectiveSpaceUR + effectiveSpaceUL).toFixed(1));
  const totalSpaceAvailLower =
    inp.spaceMode === 'arch_perimeter'
      ? Number(inp.archPerimeterL.toFixed(1))
      : Number((sumLowerIncisors + effectiveSpaceLR + effectiveSpaceLL).toFixed(1));
  const totalPostSpaceUpper = Number((effectiveSpaceUR + effectiveSpaceUL).toFixed(1));
  const totalPostSpaceLower = Number((effectiveSpaceLR + effectiveSpaceLL).toFixed(1));

  // Predicted Unerupted Canine (3) from Sum of Lower 4 Permanent Incisors (sex & arch adjusted)
  const predictedCanineU = Number(
    (inp.sex === 'male' ? 0.26 * sumLowerIncisors + 1.9 : 0.25 * sumLowerIncisors + 1.8).toFixed(1),
  );
  const predictedCanineL = Number(
    (inp.sex === 'male' ? 0.25 * sumLowerIncisors + 1.2 : 0.24 * sumLowerIncisors + 1.1).toFixed(1),
  );

  // 1. Moyers Probability Prediction (per quadrant)
  const moyersUpperQuad = interpolateMoyers(sumLowerIncisors, inp.sex, 'upper', inp.moyersConfidence);
  const moyersLowerQuad = interpolateMoyers(sumLowerIncisors, inp.sex, 'lower', inp.moyersConfidence);
  const moyersDiscUR = Number((effectiveSpaceUR - moyersUpperQuad).toFixed(1));
  const moyersDiscUL = Number((effectiveSpaceUL - moyersUpperQuad).toFixed(1));
  const moyersDiscLR = Number((effectiveSpaceLR - moyersLowerQuad).toFixed(1));
  const moyersDiscLL = Number((effectiveSpaceLL - moyersLowerQuad).toFixed(1));
  const moyersTotalUpperDisc = Number((moyersDiscUR + moyersDiscUL).toFixed(1));
  const moyersTotalLowerDisc = Number((moyersDiscLR + moyersDiscLL).toFixed(1));

  // 2. Tanaka & Johnston (1974) Prediction (per quadrant)
  const tjUpperQuad = Number((sumLowerIncisors / 2 + 11.0).toFixed(1));
  const tjLowerQuad = Number((sumLowerIncisors / 2 + 10.5).toFixed(1));
  const tjDiscUR = Number((effectiveSpaceUR - tjUpperQuad).toFixed(1));
  const tjDiscUL = Number((effectiveSpaceUL - tjUpperQuad).toFixed(1));
  const tjDiscLR = Number((effectiveSpaceLR - tjLowerQuad).toFixed(1));
  const tjDiscLL = Number((effectiveSpaceLL - tjLowerQuad).toFixed(1));
  const tjTotalUpperDisc = Number((tjDiscUR + tjDiscUL).toFixed(1));
  const tjTotalLowerDisc = Number((tjDiscLR + tjDiscLL).toFixed(1));

  // 3A. Nance Mixed Dentition Radiographic Method (1947): raw X-ray width (3+4+5) vs available space
  const nanceRadPredUR = Number(((inp.canineSource === 'predicted' ? predictedCanineU : inp.xrayCanineUR) + inp.xrayPmUR).toFixed(1));
  const nanceRadPredUL = Number(((inp.canineSource === 'predicted' ? predictedCanineU : inp.xrayCanineUL) + inp.xrayPmUL).toFixed(1));
  const nanceRadPredLR = Number(((inp.canineSource === 'predicted' ? predictedCanineL : inp.xrayCanineLR) + inp.xrayPmLR).toFixed(1));
  const nanceRadPredLL = Number(((inp.canineSource === 'predicted' ? predictedCanineL : inp.xrayCanineLL) + inp.xrayPmLL).toFixed(1));
  const nanceRadDiscUR = Number((effectiveSpaceUR - nanceRadPredUR).toFixed(1));
  const nanceRadDiscUL = Number((effectiveSpaceUL - nanceRadPredUL).toFixed(1));
  const nanceRadDiscLR = Number((effectiveSpaceLR - nanceRadPredLR).toFixed(1));
  const nanceRadDiscLL = Number((effectiveSpaceLL - nanceRadPredLL).toFixed(1));
  const nanceRadTotalUpperDisc = Number((nanceRadDiscUR + nanceRadDiscUL).toFixed(1));
  const nanceRadTotalLowerDisc = Number((nanceRadDiscLR + nanceRadDiscLL).toFixed(1));

  // 3B. Huckaba (1964) Magnification-Corrected Radiographic Method: Y1 = (X1 * Y2) / X2
  const fallbackMag = inp.xrayMagFactor > 0 ? inp.xrayMagFactor : 1;
  const calcHuckabaMag = (mTrue: number, mXray: number) =>
    mTrue > 0 && mXray > 0 ? Number((mTrue / mXray).toFixed(3)) : fallbackMag;

  const huckabaMagUR = calcHuckabaMag(inp.castRefToothUR, inp.xrayRefToothUR);
  const huckabaMagUL = calcHuckabaMag(inp.castRefToothUL, inp.xrayRefToothUL);
  const huckabaMagLR = calcHuckabaMag(inp.castRefToothLR, inp.xrayRefToothLR);
  const huckabaMagLL = calcHuckabaMag(inp.castRefToothLL, inp.xrayRefToothLL);

  const huckabaTrueCanineUR = Number((inp.xrayCanineUR * huckabaMagUR).toFixed(1));
  const huckabaTrueCanineUL = Number((inp.xrayCanineUL * huckabaMagUL).toFixed(1));
  const huckabaTrueCanineLR = Number((inp.xrayCanineLR * huckabaMagLR).toFixed(1));
  const huckabaTrueCanineLL = Number((inp.xrayCanineLL * huckabaMagLL).toFixed(1));

  const effCanineUR = inp.canineSource === 'predicted' ? predictedCanineU : huckabaTrueCanineUR;
  const effCanineUL = inp.canineSource === 'predicted' ? predictedCanineU : huckabaTrueCanineUL;
  const effCanineLR = inp.canineSource === 'predicted' ? predictedCanineL : huckabaTrueCanineLR;
  const effCanineLL = inp.canineSource === 'predicted' ? predictedCanineL : huckabaTrueCanineLL;

  const corrPmUR = Number((inp.xrayPmUR * huckabaMagUR).toFixed(1));
  const corrPmUL = Number((inp.xrayPmUL * huckabaMagUL).toFixed(1));
  const corrPmLR = Number((inp.xrayPmLR * huckabaMagLR).toFixed(1));
  const corrPmLL = Number((inp.xrayPmLL * huckabaMagLL).toFixed(1));

  const huckabaPredUR = Number((effCanineUR + corrPmUR).toFixed(1));
  const huckabaPredUL = Number((effCanineUL + corrPmUL).toFixed(1));
  const huckabaPredLR = Number((effCanineLR + corrPmLR).toFixed(1));
  const huckabaPredLL = Number((effCanineLL + corrPmLL).toFixed(1));

  const huckabaDiscUR = Number((effectiveSpaceUR - huckabaPredUR).toFixed(1));
  const huckabaDiscUL = Number((effectiveSpaceUL - huckabaPredUL).toFixed(1));
  const huckabaDiscLR = Number((effectiveSpaceLR - huckabaPredLR).toFixed(1));
  const huckabaDiscLL = Number((effectiveSpaceLL - huckabaPredLL).toFixed(1));
  const huckabaTotalUpperDisc = Number((huckabaDiscUR + huckabaDiscUL).toFixed(1));
  const huckabaTotalLowerDisc = Number((huckabaDiscLR + huckabaDiscLL).toFixed(1));

  // 4. Hixon & Oldfather (1958) Original Chart Interpolation (Cast I1+I2 + Radiographic 4+5)
  const hixonPredLR = interpolateHixonOldfather(lowerRightInc + inp.xrayPmLR);
  const hixonPredLL = interpolateHixonOldfather(lowerLeftInc + inp.xrayPmLL);
  const hixonDiscLR = Number((effectiveSpaceLR - hixonPredLR).toFixed(1));
  const hixonDiscLL = Number((effectiveSpaceLL - hixonPredLL).toFixed(1));

  // 5. Staley & Kerber (1980) Revised Hixon-Oldfather Equation: 0.7158 * (I1+I2 + Xray4+5) + 2.1267
  const staleyPredLR = Number((0.7158 * (lowerRightInc + inp.xrayPmLR) + 2.1267).toFixed(1));
  const staleyPredLL = Number((0.7158 * (lowerLeftInc + inp.xrayPmLL) + 2.1267).toFixed(1));
  const staleyDiscLR = Number((effectiveSpaceLR - staleyPredLR).toFixed(1));
  const staleyDiscLL = Number((effectiveSpaceLL - staleyPredLL).toFixed(1));

  // 6. Nance Leeway Space Analysis (Primary c+d+e minus true/predicted 3+4+5)
  const leewayUR = Number((inp.primaryCdeUR - huckabaPredUR).toFixed(1));
  const leewayUL = Number((inp.primaryCdeUL - huckabaPredUL).toFixed(1));
  const leewayLR = Number((inp.primaryCdeLR - huckabaPredLR).toFixed(1));
  const leewayLL = Number((inp.primaryCdeLL - huckabaPredLL).toFixed(1));
  const totalUpperLeeway = Number((leewayUR + leewayUL).toFixed(1));
  const totalLowerLeeway = Number((leewayLR + leewayLL).toFixed(1));

  // 7. Incisor Liability (Permanent 4 incisors minus Primary 4 incisors)
  const upperIncisorLiability = Number((sumUpperIncisors - inp.primaryUpperIncisorsSum).toFixed(1));
  const lowerIncisorLiability = Number((sumLowerIncisors - inp.primaryLowerIncisorsSum).toFixed(1));

  return {
    sumUpperIncisors,
    sumLowerIncisors,
    effectiveSpaceUR,
    effectiveSpaceUL,
    effectiveSpaceLR,
    effectiveSpaceLL,
    totalPostSpaceUpper,
    totalPostSpaceLower,
    totalSpaceAvailUpper,
    totalSpaceAvailLower,
    predictedCanineU,
    predictedCanineL,
    effCanineUR,
    effCanineUL,
    effCanineLR,
    effCanineLL,
    moyersUpperQuad,
    moyersLowerQuad,
    moyersDiscUR,
    moyersDiscUL,
    moyersDiscLR,
    moyersDiscLL,
    moyersTotalUpperDisc,
    moyersTotalLowerDisc,
    tjUpperQuad,
    tjLowerQuad,
    tjDiscUR,
    tjDiscUL,
    tjDiscLR,
    tjDiscLL,
    tjTotalUpperDisc,
    tjTotalLowerDisc,
    nanceRadPredUR,
    nanceRadPredUL,
    nanceRadPredLR,
    nanceRadPredLL,
    nanceRadDiscUR,
    nanceRadDiscUL,
    nanceRadDiscLR,
    nanceRadDiscLL,
    nanceRadTotalUpperDisc,
    nanceRadTotalLowerDisc,
    huckabaMagUR,
    huckabaMagUL,
    huckabaMagLR,
    huckabaMagLL,
    huckabaTrueCanineUR,
    huckabaTrueCanineUL,
    huckabaTrueCanineLR,
    huckabaTrueCanineLL,
    corrPmUR,
    corrPmUL,
    corrPmLR,
    corrPmLL,
    huckabaPredUR,
    huckabaPredUL,
    huckabaPredLR,
    huckabaPredLL,
    huckabaDiscUR,
    huckabaDiscUL,
    huckabaDiscLR,
    huckabaDiscLL,
    huckabaTotalUpperDisc,
    huckabaTotalLowerDisc,
    hixonPredLR,
    hixonPredLL,
    hixonDiscLR,
    hixonDiscLL,
    staleyPredLR,
    staleyPredLL,
    staleyDiscLR,
    staleyDiscLL,
    leewayUR,
    leewayUL,
    leewayLR,
    leewayLL,
    totalUpperLeeway,
    totalLowerLeeway,
    upperIncisorLiability,
    lowerIncisorLiability,
  };
}

/**
 * Computes missing records & clinical completeness checklist for a patient case
 */
export function getCaseCompleteness(c: PatientCase) {
  const missingItems: Array<{ section: string; labelAr: string; labelEn: string }> = [];

  if (!c.chiefComplaintPatientWords?.trim()) {
    missingItems.push({ section: 'intake', labelAr: 'الشكوى الرئيسية بكلمات المريض', labelEn: 'Chief complaint' });
  }
  if (!c.consents.treatmentConsent) {
    missingItems.push({ section: 'intake', labelAr: 'موافقة خطة العلاج غير موقعة', labelEn: 'Treatment consent unsigned' });
  }

  const qFields = [
    { key: 'medicalHistory', ar: 'التاريخ الطبي', en: 'Medical history' },
    { key: 'allergies', ar: 'الحساسية الدوائية', en: 'Allergies' },
    { key: 'medications', ar: 'الأدوية الحالية', en: 'Medications' },
  ] as const;

  for (const f of qFields) {
    if (c.questionnaire[f.key].status === 'unrecorded') {
      missingItems.push({ section: 'questionnaire', labelAr: `${f.ar} (غير مسجل)`, labelEn: `${f.en} (Unrecorded)` });
    }
  }

  if (c.clinicalExam.extraoral.profile.status === 'not_examined') {
    missingItems.push({ section: 'exam', labelAr: 'تقييم البروفايل خارج الفم', labelEn: 'Extraoral profile exam' });
  }
  if (c.clinicalExam.intraoral.overjetMm.status === 'not_examined') {
    missingItems.push({ section: 'exam', labelAr: 'قياس Overjet داخل الفم', labelEn: 'Intraoral Overjet' });
  }

  const t0Views = new Set(c.media.filter((m) => m.stage === 'T0').map((m) => m.viewType));
  const missingT0Views = REQUIRED_T0_VIEWS.filter((v) => !t0Views.has(v.key));
  for (const mv of missingT0Views) {
    missingItems.push({ section: 'media', labelAr: `سجل T0 ناقص: ${mv.ar}`, labelEn: `Missing T0 record: ${mv.en}` });
  }

  if (c.analyses.length === 0) {
    missingItems.push({ section: 'analysis', labelAr: 'لا يوجد تحليل قياسات محفوظ', labelEn: 'No saved measurements analysis' });
  }
  if (c.problems.length === 0) {
    missingItems.push({ section: 'diagnosis', labelAr: 'قائمة المشكلات فارغة', labelEn: 'Empty problem list' });
  }

  return {
    missingItems,
    missingT0Views,
    missingCount: missingItems.length,
    t0CapturedCount: REQUIRED_T0_VIEWS.length - missingT0Views.length,
    t0TotalCount: REQUIRED_T0_VIEWS.length,
  };
}
