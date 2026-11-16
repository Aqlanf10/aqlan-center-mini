import { ensureSchema, getPool, recordAudit } from "./db";

export type PortalOperatingMode = "disabled" | "sandbox_test" | "live_enabled";

export type PortalRecoveryPhonePolicy =
  | "disallow_inline"
  | "owner_only"
  | "admin_or_owner_only"
  | "portal_manager_in_person";

export type PortalPostMergeTargetPolicy =
  | "suspend_target"
  | "suspend_on_conflict_or_dual"
  | "keep_target_revoke_sessions";

export type PortalDeletedMessageRetentionMode =
  | "retain_indefinitely_pending_owner_policy";

export type PortalAnnouncementTone = "sky" | "navy" | "accent" | "emerald" | "amber";

export interface PortalSettingsConfig {
  operatingMode: PortalOperatingMode;
  effectiveOperatingMode: PortalOperatingMode;
  productionLaunchLocked: boolean;
  allowWhatsappChannel: boolean;
  allowSmsChannel: boolean;
  allowInPersonChannel: boolean;
  recoveryPhonePolicy: PortalRecoveryPhonePolicy;
  postMergeTargetPolicy: PortalPostMergeTargetPolicy;
  activationTtlMinutes: number;
  resetTtlMinutes: number;
  inPersonResetTtlMinutes: number;
  sessionTtlHours: number;
  adminPreviewTtlMinutes: number;
  maxTokenAttempts: number;
  maxFailedLoginAttempts: number;
  loginFailureWindowMinutes: number;
  accountLockoutMinutes: number;
  showProfile: boolean;
  showAppointments: boolean;
  allowAppointmentConfirm: boolean;
  showBookingLink: boolean;
  showVisits: boolean;
  showTreatmentPlans: boolean;
  showStatement: boolean;
  showPrescriptions: boolean;
  showDocuments: boolean;
  showXrayDocuments: boolean;
  showIntake: boolean;
  showMessages: boolean;
  allowMessageAttachments: boolean;
  allowVoiceMessages: boolean;
  showAnnouncements: boolean;
  deletedMessageRetentionMode: PortalDeletedMessageRetentionMode;
  updatedByUserId: number | null;
  updatedAt: string | null;
}

export interface PortalVisibleSections {
  profile: boolean;
  appointments: boolean;
  allowAppointmentConfirm: boolean;
  showBookingLink: boolean;
  visits: boolean;
  treatmentPlans: boolean;
  statement: boolean;
  prescriptions: boolean;
  documents: boolean;
  xrayDocuments: boolean;
  intake: boolean;
  messages: boolean;
  allowMessageAttachments: boolean;
  allowVoiceMessages: boolean;
  announcements: boolean;
}

export const PORTAL_SETTINGS_BOUNDS = {
  activationTtlMinutes: { min: 5, max: 1440, default: 60 },
  resetTtlMinutes: { min: 5, max: 1440, default: 30 },
  inPersonResetTtlMinutes: { min: 5, max: 180, default: 15 },
  sessionTtlHours: { min: 1, max: 720, default: 72 },
  adminPreviewTtlMinutes: { min: 5, max: 120, default: 30 },
  maxTokenAttempts: { min: 3, max: 10, default: 5 },
  maxFailedLoginAttempts: { min: 3, max: 15, default: 5 },
  loginFailureWindowMinutes: { min: 5, max: 120, default: 15 },
  accountLockoutMinutes: { min: 5, max: 1440, default: 15 },
} as const;

export function isProductionLiveLaunchLocked(): boolean {
  return (
    process.env.NODE_ENV === "production" &&
    process.env.PORTAL_ALLOW_PRODUCTION_LIVE?.trim() !== "true"
  );
}

export const DEFAULT_PORTAL_SETTINGS: Omit<
  PortalSettingsConfig,
  "effectiveOperatingMode" | "productionLaunchLocked"
> = {
  operatingMode: "disabled",
  allowWhatsappChannel: true,
  allowSmsChannel: true,
  allowInPersonChannel: true,
  recoveryPhonePolicy: "disallow_inline",
  postMergeTargetPolicy: "suspend_target",
  activationTtlMinutes: PORTAL_SETTINGS_BOUNDS.activationTtlMinutes.default,
  resetTtlMinutes: PORTAL_SETTINGS_BOUNDS.resetTtlMinutes.default,
  inPersonResetTtlMinutes: PORTAL_SETTINGS_BOUNDS.inPersonResetTtlMinutes.default,
  sessionTtlHours: PORTAL_SETTINGS_BOUNDS.sessionTtlHours.default,
  adminPreviewTtlMinutes: PORTAL_SETTINGS_BOUNDS.adminPreviewTtlMinutes.default,
  maxTokenAttempts: PORTAL_SETTINGS_BOUNDS.maxTokenAttempts.default,
  maxFailedLoginAttempts: PORTAL_SETTINGS_BOUNDS.maxFailedLoginAttempts.default,
  loginFailureWindowMinutes: PORTAL_SETTINGS_BOUNDS.loginFailureWindowMinutes.default,
  accountLockoutMinutes: PORTAL_SETTINGS_BOUNDS.accountLockoutMinutes.default,
  showProfile: true,
  showAppointments: true,
  allowAppointmentConfirm: true,
  showBookingLink: true,
  showVisits: true,
  showTreatmentPlans: true,
  showStatement: true,
  showPrescriptions: true,
  showDocuments: true,
  showXrayDocuments: false,
  showIntake: true,
  showMessages: true,
  allowMessageAttachments: true,
  allowVoiceMessages: true,
  showAnnouncements: true,
  deletedMessageRetentionMode: "retain_indefinitely_pending_owner_policy",
  updatedByUserId: null,
  updatedAt: null,
};

function parseEnvBoundedInt(
  raw: string | undefined,
  min: number,
  max: number,
): number | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

export function visibleSectionsFromSettings(
  settings: PortalSettingsConfig,
): PortalVisibleSections {
  return {
    profile: settings.showProfile,
    appointments: settings.showAppointments,
    allowAppointmentConfirm: settings.showAppointments && settings.allowAppointmentConfirm,
    showBookingLink: settings.showAppointments && settings.showBookingLink,
    visits: settings.showVisits,
    treatmentPlans: settings.showTreatmentPlans,
    statement: settings.showStatement,
    prescriptions: settings.showPrescriptions,
    documents: settings.showDocuments,
    xrayDocuments: settings.showDocuments && settings.showXrayDocuments,
    intake: settings.showIntake,
    messages: settings.showMessages,
    allowMessageAttachments: settings.showMessages && settings.allowMessageAttachments,
    allowVoiceMessages: settings.showMessages && settings.allowVoiceMessages,
    announcements: settings.showAnnouncements,
  };
}

interface PortalSettingsRow {
  operating_mode: PortalOperatingMode;
  allow_whatsapp_channel: boolean;
  allow_sms_channel: boolean;
  allow_in_person_channel: boolean;
  recovery_phone_policy: PortalRecoveryPhonePolicy;
  post_merge_target_policy: PortalPostMergeTargetPolicy;
  activation_ttl_minutes: number;
  reset_ttl_minutes: number;
  in_person_reset_ttl_minutes: number;
  session_ttl_hours: number;
  admin_preview_ttl_minutes: number;
  max_token_attempts: number;
  max_failed_login_attempts: number;
  login_failure_window_minutes: number;
  account_lockout_minutes: number;
  show_profile: boolean;
  show_appointments: boolean;
  allow_appointment_confirm: boolean;
  show_booking_link: boolean;
  show_visits: boolean;
  show_treatment_plans: boolean;
  show_statement: boolean;
  show_prescriptions: boolean;
  show_documents: boolean;
  show_xray_documents: boolean;
  show_intake: boolean;
  show_messages: boolean;
  allow_message_attachments: boolean;
  allow_voice_messages: boolean;
  show_announcements: boolean;
  deleted_message_retention_mode: PortalDeletedMessageRetentionMode;
  updated_by_user_id: number | null;
  updated_at: Date | null;
}

export async function readPortalSettings(): Promise<PortalSettingsConfig> {
  const hasDbBackend = Boolean(
    process.env.DATABASE_URL?.trim() || process.env.USE_LOCAL_DB === "true",
  );
  let row: PortalSettingsRow | undefined;
  if (hasDbBackend) {
    try {
      await ensureSchema();
      const res = await getPool().query<PortalSettingsRow>(
        `SELECT * FROM patient_portal_settings WHERE singleton = TRUE LIMIT 1`,
      );
      row = res.rows[0];
    } catch {
      // في اختبارات الوحدات المعزولة التي تحقن مخرجات وهمية دون خادم PostgreSQL حيّ،
      // نعود إلى الإعدادات الافتراضية المحافظة (operatingMode = 'disabled').
      row = undefined;
    }
  }

  let storedMode: PortalOperatingMode = row?.operating_mode ?? DEFAULT_PORTAL_SETTINGS.operatingMode;
  if (
    storedMode !== "disabled" &&
    storedMode !== "sandbox_test" &&
    storedMode !== "live_enabled"
  ) {
    storedMode = "disabled";
  }

  const productionLocked = isProductionLiveLaunchLocked();
  let effectiveMode: PortalOperatingMode = storedMode;
  if (effectiveMode === "live_enabled" && productionLocked) {
    effectiveMode = "disabled";
  }
  const envActivation = process.env.PATIENT_PORTAL_ACTIVATION_ENABLED?.trim();
  if (envActivation === "false") {
    effectiveMode = "disabled";
  } else if (envActivation === "true" && effectiveMode === "disabled") {
    effectiveMode = "sandbox_test";
  }

  let recoveryPhonePolicy: PortalRecoveryPhonePolicy =
    row?.recovery_phone_policy ?? DEFAULT_PORTAL_SETTINGS.recoveryPhonePolicy;
  const envPhonePolicy = process.env.PORTAL_RECOVERY_PHONE_POLICY?.trim();
  if (
    envPhonePolicy === "disallow_inline" ||
    envPhonePolicy === "owner_only" ||
    envPhonePolicy === "admin_or_owner_only" ||
    envPhonePolicy === "portal_manager_in_person"
  ) {
    recoveryPhonePolicy = envPhonePolicy;
  }

  let postMergeTargetPolicy: PortalPostMergeTargetPolicy =
    row?.post_merge_target_policy ?? DEFAULT_PORTAL_SETTINGS.postMergeTargetPolicy;
  const envMergePolicy = process.env.PORTAL_POST_MERGE_TARGET_POLICY?.trim();
  if (
    envMergePolicy === "suspend_target" ||
    envMergePolicy === "suspend_on_conflict_or_dual" ||
    envMergePolicy === "keep_target_revoke_sessions"
  ) {
    postMergeTargetPolicy = envMergePolicy;
  }

  const activationTtlMinutes =
    parseEnvBoundedInt(
      process.env.PORTAL_ACTIVATION_TTL_MINUTES,
      PORTAL_SETTINGS_BOUNDS.activationTtlMinutes.min,
      PORTAL_SETTINGS_BOUNDS.activationTtlMinutes.max,
    ) ??
    row?.activation_ttl_minutes ??
    DEFAULT_PORTAL_SETTINGS.activationTtlMinutes;

  const resetTtlMinutes =
    parseEnvBoundedInt(
      process.env.PORTAL_RESET_TTL_MINUTES,
      PORTAL_SETTINGS_BOUNDS.resetTtlMinutes.min,
      PORTAL_SETTINGS_BOUNDS.resetTtlMinutes.max,
    ) ??
    row?.reset_ttl_minutes ??
    DEFAULT_PORTAL_SETTINGS.resetTtlMinutes;

  const inPersonResetTtlMinutes =
    parseEnvBoundedInt(
      process.env.PORTAL_IN_PERSON_RESET_TTL_MINUTES,
      PORTAL_SETTINGS_BOUNDS.inPersonResetTtlMinutes.min,
      PORTAL_SETTINGS_BOUNDS.inPersonResetTtlMinutes.max,
    ) ??
    row?.in_person_reset_ttl_minutes ??
    DEFAULT_PORTAL_SETTINGS.inPersonResetTtlMinutes;

  return {
    operatingMode: storedMode,
    effectiveOperatingMode: effectiveMode,
    productionLaunchLocked: productionLocked,
    allowWhatsappChannel:
      row?.allow_whatsapp_channel ?? DEFAULT_PORTAL_SETTINGS.allowWhatsappChannel,
    allowSmsChannel: row?.allow_sms_channel ?? DEFAULT_PORTAL_SETTINGS.allowSmsChannel,
    allowInPersonChannel:
      row?.allow_in_person_channel ?? DEFAULT_PORTAL_SETTINGS.allowInPersonChannel,
    recoveryPhonePolicy,
    postMergeTargetPolicy,
    activationTtlMinutes,
    resetTtlMinutes,
    inPersonResetTtlMinutes,
    sessionTtlHours: row?.session_ttl_hours ?? DEFAULT_PORTAL_SETTINGS.sessionTtlHours,
    adminPreviewTtlMinutes:
      row?.admin_preview_ttl_minutes ?? DEFAULT_PORTAL_SETTINGS.adminPreviewTtlMinutes,
    maxTokenAttempts: row?.max_token_attempts ?? DEFAULT_PORTAL_SETTINGS.maxTokenAttempts,
    maxFailedLoginAttempts:
      row?.max_failed_login_attempts ?? DEFAULT_PORTAL_SETTINGS.maxFailedLoginAttempts,
    loginFailureWindowMinutes:
      row?.login_failure_window_minutes ?? DEFAULT_PORTAL_SETTINGS.loginFailureWindowMinutes,
    accountLockoutMinutes:
      row?.account_lockout_minutes ?? DEFAULT_PORTAL_SETTINGS.accountLockoutMinutes,
    showProfile: row?.show_profile ?? DEFAULT_PORTAL_SETTINGS.showProfile,
    showAppointments: row?.show_appointments ?? DEFAULT_PORTAL_SETTINGS.showAppointments,
    allowAppointmentConfirm:
      row?.allow_appointment_confirm ?? DEFAULT_PORTAL_SETTINGS.allowAppointmentConfirm,
    showBookingLink: row?.show_booking_link ?? DEFAULT_PORTAL_SETTINGS.showBookingLink,
    showVisits: row?.show_visits ?? DEFAULT_PORTAL_SETTINGS.showVisits,
    showTreatmentPlans: row?.show_treatment_plans ?? DEFAULT_PORTAL_SETTINGS.showTreatmentPlans,
    showStatement: row?.show_statement ?? DEFAULT_PORTAL_SETTINGS.showStatement,
    showPrescriptions: row?.show_prescriptions ?? DEFAULT_PORTAL_SETTINGS.showPrescriptions,
    showDocuments: row?.show_documents ?? DEFAULT_PORTAL_SETTINGS.showDocuments,
    showXrayDocuments: row?.show_xray_documents ?? DEFAULT_PORTAL_SETTINGS.showXrayDocuments,
    showIntake: row?.show_intake ?? DEFAULT_PORTAL_SETTINGS.showIntake,
    showMessages: row?.show_messages ?? DEFAULT_PORTAL_SETTINGS.showMessages,
    allowMessageAttachments:
      row?.allow_message_attachments ?? DEFAULT_PORTAL_SETTINGS.allowMessageAttachments,
    allowVoiceMessages: row?.allow_voice_messages ?? DEFAULT_PORTAL_SETTINGS.allowVoiceMessages,
    showAnnouncements: row?.show_announcements ?? DEFAULT_PORTAL_SETTINGS.showAnnouncements,
    deletedMessageRetentionMode:
      row?.deleted_message_retention_mode ?? DEFAULT_PORTAL_SETTINGS.deletedMessageRetentionMode,
    updatedByUserId: row?.updated_by_user_id ?? null,
    updatedAt: row?.updated_at ? row.updated_at.toISOString() : null,
  };
}

export interface PortalSettingsActor {
  userId: number;
  username: string;
  role: string;
  isActive: boolean;
  isOwner: boolean;
  canConfigurePortalSettings: boolean;
}

function validateBoundedInt(
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number },
  fieldLabel: string,
): { ok: true; value: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value !== "number" || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    return {
      ok: false,
      message: `قيمة «${fieldLabel}» يجب أن تكون عددًا صحيحًا بين ${bounds.min} و ${bounds.max}.`,
    };
  }
  return { ok: true, value };
}

function validateBool(
  value: unknown,
  fallback: boolean,
  fieldLabel: string,
): { ok: true; value: boolean } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value !== "boolean") {
    return { ok: false, message: `قيمة «${fieldLabel}» يجب أن تكون منطقية (صح/خطأ).` };
  }
  return { ok: true, value };
}

function auditSafeSettingsSnapshot(s: PortalSettingsConfig): Record<string, unknown> {
  return {
    operatingMode: s.operatingMode,
    allowWhatsappChannel: s.allowWhatsappChannel,
    allowSmsChannel: s.allowSmsChannel,
    allowInPersonChannel: s.allowInPersonChannel,
    recoveryPhonePolicy: s.recoveryPhonePolicy,
    postMergeTargetPolicy: s.postMergeTargetPolicy,
    activationTtlMinutes: s.activationTtlMinutes,
    resetTtlMinutes: s.resetTtlMinutes,
    inPersonResetTtlMinutes: s.inPersonResetTtlMinutes,
    sessionTtlHours: s.sessionTtlHours,
    adminPreviewTtlMinutes: s.adminPreviewTtlMinutes,
    maxLinkAttempts: s.maxTokenAttempts,
    maxFailedLoginAttempts: s.maxFailedLoginAttempts,
    loginFailureWindowMinutes: s.loginFailureWindowMinutes,
    accountLockoutMinutes: s.accountLockoutMinutes,
    showProfile: s.showProfile,
    showAppointments: s.showAppointments,
    allowAppointmentConfirm: s.allowAppointmentConfirm,
    showBookingLink: s.showBookingLink,
    showVisits: s.showVisits,
    showTreatmentPlans: s.showTreatmentPlans,
    showStatement: s.showStatement,
    showPrescriptions: s.showPrescriptions,
    showDocuments: s.showDocuments,
    showXrayDocuments: s.showXrayDocuments,
    showIntake: s.showIntake,
    showMessages: s.showMessages,
    allowMessageAttachments: s.allowMessageAttachments,
    allowVoiceMessages: s.allowVoiceMessages,
    showAnnouncements: s.showAnnouncements,
    deletedMessageRetentionMode: s.deletedMessageRetentionMode,
  };
}

export async function updatePortalSettings(
  actor: PortalSettingsActor,
  patch: Record<string, unknown>,
): Promise<
  | { ok: true; settings: PortalSettingsConfig }
  | { ok: false; status: number; code?: string; message: string }
> {
  if (!actor.isActive) {
    return { ok: false, status: 401, message: "انتهت الجلسة." };
  }
  if (actor.role !== "admin" || (!actor.isOwner && !actor.canConfigurePortalSettings)) {
    return {
      ok: false,
      status: 403,
      code: "portal_settings_permission_denied",
      message:
        "تعديل إعدادات وسياسات بوابة المريض محصور بمالك العيادة المعتمد أو المدير المخوّل بصلاحية «ضبط إعدادات البوابة» المستقلة.",
    };
  }

  const current = await readPortalSettings();

  let nextMode: PortalOperatingMode = current.operatingMode;
  if (patch.operatingMode !== undefined) {
    if (
      patch.operatingMode !== "disabled" &&
      patch.operatingMode !== "sandbox_test" &&
      patch.operatingMode !== "live_enabled"
    ) {
      return { ok: false, status: 400, message: "وضع تشغيل البوابة غير صالح." };
    }
    nextMode = patch.operatingMode;
  }

  if (nextMode === "live_enabled" && !actor.isOwner) {
    return {
      ok: false,
      status: 403,
      code: "owner_required_for_live_launch",
      message: "إطلاق البوابة الفعلية للمرضى (`live_enabled`) قرار حصري لمالك العيادة المعتمد وحده.",
    };
  }

  if (nextMode === "live_enabled" && isProductionLiveLaunchLocked()) {
    return {
      ok: false,
      status: 403,
      code: "production_launch_locked",
      message:
        "فتح البوابة للمرضى الفعليين في الإنتاج مقفل حاليًا بقرار المالك؛ استعمل وضع الاختبار المعزول (`sandbox_test`) في بيئة الفحص فقط.",
    };
  }

  let nextPhonePolicy: PortalRecoveryPhonePolicy = current.recoveryPhonePolicy;
  if (patch.recoveryPhonePolicy !== undefined) {
    if (
      patch.recoveryPhonePolicy !== "disallow_inline" &&
      patch.recoveryPhonePolicy !== "owner_only" &&
      patch.recoveryPhonePolicy !== "admin_or_owner_only" &&
      patch.recoveryPhonePolicy !== "portal_manager_in_person"
    ) {
      return { ok: false, status: 400, message: "سياسة تغيير الهاتف غير صالحة." };
    }
    nextPhonePolicy = patch.recoveryPhonePolicy;
  }

  let nextMergePolicy: PortalPostMergeTargetPolicy = current.postMergeTargetPolicy;
  if (patch.postMergeTargetPolicy !== undefined) {
    if (
      patch.postMergeTargetPolicy !== "suspend_target" &&
      patch.postMergeTargetPolicy !== "suspend_on_conflict_or_dual" &&
      patch.postMergeTargetPolicy !== "keep_target_revoke_sessions"
    ) {
      return { ok: false, status: 400, message: "سياسة الحساب بعد دمج الملفات غير صالحة." };
    }
    nextMergePolicy = patch.postMergeTargetPolicy;
  }

  if (
    patch.deletedMessageRetentionMode !== undefined &&
    patch.deletedMessageRetentionMode !== "retain_indefinitely_pending_owner_policy"
  ) {
    return {
      ok: false,
      status: 400,
      code: "destructive_retention_not_approved",
      message:
        "الإتلاف التلقائي أو النهائي للرسائل المحذوفة غير معتمد؛ يجب الإبقاء على وضع العهدة المحفوظة إلى أن يعتمد المالك سياسة إتلاف رسمية.",
    };
  }

  const intChecks = {
    activationTtlMinutes: validateBoundedInt(
      patch.activationTtlMinutes,
      current.activationTtlMinutes,
      PORTAL_SETTINGS_BOUNDS.activationTtlMinutes,
      "مدة رابط التفعيل (بالدقائق)",
    ),
    resetTtlMinutes: validateBoundedInt(
      patch.resetTtlMinutes,
      current.resetTtlMinutes,
      PORTAL_SETTINGS_BOUNDS.resetTtlMinutes,
      "مدة رابط الاستعادة الهاتفي (بالدقائق)",
    ),
    inPersonResetTtlMinutes: validateBoundedInt(
      patch.inPersonResetTtlMinutes,
      current.inPersonResetTtlMinutes,
      PORTAL_SETTINGS_BOUNDS.inPersonResetTtlMinutes,
      "مدة رابط الاستعادة الحضوري (بالدقائق)",
    ),
    sessionTtlHours: validateBoundedInt(
      patch.sessionTtlHours,
      current.sessionTtlHours,
      PORTAL_SETTINGS_BOUNDS.sessionTtlHours,
      "مدة جلسة المريض (بالساعات)",
    ),
    adminPreviewTtlMinutes: validateBoundedInt(
      patch.adminPreviewTtlMinutes,
      current.adminPreviewTtlMinutes,
      PORTAL_SETTINGS_BOUNDS.adminPreviewTtlMinutes,
      "مدة العرض الإداري (بالدقائق)",
    ),
    maxTokenAttempts: validateBoundedInt(
      patch.maxTokenAttempts,
      current.maxTokenAttempts,
      PORTAL_SETTINGS_BOUNDS.maxTokenAttempts,
      "حد محاولات الرابط المؤقت",
    ),
    maxFailedLoginAttempts: validateBoundedInt(
      patch.maxFailedLoginAttempts,
      current.maxFailedLoginAttempts,
      PORTAL_SETTINGS_BOUNDS.maxFailedLoginAttempts,
      "حد محاولات الدخول الفاشلة",
    ),
    loginFailureWindowMinutes: validateBoundedInt(
      patch.loginFailureWindowMinutes,
      current.loginFailureWindowMinutes,
      PORTAL_SETTINGS_BOUNDS.loginFailureWindowMinutes,
      "نافذة احتساب محاولات الدخول (بالدقائق)",
    ),
    accountLockoutMinutes: validateBoundedInt(
      patch.accountLockoutMinutes,
      current.accountLockoutMinutes,
      PORTAL_SETTINGS_BOUNDS.accountLockoutMinutes,
      "مدة قفل الحساب المؤقت (بالدقائق)",
    ),
  };

  for (const verdict of Object.values(intChecks)) {
    if (!verdict.ok) return { ok: false, status: 400, message: verdict.message };
  }

  const boolChecks = {
    allowWhatsappChannel: validateBool(patch.allowWhatsappChannel, current.allowWhatsappChannel, "قناة واتساب"),
    allowSmsChannel: validateBool(patch.allowSmsChannel, current.allowSmsChannel, "قناة SMS"),
    allowInPersonChannel: validateBool(patch.allowInPersonChannel, current.allowInPersonChannel, "التسليم الحضوري"),
    showProfile: validateBool(patch.showProfile, current.showProfile, "ملخص الملف الشخصي"),
    showAppointments: validateBool(patch.showAppointments, current.showAppointments, "قسم المواعيد"),
    allowAppointmentConfirm: validateBool(patch.allowAppointmentConfirm, current.allowAppointmentConfirm, "تأكيد حضور المواعيد"),
    showBookingLink: validateBool(patch.showBookingLink, current.showBookingLink, "رابط حجز موعد جديد"),
    showVisits: validateBool(patch.showVisits, current.showVisits, "قسم الزيارات الموقعة"),
    showTreatmentPlans: validateBool(patch.showTreatmentPlans, current.showTreatmentPlans, "قسم خطط العلاج"),
    showStatement: validateBool(patch.showStatement, current.showStatement, "قسم كشف الحساب والفواتير"),
    showPrescriptions: validateBool(patch.showPrescriptions, current.showPrescriptions, "قسم الروشتات الطبية"),
    showDocuments: validateBool(patch.showDocuments, current.showDocuments, "قسم المستندات والتقارير"),
    showXrayDocuments: validateBool(patch.showXrayDocuments, current.showXrayDocuments, "إتاحة صور الأشعة والصور السريرية"),
    showIntake: validateBool(patch.showIntake, current.showIntake, "الاستمارة الصحية"),
    showMessages: validateBool(patch.showMessages, current.showMessages, "المحادثة مع العيادة"),
    allowMessageAttachments: validateBool(patch.allowMessageAttachments, current.allowMessageAttachments, "مرفقات الرسائل"),
    allowVoiceMessages: validateBool(patch.allowVoiceMessages, current.allowVoiceMessages, "الرسائل الصوتية"),
    showAnnouncements: validateBool(patch.showAnnouncements, current.showAnnouncements, "إعلانات وأخبار المركز"),
  };

  for (const verdict of Object.values(boolChecks)) {
    if (!verdict.ok) return { ok: false, status: 400, message: verdict.message };
  }

  const getInt = (k: keyof typeof intChecks) => (intChecks[k] as { ok: true; value: number }).value;
  const getBool = (k: keyof typeof boolChecks) => (boolChecks[k] as { ok: true; value: boolean }).value;

  if (
    !getBool("allowWhatsappChannel") &&
    !getBool("allowSmsChannel") &&
    !getBool("allowInPersonChannel")
  ) {
    return {
      ok: false,
      status: 400,
      message: "يجب إبقاء وسيلة تحقق/تسليم واحدة على الأقل مفعّلة (مثل التحقق الحضوري).",
    };
  }

  await getPool().query(
    `INSERT INTO patient_portal_settings (
       singleton,
       operating_mode,
       allow_whatsapp_channel,
       allow_sms_channel,
       allow_in_person_channel,
       recovery_phone_policy,
       post_merge_target_policy,
       activation_ttl_minutes,
       reset_ttl_minutes,
       in_person_reset_ttl_minutes,
       session_ttl_hours,
       admin_preview_ttl_minutes,
       max_token_attempts,
       max_failed_login_attempts,
       login_failure_window_minutes,
       account_lockout_minutes,
       show_profile,
       show_appointments,
       allow_appointment_confirm,
       show_booking_link,
       show_visits,
       show_treatment_plans,
       show_statement,
       show_prescriptions,
       show_documents,
       show_xray_documents,
       show_intake,
       show_messages,
       allow_message_attachments,
       allow_voice_messages,
       show_announcements,
       deleted_message_retention_mode,
       updated_by_user_id,
       updated_at
     ) VALUES (
       TRUE, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
       $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
       'retain_indefinitely_pending_owner_policy', $31, NOW()
     )
     ON CONFLICT (singleton) DO UPDATE SET
       operating_mode = EXCLUDED.operating_mode,
       allow_whatsapp_channel = EXCLUDED.allow_whatsapp_channel,
       allow_sms_channel = EXCLUDED.allow_sms_channel,
       allow_in_person_channel = EXCLUDED.allow_in_person_channel,
       recovery_phone_policy = EXCLUDED.recovery_phone_policy,
       post_merge_target_policy = EXCLUDED.post_merge_target_policy,
       activation_ttl_minutes = EXCLUDED.activation_ttl_minutes,
       reset_ttl_minutes = EXCLUDED.reset_ttl_minutes,
       in_person_reset_ttl_minutes = EXCLUDED.in_person_reset_ttl_minutes,
       session_ttl_hours = EXCLUDED.session_ttl_hours,
       admin_preview_ttl_minutes = EXCLUDED.admin_preview_ttl_minutes,
       max_token_attempts = EXCLUDED.max_token_attempts,
       max_failed_login_attempts = EXCLUDED.max_failed_login_attempts,
       login_failure_window_minutes = EXCLUDED.login_failure_window_minutes,
       account_lockout_minutes = EXCLUDED.account_lockout_minutes,
       show_profile = EXCLUDED.show_profile,
       show_appointments = EXCLUDED.show_appointments,
       allow_appointment_confirm = EXCLUDED.allow_appointment_confirm,
       show_booking_link = EXCLUDED.show_booking_link,
       show_visits = EXCLUDED.show_visits,
       show_treatment_plans = EXCLUDED.show_treatment_plans,
       show_statement = EXCLUDED.show_statement,
       show_prescriptions = EXCLUDED.show_prescriptions,
       show_documents = EXCLUDED.show_documents,
       show_xray_documents = EXCLUDED.show_xray_documents,
       show_intake = EXCLUDED.show_intake,
       show_messages = EXCLUDED.show_messages,
       allow_message_attachments = EXCLUDED.allow_message_attachments,
       allow_voice_messages = EXCLUDED.allow_voice_messages,
       show_announcements = EXCLUDED.show_announcements,
       deleted_message_retention_mode = EXCLUDED.deleted_message_retention_mode,
       updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = NOW()`,
    [
      nextMode,
      getBool("allowWhatsappChannel"),
      getBool("allowSmsChannel"),
      getBool("allowInPersonChannel"),
      nextPhonePolicy,
      nextMergePolicy,
      getInt("activationTtlMinutes"),
      getInt("resetTtlMinutes"),
      getInt("inPersonResetTtlMinutes"),
      getInt("sessionTtlHours"),
      getInt("adminPreviewTtlMinutes"),
      getInt("maxTokenAttempts"),
      getInt("maxFailedLoginAttempts"),
      getInt("loginFailureWindowMinutes"),
      getInt("accountLockoutMinutes"),
      getBool("showProfile"),
      getBool("showAppointments"),
      getBool("allowAppointmentConfirm"),
      getBool("showBookingLink"),
      getBool("showVisits"),
      getBool("showTreatmentPlans"),
      getBool("showStatement"),
      getBool("showPrescriptions"),
      getBool("showDocuments"),
      getBool("showXrayDocuments"),
      getBool("showIntake"),
      getBool("showMessages"),
      getBool("allowMessageAttachments"),
      getBool("allowVoiceMessages"),
      getBool("showAnnouncements"),
      actor.userId,
    ],
  );

  const updated = await readPortalSettings();
  const prevSnap = auditSafeSettingsSnapshot(current);
  const nextSnap = auditSafeSettingsSnapshot(updated);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(nextSnap)) {
    if (prevSnap[key] !== nextSnap[key]) {
      changes[key] = { from: prevSnap[key], to: nextSnap[key] };
    }
  }

  await recordAudit({
    action: "portal.settings.update",
    entity: "patient_portal_settings",
    entityId: "singleton",
    details: {
      changedCount: Object.keys(changes).length,
      changes,
    },
    actor: actor.username,
    actorRole: actor.role,
  });

  return { ok: true, settings: updated };
}

// ── إعلانات وأخبار المركز في بوابة المريض ─────────────────────────────────────

export interface PortalAnnouncementItem {
  id: number;
  titleAr: string;
  bodyAr: string;
  titleEn: string | null;
  bodyEn: string | null;
  badgeLabel: string | null;
  tone: PortalAnnouncementTone;
  sortOrder: number;
  isActive: boolean;
  isSample: boolean;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PortalAnnouncementRow {
  id: string | number;
  title_ar: string;
  body_ar: string;
  title_en: string | null;
  body_en: string | null;
  badge_label: string | null;
  tone: PortalAnnouncementTone;
  sort_order: number;
  is_active: boolean;
  is_sample: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toAnnouncementItem(row: PortalAnnouncementRow): PortalAnnouncementItem {
  return {
    id: Number(row.id),
    titleAr: row.title_ar,
    bodyAr: row.body_ar,
    titleEn: row.title_en,
    bodyEn: row.body_en,
    badgeLabel: row.badge_label,
    tone: row.tone,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    isSample: row.is_sample,
    startsAt: row.starts_at ? row.starts_at.toISOString() : null,
    endsAt: row.ends_at ? row.ends_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * عناصر تجريبية موسومة بوضوح للمعاينة في بيئة الفحص فقط (عند عدم وجود إعلانات محفوظة)،
 * دون أي عروض طبية أو مؤهلات مختلقة، ولا تظهر أبدًا في وضع الإطلاق الفعلي.
 */
export const SANDBOX_SAMPLE_ANNOUNCEMENTS: readonly PortalAnnouncementItem[] = [
  {
    id: -1,
    titleAr: "متابعة مواعيدكم وسجلاتكم بأمان",
    bodyAr:
      "تتيح لكم بوابة المريض استعراض المواعيد القادمة وتأكيد الحضور والاطلاع على كشف الحساب والروشتات الصادرة من المركز.",
    titleEn: "Secure Access to Your Appointments & Records",
    bodyEn:
      "Review your upcoming visits, confirm attendance, and view your official statement and issued prescriptions.",
    badgeLabel: "نموذج تجريبي — غير منشور",
    tone: "sky",
    sortOrder: 1,
    isActive: true,
    isSample: true,
    startsAt: null,
    endsAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: -2,
    titleAr: "لتفعيل الحساب لأول مرة أو تحديث رقم التواصل",
    bodyAr:
      "حرصًا على خصوصية ملفكم الطبي والعائلي، يُسلّم اسم المستخدم ورابط التفعيل المؤقت عبر استقبال المركز بعد التحقق من الهوية.",
    titleEn: "First-Time Activation & Contact Verification",
    bodyEn:
      "To protect your medical privacy, your username and single-use activation link are issued by reception after identity verification.",
    badgeLabel: "نموذج تجريبي — غير منشور",
    tone: "navy",
    sortOrder: 2,
    isActive: true,
    isSample: true,
    startsAt: null,
    endsAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

export async function listPortalAnnouncementsForPublic(
  settings?: PortalSettingsConfig,
): Promise<PortalAnnouncementItem[]> {
  const cfg = settings ?? (await readPortalSettings());
  if (!cfg.showAnnouncements) return [];

  const hasDbBackend = Boolean(
    process.env.DATABASE_URL?.trim() || process.env.USE_LOCAL_DB === "true",
  );
  if (!hasDbBackend) {
    return cfg.effectiveOperatingMode === "sandbox_test"
      ? [...SANDBOX_SAMPLE_ANNOUNCEMENTS]
      : [];
  }

  const includeSamples = cfg.effectiveOperatingMode !== "live_enabled";
  let rows: PortalAnnouncementRow[] = [];
  try {
    await ensureSchema();
    const res = await getPool().query<PortalAnnouncementRow>(
      `SELECT id, title_ar, body_ar, title_en, body_en, badge_label, tone,
              sort_order, is_active, is_sample, starts_at, ends_at, created_at, updated_at
         FROM patient_portal_announcements
        WHERE is_active = TRUE
          AND ($1::boolean = TRUE OR is_sample = FALSE)
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (ends_at IS NULL OR ends_at > NOW())
        ORDER BY sort_order ASC, id DESC
        LIMIT 12`,
      [includeSamples],
    );
    rows = res.rows;
  } catch {
    rows = [];
  }

  if (rows.length > 0) {
    return rows.map(toAnnouncementItem);
  }
  if (cfg.effectiveOperatingMode === "sandbox_test") {
    return [...SANDBOX_SAMPLE_ANNOUNCEMENTS];
  }
  return [];
}

export async function listPortalAnnouncementsForAdmin(): Promise<PortalAnnouncementItem[]> {
  await ensureSchema();
  const { rows } = await getPool().query<PortalAnnouncementRow>(
    `SELECT id, title_ar, body_ar, title_en, body_en, badge_label, tone,
            sort_order, is_active, is_sample, starts_at, ends_at, created_at, updated_at
       FROM patient_portal_announcements
      ORDER BY sort_order ASC, id DESC
      LIMIT 100`,
  );
  return rows.map(toAnnouncementItem);
}

export interface PortalAnnouncementsActor {
  userId: number;
  username: string;
  role: string;
  isActive: boolean;
  isOwner: boolean;
  canManagePortalAnnouncements: boolean;
}

function parseOptionalIsoDate(
  raw: unknown,
  fieldLabel: string,
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, message: `صيغة تاريخ «${fieldLabel}» غير صالحة.` };
  }
  const d = new Date(raw.trim());
  if (Number.isNaN(d.getTime())) {
    return { ok: false, message: `تاريخ «${fieldLabel}» غير صالح.` };
  }
  return { ok: true, value: d.toISOString() };
}

function validateAnnouncementInput(raw: Record<string, unknown>):
  | {
      ok: true;
      value: {
        titleAr: string;
        bodyAr: string;
        titleEn: string | null;
        bodyEn: string | null;
        badgeLabel: string | null;
        tone: PortalAnnouncementTone;
        sortOrder: number;
        isActive: boolean;
        isSample: boolean;
        startsAt: string | null;
        endsAt: string | null;
      };
    }
  | { ok: false; message: string } {
  const titleAr = typeof raw.titleAr === "string" ? raw.titleAr.trim() : "";
  if (titleAr.length < 2 || titleAr.length > 140) {
    return { ok: false, message: "عنوان الإعلان بالعربية يجب أن يكون بين حرفين و 140 حرفًا." };
  }
  const bodyAr = typeof raw.bodyAr === "string" ? raw.bodyAr.trim() : "";
  if (bodyAr.length < 4 || bodyAr.length > 800) {
    return { ok: false, message: "نص الإعلان بالعربية يجب أن يكون بين 4 و 800 حرف." };
  }
  const titleEnRaw = typeof raw.titleEn === "string" ? raw.titleEn.trim() : "";
  if (titleEnRaw.length > 140) {
    return { ok: false, message: "العنوان الإنجليزي الاختياري لا يتجاوز 140 حرفًا." };
  }
  const bodyEnRaw = typeof raw.bodyEn === "string" ? raw.bodyEn.trim() : "";
  if (bodyEnRaw.length > 800) {
    return { ok: false, message: "النص الإنجليزي الاختياري لا يتجاوز 800 حرف." };
  }
  const badgeRaw = typeof raw.badgeLabel === "string" ? raw.badgeLabel.trim() : "";
  if (badgeRaw.length > 40) {
    return { ok: false, message: "شارة الإعلان الاختيارية لا تتجاوز 40 حرفًا." };
  }
  const toneRaw = raw.tone ?? "sky";
  if (
    toneRaw !== "sky" &&
    toneRaw !== "navy" &&
    toneRaw !== "accent" &&
    toneRaw !== "emerald" &&
    toneRaw !== "amber"
  ) {
    return { ok: false, message: "لون بطاقة الإعلان غير صالح." };
  }
  const sortOrder =
    typeof raw.sortOrder === "number" && Number.isInteger(raw.sortOrder)
      ? Math.max(-999, Math.min(9999, raw.sortOrder))
      : 0;
  const isActive = Boolean(raw.isActive);
  const isSample = Boolean(raw.isSample);

  const startsVerdict = parseOptionalIsoDate(raw.startsAt, "بداية العرض");
  if (!startsVerdict.ok) return startsVerdict;
  const endsVerdict = parseOptionalIsoDate(raw.endsAt, "نهاية العرض");
  if (!endsVerdict.ok) return endsVerdict;
  if (
    startsVerdict.value &&
    endsVerdict.value &&
    new Date(endsVerdict.value).getTime() <= new Date(startsVerdict.value).getTime()
  ) {
    return { ok: false, message: "تاريخ نهاية العرض يجب أن يكون بعد تاريخ بدايته." };
  }

  return {
    ok: true,
    value: {
      titleAr,
      bodyAr,
      titleEn: titleEnRaw || null,
      bodyEn: bodyEnRaw || null,
      badgeLabel: badgeRaw || null,
      tone: toneRaw,
      sortOrder,
      isActive,
      isSample,
      startsAt: startsVerdict.value,
      endsAt: endsVerdict.value,
    },
  };
}

function assertAnnouncementActor(
  actor: PortalAnnouncementsActor,
): { ok: true } | { ok: false; status: number; message: string } {
  if (!actor.isActive) return { ok: false, status: 401, message: "انتهت الجلسة." };
  if (!actor.isOwner && !actor.canManagePortalAnnouncements) {
    return {
      ok: false,
      status: 403,
      message: "غير مصرّح لك بإدارة إعلانات وأخبار بوابة المريض.",
    };
  }
  return { ok: true };
}

export async function createPortalAnnouncement(
  actor: PortalAnnouncementsActor,
  raw: Record<string, unknown>,
): Promise<
  | { ok: true; item: PortalAnnouncementItem }
  | { ok: false; status: number; message: string }
> {
  const auth = assertAnnouncementActor(actor);
  if (!auth.ok) return auth;
  const validated = validateAnnouncementInput(raw);
  if (!validated.ok) return { ok: false, status: 400, message: validated.message };
  const v = validated.value;

  await ensureSchema();
  const { rows: [inserted] } = await getPool().query<PortalAnnouncementRow>(
    `INSERT INTO patient_portal_announcements (
       title_ar, body_ar, title_en, body_en, badge_label, tone,
       sort_order, is_active, is_sample, starts_at, ends_at,
       created_by_user_id, updated_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
     RETURNING *`,
    [
      v.titleAr,
      v.bodyAr,
      v.titleEn,
      v.bodyEn,
      v.badgeLabel,
      v.tone,
      v.sortOrder,
      v.isActive,
      v.isSample,
      v.startsAt,
      v.endsAt,
      actor.userId,
    ],
  );
  const item = toAnnouncementItem(inserted);
  await recordAudit({
    action: "portal.announcement.create",
    entity: "patient_portal_announcements",
    entityId: item.id,
    entityLabel: item.titleAr,
    details: {
      isActive: item.isActive,
      isSample: item.isSample,
      tone: item.tone,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
    },
    actor: actor.username,
    actorRole: actor.role,
  });
  return { ok: true, item };
}

export async function updatePortalAnnouncement(
  actor: PortalAnnouncementsActor,
  id: number,
  raw: Record<string, unknown>,
): Promise<
  | { ok: true; item: PortalAnnouncementItem }
  | { ok: false; status: number; message: string }
> {
  const auth = assertAnnouncementActor(actor);
  if (!auth.ok) return auth;
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, status: 400, message: "معرّف الإعلان غير صالح." };
  }

  await ensureSchema();
  const { rows: [existing] } = await getPool().query<PortalAnnouncementRow>(
    `SELECT * FROM patient_portal_announcements WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (!existing) {
    return { ok: false, status: 404, message: "الإعلان المطلوب غير موجود." };
  }

  const mergedInput: Record<string, unknown> = {
    titleAr: raw.titleAr !== undefined ? raw.titleAr : existing.title_ar,
    bodyAr: raw.bodyAr !== undefined ? raw.bodyAr : existing.body_ar,
    titleEn: raw.titleEn !== undefined ? raw.titleEn : existing.title_en,
    bodyEn: raw.bodyEn !== undefined ? raw.bodyEn : existing.body_en,
    badgeLabel: raw.badgeLabel !== undefined ? raw.badgeLabel : existing.badge_label,
    tone: raw.tone !== undefined ? raw.tone : existing.tone,
    sortOrder: raw.sortOrder !== undefined ? raw.sortOrder : existing.sort_order,
    isActive: raw.isActive !== undefined ? raw.isActive : existing.is_active,
    isSample: raw.isSample !== undefined ? raw.isSample : existing.is_sample,
    startsAt:
      raw.startsAt !== undefined
        ? raw.startsAt
        : existing.starts_at
          ? existing.starts_at.toISOString()
          : null,
    endsAt:
      raw.endsAt !== undefined
        ? raw.endsAt
        : existing.ends_at
          ? existing.ends_at.toISOString()
          : null,
  };

  const validated = validateAnnouncementInput(mergedInput);
  if (!validated.ok) return { ok: false, status: 400, message: validated.message };
  const v = validated.value;

  const { rows: [updated] } = await getPool().query<PortalAnnouncementRow>(
    `UPDATE patient_portal_announcements
        SET title_ar = $2,
            body_ar = $3,
            title_en = $4,
            body_en = $5,
            badge_label = $6,
            tone = $7,
            sort_order = $8,
            is_active = $9,
            is_sample = $10,
            starts_at = $11,
            ends_at = $12,
            updated_by_user_id = $13,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      id,
      v.titleAr,
      v.bodyAr,
      v.titleEn,
      v.bodyEn,
      v.badgeLabel,
      v.tone,
      v.sortOrder,
      v.isActive,
      v.isSample,
      v.startsAt,
      v.endsAt,
      actor.userId,
    ],
  );
  const item = toAnnouncementItem(updated);
  await recordAudit({
    action: "portal.announcement.update",
    entity: "patient_portal_announcements",
    entityId: item.id,
    entityLabel: item.titleAr,
    details: {
      isActive: item.isActive,
      isSample: item.isSample,
      tone: item.tone,
      sortOrder: item.sortOrder,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
    },
    actor: actor.username,
    actorRole: actor.role,
  });
  return { ok: true, item };
}

export async function deletePortalAnnouncement(
  actor: PortalAnnouncementsActor,
  id: number,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const auth = assertAnnouncementActor(actor);
  if (!auth.ok) return auth;
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, status: 400, message: "معرّف الإعلان غير صالح." };
  }
  await ensureSchema();
  const { rows: [deleted] } = await getPool().query<{ title_ar: string }>(
    `DELETE FROM patient_portal_announcements WHERE id = $1 RETURNING title_ar`,
    [id],
  );
  if (!deleted) {
    return { ok: false, status: 404, message: "الإعلان المطلوب غير موجود." };
  }
  await recordAudit({
    action: "portal.announcement.delete",
    entity: "patient_portal_announcements",
    entityId: id,
    entityLabel: deleted.title_ar,
    actor: actor.username,
    actorRole: actor.role,
  });
  return { ok: true };
}

export async function reorderPortalAnnouncements(
  actor: PortalAnnouncementsActor,
  orderedIds: unknown,
): Promise<
  | { ok: true; items: PortalAnnouncementItem[] }
  | { ok: false; status: number; message: string }
> {
  const auth = assertAnnouncementActor(actor);
  if (!auth.ok) return auth;
  if (
    !Array.isArray(orderedIds) ||
    orderedIds.length === 0 ||
    orderedIds.length > 100 ||
    !orderedIds.every((id) => typeof id === "number" && Number.isInteger(id) && id > 0)
  ) {
    return { ok: false, status: 400, message: "قائمة ترتيب الإعلانات غير صالحة." };
  }
  const uniqueIds = [...new Set(orderedIds as number[])];
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < uniqueIds.length; i++) {
      await client.query(
        `UPDATE patient_portal_announcements
            SET sort_order = $2,
                updated_by_user_id = $3,
                updated_at = NOW()
          WHERE id = $1`,
        [uniqueIds[i], i + 1, actor.userId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  await recordAudit({
    action: "portal.announcement.reorder",
    entity: "patient_portal_announcements",
    details: { orderedIds: uniqueIds },
    actor: actor.username,
    actorRole: actor.role,
  });

  const items = await listPortalAnnouncementsForAdmin();
  return { ok: true, items };
}
