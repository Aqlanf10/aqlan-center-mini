import { permitsOrthoDocumentation, orthoDocumentationContext, type OrthoLifecycleStatus } from "./ortho-assessment-lifecycle";
import type { SessionPayload } from "./auth";
import { ensureSchema, findUserByUsername, getPool, type DbClient } from "./db";
import { canAccessPatient } from "./patient-access";
import { requireSession } from "./session";
import { journeyId, type JourneyScope } from "./ortho-case-journey-records";
export interface JourneyOwnerInput { session: SessionPayload; patientId: number; orthoCaseId: number }
export interface JourneyAuthority {
  session: SessionPayload; userId: number; name: string; canWrite: boolean; canViewPlans: boolean;
  canEditPlans: boolean; canViewImages: boolean;
}
export interface JourneyOwner extends JourneyScope {
  status: OrthoLifecycleStatus;
  recordingContext: "current" | "retrospective"; planId: number | null;
}
export class JourneyFault extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function journeyFail(status: number, code: string, message = "تعذّر التحقق من سجل الحالة؛ أعد القراءة وراجع الصلاحيات والمراجع."): never {
  throw new JourneyFault(status, code, message);
}
export function assertJourneyCurrent(authority: JourneyAuthority) {
  if (authority.session.expiresAt < Date.now()) journeyFail(401, "session_expired", "انتهت الجلسة. سجّل الدخول من جديد.");
}
/** Patient -> current users/session -> access witnesses -> selected sources -> case.
 * Route admission outside this transaction does not replace current authority. */
export async function authorizeJourney(client: DbClient, input: JourneyOwnerInput, write: boolean): Promise<JourneyAuthority> {
  if (!journeyId(input.patientId) || !journeyId(input.orthoCaseId)) journeyFail(400, "invalid_scope");
  const { rows } = await client.query<{ id: number }>(`SELECT id FROM patients WHERE id=$1 ${write ? "FOR NO KEY UPDATE" : "FOR SHARE"}`, [input.patientId]);
  const session = await requireSession(client);
  if (!session || !journeyId(session.userId) || session.expiresAt < Date.now()
    || session.userId !== input.session.userId || session.username !== input.session.username || session.role !== input.session.role) journeyFail(401, "session_expired");
  const user = await findUserByUsername(session.username, client);
  if (!user || !user.isActive || user.id !== session.userId || user.role !== session.role || user.username.toLowerCase() !== session.username.toLowerCase()) journeyFail(401, "session_expired");
  const canWrite = session.role === "admin" || session.role === "doctor";
  if (write && !canWrite || !canWrite && session.role !== "reception") journeyFail(403, "clinical_access_denied");
  if (!rows[0]) journeyFail(404, "patient_not_found");
  if (!await canAccessPatient(session, input.patientId, undefined, client)) journeyFail(403, "patient_access_denied");
  const canViewPlans = await canAccessPatient(session, input.patientId, "canViewPlans", client);
  const canEditPlans = canWrite && canViewPlans && await canAccessPatient(session, input.patientId, "canEditPlans", client);
  const canViewImages = await canAccessPatient(session, input.patientId, "canViewXrays", client);
  return { session, userId: user.id, name: user.displayName, canWrite, canViewPlans, canEditPlans, canViewImages };
}
/** Selected source plan/visit/document locks must precede this child lock. */
export async function lockJourneyOwner(client: DbClient, input: JourneyOwnerInput, write: boolean): Promise<JourneyOwner> {
  return readJourneyOwner(client, input, write ? "FOR UPDATE" : "FOR SHARE");
}
/** Discovery under the patient lock only. Caller must later lock and compare the
 * owner before mutation; this avoids child-before-selected-source lock order. */
export async function discoverJourneyOwner(client: DbClient, input: JourneyOwnerInput): Promise<JourneyOwner> {
  return readJourneyOwner(client, input, "");
}
async function readJourneyOwner(client: DbClient, input: JourneyOwnerInput, lock: "" | "FOR UPDATE" | "FOR SHARE"): Promise<JourneyOwner> {
  const { rows: cases } = await client.query<{ id: number; patient_id: number; status: string; plan_id: number | null }>(
    `SELECT id,patient_id,status,plan_id FROM ortho_cases WHERE id=$1 ${lock}`, [input.orthoCaseId]);
  const ortho = cases[0];
  if (!ortho || ortho.patient_id !== input.patientId) journeyFail(404, "ortho_case_not_found");
  if (!permitsOrthoDocumentation(ortho.status)) journeyFail(409, "invalid_case_state");
  const { rows: bridges } = await client.query<{ id: number; patient_id: number; ortho_case_id: number }>(
    `SELECT id,patient_id,ortho_case_id FROM clinical_cases WHERE ortho_case_id=$1 ${lock}`, [ortho.id]);
  if (bridges.length !== 1) journeyFail(409, bridges.length ? "ambiguous_bridge" : "bridge_missing");
  const bridge = bridges[0];
  if (bridge.patient_id !== input.patientId || bridge.ortho_case_id !== ortho.id) journeyFail(409, "scope_mismatch");
  return { patientId: ortho.patient_id, orthoCaseId: ortho.id, clinicalCaseId: bridge.id, status: ortho.status,
    planId: ortho.plan_id, recordingContext: orthoDocumentationContext(ortho.status) };
}
export interface JourneyFailure { ok: false; status: number; code: string; message: string }
export async function journeyTransaction<T extends { ok: true }>(write: boolean, body: (client: DbClient) => Promise<T>): Promise<T | JourneyFailure> {
  await ensureSchema(); const client = await getPool().connect(); let committing = false;
  try {
    await client.query("BEGIN"); const result = await body(client); committing = true; await client.query("COMMIT"); return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof JourneyFault) return { ok: false, status: error.status, code: error.code, message: error.message };
    if (write && committing) return { ok: false, status: 503, code: "write_unconfirmed", message: "لم تتأكد نتيجة الحفظ. أعد التحقق بنفس معرّف الطلب ومحتواه." };
    throw error;
  } finally { client.release(); }
}
