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
  | "Or" | "Po" | "U1A" | "U1" | "L1A" | "L1" | "OcclA" | "OcclP";

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
}

/**
 * سجل المعالم الستة عشر.
 *
 * الوصف التشريحي لكل معلم هو الوصف القياسي المعروف — والغاية أن يقف الطبيب على
 * النقطة الصحيحة من الكلمة لا من الحفظ.
 */
export const LANDMARKS: LandmarkDef[] = [
  { code: "S", ar: "السرجة", en: "Sella", hint: "مركز حفرة السرج — أعمق نقطة فيها", order: 1 },
  { code: "N", ar: "الأنفية", en: "Nasion", hint: "أخفض نقطة عند مفصل العظم الجبهي مع العظمين الأنفيين", order: 2 },
  { code: "Or", ar: "الحجاجية", en: "Orbitale", hint: "أخفض نقطة على الحافة السفلية لمدار العين", order: 3 },
  { code: "Po", ar: "الأذنية", en: "Porion", hint: "أعلى نقطة على حافة القناة السمعية الخارجية", order: 4 },
  { code: "A", ar: "النقطة A", en: "Point A", hint: "أعمق نقطة على contour الفك الأعلى تحت الشوكة الأنفية", order: 5 },
  { code: "B", ar: "النقطة B", en: "Point B", hint: "أعمق نقطة على contour الفك الأسفل فوق الذقن", order: 6 },
  { code: "Pog", ar: "الذقنية", en: "Pogonion", hint: "أكثر نقطة أمامية في عظم الذقن", order: 7 },
  { code: "Me", ar: "الذقنية السفلى", en: "Menton", hint: "أخفض نقطة في عظم الذقن", order: 8 },
  { code: "Gn", ar: "الذقنية الوسطى", en: "Gnathion", hint: "منتصف القوس بين الذقنية والذقنية السفلى", order: 9 },
  { code: "Go", ar: "الزّاوية", en: "Gonion", hint: "منتصف قوس زاوية الفك السفلي", order: 10 },
  { code: "U1A", ar: "قمة جذّ السنّ العلوي", en: "Upper incisor apex", hint: "طرف الجذر الشفوي للقاطع العلوي المركزي", order: 11 },
  { code: "U1", ar: "حافة القاطع العلوي", en: "Upper incisor edge", hint: "الحافة القاطعة للقاطع العلوي المركزي", order: 12 },
  { code: "L1A", ar: "قمة جذّ السنّ السفلي", en: "Lower incisor apex", hint: "طرف الجذر الشفوي للقاطع السفلي المركزي", order: 13 },
  { code: "L1", ar: "حافة القاطع السفلي", en: "Lower incisor edge", hint: "الحافة القاطعة للقاطع السفلي المركزي", order: 14 },
  { code: "OcclA", ar: "الإطباقية الأمامية", en: "Anterior occlusal", hint: "نقطة على مستوى الإطباق بين القواطع — بين حافتي القاطعين", order: 15 },
  { code: "OcclP", ar: "الإطباقية الخلفية", en: "Posterior occlusal", hint: "نقطة على مستوى الإطباق خلفًا عند طواحين الجانب المرسوم", order: 16 },
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

/** المعالم التي لا يُعتمد تحليلٌ بدونها — منشِقّة من تعريفات القياسات نفسها. */
export const REQUIRED_LANDMARKS: LandmarkCode[] = LANDMARK_ORDER;

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
}

/**
 * القياسات الثمانية عشر.
 *
 * كل تعريف تحته متجهاته حرفيًا. الرموز بأسمائها المتعارفة، والمجموعات ثلاثة:
 * أفقي هيكلي، وعمودي هيكلي، وأسنان.
 */
export const MEASUREMENTS: MeasurementDef[] = [
  { code: "SNA", ar: "SNA — موضع الفك الأعلى", group: "sagittal", unit: "°", needs: ["S", "N", "A"], mean: 82, tol: 2, source: "Steiner" },
  { code: "SNB", ar: "SNB — موضع الفك الأسفل", group: "sagittal", unit: "°", needs: ["S", "N", "B"], mean: 80, tol: 2, source: "Steiner" },
  { code: "ANB", ar: "ANB — العلاقة الفكية", group: "sagittal", unit: "°", needs: ["S", "N", "A", "B"], mean: 2, tol: 2, source: "Steiner" },
  { code: "WITS", ar: "WITS — علاقة الفكّين على الإطباقية", group: "sagittal", unit: "mm", needs: ["A", "B", "OcclA", "OcclP"], mean: -1, tol: 1, source: "Jacobson" },
  { code: "CONV", ar: "التحدّب — A على خط N-Pog", group: "sagittal", unit: "mm", needs: ["A", "N", "Pog"], mean: 0, tol: 2, source: "Downs" },
  { code: "FANGLE", ar: "الزاوية الوجهية FH-NPog", group: "sagittal", unit: "°", needs: ["N", "Pog", "Or", "Po"], mean: 87, tol: 3, source: "Downs" },
  { code: "FMA", ar: "FMA — FH مع مستوى الفك السفلي", group: "vertical", unit: "°", needs: ["Or", "Po", "Me", "Go"], mean: 25, tol: 3, source: "Tweed" },
  { code: "SNGOGN", ar: "SN-GoGn — انحدار الفك", group: "vertical", unit: "°", needs: ["S", "N", "Me", "Go"], mean: 32, tol: 5, source: "Steiner" },
  { code: "JARABAK", ar: "نسبة Jarabak — (S-Go)/(N-Me)", group: "vertical", unit: "%", needs: ["S", "N", "Me", "Go"], mean: 65, tol: 5, source: "Jarabak" },
  { code: "IMPA", ar: "IMPA — القاطع السفلي مع الفك", group: "dental", unit: "°", needs: ["L1A", "L1", "Me", "Go"], mean: 90, tol: 5, source: "Tweed" },
  { code: "FMIA", ar: "FMIA — القاطع السفلي مع FH", group: "dental", unit: "°", needs: ["Or", "Po", "L1A", "L1", "Me", "Go"], mean: 65, tol: 7, source: "Tweed" },
  { code: "U1SN", ar: "U1-SN — ميل القاطع العلوي", group: "dental", unit: "°", needs: ["S", "N", "U1A", "U1"], mean: 104, tol: 5, source: "Steiner" },
  { code: "U1NA_A", ar: "زاوية U1-NA", group: "dental", unit: "°", needs: ["N", "A", "U1A", "U1"], mean: 22, tol: 5, source: "Steiner" },
  { code: "U1NA_D", ar: "بُعد U1-NA (مم)", group: "dental", unit: "mm", needs: ["N", "A", "U1"], mean: 4, tol: 2, source: "Steiner" },
  { code: "L1NB_A", ar: "زاوية L1-NB", group: "dental", unit: "°", needs: ["N", "B", "L1A", "L1"], mean: 25, tol: 6, source: "Steiner" },
  { code: "L1NB_D", ar: "بُعد L1-NB (مم)", group: "dental", unit: "mm", needs: ["N", "B", "L1"], mean: 4, tol: 2, source: "Steiner" },
  { code: "INTER", ar: "الزاوية القاطعية U1-L1", group: "dental", unit: "°", needs: ["U1A", "U1", "L1A", "L1"], mean: 130, tol: 6, source: "Steiner" },
  { code: "YAXIS", ar: "محور Y — SGn مع SN", group: "vertical", unit: "°", needs: ["S", "N", "Gn"], mean: 67, tol: 5, source: "Steiner" },
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
