/**
 * OW-1 — الخط الزمني للأسلاك (قراءة فقط).
 *
 * العقد: docs/review/ortho-wire-timeline-photo-records-contract-20261118.md (الإصدار 2.1، معتمد).
 *
 * - الفراغ = بلا تغيير (قرار المالك): شدّة بلا سلك تبقى داخل مقطع السلك السابق.
 * - الإزالة تظهر فقط بدليل موثّق (سجل التدقيق القائم لإجراء «إزالة»)، وحين يكون
 *   السلك في صفّ الشدّة فارغًا فعلًا؛ الدليل لا يطغى على سلكٍ مسجّل.
 * - لا تاريخ تركيب ولا مدّة مختلَقة: «أول تسجيل موثّق» و«الفترة الموثّقة» حتى آخر
 *   جلسة في المقطع، لا حتى اليوم. ولا ساعة مخفية في هذه الدالة.
 * - النصّ المسجّل يُعرض حرفيًا؛ المطابقة مع الكتالوج تتسامح مع المسافات وحالة
 *   الأحرف و x/× فقط.
 * - لا اقتراحات ولا أحكام سريرية: الوسوم وقائعية محايدة.
 */
import {
  usesArchwires, wiresFor,
  type Appliance, type Archwire, type Arches, type ElasticClass, type OrthoPhase, type SlotSize,
} from "./ortho";

export type WireArch = "upper" | "lower";

export interface WireTimelineInput {
  case: { slot: SlotSize; appliance: Appliance; arches: Arches; upperWire: string | null; lowerWire: string | null };
  adjustments: readonly {
    id: number; doneOn: string; phase: OrthoPhase | null;
    upperWire: string | null; lowerWire: string | null;
    elastics: ElasticClass; elasticNote: string | null;
  }[];
  /** أزواج (الشدّة، الفك) التي وثّق سجل التدقيق فيها إزالةً صريحة. */
  documentedRemovals: readonly { adjustmentId: number; arch: WireArch }[];
  hasMore: boolean;
}

export type CatalogueStatus = "match" | "off_catalogue" | "other_slot";

export interface WireSegment {
  /** wire: سلك موثّق؛ none: بلا سلك بعد إزالة موثّقة؛ unknown: قبل أول تسجيل موثّق. */
  kind: "wire" | "none" | "unknown";
  /** أول نصّ مسجّل حرفيًا (wire فقط). */
  text: string | null;
  /** كل الصيغ الحرفية المسجّلة لهذا السلك، بترتيب ظهورها. */
  variants: string[];
  catalogue: Archwire | null;
  catalogueStatus: CatalogueStatus | null;
  /** «أول تسجيل موثّق»؛ null للمقطع المجهول. */
  firstDocumentedOn: string | null;
  lastSessionOn: string;
  /** «الفترة الموثّقة» بالأسابيع الكاملة؛ null للمقطع المجهول. */
  documentedWeeks: number | null;
  sessionIds: number[];
  /** جلسات لم يُعَد فيها إدخال السلك (بلا تغيير). */
  blankSessionIds: number[];
  endedBy: "change" | "removal" | "current";
  recordedPhase: OrthoPhase | null;
  phaseDiffers: boolean;
  /** رجوع إلى سلكٍ يسبق السابق في كتالوج قياس الحالة — وسم محايد. */
  outOfOrder: boolean;
  /** أول مقطع حين تكون أقدم الجلسات غير معروضة (أكثر من حدّ القراءة). */
  limitedToShown: boolean;
}

export interface WireLane { arch: WireArch; treated: boolean; segments: WireSegment[] }

export interface ElasticPeriod {
  elastics: ElasticClass; note: string | null;
  firstDocumentedOn: string; lastSessionOn: string; sessions: number;
}

export type WireTimeline =
  | { kind: "not_applicable" }
  | {
    kind: "timeline";
    lanes: WireLane[];
    elastics: ElasticPeriod[];
    truncated: boolean;
    mismatches: { arch: WireArch; caseWire: string | null; lastWire: string | null }[];
  };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function calendarDay(value: string): number {
  if (!DATE.test(value)) throw new Error(`تاريخ جلسة غير صالح: ${value}`);
  const ms = Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
  if (new Date(ms).toISOString().slice(0, 10) !== value) throw new Error(`تاريخ جلسة غير صالح: ${value}`);
  return ms / DAY_MS;
}

/** مفتاح المطابقة فقط — لا يُعرض أبدًا. */
export function normalizeWireCode(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase().replace(/[x×]/g, "×");
}

function blankWire(value: string | null): boolean {
  return value === null || value.trim() === "";
}

function catalogueFor(slot: SlotSize, text: string): { wire: Archwire | null; status: CatalogueStatus; index: number } {
  const key = normalizeWireCode(text);
  const own = wiresFor(slot);
  const index = own.findIndex(wire => normalizeWireCode(wire.code) === key);
  if (index >= 0) return { wire: own[index], status: "match", index };
  const otherSlot: SlotSize = slot === "018" ? "022" : "018";
  const other = wiresFor(otherSlot).find(wire => normalizeWireCode(wire.code) === key);
  return other ? { wire: other, status: "other_slot", index: -1 } : { wire: null, status: "off_catalogue", index: -1 };
}

type Session = WireTimelineInput["adjustments"][number];

function buildLane(arch: WireArch, treated: boolean, sessions: readonly Session[], removals: ReadonlySet<string>,
  slot: SlotSize, hasMore: boolean): WireLane {
  const segments: WireSegment[] = [];
  let key: string | null = null;
  let lastMatchIndex = -1;

  const open = (kind: WireSegment["kind"], session: Session, text: string | null): WireSegment => {
    const match = text === null ? null : catalogueFor(slot, text);
    const outOfOrder = match !== null && match.status === "match" && lastMatchIndex >= 0 && match.index < lastMatchIndex;
    if (match?.status === "match") lastMatchIndex = match.index;
    const segment: WireSegment = {
      kind, text, variants: text === null ? [] : [text],
      catalogue: match?.wire ?? null, catalogueStatus: match?.status ?? null,
      firstDocumentedOn: kind === "unknown" ? null : session.doneOn,
      lastSessionOn: session.doneOn, documentedWeeks: null,
      sessionIds: [session.id], blankSessionIds: [], endedBy: "current",
      recordedPhase: kind === "wire" ? session.phase : null,
      phaseDiffers: kind === "wire" && session.phase !== null && match?.wire != null && match.wire.phase !== session.phase,
      outOfOrder, limitedToShown: hasMore && segments.length === 0,
    };
    segments.push(segment);
    return segment;
  };

  let current: WireSegment | null = null;
  for (const session of sessions) {
    const raw = arch === "upper" ? session.upperWire : session.lowerWire;
    if (blankWire(raw)) {
      if (removals.has(`${session.id}:${arch}`) && current?.kind !== "none") {
        if (current) current.endedBy = "removal";
        current = open("none", session, null);
        key = null;
        continue;
      }
      if (!current) {
        current = open("unknown", session, null);
        current.blankSessionIds.push(session.id);
        continue;
      }
      current.sessionIds.push(session.id);
      current.blankSessionIds.push(session.id);
      current.lastSessionOn = session.doneOn;
      continue;
    }
    const text = raw as string;
    const nextKey = normalizeWireCode(text);
    if (current && current.kind === "wire" && key === nextKey) {
      current.sessionIds.push(session.id);
      current.lastSessionOn = session.doneOn;
      if (!current.variants.includes(text)) current.variants.push(text);
      continue;
    }
    if (current) current.endedBy = "change";
    current = open("wire", session, text);
    key = nextKey;
  }

  for (const segment of segments) {
    segment.documentedWeeks = segment.firstDocumentedOn === null ? null
      : Math.floor((calendarDay(segment.lastSessionOn) - calendarDay(segment.firstDocumentedOn)) / 7);
  }
  return { arch, treated, segments };
}

export function buildWireTimeline(input: WireTimelineInput): WireTimeline {
  if (!usesArchwires(input.case.appliance)) return { kind: "not_applicable" };

  for (const session of input.adjustments) {
    if (!Number.isSafeInteger(session.id) || session.id <= 0) throw new Error("رقم جلسة غير صالح.");
    calendarDay(session.doneOn);
  }
  const sessions = [...input.adjustments].sort((a, b) =>
    a.doneOn < b.doneOn ? -1 : a.doneOn > b.doneOn ? 1 : a.id - b.id);
  const removals = new Set(input.documentedRemovals.map(item => `${item.adjustmentId}:${item.arch}`));

  const lanes: WireLane[] = [];
  for (const arch of ["upper", "lower"] as const) {
    const treated = input.case.arches === "both" || input.case.arches === arch;
    const recorded = sessions.some(session => !blankWire(arch === "upper" ? session.upperWire : session.lowerWire));
    if (!treated && !recorded) continue;
    lanes.push(buildLane(arch, treated, sessions, removals, input.case.slot, input.hasMore));
  }

  const mismatches: { arch: WireArch; caseWire: string | null; lastWire: string | null }[] = [];
  for (const lane of lanes) {
    const last = lane.segments.at(-1);
    if (!last || last.kind === "unknown") continue;
    const caseWire = lane.arch === "upper" ? input.case.upperWire : input.case.lowerWire;
    const caseKey = blankWire(caseWire) ? null : normalizeWireCode(caseWire as string);
    const lastKey = last.kind === "wire" ? normalizeWireCode(last.text as string) : null;
    if (caseKey !== lastKey) {
      mismatches.push({ arch: lane.arch, caseWire: blankWire(caseWire) ? null : caseWire, lastWire: last.kind === "wire" ? last.variants.at(-1) ?? last.text : null });
    }
  }

  const elastics: ElasticPeriod[] = [];
  for (const session of sessions) {
    const previous = elastics.at(-1);
    if (previous && previous.elastics === session.elastics) {
      previous.lastSessionOn = session.doneOn;
      previous.sessions += 1;
      if (previous.note === null && session.elasticNote) previous.note = session.elasticNote;
      continue;
    }
    elastics.push({
      elastics: session.elastics, note: session.elasticNote || null,
      firstDocumentedOn: session.doneOn, lastSessionOn: session.doneOn, sessions: 1,
    });
  }

  return { kind: "timeline", lanes, elastics, truncated: input.hasMore, mismatches };
}
