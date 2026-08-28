CREATE SEQUENCE "public"."patient_file_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_patient_id_patients_id_fk";
--> statement-breakpoint
ALTER TABLE "charges" DROP CONSTRAINT "charges_patient_id_patients_id_fk";
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_patient_id_patients_id_fk";
--> statement-breakpoint
ALTER TABLE "visits" DROP CONSTRAINT "visits_patient_id_patients_id_fk";
--> statement-breakpoint
ALTER TABLE "patient_contacts" DROP CONSTRAINT "patient_contacts_patient_id_patients_id_fk";
--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "treatment_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "treatment_status" SET DEFAULT 'NEW'::text;--> statement-breakpoint
DROP TYPE "public"."treatment_status";--> statement-breakpoint
CREATE TYPE "public"."treatment_status" AS ENUM('NEW', 'ACTIVE', 'RETENTION', 'COMPLETED', 'PAUSED');--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "treatment_status" SET DEFAULT 'NEW'::"public"."treatment_status";--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "treatment_status" SET DATA TYPE "public"."treatment_status" USING (CASE "treatment_status"::text WHEN 'ON_HOLD' THEN 'PAUSED'::"public"."treatment_status" WHEN 'ARCHIVED' THEN 'COMPLETED'::"public"."treatment_status" WHEN 'NEW' THEN 'NEW'::"public"."treatment_status" WHEN 'ACTIVE' THEN 'ACTIVE'::"public"."treatment_status" WHEN 'RETENTION' THEN 'RETENTION'::"public"."treatment_status" WHEN 'COMPLETED' THEN 'COMPLETED'::"public"."treatment_status" WHEN 'PAUSED' THEN 'PAUSED'::"public"."treatment_status" ELSE 'ACTIVE'::"public"."treatment_status" END);--> statement-breakpoint
ALTER TABLE "visits" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "visits" ALTER COLUMN "status" SET DEFAULT 'DRAFT'::text;--> statement-breakpoint
DROP TYPE "public"."visit_status";--> statement-breakpoint
CREATE TYPE "public"."visit_status" AS ENUM('DRAFT', 'COMPLETED');--> statement-breakpoint
ALTER TABLE "visits" ALTER COLUMN "status" SET DEFAULT 'DRAFT'::"public"."visit_status";--> statement-breakpoint
ALTER TABLE "visits" ALTER COLUMN "status" SET DATA TYPE "public"."visit_status" USING (CASE "status"::text WHEN 'IN_PROGRESS' THEN 'DRAFT'::"public"."visit_status" WHEN 'CANCELLED' THEN 'DRAFT'::"public"."visit_status" WHEN 'DRAFT' THEN 'DRAFT'::"public"."visit_status" ELSE 'COMPLETED'::"public"."visit_status" END);--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "recall_interval_days" SET DEFAULT 21;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "impersonated_by" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "banned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ban_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ban_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_contacts" ADD CONSTRAINT "patient_contacts_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_doctor_time_active_unique" ON "appointments" USING btree ("doctor_id","appointment_date") WHERE status IN ('SCHEDULED', 'CONFIRMED', 'ARRIVED', 'IN_TREATMENT');