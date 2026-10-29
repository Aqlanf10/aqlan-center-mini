import type { StaffCapability } from "./staff-capability-catalogue";

/**
 * Per-key write policy for clinic settings under the canonical runtime (M2, Dot review
 * 6480538845 item 1). Category labels are display only: every key is classified here,
 * exactly once, and a write is admitted only when the actor holds the requirement of
 * EVERY key in the batch.
 *
 * Classes:
 *  - operational: `settings.operational.edit`;
 *  - finance: `settings.finance.edit`;
 *  - authority: owner-only `settings.security.change`. The value changes who may do
 *    what (for example the doctor financial view, reception opening balances), so it is
 *    an authority write, never an operational one;
 *  - integration: owner-only `settings.integrations.change`. The value sends data out
 *    of the clinic (automatic messages, consent mode, external AI);
 *  - backup: owner-only `clinic.backup.manage` (proposed owner operation).
 * Operational never inherits authority, integration or backup writes.
 *
 * Batch rule for the canonical PATCH/POST (implemented with the settings slice, M2
 * step 7; acceptance in M2_ROUTE_CAPABILITY_MAP.md §5):
 *  - every key must be known; an unknown key refuses the whole batch;
 *  - every key's requirement must hold; one refused key refuses the whole batch with
 *    no partial write;
 *  - the existing expected-version CAS and the audit row stay in the same transaction
 *    as the writes.
 * `forReview` marks classifications the owner should confirm (they do not widen access:
 * each is the narrowest class that keeps today's legitimate editors).
 */
export type SettingWriteClass = "operational" | "finance" | "authority" | "integration" | "backup";
export type OwnerOnlySettingOperation = "settings.security.change" | "settings.integrations.change" | "clinic.backup.manage";

export const SETTING_WRITE_REQUIREMENT: Readonly<Record<SettingWriteClass, { readonly capability: StaffCapability } | { readonly ownerOnly: OwnerOnlySettingOperation }>> = Object.freeze({
  operational: Object.freeze({ capability: "settings.operational.edit" }),
  finance: Object.freeze({ capability: "settings.finance.edit" }),
  authority: Object.freeze({ ownerOnly: "settings.security.change" }),
  integration: Object.freeze({ ownerOnly: "settings.integrations.change" }),
  backup: Object.freeze({ ownerOnly: "clinic.backup.manage" }),
});

interface KeyClass { readonly class: SettingWriteClass; readonly forReview?: string }
const k = (cls: SettingWriteClass, forReview?: string): KeyClass => Object.freeze(forReview ? { class: cls, forReview } : { class: cls });

export const SETTING_KEY_CLASSES: Readonly<Record<string, KeyClass>> = Object.freeze({
  // Clinic identity printed on every report (owner decision on report identity).
  "clinic.name": k("operational", "Report identity: confirm delegates may edit it, or make it owner-only."),
  "clinic.lead_doctor": k("operational", "Report identity: confirm delegates may edit it, or make it owner-only."),
  "clinic.lead_doctor_title": k("operational", "Report identity: confirm delegates may edit it, or make it owner-only."),
  "clinic.lead_doctor_credentials": k("operational", "Report identity: confirm delegates may edit it, or make it owner-only."),
  "clinic.phone": k("operational"),
  "clinic.address": k("operational"),
  "display.tagline": k("operational"),
  // Hours, capacity and scheduling.
  "clinic.day_start": k("operational"), "clinic.day_end": k("operational"),
  "clinic.shift2_start": k("operational"), "clinic.shift2_end": k("operational"),
  "clinic.chairs": k("operational"),
  "scheduling.max_days_ahead": k("operational"), "scheduling.emergency_reserve_minutes": k("operational"),
  "scheduling.new_patient_daily_limit": k("operational"), "scheduling.waiting_list_hold_days": k("operational"),
  "scheduling.near_capacity_percent": k("operational"), "lab.default_days": k("operational"),
  // Patient workflow, reception and waiting-room display.
  "patients.referral_sources": k("operational"), "patients.flags": k("operational"),
  "followup.proposal_days": k("operational"), "recall.lapse_weeks": k("operational"), "ops.follow_up_lookback_days": k("operational"),
  "display.privacy_mode": k("operational", "Waiting-room privacy: confirm delegates may relax it."),
  "display.voice": k("operational"), "display.delay_notice": k("operational"), "display.show_ortho": k("operational"),
  "display.announcements": k("operational"),
  "ops.late_tolerance_minutes": k("operational"), "ops.wait_warning_minutes": k("operational"), "ops.wait_critical_minutes": k("operational"),
  "ops.require_clearance_before_call": k("operational"),
  "reception.balance_warning_minor": k("finance"),
  // Clinical working references.
  "clinical.phrases_complaint": k("operational"), "clinical.phrases_exam": k("operational"),
  "clinical.phrases_diagnosis": k("operational"), "clinical.phrases_next": k("operational"),
  "plans.specialty_templates": k("operational"), "ortho.adjustment_service_ids": k("finance"),
  "clinical.medical_history_review_months": k("operational"), "documents.max_megabytes": k("operational"),
  "inventory.expiry_soon_days": k("operational"),
  // Finance.
  "finance.base_currency": k("finance"), "finance.rate.SAR": k("finance"), "finance.rate.USD": k("finance"),
  "finance.rate_max_age_days": k("finance"), "finance.locked_before": k("finance"),
  "finance.commission_material_rate": k("finance"), "billing.max_discount_percent": k("finance"),
  "documents.invoice_prefix": k("finance"), "documents.receipt_prefix": k("finance"),
  "documents.voucher_prefix": k("finance"), "documents.reversal_prefix": k("finance"),
  // Authority semantics: the value decides who may do what.
  "workflow.doctor_financial_view": k("authority"),
  "finance.reception_adds_opening_balance": k("authority"),
  // Integrations: the value sends data out of the clinic.
  "reminders.auto_enabled": k("integration"), "messaging.consent_mode": k("integration"),
  "reminders.auto_template": k("integration"), "reminders.auto_language": k("integration"),
  "ai.clinical_external": k("integration"),
  // Backup.
  "backup.enabled": k("backup"), "backup.schedule_enabled": k("backup"), "backup.schedule_time": k("backup"),
  "backup.schedule_timezone": k("backup"), "backup.retention_daily_count": k("backup"),
  "backup.retention_weekly_count": k("backup"), "backup.destination_railway_volume": k("backup"),
  "backup.destination_s3": k("backup"), "backup.destination_google_drive": k("backup"),
});

export type SettingBatchRequirement =
  | { readonly ok: true; readonly capabilities: readonly StaffCapability[]; readonly ownerOnly: readonly OwnerOnlySettingOperation[] }
  | { readonly ok: false; readonly reason: "unknown_setting_key"; readonly key: string };

/** The whole batch's requirement: every key's, or a refusal naming the first unknown key. */
export function settingBatchRequirement(keys: readonly string[]): SettingBatchRequirement {
  const capabilities = new Set<StaffCapability>(), ownerOnly = new Set<OwnerOnlySettingOperation>();
  for (const key of keys) {
    const entry = Object.prototype.hasOwnProperty.call(SETTING_KEY_CLASSES, key) ? SETTING_KEY_CLASSES[key] : undefined;
    if (!entry) return { ok: false, reason: "unknown_setting_key", key };
    const requirement = SETTING_WRITE_REQUIREMENT[entry.class];
    if ("capability" in requirement) capabilities.add(requirement.capability);
    else ownerOnly.add(requirement.ownerOnly);
  }
  return { ok: true, capabilities: [...capabilities].sort(), ownerOnly: [...ownerOnly].sort() };
}
