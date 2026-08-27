import { db } from "@/lib/db";
import { auditLogs } from "@/db/schema";

/**
 * Audit log actions recorded across the application.
 * Append-only trail: actor, entity, entity id, timestamp, safe metadata.
 * Passwords, hashes and secrets are NEVER written to metadata.
 */
export const AUDIT_ACTIONS = {
  PATIENT_CREATED: "PATIENT_CREATED",
  PATIENT_UPDATED: "PATIENT_UPDATED",
  PATIENT_ARCHIVED: "PATIENT_ARCHIVED",
  PATIENT_REACTIVATED: "PATIENT_REACTIVATED",
  APPOINTMENT_CREATED: "APPOINTMENT_CREATED",
  APPOINTMENT_RESCHEDULED: "APPOINTMENT_RESCHEDULED",
  APPOINTMENT_STATUS_CHANGED: "APPOINTMENT_STATUS_CHANGED",
  VISIT_CREATED: "VISIT_CREATED",
  VISIT_COMPLETED: "VISIT_COMPLETED",
  PATIENT_CONTACTED: "PATIENT_CONTACTED",
  PAYMENT_CREATED: "PAYMENT_CREATED",
  CHARGE_CREATED: "CHARGE_CREATED",
  USER_CREATED: "USER_CREATED",
  USER_UPDATED: "USER_UPDATED",
  USER_DEACTIVATED: "USER_DEACTIVATED",
  USER_ACTIVATED: "USER_ACTIVATED",
  USER_PASSWORD_CHANGED: "USER_PASSWORD_CHANGED",
  USER_PASSWORD_RESET: "USER_PASSWORD_RESET",
  CLINIC_SETTINGS_UPDATED: "CLINIC_SETTINGS_UPDATED",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export type AuditInput = {
  userId: string;
  action: AuditAction;
  entityType: "patient" | "appointment" | "visit" | "contact" | "payment" | "charge" | "user" | "settings";
  entityId: string;
  metadata?: Record<string, unknown>;
};

/**
 * Record an audit entry. Intentionally best-effort after the main write:
 * a failing audit insert must not roll back the clinical operation — it is
 * fired inside the same batch when atomicity matters, or right after.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  await db.insert(auditLogs).values({
    userId: input.userId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: input.metadata,
  });
}
