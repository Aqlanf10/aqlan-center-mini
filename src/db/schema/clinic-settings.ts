import { integer, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Single-row clinic operational settings (id = 1).
 *
 * Simple owner-editable values only — the timezone stays in the
 * environment (Asia/Aden) on purpose. Empty strings mean "not set",
 * callers fall back to the built-in defaults.
 */
export const clinicSettings = pgTable("clinic_settings", {
  id: smallint("id").primaryKey().default(1),
  /** Display name shown in the sidebar / WhatsApp messages. */
  displayName: text("display_name").notNull().default(""),
  /** Default recall interval for new patients (days). */
  defaultRecallIntervalDays: integer("default_recall_interval_days")
    .notNull()
    .default(21),
  /** Arabic WhatsApp follow-up template ({name}, {center} placeholders). */
  whatsappTemplateAr: text("whatsapp_template_ar").notNull().default(""),
  /** English WhatsApp follow-up template ({name}, {center} placeholders). */
  whatsappTemplateEn: text("whatsapp_template_en").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

export type ClinicSettings = typeof clinicSettings.$inferSelect;
export type NewClinicSettings = typeof clinicSettings.$inferInsert;
