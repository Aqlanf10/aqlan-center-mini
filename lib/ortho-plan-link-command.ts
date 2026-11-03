import "server-only";
import { createHash } from "node:crypto";
import { doctorOwnsPatient, findUserByUsername, getPool, linkOrthoCasePlanWith, type DbClient } from "./db";
import { canAccessPatient } from "./patient-access";
import type { SessionPayload } from "./auth";
import { revalidateSessionInTransaction } from "./session";

export class OrthoPlanLinkRefusal extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409, readonly code: string, message: string) { super(message); }
}
const conflict = () => new OrthoPlanLinkRefusal(409, "ortho_plan_link_conflict", "تغيّر ارتباط الحالة أو تعذّر قفله. أعد القراءة وراجع الاختيار قبل طلب جديد.");
const denied = () => new OrthoPlanLinkRefusal(403, "ortho_plan_link_denied", "غير مصرّح لك بعرض أو تعديل ارتباط هذه الحالة.");
export function parseOrthoPlanLinkId(raw: string): number {
  const id = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id) || id > 2147483647) throw new OrthoPlanLinkRefusal(400, "invalid_case", "رقم الحالة غير صالح.");
  return id;
}
export function parseOrthoPlanLink(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new OrthoPlanLinkRefusal(400, "invalid_link", "أعد تحميل الحالة قبل تغيير الارتباط.");
  const row = body as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "expectedVersion,planId"
    || typeof row.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(row.expectedVersion)
    || row.planId !== null && (typeof row.planId !== "number" || !Number.isSafeInteger(row.planId) || row.planId <= 0 || row.planId > 2147483647)) {
    throw new OrthoPlanLinkRefusal(400, "invalid_link", "اختر خطة واحدة مع نسخة الحالة الحالية. أعد تحميل الصفحة إن كانت قديمة.");
  }
  return { planId: row.planId as number | null, expectedVersion: row.expectedVersion };
}
type Observation = { id: number; patient_id: number; plan_id: number | null; status: string; revision: string; location: string };
const COLUMNS = "id,patient_id,plan_id,status,xmin::text AS revision,ctid::text AS location";
function version(row: Observation): string {
  return createHash("sha256").update(JSON.stringify([row.id, row.patient_id, row.plan_id, row.status, row.revision, row.location])).digest("hex");
}
async function authority(client: DbClient, admitted: SessionPayload, patientId: number | null, write: boolean | null) {
  const current = await revalidateSessionInTransaction(admitted, client);
  if (!current) throw new OrthoPlanLinkRefusal(401, "session_expired", "انتهت صلاحية الجلسة. أعد تسجيل الدخول.");
  if (!["admin", "reception", "doctor"].includes(current.role)) throw denied();
  if (current.role === "doctor") {
    const user = await findUserByUsername(current.username, client);
    if (!user?.isActive || !user.partyId) throw denied();
    const party = await client.query("SELECT id FROM parties WHERE id=$1 AND kind='doctor' AND is_active=TRUE FOR SHARE NOWAIT", [user.partyId]);
    if (!party.rows.length) throw denied();
    if (write === false && user.permissions?.canViewPlans === false || write === true && user.permissions?.canEditPlans === false) throw denied();
    // Preserve the existing distinct boundaries: options are own-patient; writes
    // retain an explicitly granted all-patient scope without granting plan reads.
    if (patientId !== null && (write === true
      ? !await canAccessPatient(current, patientId, undefined, client, "nowait")
      : !await doctorOwnsPatient(user.partyId, patientId, client, "nowait"))) throw denied();
  }
  if (current.expiresAt < Date.now()) throw denied();
  return current;
}
async function transaction<T>(admitted: SessionPayload, action: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // The existing session verifier owns the user SHARE lock. No client identity fields.
    await authority(client, admitted, null, null);
    const value = await action(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (["55P03", "40P01", "40001"].includes(String((error as { code?: unknown })?.code))) throw conflict();
    throw error;
  } finally { client.release(); }
}
/** Opaque observation only; this read performs no domain mutation or schema initializer. */
export async function readOrthoPlanLink(admitted: SessionPayload, id: number) {
  parseOrthoPlanLinkId(String(id));
  return transaction(admitted, async client => {
    const row = (await client.query<Observation>(`SELECT ${COLUMNS} FROM ortho_cases WHERE id=$1`, [id])).rows[0];
    if (!row) throw new OrthoPlanLinkRefusal(404, "case_missing", "الحالة غير متاحة.");
    await authority(client, admitted, row.patient_id, false);
    return { caseId: row.id, patientId: row.patient_id, planId: row.plan_id, status: row.status, observedVersion: version(row) };
  });
}
/** Not a durable receipt: an unknown HTTP result requires a fresh read and explicit reconciliation. */
export async function commandOrthoPlanLink(admitted: SessionPayload, id: number, raw: unknown) {
  parseOrthoPlanLinkId(String(id));
  const input = parseOrthoPlanLink(raw);
  return transaction(admitted, async client => {
    await authority(client, admitted, null, true);
    const initial = (await client.query<{ patient_id: number }>("SELECT patient_id FROM ortho_cases WHERE id=$1", [id])).rows[0];
    if (!initial) throw new OrthoPlanLinkRefusal(404, "case_missing", "الحالة غير متاحة.");
    await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE NOWAIT", [initial.patient_id]);
    const row = (await client.query<Observation>(`SELECT ${COLUMNS} FROM ortho_cases WHERE id=$1 FOR UPDATE NOWAIT`, [id])).rows[0];
    if (!row || row.patient_id !== initial.patient_id || !["assessment", "active", "retention"].includes(row.status) || version(row) !== input.expectedVersion) throw conflict();
    await authority(client, admitted, row.patient_id, true);
    const plans = [...new Set([row.plan_id, input.planId].filter((v): v is number => v !== null))].sort((a, b) => a - b);
    if (plans.length) {
      const owned = await client.query("SELECT id FROM treatment_plans WHERE id=ANY($1::int[]) AND patient_id=$2", [plans, row.patient_id]);
      if (owned.rows.length !== plans.length) throw conflict();
      const locked = await client.query<{ id: number; patient_id: number; status: string }>("SELECT id,patient_id,status FROM treatment_plans WHERE id=ANY($1::int[]) ORDER BY id FOR SHARE NOWAIT", [plans]);
      if (locked.rows.length !== plans.length || locked.rows.some(plan => plan.patient_id !== row.patient_id || plan.id === input.planId && plan.status === "cancelled")) throw conflict();
    }
    const actor = await authority(client, admitted, row.patient_id, true);
    const result = await linkOrthoCasePlanWith(client, { caseId: id, planId: input.planId, actor: actor.username, actorRole: actor.role });
    if (!result.ok) throw conflict();
    await authority(client, admitted, row.patient_id, true);
    return { ok: true, caseId: id, planId: input.planId, changed: result.changed };
  });
}
