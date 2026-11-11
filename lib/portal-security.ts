import { createHash, randomBytes } from "node:crypto";
import { hashPassword, verifyPassword, type SessionPayload } from "./auth";
import {
  ensureSchema,
  getPatient,
  getPool,
  messagingChannelWithSecret,
  recordAudit,
  recordMessageDelivery,
  updatePatient,
} from "./db";
import { samePhone } from "./duplicates";
import { sendOutbound, type OutboundDeps } from "./messaging-send";
import { canAccessPatient } from "./patient-access";
import {
  normalizePortalLoginName,
  portalPhoneFingerprint,
  validatePortalLoginName,
  validatePortalPasswordChoice,
} from "./portal";

/**
 * (<NNNN>_patient_portal_security) خدمات أمان بوابة المريض — التفعيل من الطاقم المخوّل، وروابط التفعيل/الاستعادة
 * المؤقتة أحادية الاستخدام، وإبطال الجلسات الفوري، وصلاحيات «عرض بوابة المريض» المستقلة.
 *
 * قواعد صارمة:
 * - لا تُخزَّن كلمة المرور الأصلية أو الرمز الخام أو الرابط في القاعدة أو `audit_log` أو `message_deliveries` أو السجلات.
 * - تجزئة كلمات المرور عبر `scrypt` (`hashPassword` / `verifyPassword`)، وتجزئة الرموز عبر `SHA-256`.
 * - مسار الدخول القديم برقم الملف والهاتف محذوف نهائيًا بلا أي استثناء طوارئ؛ وتُعتمد الاستعادة الحضورية الآمنة بتحديث وسيلة التواصل ورابط مؤقت أحادي الاستخدام.
 */

export const PORTAL_ACTIVATION_TTL_MS = 60 * 60 * 1000; // 60 دقيقة
export const PORTAL_RESET_TTL_MS = 30 * 60 * 1000; // 30 دقيقة
export const PORTAL_IN_PERSON_RESET_TTL_MS = 15 * 60 * 1000; // 15 دقيقة

export type PortalTokenPurpose = "activate" | "reset" | "in_person_reset";
export type PortalDeliveryChannel = "whatsapp" | "sms" | "in_person";
export type PortalAccountStatus = "pending_activation" | "active" | "disabled";

export interface PortalStaffAccess {
  userId: number;
  username: string;
  displayName: string;
  role: string;
  isActive: boolean;
  isOwner: boolean;
  canManagePortal: boolean;
  canPreviewPortal: boolean;
}

export interface PatientPortalAccountSummary {
  exists: boolean;
  patientId: number;
  loginName: string | null;
  status: PortalAccountStatus | "not_activated";
  credentialVersion: number | null;
  activatedAt: string | null;
  passwordUpdatedAt: string | null;
  lastLoginAt: string | null;
  sessionsRevokedAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  hasPendingToken: boolean;
  pendingTokenPurpose: PortalTokenPurpose | null;
  pendingTokenExpiresAt: string | null;
  pendingTokenChannel: PortalDeliveryChannel | null;
}

// تجزئة وهمية ثابتة لمنع كشف وجود اسم المستخدم عبر فرق زمن فحص scrypt
let dummyPasswordHashPromise: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHashPromise) {
    dummyPasswordHashPromise = hashPassword("Dummy#PortalTimingGuard99!");
  }
  return dummyPasswordHashPromise;
}

export function hashPortalActionToken(rawToken: string): string {
  return createHash("sha256")
    .update(`portal-token-v1:${rawToken.trim()}`)
    .digest("hex");
}

export function generatePortalActionToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString("base64url");
  return { rawToken, tokenHash: hashPortalActionToken(rawToken) };
}

export function buildPortalActionUrl(
  baseOrigin: string,
  mode: "activate" | "reset",
  rawToken: string,
): string {
  const cleanOrigin = baseOrigin.replace(/\/+$/, "");
  return `${cleanOrigin}/portal?mode=${mode}&token=${encodeURIComponent(rawToken)}`;
}

/**
 * استخراج صلاحيات الموظف الفعلية تجاه بوابة المريض:
 * - المالك (`is_owner = TRUE` أو أول مدير نشط عند الإقلاع الأول قبل تخصيص مالك صريح) يملك الإدارة والمعاينة.
 * - «عرض بوابة المريض» محصور بالمالك وبدور الإدارة (`role === 'admin'`) الحاصل على صلاحية `can_preview_portal` المستقلة.
 * - تفعيل الحسابات وإرسال روابط الاستعادة يتطلب `canManagePortal` (المالك أو موظف مخوّل صراحةً).
 */
export async function getPortalStaffAccess(userId: number): Promise<PortalStaffAccess | null> {
  if (!Number.isInteger(userId) || userId <= 0) return null;
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: number;
    username: string;
    display_name: string;
    role: string;
    is_active: boolean;
    is_owner: boolean | null;
    can_manage_portal: boolean | null;
    can_preview_portal: boolean | null;
    any_explicit_owner: boolean;
    first_active_admin_id: number | null;
  }>(
    `SELECT u.id,
            u.username,
            u.display_name,
            u.role,
            u.is_active,
            g.is_owner,
            g.can_manage_portal,
            g.can_preview_portal,
            EXISTS (
              SELECT 1
                FROM patient_portal_staff_grants g2
                JOIN users u2 ON u2.id = g2.user_id
               WHERE g2.is_owner = TRUE
                 AND u2.role = 'admin'
                 AND u2.is_active = TRUE
            ) AS any_explicit_owner,
            (
              SELECT MIN(u3.id)
                FROM users u3
               WHERE u3.role = 'admin'
                 AND u3.is_active = TRUE
            ) AS first_active_admin_id
       FROM users u
       LEFT JOIN patient_portal_staff_grants g ON g.user_id = u.id
      WHERE u.id = $1
      LIMIT 1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  if (!row.is_active) {
    return {
      userId: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      isActive: false,
      isOwner: false,
      canManagePortal: false,
      canPreviewPortal: false,
    };
  }
  const isBootstrapOwner =
    !row.any_explicit_owner &&
    row.role === "admin" &&
    row.first_active_admin_id === row.id;
  const isOwner = row.role === "admin" && (row.is_owner === true || isBootstrapOwner);
  const canManagePortal = isOwner || row.can_manage_portal === true;
  const canPreviewPortal =
    row.role === "admin" && (isOwner || row.can_preview_portal === true);

  return {
    userId: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    isActive: true,
    isOwner,
    canManagePortal,
    canPreviewPortal,
  };
}

export interface PortalStaffGrantRow {
  userId: number;
  username: string;
  displayName: string;
  role: string;
  isActive: boolean;
  isOwner: boolean;
  canManagePortal: boolean;
  canPreviewPortal: boolean;
  note: string | null;
  updatedAt: string | null;
}

export async function listPortalStaffGrants(): Promise<PortalStaffGrantRow[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: number;
    username: string;
    display_name: string;
    role: string;
    is_active: boolean;
    is_owner: boolean | null;
    can_manage_portal: boolean | null;
    can_preview_portal: boolean | null;
    note: string | null;
    updated_at: Date | null;
    any_explicit_owner: boolean;
    first_active_admin_id: number | null;
  }>(
    `WITH owner_state AS (
       SELECT EXISTS (
                SELECT 1
                  FROM patient_portal_staff_grants g2
                  JOIN users u2 ON u2.id = g2.user_id
                 WHERE g2.is_owner = TRUE
                   AND u2.role = 'admin'
                   AND u2.is_active = TRUE
              ) AS any_explicit_owner,
              (
                SELECT MIN(u3.id)
                  FROM users u3
                 WHERE u3.role = 'admin'
                   AND u3.is_active = TRUE
              ) AS first_active_admin_id
     )
     SELECT u.id,
            u.username,
            u.display_name,
            u.role,
            u.is_active,
            g.is_owner,
            g.can_manage_portal,
            g.can_preview_portal,
            g.note,
            g.updated_at,
            o.any_explicit_owner,
            o.first_active_admin_id
       FROM users u
       CROSS JOIN owner_state o
       LEFT JOIN patient_portal_staff_grants g ON g.user_id = u.id
      ORDER BY u.is_active DESC, u.id ASC`,
  );
  return rows.map((row) => {
    const bootstrapOwner =
      row.is_active &&
      !row.any_explicit_owner &&
      row.role === "admin" &&
      row.first_active_admin_id === row.id;
    const isOwner = row.is_active && row.role === "admin" && (row.is_owner === true || bootstrapOwner);
    return {
      userId: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      isActive: row.is_active,
      isOwner,
      canManagePortal: row.is_active && (isOwner || row.can_manage_portal === true),
      canPreviewPortal:
        row.is_active && row.role === "admin" && (isOwner || row.can_preview_portal === true),
      note: row.note,
      updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
    };
  });
}

export async function updatePortalStaffGrant(input: {
  actorSession: SessionPayload;
  targetUserId: number;
  isOwner?: boolean;
  canManagePortal: boolean;
  canPreviewPortal: boolean;
  note?: string | null;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const actorAccess = await getPortalStaffAccess(input.actorSession.userId);
  if (!actorAccess || !actorAccess.isActive) {
    return { ok: false, status: 401, message: "انتهت الجلسة." };
  }
  if (actorAccess.role !== "admin" || (!actorAccess.isOwner && !actorAccess.canManagePortal)) {
    return { ok: false, status: 403, message: "غير مصرّح لك بإدارة صلاحيات بوابة المريض." };
  }

  const targetAccess = await getPortalStaffAccess(input.targetUserId);
  if (!targetAccess) {
    return { ok: false, status: 404, message: "الموظف المطلوب غير موجود." };
  }

  const nextIsOwner = input.isOwner !== undefined ? Boolean(input.isOwner) : targetAccess.isOwner;
  // منح/سحب صفة المالك أو صلاحية «عرض بوابة المريض» المستقلة محصور بالمالك وحده (لا ترقية ذاتية لمدير غير مالك).
  if (!actorAccess.isOwner) {
    if (nextIsOwner !== targetAccess.isOwner || input.canPreviewPortal !== targetAccess.canPreviewPortal) {
      return {
        ok: false,
        status: 403,
        message: "منح صلاحية المالك أو «عرض بوابة المريض» محصور بمالك العيادة فقط.",
      };
    }
  }

  if ((nextIsOwner || input.canPreviewPortal) && targetAccess.role !== "admin") {
    return {
      ok: false,
      status: 400,
      message: "صلاحية المالك و«عرض بوابة المريض» تُمنح لحسابات الإدارة فقط.",
    };
  }

  const pool = getPool();
  // تثبيت صف المالك الأول في الجدول إن كان في وضع الإقلاع قبل أي تعديل
  if (actorAccess.isOwner) {
    await pool.query(
      `INSERT INTO patient_portal_staff_grants (user_id, is_owner, can_manage_portal, can_preview_portal, granted_by_user_id, note)
       VALUES ($1, TRUE, TRUE, TRUE, $1, 'تثبيت صلاحية المالك')
       ON CONFLICT (user_id) DO NOTHING`,
      [actorAccess.userId],
    );
  }

  if (targetAccess.isOwner && !nextIsOwner) {
    const { rows: [ownersCount] } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM patient_portal_staff_grants g
         JOIN users u ON u.id = g.user_id
        WHERE g.is_owner = TRUE
          AND u.role = 'admin'
          AND u.is_active = TRUE
          AND u.id <> $1`,
      [input.targetUserId],
    );
    if ((ownersCount?.n ?? 0) === 0) {
      return {
        ok: false,
        status: 400,
        message: "لا يمكن إزالة آخر مالك نشط للعيادة.",
      };
    }
  }

  const cleanNote = typeof input.note === "string" ? input.note.trim().slice(0, 300) || null : null;
  const finalManage = nextIsOwner ? true : Boolean(input.canManagePortal);
  const finalPreview = nextIsOwner ? true : Boolean(input.canPreviewPortal);

  await pool.query(
    `INSERT INTO patient_portal_staff_grants (
       user_id, is_owner, can_manage_portal, can_preview_portal, granted_by_user_id, note, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       is_owner = EXCLUDED.is_owner,
       can_manage_portal = EXCLUDED.can_manage_portal,
       can_preview_portal = EXCLUDED.can_preview_portal,
       granted_by_user_id = EXCLUDED.granted_by_user_id,
       note = EXCLUDED.note,
       updated_at = NOW()`,
    [
      input.targetUserId,
      nextIsOwner,
      finalManage,
      finalPreview,
      actorAccess.userId,
      cleanNote,
    ],
  );

  await recordAudit({
    action: "portal.staff_grant.update",
    entity: "user",
    entityId: input.targetUserId,
    entityLabel: targetAccess.username,
    details: {
      targetRole: targetAccess.role,
      previous: {
        isOwner: targetAccess.isOwner,
        canManagePortal: targetAccess.canManagePortal,
        canPreviewPortal: targetAccess.canPreviewPortal,
      },
      next: {
        isOwner: nextIsOwner,
        canManagePortal: finalManage,
        canPreviewPortal: finalPreview,
      },
      ...(cleanNote ? { note: cleanNote } : {}),
    },
    actor: actorAccess.username,
    actorRole: actorAccess.role,
  });

  return { ok: true };
}

export async function getPatientPortalAccountSummary(
  patientId: number,
): Promise<PatientPortalAccountSummary> {
  await ensureSchema();
  const { rows: [account] } = await getPool().query<{
    login_name: string;
    status: PortalAccountStatus;
    credential_version: number;
    activated_at: Date | null;
    password_updated_at: Date | null;
    last_login_at: Date | null;
    sessions_revoked_at: Date | null;
    disabled_at: Date | null;
    disabled_reason: string | null;
  }>(
    `SELECT login_name, status, credential_version, activated_at, password_updated_at,
            last_login_at, sessions_revoked_at, disabled_at, disabled_reason
       FROM patient_portal_accounts
      WHERE patient_id = $1`,
    [patientId],
  );

  const { rows: [pendingToken] } = await getPool().query<{
    purpose: PortalTokenPurpose;
    delivery_channel: PortalDeliveryChannel;
    expires_at: Date;
  }>(
    `SELECT purpose, delivery_channel, expires_at
       FROM patient_portal_tokens
      WHERE patient_id = $1
        AND used_at IS NULL
        AND invalidated_at IS NULL
        AND expires_at > NOW()
      ORDER BY id DESC
      LIMIT 1`,
    [patientId],
  );

  if (!account) {
    return {
      exists: false,
      patientId,
      loginName: null,
      status: "not_activated",
      credentialVersion: null,
      activatedAt: null,
      passwordUpdatedAt: null,
      lastLoginAt: null,
      sessionsRevokedAt: null,
      disabledAt: null,
      disabledReason: null,
      hasPendingToken: Boolean(pendingToken),
      pendingTokenPurpose: pendingToken?.purpose ?? null,
      pendingTokenExpiresAt: pendingToken ? pendingToken.expires_at.toISOString() : null,
      pendingTokenChannel: pendingToken?.delivery_channel ?? null,
    };
  }

  return {
    exists: true,
    patientId,
    loginName: account.login_name,
    status: account.status,
    credentialVersion: account.credential_version,
    activatedAt: account.activated_at ? account.activated_at.toISOString() : null,
    passwordUpdatedAt: account.password_updated_at
      ? account.password_updated_at.toISOString()
      : null,
    lastLoginAt: account.last_login_at ? account.last_login_at.toISOString() : null,
    sessionsRevokedAt: account.sessions_revoked_at
      ? account.sessions_revoked_at.toISOString()
      : null,
    disabledAt: account.disabled_at ? account.disabled_at.toISOString() : null,
    disabledReason: account.disabled_reason,
    hasPendingToken: Boolean(pendingToken),
    pendingTokenPurpose: pendingToken?.purpose ?? null,
    pendingTokenExpiresAt: pendingToken ? pendingToken.expires_at.toISOString() : null,
    pendingTokenChannel: pendingToken?.delivery_channel ?? null,
  };
}

export interface PortalOutboundOptions {
  fetchImpl?: typeof fetch;
  resolveDns?: (hostname: string) => Promise<string[]>;
  channel?: OutboundDeps["channel"];
  record?: OutboundDeps["record"];
}

function buildPortalOutboundDeps(sendOptions?: PortalOutboundOptions): OutboundDeps {
  return {
    channel: sendOptions?.channel ?? messagingChannelWithSecret,
    record: sendOptions?.record ?? recordMessageDelivery,
    fetchImpl: sendOptions?.fetchImpl,
    resolveDns: sendOptions?.resolveDns,
  };
}

export interface PortalIssueLinkResult {
  ok: boolean;
  status: number;
  code?: string;
  message: string;
  loginName?: string;
  expiresAt?: string;
  deliveryChannel?: PortalDeliveryChannel;
  /** يُعاد فقط في مسار التحقق الحضوري المباشر (`in_person`) لعرضه مرة واحدة على الشاشة دون تخزينه. */
  inPersonUrl?: string;
}

export async function issuePortalActivation(
  input: {
    actorSession: SessionPayload;
    patientId: number;
    loginName: string;
    deliveryChannel: PortalDeliveryChannel;
    verificationNote?: string | null;
    baseOrigin: string;
  },
  sendOptions?: PortalOutboundOptions,
): Promise<PortalIssueLinkResult> {
  const access = await getPortalStaffAccess(input.actorSession.userId);
  if (!access || !access.isActive) {
    return { ok: false, status: 401, message: "انتهت الجلسة." };
  }
  if (!access.canManagePortal) {
    return { ok: false, status: 403, message: "غير مصرّح لك بتفعيل حسابات بوابة المرضى." };
  }
  if (!(await canAccessPatient(input.actorSession, input.patientId))) {
    return { ok: false, status: 403, message: "غير مصرّح لك بالوصول إلى ملف هذا المريض." };
  }

  const loginVerdict = validatePortalLoginName(input.loginName);
  if (!loginVerdict.ok) {
    return { ok: false, status: 400, message: loginVerdict.message };
  }
  const normalizedLogin = loginVerdict.value;

  const patient = await getPatient(input.patientId);
  if (!patient) {
    return { ok: false, status: 404, message: "ملف المريض غير موجود." };
  }

  if (input.deliveryChannel !== "whatsapp" && input.deliveryChannel !== "sms" && input.deliveryChannel !== "in_person") {
    return { ok: false, status: 400, message: "وسيلة إرسال التفعيل غير صالحة." };
  }

  const note = typeof input.verificationNote === "string" ? input.verificationNote.trim().slice(0, 500) : "";
  if (input.deliveryChannel === "in_person" && note.length < 8) {
    return {
      ok: false,
      status: 400,
      message: "التفعيل الحضوري المباشر يتطلّب تدوين ملاحظة التحقق من هوية المريض حضوريًا (8 أحرف على الأقل).",
    };
  }
  if (input.deliveryChannel !== "in_person" && (!patient.phone || patient.phone.replace(/\D/g, "").length < 9)) {
    return {
      ok: false,
      status: 400,
      message: "لا يوجد رقم هاتف صالح مسجّل في ملف المريض لإرسال رابط التفعيل.",
    };
  }

  const pool = getPool();
  const { rows: [existingForPatient] } = await pool.query<{
    status: PortalAccountStatus;
    login_name: string;
  }>(
    `SELECT status, login_name FROM patient_portal_accounts WHERE patient_id = $1`,
    [input.patientId],
  );
  if (existingForPatient?.status === "active") {
    return {
      ok: false,
      status: 409,
      code: "already_active",
      message: "حساب البوابة مفعّل مسبقًا لهذا المريض. استخدم استعادة كلمة المرور عند الحاجة.",
    };
  }
  if (existingForPatient?.status === "disabled") {
    return {
      ok: false,
      status: 409,
      code: "account_disabled",
      message: "حساب البوابة معطّل حاليًا. أعد تمكين الحساب أولًا قبل إرسال رابط جديد.",
    };
  }

  const { rows: [collision] } = await pool.query<{ patient_id: number }>(
    `SELECT patient_id FROM patient_portal_accounts WHERE LOWER(login_name) = LOWER($1) AND patient_id <> $2 LIMIT 1`,
    [normalizedLogin, input.patientId],
  );
  if (collision) {
    return {
      ok: false,
      status: 409,
      code: "username_taken",
      message: "اسم المستخدم مستخدم بالفعل لمريض آخر. اختر اسم مستخدم مختلفًا.",
    };
  }

  const { rawToken, tokenHash } = generatePortalActionToken();
  const expiresAt = new Date(Date.now() + PORTAL_ACTIVATION_TTL_MS);
  const phoneFingerprint = portalPhoneFingerprint(patient.phone);

  const client = await pool.connect();
  let tokenId = 0;
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO patient_portal_accounts (
         patient_id, login_name, status, phone_fingerprint, activated_by_user_id, updated_at
       ) VALUES ($1, $2, 'pending_activation', $3, $4, NOW())
       ON CONFLICT (patient_id) DO UPDATE SET
         login_name = EXCLUDED.login_name,
         phone_fingerprint = EXCLUDED.phone_fingerprint,
         activated_by_user_id = EXCLUDED.activated_by_user_id,
         updated_at = NOW()`,
      [input.patientId, normalizedLogin, phoneFingerprint, access.userId],
    );
    await client.query(
      `UPDATE patient_portal_tokens
          SET invalidated_at = NOW(),
              invalidation_reason = 'superseded'
        WHERE patient_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
      [input.patientId],
    );
    const { rows: [insertedToken] } = await client.query<{ id: string }>(
      `INSERT INTO patient_portal_tokens (
         patient_id, token_hash, purpose, delivery_channel, phone_fingerprint,
         issued_by_user_id, verification_note, expires_at
       ) VALUES ($1, $2, 'activate', $3, $4, $5, $6, $7)
       RETURNING id::text AS id`,
      [
        input.patientId,
        tokenHash,
        input.deliveryChannel,
        phoneFingerprint,
        access.userId,
        note || null,
        expiresAt.toISOString(),
      ],
    );
    tokenId = Number(insertedToken.id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    const pgCode = (error as { code?: string } | null)?.code;
    if (pgCode === "23505") {
      return {
        ok: false,
        status: 409,
        code: "username_taken",
        message: "اسم المستخدم مستخدم بالفعل لمريض آخر.",
      };
    }
    throw error;
  } finally {
    client.release();
  }

  const actionUrl = buildPortalActionUrl(input.baseOrigin, "activate", rawToken);

  if (input.deliveryChannel !== "in_person") {
    const bodyText =
      `مرحباً ${patient.fullName}، تم تفعيل حسابكم في بوابة المريض بمركز عقلان.\n` +
      `اسم المستخدم: ${normalizedLogin}\n` +
      `لتعيين كلمة المرور الخاصة بكم (الرابط صالح لمدة 60 دقيقة ويُستخدم مرة واحدة فقط):\n` +
      `${actionUrl}`;
    const delivery = await sendOutbound(
      {
        channel: input.deliveryChannel,
        purpose: "portal_auth",
        patientId: patient.id,
        to: patient.phone!,
        body: bodyText,
        redactedLogBody: `[رابط تفعيل بوابة المريض محجوب أمنيًا — اسم المستخدم: ${normalizedLogin}]`,
        actor: access.username,
      },
      buildPortalOutboundDeps(sendOptions),
    );
    if (!delivery.ok) {
      await pool.query(
        `UPDATE patient_portal_tokens
            SET invalidated_at = NOW(),
                invalidation_reason = 'delivery_failed'
          WHERE id = $1 AND used_at IS NULL`,
        [tokenId],
      );
      await recordAudit({
        action: "portal.account.activate_delivery_failed",
        entity: "patient",
        entityId: patient.id,
        entityLabel: patient.fullName,
        details: {
          loginName: normalizedLogin,
          deliveryChannel: input.deliveryChannel,
          deliveryStatus: delivery.status,
          errorMessage: delivery.message,
        },
        actor: access.username,
        actorRole: access.role,
      });
      return {
        ok: false,
        status: 502,
        code: "delivery_failed",
        message:
          delivery.message ||
          "تعذّر إرسال رابط التفعيل عبر القناة المختارة؛ أُبطل الرابط تلقائيًا.",
      };
    }
  }

  await recordAudit({
    action: "portal.account.activate_issued",
    entity: "patient",
    entityId: patient.id,
    entityLabel: patient.fullName,
    details: {
      loginName: normalizedLogin,
      deliveryChannel: input.deliveryChannel,
      expiresAt: expiresAt.toISOString(),
      ...(note ? { verificationNote: note } : {}),
    },
    actor: access.username,
    actorRole: access.role,
  });

  return {
    ok: true,
    status: 200,
    message:
      input.deliveryChannel === "in_person"
        ? "أُصدر رابط التفعيل الحضوري أحادي الاستخدام (صالح لمدة 60 دقيقة)."
        : "أُرسل رابط تفعيل البوابة أحادي الاستخدام إلى هاتف المريض المسجّل.",
    loginName: normalizedLogin,
    expiresAt: expiresAt.toISOString(),
    deliveryChannel: input.deliveryChannel,
    ...(input.deliveryChannel === "in_person" ? { inPersonUrl: actionUrl } : {}),
  };
}

export async function issuePortalPasswordReset(
  input: {
    actorSession: SessionPayload;
    patientId: number;
    deliveryChannel: PortalDeliveryChannel;
    /** للهاتف المسجّل عند الإرسال الهاتفي المعتاد عبر واتساب/SMS — يجب أن يطابق هاتف الملف بعد تحقق الموظف. */
    verifiedPhone?: string | null;
    /** عند حضور المريض شخصيًا والتحقق من هويته، يمكن تحديث وسيلة التواصل وإرسال الرابط المؤقت أحادي الاستخدام إليها أو تسليمه حضوريًا. */
    inPersonVerified?: boolean;
    updatedPhone?: string | null;
    verificationNote?: string | null;
    baseOrigin: string;
  },
  sendOptions?: PortalOutboundOptions,
): Promise<PortalIssueLinkResult> {
  const access = await getPortalStaffAccess(input.actorSession.userId);
  if (!access || !access.isActive) {
    return { ok: false, status: 401, message: "انتهت الجلسة." };
  }
  if (!access.canManagePortal) {
    return { ok: false, status: 403, message: "غير مصرّح لك بإصدار روابط استعادة بوابة المرضى." };
  }
  if (!(await canAccessPatient(input.actorSession, input.patientId))) {
    return { ok: false, status: 403, message: "غير مصرّح لك بالوصول إلى ملف هذا المريض." };
  }

  let patient = await getPatient(input.patientId);
  if (!patient) {
    return { ok: false, status: 404, message: "ملف المريض غير موجود." };
  }

  const pool = getPool();
  const { rows: [account] } = await pool.query<{
    login_name: string;
    status: PortalAccountStatus;
  }>(
    `SELECT login_name, status FROM patient_portal_accounts WHERE patient_id = $1`,
    [input.patientId],
  );
  if (!account) {
    return {
      ok: false,
      status: 404,
      code: "not_activated",
      message: "لم يُفعَّل حساب بوابة لهذا المريض بعد. ابدأ بتفعيل الحساب أولًا.",
    };
  }
  if (account.status === "disabled") {
    return {
      ok: false,
      status: 409,
      code: "account_disabled",
      message: "حساب البوابة معطّل حاليًا. أعد تمكين الحساب أولًا.",
    };
  }

  if (
    input.deliveryChannel !== "whatsapp" &&
    input.deliveryChannel !== "sms" &&
    input.deliveryChannel !== "in_person"
  ) {
    return { ok: false, status: 400, message: "وسيلة إرسال الاستعادة غير صالحة." };
  }

  const note = typeof input.verificationNote === "string" ? input.verificationNote.trim().slice(0, 500) : "";
  const isInPersonFlow = Boolean(input.inPersonVerified) || input.deliveryChannel === "in_person";
  let contactPhoneUpdated = false;

  let purpose: PortalTokenPurpose;
  let ttlMs: number;
  if (isInPersonFlow) {
    if (note.length < 8) {
      return {
        ok: false,
        status: 400,
        message: "مسار التحقق الحضوري عند فقد وسيلة الاتصال يتطلّب توثيق طريقة التحقق من هوية المريض (8 أحرف على الأقل).",
      };
    }
    const trimmedUpdatedPhone =
      typeof input.updatedPhone === "string" ? input.updatedPhone.trim() : "";
    if (trimmedUpdatedPhone.length > 0) {
      if (trimmedUpdatedPhone.replace(/\D/g, "").length < 9) {
        return {
          ok: false,
          status: 400,
          code: "invalid_phone",
          message: "رقم الهاتف المحدّث غير صالح (يجب أن يتضمّن 9 أرقام على الأقل).",
        };
      }
      const updated = await updatePatient(input.patientId, { phone: trimmedUpdatedPhone });
      if (!updated) {
        return { ok: false, status: 404, message: "ملف المريض غير موجود." };
      }
      patient = updated;
      contactPhoneUpdated = true;
    }
    if (
      input.deliveryChannel !== "in_person" &&
      (!patient.phone || patient.phone.replace(/\D/g, "").length < 9)
    ) {
      return {
        ok: false,
        status: 400,
        message: "أدخل رقم تواصل صالحًا لتحديث وسيلة التواصل قبل إرسال الرابط المؤقت عبر واتساب أو SMS.",
      };
    }
    purpose = "in_person_reset";
    ttlMs =
      input.deliveryChannel === "in_person" ? PORTAL_IN_PERSON_RESET_TTL_MS : PORTAL_RESET_TTL_MS;
  } else {
    if (!patient.phone || patient.phone.replace(/\D/g, "").length < 9) {
      return {
        ok: false,
        status: 400,
        message: "لا يوجد رقم هاتف صالح مسجّل في ملف المريض. استعمل مسار التحقق الحضوري وتحديث وسيلة التواصل.",
      };
    }
    const givenPhone = typeof input.verifiedPhone === "string" ? input.verifiedPhone.trim() : "";
    if (!givenPhone || !samePhone(patient.phone, givenPhone)) {
      return {
        ok: false,
        status: 400,
        code: "phone_mismatch",
        message: "يجب تأكيد رقم الهاتف المسجّل في ملف المريض بعد التحقق من هويته قبل إرسال رابط الاستعادة.",
      };
    }
    if (note.length < 5) {
      return {
        ok: false,
        status: 400,
        message: "وثّق بإيجاز التحقق من هوية المريض قبل إرسال رابط إعادة التعيين (5 أحرف على الأقل).",
      };
    }
    purpose = "reset";
    ttlMs = PORTAL_RESET_TTL_MS;
  }

  const { rawToken, tokenHash } = generatePortalActionToken();
  const expiresAt = new Date(Date.now() + ttlMs);
  const phoneFingerprint = portalPhoneFingerprint(patient.phone);

  const client = await pool.connect();
  let tokenId = 0;
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE patient_portal_tokens
          SET invalidated_at = NOW(),
              invalidation_reason = 'superseded'
        WHERE patient_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
      [input.patientId],
    );
    const { rows: [inserted] } = await client.query<{ id: string }>(
      `INSERT INTO patient_portal_tokens (
         patient_id, token_hash, purpose, delivery_channel, phone_fingerprint,
         issued_by_user_id, verification_note, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id::text AS id`,
      [
        input.patientId,
        tokenHash,
        purpose,
        input.deliveryChannel,
        phoneFingerprint,
        access.userId,
        note,
        expiresAt.toISOString(),
      ],
    );
    tokenId = Number(inserted.id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const actionUrl = buildPortalActionUrl(input.baseOrigin, "reset", rawToken);

  if (input.deliveryChannel !== "in_person") {
    const bodyText =
      `مرحباً ${patient.fullName}، بناءً على طلبكم بعد التحقق من هويتكم في مركز عقلان:\n` +
      `اسم المستخدم: ${account.login_name}\n` +
      `رابط إعادة تعيين كلمة المرور (صالح لمدة 30 دقيقة ويُستخدم مرة واحدة فقط):\n` +
      `${actionUrl}`;
    const delivery = await sendOutbound(
      {
        channel: input.deliveryChannel,
        purpose: "portal_auth",
        patientId: patient.id,
        to: patient.phone!,
        body: bodyText,
        redactedLogBody: `[رابط استعادة كلمة مرور البوابة محجوب أمنيًا — اسم المستخدم: ${account.login_name}]`,
        actor: access.username,
      },
      buildPortalOutboundDeps(sendOptions),
    );
    if (!delivery.ok) {
      await pool.query(
        `UPDATE patient_portal_tokens
            SET invalidated_at = NOW(),
                invalidation_reason = 'delivery_failed'
          WHERE id = $1 AND used_at IS NULL`,
        [tokenId],
      );
      await recordAudit({
        action: "portal.account.reset_delivery_failed",
        entity: "patient",
        entityId: patient.id,
        entityLabel: patient.fullName,
        details: {
          loginName: account.login_name,
          deliveryChannel: input.deliveryChannel,
          deliveryStatus: delivery.status,
          errorMessage: delivery.message,
        },
        actor: access.username,
        actorRole: access.role,
      });
      return {
        ok: false,
        status: 502,
        code: "delivery_failed",
        message:
          delivery.message ||
          "تعذّر إرسال رابط إعادة التعيين؛ أُبطل الرابط تلقائيًا.",
      };
    }
  }

  await recordAudit({
    action:
      purpose === "in_person_reset"
        ? "portal.account.in_person_reset_issued"
        : "portal.account.reset_issued",
    entity: "patient",
    entityId: patient.id,
    entityLabel: patient.fullName,
    details: {
      loginName: account.login_name,
      purpose,
      deliveryChannel: input.deliveryChannel,
      contactPhoneUpdated,
      expiresAt: expiresAt.toISOString(),
      verificationNote: note,
    },
    actor: access.username,
    actorRole: access.role,
  });

  return {
    ok: true,
    status: 200,
    message:
      input.deliveryChannel === "in_person"
        ? "أُصدر رابط الاستعادة الحضوري أحادي الاستخدام (صالح لمدة 15 دقيقة)."
        : "أُرسل رابط إعادة تعيين كلمة المرور المؤقت أحادي الاستخدام إلى هاتف المريض المسجّل.",
    loginName: account.login_name,
    expiresAt: expiresAt.toISOString(),
    deliveryChannel: input.deliveryChannel,
    ...(input.deliveryChannel === "in_person" ? { inPersonUrl: actionUrl } : {}),
  };
}

export async function setPortalAccountStatusByStaff(input: {
  actorSession: SessionPayload;
  patientId: number;
  action: "disable" | "enable" | "revoke_sessions";
  reason?: string | null;
}): Promise<{ ok: true; message: string } | { ok: false; status: number; message: string }> {
  const access = await getPortalStaffAccess(input.actorSession.userId);
  if (!access || !access.isActive) return { ok: false, status: 401, message: "انتهت الجلسة." };
  if (!access.canManagePortal) {
    return { ok: false, status: 403, message: "غير مصرّح لك بإدارة حساب بوابة هذا المريض." };
  }
  if (!(await canAccessPatient(input.actorSession, input.patientId))) {
    return { ok: false, status: 403, message: "غير مصرّح لك بالوصول إلى ملف هذا المريض." };
  }

  const pool = getPool();
  const { rows: [account] } = await pool.query<{
    login_name: string;
    status: PortalAccountStatus;
    password_hash: string | null;
  }>(
    `SELECT login_name, status, password_hash FROM patient_portal_accounts WHERE patient_id = $1`,
    [input.patientId],
  );
  if (!account) {
    return { ok: false, status: 404, message: "لا يوجد حساب بوابة لهذا المريض." };
  }

  const cleanReason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) || null : null;

  if (input.action === "disable") {
    await pool.query(
      `UPDATE patient_portal_accounts
          SET status = 'disabled',
              credential_version = credential_version + 1,
              sessions_revoked_at = NOW(),
              disabled_at = NOW(),
              disabled_by_user_id = $2,
              disabled_reason = $3,
              updated_at = NOW()
        WHERE patient_id = $1`,
      [input.patientId, access.userId, cleanReason],
    );
    await pool.query(
      `UPDATE patient_portal_tokens
          SET invalidated_at = COALESCE(invalidated_at, NOW()),
              invalidation_reason = COALESCE(invalidation_reason, 'account_disabled')
        WHERE patient_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
      [input.patientId],
    );
    await recordAudit({
      action: "portal.account.disabled",
      entity: "patient",
      entityId: input.patientId,
      details: { loginName: account.login_name, ...(cleanReason ? { reason: cleanReason } : {}) },
      actor: access.username,
      actorRole: access.role,
    });
    return { ok: true, message: "عُطّل حساب البوابة وأُبطلت جميع جلساته وروابطه المفتوحة." };
  }

  if (input.action === "enable") {
    const nextStatus: PortalAccountStatus = account.password_hash ? "active" : "pending_activation";
    await pool.query(
      `UPDATE patient_portal_accounts
          SET status = $2,
              disabled_at = NULL,
              disabled_by_user_id = NULL,
              disabled_reason = NULL,
              updated_at = NOW()
        WHERE patient_id = $1`,
      [input.patientId, nextStatus],
    );
    await recordAudit({
      action: "portal.account.enabled",
      entity: "patient",
      entityId: input.patientId,
      details: { loginName: account.login_name, nextStatus },
      actor: access.username,
      actorRole: access.role,
    });
    return { ok: true, message: "أُعيد تمكين حساب البوابة." };
  }

  await pool.query(
    `UPDATE patient_portal_accounts
        SET credential_version = credential_version + 1,
            sessions_revoked_at = NOW(),
            updated_at = NOW()
      WHERE patient_id = $1`,
    [input.patientId],
  );
  await recordAudit({
    action: "portal.account.sessions_revoked",
    entity: "patient",
    entityId: input.patientId,
    details: { loginName: account.login_name, ...(cleanReason ? { reason: cleanReason } : {}) },
    actor: access.username,
    actorRole: access.role,
  });
  return { ok: true, message: "أُبطلت جميع جلسات البوابة السابقة لهذا المريض فورًا." };
}

export async function inspectPortalActionToken(rawToken: string): Promise<
  | {
      ok: true;
      mode: "activate" | "reset";
      loginName: string;
      patientFirstName: string;
      expiresAt: string;
    }
  | { ok: false; status: number; message: string }
> {
  if (typeof rawToken !== "string" || rawToken.trim().length < 20 || rawToken.length > 200) {
    return { ok: false, status: 400, message: "الرابط غير صالح أو منتهي الصلاحية." };
  }
  await ensureSchema();
  const tokenHash = hashPortalActionToken(rawToken);
  const { rows: [row] } = await getPool().query<{
    purpose: PortalTokenPurpose;
    delivery_channel: PortalDeliveryChannel;
    phone_fingerprint: string | null;
    expires_at: Date;
    used_at: Date | null;
    invalidated_at: Date | null;
    login_name: string;
    account_status: PortalAccountStatus;
    full_name: string;
    phone: string | null;
  }>(
    `SELECT t.purpose, t.delivery_channel, t.phone_fingerprint, t.expires_at, t.used_at, t.invalidated_at,
            a.login_name, a.status AS account_status, p.full_name, p.phone
       FROM patient_portal_tokens t
       JOIN patient_portal_accounts a ON a.patient_id = t.patient_id
       JOIN patients p ON p.id = t.patient_id
      WHERE t.token_hash = $1
      LIMIT 1`,
    [tokenHash],
  );

  if (!row || row.used_at || row.invalidated_at || row.expires_at.getTime() <= Date.now()) {
    return { ok: false, status: 410, message: "انتهت صلاحية هذا الرابط أو استُخدم مسبقًا. راجع الاستقبال لإصدار رابط جديد." };
  }
  if (row.account_status === "disabled") {
    return { ok: false, status: 403, message: "حساب البوابة معطّل. راجع إدارة العيادة." };
  }
  if (
    row.delivery_channel !== "in_person" &&
    row.phone_fingerprint &&
    portalPhoneFingerprint(row.phone) !== row.phone_fingerprint
  ) {
    return { ok: false, status: 410, message: "تغيّر رقم الهاتف المسجّل بعد إصدار الرابط؛ أُبطل الرابط لحماية حسابك." };
  }

  return {
    ok: true,
    mode: row.purpose === "activate" ? "activate" : "reset",
    loginName: row.login_name,
    patientFirstName: row.full_name.trim().split(/\s+/)[0] || "المريض",
    expiresAt: row.expires_at.toISOString(),
  };
}

export async function redeemPortalActionToken(input: {
  rawToken: string;
  expectedMode: "activate" | "reset";
  newPassword: string;
}): Promise<
  | {
      ok: true;
      patientId: number;
      patientNumber: string;
      fullName: string;
      loginName: string;
      credentialVersion: number;
      phoneFingerprint: string | null;
    }
  | { ok: false; status: number; code: string; message: string }
> {
  if (typeof input.rawToken !== "string" || input.rawToken.trim().length < 20 || input.rawToken.length > 200) {
    return { ok: false, status: 400, code: "invalid_token", message: "الرابط غير صالح." };
  }

  const basicPasswordCheck = validatePortalPasswordChoice(input.newPassword);
  if (!basicPasswordCheck.ok) {
    return { ok: false, status: 400, code: "weak_password", message: basicPasswordCheck.message };
  }

  await ensureSchema();
  const tokenHash = hashPortalActionToken(input.rawToken);
  const allowedPurposes: PortalTokenPurpose[] =
    input.expectedMode === "activate" ? ["activate"] : ["reset", "in_person_reset"];

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // استهلاك ذرّي أحادي الاستخدام: طلبان متزامنان بنفس الرمز يفوز أحدهما فقط ويرى الآخر 0 صفوف.
    const { rows: [claimed] } = await client.query<{
      id: string;
      patient_id: number;
      purpose: PortalTokenPurpose;
      delivery_channel: PortalDeliveryChannel;
      phone_fingerprint: string | null;
    }>(
      `UPDATE patient_portal_tokens
          SET used_at = NOW()
        WHERE token_hash = $1
          AND purpose = ANY($2::text[])
          AND used_at IS NULL
          AND invalidated_at IS NULL
          AND expires_at > NOW()
        RETURNING id::text AS id, patient_id, purpose, delivery_channel, phone_fingerprint`,
      [tokenHash, allowedPurposes],
    );

    if (!claimed) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 410,
        code: "token_expired_or_used",
        message: "انتهت صلاحية هذا الرابط أو سبق استخدامه. اطلب رابطًا جديدًا من العيادة.",
      };
    }

    const { rows: [accountRow] } = await client.query<{
      login_name: string;
      status: PortalAccountStatus;
      patient_number: string;
      full_name: string;
      phone: string | null;
    }>(
      `SELECT a.login_name, a.status, p.patient_number, p.full_name, p.phone
         FROM patient_portal_accounts a
         JOIN patients p ON p.id = a.patient_id
        WHERE a.patient_id = $1
        FOR UPDATE`,
      [claimed.patient_id],
    );

    if (!accountRow || accountRow.status === "disabled") {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 403,
        code: "account_disabled",
        message: "حساب البوابة غير متاح حاليًا. راجع الاستقبال.",
      };
    }

    const withLoginCheck = validatePortalPasswordChoice(input.newPassword, accountRow.login_name);
    if (!withLoginCheck.ok) {
      await client.query("ROLLBACK");
      return { ok: false, status: 400, code: "weak_password", message: withLoginCheck.message };
    }

    const currentPhoneFingerprint = portalPhoneFingerprint(accountRow.phone);
    if (
      claimed.delivery_channel !== "in_person" &&
      claimed.phone_fingerprint &&
      currentPhoneFingerprint !== claimed.phone_fingerprint
    ) {
      await client.query("ROLLBACK");
      await pool.query(
        `UPDATE patient_portal_tokens
            SET invalidated_at = COALESCE(invalidated_at, NOW()),
                invalidation_reason = 'phone_changed'
          WHERE id = $1`,
        [Number(claimed.id)],
      );
      return {
        ok: false,
        status: 410,
        code: "phone_changed",
        message: "تغيّر رقم الهاتف المسجّل في ملفك؛ أُبطل الرابط السابق لحماية حسابك.",
      };
    }

    const newPasswordHash = await hashPassword(withLoginCheck.value);

    const { rows: [updatedAccount] } = await client.query<{ credential_version: number }>(
      `UPDATE patient_portal_accounts
          SET password_hash = $2,
              status = 'active',
              credential_version = credential_version + 1,
              sessions_revoked_at = NOW(),
              phone_fingerprint = $3,
              activated_at = COALESCE(activated_at, NOW()),
              password_updated_at = NOW(),
              last_login_at = NOW(),
              updated_at = NOW()
        WHERE patient_id = $1
        RETURNING credential_version`,
      [claimed.patient_id, newPasswordHash, currentPhoneFingerprint],
    );

    await client.query(
      `UPDATE patient_portal_tokens
          SET invalidated_at = NOW(),
              invalidation_reason = 'completed_other_token'
        WHERE patient_id = $1
          AND id <> $2
          AND used_at IS NULL
          AND invalidated_at IS NULL`,
      [claimed.patient_id, Number(claimed.id)],
    );

    await client.query("COMMIT");

    await recordAudit({
      action:
        claimed.purpose === "activate"
          ? "portal.account.activated"
          : "portal.account.password_reset",
      entity: "patient",
      entityId: claimed.patient_id,
      entityLabel: accountRow.full_name,
      details: {
        loginName: accountRow.login_name,
        purpose: claimed.purpose,
        deliveryChannel: claimed.delivery_channel,
        sessionsRevoked: true,
      },
      actor: `مريض: ${accountRow.full_name}`,
    });

    return {
      ok: true,
      patientId: claimed.patient_id,
      patientNumber: accountRow.patient_number,
      fullName: accountRow.full_name,
      loginName: accountRow.login_name,
      credentialVersion: updatedAccount.credential_version,
      phoneFingerprint: currentPhoneFingerprint,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticatePortalAccount(
  rawUsername: string,
  rawPassword: string,
): Promise<{
  patientId: number;
  patientNumber: string;
  fullName: string;
  loginName: string;
  credentialVersion: number;
  phoneFingerprint: string | null;
} | null> {
  await ensureSchema();
  const normalizedUsername = normalizePortalLoginName(rawUsername);
  if (!normalizedUsername) return null;

  const { rows: [row] } = await getPool().query<{
    patient_id: number;
    login_name: string;
    password_hash: string | null;
    status: PortalAccountStatus;
    credential_version: number;
    patient_number: string;
    full_name: string;
    phone: string | null;
  }>(
    `SELECT a.patient_id, a.login_name, a.password_hash, a.status, a.credential_version,
            p.patient_number, p.full_name, p.phone
       FROM patient_portal_accounts a
       JOIN patients p ON p.id = a.patient_id
      WHERE LOWER(a.login_name) = LOWER($1)
      LIMIT 1`,
    [normalizedUsername],
  );

  if (!row || row.status !== "active" || !row.password_hash) {
    const dummy = await getDummyPasswordHash();
    await verifyPassword(rawPassword, dummy).catch(() => false);
    return null;
  }

  const valid = await verifyPassword(rawPassword, row.password_hash);
  if (!valid) return null;

  const currentPhoneFingerprint = portalPhoneFingerprint(row.phone);
  await getPool().query(
    `UPDATE patient_portal_accounts
        SET last_login_at = NOW(),
            phone_fingerprint = $2
      WHERE patient_id = $1`,
    [row.patient_id, currentPhoneFingerprint],
  );

  return {
    patientId: row.patient_id,
    patientNumber: row.patient_number,
    fullName: row.full_name,
    loginName: row.login_name,
    credentialVersion: row.credential_version,
    phoneFingerprint: currentPhoneFingerprint,
  };
}

export async function revokePortalSessionByPatient(patientId: number): Promise<void> {
  if (!Number.isInteger(patientId) || patientId <= 0) return;
  await ensureSchema();
  await getPool().query(
    `UPDATE patient_portal_accounts
        SET credential_version = credential_version + 1,
            sessions_revoked_at = NOW(),
            updated_at = NOW()
      WHERE patient_id = $1`,
    [patientId],
  );
}

/**
 * تحقق حي على الخادم من جلسة بوابة المريض في كل طلب:
 * - يرفض أي كوكي قديم بلا `credentialVersion` أو `issuedAt`.
 * - يتحقق من وجود المريض وحساب البوابة النشط ومطابقة `credential_version` وعدم إبطال الجلسات بعد `issuedAt`.
 * - يتحقق من عدم تغيّر بصمة الهاتف المسجّل بعد إصدار الجلسة.
 */
export async function verifyLivePortalPatientSession(payload: {
  patientId: number;
  credentialVersion?: number;
  issuedAt?: number;
  phoneFingerprint?: string | null;
}): Promise<{ patientId: number; patientNumber: string; fullName: string } | null> {
  if (
    typeof payload.credentialVersion !== "number" ||
    !Number.isInteger(payload.credentialVersion) ||
    typeof payload.issuedAt !== "number"
  ) {
    return null;
  }
  await ensureSchema();
  const { rows: [row] } = await getPool().query<{
    patient_id: number;
    status: PortalAccountStatus;
    credential_version: number;
    sessions_revoked_at: Date | null;
    patient_number: string;
    full_name: string;
    phone: string | null;
  }>(
    `SELECT a.patient_id, a.status, a.credential_version, a.sessions_revoked_at,
            p.patient_number, p.full_name, p.phone
       FROM patient_portal_accounts a
       JOIN patients p ON p.id = a.patient_id
      WHERE a.patient_id = $1
      LIMIT 1`,
    [payload.patientId],
  );
  if (!row) return null;
  if (row.status !== "active") return null;
  if (row.credential_version !== payload.credentialVersion) return null;
  if (row.sessions_revoked_at && row.sessions_revoked_at.getTime() > payload.issuedAt) {
    return null;
  }
  const livePhoneFingerprint = portalPhoneFingerprint(row.phone);
  if ((payload.phoneFingerprint ?? null) !== livePhoneFingerprint) {
    return null;
  }
  return {
    patientId: row.patient_id,
    patientNumber: row.patient_number,
    fullName: row.full_name,
  };
}

export interface PortalMigrationReadinessSummary {
  totalPatients: number;
  portalAccountsTotal: number;
  activeAccounts: number;
  pendingAccounts: number;
  disabledAccounts: number;
  legacyLoginsLast7Days: number;
}

/** استعلام قراءة فقط آمن (بلا بيانات مرضى) للتحقق من الجاهزية والبيانات بعد الحذف النهائي للدخول القديم. */
export async function getPortalMigrationReadinessSummary(): Promise<PortalMigrationReadinessSummary> {
  await ensureSchema();
  const { rows: [row] } = await getPool().query<{
    total_patients: number;
    total_accounts: number;
    active_accounts: number;
    pending_accounts: number;
    disabled_accounts: number;
    legacy_logins_7d: number;
  }>(
    `SELECT (SELECT COUNT(*)::int FROM patients) AS total_patients,
            (SELECT COUNT(*)::int FROM patient_portal_accounts) AS total_accounts,
            (SELECT COUNT(*)::int FROM patient_portal_accounts WHERE status = 'active') AS active_accounts,
            (SELECT COUNT(*)::int FROM patient_portal_accounts WHERE status = 'pending_activation') AS pending_accounts,
            (SELECT COUNT(*)::int FROM patient_portal_accounts WHERE status = 'disabled') AS disabled_accounts,
            (SELECT COUNT(*)::int FROM audit_log
              WHERE action = 'portal.login'
                AND details ->> 'ok' = 'true'
                AND created_at >= NOW() - INTERVAL '7 days') AS legacy_logins_7d`,
  );
  return {
    totalPatients: row?.total_patients ?? 0,
    portalAccountsTotal: row?.total_accounts ?? 0,
    activeAccounts: row?.active_accounts ?? 0,
    pendingAccounts: row?.pending_accounts ?? 0,
    disabledAccounts: row?.disabled_accounts ?? 0,
    legacyLoginsLast7Days: row?.legacy_logins_7d ?? 0,
  };
}
