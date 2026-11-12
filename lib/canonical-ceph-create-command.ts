import "server-only";
import { createCephAnalysis, getPool, type CephPhase } from "./db";
import { CanonicalCephWriteFailure, runCanonicalCephWrite } from "./canonical-ceph-write";
import type { VerifiedDurableSession } from "./staff-durable-session";

export class CanonicalCephCreateRefusal extends Error {
  constructor(readonly code: "invalid_ceph_create" | "ceph_create_not_found" | "ceph_create_conflict" | "ceph_create_session_expired", readonly status: 400 | 401 | 404 | 409, message: string) {
    super(message); this.name = "CanonicalCephCreateRefusal";
  }
}
const invalid = () => new CanonicalCephCreateRefusal("invalid_ceph_create", 400, "بيانات فتح مسودة السيفالومتري غير صالحة.");
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

/**
 * One new draft through staging's protected creator (patient → image lock order, same-patient
 * image and orthodontic case, audit), admitted by clinical.xrays.upload and current patient scope.
 * Same response as the legacy route, including the non-blocking same-image warning.
 */
export async function commandCanonicalCephCreate(session: VerifiedDurableSession, rawId: string, body: unknown, pool = getPool()) {
  const input = parseCanonicalCephCreate(rawId, body);
  try {
    return await runCanonicalCephWrite(session, "clinical.xrays.upload", { kind: "patient", patientId: input.patientId, documentId: input.documentId }, async ({ client, admit }) => {
      const { rows: same } = await client.query<{ id: number }>(
        "SELECT id FROM ceph_analyses WHERE patient_id=$1 AND document_id=$2 AND status<>'discarded' ORDER BY id", [input.patientId, input.documentId]);
      const created = await createCephAnalysis({ patientId: input.patientId, documentId: input.documentId, createdBy: "",
        orthoCaseId: input.orthoCaseId, phase: input.phase, xrayDate: input.xrayDate, device: input.device, refSet: input.refSet },
      { patientId: input.patientId, documentId: input.documentId, admit });
      if (!created.ok) return created;
      const duplicateWarning = same.length > 0
        ? `للهذه الشععة ${same.length} دراسة سابقة (${same.map((a) => `#${a.id}`).join("، ")}) — تابع إن كان ذلك مقصودًا.` : null;
      return { ok: true as const, value: { id: created.id, duplicateWarning } };
    }, pool);
  } catch (error) {
    if (error instanceof CanonicalCephWriteFailure) throw new CanonicalCephCreateRefusal(
      error.kind === "not_found" ? "ceph_create_not_found" : error.kind === "expired" ? "ceph_create_session_expired" : "ceph_create_conflict",
      error.kind === "not_found" ? 404 : error.kind === "expired" ? 401 : 409, error.message);
    throw error;
  }
}
