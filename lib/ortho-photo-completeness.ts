/**
 * OP-2 — لوحة اكتمال صور التقويم (قراءة فقط).
 * العقد: docs/review/ortho-wire-timeline-photo-records-contract-20261118.md (v2.1، معتمد).
 *
 * المصدر قراءة مستندات المريض القائمة، لا `savedFullPhotoSetHistory` (الذي يعيد أحدث مجموعة
 * مكتملة فقط). «مجموعة التصوير» = المرحلة + تاريخ الالتقاط + الشدّة (أو «بلا شدّة»):
 * لا تُجمع أبدًا صور تواريخ أو جلسات أو مراحل مختلفة فتوحي باكتمالٍ غير حقيقي.
 * الأشعة منفصلة عن نسبة الصور. وبلا صلاحية الصور تُخفى اللوحة كلها، حتى الأعداد.
 */
import {
  PHOTO_STAGE_ORDER, RADIOGRAPH_VIEWS, isPhotoStage, isPhotoView, PHOTOGRAPHIC_VIEWS,
  type PhotoStage, type PhotoStageRequirements, type PhotoView,
} from "./ortho-photos";

export interface CompletenessDocument {
  id: number;
  patientId: number;
  orthoCaseId: number | null;
  adjustmentId: number | null;
  isImage: boolean;
  removedAt: string | null;
  photoStage: string | null;
  photoView: string | null;
  takenOn: string | null;
}

export interface CaptureSet {
  stage: PhotoStage;
  takenOn: string;
  adjustmentId: number | null;
  /** عدد الصور لكل منظر حاضر (المطلوب والاختياري وغيرهما). */
  counts: Partial<Record<PhotoView, number>>;
  requiredCount: number;
  requiredPresent: number;
  missingRequired: PhotoView[];
  optionalPresent: PhotoView[];
  optionalMissing: PhotoView[];
}

export interface RadiographRow { stage: "initial" | "debond"; lateralCeph: string[]; panoramic: string[] }

export type PhotoCompleteness =
  | { status: "hidden" }
  | { status: "ready"; sets: CaptureSet[]; stagesWithoutSets: PhotoStage[]; unclassified: number; radiographs: RadiographRow[] };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
const nullableId = (value: unknown) => value === null || positiveId(value);
const nullableText = (value: unknown) => value === null || typeof value === "string";

export const PHOTO_COMPLETENESS_READ_FAILURE = "تعذّر تحميل صور الحالة. هذا لا يعني عدم وجود صور.";

/** قراءة صارمة لاستجابة `/api/patients/{id}/documents`؛ الصفّ الفاسد يرفض القراءة كلها. */
export function decodeCompletenessDocuments(payload: unknown, patientId: number): CompletenessDocument[] {
  if (!payload || typeof payload !== "object" || !("documents" in payload) || !Array.isArray(payload.documents)) {
    throw new Error(PHOTO_COMPLETENESS_READ_FAILURE);
  }
  const ids = new Set<number>();
  return payload.documents.map((row: unknown) => {
    const one = row as Record<string, unknown> | null;
    if (!one || typeof one !== "object" || !positiveId(one.id) || ids.has(one.id) || one.patientId !== patientId
      || !nullableId(one.orthoCaseId) || !nullableId(one.adjustmentId) || typeof one.isImage !== "boolean"
      || !nullableText(one.removedAt) || !nullableText(one.photoStage) || !nullableText(one.photoView) || !nullableText(one.takenOn)) {
      throw new Error(PHOTO_COMPLETENESS_READ_FAILURE);
    }
    ids.add(one.id);
    return {
      id: one.id, patientId, orthoCaseId: one.orthoCaseId as number | null, adjustmentId: one.adjustmentId as number | null,
      isImage: one.isImage, removedAt: one.removedAt as string | null, photoStage: one.photoStage as string | null,
      photoView: one.photoView as string | null, takenOn: one.takenOn as string | null,
    };
  });
}

export function photoCompleteness(input: {
  documents: readonly CompletenessDocument[];
  patientId: number;
  caseId: number;
  photosVisible: boolean | undefined;
  requirements: PhotoStageRequirements;
}): PhotoCompleteness {
  if (input.photosVisible !== true) return { status: "hidden" };

  const groups = new Map<string, { stage: PhotoStage; takenOn: string; adjustmentId: number | null; counts: Map<PhotoView, number> }>();
  const radiographs: RadiographRow[] = [
    { stage: "initial", lateralCeph: [], panoramic: [] },
    { stage: "debond", lateralCeph: [], panoramic: [] },
  ];
  let unclassified = 0;

  for (const doc of input.documents) {
    if (doc.patientId !== input.patientId || doc.orthoCaseId !== input.caseId || !doc.isImage
      || doc.removedAt !== null || doc.photoStage === "archived") continue;
    if (!isPhotoStage(doc.photoStage) || !isPhotoView(doc.photoView) || doc.takenOn === null || !DATE.test(doc.takenOn)) {
      unclassified += 1;
      continue;
    }
    const stage = doc.photoStage, view = doc.photoView, takenOn = doc.takenOn;
    if (RADIOGRAPH_VIEWS.includes(view)) {
      const row = radiographs.find(item => item.stage === stage);
      const list = row && (view === "lateral_ceph" ? row.lateralCeph : view === "panoramic" ? row.panoramic : null);
      if (list && !list.includes(takenOn)) { list.push(takenOn); list.sort(); }
      continue;
    }
    const key = `${stage}|${takenOn}|${doc.adjustmentId ?? "none"}`;
    let group = groups.get(key);
    if (!group) { group = { stage, takenOn, adjustmentId: doc.adjustmentId, counts: new Map() }; groups.set(key, group); }
    group.counts.set(view, (group.counts.get(view) ?? 0) + 1);
  }

  const sets: CaptureSet[] = [...groups.values()].map(group => {
    const { required, optional } = input.requirements[group.stage];
    const missingRequired = required.filter(view => !group.counts.has(view));
    return {
      stage: group.stage, takenOn: group.takenOn, adjustmentId: group.adjustmentId,
      counts: Object.fromEntries(group.counts) as Partial<Record<PhotoView, number>>,
      requiredCount: required.length, requiredPresent: required.length - missingRequired.length, missingRequired,
      optionalPresent: optional.filter(view => group.counts.has(view)),
      optionalMissing: optional.filter(view => !group.counts.has(view)),
    };
  }).sort((a, b) => PHOTO_STAGE_ORDER.indexOf(a.stage) - PHOTO_STAGE_ORDER.indexOf(b.stage)
    || (a.takenOn < b.takenOn ? -1 : a.takenOn > b.takenOn ? 1 : 0)
    || (a.adjustmentId ?? Number.MAX_SAFE_INTEGER) - (b.adjustmentId ?? Number.MAX_SAFE_INTEGER));

  const stagesWithoutSets = PHOTO_STAGE_ORDER.filter(stage => !sets.some(set => set.stage === stage));
  return { status: "ready", sets, stagesWithoutSets, unclassified, radiographs };
}

/* ─────────────────────── OP-3: ورقة مجموعة تصوير واحدة للطباعة ─────────────────────── */

export interface SheetCell { view: PhotoView; photo: { id: number } | null; extraCount: number }
export type CaptureSheet =
  | { status: "empty" }
  | { status: "ready"; rows: SheetCell[][]; otherViews: SheetCell[]; missingRequired: PhotoView[] };

/**
 * مجموعة تصوير واحدة فقط (مرحلة + تاريخ + جلسة) — لا تُخلط بغيرها أبدًا.
 * المطلوب الناقص إطار فارغ؛ الاختياري غير المصوّر لا يُرسم؛ والمصوّر خارج الترتيب
 * يُضاف صفًّا أخيرًا فلا يُخفى. المنظر المكرر يُعرض أقدمه مع عدد البقية.
 */
export function buildCaptureSheet(input: {
  documents: readonly CompletenessDocument[];
  patientId: number; caseId: number;
  stage: PhotoStage; takenOn: string; adjustmentId: number | null;
  requirements: PhotoStageRequirements;
  layout: PhotoView[][];
}): CaptureSheet {
  const byView = new Map<PhotoView, number[]>();
  for (const doc of input.documents) {
    if (doc.patientId !== input.patientId || doc.orthoCaseId !== input.caseId || !doc.isImage || doc.removedAt !== null
      || doc.photoStage !== input.stage || doc.takenOn !== input.takenOn || doc.adjustmentId !== input.adjustmentId
      || !isPhotoView(doc.photoView) || !PHOTOGRAPHIC_VIEWS.includes(doc.photoView)) continue;
    const list = byView.get(doc.photoView) ?? [];
    list.push(doc.id);
    byView.set(doc.photoView, list);
  }
  if (byView.size === 0) return { status: "empty" };
  const required = input.requirements[input.stage].required;
  const cell = (view: PhotoView): SheetCell => {
    const ids = [...(byView.get(view) ?? [])].sort((a, b) => a - b);
    return { view, photo: ids.length ? { id: ids[0] } : null, extraCount: Math.max(0, ids.length - 1) };
  };
  const placed = new Set(input.layout.flat());
  const rows = input.layout
    .map(row => row.filter(view => required.includes(view) || byView.has(view)).map(cell))
    .filter(row => row.length > 0);
  const otherViews = PHOTOGRAPHIC_VIEWS.filter(view => !placed.has(view) && byView.has(view)).map(cell);
  return { status: "ready", rows, otherViews, missingRequired: required.filter(view => !byView.has(view)) };
}

