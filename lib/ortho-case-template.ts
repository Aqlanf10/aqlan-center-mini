/** Clean, editable 10 × 7.5 inch layout registry. Contains no reference document/media. */
export const CASE_TEMPLATE_KEY = "full-orthodontic-case";
export const CASE_TEMPLATE_VERSION = "ortho-full-case-layout-v4-recovery";
export type CaseRect = { x: number; y: number; w: number; h: number };
export type CaseImageSlot = CaseRect & { slotId: string; sourceKind: "patient-document" | "clinic-logo" };
export type CaseLayout = {
  key: string; order: number; singular: boolean; titleAr: string; titleEn: string;
  referenceSlides: readonly number[]; images: readonly CaseImageSlot[];
  text: CaseRect; table?: CaseRect; columnWeights?: readonly number[]; footer: "wave" | "band";
};
const rect = (x: number, y: number, w: number, h: number): CaseRect => ({ x, y, w, h });
const image = (slotId: string, x: number, y: number, w: number, h: number): CaseImageSlot =>
  ({ slotId, x, y, w, h, sourceKind: "patient-document" });
const full = rect(.4, 1.22, 9.2, 5.38);
const visitImages = [
  image("intra-right", .18, .95, 2.9, 1.8), image("intra-front", 3.38, .95, 3, 1.8),
  image("intra-left", 6.78, .95, 3.05, 1.8), image("occlusal-upper", .18, 4.45, 3.08, 2.58),
  image("occlusal-lower", 6.63, 4.45, 3.18, 2.58),
];
function layout(key: string, order: number, titleAr: string, titleEn: string, referenceSlides: number[],
  text: CaseRect = full, images: CaseImageSlot[] = [], extra: Partial<CaseLayout> = {}): CaseLayout {
  return { key, order, titleAr, titleEn, referenceSlides, text, images, singular: true, footer: "wave", ...extra };
}
export const CASE_LAYOUTS: readonly CaseLayout[] = [
  layout("cover", 0, "دراسة حالة تقويم", "Orthodontic case study", [1], rect(1.35, 1.8, 7.3, 3.3), [
    { ...rect(.51, .44, 2.39, .87), slotId: "clinic-logo", sourceKind: "clinic-logo" },
  ]),
  layout("interview", 1, "المقابلة والتاريخ وتقييم النمو", "Interview, history and growth assessment", [2]),
  layout("records-overview", 2, "السجلات المختارة", "Selected records", [3], rect(3.36, 4.47, 3.46, .9), [
    image("face-profile", .59, .30, 2.13, 2.52), image("face-smile", 4.05, .30, 2.13, 2.52),
    image("face-front", 7.36, .29, 2.14, 2.55), image("occlusal-upper", .075, 3.01, 3.14, 2.30),
    image("detail-front", 3.52, 3.06, 1.46, 1.30), image("detail-profile", 5.28, 2.99, 1.38, 1.40),
    image("occlusal-lower", 6.99, 2.97, 2.91, 2.40), image("intra-right", .075, 5.55, 3.14, 1.81),
    image("intra-front", 3.37, 5.55, 3.47, 1.8), image("intra-left", 6.99, 5.55, 2.91, 1.8),
  ]),
  layout("face-overview", 3, "الفحص الخارجي", "Extraoral examination", [4], rect(.28, 4.28, 9.2, 2.25), [
    image("face-profile", .196, 1.188, 2.582, 3.048), image("face-smile", 3.658, 1.188, 2.577, 3.048),
    image("face-front", 6.968, 1.171, 2.593, 3.083),
  ]),
  layout("face-profile", 4, "الفحص الخارجي: البروفايل", "Extraoral examination: profile", [5], rect(5.394, 1.916, 4.35, 4.5), [
    image("face-profile", .275, 1.099, 4.677, 5.7),
  ]),
  layout("smile", 5, "الابتسامة والأنسجة الرخوة", "Smile and soft tissues", [6], rect(4.055, 1.23, 5.73, 5.01), [
    image("face-smile", .306, 1.746, 3.441, 4.2),
  ]),
  layout("facial-fifths", 6, "النسب العرضية للوجه", "Transverse facial proportions", [7], rect(4.055, 1.23, 5.73, 4.48), [
    image("face-front", .881, 2.095, 2.691, 3.2),
  ]),
  layout("facial-thirds", 7, "النسب العمودية للوجه", "Vertical facial proportions", [8], rect(4.225, 1.309, 5.5, 4.6), [
    image("face-front", .881, 2.075, 2.691, 3.2),
  ]),
  layout("intraoral-overview", 8, "الصور داخل الفم", "Intraoral photographs", [9], rect(3.7, 5.35, 2.8, 1.15), [
    image("intra-right", .207, 1.762, 3.14, 1.81), image("intra-left", 6.986, 1.814, 2.91, 1.8),
    image("detail-front", 4.215, 3.594, 1.761, 1.573), image("occlusal-upper", .127, 4.836, 3.14, 2.3),
    image("occlusal-lower", 6.924, 4.514, 2.91, 2.4),
  ]),
  layout("occlusal", 9, "الأقواس والإطباق", "Arches and occlusion", [10], rect(4.764, 1.1, 5.03, 5.5), [
    image("occlusal-upper", .606, .942, 3.454, 2.53), image("occlusal-lower", .573, 3.606, 3.52, 2.9),
  ]),
  layout("dental-relations", 10, "العلاقات السنية", "Dental relationships", [11], rect(.388, 3.278, 9.25, 3.26), [
    image("intra-right", .091, 1.442, 3.14, 1.81), image("intra-front", 3.384, 1.445, 3.465, 1.8),
    image("intra-left", 7.002, 1.442, 2.91, 1.8),
  ]),
  layout("panoramic", 11, "الصورة البانورامية", "Panoramic radiograph", [12], rect(6.947, 1.31, 2.87, 5.2), [
    image("panoramic", .196, 1.036, 6.685, 3.898),
  ], { table: rect(.354, 5.05, 6.5, 1.45) }),
  layout("ceph-image", 12, "الصورة السيفالومترية والتتبع", "Cephalogram and tracing", [13], rect(7.12, 1.37, 2.5, 4.96), [
    image("ceph-tracing", .445, 1.371, 6.511, 5.054),
  ]),
  layout("ceph-measurements", 13, "القياسات السيفالومترية", "Cephalometric measurements", [14], rect(.5, 6.72, 9, .35), [], {
    table: rect(.511, 1.073, 8.977, 5.65), columnWeights: [1313675, 1532621, 1021748, 729820, 1240694, 2370354],
  }),
  layout("cast-analysis", 14, "الموديلات والتحليل", "Cast analysis", [15], rect(3.19, 3.84, 3.34, .38), [
    image("cast-right", .09, 1.09, 3.012, 2.4), image("cast-front", 3.528, 1.067, 2.725, 2.7),
    image("cast-left", 6.644, 1.092, 3.138, 2.5), image("cast-upper", .12, 3.75, 2.9, 3),
    image("cast-lower", 6.854, 3.792, 2.8, 3),
  ], { table: rect(3.146, 4.25, 3.386, 2.49), columnWeights: [1, 1, 1] }),
  layout("model-measurements", 15, "تحليل المسافة وBolton", "Space and Bolton analysis", [16], rect(.127, 3.2, 9.75, 3.36), [], {
    table: rect(.74, .9, 8.6, 2.12), columnWeights: [1.4, 1, 1, 1, 1, 1, 1, 1.4],
  }),
  layout("diagnosis", 16, "قائمة المشكلات والتشخيص", "Problem list and diagnosis", [17]),
  layout("objectives", 17, "أهداف العلاج", "Treatment objectives", [18]),
  layout("problem-plan-strategy", 18, "المشكلات والخطة والاستراتيجيات", "Problem / Treatment plan / Strategies", [19, 20],
    rect(.59, 6.72, 8.97, .35), [], { table: rect(.59, 1.073, 8.977, 5.5), columnWeights: [3131916, 2538498, 2538498] }),
  layout("mechanotherapy", 19, "الأجهزة والإرساء والتسلسل المقصود", "Planned mechanics and anchorage", [21, 22, 23, 24], full, [], { singular: false }),
  layout("placement", 20, "التركيب", "Appliance placement", [25], rect(3.55, 3.0, 2.86, 3.93), visitImages, { singular: false, footer: "band" }),
  layout("visit", 21, "زيارة متابعة", "Progress visit", [26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40],
    rect(3.55, 3.0, 2.86, 3.93), visitImages, { singular: false, footer: "band" }),
  layout("plan-changes", 22, "تغييرات الخطة وأسبابها", "Plan changes and reasons", [], full, [], { singular: false }),
  layout("debond", 23, "فك الجهاز والنتائج", "Debond and results", [41, 42], rect(3.55, 3.0, 2.86, 3.93), visitImages, { singular: false, footer: "band" }),
  layout("comparison", 24, "المقارنات المتاحة", "Available comparisons", [], full, [], { singular: false }),
  layout("retention", 25, "التثبيت والمتابعة", "Retention and follow-up", [], full, [], { singular: false }),
  layout("conclusion", 26, "تقييم الأهداف والخلاصة", "Outcome review and conclusion", [43]),
];
export const CASE_PAGE = Object.freeze({ width: 10, height: 7.5, fontFace: "Arial", imageDpi: 144,
  header: rect(.3, .34, 9.4, .62), continuation: rect(.4, 1.22, 9.2, 5.38),
  footerLabel: rect(.35, 7.18, 9.3, .30), inset: .06,
  color: { text: "000000", blue: "123C9C", cyan: "168ACC", purple: "7030A0", visit: "C00000", table: "FFFF00" },
});
export const CASE_PUBLIC_NAMES = Object.freeze({ title: "دراسة حالة تقويم", full: "عرض الحالة الكامل" });
export function caseLayout(key: string): CaseLayout | undefined { return CASE_LAYOUTS.find(x => x.key === key); }

function freezeIdentity<T>(value: T, seen = new Set<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const item of Object.values(value)) freezeIdentity(item, seen);
    Object.freeze(value);
  }
  return value;
}
/** Browser-safe canonical hash input shared by save and server renderer. */
export const CASE_TEMPLATE_IDENTITY = freezeIdentity({ key: CASE_TEMPLATE_KEY, version: CASE_TEMPLATE_VERSION, page: CASE_PAGE, layouts: CASE_LAYOUTS });
