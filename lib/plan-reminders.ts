import { parseDoctorPermissions } from "./doctor-permissions";
import { classifyStaffPermissionEnvelope, isPlainCapabilityRecord } from "./staff-permission-envelope";

export type PlanReminderTarget =
  | { kind: "single"; planId: number; installmentNumber?: number }
  | { kind: "bulk"; planIds: number[] };

export type PlanReminderActor = {
  userId: number;
  username: string;
  role: string;
  credentialVersion?: string;
};

export type PlanReminderResult =
  | { ok: true; updatedCount: number; lastReminderAt: string }
  | { ok: false; status: 400 | 401 | 403 | 404 | 409; message: string };

/** Matches the maximum active-plan list; reject oversized batches, never truncate. */
export const MAX_PLAN_REMINDER_BATCH = 300;
export const isPlanReminderId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;

export function canRecordPlanReminder(role: string): boolean {
  return role === "admin" || role === "reception" || role === "doctor";
}

/** Shared HTTP/domain validation: no coercion, discarded targets, or accidental plan-wide fallback. */
export function parsePlanReminderTarget(raw: unknown):
  | { ok: true; target: PlanReminderTarget }
  | { ok: false; status: 400; message: string } {
  const invalid = (message = "طلب تذكير غير صالح.") => ({ ok: false as const, status: 400 as const, message });
  if (!isPlainCapabilityRecord(raw)) return invalid();
  const single = Object.hasOwn(raw, "planId");
  const bulk = Object.hasOwn(raw, "planIds");
  if (single === bulk) return invalid();
  if (bulk) {
    if (Object.hasOwn(raw, "installmentNumber") || (raw.kind !== undefined && raw.kind !== "bulk")) return invalid();
    if (!Array.isArray(raw.planIds) || raw.planIds.length === 0) return invalid("حدد الخطط أولاً.");
    if (raw.planIds.length > MAX_PLAN_REMINDER_BATCH) return invalid("لا يمكن تذكير أكثر من 300 خطة في طلب واحد.");
    // Array.from also exposes sparse-array holes to the domain validation.
    if (!Array.from(raw.planIds).every(isPlanReminderId)) return invalid("معرف الخطة غير صحيح.");
    return { ok: true, target: { kind: "bulk", planIds: [...new Set(raw.planIds)].sort((a, b) => a - b) } };
  }
  if ((raw.kind !== undefined && raw.kind !== "single") || !isPlanReminderId(raw.planId)) {
    return invalid("معرف الخطة غير صحيح.");
  }
  if (Object.hasOwn(raw, "installmentNumber") && !isPlanReminderId(raw.installmentNumber)) {
    return invalid("رقم القسط غير صحيح.");
  }
  return { ok: true, target: { kind: "single", planId: raw.planId,
    ...(Object.hasOwn(raw, "installmentNumber") ? { installmentNumber: raw.installmentNumber as number } : {}),
  } };
}

/**
 * Validate storage before the existing legacy permission policy supplies defaults.
 * NULL/empty legacy storage keeps its intended defaults. Corrupt envelopes and
 * invalid canEditPlans values never become doctor grants. Admin/reception keep
 * their existing role-only authority; future granular staff capabilities are inert.
 */
export function hasPlanReminderAuthority(raw: unknown, role: string): boolean {
  if (!canRecordPlanReminder(role)) return false;
  if (role === "admin" || role === "reception") return true;
  const envelope = classifyStaffPermissionEnvelope(raw);
  if (envelope.kind !== "legacy") return false;
  if (envelope.value && Object.hasOwn(envelope.value, "canEditPlans")
    && typeof envelope.value.canEditPlans !== "boolean") return false;
  return parseDoctorPermissions(envelope.value, role).canEditPlans === true;
}
