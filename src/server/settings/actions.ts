"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { clinicSettings } from "@/db/schema";
import { requireRole } from "@/lib/auth/guards";
import { validateWith } from "@/lib/validation";
import { AUDIT_ACTIONS, recordAudit } from "@/server/audit";
import { clinicSettingsSchema } from "@/server/settings/queries";
import { failure, success, type ActionResult } from "@/server/types";

/** ADMIN-only update of the single settings row. Audited, idempotent. */
export async function updateClinicSettingsAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const user = await requireRole(["ADMIN"], "/settings/clinic");

  const validation = validateWith(clinicSettingsSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }
  const data = validation.data;

  try {
    await db
      .insert(clinicSettings)
      .values({ id: 1, ...data, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: clinicSettings.id,
        set: { ...data, updatedAt: new Date() },
      });
  } catch {
    return failure("common.serverError");
  }

  try {
    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.CLINIC_SETTINGS_UPDATED,
      entityType: "settings",
      entityId: user.id,
      metadata: {
        displayName: data.displayName,
        defaultRecallIntervalDays: data.defaultRecallIntervalDays,
      },
    });
  } catch {
    // audit is best-effort; the settings write already succeeded
  }

  revalidatePath("/settings/clinic");
  revalidatePath("/follow-up");
  revalidatePath("/dashboard");
  return success("settingsClinic.saved");
}
