import { CEPH_READ_PHASES, type CephReadPhase } from "./canonical-ceph-projection";

export interface CephPairStudy {
  id: number; status: "draft" | "completed"; phase: CephReadPhase;
  xrayDate: string | null; createdAt: string;
  measurementsState: "saved-approved" | "saved-unapproved";
}
export interface CanonicalCephComparison {
  projection: "ceph-saved-comparison"; patientId: number;
  before: CephPairStudy; after: CephPairStudy;
  normSource: "historical-norm-not-stored";
  rows: { code: string; before: number; after: number; delta: number }[];
  onlyBefore: string[]; onlyAfter: string[];
}
export interface CephPairLine { from: { x: number; y: number }; to: { x: number; y: number }; label: string }
export interface CanonicalCephSuperimposition {
  projection: "ceph-saved-superimposition"; patientId: number;
  before: CephPairStudy & { lines: CephPairLine[] };
  after: CephPairStudy & { lines: CephPairLine[] };
  geometrySource: "derived-from-saved-landmarks";
  rotationDegrees: number; cranialBaseBefore: number; cranialBaseAfter: number;
  viewBox: { x: number; y: number; width: number; height: number };
}
function study(value: unknown): value is CephPairStudy {
  if (!value || typeof value !== "object") return false;
  const s = value as CephPairStudy;
  return Number.isSafeInteger(s.id) && s.id > 0 && (s.status === "draft" || s.status === "completed")
    && Object.hasOwn(CEPH_READ_PHASES, s.phase)
    && (s.xrayDate === null || typeof s.xrayDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.xrayDate))
    && typeof s.createdAt === "string" && Number.isFinite(Date.parse(s.createdAt))
    && s.measurementsState === (s.status === "completed" ? "saved-approved" : "saved-unapproved");
}
function pair(value: unknown, patientId: number, first: number, second: number): boolean {
  if (!value || typeof value !== "object" || first === second || ![patientId, first, second].every(id => Number.isSafeInteger(id) && id > 0)) return false;
  const v = value as CanonicalCephComparison;
  return v.patientId === patientId && study(v.before) && study(v.after) && v.before.id !== v.after.id
    && [v.before.id, v.after.id].every(id => id === first || id === second);
}
const code = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 100;
export function isCanonicalCephComparison(value: unknown, patientId: number, first: number, second: number): value is CanonicalCephComparison {
  if (!pair(value, patientId, first, second)) return false;
  const v = value as CanonicalCephComparison;
  if (v.projection !== "ceph-saved-comparison" || v.normSource !== "historical-norm-not-stored"
    || !Array.isArray(v.rows) || v.rows.length > 256 || !Array.isArray(v.onlyBefore) || v.onlyBefore.length > 256
    || !Array.isArray(v.onlyAfter) || v.onlyAfter.length > 256) return false;
  const codes = new Set<string>();
  for (const row of v.rows) {
    if (!row || !code(row.code) || codes.has(row.code) || ![row.before, row.after, row.delta].every(n => typeof n === "number" && Number.isFinite(n))
      || row.delta !== row.after - row.before) return false;
    codes.add(row.code);
  }
  for (const c of [...v.onlyBefore, ...v.onlyAfter]) { if (!code(c) || codes.has(c)) return false; codes.add(c); }
  return v.rows.length + v.onlyBefore.length <= 256 && v.rows.length + v.onlyAfter.length <= 256;
}
export function isCanonicalCephSuperimposition(value: unknown, patientId: number, first: number, second: number): value is CanonicalCephSuperimposition {
  if (!pair(value, patientId, first, second)) return false;
  const v = value as CanonicalCephSuperimposition;
  if (v.projection !== "ceph-saved-superimposition" || v.geometrySource !== "derived-from-saved-landmarks"
    || ![v.rotationDegrees, v.cranialBaseBefore, v.cranialBaseAfter].every(n => typeof n === "number" && Number.isFinite(n))
    || v.cranialBaseBefore <= 0 || v.cranialBaseAfter <= 0 || !v.viewBox
    || ![v.viewBox.x, v.viewBox.y, v.viewBox.width, v.viewBox.height].every(n => typeof n === "number" && Number.isFinite(n))
    || v.viewBox.width <= 0 || v.viewBox.height <= 0) return false;
  for (const lines of [v.before.lines, v.after.lines]) {
    if (!Array.isArray(lines) || lines.length === 0 || lines.length > 8 || lines.some(line => !line || typeof line.label !== "string" || !line.from || !line.to
      || ![line.from.x, line.from.y, line.to.x, line.to.y].every(n => typeof n === "number" && Number.isFinite(n)))) return false;
  }
  return true;
}
