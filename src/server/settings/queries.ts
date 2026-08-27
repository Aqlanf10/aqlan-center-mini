import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { clinicSettings, type ClinicSettings } from "@/db/schema";

/** Values used when the settings row is missing / a field is blank. */
export const DEFAULT_CLINIC_SETTINGS = {
  displayName: "",
  defaultRecallIntervalDays: 21,
  whatsappTemplateAr: "",
  whatsappTemplateEn: "",
} as const;

export type ClinicSettingsValues = {
  displayName: string;
  defaultRecallIntervalDays: number;
  whatsappTemplateAr: string;
  whatsappTemplateEn: string;
};

/**
 * Load the settings row, creating it on first read (idempotent, safe to
 * call concurrently — conflicts resolve to a re-read).
 */
export async function getClinicSettingsValues(): Promise<ClinicSettingsValues> {
  let row: ClinicSettings | undefined;
  try {
    [row] = await db
      .select()
      .from(clinicSettings)
      .where(eq(clinicSettings.id, 1))
      .limit(1);
  } catch {
    // Table missing (pre-migration) — fall back to defaults, never crash pages.
    return { ...DEFAULT_CLINIC_SETTINGS };
  }
  if (!row) {
    try {
      [row] = await db.insert(clinicSettings).values({ id: 1 }).returning();
    } catch {
      [row] = await db
        .select()
        .from(clinicSettings)
        .where(eq(clinicSettings.id, 1))
        .limit(1);
    }
  }
  if (!row) return { ...DEFAULT_CLINIC_SETTINGS };
  return {
    displayName: row.displayName ?? "",
    defaultRecallIntervalDays: row.defaultRecallIntervalDays,
    whatsappTemplateAr: row.whatsappTemplateAr ?? "",
    whatsappTemplateEn: row.whatsappTemplateEn ?? "",
  };
}

export const clinicSettingsSchema = z.object({
  displayName: z.string().trim().max(80, "tooLong80"),
  defaultRecallIntervalDays: z.coerce
    .number({ error: "recallInvalid" })
    .int("recallInvalid")
    .min(1, "recallInvalid")
    .max(365, "recallInvalid"),
  whatsappTemplateAr: z.string().trim().max(500, "tooLong500"),
  whatsappTemplateEn: z.string().trim().max(500, "tooLong500"),
});
