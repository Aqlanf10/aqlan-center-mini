import "server-only";
import { cephCompletionReviewWith, isCephReviewFingerprint } from "./canonical-ceph-review-fingerprint";
import { CanonicalCephWriteFailure, cephRouteId, runCanonicalCephWrite } from "./canonical-ceph-write";
import { completeCephAnalysis, getPool } from "./db";
import type { VerifiedDurableSession } from "./staff-durable-session";

export class CanonicalCephCompleteRefusal extends Error {
  constructor(readonly code: "invalid_ceph_complete" | "ceph_complete_not_found" | "ceph_complete_conditions" | "ceph_complete_session_expired", readonly status: 400 | 401 | 404 | 409, message: string) { super(message); this.name = "CanonicalCephCompleteRefusal"; }
}
/** Canonical completion contract: the fingerprint of the reviewed draft (snapshot and sources) from the canonical read. */
export function parseCanonicalCephComplete(rawId: string, body: unknown): { id: number; fingerprint: string } {
  const id = cephRouteId(rawId);
  if (id === null) throw new CanonicalCephCompleteRefusal("invalid_ceph_complete", 400, "رقم التحليل غير صالح.");
  const value = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!value || Object.keys(value).join(",") !== "expectedFingerprint" || !isCephReviewFingerprint(value.expectedFingerprint)) {
    throw new CanonicalCephCompleteRefusal("invalid_ceph_complete", 400, "الاعتماد يحتاج بصمة الدراسة التي راجعتها؛ أعد فتح الدراسة.");
  }
  return { id, fingerprint: value.expectedFingerprint };
}
/** Explicit completion through staging's writer (snapshot, sources, provenance witness, replay rule). */
export async function commandCanonicalCephComplete(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalCephComplete(rawId, body);
  try {
    return await runCanonicalCephWrite(session, "clinical.ceph.analyze", { kind: "study", id: input.id }, async ({ client, admit, actor }) => {
      // Rebuild the reviewed snapshot and sources inside the operation; any change since the read refuses.
      // Staging's writer then re-checks the same values under its own locks.
      const review = await cephCompletionReviewWith(client, input.id);
      if (review.state !== "available" || review.fingerprint !== input.fingerprint) {
        return { ok: false as const, message: "تغيّرت الدراسة أو مصادرها (الصورة أو المرجع) منذ مراجعتها؛ لم يُعتمد شيء. حدّث الدراسة وراجعها." };
      }
      const done = await completeCephAnalysis(input.id, actor.username, review.snapshot, actor, review.sources, admit);
      return done.ok ? { ok: true as const, value: { ok: true as const, measurements: done.measurements, summary: done.summary ?? null } }
        : { ok: false as const, message: done.message ?? "لا يمكن الاعتماد." };
    }, pool);
  } catch (error) {
    if (error instanceof CanonicalCephWriteFailure) throw new CanonicalCephCompleteRefusal(
      error.kind === "not_found" ? "ceph_complete_not_found" : error.kind === "expired" ? "ceph_complete_session_expired" : "ceph_complete_conditions",
      error.kind === "not_found" ? 404 : error.kind === "expired" ? 401 : 409, error.message);
    throw error;
  }
}
