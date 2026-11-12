import "server-only";
import { getPool } from "./db";
import { cephDraftVersionWith } from "./canonical-ceph-draft-version";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

export class CanonicalCephDiscardRefusal extends Error {
  constructor(readonly code: "invalid_ceph_discard" | "ceph_discard_not_found" | "ceph_discard_conflict" | "ceph_discard_reference_invalid" | "ceph_contract_alignment_pending", readonly status: 400 | 404 | 409, message: string) {
    super(message); this.name = "CanonicalCephDiscardRefusal";
  }
}
const missing = () => new CanonicalCephDiscardRefusal("ceph_discard_not_found", 404, "المسودة غير متاحة ضمن مرضاك.");
const conflict = () => new CanonicalCephDiscardRefusal("ceph_discard_conflict", 409, "تغيّرت المسودة أو تعذّر تثبيت حالتها. حدّث الدراسة وراجعها قبل طلب رفض جديد.");
export function parseCanonicalCephDiscard(rawId: string, body: unknown) {
  const id = Number(rawId), invalid = () => new CanonicalCephDiscardRefusal("invalid_ceph_discard", 400, "راجع المسودة الحالية وملاحظة الرفض؛ لم يُختصر النص.");
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id) || !body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const value = body as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "expectedVersion,note" || typeof value.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedVersion) || value.note !== null && (typeof value.note !== "string" || value.note.length > 4000)) throw invalid();
  return { id, expectedVersion: value.expectedVersion, note: typeof value.note === "string" ? value.note.trim() || null : null };
}

/** Preserves the existing draft-only soft discard; approved history and child rows are retained. */
/**
 * Held on the integration branch (2026-11-12). This canonical writer was built on the earlier
 * cephalometric contract; staging's protected writers (completion snapshot, sources, provenance,
 * witness, landmark/calibration checks) now own every ceph write. Until this command is re-aligned
 * with that contract it refuses before any read or write. The legacy route keeps staging's writer.
 */
export async function commandCanonicalCephDiscard(_session: VerifiedDurableSession, rawId: string, body: unknown, _pool = getPool()): Promise<never> {
  parseCanonicalCephDiscard(rawId, body);
  throw new CanonicalCephDiscardRefusal("ceph_contract_alignment_pending", 409, "تعديل دراسات السيفالو واعتمادها عبر هذا المسار موقوف مؤقتًا حتى مواءمته مع عقد الاعتماد الحالي (اللقطة والمصادر والأثر)؛ لم يُكتب شيء. استعمل شاشة السيفالو المعتادة.");
}
