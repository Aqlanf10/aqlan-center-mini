import "server-only";
import { applyCephDraftEdit, parseCephDraftEdit, type CephDraftEdit } from "./ceph-draft-edit";
import { CanonicalCephWriteFailure, cephRouteId, runCanonicalCephWrite } from "./canonical-ceph-write";
import { getPool } from "./db";
import type { VerifiedDurableSession } from "./staff-durable-session";

export class CanonicalCephEditRefusal extends Error {
  constructor(readonly code: "invalid_ceph_edit" | "ceph_edit_not_found" | "ceph_edit_conflict" | "ceph_edit_session_expired", readonly status: 400 | 401 | 404 | 409, message: string) { super(message); this.name = "CanonicalCephEditRefusal"; }
}
/** The same body the legacy route admits: one category (calibration, landmarks or diagnosis) with its observed prior state. */
export function parseCanonicalCephEdit(rawId: string, body: unknown): { id: number; edit: CephDraftEdit } {
  const id = cephRouteId(rawId);
  if (id === null) throw new CanonicalCephEditRefusal("invalid_ceph_edit", 400, "رقم التحليل غير صالح.");
  const parsed = parseCephDraftEdit(body);
  if (!parsed.ok) throw new CanonicalCephEditRefusal("invalid_ceph_edit", 400, parsed.message);
  return { id, edit: parsed.edit };
}
/** One observed-draft edit through staging's protected writer, admitted by clinical.ceph.analyze and current patient scope. */
export async function commandCanonicalCephEdit(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalCephEdit(rawId, body);
  try {
    return await runCanonicalCephWrite(session, "clinical.ceph.analyze", { kind: "study", id: input.id }, async ({ patientId, documentId, admit }) => {
      const done = await applyCephDraftEdit(input.id, input.edit, { patientId, documentId, admit });
      return done.ok ? { ok: true as const, value: done.body } : done;
    }, pool);
  } catch (error) {
    if (error instanceof CanonicalCephWriteFailure) throw new CanonicalCephEditRefusal(
      error.kind === "not_found" ? "ceph_edit_not_found" : error.kind === "expired" ? "ceph_edit_session_expired" : "ceph_edit_conflict",
      error.kind === "not_found" ? 404 : error.kind === "expired" ? 401 : 409, error.message);
    throw error;
  }
}
