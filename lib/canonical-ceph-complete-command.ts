import "server-only";
import { getPool } from "./db";
import { cephDraftVersionWith } from "./canonical-ceph-draft-version";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

export class CanonicalCephCompleteRefusal extends Error {
  constructor(readonly code: "invalid_ceph_complete" | "ceph_complete_not_found" | "ceph_complete_conflict" | "ceph_complete_reference_invalid" | "ceph_complete_conditions" | "ceph_contract_alignment_pending", readonly status: 400 | 404 | 409, message: string) {
    super(message); this.name = "CanonicalCephCompleteRefusal";
  }
}
const missing = () => new CanonicalCephCompleteRefusal("ceph_complete_not_found", 404, "المسودة غير متاحة ضمن مرضاك.");
const conflict = () => new CanonicalCephCompleteRefusal("ceph_complete_conflict", 409, "تغيّرت المسودة أو تعذّر تثبيت حالتها. حدّث الدراسة وراجعها قبل اعتماد جديد.");
export function parseCanonicalCephComplete(rawId: string, body: unknown) {
  const id = Number(rawId), invalid = () => new CanonicalCephCompleteRefusal("invalid_ceph_complete", 400, "اعتماد الدراسة يتطلب قراءة المسودة الحالية وتأكيدًا صريحًا.");
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id) || id > 2147483647 || !body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const value = body as Record<string, unknown>;
  if (Object.keys(value).join(",") !== "expectedVersion" || typeof value.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedVersion)) throw invalid();
  return { id, expectedVersion: value.expectedVersion };
}

/** Explicit approval of one observed saved draft; no new image access or historical repair. */
/**
 * Held on the integration branch (2026-11-12). This canonical writer was built on the earlier
 * cephalometric contract; staging's protected writers (completion snapshot, sources, provenance,
 * witness, landmark/calibration checks) now own every ceph write. Until this command is re-aligned
 * with that contract it refuses before any read or write. The legacy route keeps staging's writer.
 */
export async function commandCanonicalCephComplete(_session: VerifiedDurableSession, rawId: string, body: unknown, _pool = getPool()): Promise<never> {
  parseCanonicalCephComplete(rawId, body);
  throw new CanonicalCephCompleteRefusal("ceph_contract_alignment_pending", 409, "تعديل دراسات السيفالو واعتمادها عبر هذا المسار موقوف مؤقتًا حتى مواءمته مع عقد الاعتماد الحالي (اللقطة والمصادر والأثر)؛ لم يُكتب شيء. استعمل شاشة السيفالو المعتادة.");
}
