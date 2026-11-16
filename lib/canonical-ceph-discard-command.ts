import "server-only";
import { CanonicalCephWriteFailure, runCanonicalCephWrite } from "./canonical-ceph-write";
import { cephDraftVersionWith } from "./canonical-ceph-draft-version";
import { discardCephAnalysis, getPool } from "./db";
import type { VerifiedDurableSession } from "./staff-durable-session";

export class CanonicalCephDiscardRefusal extends Error {
  constructor(readonly code: "invalid_ceph_discard" | "ceph_discard_not_found" | "ceph_discard_conflict" | "ceph_discard_session_expired", readonly status: 400 | 401 | 404 | 409, message: string) { super(message); this.name = "CanonicalCephDiscardRefusal"; }
}
const conflictMessage = "تغيّرت المسودة أو تعذّر تثبيت حالتها. حدّث الدراسة وراجعها قبل طلب رفض جديد.";
const stale = () => new CanonicalCephWriteFailure("conflict", conflictMessage);

/** #539's exact body: the observed draft version and an explicit note (text or null), nothing else. */
export function parseCanonicalCephDiscard(rawId: string, body: unknown): { id: number; expectedVersion: string; note: string | null } {
  const id = Number(rawId), invalid = () => new CanonicalCephDiscardRefusal("invalid_ceph_discard", 400, "راجع المسودة الحالية وملاحظة الرفض؛ لم يُختصر النص.");
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id) || id > 2147483647 || !body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const value = body as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "expectedVersion,note" || typeof value.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedVersion)
    || value.note !== null && (typeof value.note !== "string" || value.note.length > 4000)) throw invalid();
  return { id, expectedVersion: value.expectedVersion, note: typeof value.note === "string" ? value.note.trim() || null : null };
}

/**
 * Audited soft discard of a draft through staging's lifecycle writer, admitted on the canonical runtime.
 * Before the writer runs, the same transaction locks the patient and then the study (the writer's own
 * order) and compares the draft version the user observed, with its children share-locked. A draft that
 * changed after it was read, or is no longer a draft, is refused with 409 and nothing is written; the
 * writer then re-checks status and scope under its own locks and records the audit row.
 */
export async function commandCanonicalCephDiscard(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalCephDiscard(rawId, body);
  try {
    return await runCanonicalCephWrite(session, "clinical.ceph.analyze", { kind: "study", id: input.id }, async ({ client, patientId, documentId, admit }) => {
      await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [patientId]);
      const { rows: [study] } = await client.query<{ status: string }>(
        "SELECT status FROM ceph_analyses WHERE id=$1 AND patient_id=$2 FOR UPDATE NOWAIT", [input.id, patientId]);
      if (!study || study.status !== "draft") throw stale();
      let observed: string | null;
      try { observed = await cephDraftVersionWith(client, input.id, true); }
      catch (error) { if (error instanceof Error && error.message === "CEPH_DRAFT_VERSION_LIMIT") throw stale(); throw error; }
      if (observed !== input.expectedVersion) throw stale();
      const done = await discardCephAnalysis(input.id, "", input.note, { patientId, documentId, admit });
      return done.ok ? { ok: true as const, value: { ok: true as const, studyId: input.id, status: "discarded" as const } } : done;
    }, pool);
  } catch (error) {
    if (error instanceof CanonicalCephWriteFailure) throw new CanonicalCephDiscardRefusal(
      error.kind === "not_found" ? "ceph_discard_not_found" : error.kind === "expired" ? "ceph_discard_session_expired" : "ceph_discard_conflict",
      error.kind === "not_found" ? 404 : error.kind === "expired" ? 401 : 409, error.message);
    throw error;
  }
}
