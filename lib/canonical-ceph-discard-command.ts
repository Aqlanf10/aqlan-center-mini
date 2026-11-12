import "server-only";
import { CanonicalCephWriteFailure, cephRouteId, runCanonicalCephWrite } from "./canonical-ceph-write";
import { discardCephAnalysis, getPool } from "./db";
import type { VerifiedDurableSession } from "./staff-durable-session";

export class CanonicalCephDiscardRefusal extends Error {
  constructor(readonly code: "invalid_ceph_discard" | "ceph_discard_not_found" | "ceph_discard_conflict" | "ceph_discard_session_expired", readonly status: 400 | 401 | 404 | 409, message: string) { super(message); this.name = "CanonicalCephDiscardRefusal"; }
}
/** Same body as the legacy route: an optional textual note; anything else is ignored as before. */
export function parseCanonicalCephDiscard(rawId: string, body: unknown): { id: number; note: string | null } {
  const id = cephRouteId(rawId);
  if (id === null) throw new CanonicalCephDiscardRefusal("invalid_ceph_discard", 400, "رقم التحليل غير صالح.");
  const note = body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).note === "string"
    ? (body as Record<string, string>).note : null;
  return { id, note };
}
/** Audited soft discard of a draft through staging's lifecycle writer. */
export async function commandCanonicalCephDiscard(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalCephDiscard(rawId, body);
  try {
    return await runCanonicalCephWrite(session, "clinical.ceph.analyze", { kind: "study", id: input.id }, async ({ patientId, documentId, admit }) => {
      const done = await discardCephAnalysis(input.id, "", input.note, { patientId, documentId, admit });
      return done.ok ? { ok: true as const, value: { ok: true as const } } : done;
    }, pool);
  } catch (error) {
    if (error instanceof CanonicalCephWriteFailure) throw new CanonicalCephDiscardRefusal(
      error.kind === "not_found" ? "ceph_discard_not_found" : error.kind === "expired" ? "ceph_discard_session_expired" : "ceph_discard_conflict",
      error.kind === "not_found" ? 404 : error.kind === "expired" ? 401 : 409, error.message);
    throw error;
  }
}
