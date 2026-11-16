import { createHash, randomBytes } from "node:crypto";
import { hashPassword, verifyPassword, type SessionPayload } from "./auth";
import {
  doctorOwnsPatient,
  ensureSchema,
  getPatient,
  getPool,
  messagingChannelWithSecret,
  phoneLookupForms,
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
import {
  canPerformOwnerOperation,
  hasStaffCapability,
  patientCapabilityConstraint,
  type ResolvedStaffAccess,
} from "./staff-capabilities";
import { reviewLegacyStaffCapabilities } from "./staff-capabilities-legacy";
import { inspectStaffPortalAuthority } from "./portal-staff-authority";
import {
  readPortalSettings,
  type PortalOperatingMode,
  type PortalPostMergeTargetPolicy,
  type PortalRecoveryPhonePolicy,
  type PortalSettingsConfig,
} from "./portal-settings";

export type {
  PortalOperatingMode,
  PortalPostMergeTargetPolicy,
  PortalRecoveryPhonePolicy,
};

/**
 * (0127_patient_portal_security) خدمات أمان بوابة المريض — التفعيل من الطاقم المخوّل، وروابط التفعيل/الاستعادة
 * المؤقتة أحادية الاستخدام، وإبطال الجلسات الفوري، وصلاحيات «عرض بوابة المريض» المستقلة.
 *
 * قواعد صارمة:
 * - لا تُخزَّن كلمة المرور الأصلية أو الرمز الخام أو الرابط في القاعدة أو `audit_log` أو `message_deliveries` أو السجلات.
 * - تجزئة كلمات المرور عبر `scrypt` (`hashPassword` / `verifyPassword`)، وتجزئة الرموز عبر `SHA-256`.
 * - مسار الدخول القديم برقم الملف والهاتف محذوف نهائيًا بلا أي استثناء طوارئ؛ وتُعتمد الاستعادة الحضورية الآمنة برابط مؤقت أحادي الاستخدام، مع إبقاء التفعيل وسياسات تغيير الهاتف ومدد الروابط وتعليق الحساب بعد الدمج معطّلة افتراضيًا حتى تُحسم من المالك.
 * - هوية المالك (`isOwner`) تُقرأ حصريًا من مصدر السلطة القانونية المعتمد (`lib/portal-staff-authority.ts`) ولا تُخزَّن أو تُستنتج في جدول صلاحيات البوابة.
 */

/** القيم الاسترشادية الأولية لمدد الروابط (غير معتمدة نهائيًا بعد من المالك؛ التفعيل معطّل افتراضيًا حتى تُحسم). */
export const PORTAL_ACTIVATION_TTL_MS = 60 * 60 * 1000; // 60 دقيقة (قيمة أولية مقترحة)
export const PORTAL_RESET_TTL_MS = 30 * 60 * 1000; // 30 دقيقة (قيمة أولية مقترحة)
export const PORTAL_IN_PERSON_RESET_TTL_MS = 15 * 60 * 1000; // 15 دقيقة (قيمة أولية مقترحة)

export interface PortalTokenTtlConfig {
  activationMinutes: number;
  resetMinutes: number;
  inPersonResetMinutes: number;
  activationMs: number;
  resetMs: number;
  inPersonResetMs: number;
  policyStatus: "owner_configured" | "provisional_pending_owner_decision";
}

function parseBoundedMinutes(raw: string | undefined, fallbackMinutes: number): {
  minutes: number;
  explicit: boolean;
} {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { minutes: fallbackMinutes, explicit: false };
  }
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 5 || parsed > 1440) {
    return { minutes: fallbackMinutes, explicit: false };
  }
  return { minutes: parsed, explicit: true };
}

/**
 * قراءة تزامنية من متغيرات البيئة (تُستعمل كاحتياطي سريع؛ الفحص التشغيلي الفعلي يقرأ إعدادات القاعدة `readPortalSettings()`).
 */
export function isPatientPortalActivationEnabled(): boolean {
  return process.env.PATIENT_PORTAL_ACTIVATION_ENABLED?.trim() === "true";
}

export function getPortalRecoveryPhonePolicy(): PortalRecoveryPhonePolicy {
  const raw = process.env.PORTAL_RECOVERY_PHONE_POLICY?.trim();
  if (
    raw === "owner_only" ||
    raw === "admin_or_owner_only" ||
    raw === "portal_manager_in_person"
  ) {
    return raw;
  }
  return "disallow_inline";
}

export function getPortalPostMergeTargetPolicy(): PortalPostMergeTargetPolicy {
  const raw = process.env.PORTAL_POST_MERGE_TARGET_POLICY?.trim();
  if (raw === "keep_target_revoke_sessions" || raw === "suspend_on_conflict_or_dual") {
    return raw;
  }
  return "suspend_target";
}

export function getPortalTokenTtlConfig(): PortalTokenTtlConfig {
  const act = parseBoundedMinutes(process.env.PORTAL_ACTIVATION_TTL_MINUTES, 60);
  const rst = parseBoundedMinutes(process.env.PORTAL_RESET_TTL_MINUTES, 30);
  const inp = parseBoundedMinutes(process.env.PORTAL_IN_PERSON_RESET_TTL_MINUTES, 15);
  return {
    activationMinutes: act.minutes,
    resetMinutes: rst.minutes,
    inPersonResetMinutes: inp.minutes,
    activationMs: act.minutes * 60 * 1000,
    resetMs: rst.minutes * 60 * 1000,
    inPersonResetMs: inp.minutes * 60 * 1000,
    policyStatus:
      act.explicit && rst.explicit && inp.explicit
        ? "owner_configured"
        : "provisional_pending_owner_decision",
  };
}

export interface PortalPolicyConfigurationSummary {
  operatingMode: PortalOperatingMode;
  activationEnabled: boolean;
  allowWhatsappChannel: boolean;
  allowSmsChannel: boolean;
  allowInPersonChannel: boolean;
  recoveryPhonePolicy: PortalRecoveryPhonePolicy;
  postMergeTargetPolicy: PortalPostMergeTargetPolicy;
  tokenTtls: Omit<PortalTokenTtlConfig, "activationMs" | "resetMs" | "inPersonResetMs">;
}

export function getPortalPolicyConfigurationSummary(
  dbSettings?: PortalSettingsConfig,
): PortalPolicyConfigurationSummary {
  if (dbSettings) {
    return {
      operatingMode: dbSettings.effectiveOperatingMode,
      activationEnabled: dbSettings.effectiveOperatingMode !== "disabled",
      allowWhatsappChannel: dbSettings.allowWhatsappChannel,
      allowSmsChannel: dbSettings.allowSmsChannel,
      allowInPersonChannel: dbSettings.allowInPersonChannel,
      recoveryPhonePolicy: dbSettings.recoveryPhonePolicy,
      postMergeTargetPolicy: dbSettings.postMergeTargetPolicy,
      tokenTtls: {
        activationMinutes: dbSettings.activationTtlMinutes,
        resetMinutes: dbSettings.resetTtlMinutes,
        inPersonResetMinutes: dbSettings.inPersonResetTtlMinutes,
        policyStatus: dbSettings.updatedAt ? "owner_configured" : "provisional_pending_owner_decision",
      },
    };
  }
  const ttls = getPortalTokenTtlConfig();
  const actEnabled = isPatientPortalActivationEnabled();
  return {
    operatingMode: actEnabled ? "sandbox_test" : "disabled",
    activationEnabled: actEnabled,
    allowWhatsappChannel: true,
    allowSmsChannel: true,
    allowInPersonChannel: true,
    recoveryPhonePolicy: getPortalRecoveryPhonePolicy(),
    postMergeTargetPolicy: getPortalPostMergeTargetPolicy(),
    tokenTtls: {
      activationMinutes: ttls.activationMinutes,
      resetMinutes: ttls.resetMinutes,
      inPersonResetMinutes: ttls.inPersonResetMinutes,
      policyStatus: ttls.policyStatus,
    },
  };
}

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
  canConfigurePortalSettings: boolean;
  canManagePortal: boolean;
  canIssueActivation: boolean;
  canIssueReset: boolean;
  canChangeRecoveryPhone: boolean;
  canPreviewPortal: boolean;
  canManagePortalAnnouncements: boolean;
  canInspectRetainedMessages: boolean;
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
  failedLoginAttempts: number;
  isLocked: boolean;
  lockedUntil: string | null;
  hasPendingToken: boolean;
  pendingTokenPurpose: PortalTokenPurpose | null;
  pendingTokenExpiresAt: string | null;
  pendingTokenChannel: PortalDeliveryChannel | null;
  hasSharedFamilyPhone: boolean;
  sharedPhonePatientsCount: number;
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

interface EvaluatedPortalStaffAuthority {
  access: PortalStaffAccess;
  rawCanConfigureSettingsGrant: boolean;
  rawCanManageGrant: boolean;
  rawCanIssueActivationGrant: boolean | null;
  rawCanIssueResetGrant: boolean | null;
  rawCanChangeRecoveryPhoneGrant: boolean | null;
  rawCanPreviewGrant: boolean;
  rawCanManageAnnouncementsGrant: boolean;
  canManageStaffGrants: boolean;
  canonicalAccess: ResolvedStaffAccess | null;
  note: string | null;
  updatedAt: string | null;
}

function isPortalClinicRole(role: string): boolean {
  return role === "admin" || role === "reception" || role === "doctor";
}

function emptyInactivePortalAccess(row: {
  id: number;
  username: string;
  display_name: string;
  role: string;
  is_active: boolean;
}): PortalStaffAccess {
  return {
    userId: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active,
    isOwner: false,
    canConfigurePortalSettings: false,
    canManagePortal: false,
    canIssueActivation: false,
    canIssueReset: false,
    canChangeRecoveryPhone: false,
    canPreviewPortal: false,
    canManagePortalAnnouncements: false,
    canInspectRetainedMessages: false,
  };
}

interface StaffGrantQueryRow {
  id: number;
  username: string;
  display_name: string;
  role: string;
  is_active: boolean;
  permissions: unknown;
  can_configure_portal_settings: boolean | null;
  can_manage_portal: boolean | null;
  can_issue_activation: boolean | null;
  can_issue_reset: boolean | null;
  can_change_recovery_phone: boolean | null;
  can_preview_portal: boolean | null;
  can_manage_portal_announcements: boolean | null;
  note: string | null;
  updated_at: Date | null;
}

const STAFF_GRANT_SELECT_SQL = `SELECT u.id,
        u.username,
        u.display_name,
        u.role,
        u.is_active,
        u.permissions,
        g.can_configure_portal_settings,
        g.can_manage_portal,
        g.can_issue_activation,
        g.can_issue_reset,
        g.can_change_recovery_phone,
        g.can_preview_portal,
        g.can_manage_portal_announcements,
        g.note,
        g.updated_at
   FROM users u
   LEFT JOIN patient_portal_staff_grants g ON g.user_id = u.id`;

async function evaluatePortalStaffAuthorityRow(
  row: StaffGrantQueryRow,
): Promise<EvaluatedPortalStaffAuthority> {
  const rawCanConfigureSettingsGrant = row.can_configure_portal_settings === true;
  const rawCanManageGrant = row.can_manage_portal === true;
  const rawCanIssueActivationGrant =
    typeof row.can_issue_activation === "boolean" ? row.can_issue_activation : null;
  const rawCanIssueResetGrant =
    typeof row.can_issue_reset === "boolean" ? row.can_issue_reset : null;
  const rawCanChangeRecoveryPhoneGrant =
    typeof row.can_change_recovery_phone === "boolean" ? row.can_change_recovery_phone : null;
  const rawCanPreviewGrant = row.can_preview_portal === true;
  const rawCanManageAnnouncementsGrant = row.can_manage_portal_announcements === true;
  const note = row.note ?? null;
  const updatedAt = row.updated_at ? row.updated_at.toISOString() : null;

  const baseRaw = {
    rawCanConfigureSettingsGrant,
    rawCanManageGrant,
    rawCanIssueActivationGrant,
    rawCanIssueResetGrant,
    rawCanChangeRecoveryPhoneGrant,
    rawCanPreviewGrant,
    rawCanManageAnnouncementsGrant,
    note,
    updatedAt,
  };

  if (!row.is_active) {
    return {
      access: emptyInactivePortalAccess(row),
      ...baseRaw,
      canManageStaffGrants: false,
      canonicalAccess: null,
    };
  }

  const inspection = await inspectStaffPortalAuthority(getPool(), row.id);
  if (inspection.mode === "canonical") {
    const canonicalAccess = inspection.ownerAuthority?.access ?? null;
    if (!canonicalAccess || canonicalAccess.status !== "allowed") {
      return {
        access: emptyInactivePortalAccess(row),
        ...baseRaw,
        canManageStaffGrants: false,
        canonicalAccess: null,
      };
    }

    const isOwner =
      row.role === "admin" &&
      canPerformOwnerOperation(canonicalAccess, "settings.security.change");
    const canEditPatients = patientCapabilityConstraint(canonicalAccess, "edit").kind !== "none";
    const canViewAllPatients = patientCapabilityConstraint(canonicalAccess, "view").kind === "all";
    const canEditStaffPerms = hasStaffCapability(canonicalAccess, "staff.permissions.edit");

    // فصل صارم: المدير العادي لا يحصل على صلاحيات تعديل إعدادات البوابة أو المعاينة تلقائيًا؛
    // يتطلّب تفويضًا صريحًا من المالك المعتمد (`can_configure_portal_settings` / `can_preview_portal`).
    const canConfigurePortalSettings =
      row.role === "admin" &&
      (isOwner || (rawCanConfigureSettingsGrant && (canViewAllPatients || canEditStaffPerms)));
    const canManagePortal =
      isPortalClinicRole(row.role) && canEditPatients && (isOwner || rawCanManageGrant);
    const canIssueActivation =
      isPortalClinicRole(row.role) &&
      canEditPatients &&
      (isOwner || (rawCanIssueActivationGrant ?? rawCanManageGrant));
    const canIssueReset =
      isPortalClinicRole(row.role) &&
      canEditPatients &&
      (isOwner || (rawCanIssueResetGrant ?? rawCanManageGrant));
    const canChangeRecoveryPhone =
      isPortalClinicRole(row.role) &&
      canEditPatients &&
      (isOwner || (rawCanChangeRecoveryPhoneGrant ?? rawCanManageGrant));
    const canPreviewPortal =
      row.role === "admin" && canViewAllPatients && (isOwner || rawCanPreviewGrant);
    const canManagePortalAnnouncements =
      (row.role === "admin" || row.role === "reception") &&
      (isOwner || rawCanManageAnnouncementsGrant);
    const canInspectRetainedMessages = row.role === "admin" && canViewAllPatients;
    const canManageStaffGrants =
      row.role === "admin" && (isOwner || canEditStaffPerms || canConfigurePortalSettings);

    return {
      access: {
        userId: row.id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        isActive: true,
        isOwner,
        canConfigurePortalSettings,
        canManagePortal,
        canIssueActivation,
        canIssueReset,
        canChangeRecoveryPhone,
        canPreviewPortal,
        canManagePortalAnnouncements,
        canInspectRetainedMessages,
      },
      ...baseRaw,
      canManageStaffGrants,
      canonicalAccess,
    };
  }

  // وضع التوافق القديم (قبل تفعيل مخطط السلطة القانونية): لا يُستنتج مالك من MIN(id) أو الدور أبدًا.
  const legacyReview = reviewLegacyStaffCapabilities(row.role, row.permissions);
  if (!legacyReview.ok) {
    return {
      access: emptyInactivePortalAccess(row),
      ...baseRaw,
      canManageStaffGrants: false,
      canonicalAccess: null,
    };
  }

  const review = legacyReview.value;
  const canEditPatients = review.patientEdit !== "none";
  const canViewAllPatients = review.patientRead === "all";
  const canEditStaffPerms = review.observedCapabilities["staff.permissions.edit"] === true;

  const canConfigurePortalSettings =
    row.role === "admin" && rawCanConfigureSettingsGrant && canEditStaffPerms;
  const canManagePortal =
    isPortalClinicRole(row.role) && canEditPatients && rawCanManageGrant;
  const canIssueActivation =
    isPortalClinicRole(row.role) &&
    canEditPatients &&
    (rawCanIssueActivationGrant ?? rawCanManageGrant);
  const canIssueReset =
    isPortalClinicRole(row.role) &&
    canEditPatients &&
    (rawCanIssueResetGrant ?? rawCanManageGrant);
  const canChangeRecoveryPhone =
    isPortalClinicRole(row.role) &&
    canEditPatients &&
    (rawCanChangeRecoveryPhoneGrant ?? rawCanManageGrant);
  const canPreviewPortal =
    row.role === "admin" && canViewAllPatients && rawCanPreviewGrant;
  const canManagePortalAnnouncements =
    (row.role === "admin" || row.role === "reception") && rawCanManageAnnouncementsGrant;
  const canInspectRetainedMessages = row.role === "admin" && canViewAllPatients;
  const canManageStaffGrants = row.role === "admin" && (canEditStaffPerms || canConfigurePortalSettings);

  return {
    access: {
      userId: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      isActive: true,
      isOwner: false,
      canConfigurePortalSettings,
      canManagePortal,
      canIssueActivation,
      canIssueReset,
      canChangeRecoveryPhone,
      canPreviewPortal,
      canManagePortalAnnouncements,
      canInspectRetainedMessages,
    },
    ...baseRaw,
    canManageStaffGrants,
    canonicalAccess: null,
  };
}

async function evaluatePortalStaffAuthority(
  userId: number,
): Promise<EvaluatedPortalStaffAuthority | null> {
  if (!Number.isInteger(userId) || userId <= 0) return null;
  await ensureSchema();
  const { rows } = await getPool().query<StaffGrantQueryRow>(
    `${STAFF_GRANT_SELECT_SQL}
      WHERE u.id = $1
      LIMIT 1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  return evaluatePortalStaffAuthorityRow(row);
}

async function canStaffActOnPatientPortal(
  authority: EvaluatedPortalStaffAuthority,
  actorSession: SessionPayload,
  patientId: number,
  featureAllowed: boolean,
): Promise<boolean> {
  if (!authority.access.isActive || !featureAllowed) return false;
  if (!(await canAccessPatient(actorSession, patientId))) return false;
  if (authority.canonicalAccess) {
    const constraint = patientCapabilityConstraint(authority.canonicalAccess, "edit");
    if (constraint.kind === "none") return false;
    if (constraint.kind === "own") {
      return doctorOwnsPatient(constraint.clinicianPartyId, patientId);
    }
  }
  return true;
}

export async function countPatientsSharingPhone(
  phone: string | null | undefined,
): Promise<number> {
  const forms = phoneLookupForms(phone);
  if (forms.length === 0) return 0;
  const { rows: [row] } = await getPool().query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM patients WHERE phone = ANY($1::text[])`,
    [forms],
  );
  return row?.c ?? 0;
}

/**
 * استخراج صلاحيات الموظف الفعلية تجاه بوابة المريض:
 * - هوية المالك (`isOwner`) تُقرأ حصريًا من مصدر السلطة القانونية المعتمد (`lib/portal-staff-authority.ts`).
 * - فصل تام بين صلاحية ضبط إعدادات البوابة (`canConfigurePortalSettings`) وصلاحيات التشغيل (`canManagePortal`، `canIssueActivation`، `canIssueReset`، إلخ).
 * - «عرض بوابة المريض» و«ضبط إعدادات البوابة» لا يُمنحان لمدير إلا بقرار صريح من المالك المعتمد.
 */
export async function getPortalStaffAccess(userId: number): Promise<PortalStaffAccess | null> {
  const evaluated = await evaluatePortalStaffAuthority(userId);
  return evaluated ? evaluated.access : null;
}

export interface PortalStaffGrantRow {
  userId: number;
  username: string;
  displayName: string;
  role: string;
  isActive: boolean;
  isOwner: boolean;
  canConfigurePortalSettings: boolean;
  canManagePortal: boolean;
  canIssueActivation: boolean;
  canIssueReset: boolean;
  canChangeRecoveryPhone: boolean;
  canPreviewPortal: boolean;
  canManagePortalAnnouncements: boolean;
  canInspectRetainedMessages: boolean;
  note: string | null;
  updatedAt: string | null;
}

export async function listPortalStaffGrants(): Promise<PortalStaffGrantRow[]> {
  await ensureSchema();
  const { rows } = await getPool().query<StaffGrantQueryRow>(
    `${STAFF_GRANT_SELECT_SQL}
      ORDER BY u.is_active DESC, u.id ASC`,
  );
  const evaluated = await Promise.all(rows.map((row) => evaluatePortalStaffAuthorityRow(row)));
  return evaluated.map((item) => ({
    userId: item.access.userId,
    username: item.access.username,
    displayName: item.access.displayName,
    role: item.access.role,
    isActive: item.access.isActive,
    isOwner: item.access.isOwner,
    canConfigurePortalSettings: item.access.canConfigurePortalSettings,
    canManagePortal: item.access.canManagePortal,
    canIssueActivation: item.access.canIssueActivation,
    canIssueReset: item.access.canIssueReset,
    canChangeRecoveryPhone: item.access.canChangeRecoveryPhone,
    canPreviewPortal: item.access.canPreviewPortal,
    canManagePortalAnnouncements: item.access.canManagePortalAnnouncements,
    canInspectRetainedMessages: item.access.canInspectRetainedMessages,
    note: item.note,
    updatedAt: item.updatedAt,
  }));
}

export async function updatePortalStaffGrant(input: {
  actorSession: SessionPayload;
  targetUserId: number;
  isOwner?: boolean;
  canConfigurePortalSettings?: boolean;
  canManagePortal: boolean;
  canIssueActivation?: boolean | null;
  canIssueReset?: boolean | null;
  canChangeRecoveryPhone?: boolean | null;
  canPreviewPortal: boolean;
  canManagePortalAnnouncements?: boolean;
  note?: string | null;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const actorAuthority = await evaluatePortalStaffAuthority(input.actorSession.userId);
  if (!actorAuthority || !actorAuthority.access.isActive) {
    return { ok: false, status: 401, message: "انتهت الجلسة." };
  }
  const actorAccess = actorAuthority.access;
  if (actorAccess.role !== "admin" || !actorAuthority.canManageStaffGrants) {
    return { ok: false, status: 403, message: "غير مصرّح لك بإدارة صلاحيات بوابة المريض." };
  }

  if (input.isOwner !== undefined) {
    return {
      ok: false,
      status: 403,
      message:
        "هوية مالك العيادة تُدار حصريًا عبر سجل سلطة الهوية القانونية المعتمد ولا تُعدَّل من جدول صلاحيات البوابة.",
    };
  }

  const targetAuthority = await evaluatePortalStaffAuthority(input.targetUserId);
  if (!targetAuthority) {
    return { ok: false, status: 404, message: "الموظف المطلوب غير موجود." };
  }
  const targetAccess = targetAuthority.access;

  const requestedConfigureSettings =
    input.canConfigurePortalSettings !== undefined
      ? Boolean(input.canConfigurePortalSettings)
      : targetAuthority.rawCanConfigureSettingsGrant;

  // منح/سحب صلاحية «عرض بوابة المريض» أو «ضبط إعدادات البوابة» أو تعديل سجل المالك محصور بالمالك المعتمد وحده.
  if (!actorAccess.isOwner) {
    if (
      targetAccess.isOwner ||
      Boolean(input.canPreviewPortal) !== targetAuthority.rawCanPreviewGrant ||
      Boolean(input.canPreviewPortal) !== targetAccess.canPreviewPortal
    ) {
      return {
        ok: false,
        status: 403,
        message: "منح أو تعديل صلاحية «عرض بوابة المريض» محصور بمالك العيادة المعتمد فقط.",
      };
    }
    if (
      requestedConfigureSettings !== targetAuthority.rawCanConfigureSettingsGrant ||
      requestedConfigureSettings !== targetAccess.canConfigurePortalSettings
    ) {
      return {
        ok: false,
        status: 403,
        message: "تفويض صلاحية «ضبط إعدادات وسياسات البوابة» لمدير آخر محصور بمالك العيادة المعتمد فقط.",
      };
    }
  }

  if (input.canPreviewPortal && targetAccess.role !== "admin") {
    return {
      ok: false,
      status: 400,
      message: "صلاحية «عرض بوابة المريض» تُمنح لحسابات الإدارة فقط.",
    };
  }

  if (requestedConfigureSettings && targetAccess.role !== "admin") {
    return {
      ok: false,
      status: 400,
      message: "صلاحية «ضبط إعدادات البوابة» تُمنح لحسابات الإدارة فقط بقرار المالك.",
    };
  }

  const anyPortalPatientOp =
    Boolean(input.canManagePortal) ||
    input.canIssueActivation === true ||
    input.canIssueReset === true ||
    input.canChangeRecoveryPhone === true;
  if (anyPortalPatientOp && !isPortalClinicRole(targetAccess.role)) {
    return {
      ok: false,
      status: 400,
      message: "صلاحية إدارة حسابات البوابة تُمنح لأدوار الإدارة أو الاستقبال أو الطبيب فقط.",
    };
  }

  const requestedManageAnnouncements =
    input.canManagePortalAnnouncements !== undefined
      ? Boolean(input.canManagePortalAnnouncements)
      : targetAuthority.rawCanManageAnnouncementsGrant;
  if (
    requestedManageAnnouncements &&
    targetAccess.role !== "admin" &&
    targetAccess.role !== "reception"
  ) {
    return {
      ok: false,
      status: 400,
      message: "صلاحية إدارة إعلانات البوابة تُمنح للإدارة أو الاستقبال فقط.",
    };
  }

  const cleanNote = typeof input.note === "string" ? input.note.trim().slice(0, 300) || null : null;
  const finalConfigure = targetAccess.isOwner ? true : requestedConfigureSettings;
  const finalManage = targetAccess.isOwner ? true : Boolean(input.canManagePortal);
  const finalIssueActivation = targetAccess.isOwner
    ? true
    : input.canIssueActivation === undefined
      ? targetAuthority.rawCanIssueActivationGrant
      : input.canIssueActivation;
  const finalIssueReset = targetAccess.isOwner
    ? true
    : input.canIssueReset === undefined
      ? targetAuthority.rawCanIssueResetGrant
      : input.canIssueReset;
  const finalChangePhone = targetAccess.isOwner
    ? true
    : input.canChangeRecoveryPhone === undefined
      ? targetAuthority.rawCanChangeRecoveryPhoneGrant
      : input.canChangeRecoveryPhone;
  const finalPreview = targetAccess.isOwner ? true : Boolean(input.canPreviewPortal);
  const finalAnnouncements = targetAccess.isOwner ? true : requestedManageAnnouncements;

  await getPool().query(
    `INSERT INTO patient_portal_staff_grants (
       user_id,
       can_configure_portal_settings,
       can_manage_portal,
       can_issue_activation,
       can_issue_reset,
       can_change_recovery_phone,
       can_preview_portal,
       can_manage_portal_announcements,
       granted_by_user_id,
       note,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       can_configure_portal_settings = EXCLUDED.can_configure_portal_settings,
       can_manage_portal = EXCLUDED.can_manage_portal,
       can_issue_activation = EXCLUDED.can_issue_activation,
       can_issue_reset = EXCLUDED.can_issue_reset,
       can_change_recovery_phone = EXCLUDED.can_change_recovery_phone,
       can_preview_portal = EXCLUDED.can_preview_portal,
       can_manage_portal_announcements = EXCLUDED.can_manage_portal_announcements,
       granted_by_user_id = EXCLUDED.granted_by_user_id,
       note = EXCLUDED.note,
       updated_at = NOW()`,
    [
      input.targetUserId,
      finalConfigure,
      finalManage,
      finalIssueActivation,
      finalIssueReset,
      finalChangePhone,
      finalPreview,
      finalAnnouncements,
      actorAccess.userId,
      cleanNote,
    ],
  );

  const refreshedTarget = await evaluatePortalStaffAuthority(input.targetUserId);

  await recordAudit({
    action: "portal.staff_grant.update",
    entity: "user",
    entityId: input.targetUserId,
    entityLabel: targetAccess.username,
    details: {
      targetRole: targetAccess.role,
      previous: {
        isOwner: targetAccess.isOwner,
        canConfigurePortalSettings: targetAccess.canConfigurePortalSettings,
        canManagePortal: targetAccess.canManagePortal,
        canIssueActivation: targetAccess.canIssueActivation,
        canIssueReset: targetAccess.canIssueReset,
        canChangeRecoveryPhone: targetAccess.canChangeRecoveryPhone,
        canPreviewPortal: targetAccess.canPreviewPortal,
        canManagePortalAnnouncements: targetAccess.canManagePortalAnnouncements,
      },
      next: {
        isOwner: refreshedTarget?.access.isOwner ?? targetAccess.isOwner,
        canConfigurePortalSettings:
          refreshedTarget?.access.canConfigurePortalSettings ?? finalConfigure,
        canManagePortal: refreshedTarget?.access.canManagePortal ?? finalManage,
        canIssueActivation:
          refreshedTarget?.access.canIssueActivation ?? Boolean(finalIssueActivation ?? finalManage),
        canIssueReset:
          refreshedTarget?.access.canIssueReset ?? Boolean(finalIssueReset ?? finalManage),
        canChangeRecoveryPhone:
          refreshedTarget?.access.canChangeRecoveryPhone ?? Boolean(finalChangePhone ?? finalManage),
        canPreviewPortal: refreshedTarget?.access.canPreviewPortal ?? finalPreview,
        canManagePortalAnnouncements:
          refreshedTarget?.access.canManagePortalAnnouncements ?? finalAnnouncements,
      },
      storedGrants: {
        canConfigurePortalSettings: finalConfigure,
        canManagePortal: finalManage,
        canIssueActivation: finalIssueActivation,
        canIssueReset: finalIssueReset,
        canChangeRecoveryPhone: finalChangePhone,
        canPreviewPortal: finalPreview,
        canManagePortalAnnouncements: finalAnnouncements,
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
  const patient = await getPatient(patientId);
  const sharedPhonePatientsCount = await countPatientsSharingPhone(patient?.phone);
  const hasSharedFamilyPhone = sharedPhonePatientsCount > 1;

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
    failed_login_attempts: number;
    locked_until: Date | null;
  }>(
    `SELECT login_name, status, credential_version, activated_at, password_updated_at,
            last_login_at, sessions_revoked_at, disabled_at, disabled_reason,
            failed_login_attempts, locked_until
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
      failedLoginAttempts: 0,
      isLocked: false,
      lockedUntil: null,
      hasPendingToken: Boolean(pendingToken),
      pendingTokenPurpose: pendingToken?.purpose ?? null,
      pendingTokenExpiresAt: pendingToken ? pendingToken.expires_at.toISOString() : null,
      pendingTokenChannel: pendingToken?.delivery_channel ?? null,
      hasSharedFamilyPhone,
      sharedPhonePatientsCount,
    };
  }

  const isLocked = Boolean(account.locked_until && account.locked_until.getTime() > Date.now());

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
    failedLoginAttempts: account.failed_login_attempts ?? 0,
    isLocked,
    lockedUntil: isLocked && account.locked_until ? account.locked_until.toISOString() : null,
    hasPendingToken: Boolean(pendingToken),
    pendingTokenPurpose: pendingToken?.purpose ?? null,
    pendingTokenExpiresAt: pendingToken ? pendingToken.expires_at.toISOString() : null,
    pendingTokenChannel: pendingToken?.delivery_channel ?? null,
    hasSharedFamilyPhone,
    sharedPhonePatientsCount,
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

function isChannelAllowedBySettings(
  channel: PortalDeliveryChannel,
  settings: PortalSettingsConfig,
): boolean {
  if (channel === "whatsapp") return settings.allowWhatsappChannel;
  if (channel === "sms") return settings.allowSmsChannel;
  if (channel === "in_person") return settings.allowInPersonChannel;
  return false;
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
  /** يُعاد فقط في وضع الاختبار المعزول (`sandbox_test`) عند عدم وجود مزوّد شبكي وهمي، لمنع أي إرسال خارجي حقيقي مع إتاحة فحص الرابط اصطناعيًا. */
  sandboxSimulated?: boolean;
  sandboxUrl?: string;
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
  const authority = await evaluatePortalStaffAuthority(input.actorSession.userId);
  if (!authority || !authority.access.isActive) {
    return { ok: false, status: 401, message: "انتهت الجلسة." };
  }
  const access = authority.access;
  if (!access.canIssueActivation) {
    return { ok: false, status: 403, message: "غير مصرّح لك بتفعيل حسابات بوابة المرضى." };
  }
  if (!(await canStaffActOnPatientPortal(authority, input.actorSession, input.patientId, access.canIssueActivation))) {
    return { ok: false, status: 403, message: "غير مصرّح لك بالوصول إلى ملف هذا المريض." };
  }

  const settings = await readPortalSettings();
  if (settings.effectiveOperatingMode === "disabled") {
    return {
      ok: false,
      status: 503,
      code: "portal_activation_disabled_pending_policy",
      message:
        "تفعيل حسابات بوابة المريض معطّل افتراضيًا حتى اعتماد سياسات الاستعادة ومدد الروابط ودمج الملفات من المالك.",
    };
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

  if (
    input.deliveryChannel !== "whatsapp" &&
    input.deliveryChannel !== "sms" &&
    input.deliveryChannel !== "in_person"
  ) {
    return { ok: false, status: 400, message: "وسيلة إرسال التفعيل غير صالحة." };
  }
  if (!isChannelAllowedBySettings(input.deliveryChannel, settings)) {
    return {
      ok: false,
      status: 403,
      code: "delivery_channel_disabled",
      message: "وسيلة الإرسال المختارة معطّلة حاليًا في إعدادات بوابة المريض.",
    };
  }

  const sharedPhonePatientsCount = await countPatientsSharingPhone(patient.phone);
  const hasSharedFamilyPhone = sharedPhonePatientsCount > 1;
  const note =
    typeof input.verificationNote === "string"
      ? input.verificationNote.trim().slice(0, 500)
      : "";
  if (input.deliveryChannel === "in_person" && note.length < 8) {
    return {
      ok: false,
      status: 400,
      message:
        "التفعيل الحضوري المباشر يتطلّب تدوين ملاحظة التحقق من هوية المريض حضوريًا (8 أحرف على الأقل).",
    };
  }
  if (hasSharedFamilyPhone && note.length < 8) {
    return {
      ok: false,
      status: 400,
      code: "shared_phone_verification_required",
      message:
        "هذا الهاتف مشترك بين أكثر من ملف عائلي؛ يجب توثيق التحقق من اسم المريض ورقم ملفه وهويته (8 أحرف على الأقل) قبل إصدار الرابط.",
    };
  }
  if (
    input.deliveryChannel !== "in_person" &&
    (!patient.phone || patient.phone.replace(/\D/g, "").length < 9)
  ) {
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
      message:
        "حساب البوابة مفعّل مسبقًا لهذا المريض. استخدم استعادة كلمة المرور عند الحاجة.",
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

  const activationMinutes = settings.activationTtlMinutes;
  const { rawToken, tokenHash } = generatePortalActionToken();
  const expiresAt = new Date(Date.now() + activationMinutes * 60 * 1000);
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
  const redactedLogBody = `[رابط تفعيل بوابة المريض محجوب أمنيًا — اسم المستخدم: ${normalizedLogin}]`;
  let sandboxSimulated = false;

  if (input.deliveryChannel !== "in_person") {
    if (settings.effectiveOperatingMode === "sandbox_test" && !sendOptions?.fetchImpl) {
      sandboxSimulated = true;
      const recordFn = sendOptions?.record ?? recordMessageDelivery;
      await recordFn({
        channel: input.deliveryChannel,
        patientId: patient.id,
        counterpart: patient.phone!,
        subject: null,
        body: redactedLogBody,
        purpose: "portal_auth",
        status: "sent",
        providerMessageId: "sandbox-simulated",
        error: null,
        createdBy: access.username,
      }).catch(() => null);
    } else {
      const bodyText =
        `مرحباً ${patient.fullName}، تم تفعيل حسابكم في بوابة المريض بمركز عقلان.\n` +
        `رقم الملف: ${patient.patientNumber}\n` +
        `اسم المستخدم: ${normalizedLogin}\n` +
        `لتعيين كلمة المرور الخاصة بكم (الرابط صالح لمدة ${activationMinutes} دقيقة ويُستخدم مرة واحدة فقط):\n` +
        `${actionUrl}`;
      const delivery = await sendOutbound(
        {
          channel: input.deliveryChannel,
          purpose: "portal_auth",
          patientId: patient.id,
          to: patient.phone!,
          body: bodyText,
          redactedLogBody,
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
      ...(sandboxSimulated ? { sandboxSimulated: true } : {}),
      ...(hasSharedFamilyPhone ? { sharedFamilyPhone: true, sharedPhonePatientsCount } : {}),
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
        ? `أُصدر رابط التفعيل الحضوري أحادي الاستخدام (صالح لمدة ${activationMinutes} دقيقة).`
        : sandboxSimulated
          ? `أُصدر رابط التفعيل في وضع الاختبار المعزول دون إرسال رسالة خارجية فعلية (صالح لمدة ${activationMinutes} دقيقة).`
          : "أُرسل رابط تفعيل البوابة أحادي الاستخدام إلى هاتف المريض المسجّل.",
    loginName: normalizedLogin,
    expiresAt: expiresAt.toISOString(),
    deliveryChannel: input.deliveryChannel,
    ...(input.deliveryChannel === "in_person" ? { inPersonUrl: actionUrl } : {}),
    ...(sandboxSimulated ? { sandboxSimulated: true, sandboxUrl: actionUrl } : {}),
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
  const authority = await evaluatePortalStaffAuthority(input.actorSession.userId);
  if (!authority || !authority.access.isActive) {
    return { ok: false, status: 401, message: "انتهت الجلسة." };
  }
  const access = authority.access;
  if (!access.canIssueReset) {
    return { ok: false, status: 403, message: "غير مصرّح لك بإصدار روابط استعادة بوابة المرضى." };
  }
  if (!(await canStaffActOnPatientPortal(authority, input.actorSession, input.patientId, access.canIssueReset))) {
    return { ok: false, status: 403, message: "غير مصرّح لك بالوصول إلى ملف هذا المريض." };
  }

  const settings = await readPortalSettings();
  if (settings.effectiveOperatingMode === "disabled") {
    return {
      ok: false,
      status: 503,
      code: "portal_activation_disabled_pending_policy",
      message:
        "تفعيل حسابات بوابة المريض معطّل افتراضيًا حتى اعتماد سياسات الاستعادة ومدد الروابط ودمج الملفات من المالك.",
    };
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
  if (!isChannelAllowedBySettings(input.deliveryChannel, settings)) {
    return {
      ok: false,
      status: 403,
      code: "delivery_channel_disabled",
      message: "وسيلة الإرسال المختارة معطّلة حاليًا في إعدادات بوابة المريض.",
    };
  }

  const sharedPhonePatientsCount = await countPatientsSharingPhone(patient.phone);
  const hasSharedFamilyPhone = sharedPhonePatientsCount > 1;
  const note =
    typeof input.verificationNote === "string"
      ? input.verificationNote.trim().slice(0, 500)
      : "";
  const isInPersonFlow =
    Boolean(input.inPersonVerified) || input.deliveryChannel === "in_person";
  let contactPhoneUpdated = false;

  let purpose: PortalTokenPurpose;
  let ttlMinutes: number;
  if (isInPersonFlow) {
    if (note.length < 8) {
      return {
        ok: false,
        status: 400,
        message:
          "مسار التحقق الحضوري عند فقد وسيلة الاتصال يتطلّب توثيق طريقة التحقق من هوية المريض (8 أحرف على الأقل).",
      };
    }
    const trimmedUpdatedPhone =
      typeof input.updatedPhone === "string" ? input.updatedPhone.trim() : "";
    if (trimmedUpdatedPhone.length > 0) {
      const phonePolicy = settings.recoveryPhonePolicy;
      if (phonePolicy === "disallow_inline") {
        return {
          ok: false,
          status: 409,
          code: "phone_change_policy_pending",
          message:
            "تغيير رقم الهاتف المسجّل ضمن استعادة حساب البوابة موقوف افتراضيًا حتى اعتماد سياسة تغيير الهاتف من المالك. حدّث الهاتف وفق مسار ملف المريض المعتمد أو سلّم رابط الاستعادة حضوريًا.",
        };
      }
      if (phonePolicy === "owner_only" && !access.isOwner) {
        return {
          ok: false,
          status: 403,
          code: "phone_change_owner_required",
          message: "تغيير رقم الهاتف أثناء استعادة البوابة محصور بمالك العيادة المعتمد فقط.",
        };
      }
      if (
        phonePolicy === "admin_or_owner_only" &&
        !access.isOwner &&
        !(access.role === "admin" && access.canChangeRecoveryPhone)
      ) {
        return {
          ok: false,
          status: 403,
          code: "phone_change_admin_required",
          message:
            "تغيير رقم الهاتف أثناء استعادة البوابة محصور بالمالك أو الإدارة المعتمدة فقط.",
        };
      }
      if (phonePolicy === "portal_manager_in_person" && !access.canChangeRecoveryPhone) {
        return {
          ok: false,
          status: 403,
          code: "phone_change_permission_denied",
          message: "غير مصرّح لك بتعديل رقم هاتف الاستعادة لهذا الحساب.",
        };
      }
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
        message:
          "لا يوجد رقم هاتف صالح مسجّل في ملف المريض لإرسال الرابط عبر واتساب أو SMS؛ استعمل التسليم الحضوري المباشر.",
      };
    }
    purpose = "in_person_reset";
    ttlMinutes =
      input.deliveryChannel === "in_person"
        ? settings.inPersonResetTtlMinutes
        : settings.resetTtlMinutes;
  } else {
    if (!patient.phone || patient.phone.replace(/\D/g, "").length < 9) {
      return {
        ok: false,
        status: 400,
        message:
          "لا يوجد رقم هاتف صالح مسجّل في ملف المريض. استعمل مسار التحقق الحضوري المباشر.",
      };
    }
    const givenPhone = typeof input.verifiedPhone === "string" ? input.verifiedPhone.trim() : "";
    if (!givenPhone || !samePhone(patient.phone, givenPhone)) {
      return {
        ok: false,
        status: 400,
        code: "phone_mismatch",
        message:
          "يجب تأكيد رقم الهاتف المسجّل في ملف المريض بعد التحقق من هويته قبل إرسال رابط الاستعادة.",
      };
    }
    if (hasSharedFamilyPhone && note.length < 8) {
      return {
        ok: false,
        status: 400,
        code: "shared_phone_verification_required",
        message:
          "هذا الهاتف مشترك بين أكثر من ملف عائلي؛ لا يكفي تأكيد الهاتف وحده، بل يجب توثيق التحقق من هوية صاحب الملف ورقم ملفه (8 أحرف على الأقل).",
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
    ttlMinutes = settings.resetTtlMinutes;
  }

  const { rawToken, tokenHash } = generatePortalActionToken();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
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
  const redactedLogBody = `[رابط استعادة كلمة مرور البوابة محجوب أمنيًا — اسم المستخدم: ${account.login_name}]`;
  let sandboxSimulated = false;

  if (input.deliveryChannel !== "in_person") {
    if (settings.effectiveOperatingMode === "sandbox_test" && !sendOptions?.fetchImpl) {
      sandboxSimulated = true;
      const recordFn = sendOptions?.record ?? recordMessageDelivery;
      await recordFn({
        channel: input.deliveryChannel,
        patientId: patient.id,
        counterpart: patient.phone!,
        subject: null,
        body: redactedLogBody,
        purpose: "portal_auth",
        status: "sent",
        providerMessageId: "sandbox-simulated",
        error: null,
        createdBy: access.username,
      }).catch(() => null);
    } else {
      const bodyText =
        `مرحباً ${patient.fullName}، بناءً على طلبكم بعد التحقق من هويتكم في مركز عقلان:\n` +
        `رقم الملف: ${patient.patientNumber}\n` +
        `اسم المستخدم: ${account.login_name}\n` +
        `رابط إعادة تعيين كلمة المرور (صالح لمدة ${ttlMinutes} دقيقة ويُستخدم مرة واحدة فقط):\n` +
        `${actionUrl}`;
      const delivery = await sendOutbound(
        {
          channel: input.deliveryChannel,
          purpose: "portal_auth",
          patientId: patient.id,
          to: patient.phone!,
          body: bodyText,
          redactedLogBody,
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
      ...(sandboxSimulated ? { sandboxSimulated: true } : {}),
      ...(hasSharedFamilyPhone ? { sharedFamilyPhone: true, sharedPhonePatientsCount } : {}),
    },
    actor: access.username,
    actorRole: access.role,
  });

  return {
    ok: true,
    status: 200,
    message:
      input.deliveryChannel === "in_person"
        ? `أُصدر رابط الاستعادة الحضوري أحادي الاستخدام (صالح لمدة ${ttlMinutes} دقيقة).`
        : sandboxSimulated
          ? `أُصدر رابط الاستعادة في وضع الاختبار المعزول دون إرسال رسالة خارجية فعلية (صالح لمدة ${ttlMinutes} دقيقة).`
          : "أُرسل رابط إعادة تعيين كلمة المرور المؤقت أحادي الاستخدام إلى هاتف المريض المسجّل.",
    loginName: account.login_name,
    expiresAt: expiresAt.toISOString(),
    deliveryChannel: input.deliveryChannel,
    ...(input.deliveryChannel === "in_person" ? { inPersonUrl: actionUrl } : {}),
    ...(sandboxSimulated ? { sandboxSimulated: true, sandboxUrl: actionUrl } : {}),
  };
}

export async function setPortalAccountStatusByStaff(input: {
  actorSession: SessionPayload;
  patientId: number;
  action: "disable" | "enable" | "revoke_sessions" | "unlock";
  reason?: string | null;
}): Promise<{ ok: true; message: string } | { ok: false; status: number; message: string }> {
  const authority = await evaluatePortalStaffAuthority(input.actorSession.userId);
  if (!authority || !authority.access.isActive) {
    return { ok: false, status: 401, message: "انتهت الجلسة." };
  }
  const access = authority.access;
  if (!access.canManagePortal) {
    return { ok: false, status: 403, message: "غير مصرّح لك بإدارة حساب بوابة هذا المريض." };
  }
  if (!(await canStaffActOnPatientPortal(authority, input.actorSession, input.patientId, access.canManagePortal))) {
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

  const cleanReason =
    typeof input.reason === "string" ? input.reason.trim().slice(0, 300) || null : null;

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
    const settings = await readPortalSettings();
    if (settings.effectiveOperatingMode === "disabled") {
      return {
        ok: false,
        status: 503,
        message:
          "إعادة تمكين حسابات بوابة المريض معطّلة افتراضيًا حتى اعتماد سياسات البوابة النهائية من المالك.",
      };
    }
    const nextStatus: PortalAccountStatus = account.password_hash ? "active" : "pending_activation";
    await pool.query(
      `UPDATE patient_portal_accounts
          SET status = $2,
              disabled_at = NULL,
              disabled_by_user_id = NULL,
              disabled_reason = NULL,
              failed_login_attempts = 0,
              first_failed_login_at = NULL,
              locked_until = NULL,
              lock_reason = NULL,
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

  if (input.action === "unlock") {
    await pool.query(
      `UPDATE patient_portal_accounts
          SET failed_login_attempts = 0,
              first_failed_login_at = NULL,
              locked_until = NULL,
              lock_reason = NULL,
              updated_at = NOW()
        WHERE patient_id = $1`,
      [input.patientId],
    );
    await recordAudit({
      action: "portal.account.unlocked",
      entity: "patient",
      entityId: input.patientId,
      details: { loginName: account.login_name, ...(cleanReason ? { reason: cleanReason } : {}) },
      actor: access.username,
      actorRole: access.role,
    });
    return { ok: true, message: "رُفع القفل المؤقت عن حساب بوابة المريض." };
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
  const settings = await readPortalSettings();
  if (settings.effectiveOperatingMode === "disabled") {
    return {
      ok: false,
      status: 503,
      message:
        "تفعيل واستعادة بوابة المريض معطّلان حاليًا حتى اعتماد سياسات التشغيل النهائية من إدارة المركز.",
    };
  }
  if (typeof rawToken !== "string" || rawToken.trim().length < 20 || rawToken.length > 200) {
    return { ok: false, status: 400, message: "الرابط غير صالح أو منتهي الصلاحية." };
  }
  const tokenHash = hashPortalActionToken(rawToken);
  const { rows: [row] } = await getPool().query<{
    purpose: PortalTokenPurpose;
    delivery_channel: PortalDeliveryChannel;
    phone_fingerprint: string | null;
    expires_at: Date;
    used_at: Date | null;
    invalidated_at: Date | null;
    failed_attempts: number;
    login_name: string;
    account_status: PortalAccountStatus;
    full_name: string;
    phone: string | null;
  }>(
    `SELECT t.purpose, t.delivery_channel, t.phone_fingerprint, t.expires_at, t.used_at, t.invalidated_at, t.failed_attempts,
            a.login_name, a.status AS account_status, p.full_name, p.phone
       FROM patient_portal_tokens t
       JOIN patient_portal_accounts a ON a.patient_id = t.patient_id
       JOIN patients p ON p.id = t.patient_id
      WHERE t.token_hash = $1
      LIMIT 1`,
    [tokenHash],
  );

  if (
    !row ||
    row.used_at ||
    row.invalidated_at ||
    row.failed_attempts >= settings.maxTokenAttempts ||
    row.expires_at.getTime() <= Date.now()
  ) {
    return {
      ok: false,
      status: 410,
      message: "انتهت صلاحية هذا الرابط أو استُخدم مسبقًا. راجع الاستقبال لإصدار رابط جديد.",
    };
  }
  if (row.account_status === "disabled") {
    return { ok: false, status: 403, message: "حساب البوابة معطّل. راجع إدارة العيادة." };
  }
  if (
    row.delivery_channel !== "in_person" &&
    row.phone_fingerprint &&
    portalPhoneFingerprint(row.phone) !== row.phone_fingerprint
  ) {
    return {
      ok: false,
      status: 410,
      message: "تغيّر رقم الهاتف المسجّل بعد إصدار الرابط؛ أُبطل الرابط لحماية حسابك.",
    };
  }

  return {
    ok: true,
    mode: row.purpose === "activate" ? "activate" : "reset",
    loginName: row.login_name,
    patientFirstName: row.full_name.trim().split(/\s+/)[0] || "المريض",
    expiresAt: row.expires_at.toISOString(),
  };
}

async function recordTokenFailedAttempt(
  tokenHash: string,
  maxTokenAttempts: number,
): Promise<boolean> {
  const { rows: [updated] } = await getPool().query<{
    failed_attempts: number;
    invalidated_at: Date | null;
  }>(
    `UPDATE patient_portal_tokens
        SET failed_attempts = failed_attempts + 1,
            invalidated_at = CASE
              WHEN failed_attempts + 1 >= $2 THEN COALESCE(invalidated_at, NOW())
              ELSE invalidated_at
            END,
            invalidation_reason = CASE
              WHEN failed_attempts + 1 >= $2 THEN COALESCE(invalidation_reason, 'max_attempts_exceeded')
              ELSE invalidation_reason
            END
      WHERE token_hash = $1
        AND used_at IS NULL
        AND invalidated_at IS NULL
      RETURNING failed_attempts, invalidated_at`,
    [tokenHash, maxTokenAttempts],
  );
  return Boolean(updated?.invalidated_at);
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
      sessionDurationMs: number;
      issuedAtFloorMs: number;
    }
  | { ok: false; status: number; code: string; message: string }
> {
  const settings = await readPortalSettings();
  if (settings.effectiveOperatingMode === "disabled") {
    return {
      ok: false,
      status: 503,
      code: "portal_activation_disabled_pending_policy",
      message:
        "تفعيل واستعادة بوابة المريض معطّلان حاليًا حتى اعتماد سياسات التشغيل النهائية من إدارة المركز.",
    };
  }
  if (
    typeof input.rawToken !== "string" ||
    input.rawToken.trim().length < 20 ||
    input.rawToken.length > 200
  ) {
    return { ok: false, status: 400, code: "invalid_token", message: "الرابط غير صالح." };
  }

  const tokenHash = hashPortalActionToken(input.rawToken);
  const basicPasswordCheck = validatePortalPasswordChoice(input.newPassword);
  if (!basicPasswordCheck.ok) {
    const burned = await recordTokenFailedAttempt(tokenHash, settings.maxTokenAttempts);
    if (burned) {
      return {
        ok: false,
        status: 410,
        code: "token_max_attempts_exceeded",
        message: "تجاوز هذا الرابط الحد المسموح للمحاولات وأُبطل تلقائيًا. اطلب رابطًا جديدًا من العيادة.",
      };
    }
    return { ok: false, status: 400, code: "weak_password", message: basicPasswordCheck.message };
  }

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
          AND failed_attempts < $3
          AND expires_at > NOW()
        RETURNING id::text AS id, patient_id, purpose, delivery_channel, phone_fingerprint`,
      [tokenHash, allowedPurposes, settings.maxTokenAttempts],
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
      const burned = await recordTokenFailedAttempt(tokenHash, settings.maxTokenAttempts);
      if (burned) {
        return {
          ok: false,
          status: 410,
          code: "token_max_attempts_exceeded",
          message:
            "تجاوز هذا الرابط الحد المسموح للمحاولات وأُبطل تلقائيًا. اطلب رابطًا جديدًا من العيادة.",
        };
      }
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

    const { rows: [updatedAccount] } = await client.query<{
      credential_version: number;
      sessions_revoked_at: Date;
    }>(
      `UPDATE patient_portal_accounts
          SET password_hash = $2,
              status = 'active',
              credential_version = credential_version + 1,
              sessions_revoked_at = NOW(),
              phone_fingerprint = $3,
              activated_at = COALESCE(activated_at, NOW()),
              password_updated_at = NOW(),
              last_login_at = NOW(),
              failed_login_attempts = 0,
              first_failed_login_at = NULL,
              locked_until = NULL,
              lock_reason = NULL,
              updated_at = NOW()
        WHERE patient_id = $1
        RETURNING credential_version, sessions_revoked_at`,
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
      sessionDurationMs: settings.sessionTtlHours * 60 * 60 * 1000,
      issuedAtFloorMs: updatedAccount.sessions_revoked_at.getTime(),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface PortalAuthenticatedAccount {
  patientId: number;
  patientNumber: string;
  fullName: string;
  loginName: string;
  credentialVersion: number;
  phoneFingerprint: string | null;
  sessionDurationMs: number;
}

export type PortalAuthenticationOutcome =
  | ({ ok: true } & PortalAuthenticatedAccount)
  | {
      ok: false;
      reason: "invalid_credentials" | "account_locked";
      lockedUntil?: string;
      retryAfterSeconds?: number;
    };

export async function authenticatePortalAccountWithPolicy(
  rawUsername: string,
  rawPassword: string,
): Promise<PortalAuthenticationOutcome> {
  const settings = await readPortalSettings();
  const normalizedUsername = normalizePortalLoginName(rawUsername);
  if (!normalizedUsername) {
    const dummy = await getDummyPasswordHash();
    await verifyPassword(rawPassword || "x", dummy).catch(() => false);
    return { ok: false, reason: "invalid_credentials" };
  }

  const pool = getPool();
  const { rows: [row] } = await pool.query<{
    patient_id: number;
    login_name: string;
    password_hash: string | null;
    status: PortalAccountStatus;
    credential_version: number;
    failed_login_attempts: number;
    first_failed_login_at: Date | null;
    locked_until: Date | null;
    patient_number: string;
    full_name: string;
    phone: string | null;
  }>(
    `SELECT a.patient_id, a.login_name, a.password_hash, a.status, a.credential_version,
            a.failed_login_attempts, a.first_failed_login_at, a.locked_until,
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
    return { ok: false, reason: "invalid_credentials" };
  }

  const nowMs = Date.now();
  if (row.locked_until && row.locked_until.getTime() > nowMs) {
    const dummy = await getDummyPasswordHash();
    await verifyPassword(rawPassword, dummy).catch(() => false);
    return {
      ok: false,
      reason: "account_locked",
      lockedUntil: row.locked_until.toISOString(),
      retryAfterSeconds: Math.max(1, Math.ceil((row.locked_until.getTime() - nowMs) / 1000)),
    };
  }

  const valid = await verifyPassword(rawPassword, row.password_hash);
  if (!valid) {
    const windowMs = settings.loginFailureWindowMinutes * 60 * 1000;
    const withinWindow =
      row.first_failed_login_at && nowMs - row.first_failed_login_at.getTime() <= windowMs;
    const nextFailures = withinWindow ? (row.failed_login_attempts ?? 0) + 1 : 1;
    const firstFailIso = withinWindow && row.first_failed_login_at
      ? row.first_failed_login_at.toISOString()
      : new Date(nowMs).toISOString();

    if (nextFailures >= settings.maxFailedLoginAttempts) {
      const lockedUntil = new Date(nowMs + settings.accountLockoutMinutes * 60 * 1000);
      await pool.query(
        `UPDATE patient_portal_accounts
            SET failed_login_attempts = $2,
                first_failed_login_at = $3,
                locked_until = $4,
                lock_reason = 'too_many_failed_logins',
                updated_at = NOW()
          WHERE patient_id = $1`,
        [row.patient_id, nextFailures, firstFailIso, lockedUntil.toISOString()],
      );
      await recordAudit({
        action: "portal.account.locked",
        entity: "patient",
        entityId: row.patient_id,
        entityLabel: row.full_name,
        details: {
          loginName: row.login_name,
          failedAttempts: nextFailures,
          lockoutMinutes: settings.accountLockoutMinutes,
          lockedUntil: lockedUntil.toISOString(),
        },
        actor: `مريض: ${row.full_name}`,
      });
      return {
        ok: false,
        reason: "account_locked",
        lockedUntil: lockedUntil.toISOString(),
        retryAfterSeconds: settings.accountLockoutMinutes * 60,
      };
    }

    await pool.query(
      `UPDATE patient_portal_accounts
          SET failed_login_attempts = $2,
              first_failed_login_at = $3,
              locked_until = NULL,
              lock_reason = NULL,
              updated_at = NOW()
        WHERE patient_id = $1`,
      [row.patient_id, nextFailures, firstFailIso],
    );
    return { ok: false, reason: "invalid_credentials" };
  }

  const currentPhoneFingerprint = portalPhoneFingerprint(row.phone);
  await pool.query(
    `UPDATE patient_portal_accounts
        SET last_login_at = NOW(),
            phone_fingerprint = $2,
            failed_login_attempts = 0,
            first_failed_login_at = NULL,
            locked_until = NULL,
            lock_reason = NULL
      WHERE patient_id = $1`,
    [row.patient_id, currentPhoneFingerprint],
  );

  return {
    ok: true,
    patientId: row.patient_id,
    patientNumber: row.patient_number,
    fullName: row.full_name,
    loginName: row.login_name,
    credentialVersion: row.credential_version,
    phoneFingerprint: currentPhoneFingerprint,
    sessionDurationMs: settings.sessionTtlHours * 60 * 60 * 1000,
  };
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
  const outcome = await authenticatePortalAccountWithPolicy(rawUsername, rawPassword);
  if (!outcome.ok) return null;
  return {
    patientId: outcome.patientId,
    patientNumber: outcome.patientNumber,
    fullName: outcome.fullName,
    loginName: outcome.loginName,
    credentialVersion: outcome.credentialVersion,
    phoneFingerprint: outcome.phoneFingerprint,
  };
}

export async function changePortalPasswordByPatient(input: {
  patientId: number;
  currentPassword: string;
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
      sessionDurationMs: number;
      issuedAtFloorMs: number;
    }
  | { ok: false; status: number; code: string; message: string }
> {
  if (!Number.isInteger(input.patientId) || input.patientId <= 0) {
    return { ok: false, status: 400, code: "invalid_patient", message: "طلب غير صالح." };
  }
  const settings = await readPortalSettings();
  const pool = getPool();
  const { rows: [row] } = await pool.query<{
    patient_id: number;
    login_name: string;
    password_hash: string | null;
    status: PortalAccountStatus;
    patient_number: string;
    full_name: string;
    phone: string | null;
  }>(
    `SELECT a.patient_id, a.login_name, a.password_hash, a.status,
            p.patient_number, p.full_name, p.phone
       FROM patient_portal_accounts a
       JOIN patients p ON p.id = a.patient_id
      WHERE a.patient_id = $1
      LIMIT 1`,
    [input.patientId],
  );

  if (!row || row.status !== "active" || !row.password_hash) {
    return {
      ok: false,
      status: 403,
      code: "account_inactive",
      message: "حساب البوابة غير نشط حاليًا.",
    };
  }

  const currentValid = await verifyPassword(input.currentPassword || "", row.password_hash);
  if (!currentValid) {
    return {
      ok: false,
      status: 401,
      code: "invalid_current_password",
      message: "كلمة المرور الحالية غير صحيحة.",
    };
  }

  const verdict = validatePortalPasswordChoice(input.newPassword, row.login_name);
  if (!verdict.ok) {
    return { ok: false, status: 400, code: "weak_password", message: verdict.message };
  }

  if (await verifyPassword(verdict.value, row.password_hash)) {
    return {
      ok: false,
      status: 400,
      code: "same_password",
      message: "يجب اختيار كلمة مرور جديدة مختلفة عن كلمة المرور الحالية.",
    };
  }

  const newPasswordHash = await hashPassword(verdict.value);
  const currentPhoneFingerprint = portalPhoneFingerprint(row.phone);

  const { rows: [updated] } = await pool.query<{
    credential_version: number;
    sessions_revoked_at: Date;
  }>(
    `UPDATE patient_portal_accounts
        SET password_hash = $2,
            credential_version = credential_version + 1,
            sessions_revoked_at = NOW(),
            password_updated_at = NOW(),
            phone_fingerprint = $3,
            failed_login_attempts = 0,
            first_failed_login_at = NULL,
            locked_until = NULL,
            lock_reason = NULL,
            updated_at = NOW()
      WHERE patient_id = $1
      RETURNING credential_version, sessions_revoked_at`,
    [input.patientId, newPasswordHash, currentPhoneFingerprint],
  );

  await pool.query(
    `UPDATE patient_portal_tokens
        SET invalidated_at = NOW(),
            invalidation_reason = 'password_changed_by_patient'
      WHERE patient_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
    [input.patientId],
  );

  await recordAudit({
    action: "portal.account.password_changed",
    entity: "patient",
    entityId: row.patient_id,
    entityLabel: row.full_name,
    details: {
      loginName: row.login_name,
      sessionsRevoked: true,
    },
    actor: `مريض: ${row.full_name}`,
  });

  return {
    ok: true,
    patientId: row.patient_id,
    patientNumber: row.patient_number,
    fullName: row.full_name,
    loginName: row.login_name,
    credentialVersion: updated.credential_version,
    phoneFingerprint: currentPhoneFingerprint,
    sessionDurationMs: settings.sessionTtlHours * 60 * 60 * 1000,
    issuedAtFloorMs: updated.sessions_revoked_at.getTime(),
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
  patientNumber?: string;
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
  if (payload.patientNumber !== undefined && row.patient_number !== payload.patientNumber) {
    return null;
  }
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
  portalLegacySuccessTotal: number;
  portalLegacyFailureTotal: number;
  portalLegacyBlockedTotal: number;
  auditLogEarliestAt: string | null;
  intakeFormsTotal: number;
  appointmentsConfirmedByPatientTotal: number;
  portalMessagesTotal: number;
  provenanceCaveat: string;
}

/**
 * استعلام قراءة فقط آمن (بلا أسماء أو هواتف أو معرّفات مرضى) لفحص الجاهزية وأثر الاستخدام التاريخي للبوابة.
 * تنبيه صريح: العدّ التجميعي وحده لا يثبت مصدر كل صف تاريخي (تجربة داخلية من الطاقم أم مريض فعلي) ولا بديل
 * عن التحقق التشغيلي المعتمد من المالك قبل أي قرار تواصلي مع المرضى.
 */
export async function getPortalMigrationReadinessSummary(): Promise<PortalMigrationReadinessSummary> {
  await ensureSchema();
  const { rows: [row] } = await getPool().query<{
    total_patients: number;
    total_accounts: number;
    active_accounts: number;
    pending_accounts: number;
    disabled_accounts: number;
    legacy_logins_7d: number;
    legacy_success_total: number;
    legacy_failure_total: number;
    legacy_blocked_total: number;
    audit_earliest_at: Date | null;
    intake_forms_total: number;
    appointments_confirmed_patient_total: number;
    portal_messages_total: number;
  }>(
    `SELECT (SELECT COUNT(*)::int FROM patients) AS total_patients,
            (SELECT COUNT(*)::int FROM patient_portal_accounts) AS total_accounts,
            (SELECT COUNT(*)::int FROM patient_portal_accounts WHERE status = 'active') AS active_accounts,
            (SELECT COUNT(*)::int FROM patient_portal_accounts WHERE status = 'pending_activation') AS pending_accounts,
            (SELECT COUNT(*)::int FROM patient_portal_accounts WHERE status = 'disabled') AS disabled_accounts,
            (SELECT COUNT(*)::int FROM audit_log
              WHERE action = 'portal.login'
                AND details ->> 'ok' = 'true'
                AND COALESCE(details ->> 'method', 'legacy_phone') <> 'username_password'
                AND created_at >= NOW() - INTERVAL '7 days') AS legacy_logins_7d,
            (SELECT COUNT(*)::int FROM audit_log
              WHERE action = 'portal.login'
                AND details ->> 'ok' = 'true'
                AND COALESCE(details ->> 'method', 'legacy_phone') <> 'username_password') AS legacy_success_total,
            (SELECT COUNT(*)::int FROM audit_log
              WHERE action = 'portal.login'
                AND details ->> 'ok' = 'false'
                AND COALESCE(details ->> 'method', 'legacy_phone') <> 'username_password') AS legacy_failure_total,
            (SELECT COUNT(*)::int FROM audit_log
              WHERE action = 'portal.login.legacy_blocked') AS legacy_blocked_total,
            (SELECT MIN(created_at) FROM audit_log) AS audit_earliest_at,
            (SELECT COUNT(*)::int FROM patient_intake_forms) AS intake_forms_total,
            (SELECT COUNT(*)::int FROM appointments
              WHERE patient_confirmed_at IS NOT NULL) AS appointments_confirmed_patient_total,
            (SELECT COUNT(*)::int FROM messages
              WHERE sender_type = 'patient') AS portal_messages_total`,
  );
  return {
    totalPatients: row?.total_patients ?? 0,
    portalAccountsTotal: row?.total_accounts ?? 0,
    activeAccounts: row?.active_accounts ?? 0,
    pendingAccounts: row?.pending_accounts ?? 0,
    disabledAccounts: row?.disabled_accounts ?? 0,
    legacyLoginsLast7Days: row?.legacy_logins_7d ?? 0,
    portalLegacySuccessTotal: row?.legacy_success_total ?? 0,
    portalLegacyFailureTotal: row?.legacy_failure_total ?? 0,
    portalLegacyBlockedTotal: row?.legacy_blocked_total ?? 0,
    auditLogEarliestAt: row?.audit_earliest_at ? row.audit_earliest_at.toISOString() : null,
    intakeFormsTotal: row?.intake_forms_total ?? 0,
    appointmentsConfirmedByPatientTotal: row?.appointments_confirmed_patient_total ?? 0,
    portalMessagesTotal: row?.portal_messages_total ?? 0,
    provenanceCaveat:
      "الأعداد التجميعية وحدها لا تثبت أن السجل أنشأه مريض فعلي لا فحص داخلي، كما تعتمد تغطية audit_log على أقدم سجل محفوظ.",
  };
}
