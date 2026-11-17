/**
 * Independent research-only Steiner Core-8, not a replacement for lib/ceph.ts.
 * No clinical classification, diagnosis, IO, persistence, or chairside integration.
 * Scientific gates and migration contract: docs/ceph/independent-core-v1.md.
 */
import {
  angleBetweenRays, cross, GeometryError, positiveScale, signedDistanceToLine,
  unitVector, vector, type Point2D,
} from "./geometry";

export const STEINER_CORE_VERSION = "steiner-core-8/0.1.1-research" as const;
export const CORE_LANDMARK_IDS = [
  "S", "N", "A", "B", "U1_TIP", "U1_APEX", "U1_LABIAL", "L1_TIP", "L1_APEX", "L1_LABIAL",
] as const;
export type CoreLandmarkId = typeof CORE_LANDMARK_IDS[number];
export type CoreMeasurementId = "SNA" | "SNB" | "ANB" | "U1_NA_ANGLE" | "L1_NB_ANGLE" | "INTERINCISAL" | "U1_NA_DISTANCE" | "L1_NB_DISTANCE";
export type CoreUnit = "deg" | "mm";
export interface CoreLandmark {
  readonly id: CoreLandmarkId;
  readonly column: number;
  readonly row: number;
}
export interface CoreCalibration {
  readonly kind: "patient-plane" | "detector-plane" | "ratio-only";
  /** mm/row and mm/column, or proportional units for ratio-only. DICOM order is row then column. */
  readonly rowScale: number;
  readonly columnScale: number;
  readonly imageGeometryRevision: number;
  /** Required for patient-plane. A caller assertion is NOT clinical calibration validation. */
  readonly provenance?: string;
  readonly scopeConfirmed?: boolean;
}
export interface SteinerCoreStudy {
  readonly revision: number;
  readonly imageGeometryRevision: number;
  readonly projection: "lateral-2d";
  readonly coordinateConvention: "pixel-column-right-row-down";
  readonly orientation: { readonly anterior: "right" | "left" };
  readonly calibration: CoreCalibration;
  /** Array preserves duplicate identifiers for validation. */
  readonly landmarks: readonly CoreLandmark[];
}
type Axis = readonly [CoreLandmarkId, CoreLandmarkId];
interface DefinitionBase {
  readonly id: CoreMeasurementId;
  readonly unit: CoreUnit;
  readonly requires: readonly CoreLandmarkId[];
  readonly evidence: "primary-text-reviewed" | "figure-review-pending";
}
type Definition = DefinitionBase & (
  | { readonly operation: "angle"; readonly axes: readonly [Axis, Axis]; readonly reviewObtuse?: boolean }
  | { readonly operation: "anb" }
  | { readonly operation: "distance"; readonly line: Axis; readonly point: CoreLandmarkId }
);
// The clinical landmark-dictionary review gate remains separate for ALL metrics.
const DEFINITIONS: readonly Definition[] = [
  { id: "SNA", unit: "deg", requires: ["S", "N", "A"], evidence: "primary-text-reviewed", operation: "angle", axes: [["N", "S"], ["N", "A"]] },
  { id: "SNB", unit: "deg", requires: ["S", "N", "B"], evidence: "primary-text-reviewed", operation: "angle", axes: [["N", "S"], ["N", "B"]] },
  { id: "ANB", unit: "deg", requires: ["S", "N", "A", "B"], evidence: "primary-text-reviewed", operation: "anb" },
  { id: "U1_NA_ANGLE", unit: "deg", requires: ["N", "A", "U1_APEX", "U1_TIP"], evidence: "primary-text-reviewed", operation: "angle", axes: [["N", "A"], ["U1_APEX", "U1_TIP"]], reviewObtuse: true },
  { id: "L1_NB_ANGLE", unit: "deg", requires: ["N", "B", "L1_TIP", "L1_APEX"], evidence: "primary-text-reviewed", operation: "angle", axes: [["N", "B"], ["L1_TIP", "L1_APEX"]], reviewObtuse: true },
  { id: "INTERINCISAL", unit: "deg", requires: ["U1_TIP", "U1_APEX", "L1_TIP", "L1_APEX"], evidence: "figure-review-pending", operation: "angle", axes: [["U1_TIP", "U1_APEX"], ["L1_TIP", "L1_APEX"]] },
  { id: "U1_NA_DISTANCE", unit: "mm", requires: ["N", "A", "U1_LABIAL"], evidence: "figure-review-pending", operation: "distance", line: ["N", "A"], point: "U1_LABIAL" },
  { id: "L1_NB_DISTANCE", unit: "mm", requires: ["N", "B", "L1_LABIAL"], evidence: "figure-review-pending", operation: "distance", line: ["N", "B"], point: "L1_LABIAL" },
];
export type CoreIssueCode =
  | "invalid-study" | "invalid-revision" | "unsupported-projection" | "unknown-orientation"
  | "unsupported-coordinate-convention" | "unknown-aspect-ratio" | "stale-calibration"
  | "unverified-patient-calibration" | "invalid-landmark-collection" | "unknown-landmark-id"
  | "duplicate-landmark-id" | "missing-landmark" | "uncalibrated-patient-distance"
  | "anb-branch-ambiguous" | "incisor-axis-review" | "invalid-coordinate"
  | "non-finite-geometry" | "degenerate-vector" | "invalid-scale" | "numeric-range-exceeded";
export interface CoreIssue { readonly code: CoreIssueCode; readonly landmark?: CoreLandmarkId }
interface ResultBase {
  readonly id: CoreMeasurementId;
  readonly definitionId: string;
  readonly unit: CoreUnit;
  readonly evidence: DefinitionBase["evidence"];
  readonly clinicalUseAllowed: false;
}
export type CoreMeasurementResult = ResultBase & (
  | { readonly status: "ok"; readonly value: number }
  | { readonly status: "needs-review"; readonly value: number; readonly issue: CoreIssue }
  | { readonly status: "not-computable"; readonly value: null; readonly issue: CoreIssue }
);
export interface SteinerCoreResult {
  readonly analysisVersion: typeof STEINER_CORE_VERSION;
  readonly studyRevision: number | null;
  readonly imageGeometryRevision: number | null;
  readonly clinicalUseAllowed: false;
  readonly normsStatus: "not-enabled";
  readonly measures: readonly CoreMeasurementResult[];
}
class CoreError extends Error {
  constructor(readonly issue: CoreIssue) { super(issue.code); this.name = "CoreError"; }
}
const fail = (code: CoreIssueCode, landmark?: CoreLandmarkId): never => {
  throw new CoreError({ code, ...(landmark ? { landmark } : {}) });
};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const knownId = (value: unknown): value is CoreLandmarkId => typeof value === "string" && (CORE_LANDMARK_IDS as readonly string[]).includes(value);
interface Context {
  readonly point: (id: CoreLandmarkId) => Point2D;
  readonly linearAllowed: boolean;
}
function prepare(input: unknown): Context {
  if (!record(input)) return fail("invalid-study");
  if (!revision(input.revision) || !revision(input.imageGeometryRevision)) return fail("invalid-revision");
  if (input.projection !== "lateral-2d") return fail("unsupported-projection");
  if (input.coordinateConvention !== "pixel-column-right-row-down") return fail("unsupported-coordinate-convention");
  if (!record(input.orientation) || (input.orientation.anterior !== "right" && input.orientation.anterior !== "left")) return fail("unknown-orientation");
  const c = input.calibration;
  if (!record(c) || (c.kind !== "patient-plane" && c.kind !== "detector-plane" && c.kind !== "ratio-only")) return fail("unknown-aspect-ratio");
  if (c.imageGeometryRevision !== input.imageGeometryRevision) return fail("stale-calibration");
  if (typeof c.rowScale !== "number" || typeof c.columnScale !== "number") return fail("invalid-scale");
  let rowScale = positiveScale(c.rowScale), columnScale = positiveScale(c.columnScale);
  if (c.kind === "ratio-only") {
    // Ratios have no physical unit. A common factor cannot alter validity or angles.
    const common = Math.max(rowScale, columnScale);
    rowScale = positiveScale(rowScale / common);
    columnScale = positiveScale(columnScale / common);
  }
  if (c.kind === "patient-plane" && (typeof c.provenance !== "string" || !c.provenance.trim() || c.scopeConfirmed !== true)) return fail("unverified-patient-calibration");
  if (!Array.isArray(input.landmarks) || input.landmarks.length > CORE_LANDMARK_IDS.length) return fail("invalid-landmark-collection");
  const points = new Map<CoreLandmarkId, Record<string, unknown>>();
  for (const p of input.landmarks) {
    if (!record(p) || !knownId(p.id)) return fail("unknown-landmark-id");
    if (points.has(p.id)) return fail("duplicate-landmark-id", p.id);
    points.set(p.id, p);
  }
  const sign = input.orientation.anterior === "right" ? 1 : -1;
  return {
    linearAllowed: c.kind === "patient-plane",
    point(id) {
      const p = points.get(id);
      if (!p) return fail("missing-landmark", id);
      if (typeof p.column !== "number" || typeof p.row !== "number" || !Number.isFinite(p.column) || !Number.isFinite(p.row)) return fail("invalid-coordinate", id);
      // Correct physical aspect before angles. Display zoom, pan and overlay are not inputs.
      const point = { x: sign * p.column * columnScale, y: -p.row * rowScale };
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return fail("non-finite-geometry", id);
      // Positive finite scales can still underflow a non-zero source coordinate.
      // Reject that loss rather than manufacturing a zero linear measurement.
      if ((p.column !== 0 && point.x === 0) || (p.row !== 0 && point.y === 0)) return fail("numeric-range-exceeded", id);
      return point;
    },
  };
}
function issueOf(error: unknown): CoreIssue {
  if (error instanceof CoreError) return error.issue;
  if (error instanceof GeometryError) {
    if (["invalid-coordinate", "non-finite-geometry", "degenerate-vector", "invalid-scale"].includes(error.code)) return { code: error.code as CoreIssueCode };
  }
  throw error; // Unexpected coding defects must not masquerade as valid clinical values.
}
function base(def: Definition): ResultBase {
  return {
    id: def.id, definitionId: STEINER_CORE_VERSION + ":" + def.id, unit: def.unit,
    evidence: def.evidence, clinicalUseAllowed: false,
  };
}
/** Measurement-only engineering result. Never mutates input or recalculates legacy snapshots. */
export function evaluateSteinerCore(input: unknown): SteinerCoreResult {
  const metadata = {
    analysisVersion: STEINER_CORE_VERSION,
    studyRevision: record(input) && revision(input.revision) ? input.revision : null,
    imageGeometryRevision: record(input) && revision(input.imageGeometryRevision) ? input.imageGeometryRevision : null,
    clinicalUseAllowed: false as const, normsStatus: "not-enabled" as const,
  };
  let context: Context;
  try { context = prepare(input); }
  catch (error) {
    const issue = issueOf(error);
    return { ...metadata, measures: DEFINITIONS.map(def => ({ ...base(def), status: "not-computable", value: null, issue })) };
  }
  const measures = DEFINITIONS.map((def): CoreMeasurementResult => {
    try {
      const p = context.point;
      for (const id of def.requires) p(id);
      let value: number;
      if (def.operation === "angle") {
        value = angleBetweenRays(vector(p(def.axes[0][0]), p(def.axes[0][1])), vector(p(def.axes[1][0]), p(def.axes[1][1])));
        if (def.reviewObtuse && value > 90) return { ...base(def), status: "needs-review", value, issue: { code: "incisor-axis-review" } };
      } else if (def.operation === "anb") {
        const ns = vector(p("N"), p("S")), na = vector(p("N"), p("A")), nb = vector(p("N"), p("B"));
        const sideA = cross(unitVector(ns), unitVector(na)), sideB = cross(unitVector(ns), unitVector(nb));
        if (Math.abs(sideA) <= 1e-10 || Math.abs(sideB) <= 1e-10 || Math.sign(sideA) !== Math.sign(sideB)) return fail("anb-branch-ambiguous");
        value = angleBetweenRays(ns, na) - angleBetweenRays(ns, nb);
      } else {
        if (!context.linearAllowed) return fail("uncalibrated-patient-distance");
        value = signedDistanceToLine(p(def.point), p(def.line[0]), p(def.line[1]));
      }
      if (!Number.isFinite(value)) return fail("non-finite-geometry");
      return { ...base(def), status: "ok", value: Object.is(value, -0) ? 0 : value };
    } catch (error) {
      return { ...base(def), status: "not-computable", value: null, issue: issueOf(error) };
    }
  });
  return { ...metadata, measures };
}
