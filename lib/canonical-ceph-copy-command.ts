import "server-only";
import { parseCephCorrectionCommand, type CephCorrectionSourceToken } from "./ceph-correction-origin";
import { CanonicalCephWriteFailure, cephRouteId, runCanonicalCephWrite } from "./canonical-ceph-write";
import { duplicateCephAnalysis, getPool } from "./db";
import type { VerifiedDurableSession } from "./staff-durable-session";

export class CanonicalCephCopyRefusal extends Error {
  constructor(readonly code: "invalid_ceph_copy" | "ceph_copy_not_found" | "ceph_copy_conflict" | "ceph_copy_session_expired", readonly status: 400 | 401 | 404 | 409, message: string) { super(message); this.name = "CanonicalCephCopyRefusal"; }
}
/** Staging's correction contract: the reviewed correction-source token of this exact study. */
export function parseCanonicalCephCopy(rawId: string, body: unknown): { id: number; expected: CephCorrectionSourceToken } {
  const id = cephRouteId(rawId);
  const command = parseCephCorrectionCommand(body);
  if (id === null || !command || command.expectedCorrectionSource.analysisId !== id) {
    throw new CanonicalCephCopyRefusal("invalid_ceph_copy", 400, "هوية أصل التصحيح مطلوبة؛ أعد فتح الدراسة وراجعها.");
  }
  return { id, expected: command.expectedCorrectionSource };
}
/** Correction copy through staging's writer (source token, lineage, reference checks). */
export async function commandCanonicalCephCopy(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalCephCopy(rawId, body);
  try {
    return await runCanonicalCephWrite(session, "clinical.ceph.analyze", { kind: "study", id: input.id }, async ({ patientId, documentId, admit }) => {
      const created = await duplicateCephAnalysis(input.id, "", { patientId, documentId, admit }, input.expected);
      return created.ok ? { ok: true as const, value: { id: created.id } } : created;
    }, pool);
  } catch (error) {
    if (error instanceof CanonicalCephWriteFailure) throw new CanonicalCephCopyRefusal(
      error.kind === "not_found" ? "ceph_copy_not_found" : error.kind === "expired" ? "ceph_copy_session_expired" : "ceph_copy_conflict",
      error.kind === "not_found" ? 404 : error.kind === "expired" ? 401 : 409, error.message);
    throw error;
  }
}
