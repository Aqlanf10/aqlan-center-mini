import { isValidTooth } from "./dental";
import { IDEMPOTENCY_KEY_PATTERN } from "./idempotency-key";

/** Six-site capture only. These bounds are application validation, not diagnosis. */
export const PERIO_SITES = ["MB", "B", "DB", "ML", "L", "DL"] as const;
export type PerioSite = (typeof PERIO_SITES)[number];
export interface PerioObservation {
  toothCode: number;
  site: PerioSite;
  probingDepthMm: number | null;
  bleedingOnProbing: boolean | null;
}
export interface PerioDraft {
  doctorId: number;
  caseId: number | null;
  sites: PerioObservation[];
}
export type Check<T> = { ok: true; value: T } | { ok: false; message: string };
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;

/** Reject coercion, rounding and clamping. Decimal lexical form avoids floating point multiplication errors. */
export function validProbingDepth(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 99.99
    && /^\d+(?:\.\d{1,2})?$/.test(String(value)));
}
export function canonicalPerioSites(sites: readonly PerioObservation[]): PerioObservation[] {
  return sites.map((site) => ({ ...site })).sort((a, b) => a.toothCode - b.toothCode || PERIO_SITES.indexOf(a.site) - PERIO_SITES.indexOf(b.site));
}
export function checkPerioDraft(raw: unknown): Check<PerioDraft> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "سجل اللثة غير صالح." };
  const input = raw as Record<string, unknown>;
  if (!positiveId(input.doctorId)) return { ok: false, message: "اختر الطبيب المعالج الفعلي للفحص." };
  if (input.caseId !== null && !positiveId(input.caseId)) return { ok: false, message: "اختر حالة اللثة أو حدّد عدم ربط الفحص بحالة." };
  if (!Array.isArray(input.sites) || input.sites.length > 312) return { ok: false, message: "مواضع فحص اللثة غير صالحة." };
  const seen = new Set<string>();
  const sites: PerioObservation[] = [];
  for (const rawSite of input.sites) {
    if (!rawSite || typeof rawSite !== "object" || Array.isArray(rawSite)) return { ok: false, message: "موضع فحص اللثة غير صالح." };
    const site = rawSite as Record<string, unknown>;
    if (typeof site.toothCode !== "number" || !Number.isInteger(site.toothCode) || !isValidTooth(site.toothCode)
      || typeof site.site !== "string" || !(PERIO_SITES as readonly string[]).includes(site.site)) {
      return { ok: false, message: "رقم السن أو موضع القياس غير صالح." };
    }
    const key = `${site.toothCode}:${site.site}`;
    if (seen.has(key)) return { ok: false, message: "لا يتكرر الموضع نفسه في الفحص." };
    seen.add(key);
    if (!validProbingDepth(site.probingDepthMm)) return { ok: false, message: "عمق الجيب بالملليمتر: قيمة من 0 إلى 99.99 بمنزلتين عشريتين كحد أقصى، أو غير مسجّل." };
    if (site.bleedingOnProbing !== null && typeof site.bleedingOnProbing !== "boolean") return { ok: false, message: "النزف: مسجّل نعم أو لا، أو غير مسجّل." };
    sites.push({ toothCode: site.toothCode, site: site.site as PerioSite, probingDepthMm: site.probingDepthMm, bleedingOnProbing: site.bleedingOnProbing });
  }
  return { ok: true, value: { doctorId: input.doctorId, caseId: input.caseId as number | null, sites: canonicalPerioSites(sites) } };
}
export function checkPerioRevision(value: unknown): Check<number | null> {
  return value === null || positiveId(value) ? { ok: true, value } : { ok: false, message: "رقم إصدار الفحص غير صالح. أعد تحميل السجل." };
}
export function summarizePerio(sites: readonly PerioObservation[]) {
  const recordedDepthSites = sites.filter((site) => site.probingDepthMm !== null).length;
  const recordedBleedingSites = sites.filter((site) => site.bleedingOnProbing !== null).length;
  const bleedingSites = sites.filter((site) => site.bleedingOnProbing === true).length;
  return { recordedDepthSites, recordedBleedingSites, bleedingSites, bleedingPercent: recordedBleedingSites === 0 ? null : bleedingSites / recordedBleedingSites * 100 };
}
export function hasMeaningfulPerio(sites: readonly PerioObservation[]): boolean {
  return sites.some((site) => site.probingDepthMm !== null || site.bleedingOnProbing !== null);
}
export function samePerioDraft(left: PerioDraft, right: PerioDraft): boolean {
  return left.doctorId === right.doctorId && left.caseId === right.caseId
    && JSON.stringify(canonicalPerioSites(left.sites)) === JSON.stringify(canonicalPerioSites(right.sites));
}
/** Structured, bounded audit values. Missing row and explicit unrecorded null are distinct. */
export function changedPerioSites(before: readonly PerioObservation[], after: readonly PerioObservation[]) {
  const key = (site: PerioObservation) => `${site.toothCode}:${site.site}`;
  const prior = new Map(before.map((site) => [key(site), site]));
  const next = new Map(after.map((site) => [key(site), site]));
  const identities = canonicalPerioSites([...new Map([...before, ...after].map((site) => [key(site), site])).values()]);
  return identities.flatMap((site) => {
    const oldSite = prior.get(key(site)); const newSite = next.get(key(site));
    if (oldSite && newSite && oldSite.probingDepthMm === newSite.probingDepthMm && oldSite.bleedingOnProbing === newSite.bleedingOnProbing) return [];
    const values = (value: PerioObservation | undefined) => value ? { probingDepthMm: value.probingDepthMm, bleedingOnProbing: value.bleedingOnProbing } : null;
    return [{ toothCode: site.toothCode, site: site.site, before: values(oldSite), after: values(newSite) }];
  });
}
export function checkPerioAddendum(raw: unknown): Check<{ text: string; requestKey: string }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "الملحق غير صالح." };
  const input = raw as Record<string, unknown>;
  if (typeof input.text !== "string" || !input.text.trim() || input.text.trim().length > 4000) return { ok: false, message: "اكتب نص الملحق (4000 حرف كحد أقصى)." };
  if (typeof input.requestKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(input.requestKey)) return { ok: false, message: "مفتاح إعادة محاولة الملحق غير صالح." };
  return { ok: true, value: { text: input.text.trim(), requestKey: input.requestKey } };
}
