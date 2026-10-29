import "server-only";
import { getPool, getSettingsWith, insertAuditRow, invalidateSettingsCache, readStoredSettingsWith, writeSettingsInTransaction, type DbClient } from "./db";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { ALL_SETTING_KEYS, SETTING_DEFAULTS, withDefaults, type SettingKey } from "./settings";
import { SETTINGS_AUDIT_ENTITY, SETTINGS_AUDIT_RESET, SETTINGS_AUDIT_UPDATE } from "./settings-audit";
import { SETTING_KEY_CLASSES, SETTING_WRITE_REQUIREMENT, settingBatchRequirement, type OwnerOnlySettingOperation } from "./settings-capabilities";
import { settingDefinition } from "./settings-definitions";
import { validateSettingSet, validateTypedSetting } from "./settings-validate";
import type { StaffCapability } from "./staff-capability-catalogue";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationCapabilities, staffOperationIdentity, staffOperationOwnerOperations, withStaffOperation, type StaffOperationHandle, type StaffRuntimeAction } from "./staff-operation-runtime";

/**
 * Canonical clinic settings (owner decision 5, Dot 6484846432; per-key policy from
 * Dot review 6480538845 item 1, lib/settings-capabilities.ts).
 *
 * Read: one owning RR snapshot admitted by `settings.view`. The same values, stamps and
 * secret states as the legacy payload (a secret's value is never returned), plus
 * `__canWrite`: the keys this account may change right now, from the same snapshot.
 *
 * Write (update or reset): ONE admitted transaction for the whole batch.
 *  - every key must be known and valid; one bad key refuses the batch (no partial write);
 *  - the transaction is admitted by `settings.view` (the catalogue prerequisite of
 *    every settings write), then EVERY key's requirement is freshly proved through the
 *    same handle, under the same shared identity fence, before anything is written:
 *    delegable capabilities and owner-only operations alike. The refusal names the
 *    first key the actor may not write. A batch that mixes an operational key with an
 *    owner-only key is refused whole for a delegate;
 *  - the expected-stamp CAS, the in-transaction prefix rule, the writes and one audit
 *    row per changed key commit together: no write without its audit.
 * The response payload is read in the same transaction, after the writes.
 */
export const SETTINGS_READ_MAX_BYTES = 1_048_576;
const DELEGABLE_SETTING_CAPABILITIES = ["settings.operational.edit", "settings.finance.edit"] as const satisfies readonly StaffCapability[];
const OWNER_SETTING_OPERATIONS = ["settings.security.change", "settings.integrations.change", "clinic.backup.manage"] as const satisfies readonly OwnerOnlySettingOperation[];

export type CanonicalSettingsRefusalCode = "invalid_settings_request" | "unknown_setting_key" | "invalid_setting_value" | "setting_locked"
  | "setting_reason_required" | "setting_version_missing" | "setting_not_granted" | "setting_conflict" | "setting_rule";
export class CanonicalSettingsRefusal extends Error {
  constructor(readonly code: CanonicalSettingsRefusalCode, readonly status: 400 | 403 | 409, message: string, readonly key?: string, readonly currentUpdatedAt?: string | null) {
    super(message);
  }
}

export interface CanonicalSettingsWrite {
  readonly mode: "update" | "reset";
  readonly values: Readonly<Record<string, string>>;
  readonly expected: Readonly<Record<string, string | null>>;
  readonly reason: string | null;
}

function own(source: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(source, key); }
function versionsOf(raw: unknown, keys: readonly string[], message: string): Record<string, string | null> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || keys.some(key => !own(raw, key))) {
    throw new CanonicalSettingsRefusal("setting_version_missing", 409, message);
  }
  const versions = raw as Record<string, unknown>;
  return Object.fromEntries(keys.map(key => [key, typeof versions[key] === "string" ? String(versions[key]) : null]));
}
function requireReason(keys: readonly string[], reason: string | null, message: string) {
  if (keys.some(key => settingDefinition(key)?.requiresReason) && !(reason ?? "").trim()) {
    throw new CanonicalSettingsRefusal("setting_reason_required", 400, message);
  }
}

/** The PATCH body (same contract as the legacy route): setting keys with string values,
 * `__versions` naming the stamp seen for every sent key, `__reason` when required. */
export function parseCanonicalSettingsUpdate(body: unknown): CanonicalSettingsWrite {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CanonicalSettingsRefusal("invalid_settings_request", 400, "طلب غير صالح.");
  const source = body as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const key of Object.keys(source)) {
    if (key.startsWith("__")) continue;
    if (!settingDefinition(key)) throw new CanonicalSettingsRefusal("unknown_setting_key", 400, "مفتاح إعداد غير معروف.", key);
    const raw = source[key];
    if (typeof raw !== "string") throw new CanonicalSettingsRefusal("invalid_setting_value", 400, "قيمة غير صالحة.", key);
    const problem = validateTypedSetting(key, raw);
    if (problem) throw new CanonicalSettingsRefusal(settingDefinition(key)?.systemLocked ? "setting_locked" : "invalid_setting_value", settingDefinition(key)?.systemLocked ? 403 : 400, problem, key);
    values[key] = raw.trim();
  }
  const keys = Object.keys(values);
  if (keys.length === 0) throw new CanonicalSettingsRefusal("invalid_settings_request", 400, "لا يوجد ما يُحفظ.");
  const expected = versionsOf(source.__versions, keys, "حدّث الصفحة قبل الحفظ؛ نسخة الإعداد مفقودة.");
  const reason = typeof source.__reason === "string" ? source.__reason : null;
  requireReason(keys, reason, "سبب التغيير مطلوب لهذا الإعداد.");
  return Object.freeze({ mode: "update", values: Object.freeze(values), expected: Object.freeze(expected), reason });
}

/** The POST body: `{action: "reset", keys, __versions, reason}`. A reset is a new audited
 * write of each key's default, never an erasure of history. */
export function parseCanonicalSettingsReset(body: unknown): CanonicalSettingsWrite {
  const source = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  if (source.action !== "reset") throw new CanonicalSettingsRefusal("invalid_settings_request", 400, "إجراء غير معروف.");
  const keys = Array.isArray(source.keys) ? [...new Set(source.keys.filter((key): key is string => typeof key === "string"))] : [];
  if (keys.length === 0) throw new CanonicalSettingsRefusal("invalid_settings_request", 400, "حدّد المفاتيح.");
  const values: Record<string, string> = {};
  for (const key of keys) {
    const definition = settingDefinition(key);
    if (!definition) throw new CanonicalSettingsRefusal("unknown_setting_key", 400, "مفتاح غير معروف.", key);
    if (definition.systemLocked) throw new CanonicalSettingsRefusal("setting_locked", 403, `${definition.label}: ثابتُ نظام.`, key);
    values[key] = SETTING_DEFAULTS[key as SettingKey];
  }
  const expected = versionsOf(source.__versions, keys, "حدّث الصفحة قبل الإعادة؛ نسخة الإعداد مفقودة.");
  const reason = typeof source.reason === "string" ? source.reason : null;
  requireReason(keys, reason, "سبب الإعادة مطلوب لهذا الإعداد.");
  return Object.freeze({ mode: "reset", values: Object.freeze(values), expected: Object.freeze(expected), reason });
}

/** Keys this account may write, from what it holds. Locked keys are never writable. */
function writableKeys(holds: (capability: StaffCapability) => boolean, ownerMay: (operation: OwnerOnlySettingOperation) => boolean): string[] {
  return ALL_SETTING_KEYS.filter(key => {
    const entry = own(SETTING_KEY_CLASSES, key) ? SETTING_KEY_CLASSES[key] : undefined;
    if (!entry || settingDefinition(key)?.systemLocked) return false;
    const requirement = SETTING_WRITE_REQUIREMENT[entry.class];
    return "capability" in requirement ? holds(requirement.capability) : ownerMay(requirement.ownerOnly);
  });
}

/** Values (non-secret keys) plus the read metadata, the same shape as the legacy payload. */
export type CanonicalSettingsPayload = {
  readonly __versions: Record<string, string | null>;
  readonly __secrets: Record<string, boolean>;
  readonly __canWrite: string[];
  readonly [key: string]: unknown;
};
async function payload(q: Pick<DbClient, "query">, canWrite: string[]): Promise<CanonicalSettingsPayload> {
  const stored = await readStoredSettingsWith(q);
  const values = withDefaults(Object.fromEntries([...stored].map(([key, row]) => [key, row.value])));
  const safe: Record<string, string> = {};
  const versions: Record<string, string | null> = {};
  const secrets: Record<string, boolean> = {};
  for (const key of ALL_SETTING_KEYS) {
    versions[key] = stored.get(key)?.updatedAt ?? null;
    if (settingDefinition(key)?.sensitivity === "secret") {
      secrets[key] = (stored.get(key)?.value ?? "").trim() !== "";
      continue;
    }
    safe[key] = values[key];
  }
  return { ...safe, __versions: versions, __secrets: secrets, __canWrite: canWrite };
}

export async function readCanonicalSettings(session: VerifiedDurableSession): Promise<CanonicalSettingsPayload> {
  return runCanonicalReadSnapshot(session, "settings.view",
    (q, scope) => payload(q, writableKeys(capability => scope.granted(capability), operation => scope.ownerMay(operation))),
    { errorPrefix: "STAFF_READ", maxBytes: SETTINGS_READ_MAX_BYTES });
}

async function heldThroughHandle(client: DbClient, handle: StaffOperationHandle, action: StaffRuntimeAction) {
  const capabilities = await staffOperationCapabilities(client, handle, action, DELEGABLE_SETTING_CAPABILITIES);
  const owner = await staffOperationOwnerOperations(client, handle, action, OWNER_SETTING_OPERATIONS);
  return { holds: (capability: StaffCapability) => (capabilities as ReadonlySet<StaffCapability>).has(capability), ownerMay: (operation: OwnerOnlySettingOperation) => owner.has(operation) };
}

export async function commandCanonicalSettingsWrite(session: VerifiedDurableSession, write: CanonicalSettingsWrite, pool = getPool()): Promise<CanonicalSettingsPayload & { __changed: string[] }> {
  const keys = Object.keys(write.values);
  const requirement = settingBatchRequirement(keys);
  if (!requirement.ok) throw new CanonicalSettingsRefusal("unknown_setting_key", 400, "مفتاح إعداد غير معروف.", requirement.key);
  const action: StaffRuntimeAction = "settings.view";
  const result = await withStaffOperation(pool, session, action, async (client, handle) => {
    const held = await heldThroughHandle(client, handle, action);
    for (const key of keys) {
      const need = SETTING_WRITE_REQUIREMENT[SETTING_KEY_CLASSES[key].class];
      if ("capability" in need ? !held.holds(need.capability) : !held.ownerMay(need.ownerOnly)) {
        throw new CanonicalSettingsRefusal("setting_not_granted", 403, "لا تملك صلاحية تغيير هذا الإعداد؛ لم يُحفظ شيء.", key);
      }
    }
    const crossProblem = validateSettingSet(write.values, await getSettingsWith(client));
    if (crossProblem) throw new CanonicalSettingsRefusal("setting_rule", 400, crossProblem);
    const core = await writeSettingsInTransaction(client, { values: write.values, expected: write.expected, reason: write.reason });
    if (!core.ok) {
      if ("problem" in core) throw new CanonicalSettingsRefusal("setting_rule", 400, core.problem);
      throw new CanonicalSettingsRefusal("setting_conflict", 409, "غُيّر هذا الإعداد من جهازٍ آخر. حدّث الصفحة ثم أعد المحاولة.", core.conflict.key, core.conflict.currentUpdatedAt);
    }
    const actor = await staffOperationIdentity(client, handle, action);
    for (const entry of core.audits) {
      await insertAuditRow(client, {
        action: write.mode === "reset" ? SETTINGS_AUDIT_RESET : SETTINGS_AUDIT_UPDATE,
        entity: SETTINGS_AUDIT_ENTITY, entityId: entry.key, details: entry.details,
        actor: actor.username, actorRole: actor.role,
      });
    }
    return { ...(await payload(client, writableKeys(held.holds, held.ownerMay))), __changed: core.changed };
  });
  invalidateSettingsCache();
  return result;
}
