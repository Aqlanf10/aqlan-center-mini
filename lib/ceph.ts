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
  | "D" | "Co" | "ANS" | "PNS"
  | "Prn" | "Sn" | "Ls" | "Li" | "PogS";

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
 * سجل المعالم الخمسة والعشرين.
 *
 * الوصف التشريحي لكل معلم هو الوصف القياسي المعروف — والغاية أن يقف الطبيب على
 * النقطة الصحيحة من الكلمة لا من الحفظ. الستة عشر الأولى إلزامية للاعتماد؛
 * والإضافية (D، Co، ANS، PNS، ومعالم الأنسجة الرخوة والبروفايل Prn، Sn، Ls، Li، PogS)
 * تخدم تحاليل بعينها فتوضع عند الحاجة دون أن تحجب اعتماد التحليل الأساسي.
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

export type MeasurementGroup = "sagittal" | "vertical" | "dental" | "softTissue";

export const GROUP_LABEL: Record<MeasurementGroup, string> = {
  sagittal: "الهيكلي — أفقي",
  vertical: "الهيكلي — عمودي",
  dental: "الأسنان",
  softTissue: "الأنسجة الرخوة والبروفايل",
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
 * القياسات السيفالومترية الستة والثلاثون.
 *
 * كل تعريف تحته متجهاته حرفيًا. الرموز بأسمائها المتعارفة، والمجموعات أربعة:
 * أفقي هيكلي، وعمودي هيكلي، وأسنان، وأنسجة رخوة وبروفايل جمالي. والمعدلات
 * هنا هي الافتراضية المدمجة — والنظام المرجعي في القاعدة (ceph_reference_sets)
 * يقبل مجموعات محلية أغنى (بالعمر والجنس والانحراف المعياري) تعرض بدلها حين تُختار للدراسة.
 */
export const MEASUREMENTS: MeasurementDef[] = [
  { code: "SNA", ar: "SNA — موضع الفك الأعلى", en: "SNA", group: "sagittal", unit: "°", needs: ["S", "N", "A"], mean: 82, tol: 2, source: "Steiner", note: "الأعلى: الفك الأعلى أكثر تقدمًا أو N خلفيّ الموضع" },
  { code: "SNB", ar: "SNB — موضع الفك الأسفل", en: "SNB", group: "sagittal", unit: "°", needs: ["S", "N", "B"], mean: 80, tol: 2, source: "Steiner", note: "الأعلى: الفك الأسفل أكثر تقدمًا؛ الأدنى: تراجعٌ عن SN" },
  { code: "ANB", ar: "ANB — العلاقة الفكية", en: "ANB", group: "sagittal", unit: "°", needs: ["S", "N", "A", "B"], mean: 2, tol: 2, source: "Steiner", note: "فوق المدى: نحو الصنف الثاني؛ تحت الصفر: نحو الثالث" },
  { code: "SND", ar: "SND — موضع وسط الارتفاق", en: "S-N-D", group: "sagittal", unit: "°", needs: ["S", "N", "D"], mean: 77, tol: 2, source: "Steiner", note: "يقرأ موضع وسط الذقن دون تأثير قمة الارتفاق" },
  { code: "WITS", ar: "WITS — علاقة الفكّين على الإطباقية", en: "Wits appraisal", group: "sagittal", unit: "mm", needs: ["A", "B", "OcclA", "OcclP"], mean: -1, tol: 1, source: "Jacobson", note: "الأعلى نحو الصنف الثاني — والمنشور (Jacobson): −١ للذكور و٠ للإناث؛ ويتأثر بميل مستوى الإطباق" },
  { code: "CONV", ar: "التحدّب — A على خط N-Pog", en: "Convexity (A to N-Pog)", group: "sagittal", unit: "mm", needs: ["A", "N", "Pog"], mean: 0, tol: 2, source: "Downs", note: "الأمام موجب — أمام الخط نحو الصنف الثاني (بروفايل محدب)؛ وخلفه نحو الثالث" },
  { code: "CONV_ANGLE", ar: "زاوية التحدّب N-A-Pog", en: "Angle of convexity", group: "sagittal", unit: "°", needs: ["N", "A", "Pog"], mean: 0, tol: 5.1, source: "Downs", note: "موقَّعة كما نشرها Downs: موجب بروفايل محدب (نحو الصنف الثاني) وسالب مقعّد (نحو الثالث) — والمدى المنشور −8.5 إلى +10" },
  { code: "AB_PLANE", ar: "زاوية مستوى A-B مع الخط الوجهي", en: "A-B plane angle", group: "sagittal", unit: "°", needs: ["N", "Pog", "A", "B"], mean: -4.6, tol: 3.9, source: "Downs", note: "موقَّعة كما نشرها Downs: سالب نحو الصنف الثاني (ارتداد B عن A) وموجب نحو الثالث" },
  { code: "FANGLE", ar: "الزاوية الوجهية FH-NPog", en: "Facial angle", group: "sagittal", unit: "°", needs: ["N", "Pog", "Or", "Po"], mean: 87.8, tol: 3.6, source: "Downs", note: "الأعلى: ذقنٌ أكثر تقدمًا" },
  { code: "MAX_LEN", ar: "الطول الفعلي للفك الأعلى Co-A", en: "Effective maxillary length", group: "sagittal", unit: "mm", needs: ["Co", "A"], mean: 94, tol: 5, source: "McNamara 1984", note: "McNamara ١٩٨٤: البالغة ≈٩٤ مم والذكر أعلى — تُحسّن بمجموعة مرجعية بالعمر والجنس" },
  { code: "MAND_LEN", ar: "الطول الفعلي للفك الأسفل Co-Gn", en: "Effective mandibular length", group: "sagittal", unit: "mm", needs: ["Co", "Gn"], mean: 122, tol: 5, source: "McNamara 1984", note: "McNamara ١٩٨٤: ١٢٠–١٢٣ مم للبالغة مع Co-A ≈٩٤" },
  { code: "MM_DIFF", ar: "الفرق الفعلي بين الفكّين", en: "Maxillomandibular differential", group: "sagittal", unit: "mm", needs: ["Co", "A", "Gn"], mean: 28, tol: 4, source: "McNamara 1984", note: "McNamara ١٩٨٤: ٢٦–٢٩ مم للبالغة والذكر أعلى قليلًا — مشتق من القياسين" },
  { code: "A_NPERP", ar: "بُعد A عن عمود N", en: "A to N-perpendicular", group: "sagittal", unit: "mm", needs: ["N", "Or", "Po", "A"], mean: 0.5, tol: 0.5, source: "McNamara", note: "الأمام موجب — والمنشور (McNamara): من ٠ إلى +١ مم أمام العمود للبالغين" },
  { code: "POG_NPERP", ar: "بُعد Pog عن عمود N", en: "Pog to N-perpendicular", group: "sagittal", unit: "mm", needs: ["N", "Or", "Po", "Pog"], mean: -2, tol: 2, source: "McNamara", note: "الأمام موجب — والمنشور (McNamara): من −٤ إلى ٠ مم خلف العمود للبالغين، والإناث −٤ إلى −٢" },
  { code: "FMA", ar: "FMA — FH مع مستوى الفك السفلي", en: "FMA", group: "vertical", unit: "°", needs: ["Or", "Po", "Me", "Go"], mean: 25, tol: 3, source: "Tweed", note: "الأعلى: نموٌّ مائل للأفقي؛ الأدنى: للعمقي" },
  { code: "SNGOGN", ar: "SN-GoGn — انحدار الفك", en: "SN-GoGn", group: "vertical", unit: "°", needs: ["S", "N", "Me", "Go"], mean: 32, tol: 5, source: "Steiner" },
  { code: "JARABAK", ar: "نسبة Jarabak — (S-Go)/(N-Me)", en: "Jarabak ratio", group: "vertical", unit: "%", needs: ["S", "N", "Me", "Go"], mean: 65, tol: 5, source: "Jarabak", note: "الأدنى من ٦٢: اتجاه عمودي؛ الأعلى من ٦٨: اتجاه أفقي تقريبًا" },
  { code: "SN_OCCL", ar: "مستوى الإطباق مع SN", en: "SN to occlusal plane", group: "vertical", unit: "°", needs: ["S", "N", "OcclA", "OcclP"], mean: 14, tol: 2, source: "Steiner" },
  { code: "OCCL_FH", ar: "مستوى الإطباق مع FH", en: "Occlusal plane to FH", group: "vertical", unit: "°", needs: ["Or", "Po", "OcclA", "OcclP"], mean: 9.3, tol: 3.8, source: "Downs" },
  { code: "YAXIS", ar: "محور Y — SGn مع SN", en: "Y-axis (SGn-SN)", group: "vertical", unit: "°", needs: ["S", "N", "Gn"], mean: 67, tol: 5, source: "Steiner" },
  { code: "YAXIS_FH", ar: "محور Y — SGn مع FH (داونز)", en: "Y-axis (SGn-FH)", group: "vertical", unit: "°", needs: ["S", "Gn", "Or", "Po"], mean: 59.4, tol: 3.9, source: "Downs", note: "الأعلى: نموٌّ أكثر عموديةً (ميل للأفقي)" },
  { code: "LAFH", ar: "نسبة الطول الوجهي الأمامي السفلي", en: "Lower anterior facial height ratio", group: "vertical", unit: "%", needs: ["N", "ANS", "Me"], mean: 55, tol: 3, source: "McNamara", note: "ANS-Me نسبةً من N-Me — والمنشور ≈٥٥٪" },
  { code: "IMPA", ar: "IMPA — القاطع السفلي مع الفك", en: "IMPA", group: "dental", unit: "°", needs: ["L1A", "L1", "Me", "Go"], mean: 90, tol: 5, source: "Tweed", note: "الأعلى: قاطعٌ سفلي مائل للأمام" },
  { code: "FMIA", ar: "FMIA — القاطع السفلي مع FH", en: "FMIA", group: "dental", unit: "°", needs: ["Or", "Po", "L1A", "L1", "Me", "Go"], mean: 65, tol: 7, source: "Tweed", note: "مثلث Tweed: FMA + IMPA + FMIA = ١٨٠" },
  { code: "U1SN", ar: "U1-SN — ميل القاطع العلوي", en: "U1 to SN", group: "dental", unit: "°", needs: ["S", "N", "U1A", "U1"], mean: 104, tol: 5, source: "Steiner" },
  { code: "U1NA_A", ar: "زاوية U1-NA", en: "U1 to NA (angle)", group: "dental", unit: "°", needs: ["N", "A", "U1A", "U1"], mean: 22, tol: 5, source: "Steiner" },
  { code: "U1NA_D", ar: "بُعد U1-NA (مم)", en: "U1 to NA (linear)", group: "dental", unit: "mm", needs: ["N", "A", "U1"], mean: 4, tol: 2, source: "Steiner", note: "الأمام موجب" },
  { code: "L1NB_A", ar: "زاوية L1-NB", en: "L1 to NB (angle)", group: "dental", unit: "°", needs: ["N", "B", "L1A", "L1"], mean: 25, tol: 6, source: "Steiner" },
  { code: "L1NB_D", ar: "بُعد L1-NB (مم)", en: "L1 to NB (linear)", group: "dental", unit: "mm", needs: ["N", "B", "L1"], mean: 4, tol: 2, source: "Steiner", note: "الأمام موجب — ويقارَب مع بُعد Pog-NB في التوازن" },
  { code: "POG_NB_D", ar: "بُعد Pog-NB (مم)", en: "Pog to NB (linear)", group: "dental", unit: "mm", needs: ["N", "B", "Pog"], mean: 1, tol: 1, source: "Steiner", note: "قياس التوازن الذقني: يقترب من بُعد L1-NB في التوازن" },
  { code: "INTER", ar: "الزاوية القاطعية U1-L1", en: "Interincisal angle", group: "dental", unit: "°", needs: ["U1A", "U1", "L1A", "L1"], mean: 130, tol: 6, source: "Steiner", note: "الأدنى: بروزٌ قاطعيّ متبادل؛ الأعلى: ارتداد" },
  { code: "L1OP", ar: "القاطع السفلي مع الإطباقية", en: "L1 to occlusal plane", group: "dental", unit: "°", needs: ["OcclA", "OcclP", "L1A", "L1"], mean: 14.5, tol: 5.5, source: "Downs", note: "انحراف محور القاطع السفلي عن عمود مستوى الإطباق — يُقرأ كما نشره Downs مقدارًا موجبًا (٠ = عمودي على المستوى) والمدى المنشور 3.5 إلى 20" },
  { code: "U1_APOG", ar: "بُعد U1 عن خط A-Pog (مم)", en: "U1 to A-Pog (linear)", group: "dental", unit: "mm", needs: ["A", "Pog", "U1"], mean: 1, tol: 2, source: "Ricketts", note: "الأمام موجب — مرجع موضع القاطع العلوي إلى الخط الشفوي العظمي" },
  { code: "E_LINE_UL", ar: "بعد الشفة العليا عن خط ريكتس E-Line (مم)", en: "Upper lip to E-Line", group: "softTissue", unit: "mm", needs: ["Prn", "PogS", "Ls"], mean: -4, tol: 2, source: "Ricketts", note: "الخط الجمالي Prn-PogS: الشفة العليا تقع خلف الخط بمقدار −4 مم تقريبًا لدى البالغين، والأمام موجب" },
  { code: "E_LINE_LL", ar: "بعد الشفة السفلى عن خط ريكتس E-Line (مم)", en: "Lower lip to E-Line", group: "softTissue", unit: "mm", needs: ["Prn", "PogS", "Li"], mean: -2, tol: 2, source: "Ricketts", note: "الشفة السفلى تقع خلف خط ريكتس بمقدار −2 مم تقريبًا، والأمام موجب" },
  { code: "NASOLABIAL", ar: "الزاوية الأنفية الشفوية Prn-Sn-Ls", en: "Nasolabial angle", group: "softTissue", unit: "°", needs: ["Prn", "Sn", "Ls"], mean: 102, tol: 8, source: "Holdaway / McNamara", note: "الزاوية عند Sn بين Prn وLs: الحادة (<90°) تشير لبروز الشفة أو انحدار الأنف، والمنفرجة (>110°) لتراجع الشفة" },
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
      return pixelsToMm(lateralOffset(p("Pog"), p("N"), p("B")), mmPerPixel);
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
      return lateralOffset(p("A"), p("N"), p("Pog")) >= 0 ? dev : -dev;
    }
    case "AB_PLANE": {
      if (!has("N", "Pog", "A", "B")) return NaN;
      // قراءة Downs الموقّعة كما نشرها (المتوسط −4.6): دوران مستقيم A-B عن
      // الخط الوجهي N-Pog بإشارته — سالبٌ حين يرتد B خلف A نحو الصنف الثاني
      // وموجب نحو الثالث. الإشارة من اتجاه الدوران نفسه على إحداثيات الصورة
      // (الأمام شرقًا)، والاختبارات تثبت الاتجاهين بتحريك B جانبيًا.
      const vNP = vec(p("N"), p("Pog"));
      const vAB = vec(p("A"), p("B"));
      const signed =
        -Math.atan2(vNP.x * vAB.y - vNP.y * vAB.x, vNP.x * vAB.x + vNP.y * vAB.y) * (180 / Math.PI);
      return signed <= -180 ? signed + 360 : signed > 180 ? signed - 360 : signed;
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
      return pixelsToMm(lateralOffset(p("Ls"), p("Prn"), p("PogS")), mmPerPixel);
    }
    case "E_LINE_LL": {
      if (!has("Prn", "PogS", "Li")) return NaN;
      return pixelsToMm(lateralOffset(p("Li"), p("Prn"), p("PogS")), mmPerPixel);
    }
    case "NASOLABIAL": {
      if (!has("Prn", "Sn", "Ls")) return NaN;
      // الزاوية عند Subnasale بين نقطة قمة الأنف والشفة العليا
      return angleAtVertex(p("Sn"), p("Prn"), p("Ls"));
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
  en: string;
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
      en: def.en,
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

  const stParts: string[] = [];
  const naso = get("NASOLABIAL");
  if (naso != null && Number.isFinite(naso)) {
    if (naso < 94) stParts.push(`زاوية أنفية شفوية حادة (${naso}°) تدل على بروز شفة عليا أو هبوط ذروة الأنف`);
    else if (naso > 110) stParts.push(`زاوية أنفية شفوية منفرجة (${naso}°) تدل على تراجع الشفة العليا`);
    else stParts.push(`زاوية أنفية شفوية متوازنة (${naso}°)`);
  }
  const eUl = get("E_LINE_UL");
  const eLl = get("E_LINE_LL");
  if (eUl != null && Number.isFinite(eUl)) {
    stParts.push(`الشفة العليا: ${eUl > -2 ? "بارزة بالنسبة لخط ريكتس" : eUl < -6 ? "متراجعة عن خط ريكتس" : "متوازنة مع خط ريكتس"} (${eUl} مم)`);
  }
  if (eLl != null && Number.isFinite(eLl)) {
    stParts.push(`الشفة السفلى: ${eLl > 0 ? "بارزة أمام خط ريكتس" : eLl < -4 ? "متراجعة عن خط ريكتس" : "متوازنة مع خط ريكتس"} (${eLl} مم)`);
  }

  return {
    skeletal: `${summary.skeletal} · ${summary.vertical}`,
    dental: parts.length > 0 ? parts.join(" · ") : "— أكمل قياسات القواطع ليصدر اقتراح الأسنان —",
    softTissue: stParts.length > 0
      ? stParts.join(" · ")
      : "لم تُوضع معالم الأنسجة الرخوة بعد — هذا القسم غير متاح في هذه المرحلة.",
  };
}

/* ─────────────────── محرك التشخيص واقتراح المعالم الذكي ─────────────────── */

export interface CephExpertDiagnosis {
  sagittalSkeletal: {
    classification: "Class I" | "Class II div 1" | "Class II div 2" | "Class III" | "Indeterminate";
    severity: "normal" | "mild" | "moderate" | "severe";
    descriptionAr: string;
    detailsAr: string[];
    maxilla: "normal" | "prognathic" | "retrognathic";
    mandible: "normal" | "prognathic" | "retrognathic";
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
    upperIncisor: "normal" | "proclined" | "retroclined";
    lowerIncisor: "normal" | "proclined" | "retroclined";
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
 * محرك التوليد التشخيصي التقويمي الشامل الخالص.
 *
 * يصنف بدقة وبناءً على كافة المعايير السيفالومترية المعتمدة (Steiner, Tweed,
 * Downs, McNamara, Ricketts, Holdaway):
 * - الهيكل السهمي (Class I, Class II div 1/2, Class III) ومصدر الخلل الفكي
 * - الهيكل العمودي واتجاه النمو (Hyperdivergent / Hypodivergent / Normodivergent)
 * - موضع القواطع والتعويض السني السنخي (Dentoalveolar Compensation)
 * - بروفايل الأنسجة الرخوة وخط ريكتس والزاوية الأنفية الشفوية
 * - توصيات خطة العلاج الموجهة (القلع، أجهزة النمو، التوسيع، الزرعات العظمية TADs، الجراحة)
 */
export function generateCephExpertDiagnosis(
  results: MeasurementResult[],
  patientInfo?: { age?: number; gender?: string },
): CephExpertDiagnosis {
  const get = (code: string): number | null => results.find((r) => r.code === code)?.value ?? null;

  // 1. التحليل الهيكلي السهمي
  const anb = get("ANB");
  const wits = get("WITS");
  const sna = get("SNA");
  const snb = get("SNB");
  const conv = get("CONV");
  const convAngle = get("CONV_ANGLE");
  const abPlane = get("AB_PLANE");
  const u1naA = get("U1NA_A");
  const u1sn = get("U1SN");

  let maxilla: "normal" | "prognathic" | "retrognathic" = "normal";
  if (sna != null) {
    if (sna > 84) maxilla = "prognathic";
    else if (sna < 80) maxilla = "retrognathic";
  }

  let mandible: "normal" | "prognathic" | "retrognathic" = "normal";
  if (snb != null) {
    if (snb > 82) mandible = "prognathic";
    else if (snb < 78) mandible = "retrognathic";
  }

  let classification: "Class I" | "Class II div 1" | "Class II div 2" | "Class III" | "Indeterminate" = "Indeterminate";
  let severity: "normal" | "mild" | "moderate" | "severe" = "normal";
  let sagittalDesc = "تعذر تحديد العلاقة الهيكلية السهمية بدقة";
  const sagittalDetails: string[] = [];

  if (sna != null) {
    sagittalDetails.push(
      maxilla === "prognathic"
        ? `بروز عظمي للفك العلوي (SNA = ${sna}°)`
        : maxilla === "retrognathic"
        ? `تراجع عظمي للفك العلوي (SNA = ${sna}°)`
        : `الفك العلوي متوضع طبيعيًا سهميًا (SNA = ${sna}°)`,
    );
  }
  if (snb != null) {
    sagittalDetails.push(
      mandible === "prognathic"
        ? `تقدم عظمي للفك السفلي (SNB = ${snb}°)`
        : mandible === "retrognathic"
        ? `تراجع عظمي للفك السفلي (SNB = ${snb}°)`
        : `الفك السفلي متوضع طبيعيًا سهميًا (SNB = ${snb}°)`,
    );
  }

  if (anb != null) {
    if (anb > 4) {
      const isRetroUpper = (u1naA != null && u1naA < 17) || (u1sn != null && u1sn < 99);
      classification = isRetroUpper ? "Class II div 2" : "Class II div 1";
      severity = anb <= 6 ? "mild" : anb <= 8.5 ? "moderate" : "severe";
      sagittalDesc = classification === "Class II div 2"
        ? `علاقة هيكلية صنف ثانٍ نموذج 2 (Class II div 2) — ANB = ${anb}°`
        : `علاقة هيكلية صنف ثانٍ نموذج 1 (Class II div 1) — ANB = ${anb}°`;
      sagittalDetails.push(`فارق ANB مرتفع (${anb}°) يشير لتقدم نسبي في الفك العلوي أو تراجع الفك السفلي`);
    } else if (anb < 0) {
      classification = "Class III";
      severity = anb >= -2 ? "mild" : anb >= -4.5 ? "moderate" : "severe";
      sagittalDesc = `علاقة هيكلية صنف ثالث (Class III) — ANB = ${anb}°`;
      sagittalDetails.push(`فارق ANB سالب (${anb}°) يشير لتقدم الفك السفلي أو قصور الفك العلوي`);
    } else {
      classification = "Class I";
      severity = "normal";
      sagittalDesc = `علاقة هيكلية متوازنة صنف أول (Class I) — ANB = ${anb}°`;
      sagittalDetails.push(`فارق ANB ضمن المدى الطبيعي (${anb}°)`);
    }
  } else if (wits != null) {
    if (wits > 1.5) {
      classification = "Class II div 1";
      severity = wits <= 4 ? "mild" : "moderate";
      sagittalDesc = `علاقة هيكلية صنف ثانٍ على مستوى الإطباق (Wits = ${wits} mm)`;
    } else if (wits < -3) {
      classification = "Class III";
      severity = wits >= -5 ? "mild" : "moderate";
      sagittalDesc = `علاقة هيكلية صنف ثالث على مستوى الإطباق (Wits = ${wits} mm)`;
    } else {
      classification = "Class I";
      severity = "normal";
      sagittalDesc = `علاقة هيكلية صنف أول على مستوى الإطباق (Wits = ${wits} mm)`;
    }
  }

  if (conv != null) {
    sagittalDetails.push(
      conv > 2 ? `تحدب وجهي متزايد أمام خط NPog (+${conv} مم)` : conv < -2 ? `تقعر وجهي خلف خط NPog (${conv} مم)` : `تحدب وجهي طبيعي (${conv} مم)`,
    );
  }

  // 2. التحليل الهيكلي العمودي
  const fma = get("FMA");
  const sngogn = get("SNGOGN");
  const jarabak = get("JARABAK");
  const yaxis = get("YAXIS");
  const lafh = get("LAFH");

  let hyperScore = 0;
  let hypoScore = 0;
  if (fma != null) { if (fma > 28) hyperScore += 2; else if (fma < 22) hypoScore += 2; }
  if (sngogn != null) { if (sngogn > 37) hyperScore += 2; else if (sngogn < 27) hypoScore += 2; }
  if (jarabak != null) { if (jarabak < 62) hyperScore += 2; else if (jarabak > 68) hypoScore += 2; }
  if (yaxis != null) { if (yaxis > 71) hyperScore += 1; else if (yaxis < 63) hypoScore += 1; }
  if (lafh != null) { if (lafh > 58) hyperScore += 1; else if (lafh < 52) hypoScore += 1; }

  let verticalPattern: "Normodivergent" | "Hyperdivergent" | "Hypodivergent" | "Indeterminate" = "Indeterminate";
  let verticalDesc = "نمو عمودي متوازن";
  let growthTendency = "نمط نمو عمودي متناسق ومتوازن (Mesofacial)";
  const verticalDetails: string[] = [];

  if (hyperScore >= 2 && hyperScore > hypoScore) {
    verticalPattern = "Hyperdivergent";
    verticalDesc = "نمط نمو عمودي منفتح (Hyperdivergent / High Angle)";
    growthTendency = "نمو عمودي مائل للاتجاه العمودي مع زاوية فكية مفتوحة وميل لانفتاح العضة وضعف العضلات الماضغة";
    verticalDetails.push("زاوية مستوى الفك السفلي مفتوحة تزيد من ميلان الوجه الطويل (Dolichofacial)");
  } else if (hypoScore >= 2 && hypoScore > hyperScore) {
    verticalPattern = "Hypodivergent";
    verticalDesc = "نمط نمو أفقي منغلق (Hypodivergent / Low Angle)";
    growthTendency = "نمو أفقي مائل للاتجاه الأفقي مع زاوية فكية مغمدة وميل للعضة العميقة وقوة عضلية ماضغة";
    verticalDetails.push("زاوية مستوى الفك السفلي مغلقة تزيد من نمط الوجه القصير (Brachyfacial)");
  } else if (fma != null || sngogn != null) {
    verticalPattern = "Normodivergent";
    verticalDesc = "نمط نمو عمودي متوازن (Normodivergent / Normal Angle)";
    growthTendency = "تناسق عمودي متوازن بين ارتفاع الوجه الأمامي والخلفي";
  }

  if (fma != null) verticalDetails.push(`FMA = ${fma}° (المعدل 25°±3°)`);
  if (sngogn != null) verticalDetails.push(`SN-GoGn = ${sngogn}° (المعدل 32°±5°)`);
  if (jarabak != null) verticalDetails.push(`نسبة جاراك = ${jarabak}% (المعدل 65%±5%)`);

  // 3. التحليل السني والتعويض
  const l1nbA = get("L1NB_A");
  const impa = get("IMPA");
  const inter = get("INTER");
  const u1Apog = get("U1_APOG");

  let upperIncisor: "normal" | "proclined" | "retroclined" = "normal";
  if (u1naA != null) {
    if (u1naA > 27) upperIncisor = "proclined";
    else if (u1naA < 17) upperIncisor = "retroclined";
  } else if (u1sn != null) {
    if (u1sn > 109) upperIncisor = "proclined";
    else if (u1sn < 99) upperIncisor = "retroclined";
  }

  let lowerIncisor: "normal" | "proclined" | "retroclined" = "normal";
  if (impa != null) {
    if (impa > 95) lowerIncisor = "proclined";
    else if (impa < 85) lowerIncisor = "retroclined";
  } else if (l1nbA != null) {
    if (l1nbA > 31) lowerIncisor = "proclined";
    else if (l1nbA < 19) lowerIncisor = "retroclined";
  }

  const dentalDetails: string[] = [];
  dentalDetails.push(
    upperIncisor === "proclined"
      ? `القاطع العلوي مائل للأمام بشكل ملحوظ (U1-NA = ${u1naA ?? "—"}°)`
      : upperIncisor === "retroclined"
      ? `القاطع العلوي مائل للخلف وللحنك (U1-NA = ${u1naA ?? "—"}°)`
      : `ميل القاطع العلوي متناسق (U1-NA = ${u1naA ?? "—"}°)`,
  );
  dentalDetails.push(
    lowerIncisor === "proclined"
      ? `القاطع السفلي مائل للشفة (IMPA = ${impa ?? "—"}°)`
      : lowerIncisor === "retroclined"
      ? `القاطع السفلي مائل للخلف وللسان (IMPA = ${impa ?? "—"}°)`
      : `ميل القاطع السفلي متناسق (IMPA = ${impa ?? "—"}°)`,
  );

  let interincisalAr = "الزاوية القاطعية ضمن المدى المتناسق";
  if (inter != null) {
    if (inter < 124) {
      interincisalAr = `الزاوية القاطعية حادة (${inter}°) تدل على بروز قاطعي ثنائي متبادل (Bimaxillary Proclination)`;
    } else if (inter > 136) {
      interincisalAr = `الزاوية القاطعية منفرجة (${inter}°) تدل على استقامة أو ارتداد القواطع العلوية والسفلية`;
    }
    dentalDetails.push(interincisalAr);
  }

  let compensationAr = "لا يوجد تعويض سني سنخي حرج ملحوظ";
  if (classification === "Class III" && (upperIncisor === "proclined" || lowerIncisor === "retroclined")) {
    compensationAr = "تعويض سني سنخي للصنف الثالث: بروز معاوض في القواطع العلوية وارتداد في السفلية لتغطية التراجع الهيكلي";
  } else if (classification.startsWith("Class II") && lowerIncisor === "proclined") {
    compensationAr = "تعويض سني سنخي للصنف الثاني: ميل شفوي معاوض في القواطع السفلية للوصول نحو القواطع العلوية";
  }

  // 4. تحليل الأنسجة الرخوة والبروفايل
  const eUl = get("E_LINE_UL");
  const eLl = get("E_LINE_LL");
  const naso = get("NASOLABIAL");

  let profileTypeAr = "مستقيم ومتناسق";
  if (conv != null) {
    if (conv > 2) profileTypeAr = "بروفايل وجهي محدب (Convex)";
    else if (conv < -2) profileTypeAr = "بروفايل وجهي مقعر (Concave)";
    else profileTypeAr = "بروفايل وجهي مستقيم (Orthognathic / Straight)";
  } else if (classification.startsWith("Class II")) {
    profileTypeAr = "بروفايل وجهي محدب";
  } else if (classification === "Class III") {
    profileTypeAr = "بروفايل وجهي مقعر";
  }

  let nasolabialAr = "الزاوية الأنفية الشفوية غير مقاسة بعد";
  if (naso != null) {
    if (naso < 94) nasolabialAr = `زاوية أنفية شفوية حادة (${naso}°) تدل على بروز الشفة العليا أو انخفاض ذروة الأنف`;
    else if (naso > 110) nasolabialAr = `زاوية أنفية شفوية منفرجة (${naso}°) تدل على تراجع الشفة العليا`;
    else nasolabialAr = `زاوية أنفية شفوية متوازنة (${naso}°)`;
  }

  let eLineAr = "خط ريكتس الجمالي غير مقاس بعد";
  if (eUl != null && eLl != null) {
    eLineAr = `الشفة العليا: ${eUl > -2 ? "بارزة" : eUl < -6 ? "متراجعة" : "متناسقة"} (${eUl} مم) · الشفة السفلى: ${eLl > 0 ? "بارزة" : eLl < -4 ? "متراجعة" : "متناسقة"} (${eLl} مم)`;
  }

  const lipCompetenceAr = (eUl != null && eUl > 0) || (eLl != null && eLl > 1)
    ? "بروز شريطي وبروفايل شفوي مندفع يستدعي مراجعة إغلاق الشفاه العفوي (Incompetent lips tendency)"
    : "انطباق شفوي متوازن ومظهر بروفايلي طبيعي";

  const softTissueSummary = `${profileTypeAr} · ${nasolabialAr} · ${eLineAr}`;

  // 5. توصيات خطة العلاج الموجهة
  const age = patientInfo?.age;
  const isGrowing = age != null ? age < 15 : true;
  const isAdult = age != null ? age >= 18 : false;

  let growthModification = false;
  let growthModificationAr: string | undefined;
  if (isGrowing) {
    if (classification.startsWith("Class II") && mandible === "retrognathic") {
      growthModification = true;
      growthModificationAr = "تعديل نمو وظيفي (Functional Appliances مثل Twin Block أو Herbst) لتحفيز النمو السهمي للفك السفلي قبل اكتمال طفرة النمو.";
    } else if (classification === "Class III" && maxilla === "retrognathic") {
      growthModification = true;
      growthModificationAr = "تعديل نمو الفك العلوي (قناع شد وجه عكسي Facemask مع توسيع حنكي سريع RPE) لتقديم الفك العلوي سهميًا.";
    }
  }

  let expansion = false;
  let expansionAr: string | undefined;
  if (verticalPattern === "Hypodivergent" || classification === "Class III" || classification === "Class II div 2") {
    expansion = true;
    expansionAr = "توسيع هيكلي أو سنخي للفك العلوي (RPE / Quad-Helix) لتحسين التناسق العرضي وتأمين مسافات لتسوية الأسنان.";
  }

  let anchorageOrTADs = false;
  let anchorageOrTADsAr: string | undefined;
  if (verticalPattern === "Hyperdivergent" || (upperIncisor === "proclined" && lowerIncisor === "proclined")) {
    anchorageOrTADs = true;
    anchorageOrTADsAr = "استخدام زرعات تقويمية مؤقتة (TADs) كإرساء هيكلي مطلق لإرجاع القواطع دون فقدان المسافة الخلفية، أو لإغراس الطواحين لضبط البعد العمودي.";
  }

  let orthognathicSurgery = false;
  let orthognathicSurgeryAr: string | undefined;
  if (isAdult && severity === "severe") {
    orthognathicSurgery = true;
    orthognathicSurgeryAr = "استطباب جراحة تقويمية للفكين (Orthognathic Surgery): تقويم تمهيدي جراحي لفك التعويضات (Decompensation) متبوع بجراحة فكين (Le Fort I / BSSO).";
  }

  let extractionDecision: "non-extraction" | "borderline" | "extraction-indicated" | "not-specified" = "not-specified";
  let extractionRationaleAr = "تحديد خطة القلع يتطلب استكمال دراسة القواطع والبروفايل وتزاحم الأقواس السنية.";

  if (upperIncisor === "proclined" && lowerIncisor === "proclined" && (eUl == null || eUl > -2)) {
    extractionDecision = "extraction-indicated";
    extractionRationaleAr = "استطباب قلع الضواحك الأربعة (Four Premolars Extraction) لإرجاع القواطع المندفعة وضبط البروفايل الجمالي وتأمين إغلاق الشفاه.";
  } else if (classification === "Class II div 2" || (conv != null && conv < -1) || (eUl != null && eUl < -5)) {
    extractionDecision = "non-extraction";
    extractionRationaleAr = "خطة غير قالعة (Non-Extraction) للحفاظ على امتلاء الشفاه والبروفايل، مع فتح العضة وتصحيح ميلان القواطع العلوية والسفلية.";
  } else if (upperIncisor === "proclined" || lowerIncisor === "proclined") {
    extractionDecision = "borderline";
    extractionRationaleAr = "حالة حدية (Borderline): يُوصى بدراسة أمثلة الجبس وحساب التزاحم (Bolton / Model analysis) واللجوء للبرد السني (IPR) أو القلع وفق تقدير الطبيب.";
  } else {
    extractionDecision = "non-extraction";
    extractionRationaleAr = "خطة غير قالعة مع رصف وتسوية وتنسيق الإطباق.";
  }

  const recommendationsParts: string[] = [];
  recommendationsParts.push(`• قرار القلع: ${extractionRationaleAr}`);
  if (growthModificationAr) recommendationsParts.push(`• تعديل النمو: ${growthModificationAr}`);
  if (expansionAr) recommendationsParts.push(`• التوسيع: ${expansionAr}`);
  if (anchorageOrTADsAr) recommendationsParts.push(`• التثبيت والإرساء: ${anchorageOrTADsAr}`);
  if (orthognathicSurgeryAr) recommendationsParts.push(`• الجراحة التقويمية: ${orthognathicSurgeryAr}`);

  const narrativePlanAr = recommendationsParts.join("\n");

  const formattedFinalDx = `${sagittalDesc} · ${verticalDesc} · ${profileTypeAr}`;

  return {
    sagittalSkeletal: {
      classification,
      severity,
      descriptionAr: sagittalDesc,
      detailsAr: sagittalDetails,
      maxilla,
      mandible,
    },
    verticalSkeletal: {
      pattern: verticalPattern,
      descriptionAr: verticalDesc,
      detailsAr: verticalDetails,
      growthTendencyAr: growthTendency,
    },
    dentalAnalysis: {
      descriptionAr: dentalDetails.join(" · "),
      detailsAr: dentalDetails,
      upperIncisor,
      lowerIncisor,
      compensationAr,
      interincisalAr,
    },
    aestheticProfile: {
      profileTypeAr,
      lipCompetenceAr,
      nasolabialAr,
      eLineAr,
      summaryAr: softTissueSummary,
    },
    treatmentRecommendations: {
      extractionDecision,
      extractionRationaleAr,
      growthModification,
      growthModificationAr,
      expansion,
      expansionAr,
      anchorageOrTADs,
      anchorageOrTADsAr,
      orthognathicSurgery,
      orthognathicSurgeryAr,
      narrativePlanAr,
    },
    formatted: {
      skeletal: `${sagittalDesc} · ${verticalDesc}`,
      dental: `${dentalDetails.join(" · ")}${compensationAr ? ` · ${compensationAr}` : ""}`,
      softTissue: softTissueSummary,
      finalDx: formattedFinalDx,
      recommendationsText: narrativePlanAr,
    },
  };
}

/**
 * اقتراح المعالم التشريحية بناءً على أبعاد الصورة والمعالم الموضوعة مسبقًا.
 *
 * يعتمد على النسب التشريحية القياسية للشععة السيفالومترية الرأسية الجانبية
 * (الوجه يتجه يمينًا +x والأسفل +y). إذا كانت نقطتا S و N موضوعتين مسبقًا،
 * يتم تكييف المقياس والدوران والموقع بدقة وفق جمجمة المريض، مع الحفاظ الكامل
 * على المعالم التي وضعها الطبيب بالفعل.
 */
export function suggestLandmarks(
  imageWidth: number,
  imageHeight: number,
  existingLandmarks?: Partial<Record<LandmarkCode, Pt>>,
): Record<LandmarkCode, Pt> {
  const w = Math.max(100, imageWidth);
  const h = Math.max(100, imageHeight);

  // إحداثيات قياسية موحّدة (نسبة مئوية من العرض والارتفاع)
  const canonicalNorm: Record<LandmarkCode, Pt> = {
    S: { x: 0.42, y: 0.35 },
    N: { x: 0.65, y: 0.32 },
    Or: { x: 0.62, y: 0.42 },
    Po: { x: 0.39, y: 0.43 },
    A: { x: 0.65, y: 0.55 },
    B: { x: 0.63, y: 0.69 },
    Pog: { x: 0.64, y: 0.76 },
    Me: { x: 0.62, y: 0.81 },
    Gn: { x: 0.63, y: 0.78 },
    Go: { x: 0.37, y: 0.66 },
    U1A: { x: 0.61, y: 0.54 },
    U1: { x: 0.66, y: 0.63 },
    L1A: { x: 0.63, y: 0.73 },
    L1: { x: 0.65, y: 0.64 },
    OcclA: { x: 0.65, y: 0.63 },
    OcclP: { x: 0.47, y: 0.61 },
    D: { x: 0.61, y: 0.76 },
    Co: { x: 0.37, y: 0.38 },
    ANS: { x: 0.67, y: 0.52 },
    PNS: { x: 0.46, y: 0.51 },
    Prn: { x: 0.76, y: 0.46 },
    Sn: { x: 0.71, y: 0.54 },
    Ls: { x: 0.71, y: 0.59 },
    Li: { x: 0.69, y: 0.66 },
    PogS: { x: 0.66, y: 0.76 },
  };

  const existing = existingLandmarks ?? {};
  const hasSN = existing.S != null && existing.N != null;

  const result: Partial<Record<LandmarkCode, Pt>> = {};

  if (hasSN) {
    const sActual = existing.S!;
    const nActual = existing.N!;
    const sCanon = { x: canonicalNorm.S.x * w, y: canonicalNorm.S.y * h };
    const nCanon = { x: canonicalNorm.N.x * w, y: canonicalNorm.N.y * h };

    const dxActual = nActual.x - sActual.x;
    const dyActual = nActual.y - sActual.y;
    const distActual = Math.hypot(dxActual, dyActual);

    const dxCanon = nCanon.x - sCanon.x;
    const dyCanon = nCanon.y - sCanon.y;
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
        const rx = (cPt.x - sCanon.x) * scale;
        const ry = (cPt.y - sCanon.y) * scale;
        const rotX = rx * cosA - ry * sinA;
        const rotY = rx * sinA + ry * cosA;
        result[code] = {
          x: round1(sActual.x + rotX),
          y: round1(sActual.y + rotY),
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

