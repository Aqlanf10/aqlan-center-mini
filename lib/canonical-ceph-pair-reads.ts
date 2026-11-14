import "server-only";
import { runCanonicalReadSnapshot, type CanonicalSnapshotQuery, type CanonicalSnapshotScope } from "./canonical-read-snapshot";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { canonicalCephReadId, readCephStudyWith } from "./canonical-ceph-reads";
import type { CanonicalCephStudy } from "./canonical-ceph-projection";
import { CanonicalPatientReadRefusal } from "./canonical-patient-reads";
import { CEPH_ORDER_REQUIRED_NOTICE, compareAnalyses, resolveCephComparisonOrder } from "./cephCompare";
import { referenceLines, superimposeOnSN } from "./cephSuperimpose";
import { isCephLandmarkCode, type LandmarkMap } from "./ceph";
import { isCanonicalCephComparison, isCanonicalCephSuperimposition, type CanonicalCephComparison, type CanonicalCephSuperimposition, type CephPairStudy } from "./canonical-ceph-pair-projection";

export type CanonicalCephPairMode = "compare" | "superimpose";
export class CanonicalCephPairRefusal extends Error {
  constructor(readonly code: "ceph_pair_patient_mismatch" | "ceph_pair_invalid" | "ceph_pair_geometry_unavailable" | "ceph_pair_order_unresolved", message: string) { super(message); this.name = "CanonicalCephPairRefusal"; }
}
export function canonicalCephPairIds(params: URLSearchParams): [number, number] {
  if ([...params.keys()].some(k => k !== "first" && k !== "second") || params.getAll("first").length !== 1 || params.getAll("second").length !== 1) {
    throw new CanonicalPatientReadRefusal("invalid_patient_query", "اختر دراستين مختلفتين دون توسيع البيانات من الرابط.");
  }
  const first = canonicalCephReadId(params.get("first") ?? "", new URLSearchParams());
  const second = canonicalCephReadId(params.get("second") ?? "", new URLSearchParams());
  if (first === second) throw new CanonicalPatientReadRefusal("invalid_patient_query", "اختر دراستين مختلفتين.");
  return [first, second];
}
function summary(study: CanonicalCephStudy): CephPairStudy {
  const a = study.analysis;
  return { id: a.id, status: a.status, phase: a.phase, xrayDate: a.xrayDate, createdAt: a.createdAt, measurementsState: study.measurementsState };
}
function invalid(): never { throw new CanonicalCephPairRefusal("ceph_pair_invalid", "تعذّر التحقق من المقارنة المحفوظة؛ لم تُستبدل النتائج بحساب جديد."); }
async function pairWith(q: CanonicalSnapshotQuery, scope: CanonicalSnapshotScope, first: number, second: number) {
  if (first === second || ![first, second].every(id => Number.isSafeInteger(id) && id > 0)) invalid();
  const one = await readCephStudyWith(q, scope, first), two = await readCephStudyWith(q, scope, second);
  if (one.analysis.patientId !== two.analysis.patientId) throw new CanonicalCephPairRefusal("ceph_pair_patient_mismatch", "اختر دراستين للمريض نفسه.");
  // Staging's comparison contract: only the image acquisition date establishes chronology.
  // No creation-time, id or phase fallback; an unresolved order is refused, never guessed.
  const order = resolveCephComparisonOrder({ id: Number(one.analysis.id), xrayDate: one.analysis.xrayDate, saved: one },
    { id: Number(two.analysis.id), xrayDate: two.analysis.xrayDate, saved: two });
  if (order.state === "invalid") invalid();
  if (order.state !== "resolved") throw new CanonicalCephPairRefusal("ceph_pair_order_unresolved", CEPH_ORDER_REQUIRED_NOTICE);
  return { patientId: one.analysis.patientId, before: order.before.saved, after: order.after.saved };
}
export async function compareCephPairWith(q: CanonicalSnapshotQuery, scope: CanonicalSnapshotScope, first: number, second: number): Promise<CanonicalCephComparison> {
  const pair = await pairWith(q, scope, first, second);
  // The schema stores code/value, not a historical norm snapshot. Never call
  // computeAll or substitute today's norm/diagnosis for a saved measurement.
  const comparable = (study: CanonicalCephStudy) => study.measurements.map(m => ({ ...m, name: m.code, unit: "", mean: null }));
  const comparison = compareAnalyses(comparable(pair.before), comparable(pair.after));
  // Staging's comparator skips a pair whose difference overflows; a saved value present in both
  // studies must never vanish from the canonical answer, so refuse the whole comparison instead.
  const afterValues = new Map(pair.after.measurements.map(m => [m.code, m.value]));
  if (pair.before.measurements.some(m => afterValues.has(m.code) && Number.isFinite(m.value) && Number.isFinite(afterValues.get(m.code))
    && !Number.isFinite((afterValues.get(m.code) as number) - m.value))) invalid();
  const result: CanonicalCephComparison = { projection: "ceph-saved-comparison", patientId: pair.patientId, before: summary(pair.before), after: summary(pair.after), normSource: "historical-norm-not-stored",
    rows: comparison.measurements.map(m => ({ code: m.key, before: m.before, after: m.after, delta: m.delta })), onlyBefore: comparison.onlyBefore, onlyAfter: comparison.onlyAfter };
  if (!isCanonicalCephComparison(result, pair.patientId, first, second)) invalid();
  return result;
}
export async function superimposeCephPairWith(q: CanonicalSnapshotQuery, scope: CanonicalSnapshotScope, first: number, second: number): Promise<CanonicalCephSuperimposition> {
  const pair = await pairWith(q, scope, first, second);
  const points = (study: CanonicalCephStudy) => {
    const result: LandmarkMap = {}; for (const p of study.landmarks) if (isCephLandmarkCode(p.code)) result[p.code] = { x: p.x, y: p.y }; return result;
  };
  const beforePoints = points(pair.before), afterPoints = points(pair.after);
  for (const p of [beforePoints, afterPoints]) if (p.S && p.N && p.S.x === p.N.x && p.S.y === p.N.y) {
    throw new CanonicalCephPairRefusal("ceph_pair_geometry_unavailable", "المعلمان S وN متطابقان؛ لا يمكن تحديد اتجاه التراكب من هذه البيانات.");
  }
  const placed = superimposeOnSN({ points: beforePoints, mmPerPixel: pair.before.analysis.mmPerPixel }, { points: afterPoints, mmPerPixel: pair.after.analysis.mmPerPixel });
  if (!placed.ok) throw new CanonicalCephPairRefusal("ceph_pair_geometry_unavailable", placed.message);
  const before = { ...summary(pair.before), lines: referenceLines(beforePoints) }, after = { ...summary(pair.after), lines: referenceLines(placed.value.points) };
  const all = [...before.lines, ...after.lines].flatMap(line => [line.from, line.to]);
  if (!all.length) invalid();
  const minX = Math.min(...all.map(p => p.x)), minY = Math.min(...all.map(p => p.y));
  const width = Math.max(...all.map(p => p.x)) - minX, height = Math.max(...all.map(p => p.y)) - minY;
  const padding = Math.max(width, height) * 0.1 + 1;
  const result: CanonicalCephSuperimposition = { projection: "ceph-saved-superimposition", patientId: pair.patientId, before, after, geometrySource: "derived-from-saved-landmarks",
    rotationDegrees: placed.value.rotationDegrees, cranialBaseBefore: placed.value.cranialBaseBefore, cranialBaseAfter: placed.value.cranialBaseAfter,
    viewBox: { x: minX - padding, y: minY - padding, width: width + padding * 2, height: height + padding * 2 } };
  if (!isCanonicalCephSuperimposition(result, pair.patientId, first, second)) invalid();
  return result;
}
export function readCanonicalCephPair(session: VerifiedDurableSession, mode: CanonicalCephPairMode, first: number, second: number) {
  return runCanonicalReadSnapshot<CanonicalCephComparison | CanonicalCephSuperimposition>(session, mode === "compare" ? "read:ceph.compare" : "read:ceph.superimpose",
    (q, scope) => mode === "compare" ? compareCephPairWith(q, scope, first, second) : superimposeCephPairWith(q, scope, first, second), { errorPrefix: "STAFF_READ", maxBytes: 2 * 1024 * 1024 });
}
