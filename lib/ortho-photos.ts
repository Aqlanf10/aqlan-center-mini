/**
 * صور التقويم — أدوارها ووجهاتها وموعد المجموعة الكاملة.
 *
 * المالك قالها حرفيًّا: «لا نبالغ بالتصوير في كل شدّة». فطبيبٌ يُطلب منه ثماني صور
 * في كل شدّة سيتوقف عن التصوير أصلًا بعد الشهر الثالث. لذلك التصميم هنا طبقتان:
 *
 * ١) **الجلسة الواحدة**: زرّ تصويرٍ سريع وصورة أو أكثر عند الحاجة — بلا إجبار.
 * ٢) **نقاط الميثاق** (بداية العلاج، كل فترة، قبل وبعد الفكّ، التثبيت): المجموعة
 *    الكاملة مطلوبة، لأن المقارنة التي تُبنى عليها القرارات السريرية تضيع بغيابها.
 *
 * وتُقسَم الصور إلى أدوار زمنية (Initial / Progress / Debond / Retention) لا مجلّدات:
 * الدور يقرر أين تظهر الصورة في مقارنة Before/Progress/After بعد سنوات، والمجلّد
 * يقرر أين نسيها الهاتف.
 */

/* ─────────────────────────── الأدوار الزمنية ─────────────────────────── */

export type PhotoStage = "initial" | "progress" | "debond" | "retention";

export const PHOTO_STAGE_LABEL: Record<PhotoStage, string> = {
  initial: "صور البداية",
  progress: "صور متابعة",
  debond: "قبل/بعد الفكّ",
  retention: "صور التثبيت",
};

export function isPhotoStage(value: unknown): value is PhotoStage {
  return typeof value === "string" && value in PHOTO_STAGE_LABEL;
}

/** ترتيب الأدوار في المقارنة الزمنية — البداية أولًا والنهاية آخرًا. */
export const PHOTO_STAGE_ORDER: PhotoStage[] = ["initial", "progress", "debond", "retention"];

/* ─────────────────────────── وجهات الصورة ─────────────────────────── */

/**
 * الوجهات المعيارية — ثماني صور للمجموعة الكاملة.
 *
 * الأسماء بالإنجليزية لأنها معرّفات تخزين تُقرأ في التقارير والتصدير، وعناوينها
 * بالعربية هي ما يُعرض للطبيب. و«عام» خارج القائمة عمدًا: صورة سريعة لشيءٍ لاحظه
 * الطبيب لا تحتاج وجهًا معياريًّا — إجبارُها على وجهٍ ثابت هو ما يُعطّل التصوير السريع.
 */
export type PhotoView =
  | "lateral_ceph"
  | "pa_ceph"
  | "panoramic"
  | "extraoral_45"
  | "extraoral_frontal"
  | "profile"
  | "smile"
  | "intraoral_frontal"
  | "intraoral_right"
  | "intraoral_left"
  | "upper_occlusal"
  | "lower_occlusal";

export const PHOTO_VIEW_LABEL: Record<PhotoView, string> = {
  lateral_ceph: "أشعة سيفالومترية جانبية",
  pa_ceph: "أشعة سيفالومترية أمامية",
  panoramic: "أشعة بانوراما",
  extraoral_45: "وجه مائل 45°",
  extraoral_frontal: "وجه أمامي",
  profile: "بروفايل جانبي",
  smile: "ابتسامة",
  intraoral_frontal: "داخل الفم أمامي",
  intraoral_right: "داخل الفم يمين",
  intraoral_left: "داخل الفم يسار",
  upper_occlusal: "قوام علوي",
  lower_occlusal: "قوام سفلي",
};

export interface WebCephSlotDef {
  key: PhotoView;
  labelAr: string;
  labelEn: string;
  category: "xray" | "extraoral" | "intraoral";
  categoryAr: string;
  isCephTracerTarget?: boolean;
}

export const WEBCEPH_RECORD_SLOTS: WebCephSlotDef[] = [
  { key: "lateral_ceph", labelAr: "سيفالومتري جانبي", labelEn: "Lateral Ceph", category: "xray", categoryAr: "الأشعة التشخيصية", isCephTracerTarget: true },
  { key: "pa_ceph", labelAr: "سيفالومتري أمامي", labelEn: "PA Ceph", category: "xray", categoryAr: "الأشعة التشخيصية" },
  { key: "panoramic", labelAr: "أشعة بانوراما", labelEn: "Panoramic", category: "xray", categoryAr: "الأشعة التشخيصية" },
  { key: "extraoral_frontal", labelAr: "وجه أمامي (راحة)", labelEn: "Frontal Rest", category: "extraoral", categoryAr: "الصور الوجهية" },
  { key: "smile", labelAr: "ابتسامة أمامية", labelEn: "Frontal Smile", category: "extraoral", categoryAr: "الصور الوجهية" },
  { key: "profile", labelAr: "بروفايل جانبي 90°", labelEn: "Profile", category: "extraoral", categoryAr: "الصور الوجهية" },
  { key: "extraoral_45", labelAr: "وجه مائل 45°", labelEn: "Smile 45°", category: "extraoral", categoryAr: "الصور الوجهية" },
  { key: "intraoral_frontal", labelAr: "إطباق أمامي", labelEn: "Intraoral Frontal", category: "intraoral", categoryAr: "صور داخل الفم" },
  { key: "intraoral_right", labelAr: "إطباق جانبي أيمن", labelEn: "Right Occlusion", category: "intraoral", categoryAr: "صور داخل الفم" },
  { key: "intraoral_left", labelAr: "إطباق جانبي أيسر", labelEn: "Left Occlusion", category: "intraoral", categoryAr: "صور داخل الفم" },
  { key: "upper_occlusal", labelAr: "قوس فكي علوي", labelEn: "Upper Occlusal", category: "intraoral", categoryAr: "صور داخل الفم" },
  { key: "lower_occlusal", labelAr: "قوس فكي سفلي", labelEn: "Lower Occlusal", category: "intraoral", categoryAr: "صور داخل الفم" },
];

export const PHOTO_VIEWS = Object.keys(PHOTO_VIEW_LABEL) as PhotoView[];

export function isPhotoView(value: unknown): value is PhotoView {
  return typeof value === "string" && (PHOTO_VIEWS as string[]).includes(value);
}

/** وجهات المجموعة الكاملة بترتيب التصوير المعتاد: الخارجي ثم الداخلي ثم القوامان. */
export const FULL_SET_VIEWS: PhotoView[] = [
  "extraoral_frontal",
  "profile",
  "smile",
  "intraoral_frontal",
  "intraoral_right",
  "intraoral_left",
  "upper_occlusal",
  "lower_occlusal",
];

/* ─────────────────────────── اقتراح الدور ─────────────────────────── */

export interface StageSuggestionInput {
  /** تاريخ جلسة التصوير. */
  date: string;
  /** تاريخ بدء العلاج. */
  startDate: string;
  /** مرحلة الحالة الحالية. */
  phase: "aligning" | "working" | "finishing" | "retention";
  /** هل هذه أول جلسة توثيقٍ للعلاج؟ */
  isFirstSession: boolean;
}

/**
 * يُقترح دور الصورة من سياق الجلسة — **اقتراحٌ لا فرض**.
 *
 * أول جلسة تصوير تعني البداية، ومرحلة التثبيت تعني التثبيت، وسواها متابعة. والدور
 * الذي يقترحه البرنامج يصحّحه الطبيب بنقرة إن رأى غيره — الأخصائي يقرر، والبرنامج
 * يوفّر النقرات فقط.
 */
export function suggestPhotoStage(input: StageSuggestionInput): PhotoStage {
  if (input.isFirstSession) return "initial";
  if (input.phase === "retention") return "retention";
  return "progress";
}

/* ─────────────────────────── نقاط المجموعة الكاملة ─────────────────────────── */

export interface FullSetCheck {
  required: boolean;
  /** لماذا صارت المجموعة مطلوبة الآن — تُعرض للطبيب كي يفهم لا ليُؤمَر. */
  reason: string | null;
  /** الوجهات الناقصة من المجموعة حتى اللحظة، مرتّبة. */
  missingViews: PhotoView[];
}

export interface FullSetInput {
  /** تاريخ جلسة اليوم. */
  sessionDate: string;
  startDate: string;
  /** آخر مجموعة كاملة مكتملة، إن وُجدت. */
  lastFullSetDate: string | null;
  /** الفاصل بالأشهر بين المجموعات الروتينية — من الإعدادات، الافتراض ٦. */
  intervalMonths: number;
  /** المرحلة الحالية. */
  phase: "aligning" | "working" | "finishing" | "retention";
  /** الوجهات المصوَّرة في هذه الجلسة حتى الآن. */
  capturedViews: PhotoView[];
}


/** A complete saved eight-view set, with its recorded provenance. */
export interface SavedFullPhotoSet {
  adjustmentId: number;
  stage: PhotoStage;
  takenOn: string;
  /** One persisted document per required view, in FULL_SET_VIEWS order. */
  documentIds: number[];
}

export type SavedFullPhotoSetHistory =
  | { status: "ready"; latest: SavedFullPhotoSet | null }
  | { status: "unknown"; reason: "visibility" | "metadata"; latest: null };

const photoRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const photoId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;

function photoCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (value.startsWith("0000-")) return false;
  // Same real-calendar round-trip contract as waiting-list's isRealDate.
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Read evidence from the current, authorized Ortho adjustment projection only.
 * A parent case/array is not evidence of each photo's identity: the canonical
 * endpoint supplies patientId, orthoCaseId, adjustmentId and removedAt as well.
 *
 * Never join different adjustments, stages or recorded capture dates. Missing
 * capture dates are unknown; doneOn is not silently relabelled as takenOn.
 * Future-dated evidence relative to explicit clinic today is unknown. A valid
 * later historical session/capture cannot establish history for a backdated form.
 * Unclassified/legacy metadata remains unknown, not an empty/healthy history.
 *
 * This is an informational derivation, not a sign-off or photography gate.
 * Queued files and upload acknowledgements are deliberately not inputs. Only
 * persisted documents returned by a fresh read can establish a saved full set.
 * The caller must retire stale/denied reads and check status before passing
 * latest?.takenOn to fullPhotoSetCheck; do not coalesce unknown into null.
 */
export function savedFullPhotoSetHistory(input: {
  patientId: number;
  orthoCaseId: number;
  photosVisible?: boolean;
  /** Explicit current clinic date; no hidden clock is read by this helper. */
  today: string;
  /** Date of the form/session whose prior saved history is being assessed. */
  asOfDate: string;
  adjustments: unknown;
}): SavedFullPhotoSetHistory {
  const unknown = (): SavedFullPhotoSetHistory => ({ status: "unknown", reason: "metadata", latest: null });
  if (input.photosVisible !== true) return { status: "unknown", reason: "visibility", latest: null };
  if (!photoId(input.patientId) || !photoId(input.orthoCaseId)
    || !photoCalendarDate(input.today) || !photoCalendarDate(input.asOfDate)
    || input.asOfDate > input.today || !Array.isArray(input.adjustments)) return unknown();

  const adjustmentIds = new Set<number>();
  const documentIds = new Set<number>();
  let latest: SavedFullPhotoSet | null = null;
  for (const adjustment of input.adjustments) {
    if (!photoRecord(adjustment) || !photoId(adjustment.id) || adjustmentIds.has(adjustment.id)
      || !photoCalendarDate(adjustment.doneOn) || adjustment.doneOn > input.today
      || !Array.isArray(adjustment.photos)) return unknown();
    adjustmentIds.add(adjustment.id);
    const groups = new Map<string, { stage: PhotoStage; takenOn: string; views: Map<PhotoView, number> }>();
    for (const photo of adjustment.photos) {
      if (!photoRecord(photo) || !photoId(photo.id) || documentIds.has(photo.id)
        || typeof photo.isImage !== "boolean"
        || !(photo.removedAt === null || (typeof photo.removedAt === "string"
          && photoCalendarDate(photo.removedAt.slice(0, 10)) && Number.isFinite(Date.parse(photo.removedAt))))) return unknown();
      documentIds.add(photo.id);
      // Known non-photo and retired documents are not evidence of a current set.
      if (!photo.isImage || photo.removedAt !== null || photo.photoStage === "archived") continue;
      if (photo.patientId !== input.patientId || photo.orthoCaseId !== input.orthoCaseId
        || photo.adjustmentId !== adjustment.id || !isPhotoStage(photo.photoStage)
        || !Object.hasOwn(PHOTO_STAGE_LABEL, photo.photoStage) || !isPhotoView(photo.photoView)
        || !photoCalendarDate(photo.takenOn) || photo.takenOn > input.today) return unknown();
      if (adjustment.doneOn > input.asOfDate || photo.takenOn > input.asOfDate
        || !FULL_SET_VIEWS.includes(photo.photoView)) continue;

      const key = `${photo.photoStage}:${photo.takenOn}`;
      let group = groups.get(key);
      if (!group) {
        group = { stage: photo.photoStage, takenOn: photo.takenOn, views: new Map() };
        groups.set(key, group);
      }
      const previous = group.views.get(photo.photoView);
      // Duplicate views never replace another required view; tie-break is stable.
      if (previous === undefined || photo.id < previous) group.views.set(photo.photoView, photo.id);
    }

    for (const group of groups.values()) {
      if (!FULL_SET_VIEWS.every(view => group.views.has(view))) continue;
      const candidate: SavedFullPhotoSet = {
        adjustmentId: adjustment.id, stage: group.stage, takenOn: group.takenOn,
        documentIds: FULL_SET_VIEWS.map(view => group.views.get(view)!),
      };
      if (!latest || candidate.takenOn > latest.takenOn
        || (candidate.takenOn === latest.takenOn && (candidate.adjustmentId > latest.adjustmentId
          || (candidate.adjustmentId === latest.adjustmentId
            && PHOTO_STAGE_ORDER.indexOf(candidate.stage) > PHOTO_STAGE_ORDER.indexOf(latest.stage))))) latest = candidate;
    }
  }
  return { status: "ready", latest };
}

const MONTH_DAYS = 30.44;

/**
 * هل تُطلب المجموعة الكاملة في هذه الجلسة؟
 *
 * النقاط خمس كما حدّدها المالك: بداية العلاج، وكل فترةٍ تُضبط بالأشهر، ومرحلة
 * الإنهاء قبيل الفكّ، وبعده مباشرة، وجلسات التثبيت. والنقص يُقال بالاسم: «تنقصك
 * صورة القوام العلوي» أنفع من «المجموعة غير مكتملة» — والطبيب على الكرسي لا يُفتح
 * له ملفٌّ ليعرف ماذا صوّر.
 */
export function fullPhotoSetCheck(input: FullSetInput): FullSetCheck {
  const captured = new Set(input.capturedViews);
  const missing = FULL_SET_VIEWS.filter((view) => !captured.has(view));

  const daysSinceLast = input.lastFullSetDate
    ? Math.round(
        (Date.parse(`${input.sessionDate}T00:00:00Z`)
          - Date.parse(`${input.lastFullSetDate}T00:00:00Z`)) / 86_400_000,
      )
    : null;

  if (!input.lastFullSetDate) {
    return {
      required: true,
      reason: "أول توثيقٍ للعلاج — صور البداية هي المرجع الذي تُقارن عليه كل النتائج.",
      missingViews: missing,
    };
  }

  const intervalDays = Math.max(1, Math.round(input.intervalMonths * MONTH_DAYS));
  if (daysSinceLast !== null && daysSinceLast >= intervalDays) {
    const months = Math.round((daysSinceLast / MONTH_DAYS) * 10) / 10;
    return {
      required: true,
      reason: `آخر مجموعة كاملة منذ ${months} شهرًا والفاصل المضبوط ${input.intervalMonths} أشهر — وقت مقارنة التقدّم.`,
      missingViews: missing,
    };
  }

  if (input.phase === "finishing" || input.phase === "retention") {
    return {
      required: true,
      reason: input.phase === "finishing"
        ? "مرحلة الإنهاء — تُوثَّق الحالة قبل فكّ الجهاز بقليل."
        : "مرحلة التثبيت — تُراقَب النتيجة بعد الفكّ.",
      missingViews: missing,
    };
  }

  return { required: false, reason: null, missingViews: [] };
}

/* ─────────────────────────── مقارنة البداية/التقدّم/النهاية ─────────────────────────── */

export interface StagePhoto {
  id: number;
  stage: PhotoStage;
  view: PhotoView | null;
  takenOn: string | null;
  uploadedAt: string;
}

export interface ComparisonColumn {
  stage: PhotoStage;
  label: string;
  /** أفضل صورة تُمثّل الدور في المقارنة: الأمامية الداخلية أولًا ثم أول ما وُجد. */
  featured: StagePhoto | null;
  count: number;
}

/**
 * يمثّل كل دورٍ بصورةٍ واحدة للمقارنة الجنبَ إلى الجنب.
 *
 * صورة الوجه الداخلي الأمامي هي مرآة العلاج — إن وُجدت فهي المرشّحة الأولى، ثم
 * أيّ صورة داخلية، ثم ما وُجد. والمقارنة بلا صورةٍ في عمودٍ ما تبقى عمودًا فارغًا
 * لا خطأً: بدايةٌ بلا صورٍ حادثٌ ماضٍ، والخيار الوحيد هو النظر إلى الموجود.
 */
export function buildComparison(photos: StagePhoto[]): ComparisonColumn[] {
  const rank = (view: PhotoView | null): number => {
    if (view === "intraoral_frontal") return 0;
    if (view && view.startsWith("intraoral")) return 1;
    return 2;
  };

  return PHOTO_STAGE_ORDER.map((stage) => {
    const inStage = photos
      .filter((photo) => photo.stage === stage)
      .sort((a, b) => {
        const byRank = rank(a.view) - rank(b.view);
        if (byRank !== 0) return byRank;
        // داخل الدور نفسه: الأقدم تُمثّل البداية والأحدث تُمثّل ما بعدها.
        return stage === "initial"
          ? (a.takenOn ?? a.uploadedAt).localeCompare(b.takenOn ?? b.uploadedAt)
          : (b.takenOn ?? b.uploadedAt).localeCompare(a.takenOn ?? a.uploadedAt);
      });
    return {
      stage,
      label: PHOTO_STAGE_LABEL[stage],
      featured: inStage[0] ?? null,
      count: inStage.length,
    };
  });
}
