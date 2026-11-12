import "server-only";
import { getPool } from "./db";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

export class CanonicalCephCopyRefusal extends Error {
  constructor(readonly code: "invalid_ceph_copy" | "ceph_copy_not_found" | "ceph_copy_conflict" | "ceph_copy_reference_invalid" | "ceph_copy_limit" | "ceph_copy_stored_data_invalid" | "ceph_contract_alignment_pending", readonly status: 400 | 404 | 409, message: string) {
    super(message); this.name = "CanonicalCephCopyRefusal";
  }
}
const missing = () => new CanonicalCephCopyRefusal("ceph_copy_not_found", 404, "الدراسة غير متاحة ضمن مرضاك.");
const conflict = () => new CanonicalCephCopyRefusal("ceph_copy_conflict", 409, "تعذّر إنشاء نسخة التصحيح من الحالة الحالية. حدّث الدراسات وتحقق من المسودة قبل طلب جديد.");
const invalidReference = () => new CanonicalCephCopyRefusal("ceph_copy_reference_invalid", 409, "تعذّر التحقق من مراجع الدراسة؛ لم تُنشأ نسخة جزئية.");
const invalidSource = () => new CanonicalCephCopyRefusal("ceph_copy_stored_data_invalid", 409, "بيانات المعايرة أو المعالم المحفوظة غير صالحة للنسخ؛ لم تُغيّر الدراسة الأصلية.");
export function parseCanonicalCephCopy(rawId: string, body: unknown) {
  const id = Number(rawId);
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id) || !body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
    throw new CanonicalCephCopyRefusal("invalid_ceph_copy", 400, "طلب نسخة التصحيح يقبل رقم الدراسة فقط، دون تعديل محتواها.");
  }
  return id;
}

/** A fresh correction intention, not a durable request receipt. Source facts are copied, never recomputed. */
/**
 * Held on the integration branch (2026-11-12). This canonical writer was built on the earlier
 * cephalometric contract; staging's protected writers (completion snapshot, sources, provenance,
 * witness, landmark/calibration checks) now own every ceph write. Until this command is re-aligned
 * with that contract it refuses before any read or write. The legacy route keeps staging's writer.
 */
export async function commandCanonicalCephCopy(_session: VerifiedDurableSession, rawId: string, body: unknown, _pool = getPool()): Promise<never> {
  parseCanonicalCephCopy(rawId, body);
  throw new CanonicalCephCopyRefusal("ceph_contract_alignment_pending", 409, "تعديل دراسات السيفالو واعتمادها عبر هذا المسار موقوف مؤقتًا حتى مواءمته مع عقد الاعتماد الحالي (اللقطة والمصادر والأثر)؛ لم يُكتب شيء. استعمل شاشة السيفالو المعتادة.");
}
