/** Isolated mathematical proposal. No production callers or historic-result migration. */
import { dot, finitePoint, GeometryError, positiveScale, unitVector, vector, type Point2D } from "./geometry";
export const WITS_RESEARCH_DEFINITION = "wits-directed-projection/0.1.0-research" as const;
export interface WitsResearchInput {
  readonly a: Point2D;
  readonly b: Point2D;
  /** Anatomical identities, not left/right screen ordering. */
  readonly plane: { readonly posterior: Point2D; readonly anterior: Point2D; readonly construction: "synthetic-directed-line" };
  /** Synthetic grid calibration ONLY. Not detector/patient calibration. */
  readonly calibration: { readonly basis: "synthetic-grid"; readonly xMmPerUnit: number; readonly yMmPerUnit: number };
}
export function evaluateWitsResearch(input: WitsResearchInput) {
  const metadata = { definitionId: WITS_RESEARCH_DEFINITION, clinicalUseAllowed: false as const, normsStatus: "not-enabled" as const, unit: "mm" as const };
  try {
    if (!input || input.plane?.construction !== "synthetic-directed-line" || input.calibration?.basis !== "synthetic-grid") {
      return { ...metadata, status: "not-computable" as const, value: null, issue: "unsupported-research-basis" };
    }
    const sx = positiveScale(input.calibration.xMmPerUnit), sy = positiveScale(input.calibration.yMmPerUnit);
    const scaled = (p: Point2D): Point2D => {
      finitePoint(p);
      const q = finitePoint({ x: p.x * sx, y: p.y * sy });
      if ((p.x !== 0 && q.x === 0) || (p.y !== 0 && q.y === 0)) throw new GeometryError("numeric-range-exceeded");
      return q;
    };
    const a = scaled(input.a), b = scaled(input.b);
    const posterior = scaled(input.plane.posterior), anterior = scaled(input.plane.anterior);
    // Projection difference equals (A-B) dot plane unit direction. Crucially, the
    // direction is independent of AO-BO, so coincident projections remain zero.
    const value = dot(vector(b, a), unitVector(vector(posterior, anterior)));
    return { ...metadata, status: "ok" as const, value: value === 0 ? 0 : value, issue: null };
  } catch (e) {
    if (!(e instanceof GeometryError)) throw e;
    return { ...metadata, status: "not-computable" as const, value: null, issue: e.code };
  }
}
