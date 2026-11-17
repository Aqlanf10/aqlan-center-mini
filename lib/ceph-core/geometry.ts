/** Pure 2D geometry. Numerical guards are not clinical uncertainty thresholds. */
export interface Point2D { readonly x: number; readonly y: number }
export type GeometryErrorCode = "invalid-coordinate" | "non-finite-geometry" | "degenerate-vector" | "unstable-intersection" | "invalid-scale" | "invalid-reference-length" | "numeric-range-exceeded";
export class GeometryError extends Error {
  constructor(readonly code: GeometryErrorCode) { super(code); this.name = "GeometryError"; }
}
const MIN_VECTOR_LENGTH = 1e-10;
const MIN_INTERSECTION_SINE = 1e-10;
export function finitePoint(p: Point2D): Point2D {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new GeometryError("invalid-coordinate");
  return p;
}
function finiteNumber(n: number): number {
  if (!Number.isFinite(n)) throw new GeometryError("non-finite-geometry");
  return n;
}
export function vector(from: Point2D, to: Point2D): Point2D {
  finitePoint(from); finitePoint(to);
  return { x: finiteNumber(to.x - from.x), y: finiteNumber(to.y - from.y) };
}
export function distance2D(a: Point2D, b: Point2D): number {
  const v = vector(a, b);
  return finiteNumber(Math.hypot(v.x, v.y));
}
export function unitVector(v: Point2D): Point2D {
  finitePoint(v);
  const length = finiteNumber(Math.hypot(v.x, v.y));
  if (length <= MIN_VECTOR_LENGTH) throw new GeometryError("degenerate-vector");
  return { x: v.x / length, y: v.y / length };
}
export const cross = (a: Point2D, b: Point2D): number => finiteNumber(a.x * b.y - a.y * b.x);
export const dot = (a: Point2D, b: Point2D): number => finiteNumber(a.x * b.x + a.y * b.y);
/** Ordered rays, 0..180 degrees. Never silently fold obtuse angles to acute ones. */
export function angleBetweenRays(a: Point2D, b: Point2D): number {
  const u = unitVector(a), v = unitVector(b);
  return Math.atan2(Math.abs(cross(u, v)), dot(u, v)) * 180 / Math.PI;
}
/** Positive means LEFT of directed a->b in a right-handed mathematical frame. */
export function signedDistanceToLine(p: Point2D, a: Point2D, b: Point2D): number {
  return cross(unitVector(vector(a, b)), vector(a, p));
}
export function projectOntoLine(p: Point2D, a: Point2D, b: Point2D): Point2D {
  const u = unitVector(vector(a, b)), along = dot(vector(a, p), u);
  return finitePoint({ x: finiteNumber(a.x + along * u.x), y: finiteNumber(a.y + along * u.y) });
}
/** Infinite lines. Parallel or nearly parallel lines are deliberately not a point. */
export function intersectLines(a: Point2D, b: Point2D, c: Point2D, d: Point2D): Point2D {
  const u = unitVector(vector(a, b)), v = unitVector(vector(c, d));
  const determinant = cross(u, v);
  if (Math.abs(determinant) <= MIN_INTERSECTION_SINE) throw new GeometryError("unstable-intersection");
  const along = cross(vector(a, c), v) / determinant;
  return finitePoint({ x: finiteNumber(a.x + along * u.x), y: finiteNumber(a.y + along * u.y) });
}
export function positiveScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new GeometryError("invalid-scale");
  return value;
}
/** Assumes known isotropic image pixels. This primitive does not establish patient depth. */
export function isotropicScaleFromReference(a: Point2D, b: Point2D, referenceMm: number): number {
  if (!Number.isFinite(referenceMm) || referenceMm <= 0) throw new GeometryError("invalid-reference-length");
  const pixels = distance2D(a, b);
  if (pixels <= MIN_VECTOR_LENGTH) throw new GeometryError("degenerate-vector");
  return positiveScale(referenceMm / pixels);
}
/** Explicit factors: 1.08 means 108% of true size, not an increase of 108%. */
export function convertLinearMagnificationBasis(value: number, fromFactor: number, toFactor: number): number {
  finiteNumber(value); positiveScale(fromFactor); positiveScale(toFactor);
  // Equal bases must be an identity, even for subnormal values.
  if (fromFactor === toFactor || value === 0) return value;
  const ratio = toFactor / fromFactor;
  const result = value * ratio;
  // Reject unrepresentable intermediates rather than reporting a false zero.
  if (!Number.isFinite(ratio) || ratio === 0 || !Number.isFinite(result) || result === 0) {
    throw new GeometryError("numeric-range-exceeded");
  }
  return result;
}
