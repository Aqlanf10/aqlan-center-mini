import "server-only";
import { cephCorrectionReviewWith, isCephReviewFingerprint } from "./canonical-ceph-review-fingerprint";
import { CanonicalCephWriteFailure, cephRouteId, runCanonicalCephWrite } from "./canonical-ceph-write";
import { duplicateCephAnalysis, getPool } from "./db";
import type { VerifiedDurableSession } from "./staff-durable-session";

export class CanonicalCephCopyRefusal extends Error {
  constructor(readonly code: "invalid_ceph_copy" | "ceph_copy_not_found" | "ceph_copy_conflict" | "ceph_copy_session_expired", readonly status: 400 | 401 | 404 | 409, message: string) { super(message); this.name = "CanonicalCephCopyRefusal"; }
}
/** Canonical correction contract: the fingerprint of the reviewed correction source from the canonical read. */
export function parseCanonicalCephCopy(rawId: string, body: unknown): { id: number; fingerprint: string } {
  const id = cephRouteId(rawId);
  const value = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (id === null || !value || Object.keys(value).sort().join(",") !== "expectedFingerprint,schemaVersion" || value.schemaVersion !== 1
    || !isCephReviewFingerprint(value.expectedFingerprint)) {
    throw new CanonicalCephCopyRefusal("invalid_ceph_copy", 400, "هوية أصل التصحيح مطلوبة؛ أعد فتح الدراسة وراجعها.");
  }
  return { id, fingerprint: value.expectedFingerprint };
}
/** Correction copy through staging's writer (source token, lineage, reference checks). */
export async function commandCanonicalCephCopy(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalCephCopy(rawId, body);
  try {
    return await runCanonicalCephWrite(session, "clinical.ceph.analyze", { kind: "study", id: input.id }, async ({ client, patientId, documentId, admit }) => {
      // Rebuild the correction source inside the operation; staging's writer re-checks it under its locks.
      const review = await cephCorrectionReviewWith(client, input.id);
      if (review.state !== "available" || review.fingerprint !== input.fingerprint) {
        return { ok: false as const, message: "تغيّر أصل التصحيح منذ مراجعته؛ لم تُنشأ نسخة. حدّث الدراسة وراجعها." };
      }
      const created = await duplicateCephAnalysis(input.id, "", { patientId, documentId, admit }, review.token);
      return created.ok ? { ok: true as const, value: { id: created.id } } : created;
    }, pool);
  } catch (error) {
    if (error instanceof CanonicalCephWriteFailure) throw new CanonicalCephCopyRefusal(
      error.kind === "not_found" ? "ceph_copy_not_found" : error.kind === "expired" ? "ceph_copy_session_expired" : "ceph_copy_conflict",
      error.kind === "not_found" ? 404 : error.kind === "expired" ? 401 : 409, error.message);
    throw error;
  }
}
