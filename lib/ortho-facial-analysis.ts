import { readOccurrenceEvidence, type OccurrenceEvidence } from "./ortho-case-occurrence";

export const FACIAL_PROTOCOL = "frontal-projections-1.0.0" as const;
export const FACIAL_LANDMARKS = [
  ["axisTop", "بداية المحور العمودي", "مرجع الاتجاه العمودي للصورة بعد مراجعة وضع الرأس؛ لا يُستنتج تلقائياً من الذقن."],
  ["axisBottom", "نهاية المحور العمودي", "نقطة أسفل بداية المحور في اتجاه عمودي الوجه المختار."],
  ["tr", "Tr — منبت الشعر", "Trichion: منبت الشعر على الخط الوسطي. إذا لم يظهر فلا تخمّن موضعه."],
  ["gl", "Gl — الغلابيلا", "Glabella: المنطقة الوسطية الأبرز من الجبهة عند مستوى الحاجبين."],
  ["sn", "Sn — تحت الأنف", "Subnasale: التقاء قاعدة الحاجز الأنفي بالشفة العليا على الخط الوسطي."],
  ["me", "Me — أسفل الذقن", "Menton: أخفض نقطة مرئية في النسج الرخوة للذقن."],
  ["sto", "Sto — التقاء الشفتين", "Stomion: منتصف شق التقاء الشفتين. سجله غير متاح إذا تعذر تحديده في وضع الراحة."],
  ["paImageLeft", "Pa — الحد الأذني الأيسر بالصورة", "Postaurale: الحد الخلفي لحافة صيوان الأذن في إسقاط الصورة الأمامية. ليس حد الوجنة."],
  ["exImageLeft", "Ex — زاوية العين الخارجية يسار الصورة", "Exocanthion: ملتقى الجفنين عند الزاوية الخارجية للعين."],
  ["enImageLeft", "En — زاوية العين الداخلية يسار الصورة", "Endocanthion: ملتقى الجفنين عند الزاوية الداخلية للعين."],
  ["enImageRight", "En — زاوية العين الداخلية يمين الصورة", "Endocanthion: ملتقى الجفنين عند الزاوية الداخلية للعين."],
  ["exImageRight", "Ex — زاوية العين الخارجية يمين الصورة", "Exocanthion: ملتقى الجفنين عند الزاوية الخارجية للعين."],
  ["paImageRight", "Pa — الحد الأذني الأيمن بالصورة", "Postaurale: الحد الخلفي لحافة صيوان الأذن في إسقاط الصورة الأمامية. ليس حد الوجنة."],
] as const;
export type FacialLandmark = typeof FACIAL_LANDMARKS[number][0];
export type FacialPoint = { state: "located"; x: number; y: number } | { state: "unavailable"; reason: string };
export interface FacialContent {
  protocol: typeof FACIAL_PROTOCOL;
  image: { sha256: string; width: number; height: number; exifOrientation: number };
  occurrence: OccurrenceEvidence;
  landmarks: Partial<Record<FacialLandmark, FacialPoint>>;
  quality: { frontalRest: boolean; headPosition: boolean; visibleLandmarks: boolean; perspectiveReviewed: boolean; note: string };
  review: { state: "draft" | "reviewed"; note: string };
}
export interface FacialCommand { schemaVersion: 1; clientRequestId: string; documentId: number; expectedHeadId: number | null; reason: string; content: FacialContent }
export interface FacialMeasure {
  id: "thirds" | "fifths_postaurale" | "lower_third" | "eye_widths";
  state: "ready" | "incomplete" | "invalid_geometry";
  landmarks: FacialLandmark[];
  segments: { label: string; pixels: number; percent: number }[];
  message: string;
}
export interface FacialResults { protocol: typeof FACIAL_PROTOCOL; units: "image_pixels_and_percent"; clinicalInterpretation: "clinician_only"; measures: FacialMeasure[] }
const fail = (): never => { throw Error("invalid_facial_analysis"); };
const id = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 2147483647;
function object(v: unknown, required: string[]) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail();
  const r = v as Record<string, unknown>;
  if (Object.keys(r).length !== required.length || required.some(k => !Object.hasOwn(r, k))) return fail(); return r;
}
function text(v: unknown, max: number, empty = false): string {
  if (typeof v !== "string" || v.length > max || !empty && !v.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(v)) return fail(); return v;
}
export function readFacialCommand(raw: unknown): FacialCommand {
  const r = object(raw, ["schemaVersion", "clientRequestId", "documentId", "expectedHeadId", "reason", "content"]);
  if (r.schemaVersion !== 1 || !id(r.documentId) || !(r.expectedHeadId === null || id(r.expectedHeadId))
    || typeof r.clientRequestId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(r.clientRequestId)) return fail();
  const c = object(r.content, ["protocol", "image", "occurrence", "landmarks", "quality", "review"]);
  const i = object(c.image, ["sha256", "width", "height", "exifOrientation"]), q = object(c.quality, ["frontalRest", "headPosition", "visibleLandmarks", "perspectiveReviewed", "note"]), review = object(c.review, ["state", "note"]);
  if (c.protocol !== FACIAL_PROTOCOL || typeof i.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(i.sha256)
    || !id(i.width) || !id(i.height) || i.width > 50000 || i.height > 50000 || !id(i.exifOrientation) || i.exifOrientation > 8
    || [q.frontalRest, q.headPosition, q.visibleLandmarks, q.perspectiveReviewed].some(v => typeof v !== "boolean")
    || (review.state !== "draft" && review.state !== "reviewed") || !c.landmarks || typeof c.landmarks !== "object" || Array.isArray(c.landmarks)) return fail();
  const landmarks: FacialContent["landmarks"] = {};
  for (const [key, value] of Object.entries(c.landmarks)) {
    if (!FACIAL_LANDMARKS.some(row => row[0] === key) || !value || typeof value !== "object" || Array.isArray(value)) return fail();
    if (value.state === "located") {
      const p = object(value, ["state", "x", "y"]);
      if ([p.x, p.y].some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1)) return fail();
      landmarks[key as FacialLandmark] = { state: "located", x: p.x as number, y: p.y as number };
    } else {
      const p = object(value, ["state", "reason"]); if (p.state !== "unavailable") return fail();
      landmarks[key as FacialLandmark] = { state: "unavailable", reason: text(p.reason, 500) };
    }
  }
  const content: FacialContent = { protocol: FACIAL_PROTOCOL, image: { sha256: i.sha256, width: i.width, height: i.height, exifOrientation: i.exifOrientation }, occurrence: readOccurrenceEvidence(c.occurrence), landmarks,
    quality: { frontalRest: q.frontalRest as boolean, headPosition: q.headPosition as boolean, visibleLandmarks: q.visibleLandmarks as boolean, perspectiveReviewed: q.perspectiveReviewed as boolean, note: text(q.note, 1000, true) },
    review: { state: review.state as "draft" | "reviewed", note: text(review.note, 2000, review.state === "draft") } };
  if (content.review.state === "reviewed" && (!content.quality.frontalRest || !content.quality.headPosition || !content.quality.perspectiveReviewed
    || !content.quality.visibleLandmarks && !content.quality.note.trim() || !computeFacialResults(content).measures.some(m => m.state === "ready"))) return fail();
  return { schemaVersion: 1, clientRequestId: r.clientRequestId, documentId: r.documentId, expectedHeadId: r.expectedHeadId, reason: text(r.reason, 500), content };
}
/** Pure 2D projection. Coordinates are normalized, but computation uses original
 * pixel dimensions so rectangular images and rotations preserve the geometry. */
export function computeFacialResults(content: FacialContent): FacialResults {
  const point = (key: FacialLandmark) => { const p = content.landmarks[key]; return p?.state === "located" ? { x: p.x * content.image.width, y: p.y * content.image.height } : null; };
  const top = point("axisTop"), bottom = point("axisBottom");
  const length = top && bottom ? Math.hypot(bottom.x - top.x, bottom.y - top.y) : 0;
  const axis = top && bottom && length >= 1 ? { x: (bottom.x - top.x) / length, y: (bottom.y - top.y) / length } : null;
  const definitions: { id: FacialMeasure["id"]; keys: FacialLandmark[]; horizontal: boolean; labels: string[] }[] = [
    { id: "thirds", keys: ["tr", "gl", "sn", "me"], horizontal: false, labels: ["الثلث العلوي Tr–Gl", "الثلث الأوسط Gl–Sn", "الثلث السفلي Sn–Me"] },
    { id: "fifths_postaurale", keys: ["paImageLeft", "exImageLeft", "enImageLeft", "enImageRight", "exImageRight", "paImageRight"], horizontal: true,
      labels: ["الجزء الجانبي يسار الصورة Pa–Ex", "عرض العين يسار الصورة Ex–En", "بين زاويتي العينين En–En", "عرض العين يمين الصورة En–Ex", "الجزء الجانبي يمين الصورة Ex–Pa"] },
    { id: "lower_third", keys: ["sn", "sto", "me"], horizontal: false, labels: ["Sn–Sto من الجزء السفلي", "Sto–Me من الجزء السفلي"] },
    { id: "eye_widths", keys: ["exImageLeft", "enImageLeft", "enImageRight", "exImageRight"], horizontal: true, labels: ["عرض العين يسار الصورة", "المسافة بين زاويتي العينين", "عرض العين يمين الصورة"] },
  ];
  const measures = definitions.map(({ id, keys, horizontal, labels }): FacialMeasure => {
    const base = { id, landmarks: keys, segments: [] };
    if (!top || !bottom || keys.some(key => !point(key))) return { ...base, state: "incomplete", message: "لم تحدد كل المعالم اللازمة أو سجل أحدها غير متاح." };
    if (!axis || axis.y <= 0) return { ...base, state: "invalid_geometry", message: "حدد محوراً غير صفري من الأعلى إلى الأسفل." };
    const direction = horizontal ? { x: axis.y, y: -axis.x } : axis;
    const projections = keys.map(key => { const p = point(key)!; return (p.x - top.x) * direction.x + (p.y - top.y) * direction.y; });
    const distances = projections.slice(1).map((p, index) => p - projections[index]);
    const total = distances.reduce((sum, p) => sum + p, 0);
    if (distances.some(p => !Number.isFinite(p) || p < 1) || !Number.isFinite(total) || total < 1)
      return { ...base, state: "invalid_geometry", message: "ترتيب المعالم أو المسافة غير صالح؛ راجع النقاط والاتجاه. لا يُستبدل القياس بصفر." };
    return { ...base, state: "ready", segments: distances.map((pixels, index) => ({ label: labels[index], pixels, percent: pixels / total * 100 })),
      message: "نسب من إسقاط الصورة ثنائية الأبعاد؛ ليست تشخيصاً ولا قياساً بالملليمتر." };
  });
  return { protocol: FACIAL_PROTOCOL, units: "image_pixels_and_percent", clinicalInterpretation: "clinician_only", measures };
}
export function blankFacialContent(image: FacialContent["image"]): FacialContent {
  return { protocol: FACIAL_PROTOCOL, image, occurrence: { occurredOn: null, dateProvenance: "unknown", sourceNote: "" }, landmarks: {},
    quality: { frontalRest: false, headPosition: false, visibleLandmarks: false, perspectiveReviewed: false, note: "" }, review: { state: "draft", note: "" } };
}
