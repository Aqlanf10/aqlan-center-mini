import "server-only";
import type { DbClient, DbPool } from "./db";
import { doctorCommissionAuditInput, doctorCommissionChangeOn, getPool, insertAuditRow, usesSharedLocalDatabaseConnection } from "./db";
import { hashPassword } from "./auth";
import { isRole, ROLES, type Role } from "./roles";
import { withIsolation } from "./transactions";
import { staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";
import { staffLifecycleLockKey } from "./legacy-staff-schema.mjs";
import { revalidateVerifiedDurableSession, type VerifiedDurableSession } from "./staff-durable-session";
import { loadAdministrativeTargetState, loadExclusiveWriterAuthority, loadLockedIssuanceAuthority, type AdministrativeTargetState, type ProvedAccountAuthority } from "./staff-authority-proof-internal";
import { validateStaffAccountChange, type StaffAccountOperation } from "./staff-capabilities";
import { StaffCapabilityEditError } from "./staff-capability-editor";
import { withStaffOperation } from "./staff-operation-runtime";

/**
 * محرّر حسابات الطاقم الموحّد (المقترح A في CANONICAL_ACCOUNT_WRITES.md، المراجعة 6507696166 البند 2).
 *
 * كاتب سلطة يملك معاملته، بالترتيب: السياج الحصري أولًا ← إثبات الفاعل بجلسته الحيّة
 * (`staff.view` بلا تخفيف) ← قفل الهدف FOR UPDATE بتحقق إداري منفصل يقبل الحساب غير النشط
 * (لتفعيله) والربط المتقادم بطبيب (لإصلاحه) ← قاعدة الدفعة: أي حقل غير مسموح يرفض الحفظ كله
 * ← CAS على حقول الحساب نفسها ← الكتابة والتدقيق في المعاملة ذاتها ← إثبات نهائي للفاعل.
 * الإبطال: مشغّل 0076 يرفع حقبة حساب الهدف وحده عند تغيّر التفعيل أو الدور أو الربط أو كلمة
 * المرور، فتسقط جلساته هو فقط؛ جلسات غيره لا تُمس. الاسم الظاهر عرضٌ فقط ولا يرفع الحقبة.
 * لا كلمة مرور ولا تجزئة في التدقيق أو الاستجابة؛ ولا «تغيير إلزامي عند الدخول» (سياسة منفصلة).
 */
const REASONS: Record<string, [number, string]> = {
 "self-staff-maintenance": [403, "لا يمكنك تعديل حسابك أنت من هنا (لا إيقاف ذاتي ولا تغيير دورك أو ربطك أو كلمة مرورك)."],
 "protected-owner": [403, "حساب المالك المحمي لا يُعدَّل من هنا."],
 "maintenance-denied": [403, "لا تملك صلاحية هذا التعديل على حسابات الطاقم."],
 "owner-operation-required": [403, "تغيير الدور أو ربط الطبيب أو تعيين كلمة مرور مؤقتة من صلاحيات المالك وحده."],
 "outside-delegable-authority": [403, "لا يمكنك إدارة حساب يملك صلاحيات أو نطاقًا لا تملكه أنت."],
 "stale-version": [409, "تغيّر هذا الحساب منذ فتحه. حدّث البيانات وراجع التعديل."],
 "stale-clinician-link": [409, "الحساب مربوط بطبيب غير نشط. أصلح الربط (أو أزله) مع التفعيل في الحفظ نفسه."],
 "owner-context-missing": [409, "تعذّر التحقق من المالك المحمي. حدّث البيانات."],
 "owner-context-mismatch": [409, "تعذّر التحقق من المالك المحمي. حدّث البيانات."],
 "invalid-access": [409, "تعذّر التحقق من الحسابين. حدّث البيانات."],
 "no-account-change": [422, "لا يوجد تغيير للحفظ."],
 "unknown-account-field": [422, "الطلب يحتوي حقلًا غير معروف؛ لم يُحفظ شيء."],
 "invalid-display-name": [422, "اكتب الاسم الظاهر (حتى 80 حرفًا)."],
 "invalid-active": [422, "حالة التفعيل غير صالحة."],
 "invalid-role": [422, "دور غير معروف."],
 "invalid-clinician": [422, "الطبيب المختار غير موجود أو غير نشط."],
 "invalid-temporary-password": [422, "كلمة المرور المؤقتة يجب ألا تقل عن 8 أحرف (ولا تزيد على 1024)."],
};
function accountRefusal(reason: string): never {
 const [status, message] = REASONS[reason] ?? [422, "تعديل الحساب غير صالح."];
 throw new StaffCapabilityEditError(status, reason, message);
}
function refuse(reason: string): never { throw new Error(`STAFF_OPERATION_${reason}`); }

const FIELDS = ["displayName", "active", "roleLabel", "clinicianPartyId", "temporaryPassword"] as const;
type AccountField = typeof FIELDS[number];
const OPERATION: Record<AccountField, StaffAccountOperation> = {
 displayName: "profile.edit", active: "accounts.disable", roleLabel: "staff.role.change",
 clinicianPartyId: "staff.clinician-link.change", temporaryPassword: "staff.credentials.reset",
};
export interface StaffAccountChanges {
 readonly displayName?: string;
 readonly active?: boolean;
 readonly roleLabel?: string;
 readonly clinicianPartyId?: number | null;
 readonly temporaryPassword?: string;
}
export interface StaffAccountEditInput {
 readonly targetUserId: number;
 readonly expectedVersion: string;
 readonly changes: Readonly<Record<string, unknown>>;
}
export interface StaffAccountView {
 readonly userId: number;
 readonly username: string;
 readonly displayName: string;
 readonly roleLabel: string;
 readonly active: boolean;
 readonly clinicianPartyId: number | null;
 /** `stale`: linked to a doctor party that is no longer active; the account cannot sign in until repaired. */
 readonly clinicianLink: AdministrativeTargetState["provider"];
 readonly version: string;
 readonly isOwner: boolean;
 readonly isSelf: boolean;
 /** What this actor may change on this target right now (the real policy, per field). */
 readonly allowed: Readonly<Record<AccountField, boolean>>;
 readonly roleOptions: readonly Role[];
 readonly doctorOptions: readonly Readonly<{ id: number; name: string }>[];
}

/** Strict batch parse: an unknown field or an invalid value refuses the whole save. */
export function parseStaffAccountChanges(raw: unknown): StaffAccountChanges {
 if (!raw || typeof raw !== "object" || Array.isArray(raw)) accountRefusal("no-account-change");
 const source = raw as Record<string, unknown>;
 if (Object.keys(source).some(key => !(FIELDS as readonly string[]).includes(key))) accountRefusal("unknown-account-field");
 const out: { -readonly [K in keyof StaffAccountChanges]: StaffAccountChanges[K] } = {};
 if (source.displayName !== undefined) {
  const value = typeof source.displayName === "string" ? source.displayName.trim() : "";
  if (!value || value.length > 80 || [...value].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) accountRefusal("invalid-display-name");
  out.displayName = value;
 }
 if (source.active !== undefined) {
  if (typeof source.active !== "boolean") accountRefusal("invalid-active");
  out.active = source.active;
 }
 if (source.roleLabel !== undefined) {
  if (!isRole(source.roleLabel)) accountRefusal("invalid-role");
  out.roleLabel = source.roleLabel;
 }
 if (source.clinicianPartyId !== undefined) {
  const value = source.clinicianPartyId;
  if (value !== null && !(Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 2147483647)) accountRefusal("invalid-clinician");
  out.clinicianPartyId = value as number | null;
 }
 if (source.temporaryPassword !== undefined) {
  const value = source.temporaryPassword;
  if (typeof value !== "string" || value.length < 8 || value.length > 1024) accountRefusal("invalid-temporary-password");
  out.temporaryPassword = value;
 }
 return Object.freeze(out);
}

/** Fields whose requested value differs from the locked current state (a password is never a no-op). */
function effectiveFields(changes: StaffAccountChanges, target: AdministrativeTargetState): AccountField[] {
 const u = target.user;
 return FIELDS.filter(field => {
  if (changes[field] === undefined) return false;
  switch (field) {
   case "displayName": return changes.displayName !== (u.displayName ?? u.username);
   case "active": return changes.active !== u.isActive;
   case "roleLabel": return changes.roleLabel !== u.role;
   case "clinicianPartyId": return changes.clinicianPartyId !== u.partyId;
   case "temporaryPassword": return true;
  }
 });
}

async function transactionId(client: DbClient): Promise<string> {
 await client.query("SAVEPOINT staff_account_transaction_check");
 await client.query("RELEASE SAVEPOINT staff_account_transaction_check");
 const { rows } = await client.query<{ xid: string; isolation: string }>("SELECT pg_current_xact_id()::text AS xid, current_setting('transaction_isolation') AS isolation");
 if (rows.length !== 1 || rows[0].isolation !== "read committed") refuse("TRANSACTION_REQUIRED");
 return rows[0].xid;
}

async function accountView(client: DbClient, s: string, actor: ProvedAccountAuthority, target: AdministrativeTargetState): Promise<StaffAccountView> {
 const policyTarget = { userId: target.user.id, ownerUserId: target.ownerUserId, isOwner: target.isOwner, document: target.document };
 const allowed = Object.fromEntries(FIELDS.map(field => [field, validateStaffAccountChange(actor.access, policyTarget, [OPERATION[field]]).ok])) as Record<AccountField, boolean>;
 const doctorOptions = allowed.clinicianPartyId
  ? (await client.query<{ id: number; name: string }>(`SELECT id,name FROM ${s}.parties WHERE kind='doctor' AND is_active ORDER BY name,id LIMIT 500`)).rows.map(row => Object.freeze({ id: row.id, name: row.name }))
  : [];
 return Object.freeze({
  userId: target.user.id, username: target.user.username, displayName: target.user.displayName || target.user.username,
  roleLabel: target.user.role, active: target.user.isActive, clinicianPartyId: target.user.partyId, clinicianLink: target.provider,
  version: target.version, isOwner: target.isOwner, isSelf: actor.user.id === target.user.id,
  allowed: Object.freeze(allowed), roleOptions: Object.freeze(allowed.roleLabel ? [...ROLES] : []), doctorOptions: Object.freeze(doctorOptions),
 });
}

/** Read one target's account for the editor: shared fence, exact `staff.view` admission. */
export async function readStaffAccountIn(pool: DbPool, schema: string, session: VerifiedDurableSession, targetUserId: number): Promise<StaffAccountView> {
 const s = staffIdentitySchemaName(schema);
 return withStaffOperation(pool, session, "staff.view", async client => {
  const claims = revalidateVerifiedDurableSession(session);
  if (!claims) refuse("SESSION_EXPIRED");
  const actor = await loadLockedIssuanceAuthority(client, claims.userId, s);
  const target = await loadAdministrativeTargetState(client, targetUserId, s, "share");
  return accountView(client, s, actor, target);
 }, s);
}

/** Exclusive-first account writer (no shared→exclusive upgrade). */
export async function updateStaffAccountIn(pool: DbPool, schema: string, session: VerifiedDurableSession, input: StaffAccountEditInput): Promise<StaffAccountView> {
 const s = staffIdentitySchemaName(schema);
 if (!input || typeof input.expectedVersion !== "string" || !/^[0-9a-f]{64}$/.test(input.expectedVersion)) accountRefusal("stale-version");
 if (!Number.isSafeInteger(input.targetUserId) || input.targetUserId <= 0) refuse("TARGET_INVALID");
 // Value validation needs no lock; the batch is refused whole before anything is touched.
 const changes = parseStaffAccountChanges(input.changes);
 const passwordHash = changes.temporaryPassword === undefined ? null : await hashPassword(changes.temporaryPassword);
 return withIsolation(pool, "READ COMMITTED", async client => {
  const xid = await transactionId(client);
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [staffLifecycleLockKey(s)]);
  const actor = await loadExclusiveWriterAuthority(client, session, "staff.view", s);
  const target = await loadAdministrativeTargetState(client, input.targetUserId, s, "update");
  const fields = effectiveFields(changes, target);
  const decision = validateStaffAccountChange(actor.access,
   { userId: target.user.id, ownerUserId: target.ownerUserId, isOwner: target.isOwner, document: target.document },
   fields.map(field => OPERATION[field]));
  if (!decision.ok) accountRefusal(decision.reason);
  if (input.expectedVersion !== target.version) accountRefusal("stale-version");
  const nextActive = fields.includes("active") ? changes.active! : target.user.isActive;
  const linkChanges = fields.includes("clinicianPartyId");
  // An active account must be able to prove: never leave (or make) it active on a stale link.
  if (nextActive && !linkChanges && target.provider === "stale") accountRefusal("stale-clinician-link");

  const write = async (c: DbClient) => {
   const { rows } = await c.query<{ id: number }>(
    `UPDATE ${s}.users SET
      display_name=CASE WHEN $2 THEN $3::text ELSE display_name END,
      is_active=CASE WHEN $4 THEN $5::boolean ELSE is_active END,
      role=CASE WHEN $6 THEN $7::text ELSE role END,
      party_id=CASE WHEN $8 THEN $9::integer ELSE party_id END,
      password_hash=CASE WHEN $10 THEN $11::text ELSE password_hash END
     WHERE id=$1 AND authorization_mode='canonical' AND authorization_epoch::text=$12 RETURNING id`,
    [target.user.id, fields.includes("displayName"), changes.displayName ?? null, fields.includes("active"), changes.active ?? null,
     fields.includes("roleLabel"), changes.roleLabel ?? null, linkChanges, changes.clinicianPartyId ?? null,
     passwordHash !== null, passwordHash, target.user.authorizationEpoch]);
   if (rows.length !== 1) accountRefusal("stale-version");
  };
  const commissionContext = { actor: actor.user.username, actorRole: actor.user.role, reason: "ربط/فك ربط حساب موظف بطبيب (محرّر الحسابات الموحّد)" };
  if (linkChanges) {
   // The legacy commission tables resolve through the search path: prove it names this schema.
   const { rows: [path] } = await client.query<{ schema: string }>("SELECT current_schema() AS schema");
   if (path?.schema !== s) refuse("SCHEMA_PATH_MISMATCH");
   const nextParty = changes.clinicianPartyId ?? null;
   const { changes: commissionChanges } = await doctorCommissionChangeOn(client, commissionContext, "advanced",
    async () => [target.user.partyId, nextParty],
    async c => {
     if (nextParty !== null) {
      const { rows: [party] } = await c.query<{ kind: string; is_active: boolean }>(`SELECT kind,is_active FROM ${s}.parties WHERE id=$1`, [nextParty]);
      if (!party || party.kind !== "doctor" || !party.is_active) accountRefusal("invalid-clinician");
     }
     await write(c);
    });
   for (const change of commissionChanges) await insertAuditRow(client, doctorCommissionAuditInput(change, commissionContext), s);
  } else {
   await write(client);
  }
  const { rows: [after] } = await client.query<{ authorization_epoch: string }>(`SELECT authorization_epoch::text FROM ${s}.users WHERE id=$1`, [target.user.id]);
  const changed: Record<string, [unknown, unknown]> = {};
  if (fields.includes("displayName")) changed.displayName = [target.user.displayName, changes.displayName];
  if (fields.includes("active")) changed.active = [target.user.isActive, changes.active];
  if (fields.includes("roleLabel")) changed.roleLabel = [target.user.role, changes.roleLabel];
  if (linkChanges) changed.clinicianPartyId = [target.user.partyId, changes.clinicianPartyId ?? null];
  await insertAuditRow(client, {
   action: "staff.account.update", entity: "user", entityId: target.user.id,
   actor: actor.user.username, actorRole: actor.user.role, entityLabel: target.user.username,
   details: { changes: changed, credentialReset: passwordHash !== null, fields,
    sessionsRevoked: after?.authorization_epoch !== target.user.authorizationEpoch, actorUserId: actor.user.id },
  }, s);
  // Fresh precommit proof of the actor (unchanged: it never targets itself), same transaction, live clock.
  const finalActor = await loadExclusiveWriterAuthority(client, session, "staff.view", s);
  const finalTarget = await loadAdministrativeTargetState(client, target.user.id, s, "update");
  if (await transactionId(client) !== xid || !revalidateVerifiedDurableSession(session)) refuse("SESSION_EXPIRED");
  return accountView(client, s, finalActor, finalTarget);
 });
}

function assertSharedDatabase(): void {
 if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) refuse("EXCLUSIVE_CONNECTION_REQUIRED");
}
export async function readStaffAccount(session: VerifiedDurableSession, targetUserId: number) {
 assertSharedDatabase();
 return readStaffAccountIn(getPool(), "public", session, targetUserId);
}
export async function updateStaffAccount(session: VerifiedDurableSession, input: StaffAccountEditInput) {
 assertSharedDatabase();
 return updateStaffAccountIn(getPool(), "public", session, input);
}
