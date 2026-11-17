/**
 * C1 — SN to mandibular plane as TWO separately versioned research definitions (C0 finding: the legacy
 * `SNGOGN` is labelled Go–Gn but computed on Go–Me). Isolated: no production callers, no stored-result change,
 * no norms. `clinicalUseAllowed` is always false until the validation gates (docs/ceph) are met.
 *
 * Gnathion is ambiguous in the literature (C0, McNamara 1984): ANATOMIC gnathion is a traced point on the
 * symphysis; CONSTRUCTED gnathion is the intersection of the facial plane (N–Pog) with the mandibular plane
 * (Go–Me). The caller must say which one — there is no default. With constructed gnathion, Gn lies on the Go–Me
 * line, so SN-GoGn equals SN-GoMe exactly; the two only differ with an anatomic gnathion.
 */
import { angleBetweenRays, finitePoint, GeometryError, intersectLines, positiveScale, vector, type Point2D } from "./geometry";

export const SN_GOME_RESEARCH_DEFINITION = "sn-gome-angle/0.1.0-research" as const;
export const SN_GOGN_RESEARCH_DEFINITION = "sn-gogn-angle/0.1.0-research" as const;

/** Synthetic grid calibration ONLY; unequal x/y scales are applied before any angle. */
export interface SyntheticGridCalibration { readonly basis: "synthetic-grid"; readonly xMmPerUnit: number; readonly yMmPerUnit: number }

export type GnathionInput =
  | { readonly kind: "anatomic"; readonly point: Point2D }
  /** Constructed from the facial plane N–Pog and the mandibular plane Go–Me. */
  | { readonly kind: "constructed"; readonly pogonion: Point2D };

export interface MandibularPlaneResearchInput {
  readonly s?: Point2D;
  readonly n?: Point2D;
  readonly go?: Point2D;
  readonly me?: Point2D;
  /** Required only for SN-GoGn. */
  readonly gnathion?: GnathionInput;
  /** Synthetic grid calibration ONLY (same basis as the Wits research proposal). Angles are measured in mm space,
   * so unequal x/y scales are applied before the angle — never computed on raw pixels. */
  readonly calibration: SyntheticGridCalibration;
}

export type MandibularPlaneIssue =
  | "unsupported-research-basis" | "missing-landmark" | "gnathion-kind-required" | "unknown-gnathion-kind"
  | "gnathion-equals-gonion" | GeometryError["code"];

export interface MandibularPlaneResult {
  readonly definitionId: typeof SN_GOME_RESEARCH_DEFINITION | typeof SN_GOGN_RESEARCH_DEFINITION;
  readonly unit: "deg";
  readonly clinicalUseAllowed: false;
  readonly normsStatus: "not-enabled";
  readonly status: "ok" | "not-computable";
  readonly value: number | null;
  readonly issue: MandibularPlaneIssue | null;
  /** Which gnathion produced the value (SN-GoGn only). */
  readonly gnathionKind?: "anatomic" | "constructed";
  /** Names the landmarks that were missing, never filled in. */
  readonly missing?: readonly string[];
}

/** Angle between two LINES (undirected), 0–90°: the order in which plane endpoints are traced cannot flip it. */
function lineAngle(a: Point2D, b: Point2D, c: Point2D, d: Point2D): number {
  const theta = angleBetweenRays(vector(a, b), vector(c, d));
  return Math.min(theta, 180 - theta);
}

export function syntheticGridScaler(calibration: SyntheticGridCalibration) {
  const sx = positiveScale(calibration.xMmPerUnit), sy = positiveScale(calibration.yMmPerUnit);
  return (p: Point2D): Point2D => {
    finitePoint(p);
    const q = finitePoint({ x: p.x * sx, y: p.y * sy });
    if ((p.x !== 0 && q.x === 0) || (p.y !== 0 && q.y === 0)) throw new GeometryError("numeric-range-exceeded");
    return q;
  };
}

function base(definitionId: MandibularPlaneResult["definitionId"]) {
  return { definitionId, unit: "deg" as const, clinicalUseAllowed: false as const, normsStatus: "not-enabled" as const };
}
const missingOf = (input: MandibularPlaneResearchInput, names: readonly ("s" | "n" | "go" | "me")[]) =>
  names.filter(name => !input[name]).map(name => ({ s: "S", n: "N", go: "Go", me: "Me" })[name]);

export function evaluateSnGoMeResearch(input: MandibularPlaneResearchInput): MandibularPlaneResult {
  const meta = base(SN_GOME_RESEARCH_DEFINITION);
  if (!input || input.calibration?.basis !== "synthetic-grid") return { ...meta, status: "not-computable", value: null, issue: "unsupported-research-basis" };
  const missing = missingOf(input, ["s", "n", "go", "me"]);
  if (missing.length) return { ...meta, status: "not-computable", value: null, issue: "missing-landmark", missing };
  try {
    const at = syntheticGridScaler(input.calibration);
    return { ...meta, status: "ok", value: lineAngle(at(input.s!), at(input.n!), at(input.go!), at(input.me!)), issue: null };
  } catch (error) {
    if (!(error instanceof GeometryError)) throw error;
    return { ...meta, status: "not-computable", value: null, issue: error.code };
  }
}

export function evaluateSnGoGnResearch(input: MandibularPlaneResearchInput): MandibularPlaneResult {
  const meta = base(SN_GOGN_RESEARCH_DEFINITION);
  if (!input || input.calibration?.basis !== "synthetic-grid") return { ...meta, status: "not-computable", value: null, issue: "unsupported-research-basis" };
  if (!input.gnathion) return { ...meta, status: "not-computable", value: null, issue: "gnathion-kind-required" };
  const kind = input.gnathion.kind;
  if (kind !== "anatomic" && kind !== "constructed") return { ...meta, status: "not-computable", value: null, issue: "unknown-gnathion-kind" };
  // Constructed gnathion also needs Me (mandibular plane) and Pog (facial plane); anatomic needs neither.
  const missing = missingOf(input, kind === "constructed" ? ["s", "n", "go", "me"] : ["s", "n", "go"]);
  if (kind === "anatomic" && !input.gnathion.point) missing.push("Gn");
  if (kind === "constructed" && !input.gnathion.pogonion) missing.push("Pog");
  if (missing.length) return { ...meta, status: "not-computable", value: null, issue: "missing-landmark", gnathionKind: kind, missing };
  try {
    const at = syntheticGridScaler(input.calibration);
    const s = at(input.s!), n = at(input.n!), go = at(input.go!);
    const gn = input.gnathion.kind === "anatomic" ? at(input.gnathion.point)
      : intersectLines(n, at(input.gnathion.pogonion), go, at(input.me!));
    if (gn.x === go.x && gn.y === go.y) return { ...meta, status: "not-computable", value: null, issue: "gnathion-equals-gonion", gnathionKind: kind };
    return { ...meta, status: "ok", value: lineAngle(s, n, go, gn), issue: null, gnathionKind: kind };
  } catch (error) {
    if (!(error instanceof GeometryError)) throw error;
    return { ...meta, status: "not-computable", value: null, issue: error.code, gnathionKind: kind };
  }
}
