import { isValidTooth } from "./dental";
import { IDEMPOTENCY_KEY_PATTERN } from "./idempotency-key";

/** Measurement storage only. No diagnosis, clinical cutoffs or treatment advice. */
export const PERIO_SURFACES = ["facial", "lingual"] as const;
export const PERIO_POSITIONS = ["mesial", "mid", "distal"] as const;
export type PerioSurface = typeof PERIO_SURFACES[number];
export type PerioPosition = typeof PERIO_POSITIONS[number];
export interface PeriodontalSite {
  surface: PerioSurface;
  position: PerioPosition;
  /** Exact nonnegative decimal millimetres; null is unrecorded, never zero. */
  depthMm: string | null;
  /** null = unrecorded; false = explicitly recorded absence of bleeding. */
  bleeding: boolean | null;
}
export interface PeriodontalCommand {
  toothCode: number;
  expectedHeadId: number | null;
  requestKey: string;
  sites: PeriodontalSite[];
}
export interface PeriodontalRecord {
  id: number;
  patientId: number;
  toothCode: number;
  priorRecordId: number | null;
  recordedBy: string;
  recordedAt: string;
  sites: PeriodontalSite[];
}
export type PeriodontalValidation<T> = { ok: true; value: T } | { ok: false; message: string };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
export const isPeriodontalId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;

/** The 16-character limit is a wire-format budget, not a clinical normal/range. */
export function periodontalDepth(raw: unknown): PeriodontalValidation<string | null> {
  if (raw === null) return { ok: true, value: null };
  // JavaScript `$` can match before a final line terminator. This lookahead
  // requires actual end-of-input, so storage and the replay fingerprint agree.
  if (typeof raw !== "string" || raw.length > 16 || !/^(?:0|[1-9]\d*)(?:\.\d+)?(?![\s\S])/.test(raw)) {
    return { ok: false, message: "أدخل عمق السبر بالمليمتر كعدد عشري غير سالب، أو اتركه غير مسجّل." };
  }
  // Canonicalize spelling without converting through an IEEE-754 number.
  const value = raw.includes(".") ? raw.replace(/0+$/, "").replace(/\.$/, "") : raw;
  return { ok: true, value };
}

export function parsePeriodontalSites(raw: unknown): PeriodontalValidation<PeriodontalSite[]> {
  if (!Array.isArray(raw) || raw.length !== 6) return { ok: false, message: "حدّد المواضع الستة، مع إبقاء القياسات غير المدخلة غير مسجّلة." };
  const sites = new Map<string, PeriodontalSite>();
  for (const item of raw) {
    if (!object(item) || !exactKeys(item, ["surface", "position", "depthMm", "bleeding"])
      || !PERIO_SURFACES.includes(item.surface as PerioSurface)
      || !PERIO_POSITIONS.includes(item.position as PerioPosition)
      || (item.bleeding !== null && typeof item.bleeding !== "boolean")) {
      return { ok: false, message: "بيانات موضع قياس اللثة غير صالحة." };
    }
    const depth = periodontalDepth(item.depthMm);
    if (!depth.ok) return depth;
    const key = `${item.surface}:${item.position}`;
    if (sites.has(key)) return { ok: false, message: "موضع القياس مكرر." };
    sites.set(key, { surface: item.surface as PerioSurface, position: item.position as PerioPosition,
      depthMm: depth.value, bleeding: item.bleeding });
  }
  return { ok: true, value: PERIO_SURFACES.flatMap((surface) =>
    PERIO_POSITIONS.map((position) => sites.get(`${surface}:${position}`)!)) };
}

export function parsePeriodontalCommand(raw: unknown): PeriodontalValidation<PeriodontalCommand> {
  if (!object(raw) || !exactKeys(raw, ["toothCode", "expectedHeadId", "requestKey", "sites"])) {
    return { ok: false, message: "طلب قياسات اللثة غير صالح أو يحتوي حقولًا غير مدعومة." };
  }
  if (typeof raw.toothCode !== "number" || !isValidTooth(raw.toothCode)) {
    return { ok: false, message: "رقم السن غير صالح بترقيم FDI." };
  }
  if (raw.expectedHeadId !== null && !isPeriodontalId(raw.expectedHeadId)) {
    return { ok: false, message: "مرجع آخر قياس محفوظ غير صالح." };
  }
  // Keep the shared helper unchanged. Bound the RAW key and require the
  // shared grammar's match to consume it completely (including terminators).
  if (typeof raw.requestKey !== "string" || raw.requestKey.length < 8 || raw.requestKey.length > 128
    || IDEMPOTENCY_KEY_PATTERN.exec(raw.requestKey)?.[0] !== raw.requestKey) {
    return { ok: false, message: "مفتاح طلب الحفظ غير صالح." };
  }
  const sites = parsePeriodontalSites(raw.sites);
  if (!sites.ok) return sites;
  if (!sites.value.some((site) => site.depthMm !== null || site.bleeding !== null)) {
    return { ok: false, message: "أدخل قياسًا أو نتيجة نزف واحدة على الأقل قبل الحفظ." };
  }
  return { ok: true, value: { toothCode: raw.toothCode, expectedHeadId: raw.expectedHeadId,
    requestKey: raw.requestKey, sites: sites.value } };
}

export function emptyPeriodontalSites(): PeriodontalSite[] {
  return PERIO_SURFACES.flatMap((surface) => PERIO_POSITIONS.map((position) =>
    ({ surface, position, depthMm: null, bleeding: null })));
}
