import "server-only";
import { getPool, type CephPhase } from "./db";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

export class CanonicalCephCreateRefusal extends Error {
  constructor(readonly code: "invalid_ceph_create" | "ceph_create_not_found" | "ceph_create_conflict" | "ceph_create_reference_invalid" | "ceph_contract_alignment_pending", readonly status: 400 | 404 | 409, message: string) {
    super(message); this.name = "CanonicalCephCreateRefusal";
  }
}
const invalid = () => new CanonicalCephCreateRefusal("invalid_ceph_create", 400, "بيانات فتح مسودة السيفالومتري غير صالحة.");
const missing = () => new CanonicalCephCreateRefusal("ceph_create_not_found", 404, "المريض غير متاح ضمن مرضاك.");
const conflict = () => new CanonicalCephCreateRefusal("ceph_create_conflict", 409, "تعذّر فتح المسودة من الحالة الحالية. راجع الدراسات قبل طلب جديد.");
const reference = () => new CanonicalCephCreateRefusal("ceph_create_reference_invalid", 409, "تعذّر التحقق من صورة المريض أو الحالة المرتبطة؛ لم تُنشأ مسودة.");
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const phases = new Set(["pretreatment", "during", "posttreatment", "followup"]);
export function parseCanonicalCephCreate(raw: string, body: unknown) {
  const patientId = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(patientId) || patientId > 2147483647 || !body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const row = body as Record<string, unknown>;
  if (Object.keys(row).some(k => !["documentId", "orthoCaseId", "phase", "xrayDate", "device", "refSet"].includes(k)) || !positive(row.documentId)) throw invalid();
  if (row.orthoCaseId !== undefined && row.orthoCaseId !== null && !positive(row.orthoCaseId)) throw invalid();
  if (row.phase !== undefined && (typeof row.phase !== "string" || !phases.has(row.phase))) throw invalid();
  const text = (value: unknown, max: number) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.length > max) throw invalid();
    return value.trim() || null;
  };
  const date = row.xrayDate;
  if (date !== undefined && date !== null && (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "0001-01-01" || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) throw invalid();
  return { patientId, documentId: row.documentId, orthoCaseId: row.orthoCaseId as number | null | undefined ?? null, phase: (row.phase ?? "pretreatment") as CephPhase, xrayDate: date as string | null | undefined ?? null, device: text(row.device, 120), refSet: text(row.refSet, 60) };
}

/** One new intention. The native single-draft constraint is not a permanent request receipt. */
/**
 * Held on the integration branch (2026-11-12). This canonical writer was built on the earlier
 * cephalometric contract; staging's protected writers (completion snapshot, sources, provenance,
 * witness, landmark/calibration checks) now own every ceph write. Until this command is re-aligned
 * with that contract it refuses before any read or write. The legacy route keeps staging's writer.
 */
export async function commandCanonicalCephCreate(_session: VerifiedDurableSession, rawId: string, body: unknown, _pool = getPool()): Promise<never> {
  parseCanonicalCephCreate(rawId, body);
  throw new CanonicalCephCreateRefusal("ceph_contract_alignment_pending", 409, "تعديل دراسات السيفالو واعتمادها عبر هذا المسار موقوف مؤقتًا حتى مواءمته مع عقد الاعتماد الحالي (اللقطة والمصادر والأثر)؛ لم يُكتب شيء. استعمل شاشة السيفالو المعتادة.");
}
