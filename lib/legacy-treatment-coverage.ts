import { isValidTooth, MAX_SELECTED_TEETH } from "./dental";
import { caseSiteOverlaps, lineLinkage, siteText, validateLineSite, type LineSite } from "./invoice-clinical-linkage";

export const LEGACY_COVERAGE_FORMAT_VERSION = 1 as const;

/** Identity from the immutable agreement, never from current case/catalog labels. */
export interface LegacyCoverageIdentity {
  agreementId: number;
  serviceId: number;
  anchorToothCode: number | null;
}

export interface NormalizedLegacyCoverage extends LegacyCoverageIdentity {
  readonly formatVersion: typeof LEGACY_COVERAGE_FORMAT_VERSION;
  /** The object and its complete episode tooth array are frozen at the read boundary. */
  readonly site: Readonly<LineSite>;
  readonly storedCategory: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export type LegacyCoverageState =
  | { kind: "verified"; coverage: NormalizedLegacyCoverage }
  | { kind: "unknown"; reason: "missing_snapshot" | "unsupported_format" }
  | { kind: "conflict"; reason: "invalid_snapshot" | "identity_mismatch" | "invalid_site" };

/** PostgreSQL row contract. Supply the snapshot itself, not the containing agreement row. */
export interface LegacyCoverageSnapshotRow {
  agreement_id: number;
  format_version: number;
  service_id: number;
  service_category: string;
  anchor_tooth_code: number | null;
  snapshot_mode: LineSite["mode"];
  snapshot_tooth_codes: number[];
  snapshot_scope: LineSite["scope"];
  snapshot_surfaces: string | null;
  recorded_by: string;
  /** Prefer recorded_at::text when selecting so PostgreSQL sub-millisecond precision survives. */
  recorded_at: string | Date;
}

const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nullableTooth = (value: unknown): value is number | null => value === null || typeof value === "number" && isValidTooth(value);
const sameTeeth = (a: readonly number[] | null, b: readonly number[] | null) =>
  a === null || b === null ? a === b : a.length === b.length && a.every((tooth, index) => tooth === b[index]);
const teethOf = (site: Readonly<LineSite>): readonly number[] => site.episodeTeeth ?? (site.toothCode === null ? [] : [site.toothCode]);
const sameSite = (a: Readonly<LineSite>, b: Readonly<LineSite>) => a.mode === b.mode && a.toothCode === b.toothCode
  && a.scope === b.scope && a.surfaces === b.surfaces && sameTeeth(a.episodeTeeth, b.episodeTeeth);

/**
 * Decode, validate and bind an immutable snapshot. Never repair corrupt stored data by
 * sorting/deduplicating it, interpreting a mutable case label or consulting today's category.
 * Missing historical snapshots are unknown; a void agreement's snapshot stays verified
 * spatial evidence but is NEVER financial clearance. Callers retain all status/review checks.
 */
export function legacyCoverageStateFromSnapshot(raw: unknown, expected: LegacyCoverageIdentity): LegacyCoverageState {
  if (raw === null || raw === undefined) return { kind: "unknown", reason: "missing_snapshot" };
  if (typeof raw !== "object" || Array.isArray(raw)) return { kind: "conflict", reason: "invalid_snapshot" };
  const row = raw as Record<string, unknown>;
  if (!positiveId(expected.agreementId) || !positiveId(expected.serviceId) || !nullableTooth(expected.anchorToothCode)
    || !positiveId(row.agreement_id) || !positiveId(row.service_id) || !nullableTooth(row.anchor_tooth_code)) {
    return { kind: "conflict", reason: "invalid_snapshot" };
  }
  if (row.agreement_id !== expected.agreementId || row.service_id !== expected.serviceId || row.anchor_tooth_code !== expected.anchorToothCode) {
    return { kind: "conflict", reason: "identity_mismatch" };
  }
  if (typeof row.format_version !== "number" || !Number.isSafeInteger(row.format_version) || row.format_version < 1) {
    return { kind: "conflict", reason: "invalid_snapshot" };
  }
  if (row.format_version !== LEGACY_COVERAGE_FORMAT_VERSION) return { kind: "unknown", reason: "unsupported_format" };
  const recordedAt = row.recorded_at instanceof Date
    ? Number.isFinite(row.recorded_at.valueOf()) ? row.recorded_at.toISOString() : null
    : typeof row.recorded_at === "string" && row.recorded_at.trim() !== "" && Number.isFinite(Date.parse(row.recorded_at)) ? row.recorded_at : null;
  if (typeof row.service_category !== "string" || lineLinkage({ serviceId: row.service_id, category: row.service_category }).kind !== "clinical"
    || typeof row.recorded_by !== "string" || row.recorded_by.trim() !== row.recorded_by || row.recorded_by.length < 1 || row.recorded_by.length > 200
    || recordedAt === null || !Array.isArray(row.snapshot_tooth_codes) || row.snapshot_tooth_codes.length > MAX_SELECTED_TEETH
    || row.snapshot_tooth_codes.some((tooth, index, teeth) => typeof tooth !== "number" || !isValidTooth(tooth) || index > 0 && tooth <= teeth[index - 1])
    || row.snapshot_scope !== null && typeof row.snapshot_scope !== "string"
    || row.snapshot_surfaces !== null && typeof row.snapshot_surfaces !== "string") {
    return { kind: "conflict", reason: "invalid_snapshot" };
  }
  const teeth = row.snapshot_tooth_codes as number[];
  const checked = validateLineSite({ category: row.service_category, toothCode: row.anchor_tooth_code,
    episodeTeeth: row.snapshot_mode === "multi_tooth_episode" ? teeth : null,
    scope: row.snapshot_scope as string | null, surfaces: row.snapshot_surfaces as string | null });
  if (!checked.ok || checked.site.mode !== row.snapshot_mode || checked.site.toothCode !== row.anchor_tooth_code
    || checked.site.scope !== row.snapshot_scope || checked.site.surfaces !== row.snapshot_surfaces || !sameTeeth(teethOf(checked.site), teeth)) {
    return { kind: "conflict", reason: "invalid_site" };
  }
  if (checked.site.episodeTeeth) Object.freeze(checked.site.episodeTeeth);
  const site = Object.freeze(checked.site);
  return { kind: "verified", coverage: Object.freeze({ ...expected, formatVersion: LEGACY_COVERAGE_FORMAT_VERSION,
    site, storedCategory: row.service_category, recordedBy: row.recorded_by, recordedAt }) };
}

/** One shared scalar-JSON projection for plan-item readers; multiple agreements are not silently collapsed. */
export function legacyCoverageStateFromContext(raw: unknown): LegacyCoverageState {
  if (raw === null || raw === undefined) return { kind: "unknown", reason: "missing_snapshot" };
  if (typeof raw !== "object" || Array.isArray(raw)) return { kind: "conflict", reason: "invalid_snapshot" };
  const context = raw as Record<string, unknown>;
  if (context.agreementCount !== 1 || !positiveId(context.agreementId) || !positiveId(context.serviceId)
    || !nullableTooth(context.anchorToothCode)) return { kind: "conflict", reason: "identity_mismatch" };
  return legacyCoverageStateFromSnapshot(context.snapshot, { agreementId: context.agreementId,
    serviceId: context.serviceId, anchorToothCode: context.anchorToothCode });
}

/** Defensive validation for a normalized incoming site; malformed input cannot create an escape. */
function isCanonicalSite(site: Readonly<LineSite>): boolean {
  if (!site || typeof site !== "object") return false;
  const category = ({ none: site.scope === "full_mouth" ? "whitening" : "consultation", per_tooth_episode: "rct",
    multi_tooth_episode: "bridge", tooth_surfaces: "filling", region: "cleaning", arch: "ortho" } as Record<string, string>)[site.mode];
  if (!category || !nullableTooth(site.toothCode) || site.surfaces !== null && typeof site.surfaces !== "string"
    || site.scope !== null && typeof site.scope !== "string"
    || site.episodeTeeth !== null && (!Array.isArray(site.episodeTeeth) || site.episodeTeeth.some((tooth) => typeof tooth !== "number"))) return false;
  const checked = validateLineSite({ category, toothCode: site.toothCode, surfaces: site.surfaces,
    episodeTeeth: site.episodeTeeth, scope: site.scope });
  return checked.ok && sameSite(checked.site, site);
}

/**
 * Duplicate-billing hold only. Caller first selects the same patient AND immutable service
 * across all agreement states/currencies. Unknown/conflict must hold that work for review.
 * Disjoint surfaces still overlap: this extension does not invent a new surface-charge rule.
 */
export function legacyCoverageOverlaps(state: LegacyCoverageState, incomingSite: Readonly<LineSite>): boolean {
  if (state.kind !== "verified" || !isCanonicalSite(incomingSite)) return true;
  return caseSiteOverlaps(siteText(state.coverage.site), incomingSite);
}

/**
 * Spatial containment is stricter than overlap. It does not prove agreement is live, case
 * bridge/consent, service/currency compatibility, correct canonical item, or clinical completion.
 * A surface-specific request cannot be expanded from unknown historical surfaces, and a
 * surface-specific snapshot cannot claim unknown/all requested surfaces.
 */
export function legacyCoverageContains(state: LegacyCoverageState, incomingSite: Readonly<LineSite>): boolean {
  if (state.kind !== "verified" || !isCanonicalSite(incomingSite)) return false;
  const existing = state.coverage.site;
  if (existing.mode === "tooth_surfaces" || incomingSite.mode === "tooth_surfaces") {
    if (existing.mode !== incomingSite.mode || existing.surfaces === null || incomingSite.surfaces === null
      || ![...incomingSite.surfaces].every((surface) => existing.surfaces!.includes(surface))) return false;
  }
  if (existing.scope !== null) {
    if (incomingSite.scope !== null) return existing.scope === incomingSite.scope
      || (existing.scope === "both" || existing.scope === "full_mouth");
    const incomingTeeth = teethOf(incomingSite);
    return incomingTeeth.length > 0 && incomingTeeth.every((tooth) => caseSiteOverlaps(siteText(existing), {
      mode: "per_tooth_episode", toothCode: tooth, surfaces: null, episodeTeeth: null, scope: null,
    }));
  }
  if (incomingSite.scope !== null) return false;
  const existingTeeth = teethOf(existing), incomingTeeth = teethOf(incomingSite);
  return incomingTeeth.length > 0 && incomingTeeth.every((tooth) => existingTeeth.includes(tooth));
}
