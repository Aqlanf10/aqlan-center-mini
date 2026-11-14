import type { LandmarkMap } from "../../lib/ceph";
/**
 * Defined synthetic geometry (same as the staging ortho-case-identity fixture). Staging's completion
 * gate refuses landmarks from which a measurement cannot be computed, so arbitrary index-derived
 * points (which can be collinear) are not a valid "legitimate geometry" baseline.
 */
export const VALID_CEPH_POINTS: LandmarkMap = {
  S: { x: 100, y: 20 }, N: { x: 169, y: 12 }, A: { x: 167.57, y: 71.98 },
  B: { x: 163.84, y: 99.85 }, Pog: { x: 164.03, y: 106.87 }, Me: { x: 160, y: 125 },
  Gn: { x: 161.5, y: 115.5 }, Go: { x: 82.97, y: 89.08 }, Or: { x: 160, y: 45 },
  Po: { x: 100, y: 45 }, U1A: { x: 160, y: 54 }, U1: { x: 174.08, y: 91.44 },
  L1A: { x: 149, y: 119.2 }, L1: { x: 168, y: 84 },
  OcclA: { x: 170, y: 68 }, OcclP: { x: 100, y: 55.3 },
};
export function validCephPoint(code: string): { x: number; y: number } {
  const point = (VALID_CEPH_POINTS as Record<string, { x: number; y: number } | undefined>)[code];
  if (!point) throw new Error(`No defined synthetic geometry for landmark ${code}`);
  return point;
}
