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
 * تواجه اليمين، العرفُ القياسي)، وy يتزايد نحو الأسفل. القياسات كلها تعمل
 * مباشرةً على هذا النظام، والاختبارات تثبت الاتجاهات.
 */

/* ─────────────────────────── النقاط والهندسة ─────────────────────────── */

export interface Pt {
  x: number;
  y: number;
}

/** طول المتجه. */
export function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** الزاوية بين متجهين بالدرجات — ٠ إلى ١٨٠، لا تهمّ اتجاه y هنا. */
export function angleBetween(v1: Pt, v2: Pt): number {
  const m1 = Math.hypot(v1.x, v1.y);
  const m2 = Math.hypot(v2.x, v2.y);
  if (m1 === 0 || m2 === 0) return NaN;
  const cos = (v1.x * v2.x + v1.y * v2.y) / (m1 * m2);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
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
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const cross = dx * (p.y - a.y) - dy * (p.x - a.x);
  const len = Math.hypot(dx, dy);
  if (len === 0) return NaN;
  // القسمة على الطول تعطي المسافة الحقيقية، والسالب يثبّت «الأمام موجب».
  return -cross / len;
}

/** مسافة عمودية غير موقَّعة من نقطة إلى خطّ. */
export function perpDistance(p: Pt, a: Pt, b: Pt): number {
  return Math.abs(lateralOffset(p, a, b));
}

/** إسقاط نقطة على خطّ (a→b) — قدمُ العمود. */
export function projectOnLine(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { ...a };
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** تقريب إلى منزلة عشرية واحدة — عرضُ القياسات كلها. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/* ─────────────────────────── المعالم ─────────────────────────── */

/** رموز المعالم — قائمة مغلقة: كل معلم له اسم وموضع تشريحي معلوم. */
export type LandmarkCode =
  | "S" | "N" | "A" | "B" | "Pog" | "Me" | "Gn" | "Go"
  | "Or" | "Po" | "U1A" | "U1" | "L1A" | "L1" | "OcclA" | "OcclP"
  | "D" | "Co" | "ANS" | "PNS";

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
 * سجل المعالم العشرين.
 *
 * الوصف التشريحي لكل معلم هو الوصف القياسي المعروف — والغاية أن يقف الطبيب على
 * النقطة الصحيحة من الكلمة لا من الحفظ. الستة عشر الأولى إلزامية للاعتماد؛
 * والإضافية (D، Co، ANS، PNS) تخدم تحاليل بعينها (Steiner الموسّع، McNamara،
 * استواء الحنكي) فتوضع عند الحاجة دون أن تحجب اعتماد التحليل الأساسي.
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
  if (pixels <= 0) return NaN;
  return realMm / pixels;
}

/** تحويل طولٍ بالبكسل إلى مليمتر بمقياس معلوم.
 *
 * بلا مقياس (أو بمقياسٍ تالف) تعيد NaN لا صفرًا: صفرٌ مقنع أخطر من «—»،
 * فهو رقمٌ يُقرأ ويُعتمد ولم يُقس أصلًا.
 */
export function pixelsToMm(pixels: number, mmPerPixel: number): number {
  if (!Number.isFinite(mmPerPixel) || !Number.isFinite(pixels)) return NaN;
  return pixels * mmPerPixel;
}

/* ─────────────────────────── القياسات ─────────────────────────── */

export type MeasurementGroup = "sagittal" | "vertical" | "dental";

export const GROUP_LABEL: Record<MeasurementGroup, string> = {
  sagittal: "الهيكلي — أفقي",
  vertical: "الهيكلي — عمودي",
  dental: "الأسنان",
};

export interface MeasurementDef {
  code: string;
  ar: string;
  /** الاسم الإنجليزي المعتمد في الأدبيات — للتقرير ثنائي اللغة. */
  en: string;
  group: MeasurementGroup;
  unit: "°" | "mm" | "%";
  /** المعالم اللازمة لهذا القياس وحده. */
  needs: LandmarkCode[];
  /**
   * المعدل المرجعي من الأدبيات — وسيلةُ عيّناتٍ تُعرض للطبيب مرجعًا لا حكمًا.
   * `mean` و`tol` يحصران المدى المتعارف: [mean−tol, mean+tol].
   */
  mean: number;
  tol: number;
  /** كيف وُجد المعدل — يُعرض تحت الجدول بندرةِ المصدر. */
  source: string;
  /** تفسير اتجاه القيمة — يُعرض عند المزاج لمن يحتاجه. */
  note?: string;
}

/**
 * القياسات الثلاثون والثلاثين.
 *
 * كل تعريف تحته متجهاته حرفيًا. الرموز بأسمائها المتعارفة، والمجموعات ثلاثة:
 * أفقي هيكلي، وعمودي هيكلي، وأسنان. والمعدلات هنا هي الافتراضية المدمجة —
 * والنظام المرجعي في القاعدة (ceph_reference_sets) يقبل مجموعات محلية أغنى
 * (بالعمر والجنس والانحراف المعياري) تعرض بدلها حين تُختار للدراسة.
 */
export const MEASUREMENTS: MeasurementDef[] = [
  { code: "SNA", ar: "SNA — موضع الفك الأعلى", en: "SNA", group: "sagittal", unit: "°", needs: ["S", "N", "A"], mean: 82, tol: 2, source: "Steiner", note: "الأعلى: الفك الأعلى أكثر تقدمًا أو N خلفيّ الموضع" },
  { code: "SNB", ar: "SNB — موضع الفك الأسفل", en: "SNB", group: "sagittal", unit: "°", needs: ["S", "N", "B"], mean: 80, tol: 2, source: "Steiner", note: "الأعلى: الفك الأسفل أكثر تقدمًا؛ الأدنى: تراجعٌ عن SN" },
  { code: "ANB", ar: "ANB — العلاقة الفكية", en: "ANB", group: "sagittal", unit: "°", needs: ["S", "N", "A", "B"], mean: 2, tol: 2, source: "Steiner", note: "فوق المدى: نحو الصنف الثاني؛ تحت الصفر: نحو الثالث" },
  { code: "SND", ar: "SND — موضع وسط الارتفاق", en: "S-N-D", group: "sagittal", unit: "°", needs: ["S", "N", "D"], mean: 77, tol: 2, source: "Steiner", note: "يقرأ موضع وسط الذقن دون تأثير قمة الارتفاق" },
  { code: "WITS", ar: "WITS — علاقة الفكّين على الإطباقية", en: "Wits appraisal", group: "sagittal", unit: "mm", needs: ["A", "B", "OcclA", "OcclP"], mean: -1, tol: 1, source: "Jacobson", note: "الأعلى نحو الصنف الثاني — ويتأثر بميل مستوى الإطباق" },
  { code: "CONV", ar: "التحدّب — A على خط N-Pog", en: "Convexity (A to N-Pog)", group: "sagittal", unit: "mm", needs: ["A", "N", "Pog"], mean: 0, tol: 2, source: "Downs", note: "الأعلى (أمام الخط): نحو الصنف الثالث؛ الأدنى: نحو الثاني" },
  { code: "CONV_ANGLE", ar: "زاوية التحدّب N-A-Pog", en: "Angle of convexity", group: "sagittal", unit: "°", needs: ["N", "A", "Pog"], mean: 180, tol: 5.1, source: "Downs", note: "١٨٠ استقامة كاملة؛ الأصغر بروفايل أكثر تحدبًا (نحو الصنف الثاني)" },
  { code: "AB_PLANE", ar: "زاوية مستوى A-B مع الخط الوجهي", en: "A-B plane angle", group: "sagittal", unit: "°", needs: ["N", "Pog", "A", "B"], mean: 4.6, tol: 3.9, source: "Downs", note: "القيمة الحادة بين المستقيمين — إشارة الصنف تُقرأ من ANB وWITS" },
  { code: "FANGLE", ar: "الزاوية الوجهية FH-NPog", en: "Facial angle", group: "sagittal", unit: "°", needs: ["N", "Pog", "Or", "Po"], mean: 87, tol: 3, source: "Downs", note: "الأعلى: ذقنٌ أكثر تقدمًا" },
  { code: "MAX_LEN", ar: "الطول الفعلي للفك الأعلى Co-A", en: "Effective maxillary length", group: "sagittal", unit: "mm", needs: ["Co", "A"], mean: 90, tol: 5, source: "McNamara (بالغة — تقريبي)", note: "معدلات McNamara بعمر المريض — تُحسّن بمجموعة مرجعية محلية" },
  { code: "MAND_LEN", ar: "الطول الفعلي للفك الأسفل Co-Gn", en: "Effective mandibular length", group: "sagittal", unit: "mm", needs: ["Co", "Gn"], mean: 122, tol: 5, source: "McNamara (بالغة — تقريبي)" },
  { code: "MM_DIFF", ar: "الفرق الفعلي بين الفكّين", en: "Maxillomandibular differential", group: "sagittal", unit: "mm", needs: ["Co", "A", "Gn"], mean: 30, tol: 5, source: "McNamara (بالغة — تقريبي)", note: "طول الفك الأسفل ناقص الأعلى — مشتق من القياسين" },
  { code: "A_NPERP", ar: "بُعد A عن عمود N", en: "A to N-perpendicular", group: "sagittal", unit: "mm", needs: ["N", "Or", "Po", "A"], mean: 1, tol: 2, source: "McNamara", note: "الأمام موجب: الأعلى فكٌ أعلى متقدم عن العمود الفقوي الوجهي" },
  { code: "POG_NPERP", ar: "بُعد Pog عن عمود N", en: "Pog to N-perpendicular", group: "sagittal", unit: "mm", needs: ["N", "Or", "Po", "Pog"], mean: 0, tol: 3, source: "McNamara", note: "الأمام موجب؛ الأدنى يعني ذقنًا خلف العمود" },
  { code: "FMA", ar: "FMA — FH مع مستوى الفك السفلي", en: "FMA", group: "vertical", unit: "°", needs: ["Or", "Po", "Me", "Go"], mean: 25, tol: 3, source: "Tweed", note: "الأعلى: نموٌّ مائل للأفقي؛ الأدنى: للعمقي" },
  { code: "SNGOGN", ar: "SN-GoGn — انحدار الفك", en: "SN-GoGn", group: "vertical", unit: "°", needs: ["S", "N", "Me", "Go"], mean: 32, tol: 5, source: "Steiner" },
  { code: "JARABAK", ar: "نسبة Jarabak — (S-Go)/(N-Me)", en: "Jarabak ratio", group: "vertical", unit: "%", needs: ["S", "N", "Me", "Go"], mean: 65, tol: 5, source: "Jarabak", note: "الأدنى من ٦٢: اتجاه عمودي؛ الأعلى من ٦٨: اتجاه أفقي تقريبًا" },
  { code: "SN_OCCL", ar: "مستوى الإطباق مع SN", en: "SN to occlusal plane", group: "vertical", unit: "°", needs: ["S", "N", "OcclA", "OcclP"], mean: 14, tol: 2, source: "Steiner" },
  { code: "OCCL_FH", ar: "مستوى الإطباق مع FH", en: "Occlusal plane to FH", group: "vertical", unit: "°", needs: ["Or", "Po", "OcclA", "OcclP"], mean: 9.4, tol: 4, source: "Downs" },
  { code: "YAXIS", ar: "محور Y — SGn مع SN", en: "Y-axis (SGn-SN)", group: "vertical", unit: "°", needs: ["S", "N", "Gn"], mean: 67, tol: 5, source: "Steiner" },
  { code: "YAXIS_FH", ar: "محور Y — SGn مع FH (داونز)", en: "Y-axis (SGn-FH)", group: "vertical", unit: "°", needs: ["S", "Gn", "Or", "Po"], mean: 59.4, tol: 3.9, source: "Downs", note: "الأعلى: نموٌّ أكثر عموديةً (ميل للأفقي)" },
  { code: "LAFH", ar: "الطول الوجهي الأمامي السفلي ANS-Me", en: "Lower anterior facial height", group: "vertical", unit: "mm", needs: ["ANS", "Me"], mean: 66, tol: 5, source: "McNamara (بالغة — تقريبي)" },
  { code: "IMPA", ar: "IMPA — القاطع السفلي مع الفك", en: "IMPA", group: "dental", unit: "°", needs: ["L1A", "L1", "Me", "Go"], mean: 90, tol: 5, source: "Tweed", note: "الأعلى: قاطعٌ سفلي مائل للأمام" },
  { code: "FMIA", ar: "FMIA — القاطع السفلي مع FH", en: "FMIA", group: "dental", unit: "°", needs: ["Or", "Po", "L1A", "L1", "Me", "Go"], mean: 65, tol: 7, source: "Tweed", note: "مثلث Tweed: FMA + IMPA + FMIA = ١٨٠" },
  { code: "U1SN", ar: "U1-SN — ميل القاطع العلوي", en: "U1 to SN", group: "dental", unit: "°", needs: ["S", "N", "U1A", "U1"], mean: 104, tol: 5, source: "Steiner" },
  { code: "U1NA_A", ar: "زاوية U1-NA", en: "U1 to NA (angle)", group: "dental", unit: "°", needs: ["N", "A", "U1A", "U1"], mean: 22, tol: 5, source: "Steiner" },
  { code: "U1NA_D", ar: "بُعد U1-NA (مم)", en: "U1 to NA (linear)", group: "dental", unit: "mm", needs: ["N", "A", "U1"], mean: 4, tol: 2, source: "Steiner", note: "الأمام موجب" },
  { code: "L1NB_A", ar: "زاوية L1-NB", en: "L1 to NB (angle)", group: "dental", unit: "°", needs: ["N", "B", "L1A", "L1"], mean: 25, tol: 6, source: "Steiner" },
  { code: "L1NB_D", ar: "بُعد L1-NB (مم)", en: "L1 to NB (linear)", group: "dental", unit: "mm", needs: ["N", "B", "L1"], mean: 4, tol: 2, source: "Steiner", note: "الأمام موجب — ويقارَب مع بُعد Pog-NB في التوازن" },
  { code: "POG_NB_D", ar: "بُعد Pog-NB (مم)", en: "Pog to NB (linear)", group: "dental", unit: "mm", needs: ["N", "B", "Pog"], mean: 1, tol: 1, source: "Steiner", note: "قياس التوازن الذقني: يقترب من بُعد L1-NB في التوازن" },
  { code: "INTER", ar: "الزاوية القاطعية U1-L1", en: "Interincisal angle", group: "dental", unit: "°", needs: ["U1A", "U1", "L1A", "L1"], mean: 130, tol: 6, source: "Steiner", note: "الأدنى: بروزٌ قاطعيّ متبادل؛ الأعلى: ارتداد" },
  { code: "U1_APOG", ar: "بُعد U1 عن خط A-Pog (مم)", en: "U1 to A-Pog (linear)", group: "dental", unit: "mm", needs: ["A", "Pog", "U1"], mean: 1, tol: 2, source: "Ricketts", note: "الأمام موجب — مرجع موضع القاطع العلوي إلى الخط الشفوي العظمي" },
];

const MEASUREMENT_SET: ReadonlySet<string> = new Set(MEASUREMENTS.map((m) => m.code));

export function isCephMeasurementCode(value: unknown): value is string {
  return typeof value === "string" && MEASUREMENT_SET.has(value);
}

export type LandmarkMap = Partial<Record<LandmarkCode, Pt>>;

/**
 * قيمة قياسٍ واحد من خريطة معالم — نفس الدوالّ التي تُختم في القاعدة عند الاعتماد.
 *
 * كل فرع موثَّق بمتجهاته. والقياسات الطولية (mm) تُضرب في المقياس؛ وغباءُ
 * المقياس (NaN) يجعلها غير متاحة بينما الزوايا تعمل — فالطبيب يرى الأنغام قبل
 * أن تكتمل المعايرة.
 */
export function measure(code: string, L: LandmarkMap, mmPerPixel: number): number {
  const p = (c: LandmarkCode): Pt => L[c] as Pt;
  const has = (...cs: LandmarkCode[]): boolean => cs.every((c) => L[c] != null);

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
      // قدمُ العمود لكلٍّ من A وB على مستوى الإطباق، ثم المسافة بينهما على
      // اتجاه المستوى نفسه موجبًا نحو الأمام. القيم الأكبر نحو الصنف الثاني.
      const fa = projectOnLine(p("A"), p("OcclA"), p("OcclP"));
      const fb = projectOnLine(p("B"), p("OcclA"), p("OcclP"));
      let dir = vec(fb, fa);
      if (dir.x < 0) dir = { x: -dir.x, y: -dir.y };
      const len = Math.hypot(dir.x, dir.y);
      if (len === 0) return NaN;
      const along = ((fa.x - fb.x) * dir.x + (fa.y - fb.y) * dir.y) / len;
      return pixelsToMm(along, mmPerPixel);
    }
    case "CONV": {
      if (!has("A", "N", "Pog")) return NaN;
      return pixelsToMm(lateralOffset(p("A"), p("N"), p("Pog")), mmPerPixel);
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
      if (!has("S", "N", "Me", "Go")) return NaN;
      return angleBetween(vec(p("S"), p("N")), vec(p("Go"), p("Me")));
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
      return pixelsToMm(lateralOffset(p("U1"), p("N"), p("A")), mmPerPixel);
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
      return pixelsToMm(lateralOffset(p("L1"), p("N"), p("B")), mmPerPixel);
    }
    case "INTER": {
      if (!has("U1A", "U1", "L1A", "L1")) return NaN;
      return 180 - angleBetween(vec(p("U1A"), p("U1")), vec(p("L1A"), p("L1")));
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
      return pixelsToMm(lateralOffset(p("Pog"), p("N"), p("B")), mmPerPixel);
    }
    case "SN_OCCL": {
      if (!has("S", "N", "OcclA", "OcclP")) return NaN;
      return angleBetween(vec(p("S"), p("N")), vec(p("OcclP"), p("OcclA")));
    }
    case "CONV_ANGLE": {
      if (!has("N", "A", "Pog")) return NaN;
      // زاوية N-A-Pog الخام عند A: الاستقامة ١٨٠ — والأصغر تحدّب أكثر.
      return angleAtVertex(p("A"), p("N"), p("Pog"));
    }
    case "AB_PLANE": {
      if (!has("N", "Pog", "A", "B")) return NaN;
      // الزاوية الحادة بين مستقيمي A-B وN-Pog — بلا إشارة صنف.
      const a = angleBetween(vec(p("A"), p("B")), vec(p("N"), p("Pog")));
      return a > 90 ? 180 - a : a;
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
      return pixelsToMm(lateralOffset(p("U1"), p("A"), p("Pog")), mmPerPixel);
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
      // عمود Naser: مستقيم من N عموديًا على FH. موجبه الأمام — ولذلك يوجَّه
      // المستقيم نحو أسفل الشاشة (الجانب الشرقي عنه هو الأمام، كما ثبت بالاختبار).
      const fh = vec(p("Po"), p("Or"));
      const len = Math.hypot(fh.x, fh.y);
      if (len === 0) return NaN;
      const down = { x: (-fh.y / len) * 100, y: (fh.x / len) * 100 };
      const anchor = { x: p("N").x + down.x, y: p("N").y + down.y };
      return pixelsToMm(lateralOffset(p(target as LandmarkCode), p("N"), anchor), mmPerPixel);
    }
    case "LAFH": {
      if (!has("ANS", "Me")) return NaN;
      return pixelsToMm(dist(p("ANS"), p("Me")), mmPerPixel);
    }
    default:
      return NaN;
  }
}

export type MeasurementStatus = "within" | "above" | "below";

/** موضع القيمة من المدى المرجعي — للعرض بالألوان لا للحكم. */
export function interpret(value: number, def: MeasurementDef): MeasurementStatus | null {
  if (!Number.isFinite(value)) return null;
  if (value > def.mean + def.tol) return "above";
  if (value < def.mean - def.tol) return "below";
  return "within";
}

export interface MeasurementResult {
  code: string;
  ar: string;
  unit: string;
  group: MeasurementGroup;
  value: number | null;
  display: string;
  mean: number;
  tol: number;
  status: MeasurementStatus | null;
  source: string;
  note?: string;
}

/** كل القياسات دفعةً واحدة — جداول الشاشة الحية ولقطة الاعتماد على السواء. */
export function computeAll(L: LandmarkMap, mmPerPixel: number): MeasurementResult[] {
  return MEASUREMENTS.map((def) => {
    const value = measure(def.code, L, mmPerPixel);
    const ok = Number.isFinite(value);
    return {
      code: def.code,
      ar: def.ar,
      unit: def.unit,
      group: def.group,
      value: ok ? round1(value) : null,
      display: ok ? String(round1(value)) : "—",
      mean: def.mean,
      tol: def.tol,
      status: interpret(value, def),
      source: def.source,
      note: def.note,
    };
  });
}

/** القياسات التي ما زال ناقصها معلمًا — تُعرض دليلًا للطبيب قبل الاعتماد. */
export function missingFor(code: string, L: LandmarkMap): LandmarkCode[] {
  const def = MEASUREMENTS.find((m) => m.code === code);
  if (!def) return [];
  return def.needs.filter((c) => L[c] == null);
}

/* ─────────────────────────── خلاصة الحالة ─────────────────────────── */

export interface CephSummary {
  /** الصنف الهيكلي من ANB — والمقصود به العلاقة لا التشخيص. */
  skeletal: string;
  /** اتجاه النمو العمودي من FMA وSN-GoGn. */
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
  const anb = results.find((r) => r.code === "ANB")?.value ?? null;
  const fma = results.find((r) => r.code === "FMA")?.value ?? null;
  const sngogn = results.find((r) => r.code === "SNGOGN")?.value ?? null;

  let skeletal = "— أكمل قياس ANB —";
  if (anb != null && Number.isFinite(anb)) {
    if (anb > 4) skeletal = "نحو علاقة هيكلية صنف ثانٍ (ANB أكبر من المعدل)";
    else if (anb < 0) skeletal = "نحو علاقة هيكلية صنف ثالث (ANB سالب)";
    else skeletal = "علاقة هيكلية صنف أول تقريبًا (ANB داخل المدى)";
  }

  let vertical = "— أكمل قياس FMA —";
  if (fma != null && Number.isFinite(fma) && sngogn != null && Number.isFinite(sngogn)) {
    if (fma > 31 || sngogn > 39) vertical = "نموّ عمودي مائل للأفقي (زاوية الفك مفتوحة)";
    else if (fma < 19 || sngogn < 27) vertical = "نموّ عمودي مائل للعمقي (زاوية الفك مغمدة)";
    else vertical = "نموّ عمودي متوازن تقريبًا";
  }

  return { skeletal, vertical };
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
    const ref = refs?.[r.code];
    const mean = ref ? ref.mean : r.mean;
    const sd = ref ? ref.sd : r.tol;
    if (r.value == null || !Number.isFinite(mean) || !Number.isFinite(sd) || sd <= 0) {
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
  const get = (code: string): number | null => results.find((r) => r.code === code)?.value ?? null;
  const summary = summarize(results);

  const parts: string[] = [];
  const u1 = get("U1NA_A");
  if (u1 != null && Number.isFinite(u1)) {
    if (u1 > 27) parts.push("القاطع العلوي مائل للأمام (U1-NA أعلى من المدى)");
    else if (u1 < 17) parts.push("القاطع العلوي مائل للخلف (U1-NA أدنى من المدى)");
    else parts.push("ميل القاطع العلوي داخل المدى تقريبًا");
  }
  const l1 = get("L1NB_A");
  if (l1 != null && Number.isFinite(l1)) {
    if (l1 > 31) parts.push("القاطع السفلي مائل للأمام (L1-NB أعلى من المدى)");
    else if (l1 < 19) parts.push("القاطع السفلي مائل للخلف (L1-NB أدنى من المدى)");
    else parts.push("ميل القاطع السفلي داخل المدى تقريبًا");
  }

  return {
    skeletal: `${summary.skeletal} · ${summary.vertical}`,
    dental: parts.length > 0 ? parts.join(" · ") : "— أكمل قياسات القواطع ليصدر اقتراح الأسنان —",
    softTissue: "لم تُوضع معالم الأنسجة الرخوة بعد — هذا القسم غير متاح في هذه المرحلة.",
  };
}
