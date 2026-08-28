CREATE TABLE "clinic_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"default_recall_interval_days" integer DEFAULT 21 NOT NULL,
	"whatsapp_template_ar" text DEFAULT '' NOT NULL,
	"whatsapp_template_en" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone
);
