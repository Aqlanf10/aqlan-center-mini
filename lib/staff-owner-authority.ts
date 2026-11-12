import { getPool, type DbClient } from "./db";
import {
  ownerContextFromTrustedBinding,
  parseStaffCapabilityDocument,
  resolveStaffCapabilities,
  type ResolvedStaffAccess,
} from "./staff-capabilities";

/**
 * مصدر هوية مالك العيادة المعتمد وصلاحيات الطاقم الموحدة (متوافق مع عقد الاستيجنج 779bf35b
 * ونواة السلطة القانونية الموحدة لكلاود):
 *
 * - لا يُستنتج المالك أبدًا من `role = 'admin'` أو `MIN(users.id)` أو علم محلي في جدول صلاحيات البوابة
 *   أو متغير بيئة أو `settings`.
 * - في الوضع القديم (`legacy` — صفر مؤشرات من مخطط السلطة القانونية): `isOwner` دائمًا `false`
 *   (فشل مغلق لعمليات المالك الحصرية مثل منح «عرض بوابة المريض»).
 * - عند وجود أي أثر لمخطط السلطة القانونية (`canonical`): يجب أن يكتمل إثبات `staff_authority_control`
 *   (`state = 'active'`) و`staff_identity_state` (`status = 'ready'`) وسلامة سلسلة الهويات وربط الحساب
 *   بوثيقة صلاحيات موحدة صالحة؛ وأي نقص أو تعليق أو انحراف يغلق الوصول كليًا بلا تراجع للوضع القديم.
 */
export interface CanonicalOwnerAuthority {
  readonly access: ResolvedStaffAccess;
  readonly bindingVersion: string;
}

export type StaffPortalAuthorityInspection =
  | {
      readonly mode: "legacy";
      readonly ownerAuthority: null;
    }
  | {
      readonly mode: "canonical";
      readonly ownerAuthority: CanonicalOwnerAuthority;
    }
  | {
      readonly mode: "canonical";
      readonly ownerAuthority: null;
      readonly deniedReason: string;
    };

const CANONICAL_RELATIONS = [
  "staff_authority_control",
  "staff_identity_generations",
  "staff_identity_subjects",
  "staff_identity_state",
  "staff_identity_binding_events",
  "staff_identity_current",
  "staff_authority_identity",
  "staff_execution_epochs",
  "users_staff_subject_identity",
  "staff_restore_hold",
] as const;

const CANONICAL_FUNCTIONS = [
  "staff_restore_hold_guard",
  "staff_authority_control_guard",
  "staff_account_authority_epoch_guard",
  "staff_clinical_authority_epoch_guard",
  "staff_identity_history_guard",
  "staff_identity_state_guard",
  "staff_identity_subject_guard",
  "staff_identity_event_guard",
  "staff_identity_current_guard",
  "staff_subject_identity_immutable",
  "staff_realm_identity_immutable",
  "staff_execution_epoch_immutable",
] as const;

const CANONICAL_TRIGGERS = [
  "staff_restore_hold_guard_row",
  "staff_restore_hold_no_truncate",
  "staff_authority_control_guard_row",
  "staff_authority_control_guard_truncate",
  "staff_account_authority_epoch",
  "staff_clinical_authority_epoch",
  "users_subject_identity_immutable",
  "staff_realm_identity_immutable",
  "staff_execution_epoch_immutable",
  "staff_identity_generations_immutable",
  "staff_identity_generations_no_truncate",
  "staff_identity_subjects_immutable",
  "staff_identity_subjects_no_truncate",
  "staff_identity_binding_events_immutable",
  "staff_identity_binding_events_no_truncate",
  "staff_identity_state_guard",
  "staff_identity_subjects_guard",
  "staff_identity_binding_events_guard",
  "staff_identity_current_guard",
  "staff_identity_state_no_truncate",
  "staff_identity_current_no_truncate",
] as const;

function safeSchemaIdentifier(schema: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error("INVALID_STAFF_AUTHORITY_SCHEMA");
  }
  return schema;
}

export async function readStaffAuthorityMode(
  source: Pick<DbClient, "query">,
  schema = "public",
): Promise<"legacy" | "canonical"> {
  const cleanSchema = safeSchemaIdentifier(schema);
  const { rows } = await source.query<{ markers: string }>(
    `SELECT (
       (SELECT count(*) FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = ANY($2::text[])) +
       (SELECT count(*) FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proname = ANY($3::text[])) +
       (SELECT count(*) FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND t.tgname = ANY($4::text[])) +
       (SELECT count(*) FROM pg_catalog.pg_attribute a
          JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1
           AND NOT a.attisdropped
           AND (
             (c.relname = 'users' AND a.attname = ANY(ARRAY['authorization_mode', 'authorization_epoch', 'staff_subject_id']))
             OR (c.relname = 'parties' AND a.attname = 'clinical_authority_epoch')
           ))
     )::text AS markers`,
    [cleanSchema, CANONICAL_RELATIONS, CANONICAL_FUNCTIONS, CANONICAL_TRIGGERS],
  );
  if (rows.length !== 1 || typeof rows[0].markers !== "string" || !/^[0-9]+$/.test(rows[0].markers)) {
    throw new Error("STAFF_AUTHORITY_SCHEMA_UNREADABLE");
  }
  return rows[0].markers === "0" ? "legacy" : "canonical";
}

export async function inspectStaffPortalAuthority(
  source: Pick<DbClient, "query">,
  userId: number,
  schema = "public",
): Promise<StaffPortalAuthorityInspection> {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return { mode: "canonical", ownerAuthority: null, deniedReason: "invalid-user-id" };
  }
  const cleanSchema = safeSchemaIdentifier(schema);
  const mode = await readStaffAuthorityMode(source, cleanSchema);
  if (mode === "legacy") {
    return { mode: "legacy", ownerAuthority: null };
  }

  try {
    const { rows: controls } = await source.query<{
      state: string;
      realm_id: string;
      owner_user_id: number;
      binding_epoch: string;
    }>(
      `SELECT state, realm_id::text AS realm_id, owner_user_id, binding_epoch::text AS binding_epoch
         FROM ${cleanSchema}.staff_authority_control
        WHERE singleton`,
    );
    const c = controls[0];
    if (controls.length !== 1 || c.state !== "active" || !Number.isSafeInteger(c.owner_user_id) || c.owner_user_id <= 0) {
      return { mode: "canonical", ownerAuthority: null, deniedReason: "control-not-active" };
    }

    const { rows: states } = await source.query<{
      status: string;
      realm_id: string;
      generation_id: string;
      registry_revision: string;
      ready_owner_subject_id: string;
      ready_control_epoch: string;
    }>(
      `SELECT status,
              realm_id::text AS realm_id,
              generation_id::text AS generation_id,
              registry_revision::text AS registry_revision,
              ready_owner_subject_id::text AS ready_owner_subject_id,
              ready_control_epoch::text AS ready_control_epoch
         FROM ${cleanSchema}.staff_identity_state
        WHERE singleton`,
    );
    const h = states[0];
    if (
      states.length !== 1 ||
      h.status !== "ready" ||
      h.realm_id !== c.realm_id ||
      h.ready_control_epoch !== c.binding_epoch
    ) {
      return { mode: "canonical", ownerAuthority: null, deniedReason: "identity-not-ready" };
    }

    const { rows: [integrity] } = await source.query<{ valid: boolean }>(
      `WITH RECURSIVE chain AS (
         SELECT generation_id, previous_generation_id
           FROM ${cleanSchema}.staff_identity_generations
          WHERE generation_id = $1::uuid
         UNION
         SELECT g.generation_id, g.previous_generation_id
           FROM ${cleanSchema}.staff_identity_generations g
           JOIN chain ch ON g.generation_id = ch.previous_generation_id
       )
       SELECT
         (SELECT count(*) FROM chain) = (SELECT count(*) FROM ${cleanSchema}.staff_identity_generations)
         AND $3::bigint = (SELECT count(*) FROM ${cleanSchema}.staff_identity_generations)
                        + (SELECT count(*) FROM ${cleanSchema}.staff_identity_binding_events)
         AND NOT EXISTS (
           SELECT 1 FROM ${cleanSchema}.staff_identity_generations WHERE realm_id <> $2::uuid
         )
         AND NOT EXISTS (
           SELECT 1 FROM ${cleanSchema}.staff_identity_subjects
            WHERE realm_id <> $2::uuid OR created_registry_revision > $3::bigint
         )
         AND NOT EXISTS (
           SELECT 1 FROM ${cleanSchema}.staff_identity_binding_events
            WHERE registry_revision > $3::bigint
         )
         AND NOT EXISTS (
           SELECT 1
             FROM (
               SELECT previous_subject_id,
                      lag(new_subject_id) OVER (PARTITION BY user_id ORDER BY registry_revision) AS prior
                 FROM ${cleanSchema}.staff_identity_binding_events
             ) e
            WHERE previous_subject_id IS DISTINCT FROM prior
         )
         AND NOT EXISTS (
           SELECT 1
             FROM ${cleanSchema}.staff_identity_subjects p
             LEFT JOIN ${cleanSchema}.staff_identity_binding_events e
               ON e.registry_revision = p.created_registry_revision
            WHERE e.new_subject_id IS DISTINCT FROM p.subject_id
               OR e.user_id IS DISTINCT FROM p.user_id_at_binding
               OR e.generation_id IS DISTINCT FROM p.created_generation_id
         )
         AND NOT EXISTS (
           SELECT 1
             FROM ${cleanSchema}.staff_identity_binding_events e
             LEFT JOIN ${cleanSchema}.staff_identity_current b ON b.user_id = e.user_id
            WHERE NOT EXISTS (
                    SELECT 1 FROM ${cleanSchema}.staff_identity_binding_events later
                     WHERE later.user_id = e.user_id AND later.registry_revision > e.registry_revision
                  )
              AND (
                (e.new_subject_id IS NULL AND b.user_id IS NOT NULL)
                OR (
                  e.new_subject_id IS NOT NULL
                  AND (
                    b.subject_id IS DISTINCT FROM e.new_subject_id
                    OR b.bound_registry_revision IS DISTINCT FROM e.registry_revision
                  )
                )
              )
         )
         AND NOT EXISTS (
           SELECT 1
             FROM ${cleanSchema}.staff_identity_current b
             LEFT JOIN ${cleanSchema}.staff_identity_subjects p ON p.subject_id = b.subject_id
             LEFT JOIN ${cleanSchema}.staff_identity_binding_events e ON e.registry_revision = b.bound_registry_revision
            WHERE p.user_id_at_binding IS DISTINCT FROM b.user_id
               OR p.realm_id IS DISTINCT FROM $2::uuid
               OR e.new_subject_id IS DISTINCT FROM b.subject_id
               OR e.user_id IS DISTINCT FROM b.user_id
               OR EXISTS (
                 SELECT 1 FROM ${cleanSchema}.staff_identity_binding_events later
                  WHERE later.user_id = b.user_id AND later.registry_revision > e.registry_revision
               )
         ) AS valid`,
      [h.generation_id, h.realm_id, h.registry_revision],
    );
    if (integrity?.valid !== true) {
      return { mode: "canonical", ownerAuthority: null, deniedReason: "history-invalid" };
    }

    const { rows: users } = await source.query<{
      id: number;
      username: string;
      role: string;
      is_active: boolean;
      authorization_mode: string;
      password_hash: string;
      permissions: unknown;
      party_id: number | null;
    }>(
      `SELECT id, username, role, is_active, authorization_mode, password_hash, permissions, party_id
         FROM ${cleanSchema}.users
        WHERE id = ANY($1::integer[])
        ORDER BY id`,
      [[c.owner_user_id, userId]],
    );
    const owner = users.find((u) => u.id === c.owner_user_id);
    const user = users.find((u) => u.id === userId);
    if (
      !owner ||
      !owner.is_active ||
      owner.role !== "admin" ||
      owner.authorization_mode !== "canonical" ||
      !user ||
      !user.is_active ||
      user.authorization_mode !== "canonical" ||
      typeof user.username !== "string" ||
      user.username.length < 1 ||
      user.username.length > 200 ||
      typeof user.password_hash !== "string" ||
      !user.password_hash
    ) {
      return { mode: "canonical", ownerAuthority: null, deniedReason: "account-invalid" };
    }

    const { rows: bindings } = await source.query<{ user_id: number; subject_id: string }>(
      `SELECT user_id, subject_id::text AS subject_id
         FROM ${cleanSchema}.staff_identity_current
        WHERE user_id = ANY($1::integer[])
        ORDER BY user_id`,
      [[c.owner_user_id, userId]],
    );
    const ownerBinding = bindings.find((b) => b.user_id === c.owner_user_id)?.subject_id;
    const userBinding = bindings.find((b) => b.user_id === userId)?.subject_id;
    if (ownerBinding !== h.ready_owner_subject_id || typeof userBinding !== "string") {
      return { mode: "canonical", ownerAuthority: null, deniedReason: "subject-stale" };
    }

    let clinicianPartyId: number | null = null;
    if (user.party_id !== null) {
      const { rows: partyRows } = await source.query<{ id: number; kind: string; is_active: boolean }>(
        `SELECT id, kind, is_active FROM ${cleanSchema}.parties WHERE id = $1`,
        [user.party_id],
      );
      const party = partyRows[0];
      if (partyRows.length !== 1 || party.kind !== "doctor" || !party.is_active) {
        return { mode: "canonical", ownerAuthority: null, deniedReason: "provider-stale" };
      }
      clinicianPartyId = party.id;
    }

    const parsed = parseStaffCapabilityDocument(user.permissions);
    if (!parsed.ok) {
      return { mode: "canonical", ownerAuthority: null, deniedReason: "permissions-invalid" };
    }

    const bindingVersion = `${h.ready_owner_subject_id}:${c.binding_epoch}`;
    const ownerContext = ownerContextFromTrustedBinding({
      ownerUserId: c.owner_user_id,
      bindingVersion,
    });
    const access = resolveStaffCapabilities(
      {
        subject: {
          userId: user.id,
          role: user.role,
          isActive: user.is_active,
          clinicianPartyId,
        },
        permissionDocument: parsed.value,
      },
      ownerContext,
    );
    if (access.status !== "allowed") {
      return { mode: "canonical", ownerAuthority: null, deniedReason: access.reason ?? "access-denied" };
    }

    return {
      mode: "canonical",
      ownerAuthority: Object.freeze({ access, bindingVersion }),
    };
  } catch {
    return { mode: "canonical", ownerAuthority: null, deniedReason: "canonical-verification-failed" };
  }
}

export async function loadCanonicalOwnerAuthority(
  userId: number,
  source?: Pick<DbClient, "query">,
): Promise<CanonicalOwnerAuthority | null> {
  const runner = source ?? getPool();
  const inspected = await inspectStaffPortalAuthority(runner, userId);
  if (inspected.mode !== "canonical" || !inspected.ownerAuthority) {
    return null;
  }
  return inspected.ownerAuthority;
}
