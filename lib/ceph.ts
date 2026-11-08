/**
 * السيفالومتري — المنطق الخالص.
 *
 * تحليل الرأس القياسي هو رياضياتٌ على نقاطٍ معلومة: معالم تُوضَع على الشععة،
 * وقياسات تُحسَب منها بزوايا ومسافات. والوحدة كلها منطقٌ خالص بلا قاعدة ولا شبكة
 * — تُختبر بالأرقام المركَّبة حرفيًا، وتُستدعى من الخادم للاعتماد ومن الشاشة
 * للعرض الحي، فلا يحصل أن يظهر على الشاشة رقمٌ والقاعدة تسجّل غيره.
 *
 * **القاعدة الدستورية (ZONE_B): الذكاء الاصطناعي يقترح ولا يعتمد.** لذلك كل معلم
 * يحمل مصدره: `manual` وضعه الطبيب بيدِه، أو `suggested` اقترحه الحاسوب. والاقتراح
 * لا يصير قياسًا إلا حين يُؤكِّده الطبيب — والاعتماد النهائي للتحليل كله عملُ
 * الطبيب وحده في `completeCephAnalysis`.
 *
 * **التعريفات.** القياسات هي التعريفات الكلاسيكية المنشورة في أدبيات التقويم
 * التخصصي (Steiner، Tweed، Jarabak وغيرها) — معرفةٌ طبية عامة قديمة. وكل تعريف
 * هنا موثَّق بمتجهاته حرفيًا حتى يعرف من يقرأ الكود بعد سنةٍ أيّ زاويةٍ حُسِبت
 * ومن أيّ طرف. أما «المعدلات» فوسائلُ عيّناتٍ من مصادر مختلفة — ليست نظامًا
 * هندسيًا واحدًا يُشتقّ بعضها من بعض — فتُعرض للطبيب **مرجعًا** لا حكمًا.
 *
 * **نظام الإحداثيات:** إحداثيات الشاشة كما هي — x يتزايد نحو الأمام (الصورة
 * تواجه اليمين، العرفُ القياسي)، وy يتزايد نحو الأسفل. للحسابات الموقَّعة يُحدَّد
 * اتجاه الإطار التشريحي من S→N (خلفي إلى أمامي) وN→Me (نحو الأسفل تشريحيًا).
 * لذلك يبقى المعنى بعد تدوير الصورة أو عكسها. إطار ناقص أو منعدم الاتجاه
 * يجعل القياسات الموقَّعة غير متاحة، ولا يُخمَّن الاتجاه من موضع A أو B.
 */

/* ─────────────────────────── النقاط والهندسة ─────────────────────────── */

export interface Pt {
  x: number;
  y: number;
}

/** Finite image-space coordinates; invalid geometry never becomes a measured zero. */
export function isFiniteCephPoint(point: Pt | null | undefined): point is Pt {
  return point != null && Number.isFinite(point.x) && Number.isFinite(point.y);
}

/** طول المتجه. الصفر مسافة صحيحة، لكنه لا يُعرِّف اتجاه خط. */
export function dist(a: Pt, b: Pt): number {
  if (!isFiniteCephPoint(a) || !isFiniteCephPoint(b)) return NaN;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  return Number.isFinite(length) ? length : NaN;
}

/** Normalize before products, avoiding overflow/underflow in cross/dot products. */
function unitVector(vector: Pt): Pt | null {
  if (!isFiniteCephPoint(vector)) return null;
  const length = Math.hypot(vector.x, vector.y);
  if (!Number.isFinite(length) || length === 0) return null;
  return { x: vector.x / length, y: vector.y / length };
}

/** Raw directed screen angle, -180..180. Anatomical signed uses also need handedness. */
function signedAngleBetween(v1: Pt, v2: Pt): number {
  const a = unitVector(v1);
  const b = unitVector(v2);
  if (!a || !b) return NaN;
  return Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y) * 180 / Math.PI;
}

/** الزاوية بين متجهين بالدرجات — ٠ إلى ١٨٠، ثابتة تحت الدوران والانعكاس. */
export function angleBetween(v1: Pt, v2: Pt): number {
  return Math.abs(signedAngleBetween(v1, v2));
}

/** الزاوية عند رأسٍ بين شعاعين إليه — تعريف الزوايا عند نقطة N وA وB. */
export function angleAtVertex(vertex: Pt, p1: Pt, p2: Pt): number {
  return angleBetween(vec(vertex, p1), vec(vertex, p2));
}

/** متجه من a إلى b. */
export function vec(a: Pt, b: Pt): Pt {
  return { x: b.x - a.x, y: b.y - a.y };
}

/**
 * المسافة العمودية الموقَّعة من نقطة إلى خطّ (a→b).
 *
 * الإشارة بموجبها «نحو الأمام» — الوجه يمين الصورة فالأمام شرقًا (+x). والقاعدة
 * ثابتة لا شرطية: للمستقيم الموجَّه (dx,dy) على الشاشة، يكون الجانب الأمامي هو
 * الجانب الذي تُعطي `(dx·vy − dy·vx)` عنده قيمةً سالبة، فيُقلَب الموجب صراحةً
 * — والاختبارات تثبت ذلك بحالةٍ تركيبية معلومة.
 */
export function lateralOffset(p: Pt, a: Pt, b: Pt): number {
  if (!isFiniteCephPoint(p) || !isFiniteCephPoint(a) || !isFiniteCephPoint(b)) return NaN;
  const direction = unitVector(vec(a, b));
  if (!direction) return NaN;
  const offset = vec(a, p);
  const result = direction.y * offset.x - direction.x * offset.y;
  return Number.isFinite(result) ? result : NaN;
}

/** مسافة عمودية غير موقَّعة من نقطة إلى خطّ. */
export function perpDistance(p: Pt, a: Pt, b: Pt): number {
  return Math.abs(lateralOffset(p, a, b));
}

/** إسقاط نقطة على خطّ (a→b) — قدمُ العمود. */
export function projectOnLine(p: Pt, a: Pt, b: Pt): Pt {
  const invalid = { x: NaN, y: NaN };
  if (!isFiniteCephPoint(p) || !isFiniteCephPoint(a) || !isFiniteCephPoint(b)) return invalid;
  const direction = unitVector(vec(a, b));
  if (!direction) return invalid;
  const offset = vec(a, p);
  const along = offset.x * direction.x + offset.y * direction.y;
  const result = { x: a.x + along * direction.x, y: a.y + along * direction.y };
  return isFiniteCephPoint(result) ? result : invalid;
}

/** تقريب إلى منزلة عشرية واحدة — عرضُ القياسات كلها. */
export function round1(value: number): number {
  return Number.isFinite(value) && Math.abs(value) <= Number.MAX_VALUE / 10
    ? Math.round(value * 10) / 10 : value;
}

/* ─────────────────────────── المعالم ─────────────────────────── */

/** رموز المعالم — قائمة مغلقة: كل معلم له اسم وموضع تشريحي معلوم. */
export type LandmarkCode =
  | "S" | "N" | "A" | "B" | "Pog" | "Me" | "Gn" | "Go"
  | "Or" | "Po" | "U1A" | "U1" | "L1A" | "L1" | "OcclA" | "OcclP"
  | "D" | "Co" | "ANS" | "PNS"
  | "Prn" | "Sn" | "Ls" | "Li" | "PogS"
  | "Ar" | "Ba";

export interface LandmarkDef {
  code: LandmarkCode;
  /** الاسم العربي المعتمد في العرض. */
  ar: string;
  /** الرمز اللاتيني كما في الأدبيات. */
  en: string;
  /** دليل الوضع: أين تُوضَع النقطة على الشععة. */
  hint: string;
  /** الترتيب المقترح للوضع — القياسات تكتمل مبكرًا فيتتبع الطبيب أثرها حيًّا. */
  order: number;
  /** إلزامي للاعتماد أم اختياري (تستهلبه تحاليل بعينها). */
  required: boolean;
}

/**
 * سجل المعالم السبعة والعشرين.
 *
 * الوصف التشريحي لكل معلم هو الوصف القياسي المعروف — والغاية أن يقف الطبيب على
 * النقطة الصحيحة من الكلمة لا من الحفظ. الستة عشر الأولى إلزامية للاعتماد؛
 * والإضافية (D، Co، ANS، PNS، معالم الأنسجة الرخوة والبروفايل Prn، Sn، Ls، Li، PogS،
 * ومعلم المفصل Ar لمضلع بيورك، وBa لقاعدة الجمجمة) تخدم تحاليل بعينها فتوضع عند
 * الحاجة دون أن تحجب اعتماد التحليل الأساسي.
 */
export const LANDMARKS: LandmarkDef[] = [
  { code: "S", ar: "السرجة", en: "Sella", hint: "مركز حفرة السرج — أعمق نقطة فيها", order: 1, required: true },
  { code: "N", ar: "الأنفية", en: "Nasion", hint: "أخفض نقطة عند مفصل العظم الجبهي مع العظمين الأنفيين", order: 2, required: true },
  { code: "Or", ar: "الحجاجية", en: "Orbitale", hint: "أخفض نقطة على الحافة السفلية لمدار العين", order: 3, required: true },
  { code: "Po", ar: "الأذنية", en: "Porion", hint: "أعلى نقطة على حافة القناة السمعية الخارجية", order: 4, required: true },
  { code: "A", ar: "النقطة A", en: "Point A", hint: "أعمق نقطة على contour الفك الأعلى تحت الشوكة الأنفية", order: 5, required: true },
  { code: "B", ar: "النقطة B", en: "Point B", hint: "أعمق نقطة على contour الفك الأسفل فوق الذقن", order: 6, required: true },
  { code: "Pog", ar: "الذقنية", en: "Pogonion", hint: "أكثر نقطة أمامية في عظم الذقن", order: 7, required: true },
  { code: "Me", ar: "الذقنية السفلى", en: "Menton", hint: "أخفض نقطة في عظم الذقن", order: 8, required: true },
  { code: "Gn", ar: "الذقنية الوسطى", en: "Gnathion", hint: "منتصف القوس بين الذقنية والذقنية السفلى", order: 9, required: true },
  { code: "Go", ar: "الزّاوية", en: "Gonion", hint: "منتصف قوس زاوية الفك السفلي", order: 10, required: true },
  { code: "U1A", ar: "قمة جذّ السنّ العلوي", en: "Upper incisor apex", hint: "طرف الجذر الشفوي للقاطع العلوي المركزي", order: 11, required: true },
  { code: "U1", ar: "حافة القاطع العلوي", en: "Upper incisor edge", hint: "الحافة القاطعة للقاطع العلوي المركزي", order: 12, required: true },
  { code: "L1A", ar: "قمة جذّ السنّ السفلي", en: "Lower incisor apex", hint: "طرف الجذر الشفوي للقاطع السفلي المركزي", order: 13, required: true },
  { code: "L1", ar: "حافة القاطع السفلي", en: "Lower incisor edge", hint: "الحافة القاطعة للقاطع السفلي المركزي", order: 14, required: true },
  { code: "OcclA", ar: "الإطباقية الأمامية", en: "Anterior occlusal", hint: "نقطة على مستوى الإطباق بين القواطع — بين حافتي القاطعين", order: 15, required: true },
  { code: "OcclP", ar: "الإطباقية الخلفية", en: "Posterior occlusal", hint: "نقطة على مستوى الإطباق خلفًا عند طواحين الجانب المرسوم", order: 16, required: true },
  { code: "D", ar: "نقطة D — وسط الارتفاق", en: "Symphysis midpoint (D)", hint: "مركز ارتفاق الذقن — نقطة Steiner لقياس SND", order: 17, required: false },
  { code: "Co", ar: "رأس اللقمة", en: "Condylion", hint: "أعلى-أخلف نقطة في رأس اللقمة الفكية", order: 18, required: false },
  { code: "ANS", ar: "الشوكة الأنفية الأمامية", en: "Anterior Nasal Spine", hint: "طرف الشوكة الأنفية الأمامية — الحد الأمامي للحآنك العظمي", order: 19, required: false },
  { code: "PNS", ar: "الشوكة الأنفية الخلفية", en: "Posterior Nasal Spine", hint: "الحد الخلفي للحآنك العظمي — لاستواء الحنكي", order: 20, required: false },
  { code: "Prn", ar: "قمة الأنف — Pronasale", en: "Pronasale", hint: "أبرز نقطة أمامية على ذروة الأنف (القمة الأنفية)", order: 21, required: false },
  { code: "Sn", ar: "تحت الأنف — Subnasale", en: "Subnasale", hint: "نقطة التقاء الحافة السفلية للحاجز الأنفي مع الشفة العليا", order: 22, required: false },
  { code: "Ls", ar: "الشفة العليا — Labrale superius", en: "Labrale superius", hint: "أبرز نقطة أمامية على الحد القرمزي للشفة العليا", order: 23, required: false },
  { code: "Li", ar: "الشفة السفلى — Labrale inferius", en: "Labrale inferius", hint: "أبرز نقطة أمامية على الحد القرمزي للشفة السفلى", order: 24, required: false },
  { code: "PogS", ar: "الذقن الرخو — Soft tissue pogonion", en: "Soft tissue pogonion", hint: "أكثر نقطة أمامية على نسيج الذقن الرخو", order: 25, required: false },
  { code: "Ar", ar: "الارتكاز المفصلي — Articulare", en: "Articulare", hint: "نقطة تقاطع الحافة الخلفية لعنق اللقمة الفكية مع قاعدة الجمجمة لمضلع بيورك", order: 26, required: false },
  { code: "Ba", ar: "القاعدية — Basion", en: "Basion", hint: "أخفض نقطة على الحافة الأمامية للثقبة العظمى (Foramen Magnum)", order: 27, required: false },
];

export const LANDMARK_ORDER: LandmarkCode[] =
  [...LANDMARKS].sort((a, b) => a.order - b.order).map((l) => l.code);

const LANDMARK_SET: ReadonlySet<string> = new Set(LANDMARKS.map((l) => l.code));

export function isCephLandmarkCode(value: unknown): value is LandmarkCode {
  return typeof value === "string" && LANDMARK_SET.has(value);
}

export function landmarkDef(code: LandmarkCode): LandmarkDef {
  return LANDMARKS.find((l) => l.code === code) as LandmarkDef;
}

/** المعالم التي لا يُعتمد تحليلٌ بدونها — منشِقّة من خاصية الإلزام في التعريفات نفسها. */
export const REQUIRED_LANDMARKS: LandmarkCode[] =
  LANDMARKS.filter((l) => l.required).map((l) => l.code);

/** المعالم الاختيارية — تخدم تحاليل موسّعة ولا تحجب اعتماد الأساس. */
export const OPTIONAL_LANDMARKS: LandmarkCode[] =
  LANDMARKS.filter((l) => !l.required).map((l) => l.code);

/* ─────────────────────────── المعايرة ─────────────────────────── */

/**
 * المقياس: مليمتر لكل بكسل.
 *
 * نقطتان معلومة المسافة الحقيقية على الشععة (كرة معايرة أو مسطرة مدمجة) تحسمان
 * العلاقة بين بكسل الصورة والعالم الحقيقي. وكل قياسٍ طُوليّ يمرّ بها — والزوايا
 * لا تحتاجها (نسبةٌ بين أطوال لا تتأثر بالتكبير).
 */
export function computeMmPerPixel(p1: Pt, p2: Pt, realMm: number): number {
  if (!Number.isFinite(realMm) || realMm <= 0) return NaN;
  const pixels = dist(p1, p2);
  if (!Number.isFinite(pixels) || pixels <= 0) return NaN;
  const scale = realMm / pixels;
  return Number.isFinite(scale) && scale > 0 ? scale : NaN;
}

/** تحويل طولٍ بالبكسل إلى مليمتر بمقياس معلوم.
 *
 * بلا مقياس (أو بمقياسٍ تالف) تعيد NaN لا صفرًا: صفرٌ مقنع أخطر من «—»،
 * فهو رقمٌ يُقرأ ويُعتمد ولم يُقس أصلًا.
 */
export function pixelsToMm(pixels: number, mmPerPixel: number): number {
  if (!Number.isFinite(mmPerPixel) || mmPerPixel <= 0 || !Number.isFinite(pixels)) return NaN;
  const result = pixels * mmPerPixel;
  if (!Number.isFinite(result) || (pixels !== 0 && result === 0)) return NaN;
  return result;
}

/* ─────────────────────────── القياسات ومدارس التحليل ─────────────────────────── */

export type MeasurementGroup = "sagittal" | "vertical" | "dental" | "softTissue";

export const GROUP_LABEL: Record<MeasurementGroup, string> = {
  sagittal: "الهيكلي — أفقي",
  vertical: "الهيكلي — عمودي",
  dental: "الأسنان",
  softTissue: "الأنسجة الرخوة والبروفايل",
};

/** مدارس وتحليلات كبار علماء التقويم الكلاسيكية المعتمدة (توازي WebCeph). */
export type CephSchool =
  | "all"
  | "webceph"
  | "steiner"
  | "tweed"
  | "downs"
  | "mcnamara"
  | "ricketts"
  | "jarabak"
  | "kim"
  | "wits"
  | "softTissue";

export interface CephSchoolDef {
  id: CephSchool;
  nameAr: string;
  nameEn: string;
  author: string;
  descAr: string;
}

export const CEPH_SCHOOLS: CephSchoolDef[] = [
  { id: "all", nameAr: "الكل", nameEn: "All Analyses", author: "الجميع", descAr: "عرض كافة القياسات السيفالومترية الـ 49 لجميع المدارس" },
  { id: "webceph", nameAr: "ويب سيف الشامل", nameEn: "WebCeph Comprehensive", author: "WebCeph / AssembleCircle", descAr: "التحليل القياسي الشامل لبرنامج WebCeph متضمناً مؤشرات كيم ومضلع بيورك والبروفايل ومؤشر القلع" },
  { id: "steiner", nameAr: "شتاينر", nameEn: "Steiner Analysis", author: "Cecil C. Steiner (1953)", descAr: "تحليل شتاينر الكلاسيكي للعلاقات الهيكلية السهمية وميل القواطع بالنسبة لقاعدة الجمجمة SN" },
  { id: "tweed", nameAr: "تويد", nameEn: "Tweed Triangle", author: "Charles H. Tweed (1946)", descAr: "مثلث تويد التشخيصي الشهير (FMA + FMIA + IMPA = 180°) لتحديد وضع القاطع السفلي واستقرار الإطباق" },
  { id: "downs", nameAr: "داونز", nameEn: "Downs Analysis", author: "William B. Downs (1948)", descAr: "تحليل داونز لتقييم النمط الهيكلي وتحدب الوجه ومستويات فرانكفورت والإطباق وميل AB" },
  { id: "mcnamara", nameAr: "مكنمارا", nameEn: "McNamara Analysis", author: "James A. McNamara (1984)", descAr: "تحليل مكنمارا للأبعاد الهيكلية الحقيقية للفكين Co-A و Co-Gn والارتفاع الوجهي السفلي وعمود نازيون" },
  { id: "ricketts", nameAr: "ريكتس", nameEn: "Ricketts Analysis", author: "Robert M. Ricketts (1960)", descAr: "تحليل ريكتس للبروفايل الجمالي E-Line ومحور الوجه وموضع القاطع العلوي A-Pog" },
  { id: "jarabak", nameAr: "جاراك وبيورك", nameEn: "Jarabak & Bjork", author: "Joseph R. Jarabak & Arne Bjork", descAr: "مضلع بيورك الثلاثي (Bjork Polygon Sum) ونسبة جاراك لتحديد اتجاه دوران نمو الفك السفلي" },
  { id: "kim", nameAr: "كيم (Kim Indicators)", nameEn: "Kim Analysis (APDI & ODI)", author: "Young H. Kim (1978)", descAr: "مؤشرات كيم لتشخيص العضة المفتوحة والعميقة وعلاقة الفكين السهمية (APDI و ODI وعامل الدمج CF ومؤشر القلع)" },
  { id: "wits", nameAr: "ويتس", nameEn: "Wits Appraisal", author: "Alex Jacobson (1975)", descAr: "تقييم ويتس السهمي لعلاقة الفكين المسقطة عمودياً على مستوى الإطباق الوظيفي" },
  { id: "softTissue", nameAr: "الأنسجة الرخوة والبروفايل", nameEn: "Soft Tissue & Esthetics", author: "Holdaway / Ricketts / Burstone", descAr: "التحليل الجمالي للأنسجة الرخوة والزاوية الأنفية الشفوية وبروز الشفاه بالنسبة لخط ريكتس" },
];

/** Persisted versioned code: unsupported historical EXT_INDEX is never relabeled. */
export const EI_KIM_1996_CODE = "EI_KIM_1996";
export const L1_APOG_CODE = "L1_APOG";
export const L1_APOG_ANGLE_CODE = "L1_APOG_ANGLE";
export const U1_PP_CODE = "U1_PP";
export const PALATAL_ANS_PNS_CODE = "PALATAL_ANS_PNS";
export const AFH_N_ME_CODE = "AFH_N_ME";
export const LAFH_ANS_ME_CODE = "LAFH_ANS_ME";
export const isDescriptiveCephMeasurement = (code: string): boolean => code === EI_KIM_1996_CODE || code === L1_APOG_CODE || code === AFH_N_ME_CODE || code === LAFH_ANS_ME_CODE || code === PALATAL_ANS_PNS_CODE || code === U1_PP_CODE || code === L1_APOG_ANGLE_CODE;

/** Published cohort description, not patient-specific norms or treatment cutoffs. */
export interface CephPopulationReference {
  mean: number;
  sd: number;
  sampleSize: number;
  ageMin: number;
  ageMax: number;
  meanAge: number;
  boys: number;
  girls: number;
  population: string;
}

export interface CephCalculationMetadata {
  descriptiveOnly?: boolean;
  requiresCalibration?: boolean;
  calculationVersion?: string;
  sourceUrl?: string;
  populationReference?: CephPopulationReference;
}

export interface MeasurementDef extends CephCalculationMetadata {
  code: string;
  ar: string;
  /** الاسم الإنجليزي المعتمد في الأدبيات — للتقرير ثنائي اللغة. */
  en: string;
  group: MeasurementGroup;
  /** المدارس التي ينتمي إليها القياس لفرز التبويبات بنقرة واحدة كما في WebCeph. */
  schools: CephSchool[];
  unit: "°" | "mm" | "%" | "";
  /** المعالم اللازمة لهذا القياس وحده. */
  needs: LandmarkCode[];
  /**
   * المعدل المرجعي من الأدبيات — وسيلةُ عيّناتٍ تُعرض للطبيب مرجعًا لا حكمًا.
   * `mean` و`tol` يحصران المدى المتعارف: [mean−tol, mean+tol].
   */
  mean: number | null;
  tol: number | null;
  /** كيف وُجد المعدل — يُعرض تحت الجدول بندرةِ المصدر. */
  source: string;
  /** تفسير اتجاه القيمة — يُعرض عند المزاج لمن يحتاجه. */
  note?: string;
}

/**
 * القياسات السيفالومترية التسعة والأربعون (مطابقة ومعززة عن معايير WebCeph العالمية).
 *
 * كل تعريف تحته متجهاته حرفيًا. الرموز بأسمائها المتعارفة، والمجموعات أربعة:
 * أفقي هيكلي، وعمودي هيكلي، وأسنان، وأنسجة رخوة وبروفايل جمالي. والمعدلات
 * هنا هي الافتراضية المدمجة — والنظام المرجعي في القاعدة (ceph_reference_sets)
 * يقبل مجموعات محلية أغنى (بالعمر والجنس والانحراف المعياري) تعرض بدلها حين تُختار للدراسة.
 */
export const MEASUREMENTS: MeasurementDef[] = [
  { code: "SNA", ar: "SNA — موضع الفك الأعلى", en: "SNA", group: "sagittal", schools: ["steiner", "webceph"], unit: "°", needs: ["S", "N", "A"], mean: 82, tol: 2, source: "Steiner / WebCeph", note: "الأعلى: الفك الأعلى أكثر تقدمًا أو N خلفيّ الموضع" },
  { code: "SNB", ar: "SNB — موضع الفك الأسفل", en: "SNB", group: "sagittal", schools: ["steiner", "webceph"], unit: "°", needs: ["S", "N", "B"], mean: 80, tol: 2, source: "Steiner / WebCeph", note: "الأعلى: الفك الأسفل أكثر تقدمًا؛ الأدنى: تراجعٌ عن SN" },
  { code: "ANB", ar: "ANB — العلاقة الفكية", en: "ANB", group: "sagittal", schools: ["steiner", "webceph"], unit: "°", needs: ["S", "N", "A", "B"], mean: 2, tol: 2, source: "Steiner / WebCeph", note: "فوق المدى: نحو الصنف الثاني؛ تحت الصفر: نحو الثالث" },
  { code: "SND", ar: "SND — موضع وسط الارتفاق", en: "S-N-D", group: "sagittal", schools: ["steiner"], unit: "°", needs: ["S", "N", "D"], mean: 77, tol: 2, source: "Steiner", note: "يقرأ موضع وسط الذقن دون تأثير قمة الارتفاق" },
  { code: "WITS", ar: "WITS — علاقة الفكّين على الإطباقية", en: "Wits appraisal", group: "sagittal", schools: ["wits", "webceph"], unit: "mm", needs: ["A", "B", "OcclA", "OcclP"], mean: -1, tol: 1, source: "Jacobson / WebCeph", note: "الأعلى نحو الصنف الثاني — والمنشور (Jacobson): −١ للذكور و٠ للإناث؛ ويتأثر بميل مستوى الإطباق" },
  { code: "CONV", ar: "التحدّب — A على خط N-Pog", en: "Convexity (A to N-Pog)", group: "sagittal", schools: ["downs"], unit: "mm", needs: ["A", "N", "Pog", "S", "Me"], mean: 0, tol: 2, source: "Downs", note: "الأمام موجب — أمام الخط نحو الصنف الثاني (بروفايل محدب)؛ وخلفه نحو الثالث" },
  { code: "CONV_ANGLE", ar: "زاوية التحدّب N-A-Pog", en: "Angle of convexity", group: "sagittal", schools: ["downs"], unit: "°", needs: ["N", "A", "Pog", "S", "Me"], mean: 0, tol: 5.1, source: "Downs", note: "موقَّعة كما نشرها Downs: موجب بروفايل محدب (نحو الصنف الثاني) وسالب مقعّد (نحو الثالث) — والمدى المنشور −8.5 إلى +10" },
  { code: "AB_PLANE", ar: "زاوية مستوى A-B مع الخط الوجهي", en: "A-B plane angle", group: "sagittal", schools: ["downs"], unit: "°", needs: ["N", "Pog", "A", "B", "S", "Me"], mean: -4.6, tol: 3.9, source: "Downs", note: "موقَّعة كما نشرها Downs: سالب نحو الصنف الثاني (ارتداد B عن A) وموجب نحو الثالث" },
  { code: "FH_AB", ar: "FH مع مستوى AB (داونز/كيم)", en: "FH to AB (posterior angle)", group: "sagittal", schools: ["downs", "kim", "webceph"], unit: "°", needs: ["Or", "Po", "A", "B"], mean: 81, tol: 3, source: "Downs / Kim / WebCeph", note: "الزاوية بين مستوى فرانكفورت ومستقيم AB (المعدل 81°±3°): >84° صنف ثالث، <78° صنف ثانٍ" },
  { code: "APDI", ar: "مؤشر خلل الفكين السهمي APDI", en: "APDI", group: "sagittal", schools: ["kim", "webceph"], unit: "°", needs: ["A", "B", "ANS", "PNS"], mean: 85.98, tol: 4.0, source: "Kim / WebCeph", note: "مؤشر كيم السهمي (85.98°±4°): >90° صنف ثالث هيكلي، <82° صنف ثانٍ هيكلي" },
  { code: "FANGLE", ar: "الزاوية الوجهية FH-NPog", en: "Facial angle", group: "sagittal", schools: ["downs"], unit: "°", needs: ["N", "Pog", "Or", "Po"], mean: 87.8, tol: 3.6, source: "Downs", note: "الأعلى: ذقنٌ أكثر تقدمًا" },
  { code: "MAX_LEN", ar: "الطول الفعلي للفك الأعلى Co-A", en: "Effective maxillary length", group: "sagittal", schools: ["mcnamara"], unit: "mm", needs: ["Co", "A"], mean: 94, tol: 5, source: "McNamara 1984", note: "McNamara ١٩٨٤: البالغة ≈٩٤ مم والذكر أعلى — تُحسّن بمجموعة مرجعية بالعمر والجنس" },
  { code: "MAND_LEN", ar: "الطول الفعلي للفك الأسفل Co-Gn", en: "Effective mandibular length", group: "sagittal", schools: ["mcnamara"], unit: "mm", needs: ["Co", "Gn"], mean: 122, tol: 5, source: "McNamara 1984", note: "McNamara ١٩٨٤: ١٢٠–١٢٣ مم للبالغة مع Co-A ≈٩٤" },
  { code: "MM_DIFF", ar: "الفرق الفعلي بين الفكّين", en: "Maxillomandibular differential", group: "sagittal", schools: ["mcnamara"], unit: "mm", needs: ["Co", "A", "Gn"], mean: 28, tol: 4, source: "McNamara 1984", note: "McNamara ١٩٨٤: ٢٦–٢٩ مم للبالغة والذكر أعلى قليلًا — مشتق من القياسين" },
  { code: "A_NPERP", ar: "بُعد A عن عمود N", en: "A to N-perpendicular", group: "sagittal", schools: ["mcnamara", "webceph"], unit: "mm", needs: ["N", "Or", "Po", "A"], mean: 0.5, tol: 0.5, source: "McNamara / WebCeph", note: "الأمام موجب — والمنشور (McNamara): من ٠ إلى +١ مم أمام العمود للبالغين" },
  { code: "POG_NPERP", ar: "بُعد Pog عن عمود N", en: "Pog to N-perpendicular", group: "sagittal", schools: ["mcnamara", "webceph"], unit: "mm", needs: ["N", "Or", "Po", "Pog"], mean: -2, tol: 2, source: "McNamara / WebCeph", note: "الأمام موجب — والمنشور (McNamara): من −٤ إلى ٠ مم خلف العمود للبالغين، والإناث −٤ إلى −٢" },
  { code: "FMA", ar: "FMA — FH مع مستوى الفك السفلي", en: "FMA", group: "vertical", schools: ["tweed", "downs", "webceph"], unit: "°", needs: ["Or", "Po", "Me", "Go"], mean: 25, tol: 3, source: "Tweed / WebCeph", note: "الأعلى: نموٌّ مائل للأفقي؛ الأدنى: للعمقي" },
  { code: "SNGOGN", ar: "SN-GoGn — انحدار الفك", en: "SN-GoGn", group: "vertical", schools: ["steiner", "webceph"], unit: "°", needs: ["S", "N", "Gn", "Go"], mean: 32, tol: 5, source: "Steiner" },
  { code: "JARABAK", ar: "نسبة Jarabak — (S-Go)/(N-Me)", en: "Jarabak ratio", group: "vertical", schools: ["jarabak", "webceph"], unit: "%", needs: ["S", "N", "Me", "Go"], mean: 65, tol: 5, source: "Jarabak", note: "الأدنى من ٦٢: اتجاه عمودي؛ الأعلى من ٦٨: اتجاه أفقي تقريبًا" },
  { code: "SADDLE", ar: "زاوية السرج N-S-Ar", en: "Saddle angle (N-S-Ar)", group: "vertical", schools: ["jarabak", "steiner", "webceph"], unit: "°", needs: ["N", "S", "Ar"], mean: 123, tol: 5, source: "Bjork / Jarabak", note: "زاوية قاعدة الجمجمة الخلفية (123°±5°): الزاوية الكبيرة (>128°) ترجع المفصل الفكي للخلف وتزيد من ميل الصنف الثاني" },
  { code: "ARTICULAR", ar: "زاوية الارتكاز المفصلي S-Ar-Go", en: "Articular angle (S-Ar-Go)", group: "vertical", schools: ["jarabak", "webceph"], unit: "°", needs: ["S", "Ar", "Go"], mean: 143, tol: 6, source: "Bjork / Jarabak", note: "زاوية المفصل الفكي (143°±6°): الأكبر تزيد من الطول العمودي للوجه وتدير الفك للأسفل والخلف" },
  { code: "GONIAL", ar: "زاوية الفك السفلي Ar-Go-Me", en: "Gonial angle", group: "vertical", schools: ["jarabak", "webceph"], unit: "°", needs: ["Ar", "Go", "Me"], mean: 122.38, tol: 4.9, source: "Bjork / Jarabak / WebCeph", note: "زاوية زاوية الفك (122.38°±4.9°): تحدد ميلان جسم ورأد الفك السفلي؛ الزاوية المفتوحة ترتبط بالنمو العمودي وعضة مفتوحة" },
  { code: "BJORK_SUM", ar: "مجموع مضلع بيورك (Bjork Sum)", en: "Bjork sum", group: "vertical", schools: ["jarabak", "webceph"], unit: "°", needs: ["N", "S", "Ar", "Go", "Me"], mean: 393.97, tol: 3.7, source: "Bjork / WebCeph", note: "مجموع زوايا مضلع بيورك الثلاث (393.97°±3.7°): >400° نمو عمودي ودوران الفك مع عقارب الساعة (Clockwise / Open bite)، <390° نمو أفقي ودوران عكس عقارب الساعة (Counter-clockwise / Deep bite)" },
  { code: "AB_MAND", ar: "مستوى AB مع الفك السفلي", en: "A-B to mandibular plane", group: "vertical", schools: ["kim", "webceph"], unit: "°", needs: ["A", "B", "Me", "Go"], mean: 69.3, tol: 2.5, source: "Kim / WebCeph", note: "الزاوية بين مستقيم AB ومستوى الفك السفلي (المعدل 69.3°±2.5°): ركيزة مؤشر كيم لعضة القواطع ODI" },
  { code: "PP_FH", ar: "المستوى الحنكي مع FH", en: "Palatal plane to FH", group: "vertical", schools: ["kim", "downs", "webceph"], unit: "°", needs: ["ANS", "PNS", "Or", "Po", "S", "N", "Me"], mean: 3.0, tol: 2.0, source: "Kim", note: "ميل الحنك الموقَّع بالنسبة إلى FH: موجب حين ينخفض للأمام، وسالب حين يرتفع. يتطلب إطار S-N-Me صالحًا." },
  { code: "ODI", ar: "مؤشر عمق العضة ODI", en: "ODI", group: "vertical", schools: ["kim", "webceph"], unit: "°", needs: ["A", "B", "Me", "Go", "ANS", "PNS", "Or", "Po", "S", "N"], mean: 73.35, tol: 5.9, source: "Kim / WebCeph", note: "مؤشر كيم لعمق العضة (73.35°±5.9°): >79° ميل لعضة عميقة، <67° ميل لعضة مفتوحة هيكلية" },
  { code: "CF", ar: "عامل الدمج (Combination Factor)", en: "Combination factor", group: "vertical", schools: ["kim", "webceph"], unit: "°", needs: ["Or", "Po", "A", "B", "Me", "Go", "ANS", "PNS", "S", "N"], mean: 159.3, tol: 7.1, source: "Kim / WebCeph", note: "عامل الدمج التشخيصي (159.3°±7.1°): يجمع APDI وODI لتقييم صعوبة الحالة واستجابة العلاج" },
  { code: "SN_OCCL", ar: "مستوى الإطباق مع SN", en: "SN to occlusal plane", group: "vertical", schools: ["steiner"], unit: "°", needs: ["S", "N", "OcclA", "OcclP"], mean: 14, tol: 2, source: "Steiner" },
  { code: "OCCL_FH", ar: "مستوى الإطباق مع FH", en: "Cant of occlusal plane", group: "vertical", schools: ["downs", "webceph"], unit: "°", needs: ["Or", "Po", "OcclA", "OcclP"], mean: 9.3, tol: 3.8, source: "Downs / WebCeph" },
  { code: "YAXIS", ar: "محور Y — SGn مع SN", en: "Y-axis (SGn-SN)", group: "vertical", schools: ["steiner"], unit: "°", needs: ["S", "N", "Gn"], mean: 67, tol: 5, source: "Steiner" },
  { code: "YAXIS_FH", ar: "محور Y — SGn مع FH (داونز)", en: "Y-axis (SGn-FH)", group: "vertical", schools: ["downs"], unit: "°", needs: ["S", "Gn", "Or", "Po"], mean: 59.4, tol: 3.9, source: "Downs", note: "الأعلى: نموٌّ أكثر عموديةً (ميل للأفقي)" },
  { code: "LAFH", ar: "نسبة الطول الوجهي الأمامي السفلي", en: "Lower anterior facial height ratio", group: "vertical", schools: ["mcnamara"], unit: "%", needs: ["N", "ANS", "Me"], mean: 55, tol: 3, source: "McNamara", note: "ANS-Me نسبةً من N-Me — والمنشور ≈٥٥٪" },
  { code: "OVERJET", ar: "البروز الأفقي للقواطع (Overjet)", en: "Overjet", group: "dental", schools: ["steiner", "webceph"], unit: "mm", needs: ["U1", "L1", "OcclA", "OcclP"], mean: 2.0, tol: 2.0, source: "Standard / WebCeph", note: "المسافة الأفقية بين حافة القاطع العلوي والسفلي مسقطة على مستوى الإطباق (المعدل 2 مم)" },
  { code: "OVERBITE", ar: "التغطية العمودية للقواطع (Overbite)", en: "Overbite", group: "dental", schools: ["steiner", "webceph"], unit: "mm", needs: ["U1", "L1", "OcclA", "OcclP", "S", "N", "Me"], mean: 2.0, tol: 2.0, source: "Standard / WebCeph", note: "التغطية العمودية للقاطع العلوي فوق السفلي عمودياً على مستوى الإطباق (المعدل 2 مم)" },
  { code: "IMPA", ar: "IMPA — القاطع السفلي مع الفك", en: "IMPA", group: "dental", schools: ["tweed", "webceph"], unit: "°", needs: ["L1A", "L1", "Me", "Go"], mean: 90, tol: 3.5, source: "Tweed / WebCeph", note: "الأعلى: قاطعٌ سفلي مائل للأمام" },
  { code: "FMIA", ar: "FMIA — القاطع السفلي مع FH", en: "FMIA", group: "dental", schools: ["tweed"], unit: "°", needs: ["Or", "Po", "L1A", "L1", "Me", "Go"], mean: 65, tol: 7, source: "Tweed", note: "مثلث Tweed: FMA + IMPA + FMIA = ١٨٠" },
  { code: "U1SN", ar: "U1-SN — ميل القاطع العلوي", en: "U1 to SN", group: "dental", schools: ["steiner", "webceph"], unit: "°", needs: ["S", "N", "U1A", "U1"], mean: 104, tol: 5, source: "Steiner / WebCeph" },
  { code: "U1NA_A", ar: "زاوية U1-NA", en: "U1 to NA (deg)", group: "dental", schools: ["steiner", "webceph"], unit: "°", needs: ["N", "A", "U1A", "U1"], mean: 22, tol: 5, source: "Steiner / WebCeph" },
  { code: "U1NA_D", ar: "بُعد U1-NA (مم)", en: "U1 to NA (mm)", group: "dental", schools: ["steiner", "webceph"], unit: "mm", needs: ["N", "A", "U1", "S", "Me"], mean: 4, tol: 3, source: "Steiner / WebCeph", note: "الأمام موجب" },
  { code: "L1NB_A", ar: "زاوية L1-NB", en: "L1 to NB (deg)", group: "dental", schools: ["steiner", "webceph"], unit: "°", needs: ["N", "B", "L1A", "L1"], mean: 25, tol: 5, source: "Steiner / WebCeph" },
  { code: "L1NB_D", ar: "بُعد L1-NB (مم)", en: "L1 to NB (mm)", group: "dental", schools: ["steiner", "webceph"], unit: "mm", needs: ["N", "B", "L1", "S", "Me"], mean: 4, tol: 2, source: "Steiner / WebCeph", note: "الأمام موجب — ويقارَب مع بُعد Pog-NB في التوازن" },
  { code: "POG_NB_D", ar: "بُعد Pog-NB (مم)", en: "Pog to NB (linear)", group: "dental", schools: ["steiner"], unit: "mm", needs: ["N", "B", "Pog", "S", "Me"], mean: 1, tol: 1, source: "Steiner", note: "قياس التوازن الذقني: يقترب من بُعد L1-NB في التوازن" },
  { code: "INTER", ar: "الزاوية القاطعية U1-L1", en: "Interincisal angle", group: "dental", schools: ["steiner", "downs", "webceph"], unit: "°", needs: ["U1A", "U1", "L1A", "L1"], mean: 128, tol: 5.3, source: "Steiner / WebCeph", note: "الأدنى: بروزٌ قاطعيّ متبادل؛ الأعلى: ارتداد" },
  { code: "L1OP", ar: "القاطع السفلي مع الإطباقية", en: "L1 to occlusal plane", group: "dental", schools: ["downs"], unit: "°", needs: ["OcclA", "OcclP", "L1A", "L1"], mean: 14.5, tol: 5.5, source: "Downs", note: "انحراف محور القاطع السفلي عن عمود مستوى الإطباق — يُقرأ كما نشره Downs مقدارًا موجبًا (٠ = عمودي على المستوى) والمدى المنشور 3.5 إلى 20" },
  { code: "U1_APOG", ar: "بُعد U1 عن خط A-Pog (مم)", en: "U1 to A-Pog (linear)", group: "dental", schools: ["ricketts"], unit: "mm", needs: ["A", "Pog", "U1", "S", "N", "Me"], mean: 1, tol: 2, source: "Ricketts", note: "الأمام موجب — مرجع موضع القاطع العلوي إلى الخط الشفوي العظمي" },
  { code: L1_APOG_ANGLE_CODE, ar: "زاوية محور القاطع السفلي مع A–Pog — الزاوية الصغرى الوصفية", en: "Lower incisor to A–Pog (acute axis angle)", group: "dental", schools: ["all"], unit: "°", needs: ["A", "Pog", "L1", "L1A"], mean: null, tol: null, descriptiveOnly: true, calculationVersion: "l1-apog-acute-axis-v1", source: "Duncan 2015, measurement definition table p49", sourceUrl: "https://mspace.lib.umanitoba.ca/bitstream/1993/30613/3/duncan_laura.pdf", note: "الزاوية الصغرى غير الموقعة بين خط A–Pog ومحور القاطع السفلي من الحافة إلى قمة الجذر، وفق تعريف Duncan 2015؛ المجال من صفر إلى 90 درجة. تعطي الاتجاهات المتكاملة القيمة نفسها ولا تثبت اتجاه الميل أو العزم. أربعة معالم فعلية بلا معايرة طول؛ قياس وصفي بلا معيار سكاني أو حكم تعويضي أو توصية علاجية، ومختلف عن المسافة الخطية L1–APog؛ تغير A أو Pog قد يغير الزاوية دون حركة القاطع." },
  { code: U1_PP_CODE, ar: "ميل القاطع العلوي إلى المستوى الحنكي U1–PP — زاوية وصفية", en: "Upper incisor to palatal plane (posterior angle)", group: "dental", schools: ["all"], unit: "°", needs: ["ANS", "PNS", "U1A", "U1"], mean: null, tol: null, descriptiveOnly: true, calculationVersion: "u1-pp-posterior-v1", source: "Toy & Enacar 2011, Fig. 2; Buyuknacar & Gulec 2020, Figs. 3 and 5", sourceUrl: "https://reference-global.com/2/v2/download/article/10.2478/aoj-2011-0003.pdf", note: "الزاوية الخلفية بين اتجاه ANS إلى PNS واتجاه قمة جذر القاطع العلوي إلى حافته القاطعة، من صفر إلى 180 درجة، دون تحويلها تلقائيًا إلى حادة أو منفرجة. تعتمد على أربعة معالم فعلية ولا تحتاج معايرة طول. زاوية وصفية بلا معيار سكاني أو حكم تعويضي أو توصية علاجية؛ ليست U1–SN أو U1–NA." },
  { code: PALATAL_ANS_PNS_CODE, ar: "طول الحنك العظمي ANS–PNS — طول وصفي", en: "Bony palatal length (ANS–PNS)", group: "sagittal", schools: ["all"], unit: "mm", needs: ["ANS", "PNS"], mean: null, tol: null, descriptiveOnly: true, requiresCalibration: true, calculationVersion: "palatal-direct-length-v1", source: "Tsai 2002, Fig. 3; Buyuknacar & Gulec 2020, Fig. 5", sourceUrl: "https://revistas.usp.br/jaos/article/download/189493/174980/509086", note: "طول مباشر بين الشوكتين الأنفيتين الأمامية والخلفية في الصورة السيفالومترية الجانبية بالمليمتر، وليس إسقاطًا أو طول القوس السني أو المسافة الفعالة Co–A. يتطلب معايرة موجبة ونقطتين مختلفتين محددتين؛ تطابق النقطتين إدخال غير صالح. قياس وصفي بلا معيار سكاني أو توصية علاجية أو توقع نمو." },
  { code: AFH_N_ME_CODE, ar: "ارتفاع الوجه الأمامي الكلي N–Me — طول وصفي", en: "Total anterior facial height (N–Me)", group: "vertical", schools: ["all"], unit: "mm", needs: ["N", "Me"], mean: null, tol: null, descriptiveOnly: true, requiresCalibration: true, calculationVersion: "anterior-direct-length-v1", source: "Tsai 2002, Fig. 3; Buyuknacar & Gulec 2020, Fig. 5", sourceUrl: "https://oss.jocpd.com/files/article/20220926-1550/pdf/JOCPD.26.4.363.pdf", note: "طول مباشر بين النقطتين بالمليمتر، وليس إسقاطًا على محور أو نسبة مئوية. يتطلب معايرة موجبة ونقطتين مختلفتين محددتين؛ تطابق النقطتين إدخال غير صالح. قياس وصفي بلا معيار سكاني أو تصنيف أو توقع نمو أو توصية علاجية." },
  { code: LAFH_ANS_ME_CODE, ar: "ارتفاع الوجه الأمامي السفلي ANS–Me — طول وصفي", en: "Lower anterior facial height (ANS–Me)", group: "vertical", schools: ["all"], unit: "mm", needs: ["ANS", "Me"], mean: null, tol: null, descriptiveOnly: true, requiresCalibration: true, calculationVersion: "anterior-direct-length-v1", source: "Tsai 2002, Fig. 3; Buyuknacar & Gulec 2020, Fig. 5", sourceUrl: "https://oss.jocpd.com/files/article/20220926-1550/pdf/JOCPD.26.4.363.pdf", note: "طول مباشر بين النقطتين بالمليمتر، وليس إسقاطًا على محور أو نسبة مئوية. يتطلب معايرة موجبة ونقطتين مختلفتين محددتين؛ تطابق النقطتين إدخال غير صالح. قياس وصفي بلا معيار سكاني أو تصنيف أو توقع نمو أو توصية علاجية." },
  { code: L1_APOG_CODE, ar: "بُعد القاطع السفلي عن A-Pog — قياس وصفي", en: "Lower incisor to A-Pog (perpendicular)", group: "dental", schools: ["ricketts"], unit: "mm", needs: ["A", "Pog", "L1", "S", "N", "Me"], mean: null, tol: null, descriptiveOnly: true, requiresCalibration: true, calculationVersion: "l1-apog-perpendicular-snme-v1", source: "Hennessey 2020, Table 3.2; Hernández-Sayago et al. 2013", sourceUrl: "https://mspace.lib.umanitoba.ca/bitstreams/c1b02951-4f2f-45c2-8947-4c5fa46a2735/download", note: "المسافة العمودية من الحافة القاطعة للقاطع السفلي إلى خط A–Pog بالمليمتر. الأمام موجب والخلف سالب وفق إطار S–N–Me؛ الصفر قياس صالح. يتطلب معايرة ومعالم محددة؛ لا يُستبدل القاطع العلوي بالسفلي. قياس وصفي بلا معيار سكاني أو تصنيف أو توصية علاجية؛ حركة A أو Pog قد تغيره دون حركة القاطع." },
  { code: EI_KIM_1996_CODE, ar: "مؤشر كيم الوصفي EI — Shin–Chang 1996", en: "Kim EI (Shin–Chang 1996)", group: "dental", schools: ["kim"], unit: "", needs: ["Or", "Po", "A", "B", "Me", "Go", "ANS", "PNS", "S", "N", "U1A", "U1", "L1A", "L1", "Prn", "PogS", "Ls", "Li"], mean: null, tol: null, descriptiveOnly: true, requiresCalibration: true, calculationVersion: "kim-ei-shin-chang-1996-nose-tip-v1", source: "Shin & Chang, Korean J Orthod 1996;26(4):349–358", sourceUrl: "https://e-kjo.org/journal/view.html?uid=1202&vmd=Full", populationReference: { mean: 153.8, sd: 7.76, sampleSize: 153, ageMin: 11.2, ageMax: 14.4, meanAge: 12.7, boys: 67, girls: 86, population: "Korean children with selected normal occlusion" }, note: "مؤشر وصفي مركّب بلا وحدة فيزيائية: CF + (INTER−130)/5 − مسافة الشفة العليا − مسافة الشفة السفلى. المسافتان موقَّعتان بالمليمتر إلى خط Prn–PogS؛ الأمام موجب. يتطلب معايرة ومعالم كاملة. مرجع الدراسة: 153 طفلًا كوريًا بإطباق طبيعي مختار، 11.2–14.4 سنة؛ المتوسط 153.8 والانحراف المعياري 7.76 وصف للعينة لا عتبة علاج. قرار القلع للطبيب بعد تقييم سريري شامل." },
  { code: "E_LINE_UL", ar: "بعد الشفة العليا عن خط ريكتس E-Line (مم)", en: "Upper lip to E-plane", group: "softTissue", schools: ["ricketts", "softTissue", "webceph"], unit: "mm", needs: ["Prn", "PogS", "Ls", "S", "N", "Me"], mean: -4, tol: 2, source: "Ricketts / WebCeph", note: "الخط الجمالي Prn-PogS: الشفة العليا تقع خلف الخط بمقدار −4 مم تقريبًا لدى البالغين، والأمام موجب" },
  { code: "E_LINE_LL", ar: "بعد الشفة السفلى عن خط ريكتس E-Line (مم)", en: "Lower lip to E-plane", group: "softTissue", schools: ["ricketts", "softTissue", "webceph"], unit: "mm", needs: ["Prn", "PogS", "Li", "S", "N", "Me"], mean: -2, tol: 2, source: "Ricketts / WebCeph", note: "الشفة السفلى تقع خلف خط ريكتس بمقدار −2 مم تقريبًا، والأمام موجب" },
  { code: "NASOLABIAL", ar: "الزاوية الأنفية الشفوية Prn-Sn-Ls", en: "Nasolabial angle", group: "softTissue", schools: ["softTissue", "webceph"], unit: "°", needs: ["Prn", "Sn", "Ls"], mean: 102, tol: 8, source: "Holdaway / McNamara / WebCeph", note: "الزاوية عند Sn بين Prn وLs: الحادة (<90°) تشير لبروز الشفة أو انحدار الأنف، والمنفرجة (>110°) لتراجع الشفة" },
];

const MEASUREMENT_SET: ReadonlySet<string> = new Set(MEASUREMENTS.map((m) => m.code));

export function isCephMeasurementCode(value: unknown): value is string {
  return typeof value === "string" && MEASUREMENT_SET.has(value);
}

export type LandmarkMap = Partial<Record<LandmarkCode, Pt>>;

/**
 * Anatomical handedness, not an image-x guess: S→N is posterior→anterior and
 * Me lies inferior to SN. A reflection reverses this basis; a rotation does not.
 * Correctly identified lateral landmarks are a prerequisite. This is a geometric
 * convention, not a check that landmarks/anatomy were clinically identified well.
 * Missing, nonfinite or collinear anchors cannot define a signed measurement.
 */
export function cephHandedness(L: LandmarkMap): 1 | -1 | null {
  if (!isFiniteCephPoint(L.S) || !isFiniteCephPoint(L.N) || !isFiniteCephPoint(L.Me)) return null;
  const anterior = unitVector(vec(L.S, L.N));
  const inferior = unitVector(vec(L.N, L.Me));
  if (!anterior || !inferior) return null;
  const cross = anterior.x * inferior.y - anterior.y * inferior.x;
  // A rotated/translated collinear triple may acquire a tiny cross product from
  // floating-point subtraction. Bound arithmetic uncertainty using coordinate
  // magnitude and the two baseline lengths, rather than a clinical angle cutoff.
  // The factor 8 covers subtraction, normalization and cross-product roundoff.
  const coordinateMagnitude = Math.max(...[L.S, L.N, L.Me].flatMap(point => [Math.abs(point.x), Math.abs(point.y)]));
  const roundoff = 8 * Number.EPSILON * (1
    + coordinateMagnitude / dist(L.S, L.N) + coordinateMagnitude / dist(L.N, L.Me));
  if (!Number.isFinite(cross) || Math.abs(cross) <= roundoff) return null;
  return cross > 0 ? 1 : -1;
}

/**
 * قيمة قياسٍ واحد من خريطة معالم — نفس الدوالّ التي تُختم في القاعدة عند الاعتماد.
 *
 * كل فرع موثَّق بمتجهاته. والقياسات الطولية (mm) تُضرب في المقياس؛ وغباءُ
 * المقياس (NaN) يجعلها غير متاحة بينما الزوايا تعمل — فالطبيب يرى الأنغام قبل
 * أن تكتمل المعايرة.
 */
export function measure(code: string, L: LandmarkMap, mmPerPixel: number): number {
  const p = (c: LandmarkCode): Pt => L[c] as Pt;
  const has = (...cs: LandmarkCode[]): boolean => cs.every((c) => isFiniteCephPoint(L[c]));
  const handedness = () => cephHandedness(L) ?? NaN;
  const anatomicalOffset = (point: Pt, a: Pt, b: Pt) => lateralOffset(point, a, b) * handedness();

  switch (code) {
    case "SNA": {
      if (!has("S", "N", "A")) return NaN;
      return angleAtVertex(p("N"), p("S"), p("A"));
    }
    case "SNB": {
      if (!has("S", "N", "B")) return NaN;
      return angleAtVertex(p("N"), p("S"), p("B"));
    }
    case "ANB": {
      const sna = measure("SNA", L, mmPerPixel);
      const snb = measure("SNB", L, mmPerPixel);
      return sna - snb;
    }
    case "WITS": {
      if (!has("A", "B", "OcclA", "OcclP")) return NaN;
      // Signed AO−BO equals dot(A−B, posterior→anterior occlusal unit vector).
      // Coincident projections are a valid zero; only a degenerate plane is invalid.
      const direction = unitVector(vec(p("OcclP"), p("OcclA")));
      if (!direction) return NaN;
      const separation = vec(p("B"), p("A"));
      return pixelsToMm(separation.x * direction.x + separation.y * direction.y, mmPerPixel);
    }
    case "CONV": {
      if (!has("A", "N", "Pog")) return NaN;
      return pixelsToMm(anatomicalOffset(p("A"), p("N"), p("Pog")), mmPerPixel);
    }
    case "FANGLE": {
      if (!has("N", "Pog", "Or", "Po")) return NaN;
      return angleBetween(vec(p("Or"), p("Po")), vec(p("N"), p("Pog")));
    }
    case "FMA": {
      if (!has("Or", "Po", "Me", "Go")) return NaN;
      return angleBetween(vec(p("Or"), p("Po")), vec(p("Me"), p("Go")));
    }
    case "SNGOGN": {
      if (!has("S", "N", "Gn", "Go")) return NaN;
      return angleBetween(vec(p("S"), p("N")), vec(p("Go"), p("Gn")));
    }
    case "JARABAK": {
      if (!has("S", "N", "Me", "Go")) return NaN;
      const post = pixelsToMm(dist(p("S"), p("Go")), mmPerPixel);
      const ant = pixelsToMm(dist(p("N"), p("Me")), mmPerPixel);
      if (ant === 0) return NaN;
      return (post / ant) * 100;
    }
    case "IMPA": {
      if (!has("L1A", "L1", "Me", "Go")) return NaN;
      return angleBetween(vec(p("L1A"), p("L1")), vec(p("Me"), p("Go")));
    }
    case "FMIA": {
      const fma = measure("FMA", L, mmPerPixel);
      const impa = measure("IMPA", L, mmPerPixel);
      // علاقة Tweed: مجموع زوايا مثلثه الثلاث ١٨٠.
      return 180 - fma - impa;
    }
    case "U1SN": {
      if (!has("S", "N", "U1A", "U1")) return NaN;
      return angleBetween(vec(p("N"), p("S")), vec(p("U1A"), p("U1")));
    }
    case "U1NA_A": {
      if (!has("N", "A", "U1A", "U1")) return NaN;
      // الزاوية الكلاسيكية بين مستقيمي NA ومحور القاطع — وهي **الحادة** (٠–٩٠):
      // على شععة حقيقية القمة فوق الحافة، فشعاعا NA والمحور ينزلان معًا وتعطي
      // angleBetween الزاوية الحادة مباشرة. أما إن عُكس اتجاه المحور في الرسم فالناتج
      // متممة — والتعريف بين المستقيمين لا بين الشعاعين: min(θ, 180−θ).
      const a = angleBetween(vec(p("N"), p("A")), vec(p("U1A"), p("U1")));
      return a > 90 ? 180 - a : a;
    }
    case "U1NA_D": {
      if (!has("N", "A", "U1")) return NaN;
      return pixelsToMm(anatomicalOffset(p("U1"), p("N"), p("A")), mmPerPixel);
    }
    case "L1NB_A": {
      if (!has("N", "B", "L1A", "L1")) return NaN;
      // كما في U1NA_A: الزاوية الحادة بين المستقيمين لا بين الشعاعين — فلا تنقلب
      // مع اتجاه رسم المحور، ويخرج ميل القاطع الحقيقي عن NB لا متممته.
      const a = angleBetween(vec(p("N"), p("B")), vec(p("L1A"), p("L1")));
      return a > 90 ? 180 - a : a;
    }
    case "L1NB_D": {
      if (!has("N", "B", "L1")) return NaN;
      return pixelsToMm(anatomicalOffset(p("L1"), p("N"), p("B")), mmPerPixel);
    }
    case "INTER": {
      if (!has("U1A", "U1", "L1A", "L1")) return NaN;
      return angleBetween(vec(p("U1A"), p("U1")), vec(p("L1A"), p("L1")));
    }
    case "L1OP": {
      if (!has("OcclA", "OcclP", "L1A", "L1")) return NaN;
      // قراءة Downs كما نشرها: مقدارُ انحراف المحور عن العمود على مستوى
      // الإطباق، موجبًا محضًا (٠ = عمودي، والمدى المنشور 3.5–20 كله موجب)
      // — لا إشارة بروزٍ فيها. والصيغة |90−θ| محصّنة من اتجاه رسم المحور
      // والمستوى معًا: قلبُ أيّ متجه يقلب θ إلى متممتها ولا يغيّر الناتج.
      const a = angleBetween(vec(p("L1A"), p("L1")), vec(p("OcclA"), p("OcclP")));
      return Math.abs(90 - a);
    }
    case "YAXIS": {
      if (!has("S", "N", "Gn")) return NaN;
      return angleBetween(vec(p("S"), p("N")), vec(p("S"), p("Gn")));
    }
    case "SND": {
      if (!has("S", "N", "D")) return NaN;
      return angleAtVertex(p("N"), p("S"), p("D"));
    }
    case "POG_NB_D": {
      if (!has("N", "B", "Pog")) return NaN;
      return pixelsToMm(anatomicalOffset(p("Pog"), p("N"), p("B")), mmPerPixel);
    }
    case "SN_OCCL": {
      if (!has("S", "N", "OcclA", "OcclP")) return NaN;
      return angleBetween(vec(p("S"), p("N")), vec(p("OcclP"), p("OcclA")));
    }
    case "CONV_ANGLE": {
      if (!has("N", "A", "Pog")) return NaN;
      // قراءة Downs الموقّعة كما نشرها: مقدار التحدب هو متممة الزاوية عند A،
      // وإشارتها من جهة A عن خط N-Pog (الأمام موجب كما في CONV): موجب محدب
      // نحو الصنف الثاني، وسالب مقعّد نحو الثالث، والاستقامة الكاملة صفر.
      const dev = 180 - angleAtVertex(p("A"), p("N"), p("Pog"));
      const side = anatomicalOffset(p("A"), p("N"), p("Pog"));
      if (!Number.isFinite(side)) return NaN;
      return side >= 0 ? dev : -dev;
    }
    case "AB_PLANE": {
      if (!has("N", "Pog", "A", "B")) return NaN;
      // قراءة Downs الموقّعة كما نشرها (المتوسط −4.6): دوران مستقيم A-B عن
      // الخط الوجهي N-Pog بإشارته — سالبٌ حين يرتد B خلف A نحو الصنف الثاني
      // وموجب نحو الثالث. الإشارة من اتجاه الدوران نفسه على إحداثيات الصورة
      // (الأمام شرقًا)، والاختبارات تثبت الاتجاهين بتحريك B جانبيًا.
      const vNP = vec(p("N"), p("Pog"));
      const vAB = vec(p("A"), p("B"));
      const signed = -signedAngleBetween(vNP, vAB) * handedness();
      return signed <= -180 ? signed + 360 : signed;
    }
    case "OCCL_FH": {
      if (!has("Or", "Po", "OcclA", "OcclP")) return NaN;
      return angleBetween(vec(p("Or"), p("Po")), vec(p("OcclA"), p("OcclP")));
    }
    case "YAXIS_FH": {
      if (!has("S", "Gn", "Or", "Po")) return NaN;
      return angleBetween(vec(p("Po"), p("Or")), vec(p("S"), p("Gn")));
    }
    case "U1_APOG": {
      if (!has("A", "Pog", "U1")) return NaN;
      return pixelsToMm(anatomicalOffset(p("U1"), p("A"), p("Pog")), mmPerPixel);
    }
    case L1_APOG_ANGLE_CODE: {
      if (!has("A", "Pog", "L1", "L1A")) return NaN;
      // Duncan2015 p49 explicitly specifies the acute angle of two lines.
      // This protocol intentionally loses direction, unlike U1-PP's wedge.
      const angle = angleBetween(vec(p("A"), p("Pog")), vec(p("L1"), p("L1A")));
      return Math.min(angle, 180 - angle);
    }
    case U1_PP_CODE: {
      // Published posterior wedge: ANS toward PNS, upper apex toward edge.
      // Do not acute-fold or force obtuse: either would lose inclination.
      if (!has("ANS", "PNS", "U1A", "U1")) return NaN;
      return angleBetween(vec(p("ANS"), p("PNS")), vec(p("U1A"), p("U1")));
    }
    case PALATAL_ANS_PNS_CODE: {
      if (!has("ANS", "PNS")) return NaN;
      const length = dist(p("ANS"), p("PNS"));
      // Exact coincident endpoints are invalid, without a clinical epsilon.
      return length > 0 ? pixelsToMm(length, mmPerPixel) : NaN;
    }
    case AFH_N_ME_CODE:
    case LAFH_ANS_ME_CODE: {
      const start = code === AFH_N_ME_CODE ? "N" : "ANS";
      if (!has(start, "Me")) return NaN;
      const length = dist(p(start), p("Me"));
      // Exact coincident clicks do not define a usable anatomical segment.
      // This is input-validity policy, not a clinical threshold or projection.
      return length > 0 ? pixelsToMm(length, mmPerPixel) : NaN;
    }
    case L1_APOG_CODE: {
      // Perpendicular incisal-tip distance, Hennessey 2020 Table 3.2 (p49).
      // Anterior-positive sign uses this engine's explicit S-N-Me frame.
      if (!has("A", "Pog", "L1")) return NaN;
      return pixelsToMm(anatomicalOffset(p("L1"), p("A"), p("Pog")), mmPerPixel);
    }
    case "MAX_LEN": {
      if (!has("Co", "A")) return NaN;
      return pixelsToMm(dist(p("Co"), p("A")), mmPerPixel);
    }
    case "MAND_LEN": {
      if (!has("Co", "Gn")) return NaN;
      return pixelsToMm(dist(p("Co"), p("Gn")), mmPerPixel);
    }
    case "MM_DIFF": {
      const mand = measure("MAND_LEN", L, mmPerPixel);
      const max = measure("MAX_LEN", L, mmPerPixel);
      if (!Number.isFinite(mand) || !Number.isFinite(max)) return NaN;
      return mand - max;
    }
    case "A_NPERP":
    case "POG_NPERP": {
      const target = code === "A_NPERP" ? "A" : "Pog";
      if (!has("N", "Or", "Po", target as LandmarkCode)) return NaN;
      const anterior = unitVector(vec(p("Po"), p("Or")));
      if (!anterior) return NaN;
      const offset = vec(p("N"), p(target as LandmarkCode));
      return pixelsToMm(offset.x * anterior.x + offset.y * anterior.y, mmPerPixel);
    }
    case "LAFH": {
      if (!has("N", "ANS", "Me")) return NaN;
      // نسبة McNamara: الطول السفلي ANS-Me من الكلي N-Me — نسبةُ أطوالٍ
      // بالبكسل تعادل نسبة الأطوال الحقيقية، وتحتاج المقياس كما سائر الطوليات.
      const total = pixelsToMm(dist(p("N"), p("Me")), mmPerPixel);
      const lower = pixelsToMm(dist(p("ANS"), p("Me")), mmPerPixel);
      if (!Number.isFinite(total) || total === 0 || !Number.isFinite(lower)) return NaN;
      return (lower / total) * 100;
    }
    case "E_LINE_UL": {
      if (!has("Prn", "PogS", "Ls")) return NaN;
      // خط ريكتس الجمالي E-Line يمتد من Prn (قمة الأنف) إلى PogS (الذقن الرخو).
      // الإزاحة الجانبية الموقعة: الأمام شرقًا (+x) موجب.
      return pixelsToMm(anatomicalOffset(p("Ls"), p("Prn"), p("PogS")), mmPerPixel);
    }
    case "E_LINE_LL": {
      if (!has("Prn", "PogS", "Li")) return NaN;
      return pixelsToMm(anatomicalOffset(p("Li"), p("Prn"), p("PogS")), mmPerPixel);
    }
    case "NASOLABIAL": {
      if (!has("Prn", "Sn", "Ls")) return NaN;
      // الزاوية عند Subnasale بين نقطة قمة الأنف والشفة العليا
      return angleAtVertex(p("Sn"), p("Prn"), p("Ls"));
    }
    case "SADDLE": {
      if (!has("N", "S", "Ar")) return NaN;
      // زاوية السرج N-S-Ar
      return angleAtVertex(p("S"), p("N"), p("Ar"));
    }
    case "ARTICULAR": {
      if (!has("S", "Ar", "Go")) return NaN;
      // زاوية الارتكاز المفصلي S-Ar-Go
      return angleAtVertex(p("Ar"), p("S"), p("Go"));
    }
    case "GONIAL": {
      if (!has("Ar", "Go", "Me")) return NaN;
      // زاوية الفك السفلي Ar-Go-Me
      return angleAtVertex(p("Go"), p("Ar"), p("Me"));
    }
    case "BJORK_SUM": {
      const saddle = measure("SADDLE", L, mmPerPixel);
      const articular = measure("ARTICULAR", L, mmPerPixel);
      const gonial = measure("GONIAL", L, mmPerPixel);
      if (!Number.isFinite(saddle) || !Number.isFinite(articular) || !Number.isFinite(gonial)) return NaN;
      return saddle + articular + gonial;
    }
    case "FH_AB": {
      if (!has("Or", "Po", "A", "B")) return NaN;
      return angleBetween(vec(p("Or"), p("Po")), vec(p("A"), p("B")));
    }
    case "AB_MAND": {
      if (!has("A", "B", "Me", "Go")) return NaN;
      return angleBetween(vec(p("A"), p("B")), vec(p("Go"), p("Me")));
    }
    case "PP_FH": {
      if (!has("ANS", "PNS", "Or", "Po")) return NaN;
      return signedAngleBetween(vec(p("Po"), p("Or")), vec(p("PNS"), p("ANS"))) * handedness();
    }
    case "APDI": {
      if (!has("A", "B", "ANS", "PNS")) return NaN;
      // Posterior/downward PP–AB wedge; may legitimately exceed 90 degrees.
      // Celar et al., doi:10.1007/s00056-018-0139-z. No population tilt imputation.
      return angleBetween(vec(p("ANS"), p("PNS")), vec(p("A"), p("B")));
    }
    case "ODI": {
      // Caballero-Purizaga et al., doi:10.1590/2177-6709.24.3.046-054.oar:
      // AB–MP plus signed PP–FH (anterior-down positive, anterior-up negative).
      return measure("AB_MAND", L, mmPerPixel) + measure("PP_FH", L, mmPerPixel);
    }
    case "CF": {
      const apdi = measure("APDI", L, mmPerPixel);
      const odi = measure("ODI", L, mmPerPixel);
      if (!Number.isFinite(apdi) || !Number.isFinite(odi)) return NaN;
      return apdi + odi;
    }
    case "OVERJET": {
      if (!has("U1", "L1", "OcclA", "OcclP")) return NaN;
      const dir = unitVector(vec(p("OcclP"), p("OcclA")));
      if (!dir) return NaN;
      const v = vec(p("L1"), p("U1"));
      const proj = v.x * dir.x + v.y * dir.y;
      return pixelsToMm(proj, mmPerPixel);
    }
    case "OVERBITE": {
      if (!has("U1", "L1", "OcclA", "OcclP")) return NaN;
      const dir = unitVector(vec(p("OcclP"), p("OcclA")));
      if (!dir) return NaN;
      const normalDown = { x: -dir.y, y: dir.x };
      const v = vec(p("L1"), p("U1"));
      const proj = (v.x * normalDown.x + v.y * normalDown.y) * handedness();
      return pixelsToMm(proj, mmPerPixel);
    }
    case EI_KIM_1996_CODE: {
      // Shin & Chang 1996, p352: both piecewise incisor corrections simplify to
      // (IIA−130)/5; subtract each anatomically signed lip distance in mm.
      // The persisted code identifies this nose-tip E-line variant, not legacy EI.
      if (!Number.isFinite(mmPerPixel) || mmPerPixel <= 0) return NaN;
      const cf = measure("CF", L, mmPerPixel);
      const interincisal = measure("INTER", L, mmPerPixel);
      const upperLip = measure("E_LINE_UL", L, mmPerPixel);
      const lowerLip = measure("E_LINE_LL", L, mmPerPixel);
      if (![cf, interincisal, upperLip, lowerLip].every(Number.isFinite)) return NaN;
      const index = cf + (interincisal - 130) / 5 - upperLip - lowerLip;
      return Number.isFinite(index) ? index : NaN;
    }
    case "EXT_INDEX": {
      // Quarantined: the former CF+(nasolabial−95)*0.5 formula and its missing-
      // tissue fallback lack a verified clinical definition. Do not invent a
      // patient measurement or extraction recommendation. Saved records are untouched.
      return NaN;
    }
    default:
      return NaN;
  }
}

export type MeasurementStatus = "within" | "above" | "below";

/** موضع القيمة من المدى المرجعي — للعرض بالألوان لا للحكم. */
export function interpret(value: number, def: MeasurementDef): MeasurementStatus | null {
  if (def.descriptiveOnly || isDescriptiveCephMeasurement(def.code)
      || !Number.isFinite(value) || def.mean == null || def.tol == null) return null;
  if (value > def.mean + def.tol) return "above";
  if (value < def.mean - def.tol) return "below";
  return "within";
}

/**
 * تقييم شدة الانحراف بالنجوم كمنصة WebCeph العالمية:
 * - فارغ "": طبيعي ضمن انحراف معياري واحد (<= 1 SD)
 * - نجمة "*": انحراف خفيف (1 to 2 SD)
 * - نجمتان "**": انحراف ملحوظ (2 to 3 SD)
 * - ثلاث نجوم "***": انحراف شديد (> 3 SD)
 */
export function getSeverityStars(value: number | null | undefined, mean: number | null | undefined, sd: number | null | undefined): "" | "*" | "**" | "***" {
  if (value == null || !Number.isFinite(value) || typeof mean !== "number" || typeof sd !== "number"
      || !Number.isFinite(mean) || !Number.isFinite(sd) || sd <= 0) return "";
  const z = Math.abs(value - mean) / sd;
  if (z <= 1.0) return "";
  if (z <= 2.0) return "*";
  if (z <= 3.0) return "**";
  return "***";
}

/**
 * التفسير السريري الفوري التلقائي لكل قياس سيفالومتري (يطابق WebCeph بالعربية والإنجليزية).
 */
export function getClinicalInterpretation(code: string, value: number | null | undefined): { en: string; ar: string } {
  if (code === "EXT_INDEX") return { en: "Unavailable: clinical definition requires validation", ar: "غير متاح: تعريف المؤشر يحتاج تحققًا سريريًا" };
  if (value == null || !Number.isFinite(value)) return { en: "—", ar: "—" };
  if (code === L1_APOG_CODE || code === AFH_N_ME_CODE || code === LAFH_ANS_ME_CODE || code === PALATAL_ANS_PNS_CODE || code === U1_PP_CODE || code === L1_APOG_ANGLE_CODE) return {
    en: "Descriptive measurement; treatment decisions require clinical assessment",
    ar: "قياس وصفي؛ القرار العلاجي يتطلب تقييمًا سريريًا",
  };
  if (isDescriptiveCephMeasurement(code)) return {
    en: "Descriptive composite index; treatment decisions require clinical assessment",
    ar: "مؤشر مركّب وصفي؛ القرار العلاجي يتطلب تقييمًا سريريًا",
  };

  switch (code) {
    case "SNA":
      if (value > 84) return { en: "Prognathic maxilla", ar: "بروز الفك العلوي" };
      if (value < 80) return { en: "Retrognathic maxilla", ar: "تراجع الفك العلوي" };
      return { en: "Normal A-P position of maxilla", ar: "الموضع السهمي للفك العلوي طبيعي" };
    case "SNB":
      if (value > 82) return { en: "Prognathic mandible", ar: "بروز الفك السفلي" };
      if (value < 78) return { en: "Retrognathic mandible", ar: "تراجع الفك السفلي" };
      return { en: "Normal A-P position of mandible", ar: "الموضع السهمي للفك السفلي طبيعي" };
    case "ANB":
      if (value > 4) return { en: "Skeletal Class II", ar: "صنف هيكلي ثانٍ" };
      if (value < 0) return { en: "Skeletal Class III", ar: "صنف هيكلي ثالث" };
      return { en: "Skeletal Class I", ar: "صنف هيكلي أول" };
    case "BJORK_SUM":
      if (value > 400) return { en: "Hyperdivergent (Clockwise)", ar: "نمط نمو عمودي منفتح (دوران مع عقارب الساعة)" };
      if (value < 390) return { en: "Hypodivergent (Counter-clockwise)", ar: "نمط نمو أفقي منغلق (دوران عكس عقارب الساعة)" };
      return { en: "Normodivergent skeletal pattern", ar: "نمط نمو هيكلي متوازن" };
    case "FMA":
      if (value > 29) return { en: "Hyperdivergent facial pattern", ar: "نمط وجهي منفتح الزاوية (وجه طويل)" };
      if (value < 21) return { en: "Hypodivergent facial pattern", ar: "نمط وجهي منخفض الزاوية (وجه قصير)" };
      return { en: "Normodivergent facial pattern", ar: "نمط وجهي متناسق وطبيعي" };
    case "GONIAL":
      if (value > 127) return { en: "Large gonial angle (Downward growth)", ar: "زاوية فك منفرجة (نمو خلفي هابط)" };
      if (value < 117) return { en: "Small gonial angle (Horizontal growth)", ar: "زاوية فك حادة (نمو أفقي)" };
      return { en: "Normal gonial angle", ar: "زاوية الفك السفلي طبيعية" };
    case "APDI":
      if (value > 90) return { en: "Skeletal Class III", ar: "صنف هيكلي ثالث (APDI مرتفع)" };
      if (value < 82) return { en: "Skeletal Class II", ar: "صنف هيكلي ثانٍ (APDI منخفض)" };
      return { en: "Normal APDI", ar: "مؤشر APDI طبيعي (صنف أول)" };
    case "ODI":
      if (value > 79) return { en: "Deep bite tendency", ar: "ميل لعضة عميقة (ODI مرتفع)" };
      if (value < 67) return { en: "Open bite tendency", ar: "ميل لعضة مفتوحة (ODI منخفض)" };
      return { en: "Normal ODI", ar: "مؤشر عمق العضة ODI طبيعي" };
    case "CF":
      if (value > 166) return { en: "High CF (Class III / Deep bite)", ar: "عامل دمج مرتفع (ميل لعضة عميقة / صنف ثالث)" };
      if (value < 152) return { en: "Low CF (Class II / Open bite)", ar: "عامل دمج منخفض (ميل لعضة مفتوحة / صنف ثانٍ)" };
      return { en: "Normal combination factor value", ar: "عامل الدمج CF متوازن وطبيعي" };
    case "FH_AB":
      if (value > 84) return { en: "Skeletal Class III", ar: "صنف هيكلي ثالث" };
      if (value < 78) return { en: "Skeletal Class II", ar: "صنف هيكلي ثانٍ" };
      return { en: "Normal FH to AB relationship", ar: "علاقة AB طبيعية بالنسبة لمستوى فرانكفورت" };
    case "AB_MAND":
      if (value > 72) return { en: "Steep AB to mandibular plane", ar: "زاوية AB منفرجة مع مستوى الفك" };
      if (value < 66) return { en: "Flat AB to mandibular plane", ar: "زاوية AB حادة مع مستوى الفك" };
      return { en: "Normal AB to mand. plane angle", ar: "زاوية AB طبيعية مع مستوى الفك" };
    case "WITS":
      if (value > 1) return { en: "Skeletal Class II", ar: "صنف هيكلي ثانٍ" };
      if (value < -3) return { en: "Skeletal Class III", ar: "صنف هيكلي ثالث" };
      return { en: "Skeletal Class I", ar: "صنف هيكلي أول" };
    case "OVERJET":
      if (value > 4) return { en: "Increased overjet", ar: "بروز قواطع أفقي متزايد" };
      if (value < 0) return { en: "Reverse overjet (Crossbite)", ar: "عضة معكوسة أمامية" };
      if (value < 1) return { en: "Edge-to-edge incisal relation", ar: "عضة حدية (Edge-to-edge)" };
      return { en: "Normal overjet", ar: "بروز القواطع الأفقي طبيعي" };
    case "OVERBITE":
      if (value > 4) return { en: "Deep overbite", ar: "تغطية قاطعية عميقة (Deep bite)" };
      if (value < 0) return { en: "Anterior open bite", ar: "عضة مفتوحة أمامية" };
      if (value < 1) return { en: "Reduced overbite", ar: "تغطية قاطعية منخفضة" };
      return { en: "Normal overbite", ar: "التغطية القاطعية العمودية طبيعية" };
    case "IMPA":
      if (value > 95) return { en: "Proclined lower incisor", ar: "بروز القاطع السفلي نحو الشفة" };
      if (value < 85) return { en: "Retroclined lower incisor", ar: "تراجع القاطع السفلي نحو اللسان" };
      return { en: "Normal lower incisor inclination", ar: "ميل القاطع السفلي طبيعي ومتوازن" };
    case "U1SN":
      if (value > 109) return { en: "Proclined upper incisor", ar: "بروز القاطع العلوي نحو الشفة" };
      if (value < 99) return { en: "Retroclined upper incisor", ar: "تراجع القاطع العلوي نحو الحنك" };
      return { en: "Normal upper incisor inclination", ar: "ميل القاطع العلوي طبيعي" };
    case "INTER":
      if (value > 136) return { en: "Uprighted interincisal angle", ar: "زاوية قاطعية مستقيمة/قواطع متراجعة" };
      if (value < 124) return { en: "Bimaxillary protrusion tendency", ar: "ميل للبروز الثنائي للقواطع" };
      return { en: "Normal interincisal angle", ar: "الزاوية القاطعية طبيعية ومتناسقة" };
    case "E_LINE_UL":
      if (value > -2) return { en: "Protruded upper lip", ar: "بروز الشفة العليا بالنسبة لخط ريكتس" };
      if (value < -6) return { en: "Retruded upper lip", ar: "تراجع الشفة العليا عن خط ريكتس" };
      return { en: "Normal upper lip", ar: "موضع الشفة العليا متناسق مع خط ريكتس" };
    case "E_LINE_LL":
      if (value > 0) return { en: "Protruded lower lip", ar: "بروز الشفة السفلى أمام خط ريكتس" };
      if (value < -4) return { en: "Retruded lower lip", ar: "تراجع الشفة السفلى عن خط ريكتس" };
      return { en: "Normal lower lip", ar: "موضع الشفة السفلى متناسق مع خط ريكتس" };
    case "NASOLABIAL":
      if (value > 110) return { en: "Retruded lip / Obtuse angle", ar: "تراجع الشفة العليا / زاوية منفرجة" };
      if (value < 94) return { en: "Protruded lip / Acute angle", ar: "بروز الشفة العليا / زاوية حادة" };
      return { en: "Normal nasolabial angle", ar: "الزاوية الأنفية الشفوية طبيعية ومتوازنة" };
    case "A_NPERP":
      if (value > 2) return { en: "Protruded maxilla", ar: "بروز الفك العلوي أمام عمود N" };
      if (value < -1) return { en: "Retruded maxilla", ar: "تراجع الفك العلوي خلف عمود N" };
      return { en: "Normal A-P position of maxilla", ar: "موضع الفك العلوي طبيعي" };
    case "POG_NPERP":
      if (value > 0) return { en: "Protruded chin", ar: "بروز الذقن أمام عمود N" };
      if (value < -4) return { en: "Retruded chin", ar: "تراجع الذقن خلف عمود N" };
      return { en: "Normal A-P position of chin", ar: "موضع الذقن طبيعي" };
    default:
      return { en: "Normal range", ar: "ضمن الحدود الطبيعية" };
  }
}

export interface MeasurementResult extends CephCalculationMetadata {
  code: string;
  ar: string;
  en: string;
  unit: string;
  group: MeasurementGroup;
  schools: CephSchool[];
  value: number | null;
  display: string;
  mean: number | null;
  tol: number | null;
  status: MeasurementStatus | null;
  severityStars?: "" | "*" | "**" | "***";
  interpretationEn?: string;
  interpretationAr?: string;
  source: string;
  note?: string;
}

/** كل القياسات دفعةً واحدة — جداول الشاشة الحية ولقطة الاعتماد على السواء. */
export function computeAll(L: LandmarkMap, mmPerPixel: number): MeasurementResult[] {
  return MEASUREMENTS.map((def) => {
    const value = measure(def.code, L, mmPerPixel);
    const ok = Number.isFinite(value);
    const valRounded = ok ? round1(value) : null;
    const interp = getClinicalInterpretation(def.code, valRounded);
    return {
      code: def.code,
      ar: def.ar,
      en: def.en,
      unit: def.unit,
      group: def.group,
      schools: def.schools,
      value: valRounded,
      display: ok ? String(valRounded) : "—",
      mean: def.mean,
      tol: def.tol,
      status: interpret(value, def),
      severityStars: def.descriptiveOnly ? "" : getSeverityStars(valRounded, def.mean, def.tol),
      interpretationEn: interp.en,
      interpretationAr: interp.ar,
      source: def.source,
      note: def.note,
      ...(def.descriptiveOnly ? { descriptiveOnly: true } : {}),
      ...(def.requiresCalibration ? { requiresCalibration: true } : {}),
      ...(def.calculationVersion ? { calculationVersion: def.calculationVersion } : {}),
      ...(def.sourceUrl ? { sourceUrl: def.sourceUrl } : {}),
      ...(def.populationReference ? { populationReference: def.populationReference } : {}),
    };
  });
}

/** القياسات التي ما زال ناقصها معلمًا — تُعرض دليلًا للطبيب قبل الاعتماد. */
export function missingFor(code: string, L: LandmarkMap): LandmarkCode[] {
  const def = MEASUREMENTS.find((m) => m.code === code);
  if (!def) return [];
  return def.needs.filter((c) => !isFiniteCephPoint(L[c]));
}

/* ─────────────────────────── خلاصة الحالة ─────────────────────────── */

export interface CephSummary {
  /** الصنف الهيكلي من ANB — والمقصود به العلاقة لا التشخيص. */
  skeletal: string;
  /** وصف العلاقة العمودية المتاحة؛ لا يتنبأ بالنمو. */
  vertical: string;
}

/**
 * خلاصة أولية تُعرض تحت الجدول — **قراءة أرقام لا تشخيص**.
 *
 * الحدود هي المتعارفة في الأدبيات (ANB: ٠–٤ صنف أول، فوقها نحو ثانٍ، وتحته نحو
 * ثالث)، وهي نفسها وسيلةُ عيّنات: تُقرأ مع الظاهر السريري لا وحدها. والنصّ يقول
 * «نحو» لا «هو» — لأن العكس يوهم أن البرنامج أشخّص.
 */
export function summarize(results: MeasurementResult[]): CephSummary {
  const description = generateCephExpertDiagnosis(results);
  return { skeletal: description.sagittalSkeletal.descriptionAr, vertical: description.verticalSkeletal.descriptionAr };
}

/* ─────────────────── النظام المرجعي والتشخيص المقترح ─────────────────── */

/** قيمة مرجعية من مجموعة معتمدة: متوسط وانحراف معياري. */
export interface RefValue {
  mean: number;
  sd: number;
}

/** خريطة رمز القياس → قيمته المرجعية في المجموعة المختارة للدراسة. */
export type RefMap = Record<string, RefValue>;

/**
 * الدرجة المعيارية Z = (القيمة − المتوسط) / الانحراف المعياري.
 *
 * تعيد null إن كان أيّ طرفٍ غير منطقي أو الانحراف صفريًا — لا رقمًا زوّارًا.
 */
export function zScore(value: number, ref: RefValue): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(ref.mean)) return null;
  if (!Number.isFinite(ref.sd) || ref.sd <= 0) return null;
  return (value - ref.mean) / ref.sd;
}

export type RefSeverity = "within" | "mild" | "marked";

export interface RefReading {
  z: number;
  severity: RefSeverity;
  /** وصف عربي صريح — اللون مساعدةٌ لا الحامل الوحيد للمعنى. */
  label: string;
}

/**
 * تصنيف القراءة على المجموعة المرجعية: داخل المدى (|Z| ≤ ١)، ميلٌ بسيط
 * (١–٢ انحراف)، أو بوضوح (أكثر من انحرافين). قراءةُ عرضٍ لا حكمٌ سريري.
 */
export function classifyZ(z: number | null): RefReading | null {
  if (z == null || !Number.isFinite(z)) return null;
  const a = Math.abs(z);
  if (a <= 1) return { z, severity: "within", label: "داخل المدى المرجعي" };
  if (z > 0) {
    return a <= 2
      ? { z, severity: "mild", label: "أعلى من المتوسط بقليل" }
      : { z, severity: "marked", label: "أعلى من المتوسط بوضوح" };
  }
  return a <= 2
    ? { z, severity: "mild", label: "أدنى من المتوسط بقليل" }
    : { z, severity: "marked", label: "أدنى من المتوسط بوضوح" };
}

/** صف جدول مُغنّى بالقيم المرجعية للدراسة إن وُجدت. */
export interface EnrichedMeasurement extends MeasurementResult {
  refMean: number | null;
  refSd: number | null;
  diff: number | null;
  z: number | null;
  refLabel: string | null;
  refSeverity: RefSeverity | null;
}

/**
 * يغنّي نتائج الحساب بالمجموعة المرجعية المختارة — وما لم يوجد رمزٌ في
 * المجموعة عاد إلى المعدل المدمج في التعريف نفسه، فلا يبقى صفٌّ بلا مرجع.
 */
export function enrichWithRefs(
  results: MeasurementResult[],
  refs: RefMap | null,
): EnrichedMeasurement[] {
  return results.map((r) => {
    // An empirical index's study distribution is not an applicable patient norm.
    // Even injected custom references cannot silently turn it into a grade.
    if (r.descriptiveOnly || isDescriptiveCephMeasurement(r.code)) {
      return { ...r, mean: null, tol: null, status: null, severityStars: "" as const,
        refMean: null, refSd: null, diff: null, z: null, refLabel: null, refSeverity: null };
    }
    const ref = refs?.[r.code];
    const mean = ref ? ref.mean : r.mean;
    const sd = ref ? ref.sd : r.tol;
    if (r.value == null || mean == null || sd == null || !Number.isFinite(mean) || !Number.isFinite(sd) || sd <= 0) {
      return { ...r, refMean: ref ? ref.mean : r.mean, refSd: ref ? ref.sd : r.tol, diff: null, z: null, refLabel: null, refSeverity: null };
    }
    const reading = classifyZ(zScore(r.value, { mean, sd }));
    return {
      ...r,
      refMean: mean,
      refSd: sd,
      diff: Math.round((r.value - mean) * 10) / 10,
      z: reading ? Math.round(reading.z * 100) / 100 : null,
      refLabel: reading?.label ?? null,
      refSeverity: reading?.severity ?? null,
    };
  });
}

/** اقتراح تشخيصي منظم — قراءةُ أرقامٍ يقترحها النظام ويحرّرها الطبيب ويعتمدها. */
export interface DiagnosisSuggestion {
  skeletal: string;
  dental: string;
  softTissue: string;
}

/**
 * صياغة اقتراح أولي من القياسات المكتملة — **مقترحٌ موسوم لا تشخيص**، والاعتماد
 * عملُ الطبيب في شاشة التحرير. حدوده من ANB وFMA وSN-GoGn والقواطع، وما لا
 * تكتمل معالمه يقول عنه الصدق: غير متاح.
 */
export function suggestDiagnosis(results: MeasurementResult[]): DiagnosisSuggestion {
  const { skeletal, dental, softTissue } = generateCephExpertDiagnosis(results).formatted;
  return { skeletal, dental, softTissue };
}

/* ─────────────────── محرك التشخيص واقتراح المعالم الذكي ─────────────────── */

export interface CephExpertDiagnosis {
  sagittalSkeletal: {
    classification: "Class I" | "Class II" | "Class II div 1" | "Class II div 2" | "Class III" | "Indeterminate";
    severity: "normal" | "mild" | "moderate" | "severe" | "indeterminate";
    descriptionAr: string;
    detailsAr: string[];
    maxilla: "normal" | "prognathic" | "retrognathic" | "indeterminate";
    mandible: "normal" | "prognathic" | "retrognathic" | "indeterminate";
  };
  verticalSkeletal: {
    pattern: "Normodivergent" | "Hyperdivergent" | "Hypodivergent" | "Indeterminate";
    descriptionAr: string;
    detailsAr: string[];
    growthTendencyAr: string;
  };
  dentalAnalysis: {
    descriptionAr: string;
    detailsAr: string[];
    upperIncisor: "normal" | "proclined" | "retroclined" | "indeterminate";
    lowerIncisor: "normal" | "proclined" | "retroclined" | "indeterminate";
    compensationAr: string;
    interincisalAr: string;
  };
  aestheticProfile: {
    profileTypeAr: string;
    lipCompetenceAr: string;
    nasolabialAr: string;
    eLineAr: string;
    summaryAr: string;
  };
  treatmentRecommendations: {
    extractionDecision: "non-extraction" | "borderline" | "extraction-indicated" | "not-specified";
    extractionRationaleAr: string;
    growthModification: boolean;
    growthModificationAr?: string;
    expansion: boolean;
    expansionAr?: string;
    anchorageOrTADs: boolean;
    anchorageOrTADsAr?: string;
    orthognathicSurgery: boolean;
    orthognathicSurgeryAr?: string;
    narrativePlanAr: string;
  };
  formatted: {
    skeletal: string;
    dental: string;
    softTissue: string;
    finalDx: string;
    recommendationsText: string;
  };
}

/**
 * Descriptive cephalometric observations, not a diagnosis or a treatment plan.
 * The caller has no examination, crowding, periodontal, skeletal maturity or
 * patient-preference evidence. Missing data never means normal; age alone never
 * determines remaining growth. Reference-range labels are not clinical severity.
 * Preserve the historical response keys, but never select an intervention here.
 */
export function generateCephExpertDiagnosis(
  results: MeasurementResult[],
  patientInfo?: { age?: number; gender?: string },
): CephExpertDiagnosis {
  // Demographics alone cannot establish treatment eligibility or growth status.
  void patientInfo;
  const get = (code: string): number | null => {
    const value = results.find((row) => row.code === code)?.value;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const anb = get("ANB"), sna = get("SNA"), snb = get("SNB"), wits = get("WITS");
  const classification: CephExpertDiagnosis["sagittalSkeletal"]["classification"] = anb === null
    ? "Indeterminate" : anb > 4 ? "Class II" : anb < 0 ? "Class III" : "Class I";
  const classAr = classification === "Class I" ? "صنف أول" : classification === "Class II" ? "صنف ثانٍ" : "صنف ثالث";
  const sagittalDesc = anb === null ? "العلاقة السهمية غير محددة: قياس ANB غير متاح"
    : `ميل لعلاقة هيكلية ${classAr} (${classification}) حسب ANB = ${anb}°؛ يحتاج مطابقة سريرية`;
  const sagittalDetails: string[] = [];
  if (sna !== null) sagittalDetails.push(`SNA = ${sna}° (المرجع المدمج 82°±2°)`);
  if (snb !== null) sagittalDetails.push(`SNB = ${snb}° (المرجع المدمج 80°±2°)`);
  if (anb !== null) sagittalDetails.push(`ANB = ${anb}°؛ لا يحدد وحده الإطباق أو شدة الحالة أو تقسيم Angle`);
  if (wits !== null) sagittalDetails.push(`Wits = ${wits} مم؛ يُقرأ مع ميل مستوى الإطباق والمرجع الملائم للمريض`);
  const position = (value: number | null, mean: number): CephExpertDiagnosis["sagittalSkeletal"]["maxilla"] =>
    value === null ? "indeterminate" : value > mean + 2 ? "prognathic" : value < mean - 2 ? "retrognathic" : "normal";

  const verticalDetails: string[] = [];
  const patterns = new Set<CephExpertDiagnosis["verticalSkeletal"]["pattern"]>();
  for (const [code, label] of [["FMA", "FMA"], ["SNGOGN", "SN-GoGn"], ["BJORK_SUM", "Bjork sum"]]) {
    const value = get(code);
    const definition = MEASUREMENTS.find((row) => row.code === code);
    if (value === null || !definition) continue;
    if (definition.mean === null || definition.tol === null
      || !Number.isFinite(definition.mean) || !Number.isFinite(definition.tol) || definition.tol <= 0) {
      verticalDetails.push(`${label} = ${value}° (لا مرجع تصنيفي متاح)`);
      continue;
    }
    verticalDetails.push(`${label} = ${value}° (المرجع المدمج ${definition.mean}°±${definition.tol}°)`);
    patterns.add(value > definition.mean + definition.tol ? "Hyperdivergent"
      : value < definition.mean - definition.tol ? "Hypodivergent" : "Normodivergent");
  }
  for (const code of ["JARABAK", "YAXIS", "LAFH"]) {
    const value = get(code);
    if (value !== null) verticalDetails.push(`${code} = ${value}${code === "YAXIS" ? "°" : "%"}`);
  }
  const verticalPattern = patterns.size === 1 ? [...patterns][0] : "Indeterminate";
  const verticalDesc = verticalPattern === "Indeterminate"
    ? patterns.size > 1 ? "المؤشرات العمودية غير متفقة؛ يلزم تقييم سريري" : "العلاقة العمودية غير محددة: القياسات غير متاحة"
    : `وصف العلاقة العمودية حسب القياسات المتاحة: ${verticalPattern}؛ لا يثبت اتجاه النمو المستقبلي`;
  const growthTendency = "اتجاه النمو والنمو المتبقي غير محددين؛ يلزم تقييم النضج ومتابعة سريرية، ولا يكفي العمر الزمني أو صورة واحدة.";

  const u1na = get("U1NA_A"), u1sn = get("U1SN"), impa = get("IMPA"), l1nb = get("L1NB_A"), inter = get("INTER");
  const inclination = (value: number | null, low: number, high: number): CephExpertDiagnosis["dentalAnalysis"]["upperIncisor"] =>
    value === null ? "indeterminate" : value > high ? "proclined" : value < low ? "retroclined" : "normal";
  const upperIncisor = u1na !== null ? inclination(u1na, 17, 27) : inclination(u1sn, 99, 109);
  const lowerIncisor = impa !== null ? inclination(impa, 85, 95) : inclination(l1nb, 19, 31);
  const dentalDetails: string[] = [];
  if (upperIncisor !== "indeterminate") dentalDetails.push(upperIncisor === "proclined" ? "القاطع العلوي مائل للأمام بالنسبة للمرجع المدمج" : upperIncisor === "retroclined" ? "القاطع العلوي مائل للخلف بالنسبة للمرجع المدمج" : "ميل القاطع العلوي داخل المدى المرجعي المدمج");
  if (lowerIncisor !== "indeterminate") dentalDetails.push(lowerIncisor === "proclined" ? "القاطع السفلي مائل للأمام بالنسبة للمرجع المدمج" : lowerIncisor === "retroclined" ? "القاطع السفلي مائل للخلف بالنسبة للمرجع المدمج" : "ميل القاطع السفلي داخل المدى المرجعي المدمج");
  for (const [label, value] of [["U1-NA", u1na], ["U1-SN", u1sn], ["IMPA", impa], ["L1-NB", l1nb]] as const) {
    if (value !== null) dentalDetails.push(`${label} = ${value}°`);
  }
  if (upperIncisor === "indeterminate") dentalDetails.push("ميل القواطع العلوية غير محدد: القياسات غير متاحة");
  if (lowerIncisor === "indeterminate") dentalDetails.push("ميل القواطع السفلية غير محدد: القياسات غير متاحة");
  const interincisalAr = inter === null ? "الزاوية القاطعية غير مقاسة" : `الزاوية القاطعية INTER = ${inter}°؛ لا تكفي وحدها لتحديد سبب الميل`;
  dentalDetails.push(interincisalAr);
  let compensationAr = "التعويض السني السنخي غير محسوم من هذه القياسات وحدها";
  if (classification === "Class III" && (upperIncisor === "proclined" || lowerIncisor === "retroclined")) {
    compensationAr = "ميل القواطع قد يتوافق مع تعويض للصنف الثالث؛ يحتاج مطابقة الإطباق والفحص السريري";
  } else if (classification === "Class II" && lowerIncisor === "proclined") {
    compensationAr = "ميل القاطع السفلي قد يتوافق مع تعويض للصنف الثاني؛ يحتاج مطابقة الإطباق والفحص السريري";
  }

  const naso = get("NASOLABIAL"), eUl = get("E_LINE_UL"), eLl = get("E_LINE_LL");
  // Bony convexity and ANB do not establish the soft-tissue profile or lip competence.
  const profileTypeAr = "شكل بروفايل الأنسجة الرخوة غير محدد من هذه القياسات وحدها";
  const lipCompetenceAr = "انطباق الشفاه غير محدد؛ يتطلب فحص سريري في وضع الراحة";
  const nasolabialAr = naso === null ? "الزاوية الأنفية الشفوية غير مقاسة" : `الزاوية الأنفية الشفوية = ${naso}°؛ لا تحدد وحدها بروز الشفة أو شكل الأنف`;
  const eLineAr = `خط ريكتس: الشفة العليا ${eUl === null ? "غير مقاسة" : `${eUl} مم`} · الشفة السفلى ${eLl === null ? "غير مقاسة" : `${eLl} مم`}`;
  const softTissueSummary = `${naso === null && eUl === null && eLl === null ? "قياسات الأنسجة الرخوة غير متاحة · " : ""}${profileTypeAr} · ${nasolabialAr} · ${eLineAr} · ${lipCompetenceAr}`;
  const extractionRationaleAr = "قرار القلع أو عدم القلع غير محدد؛ لا يُستنتج من القياسات السيفالومترية أو مؤشر واحد.";
  const narrativePlanAr = `${extractionRationaleAr}\nلا تصدر هذه القراءة توصية آلية بالتوسيع أو تعديل النمو أو الزرعات التقويمية أو الجراحة.\nيلزم فحص سريري، وتحليل المسافات والتزاحم والإطباق، وتقييم النسج الداعمة والنضج الهيكلي والبروفايل وأهداف المريض قبل أن يضع الطبيب خطة العلاج.`;
  return {
    sagittalSkeletal: { classification, severity: "indeterminate", descriptionAr: sagittalDesc, detailsAr: sagittalDetails,
      maxilla: position(sna, 82), mandible: position(snb, 80) },
    verticalSkeletal: { pattern: verticalPattern, descriptionAr: verticalDesc, detailsAr: verticalDetails, growthTendencyAr: growthTendency },
    dentalAnalysis: { descriptionAr: dentalDetails.join(" · "), detailsAr: dentalDetails, upperIncisor, lowerIncisor, compensationAr, interincisalAr },
    aestheticProfile: { profileTypeAr, lipCompetenceAr, nasolabialAr, eLineAr, summaryAr: softTissueSummary },
    treatmentRecommendations: { extractionDecision: "not-specified", extractionRationaleAr,
      // false means no automated recommendation, NOT a contraindication or ruling out treatment.
      growthModification: false, expansion: false, anchorageOrTADs: false, orthognathicSurgery: false, narrativePlanAr },
    formatted: { skeletal: `${sagittalDesc} · ${sagittalDetails.join(" · ")} · ${verticalDesc} · ${verticalDetails.join(" · ")}`,
      dental: `${dentalDetails.join(" · ")} · ${compensationAr}`, softTissue: softTissueSummary,
      finalDx: `قراءة وصفية أولية وليست تشخيصًا نهائيًا: ${sagittalDesc} · ${verticalDesc}`,
      recommendationsText: narrativePlanAr },
  };
}

/**
 * Legacy geometric template, retained for compatibility and synthetic tests only.
 * It consumes dimensions/anchors, not image pixels: it is NOT anatomical landmark
 * detection or a clinically validated patient tracing. No clinical UI/API invokes
 * this function. Existing saved landmarks are never changed by disabling its route.
 */
export function suggestLandmarks(
  imageWidth: number,
  imageHeight: number,
  existingLandmarks?: Partial<Record<LandmarkCode, Pt>>,
  patientInfo?: { age?: number; gender?: string },
): Record<LandmarkCode, Pt> {
  const w = Math.max(100, imageWidth);
  const h = Math.max(100, imageHeight);

  // إحداثيات قياسية موحّدة ومعايرة بدقة متناهية وفق معايير WebCeph المستخرجة من 15 حالة سريرية حقيقية
  // من مركز عقلان على منصة WebCeph (متوسطات وتوزيعات تشريحية حقيقية)
  const canonicalNorm: Record<LandmarkCode, Pt> = {
    S: { x: 0.3694, y: 0.3918 },     // مركز السرج التركي (Sella)
    N: { x: 0.6804, y: 0.3410 },     // درز العظم الأنفي الجبهي (Nasion)
    Or: { x: 0.6234, y: 0.4460 },    // أخفض نقطة على حافة الحجاج السفلي (Orbitale)
    Po: { x: 0.2708, y: 0.4601 },    // أعلى حافة مجرى السمع الظاهر (Porion)
    Ba: { x: 0.2639, y: 0.5252 },    // الحافة الأمامية للثقبة العظمى القاعدية (Basion)
    Co: { x: 0.3192, y: 0.4556 },    // قمة لقمة الفك السفلي (Condylion)
    Ar: { x: 0.3069, y: 0.4974 },    // نقطة التقاطع المفصلي (Articulare)
    ANS: { x: 0.7125, y: 0.5202 },   // الشوكة الأنفية الأمامية (Anterior Nasal Spine)
    PNS: { x: 0.4715, y: 0.5277 },   // الشوكة الأنفية الخلفية (Posterior Nasal Spine)
    A: { x: 0.6935, y: 0.5369 },     // النقطة A (أعمق نقطة بالفك العلوي)
    B: { x: 0.6753, y: 0.6813 },     // النقطة B (أعمق نقطة بالفك السفلي)
    Pog: { x: 0.6827, y: 0.7192 },   // أقصى بروز عظمي لذقن الفك السفلي (Pogonion)
    Gn: { x: 0.6753, y: 0.7375 },    // ناثيون (Gnathion - بين Pog و Me)
    Me: { x: 0.6505, y: 0.7472 },    // منتون (Menton - أخفض نقطة في الارتفاق الذقني)
    Go: { x: 0.3506, y: 0.6430 },    // جونيون (Gonion - زاوية الفك السفلي)
    D: { x: 0.6779, y: 0.7038 },     // مركز الارتفاق الذقني (PM / Symphysis center)
    U1A: { x: 0.6718, y: 0.5465 },   // ذروة جذر القاطع العلوي (U1 Root Tip)
    U1: { x: 0.7209, y: 0.6170 },    // حافة القاطع العلوي القاطعة (U1 Incisal Tip)
    L1A: { x: 0.6654, y: 0.6680 },   // ذروة جذر القاطع السفلي (L1 Root Tip)
    L1: { x: 0.7065, y: 0.6111 },    // حافة القاطع السفلي القاطعة (L1 Incisal Tip)
    OcclA: { x: 0.7137, y: 0.6140 },  // نقطة الإطباق الأمامية (Anterior occlusal point)
    OcclP: { x: 0.5920, y: 0.6050 },  // نقطة الإطباق الخلفية (Posterior occlusal point)
    Prn: { x: 0.8287, y: 0.4934 },   // قمة الأنف الرخوة (Pronasale)
    Sn: { x: 0.7642, y: 0.5326 },    // تحت الأنف الرخوة (Subnasale)
    Ls: { x: 0.7638, y: 0.5685 },    // الشفة العليا (Labrale superius)
    Li: { x: 0.7577, y: 0.6458 },    // الشفة السفلى (Labrale inferius)
    PogS: { x: 0.7296, y: 0.7119 },  // ذقن الأنسجة الرخوة (Soft tissue Pogonion)
  };

  // إحداثيات الإطار المرجعي لقاعدة الجمجمة (S-N Frame Coordinates)
  // حيث تمثل S الأصل (0,0) و N النقطة (1,0)، والمحور العمودي لأسفل
  // إحداثيات قالب ثابت قديم؛ لا توجد هنا أدلة تحقق سريري أو كشف للمعالم من الصورة
  const snFrame: Record<LandmarkCode, { sx: number; sy: number }> = {
    S: { sx: 0, sy: 0 },
    N: { sx: 1, sy: 0 },
    Or: { sx: 0.7259, sy: 0.3917 },
    Po: { sx: -0.3613, sy: 0.2098 },
    Ba: { sx: -0.4457, sy: 0.4720 },
    Co: { sx: -0.2117, sy: 0.2245 },
    Ar: { sx: -0.2883, sy: 0.3875 },
    ANS: { sx: 0.9251, sy: 0.7593 },
    PNS: { sx: 0.1861, sy: 0.6227 },
    A: { sx: 0.8512, sy: 0.8133 },
    B: { sx: 0.6586, sy: 1.3907 },
    Pog: { sx: 0.6438, sy: 1.5503 },
    Gn: { sx: 0.6041, sy: 1.6190 },
    Me: { sx: 0.5203, sy: 1.6418 },
    Go: { sx: -0.2889, sy: 1.0102 },
    D: { sx: 0.6444, sy: 1.4837 },
    U1A: { sx: 0.7743, sy: 0.8374 },
    U1: { sx: 0.8581, sy: 1.1614 },
    L1A: { sx: 0.6406, sy: 1.3318 },
    L1: { sx: 0.8190, sy: 1.1264 },
    OcclA: { sx: 0.8385, sy: 1.1439 },
    OcclP: { sx: 0.4783, sy: 1.0211 },
    Prn: { sx: 1.3040, sy: 0.7277 },
    Sn: { sx: 1.0706, sy: 0.8443 },
    Ls: { sx: 1.0353, sy: 0.9910 },
    Li: { sx: 0.9423, sy: 1.3032 },
    PogS: { sx: 0.7937, sy: 1.5528 },
  };

  // إطار تعديل نمو الأطفال واليافعين (Pediatric Growth-Adjusted Frame <= 14 yrs)
  // حيث يكون الارتفاع الوجهي السفلي N-Me أقصر وزاوية الفك السفلي أكثر انفراجاً
  const pedSnFrame: Partial<Record<LandmarkCode, { sx: number; sy: number }>> = {
    Or: { sx: 0.7097, sy: 0.3833 },
    Po: { sx: -0.3555, sy: 0.1906 },
    Ba: { sx: -0.4304, sy: 0.4622 },
    Co: { sx: -0.2198, sy: 0.2050 },
    Ar: { sx: -0.2974, sy: 0.3580 },
    ANS: { sx: 0.8986, sy: 0.7092 },
    PNS: { sx: 0.1691, sy: 0.5620 },
    A: { sx: 0.8174, sy: 0.7508 },
    B: { sx: 0.6433, sy: 1.3447 },
    Pog: { sx: 0.6385, sy: 1.4687 },
    Gn: { sx: 0.6015, sy: 1.5259 },
    Me: { sx: 0.5186, sy: 1.5381 },
    Go: { sx: -0.2862, sy: 0.8908 },
    D: { sx: 0.6397, sy: 1.4079 },
    U1A: { sx: 0.7512, sy: 0.6863 },
    U1: { sx: 0.8258, sy: 1.0304 },
    L1A: { sx: 0.6392, sy: 1.3063 },
    L1: { sx: 0.7981, sy: 1.0352 },
    OcclA: { sx: 0.8124, sy: 1.0328 },
    OcclP: { sx: 0.4578, sy: 0.8958 },
    Prn: { sx: 1.2580, sy: 0.6694 },
    Sn: { sx: 1.0315, sy: 0.7945 },
    Ls: { sx: 1.0028, sy: 0.9207 },
    Li: { sx: 0.9145, sy: 1.1742 },
    PogS: { sx: 0.7712, sy: 1.4639 },
  };

  const existing = existingLandmarks ?? {};
  const hasSN = existing.S != null && existing.N != null;
  const hasNMe = !hasSN && existing.N != null && existing.Me != null;

  const result: Partial<Record<LandmarkCode, Pt>> = {};

  if (hasSN) {
    const sPt = existing.S!;
    const nPt = existing.N!;
    const dx = nPt.x - sPt.x;
    const dy = nPt.y - sPt.y;
    const snLen = Math.hypot(dx, dy);
    const cosA = snLen > 0 ? dx / snLen : 1;
    const sinA = snLen > 0 ? dy / snLen : 0;

    for (const def of LANDMARKS) {
      const code = def.code;
      if (existing[code] != null) {
        result[code] = { ...existing[code]! };
      } else {
        const frame = (patientInfo?.age != null && patientInfo.age <= 14)
          ? (pedSnFrame[code] ?? snFrame[code])
          : snFrame[code];
        
        // التحويل الدائري والتكبير من قاعدة الجمجمة S-N
        const rx = (frame.sx * cosA - frame.sy * sinA) * snLen;
        const ry = (frame.sx * sinA + frame.sy * cosA) * snLen;
        result[code] = {
          x: round1(sPt.x + rx),
          y: round1(sPt.y + ry),
        };
      }
    }
  } else if (hasNMe) {
    const p1Code: LandmarkCode = "N";
    const p2Code: LandmarkCode = "Me";
    const p1Actual = existing[p1Code]!;
    const p2Actual = existing[p2Code]!;
    const p1Canon = { x: canonicalNorm[p1Code].x * w, y: canonicalNorm[p1Code].y * h };
    const p2Canon = { x: canonicalNorm[p2Code].x * w, y: canonicalNorm[p2Code].y * h };

    const dxActual = p2Actual.x - p1Actual.x;
    const dyActual = p2Actual.y - p1Actual.y;
    const distActual = Math.hypot(dxActual, dyActual);

    const dxCanon = p2Canon.x - p1Canon.x;
    const dyCanon = p2Canon.y - p1Canon.y;
    const distCanon = Math.hypot(dxCanon, dyCanon);

    const scale = distCanon > 0 ? distActual / distCanon : 1;
    const angleActual = Math.atan2(dyActual, dxActual);
    const angleCanon = Math.atan2(dyCanon, dxCanon);
    const dAngle = angleActual - angleCanon;
    const cosA = Math.cos(dAngle);
    const sinA = Math.sin(dAngle);

    for (const def of LANDMARKS) {
      const code = def.code;
      if (existing[code] != null) {
        result[code] = { ...existing[code]! };
      } else {
        const cPt = { x: canonicalNorm[code].x * w, y: canonicalNorm[code].y * h };
        const rx = (cPt.x - p1Canon.x) * scale;
        const ry = (cPt.y - p1Canon.y) * scale;
        const rotX = rx * cosA - ry * sinA;
        const rotY = rx * sinA + ry * cosA;
        result[code] = {
          x: round1(p1Actual.x + rotX),
          y: round1(p1Actual.y + rotY),
        };
      }
    }
  } else {
    for (const def of LANDMARKS) {
      const code = def.code;
      if (existing[code] != null) {
        result[code] = { ...existing[code]! };
      } else {
        result[code] = {
          x: round1(canonicalNorm[code].x * w),
          y: round1(canonicalNorm[code].y * h),
        };
      }
    }
  }

  return result as Record<LandmarkCode, Pt>;
}

