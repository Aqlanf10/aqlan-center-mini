import { SITE_SCOPE_LABEL, validateLineSite, type LineSite } from "@/lib/invoice-clinical-linkage";
import { isCurrency, type Currency } from "@/lib/money";
import { planItemsProgress, type PlanItemLike } from "@/lib/plans";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const minor = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nullableText = (value: unknown) => value === null || typeof value === "string";

export type LegacyCoverageState = "verified" | "unknown" | "conflict";

/** Read normalized snapshot fields only. Never reconstruct coverage from an anchor or case title. */
export function readLegacyCoverageSite(value: unknown): LineSite | null {
  if (!record(value)) return null;
  const categories = { none: null, per_tooth_episode: "rct", multi_tooth_episode: "bridge",
    tooth_surfaces: "filling", arch: "ortho", region: "cleaning" } as const;
  if (typeof value.mode !== "string" || !Object.hasOwn(categories, value.mode)
    || (value.toothCode !== null && !positiveId(value.toothCode))
    || (value.surfaces !== null && typeof value.surfaces !== "string")
    || (value.episodeTeeth !== null && (!Array.isArray(value.episodeTeeth) || !value.episodeTeeth.every(positiveId)))
    || (value.scope !== null && typeof value.scope !== "string")) return null;
  const mode = value.mode as LineSite["mode"];
  const checked = validateLineSite({ category: mode === "none" && value.scope === "full_mouth" ? "whitening" : categories[mode],
    toothCode: value.toothCode as number | null, surfaces: value.surfaces as string | null,
    episodeTeeth: value.episodeTeeth as number[] | null, scope: value.scope as string | null });
  if (!checked.ok || checked.site.mode !== mode || checked.site.toothCode !== value.toothCode
    || checked.site.surfaces !== value.surfaces || checked.site.scope !== value.scope
    || JSON.stringify(checked.site.episodeTeeth) !== JSON.stringify(value.episodeTeeth)) return null;
  return checked.site;
}

export function legacyCoverageLabel(site: LineSite): string {
  if (site.episodeTeeth?.length) return `أسنان الحلقة: ${site.episodeTeeth.join("، ")}`;
  if (site.toothCode !== null) return `سن ${site.toothCode}${site.surfaces ? ` · الأسطح: ${site.surfaces}` : ""}`;
  if (site.scope !== null) return SITE_SCOPE_LABEL[site.scope];
  return "لا يتطلب موضعًا سنّيًّا";
}

export interface HistoricalPlanItem {
  legacyAgreementId?: number;
  legacyAgreementStatus?: "live" | "void";
  billingStatus?: string;
  legacyCoverageState?: LegacyCoverageState;
  legacyCoverageSite?: LineSite | null;
  legacyCurrentConsentRequired?: boolean;
}
/** Historical identity survives void. Missing state is not evidence of coverage. */
export function hasLegacyHistory(item: HistoricalPlanItem): boolean {
  return positiveId(item.legacyAgreementId);
}
export function legacyCoverageIsLive(item: HistoricalPlanItem): boolean {
  return hasLegacyHistory(item) && item.legacyAgreementStatus === "live"
    && item.billingStatus === "included_in_package" && item.legacyCoverageState === "verified"
    && readLegacyCoverageSite(item.legacyCoverageSite) !== null;
}
/** A historical timestamp alone is not evidence of genuine current consent. */
export function legacyConsentIsCurrent(item: HistoricalPlanItem, consented: boolean): boolean {
  return consented && legacyCoverageIsLive(item) && item.legacyCurrentConsentRequired === false;
}
export function planConsentIsCurrent(plan: { consentAt: string | null; items: readonly HistoricalPlanItem[] }): boolean {
  return Boolean(plan.consentAt) && plan.items.filter(hasLegacyHistory).every((item) => legacyConsentIsCurrent(item, true));
}
export function ordinaryPlanProgress(items: readonly (HistoricalPlanItem & PlanItemLike)[]) {
  return planItemsProgress(items.filter((item) => !hasLegacyHistory(item)));
}

export interface LegacyAgreementView {
  id: number; serviceName: string; specialtyLabel: string; toothCode: number | null; caseTitle: string | null;
  currency: Currency; agreedMinor: number; previouslyPaidMinor: number; remainingMinor: number; historicalAsOf: string;
  coverageState: LegacyCoverageState; coverageSite: LineSite | null;
  openingEffect: "none" | "created" | "increased"; status: "live" | "void"; createdBy: string; voidReason: string | null;
}
export function readLegacyAgreements(value: unknown, patientId: number): { agreements: LegacyAgreementView[]; canVoid: boolean } | null {
  if (!record(value) || !Array.isArray(value.agreements) || !record(value.access)
    || typeof value.access.void !== "boolean") return null;
  const ids = new Set<number>();
  const agreements: LegacyAgreementView[] = [];
  for (const row of value.agreements) {
    if (!record(row) || !positiveId(row.id) || ids.has(row.id) || row.patientId !== patientId
      || typeof row.serviceName !== "string" || typeof row.specialtyLabel !== "string"
      || (row.toothCode !== null && !positiveId(row.toothCode)) || !nullableText(row.caseTitle)
      || !isCurrency(row.currency) || !minor(row.agreedMinor) || !minor(row.previouslyPaidMinor)
      || !minor(row.remainingMinor) || row.agreedMinor - row.previouslyPaidMinor !== row.remainingMinor
      || typeof row.historicalAsOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.historicalAsOf)
      || !["none", "created", "increased"].includes(String(row.openingEffect))
      || (row.status !== "live" && row.status !== "void") || typeof row.createdBy !== "string"
      || !nullableText(row.voidReason)) return null;
    const coverageState = row.coverageState === undefined ? "unknown" : row.coverageState;
    if (coverageState !== "verified" && coverageState !== "unknown" && coverageState !== "conflict") return null;
    const coverageSite = coverageState === "verified" ? readLegacyCoverageSite(row.coverageSite) : null;
    if ((coverageState === "verified" && coverageSite === null)
      || (coverageState !== "verified" && row.coverageSite !== null && row.coverageSite !== undefined)) return null;
    agreements.push({ ...row, coverageState, coverageSite } as unknown as LegacyAgreementView);
    ids.add(row.id);
  }
  return { agreements, canVoid: value.access.void };
}

export interface LegacyCaseView { key: string; title: string; site: string | null }
/** Validate the entire unified projection before exposing any patient title. */
export function readLegacyCases(value: unknown, patientId: number, specialty: string): LegacyCaseView[] | null {
  if (!record(value) || !Array.isArray(value.cases)) return null;
  const result: LegacyCaseView[] = [];
  const keys = new Set<string>();
  for (const row of value.cases) {
    if (!record(row) || row.patientId !== patientId || typeof row.title !== "string" || !row.title.trim()
      || typeof row.specialty !== "string" || !nullableText(row.site)
      || !["active", "waiting", "completed", "closed", "cancelled"].includes(String(row.status))
      || (row.legacy !== undefined && typeof row.legacy !== "boolean")) return null;
    const specialtyCase = row.kind === "specialty" && positiveId(row.id)
      && (row.orthoCaseId === null || positiveId(row.orthoCaseId));
    const orthoProjection = row.kind === "ortho" && row.id === null && positiveId(row.orthoCaseId)
      && row.specialty === "orthodontics";
    if (!specialtyCase && !orthoProjection) return null;
    const key = specialtyCase ? `case-${row.id}` : `ortho-${row.orthoCaseId}`;
    if (keys.has(key)) return null;
    keys.add(key);
    if (row.specialty === specialty && row.legacy === true && (row.status === "active" || row.status === "waiting")) {
      result.push({ key, title: row.title, site: row.site as string | null });
    }
  }
  return result;
}
