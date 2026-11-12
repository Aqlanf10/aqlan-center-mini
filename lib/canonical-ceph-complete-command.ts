import "server-only";
import { parseCephCompletionSnapshot, type CephCompletionSnapshot } from "./ceph-completion-snapshot";
import { parseCephSourceIdentity, type CephSourceIdentity } from "./ceph-source-review";
import { CanonicalCephWriteFailure, cephRouteId, runCanonicalCephWrite } from "./canonical-ceph-write";
import { completeCephAnalysis, getPool } from "./db";
import type { VerifiedDurableSession } from "./staff-durable-session";

export class CanonicalCephCompleteRefusal extends Error {
  constructor(readonly code: "invalid_ceph_complete" | "ceph_complete_not_found" | "ceph_complete_conditions" | "ceph_complete_session_expired", readonly status: 400 | 401 | 404 | 409, message: string) { super(message); this.name = "CanonicalCephCompleteRefusal"; }
}
/** Staging's completion contract: the reviewed snapshot, and the reviewed source identity when sent. */
export function parseCanonicalCephComplete(rawId: string, body: unknown): { id: number; snapshot: CephCompletionSnapshot; sources: CephSourceIdentity | null } {
  const id = cephRouteId(rawId);
  if (id === null) throw new CanonicalCephCompleteRefusal("invalid_ceph_complete", 400, "رقم التحليل غير صالح.");
  const value = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  const snapshot = parseCephCompletionSnapshot(value?.expectedSnapshot);
  if (!snapshot) throw new CanonicalCephCompleteRefusal("invalid_ceph_complete", 400, "الاعتماد يحتاج نسخة صالحة من البيانات التي راجعتها.");
  const hasSources = !!value && Object.hasOwn(value, "expectedSources");
  const sources = hasSources ? parseCephSourceIdentity(value!.expectedSources) : null;
  if (hasSources && !sources) throw new CanonicalCephCompleteRefusal("invalid_ceph_complete", 400, "هوية مصادر المراجعة غير صالحة؛ أعد فتح الدراسة.");
  return { id, snapshot, sources };
}
/** Explicit completion through staging's writer (snapshot, sources, provenance witness, replay rule). */
export async function commandCanonicalCephComplete(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalCephComplete(rawId, body);
  try {
    return await runCanonicalCephWrite(session, "clinical.ceph.analyze", { kind: "study", id: input.id }, async ({ admit, actor }) => {
      const done = await completeCephAnalysis(input.id, actor.username, input.snapshot, actor, input.sources, admit);
      return done.ok ? { ok: true as const, value: { ok: true as const, measurements: done.measurements, summary: done.summary } }
        : { ok: false as const, message: done.message ?? "لا يمكن الاعتماد." };
    }, pool);
  } catch (error) {
    if (error instanceof CanonicalCephWriteFailure) throw new CanonicalCephCompleteRefusal(
      error.kind === "not_found" ? "ceph_complete_not_found" : error.kind === "expired" ? "ceph_complete_session_expired" : "ceph_complete_conditions",
      error.kind === "not_found" ? 404 : error.kind === "expired" ? 401 : 409, error.message);
    throw error;
  }
}
