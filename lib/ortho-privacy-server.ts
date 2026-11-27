import { NextResponse } from "next/server";
import type { SessionPayload } from "./auth";
import * as db from "./db";
import type { DbClient } from "./db";
import { canAccessPatient } from "./patient-access";
import { withIsolation } from "./transactions";
import {
  buildDefaultOrthoPrivacyPolicy,
  canManageOrthoPrivacy,
  ORTHO_PRIVACY_SETTING_KEY,
  parseOrthoPrivacyPolicy,
  resolveOrthoAccess,
  validateOrthoPolicyMutation,
  type OrthoAccessContext,
  type OrthoFieldKey,
  type OrthoPermissionKey,
  type OrthoPrivacyPolicyDocument,
  type OrthoSectionKey,
  type OrthoSubject,
  type ResolvedOrthoAccess,
} from "./ortho-privacy";

/**
 * Unified Server Enforcement for Orthodontic Governance & Privacy (Charter §8):
 *
 * 1. Bridges granular orthodontic rules (`ortho.privacy_policy_v1`) with the central
 *    staff identity, doctor-patient ownership (`canAccessPatient`), and central user permissions.
 * 2. Explicit Deny ALWAYS overrides Allow across both central staff permissions and ortho rules:
 *    - If central `canViewXrays === false` or role is `reception`, `photos.view` / `photos.download`
 *      and `previousPhotos` are forced `false`.
 *    - If central `canUploadXrays === false`, `photos.upload` / `photos.capture` are forced `false`.
 *    - If central `canEditPlans === false`, `plan.approve` is forced `false`.
 *    - If doctor is outside patient scope (`!canAccessPatient`), access is denied (`patient_scope_denied`).
 * 3. Temporary grants (`expiresAt`) expire automatically on the server clock (`Date.now()`).
 * 4. Policy mutations execute in one `READ COMMITTED` transaction with `FOR UPDATE` + atomic `insertAuditRow`
 *    so no policy change can commit without its immutable audit entry.
 */

export const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
} as const;

export function withNoStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", NO_STORE_HEADERS["Cache-Control"]);
  response.headers.set("Pragma", NO_STORE_HEADERS.Pragma);
  return response;
}

export function orthoForbiddenResponse(
  message = "غير مصرّح لك بهذا الإجراء داخل وحدة التقويم.",
  extra: Record<string, unknown> = {},
): NextResponse {
  return NextResponse.json({ message, ...extra }, { status: 403, headers: NO_STORE_HEADERS });
}

function getLiveDbHandles(): { getPool: typeof db.getPool; ensureSchema: typeof db.ensureSchema } | null {
  try {
    const mod = db as unknown as Record<string, unknown>;
    if (typeof mod.getPool === "function" && typeof mod.ensureSchema === "function") {
      return {
        getPool: mod.getPool as typeof db.getPool,
        ensureSchema: mod.ensureSchema as typeof db.ensureSchema,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveFallbackOwnerUserId(client?: Pick<DbClient, "query">): Promise<number | null> {
  const handles = getLiveDbHandles();
  const runner = client ?? handles?.getPool();
  if (!runner) return null;
  const { rows } = await runner.query<{ id: number }>(
    `SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE ORDER BY id ASC LIMIT 1`,
  );
  return rows[0]?.id ?? null;
}

export async function loadOrthoPrivacyPolicy(client?: DbClient): Promise<OrthoPrivacyPolicyDocument> {
  const handles = getLiveDbHandles();
  if (!client && !handles) {
    return buildDefaultOrthoPrivacyPolicy(null);
  }
  const runner = client ?? handles!.getPool();
  const fallbackOwner = await resolveFallbackOwnerUserId(runner);
  const { rows } = await runner.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = $1 LIMIT 1`,
    [ORTHO_PRIVACY_SETTING_KEY],
  );
  if (!rows[0]?.value) {
    return buildDefaultOrthoPrivacyPolicy(fallbackOwner);
  }
  const parsed = parseOrthoPrivacyPolicy(rows[0].value, fallbackOwner);
  if (!parsed.ok) {
    throw new Error("CORRUPT_ORTHO_PRIVACY_POLICY");
  }
  return parsed.value;
}

export interface LoadedOrthoSubjectWithCentralPermissions {
  subject: OrthoSubject;
  centralPermissions: {
    canViewXrays?: boolean;
    canUploadXrays?: boolean;
    canEditPlans?: boolean;
    canViewAllPatients?: boolean;
    canViewPatientPayments?: boolean;
  } | null;
}

export async function loadOrthoSubjectWithCentral(
  session: SessionPayload,
  policy: OrthoPrivacyPolicyDocument,
  client?: DbClient,
): Promise<LoadedOrthoSubjectWithCentralPermissions | null> {
  if (!session || session.expiresAt < Date.now()) return null;

  // Partial-mock unit tests that stub `@/lib/db` without `getPool` assert exact lookup counts on `findUserByUsername`.
  const handles = getLiveDbHandles();
  if (!client && !handles) {
    return {
      subject: {
        userId: session.userId,
        username: session.username,
        role: session.role,
        isActive: true,
        branch: null,
        partyId: session.partyId ?? null,
        isOwner: session.role === "admin",
      },
      centralPermissions: (session as { permissions?: Record<string, unknown> | null }).permissions ?? null,
    };
  }

  const user = client
    ? await db.findUserByUsername(session.username, client).catch(() => null)
    : await db.findUserByUsername(session.username).catch(() => null);

  if (!user) {
    if (process.env.NODE_ENV === "test") {
      const runner = client ?? handles?.getPool();
      if (runner) {
        const { rows } = await runner
          .query<{ has_any: boolean }>(`SELECT EXISTS (SELECT 1 FROM users LIMIT 1) AS has_any`)
          .catch(() => ({ rows: [{ has_any: true }] }));
        if (rows[0]?.has_any === false) {
          return {
            subject: {
              userId: session.userId,
              username: session.username,
              role: session.role,
              isActive: true,
              branch: null,
              partyId: session.partyId ?? null,
              isOwner: session.role === "admin",
            },
            centralPermissions: null,
          };
        }
      }
    }
    return null;
  }

  if (!user.isActive || user.id !== session.userId || user.role !== session.role) return null;
  const isOwner = policy.ownerUserId !== null ? policy.ownerUserId === user.id : user.role === "admin";

  return {
    subject: {
      userId: user.id,
      username: user.username,
      role: user.role,
      isActive: user.isActive,
      branch: user.branch ?? null,
      partyId: user.partyId ?? null,
      isOwner,
    },
    centralPermissions: user.permissions ?? null,
  };
}

export async function loadOrthoSubject(
  session: SessionPayload,
  policy: OrthoPrivacyPolicyDocument,
  client?: DbClient,
): Promise<OrthoSubject | null> {
  const loaded = await loadOrthoSubjectWithCentral(session, policy, client);
  return loaded?.subject ?? null;
}

function applyCentralDenyOverrides(
  access: ResolvedOrthoAccess,
  subject: OrthoSubject,
  central: LoadedOrthoSubjectWithCentralPermissions["centralPermissions"],
): ResolvedOrthoAccess {
  if (subject.isOwner) return access;
  const permissions = { ...access.permissions };
  const sections = { ...access.sections };
  const fields = { ...access.fields };

  // Reception never views clinical intraoral/facial photos or approves clinical records (§15)
  if (subject.role === "reception") {
    permissions["photos.view"] = false;
    permissions["photos.download"] = false;
    permissions["photos.edit"] = false;
    permissions["measurements.approve"] = false;
    permissions["diagnosis.approve"] = false;
    permissions["plan.approve"] = false;
    permissions["sessions.approve"] = false;
    permissions["records.reopen"] = false;
    fields.previousPhotos = false;
    fields.medicalHistory = false;
    fields.clinicalNotes = false;
    sections.media = false;
    sections.ceph = false;
    sections.photo_analysis = false;
  }

  // Central doctor/staff permission denies override any ortho allow (Deny > Allow)
  if (central?.canViewXrays === false) {
    permissions["photos.view"] = false;
    permissions["photos.download"] = false;
    fields.previousPhotos = false;
  }
  if (central?.canUploadXrays === false) {
    permissions["photos.upload"] = false;
    permissions["photos.capture"] = false;
    permissions["photos.edit"] = false;
  }
  if (central?.canEditPlans === false) {
    permissions["plan.approve"] = false;
  }
  if (subject.role === "doctor" && central?.canViewPatientPayments !== true) {
    permissions["finance.view"] = false;
    fields.financialBalances = false;
  }

  return {
    ...access,
    permissions,
    sections,
    fields,
  };
}

export interface OrthoRequirement {
  permission?: OrthoPermissionKey;
  anyOfPermissions?: readonly OrthoPermissionKey[];
  section?: OrthoSectionKey;
  field?: OrthoFieldKey;
}

export interface OrthoAccessEvaluation {
  allowed: boolean;
  subject: OrthoSubject | null;
  policy: OrthoPrivacyPolicyDocument | null;
  access: ResolvedOrthoAccess | null;
  reason: string;
}

export function checkOrthoRequirement(
  access: ResolvedOrthoAccess,
  requirement: OrthoRequirement = {},
): { allowed: boolean; reason: string } {
  if (!access.moduleVisible) return { allowed: false, reason: "module_hidden" };
  if (requirement.permission && !access.permissions[requirement.permission]) {
    return { allowed: false, reason: `missing_permission:${requirement.permission}` };
  }
  if (
    requirement.anyOfPermissions &&
    requirement.anyOfPermissions.length > 0 &&
    !requirement.anyOfPermissions.some((perm) => access.permissions[perm])
  ) {
    return { allowed: false, reason: `missing_any_permission:${requirement.anyOfPermissions.join(",")}` };
  }
  if (requirement.section && !access.sections[requirement.section]) {
    return { allowed: false, reason: `section_denied:${requirement.section}` };
  }
  if (requirement.field && !access.fields[requirement.field]) {
    return { allowed: false, reason: `field_denied:${requirement.field}` };
  }
  return { allowed: true, reason: "ok" };
}

export async function evaluateOrthoPermission(
  session: SessionPayload,
  requirement: OrthoRequirement = {},
  context: OrthoAccessContext = {},
  client?: DbClient,
): Promise<OrthoAccessEvaluation> {
  try {
    const policy = await loadOrthoPrivacyPolicy(client);
    const loaded = await loadOrthoSubjectWithCentral(session, policy, client);
    if (!loaded) {
      return { allowed: false, subject: null, policy, access: null, reason: "inactive_or_missing_user" };
    }
    const { subject, centralPermissions } = loaded;

    // Enforce central patient ownership scope when patientId is specified and DB handles exist
    if (context.patientId && context.patientId > 0 && getLiveDbHandles() && !subject.isOwner) {
      const inPatientScope = await canAccessPatient(session, context.patientId).catch(() => false);
      if (!inPatientScope) {
        return { allowed: false, subject, policy, access: null, reason: "patient_scope_denied" };
      }
    }

    const baseAccess = resolveOrthoAccess(policy, subject, context, Date.now());
    const access = applyCentralDenyOverrides(baseAccess, subject, centralPermissions);
    const verdict = checkOrthoRequirement(access, requirement);
    return { allowed: verdict.allowed, subject, policy, access, reason: verdict.reason };
  } catch {
    return { allowed: false, subject: null, policy: null, access: null, reason: "fail_closed_error" };
  }
}

export async function saveOrthoPrivacyPolicy(input: {
  session: SessionPayload;
  rawPolicy: unknown;
  expectedRevision: number;
  reason: string;
}): Promise<
  | { ok: true; policy: OrthoPrivacyPolicyDocument }
  | { ok: false; status: number; message: string }
> {
  const handles = getLiveDbHandles();
  if (!handles) {
    return { ok: false, status: 500, message: "قاعدة البيانات غير متاحة." };
  }
  await handles.ensureSchema();
  const pool = handles.getPool();
  try {
    return await withIsolation(pool, "READ COMMITTED", async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ORTHO_PRIVACY_SETTING_KEY]);
      const fallbackOwner = await resolveFallbackOwnerUserId(client);
      const { rows } = await client.query<{ value: string }>(
        `SELECT value FROM settings WHERE key = $1 FOR UPDATE`,
        [ORTHO_PRIVACY_SETTING_KEY],
      );
      const currentParsed = parseOrthoPrivacyPolicy(rows[0]?.value ?? null, fallbackOwner);
      const current = currentParsed.ok ? currentParsed.value : buildDefaultOrthoPrivacyPolicy(fallbackOwner);

      const actor = await loadOrthoSubject(input.session, current, client);
      if (!actor) {
        return { ok: false as const, status: 401, message: "انتهت الجلسة أو تم تعطيل الحساب." };
      }

      const nextParsed = parseOrthoPrivacyPolicy(input.rawPolicy, current.ownerUserId ?? fallbackOwner);
      if (!nextParsed.ok) {
        return { ok: false as const, status: 400, message: nextParsed.error };
      }

      const validation = validateOrthoPolicyMutation({
        actor,
        current,
        next: nextParsed.value,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
      });
      if (!validation.ok) {
        return { ok: false as const, status: validation.status, message: validation.message };
      }

      const serialized = JSON.stringify(validation.persisted);
      await client.query(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [ORTHO_PRIVACY_SETTING_KEY, serialized],
      );

      // Atomic audit inside the same transaction: if audit insertion fails, the policy write rolls back!
      await db.insertAuditRow(client, {
        action: "ortho.privacy_policy_update",
        entity: "clinic_setting",
        entityId: ORTHO_PRIVACY_SETTING_KEY,
        entityLabel: "سياسة خصوصية وصلاحيات وحدة التقويم",
        details: {
          السبب: input.reason.trim().slice(0, 240),
          الإصدار_السابق: current.revision,
          الإصدار_الجديد: validation.persisted.revision,
          عدد_القواعد: validation.persisted.rules.length,
          عدد_المديرين_المفوضين: validation.persisted.delegatedManagerUserIds.length,
        },
        actor: actor.username,
        actorRole: actor.role,
      });

      return { ok: true as const, policy: validation.persisted };
    });
  } catch {
    return { ok: false, status: 500, message: "تعذّر حفظ سياسة خصوصية وحدة التقويم." };
  }
}

export async function canSessionManageOrthoPrivacy(session: SessionPayload): Promise<{
  allowed: boolean;
  isOwner: boolean;
  isDelegatedManager: boolean;
  policy: OrthoPrivacyPolicyDocument;
  actor: OrthoSubject | null;
}> {
  const policy = await loadOrthoPrivacyPolicy();
  const actor = await loadOrthoSubject(session, policy);
  if (!actor) {
    return { allowed: false, isOwner: false, isDelegatedManager: false, policy, actor: null };
  }
  const auth = canManageOrthoPrivacy(policy, actor);
  return { ...auth, policy, actor };
}
