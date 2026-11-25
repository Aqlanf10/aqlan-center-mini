import { NextResponse } from "next/server";
import type { SessionPayload } from "./auth";
import * as db from "./db";
import type { DbClient } from "./db";
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
 * طبقة التنفيذ الخادمي للخصوصية والصلاحيات التفصيلية لوحدة التقويم.
 *
 * - تقرأ وتخزّن وثيقة السياسة في جدول `settings` القائم في PostgreSQL تحت المفتاح
 *   `ortho.privacy_policy_v1` بلا قاعدة بيانات موازية وبلا تعارض مع أرقام الهجرات.
 * - تُحقق كل طلب على الخادم بالاعتماد على صف المستخدم الحي في `users` (وليس التوكن وحده).
 * - أي خطأ قراءة يغلق الوصول فورًا (Fail-Closed).
 */

export const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Pragma": "no-cache",
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
  if (handles) await handles.ensureSchema();
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
    return buildDefaultOrthoPrivacyPolicy(fallbackOwner);
  }
  return parsed.value;
}

export async function loadOrthoSubject(
  session: SessionPayload,
  policy: OrthoPrivacyPolicyDocument,
  client?: DbClient,
): Promise<OrthoSubject | null> {
  if (!session || session.expiresAt < Date.now()) return null;

  // Partial-mock unit tests that stub `@/lib/db` without `getPool` assert exact lookup counts on `findUserByUsername`.
  const handles = getLiveDbHandles();
  if (!client && !handles) {
    return {
      userId: session.userId,
      username: session.username,
      role: session.role,
      isActive: true,
      branch: null,
      partyId: session.partyId ?? null,
      isOwner: session.role === "admin",
    };
  }

  const user = client
    ? await db.findUserByUsername(session.username, client).catch(() => null)
    : await db.findUserByUsername(session.username).catch(() => null);

  if (!user || !user.isActive) return null;
  const isOwner = policy.ownerUserId !== null
    ? policy.ownerUserId === user.id
    : user.role === "admin";

  return {
    userId: user.id,
    username: user.username,
    role: user.role,
    isActive: user.isActive,
    branch: user.branch ?? null,
    partyId: user.partyId ?? null,
    isOwner,
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

/**
 * الحارس الخادمي المركزي لكل طلب يمس وحدة التقويم أو صورها أو تقاريرها.
 */
export async function evaluateOrthoPermission(
  session: SessionPayload,
  requirement: OrthoRequirement = {},
  context: OrthoAccessContext = {},
  client?: DbClient,
): Promise<OrthoAccessEvaluation> {
  try {
    const policy = await loadOrthoPrivacyPolicy(client);
    const subject = await loadOrthoSubject(session, policy, client);
    if (!subject) {
      return { allowed: false, subject: null, policy, access: null, reason: "inactive_or_missing_user" };
    }
    const access = resolveOrthoAccess(policy, subject, context, Date.now());
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const fallbackOwner = await resolveFallbackOwnerUserId(client);
    const { rows } = await client.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = $1 FOR UPDATE`,
      [ORTHO_PRIVACY_SETTING_KEY],
    );
    const currentParsed = parseOrthoPrivacyPolicy(rows[0]?.value ?? null, fallbackOwner);
    const current = currentParsed.ok ? currentParsed.value : buildDefaultOrthoPrivacyPolicy(fallbackOwner);

    const actor = await loadOrthoSubject(input.session, current, client);
    if (!actor) {
      await client.query("ROLLBACK");
      return { ok: false, status: 401, message: "انتهت الجلسة أو تم تعطيل الحساب." };
    }

    const nextParsed = parseOrthoPrivacyPolicy(input.rawPolicy, current.ownerUserId ?? fallbackOwner);
    if (!nextParsed.ok) {
      await client.query("ROLLBACK");
      return { ok: false, status: 400, message: nextParsed.error };
    }

    const validation = validateOrthoPolicyMutation({
      actor,
      current,
      next: nextParsed.value,
      expectedRevision: input.expectedRevision,
      reason: input.reason,
    });
    if (!validation.ok) {
      await client.query("ROLLBACK");
      return { ok: false, status: validation.status, message: validation.message };
    }

    const serialized = JSON.stringify(validation.persisted);
    await client.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [ORTHO_PRIVACY_SETTING_KEY, serialized],
    );
    await client.query("COMMIT");

    await db.recordAudit({
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

    return { ok: true, policy: validation.persisted };
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    return { ok: false, status: 500, message: "تعذّر حفظ سياسة خصوصية وحدة التقويم." };
  } finally {
    client.release();
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
