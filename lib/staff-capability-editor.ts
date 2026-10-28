import "server-only";
import type { DbClient, DbPool } from "./db";
import { getPool, insertAuditRow, usesSharedLocalDatabaseConnection } from "./db";
import { withIsolation } from "./transactions";
import { staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";
import { staffLifecycleLockKey } from "./legacy-staff-schema.mjs";
import { revalidateVerifiedDurableSession, type VerifiedDurableSession } from "./staff-durable-session";
import { loadExclusiveWriterAuthority, loadLockedIssuanceAuthority, type ProvedAccountAuthority } from "./staff-authority-proof-internal";
import { hasStaffCapability, validateStaffCapabilityChange } from "./staff-capabilities";
import { STAFF_CAPABILITIES, STAFF_CAPABILITY_SCHEMA_VERSION, type StaffCapability, type StaffCapabilityDocument, type StaffRecordScope } from "./staff-capability-catalogue";
import { withStaffOperation } from "./staff-operation-runtime";

/**
 * محرّر صلاحيات الطاقم الموحّد — كاتب سلطة يملك معاملته.
 *
 * AUTHORITY_WRITER_CLOSURE.md و§4 من OWNER_READINESS: السياج الحصري أولًا (قبل أي قفل
 * صف)، ثم إثبات الفاعل بقدرته الدقيقة `staff.permissions.edit`، ثم الهدف بقفل
 * FOR UPDATE، ثم قرار السياسة النقي (`validateStaffCapabilityChange`: لا تعديل للنفس،
 * لا للمالك المحمي، لا منح خارج ما يملكه الفاعل، مراجعة متزايدة بمقارنة CAS)، ثم
 * الكتابة والتدقيق ذرّيًا، ثم إثبات نهائي وانتهاء بساعة الحائط قبل الالتزام.
 * لا ترقية من مشترك إلى حصري: هذا الكاتب لا يمر عبر withStaffOperation.
 * تغيير الوثيقة يرفع حقبة حساب الهدف (مشغّل القاعدة)، فتسقط جلساته القائمة فور الالتزام.
 */
export class StaffCapabilityEditError extends Error {
 constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const REASONS: Record<string, [number, string]> = {
 "self-permission-change": [403, "لا يمكنك تعديل صلاحياتك بنفسك."],
 "protected-owner": [403, "صلاحيات المالك المحمي لا تُعدَّل من هنا."],
 "permission-management-denied": [403, "لا تملك صلاحية إدارة صلاحيات الطاقم."],
 "outside-delegable-authority": [403, "لا يمكنك منح صلاحية أو نطاق لا تملكه أنت، ولا منح إدارة الصلاحيات لغيرك."],
 "stale-revision": [409, "تغيّرت صلاحيات هذا الموظف منذ فتحها. حدّث البيانات وراجع التعديل."],
 "revision-must-increment": [409, "تغيّرت صلاحيات هذا الموظف منذ فتحها. حدّث البيانات وراجع التعديل."],
 "missing-prerequisite": [422, "بعض الصلاحيات تحتاج صلاحية أساسية معها (مثل العرض قبل التعديل)."],
 "unknown-or-invalid-grant": [422, "قائمة الصلاحيات تحتوي عنصرًا غير معروف."],
 "invalid-scope": [422, "نطاق المرضى أو المواعيد غير صالح."],
 "owner-context-missing": [409, "تعذّر التحقق من المالك المحمي. حدّث البيانات."],
 "owner-context-mismatch": [409, "تعذّر التحقق من المالك المحمي. حدّث البيانات."],
 "invalid-access": [409, "تعذّر التحقق من الحسابين. حدّث البيانات."],
};
function policyRefusal(reason: string): never {
 const [status, message] = REASONS[reason] ?? [422, "تعديل الصلاحيات غير صالح."];
 throw new StaffCapabilityEditError(status, reason, message);
}
/** Runtime/admission refusals are mapped once, here, to Arabic HTTP answers. */
export function staffAdmissionRefusal(error: unknown): StaffCapabilityEditError | null {
 if (error instanceof StaffCapabilityEditError) return error;
 if (!(error instanceof Error) || !/^STAFF_(OPERATION|RUNTIME|DIRECTORY)_[A-Z_]+$/.test(error.message)) return null;
 const code = error.message;
 if (/CAPABILITY_DENIED$/.test(code)) return new StaffCapabilityEditError(403, code, "لا تملك الصلاحية اللازمة لهذه العملية.");
 if (/(SESSION|STALE|EXPIRED|SUBJECT|USERNAME|CREDENTIAL|PERMISSIONS|PROVIDER|ACCOUNT_INVALID)/.test(code)) return new StaffCapabilityEditError(401, code, "انتهت الجلسة أو تغيّرت صلاحياتك. سجّل الدخول من جديد.");
 if (/TARGET_/.test(code)) return new StaffCapabilityEditError(404, code, "الموظف غير موجود أو غير نشط في الهوية الموحّدة.");
 return new StaffCapabilityEditError(503, code, "الهوية الموحّدة غير جاهزة الآن. أعد المحاولة لاحقًا.");
}
function refuse(reason: string): never { throw new Error(`STAFF_OPERATION_${reason}`); }

export interface StaffCapabilityEditInput {
 readonly targetUserId: number;
 readonly expectedRevision: number;
 readonly patientScope: StaffRecordScope;
 readonly appointmentScope: StaffRecordScope;
 readonly grants: Readonly<Record<string, boolean>>;
}
export interface StaffCapabilityTargetView {
 readonly userId: number;
 readonly username: string;
 readonly displayName: string;
 readonly roleLabel: string;
 readonly isOwner: boolean;
 readonly isSelf: boolean;
 readonly revision: number;
 readonly patientScope: StaffRecordScope;
 readonly appointmentScope: StaffRecordScope;
 readonly grants: readonly StaffCapability[];
 /** Capabilities the actor could grant to this target right now (presentation aid). */
 readonly delegable: readonly StaffCapability[];
 readonly editable: boolean;
 readonly scopeOptions: Readonly<{ patient: readonly StaffRecordScope[]; appointment: readonly StaffRecordScope[] }>;
}
async function transactionId(client: DbClient): Promise<string> {
 await client.query("SAVEPOINT staff_editor_transaction_check");
 await client.query("RELEASE SAVEPOINT staff_editor_transaction_check");
 const { rows } = await client.query<{ xid: string; isolation: string }>("SELECT pg_current_xact_id()::text AS xid, current_setting('transaction_isolation') AS isolation");
 if (rows.length !== 1 || rows[0].isolation !== "read committed") refuse("TRANSACTION_REQUIRED");
 return rows[0].xid;
}
function grantsOf(document: StaffCapabilityDocument): StaffCapability[] {
 return STAFF_CAPABILITIES.filter(capability => document.grants[capability] === true);
}
function targetView(actor: ProvedAccountAuthority, target: ProvedAccountAuthority): StaffCapabilityTargetView {
 const isSelf = actor.user.id === target.user.id;
 // Editability is the real policy applied to a no-op revision, not a UI guess.
 const editable = validateStaffCapabilityChange({ actor: actor.access, target: target.access, expectedRevision: target.document.revision,
  nextDocument: { ...target.document, grants: { ...target.document.grants }, revision: target.document.revision + 1 } }).ok;
 const scopes = (actorScope: StaffRecordScope): readonly StaffRecordScope[] => !editable ? [] : actor.access.isOwner || actorScope === "all" ? ["none", "own", "all"] : ["none"];
 const delegable = !editable ? [] : STAFF_CAPABILITIES.filter(capability => capability !== "staff.permissions.edit"
  && (actor.access.isOwner || (capability === "finance.commissions.view-own" ? hasStaffCapability(actor.access, "finance.commissions.view-all") : hasStaffCapability(actor.access, capability))));
 return Object.freeze({
  userId: target.user.id, username: target.user.username, displayName: target.user.displayName || target.user.username,
  roleLabel: target.user.role, isOwner: target.access.isOwner, isSelf, revision: target.document.revision,
  patientScope: target.document.patientScope, appointmentScope: target.document.appointmentScope,
  grants: Object.freeze(grantsOf(target.document)), delegable: Object.freeze(actor.access.isOwner && editable ? [...delegable, "staff.permissions.edit" as const] : delegable), editable,
  scopeOptions: Object.freeze({ patient: Object.freeze(scopes(actor.document.patientScope)), appointment: Object.freeze(scopes(actor.document.appointmentScope)) }),
 });
}
async function targetProof(client: DbClient, targetUserId: number, s: string): Promise<ProvedAccountAuthority> {
 if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) refuse("TARGET_INVALID");
 try { return await loadLockedIssuanceAuthority(client, targetUserId, s); }
 catch (error) {
  if (error instanceof Error && /^STAFF_OPERATION_(ACCOUNT_INVALID|SUBJECT_STALE|PROVIDER_STALE|PERMISSIONS_STALE)$/.test(error.message)) refuse("TARGET_INVALID");
  throw error;
 }
}

/** Read one target's current document for the editor (exact staff.permissions.edit admission). */
export async function readStaffCapabilityTargetIn(pool: DbPool, schema: string, session: VerifiedDurableSession, targetUserId: number): Promise<StaffCapabilityTargetView> {
 const s = staffIdentitySchemaName(schema);
 return withStaffOperation(pool, session, "staff.permissions.edit", async client => {
  const claims = revalidateVerifiedDurableSession(session);
  if (!claims) refuse("SESSION_EXPIRED");
  const actor = await loadLockedIssuanceAuthority(client, claims.userId, s);
  const target = await targetProof(client, targetUserId, s);
  return targetView(actor, target);
 }, s);
}

/** Exclusive-first authority writer (no shared→exclusive upgrade). */
export async function updateStaffCapabilitiesIn(pool: DbPool, schema: string, session: VerifiedDurableSession, input: StaffCapabilityEditInput): Promise<StaffCapabilityTargetView> {
 const s = staffIdentitySchemaName(schema);
 if (!input || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0) policyRefusal("stale-revision");
 return withIsolation(pool, "READ COMMITTED", async client => {
  const xid = await transactionId(client);
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [staffLifecycleLockKey(s)]);
  const actor = await loadExclusiveWriterAuthority(client, session, "staff.permissions.edit", s);
  const target = await targetProof(client, input.targetUserId, s);
  await client.query(`SELECT id FROM ${s}.users WHERE id=$1 FOR UPDATE`, [target.user.id]);
  const nextDocument = {
   schemaVersion: STAFF_CAPABILITY_SCHEMA_VERSION, revision: input.expectedRevision + 1,
   patientScope: input.patientScope, appointmentScope: input.appointmentScope, grants: { ...input.grants },
  };
  const decision = validateStaffCapabilityChange({ actor: actor.access, target: target.access, expectedRevision: input.expectedRevision, nextDocument });
  if (!decision.ok) policyRefusal(decision.reason);
  const { rows: updated } = await client.query<{ id: number }>(
   // The parameter takes the column's own type (TEXT in the clinic schema); the CAS reads it as JSON either way.
   `UPDATE ${s}.users SET permissions=$2 WHERE id=$1 AND (permissions::jsonb->>'revision')::bigint=$3 AND authorization_mode='canonical' AND is_active RETURNING id`,
   [target.user.id, JSON.stringify(nextDocument), input.expectedRevision]);
  if (updated.length !== 1) policyRefusal("stale-revision");
  const before = new Set(grantsOf(target.document));
  const after = STAFF_CAPABILITIES.filter(capability => nextDocument.grants[capability] === true);
  await insertAuditRow(client, {
   action: "staff.capabilities.update", entity: "user", entityId: target.user.id,
   actor: actor.user.username, actorRole: actor.user.role, entityLabel: target.user.username,
   details: { previousRevision: input.expectedRevision, revision: nextDocument.revision,
    added: after.filter(capability => !before.has(capability)), removed: [...before].filter(capability => !after.includes(capability)),
    patientScope: [target.document.patientScope, nextDocument.patientScope], appointmentScope: [target.document.appointmentScope, nextDocument.appointmentScope],
    actorUserId: actor.user.id },
  }, s);
  // Fresh precommit proof: actor still holds the exact grant; target proves at the new revision.
  const finalActor = await loadExclusiveWriterAuthority(client, session, "staff.permissions.edit", s);
  const finalTarget = await targetProof(client, target.user.id, s);
  if (finalTarget.document.revision !== nextDocument.revision) policyRefusal("stale-revision");
  if (await transactionId(client) !== xid || !revalidateVerifiedDurableSession(session)) refuse("SESSION_EXPIRED");
  return targetView(finalActor, finalTarget);
 });
}

function assertSharedDatabase(): void {
 if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) refuse("EXCLUSIVE_CONNECTION_REQUIRED");
}
export async function readStaffCapabilityTarget(session: VerifiedDurableSession, targetUserId: number) {
 assertSharedDatabase();
 return readStaffCapabilityTargetIn(getPool(), "public", session, targetUserId);
}
export async function updateStaffCapabilities(session: VerifiedDurableSession, input: StaffCapabilityEditInput) {
 assertSharedDatabase();
 return updateStaffCapabilitiesIn(getPool(), "public", session, input);
}
