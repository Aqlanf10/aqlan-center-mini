CREATE TYPE "public"."cash_account_type" AS ENUM('CASH', 'BANK');--> statement-breakpoint
CREATE TYPE "public"."commission_basis" AS ENUM('WORK_VALUE', 'COLLECTED');--> statement-breakpoint
CREATE TYPE "public"."commission_status" AS ENUM('PENDING', 'APPROVED', 'PAID', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."commission_type" AS ENUM('PERCENT', 'FIXED');--> statement-breakpoint
CREATE TYPE "public"."lab_case_status" AS ENUM('ORDERED', 'SENT', 'RECEIVED', 'DELIVERED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."party_type" AS ENUM('PATIENT', 'DOCTOR', 'LAB', 'SUPPLIER', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('CASH', 'TRANSFER', 'CARD', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."purchase_invoice_status" AS ENUM('ACTIVE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."voucher_status" AS ENUM('ACTIVE', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."voucher_type" AS ENUM('RECEIPT', 'PAYMENT');--> statement-breakpoint
CREATE TYPE "public"."work_item_status" AS ENUM('ACTIVE', 'CANCELLED');--> statement-breakpoint
CREATE SEQUENCE "public"."lab_case_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."purchase_invoice_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "commissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doctor_id" uuid NOT NULL,
	"work_item_id" uuid,
	"source_voucher_id" uuid,
	"basis" "commission_basis" NOT NULL,
	"plan_type" "commission_type",
	"plan_value" numeric(12, 2),
	"base_amount" numeric(12, 2) NOT NULL,
	"currency" "currency" NOT NULL,
	"amount" numeric(12, 2),
	"status" "commission_status" DEFAULT 'PENDING' NOT NULL,
	"paid_voucher_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"reversal_reason" text,
	"reversed_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commissions_base_positive" CHECK ("commissions"."base_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "doctor_commission_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doctor_id" uuid NOT NULL,
	"service_id" uuid,
	"basis" "commission_basis" DEFAULT 'WORK_VALUE' NOT NULL,
	"type" "commission_type" NOT NULL,
	"value" numeric(12, 2) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doctor_commission_plans_value_positive" CHECK ("doctor_commission_plans"."value" > 0)
);
--> statement-breakpoint
CREATE TABLE "cash_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"currency" "currency" NOT NULL,
	"type" "cash_account_type" DEFAULT 'CASH' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voucher_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "voucher_type" NOT NULL,
	"year" integer NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "voucher_type" NOT NULL,
	"voucher_number" text NOT NULL,
	"party_type" "party_type" NOT NULL,
	"patient_id" uuid,
	"doctor_id" uuid,
	"lab_id" uuid,
	"supplier_id" uuid,
	"other_party_name" text,
	"lab_case_id" uuid,
	"purchase_invoice_id" uuid,
	"commission_id" uuid,
	"expense_category_id" uuid,
	"amount" numeric(12, 2) NOT NULL,
	"currency" "currency" NOT NULL,
	"cash_account_id" uuid NOT NULL,
	"payment_method" "payment_method" DEFAULT 'CASH' NOT NULL,
	"voucher_date" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text,
	"reference" text,
	"status" "voucher_status" DEFAULT 'ACTIVE' NOT NULL,
	"reversal_of_voucher_id" uuid,
	"reversal_reason" text,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vouchers_amount_positive" CHECK ("vouchers"."amount" > 0),
	CONSTRAINT "vouchers_receipt_party" CHECK ("vouchers"."type" = 'PAYMENT' OR ("vouchers"."patient_id" IS NOT NULL OR "vouchers"."other_party_name" IS NOT NULL)),
	CONSTRAINT "vouchers_payment_party" CHECK ("vouchers"."type" = 'RECEIPT' OR ("vouchers"."doctor_id" IS NOT NULL OR "vouchers"."lab_id" IS NOT NULL OR "vouchers"."supplier_id" IS NOT NULL OR "vouchers"."other_party_name" IS NOT NULL)),
	CONSTRAINT "vouchers_other_party_category" CHECK ("vouchers"."party_type" <> 'OTHER' OR "vouchers"."expense_category_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" smallint DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"category_id" uuid,
	"default_price" numeric(12, 2),
	"currency" "currency" DEFAULT 'YER' NOT NULL,
	"commission_eligible" boolean DEFAULT false NOT NULL,
	"default_commission_type" "commission_type",
	"default_commission_value" numeric(12, 2),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visit_work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visit_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"quantity" numeric(10, 2) DEFAULT '1' NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	"discount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"currency" "currency" DEFAULT 'YER' NOT NULL,
	"notes" text,
	"status" "work_item_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visit_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visit_id" uuid NOT NULL,
	"note" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_number" text NOT NULL,
	"lab_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"visit_id" uuid,
	"doctor_id" uuid NOT NULL,
	"service_id" uuid,
	"work_type" text NOT NULL,
	"cost" numeric(12, 2) NOT NULL,
	"currency" "currency" DEFAULT 'YER' NOT NULL,
	"status" "lab_case_status" DEFAULT 'ORDERED' NOT NULL,
	"sent_at" timestamp with time zone,
	"expected_delivery_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"invoiced" boolean DEFAULT false NOT NULL,
	"invoice_number" text,
	"invoice_amount" numeric(12, 2),
	"invoiced_at" timestamp with time zone,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_cases_cost_positive" CHECK ("lab_cases"."cost" > 0)
);
--> statement-breakpoint
CREATE TABLE "labs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"address" text,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	"unit" text,
	"default_supplier_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"quantity" numeric(10, 2) NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	"discount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total" numeric(12, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_ref" text,
	"invoice_date" timestamp with time zone DEFAULT now() NOT NULL,
	"currency" "currency" NOT NULL,
	"total_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"status" "purchase_invoice_status" DEFAULT 'ACTIVE' NOT NULL,
	"cancel_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_invoices_total_positive" CHECK ("purchase_invoices"."total_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"address" text,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "voucher_id" uuid;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_doctor_id_users_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_work_item_id_visit_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."visit_work_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_source_voucher_id_vouchers_id_fk" FOREIGN KEY ("source_voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_paid_voucher_id_vouchers_id_fk" FOREIGN KEY ("paid_voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_commission_plans" ADD CONSTRAINT "doctor_commission_plans_doctor_id_users_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_commission_plans" ADD CONSTRAINT "doctor_commission_plans_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_doctor_id_users_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_lab_case_id_lab_cases_id_fk" FOREIGN KEY ("lab_case_id") REFERENCES "public"."lab_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_purchase_invoice_id_purchase_invoices_id_fk" FOREIGN KEY ("purchase_invoice_id") REFERENCES "public"."purchase_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_expense_category_id_expense_categories_id_fk" FOREIGN KEY ("expense_category_id") REFERENCES "public"."expense_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_cash_account_id_cash_accounts_id_fk" FOREIGN KEY ("cash_account_id") REFERENCES "public"."cash_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_reversal_of_voucher_id_vouchers_id_fk" FOREIGN KEY ("reversal_of_voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_category_id_service_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."service_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_work_items" ADD CONSTRAINT "visit_work_items_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_work_items" ADD CONSTRAINT "visit_work_items_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_work_items" ADD CONSTRAINT "visit_work_items_doctor_id_users_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_work_items" ADD CONSTRAINT "visit_work_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_corrections" ADD CONSTRAINT "visit_corrections_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_corrections" ADD CONSTRAINT "visit_corrections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_cases" ADD CONSTRAINT "lab_cases_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "public"."labs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_cases" ADD CONSTRAINT "lab_cases_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_cases" ADD CONSTRAINT "lab_cases_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_cases" ADD CONSTRAINT "lab_cases_doctor_id_users_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_cases" ADD CONSTRAINT "lab_cases_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_cases" ADD CONSTRAINT "lab_cases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "materials" ADD CONSTRAINT "materials_default_supplier_id_suppliers_id_fk" FOREIGN KEY ("default_supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_invoice_items" ADD CONSTRAINT "purchase_invoice_items_invoice_id_purchase_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."purchase_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_invoice_items" ADD CONSTRAINT "purchase_invoice_items_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commissions_doctor_idx" ON "commissions" USING btree ("doctor_id");--> statement-breakpoint
CREATE INDEX "commissions_status_idx" ON "commissions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "commissions_work_item_idx" ON "commissions" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "commissions_source_voucher_idx" ON "commissions" USING btree ("source_voucher_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commissions_work_item_unique" ON "commissions" USING btree ("work_item_id") WHERE basis = 'WORK_VALUE' AND work_item_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "commissions_collected_unique" ON "commissions" USING btree ("work_item_id","source_voucher_id") WHERE basis = 'COLLECTED' AND work_item_id IS NOT NULL AND source_voucher_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "doctor_commission_plans_doctor_idx" ON "doctor_commission_plans" USING btree ("doctor_id");--> statement-breakpoint
CREATE INDEX "doctor_commission_plans_service_idx" ON "doctor_commission_plans" USING btree ("service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_commission_plans_doctor_service_unique" ON "doctor_commission_plans" USING btree ("doctor_id","service_id");--> statement-breakpoint
CREATE INDEX "cash_accounts_active_idx" ON "cash_accounts" USING btree ("active");--> statement-breakpoint
CREATE INDEX "cash_accounts_currency_idx" ON "cash_accounts" USING btree ("currency");--> statement-breakpoint
CREATE INDEX "expense_categories_active_idx" ON "expense_categories" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "voucher_counters_kind_year_unique" ON "voucher_counters" USING btree ("kind","year");--> statement-breakpoint
CREATE UNIQUE INDEX "vouchers_number_unique" ON "vouchers" USING btree ("voucher_number");--> statement-breakpoint
CREATE INDEX "vouchers_type_date_idx" ON "vouchers" USING btree ("type","voucher_date");--> statement-breakpoint
CREATE INDEX "vouchers_party_idx" ON "vouchers" USING btree ("party_type","patient_id","doctor_id");--> statement-breakpoint
CREATE INDEX "vouchers_cash_account_idx" ON "vouchers" USING btree ("cash_account_id");--> statement-breakpoint
CREATE INDEX "vouchers_status_idx" ON "vouchers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "vouchers_lab_case_idx" ON "vouchers" USING btree ("lab_case_id");--> statement-breakpoint
CREATE INDEX "vouchers_purchase_invoice_idx" ON "vouchers" USING btree ("purchase_invoice_id");--> statement-breakpoint
CREATE INDEX "vouchers_commission_idx" ON "vouchers" USING btree ("commission_id");--> statement-breakpoint
CREATE INDEX "idempotency_keys_entity_idx" ON "idempotency_keys" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "service_categories_active_idx" ON "service_categories" USING btree ("active","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "services_code_unique" ON "services" USING btree ("code");--> statement-breakpoint
CREATE INDEX "services_active_idx" ON "services" USING btree ("active");--> statement-breakpoint
CREATE INDEX "services_category_id_idx" ON "services" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "visit_work_items_visit_id_idx" ON "visit_work_items" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "visit_work_items_service_id_idx" ON "visit_work_items" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "visit_work_items_doctor_id_idx" ON "visit_work_items" USING btree ("doctor_id");--> statement-breakpoint
CREATE INDEX "visit_work_items_status_idx" ON "visit_work_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "visit_corrections_visit_id_idx" ON "visit_corrections" USING btree ("visit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_cases_number_unique" ON "lab_cases" USING btree ("case_number");--> statement-breakpoint
CREATE INDEX "lab_cases_lab_id_idx" ON "lab_cases" USING btree ("lab_id");--> statement-breakpoint
CREATE INDEX "lab_cases_patient_id_idx" ON "lab_cases" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "lab_cases_doctor_id_idx" ON "lab_cases" USING btree ("doctor_id");--> statement-breakpoint
CREATE INDEX "lab_cases_status_idx" ON "lab_cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "labs_active_idx" ON "labs" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "materials_code_unique" ON "materials" USING btree ("code");--> statement-breakpoint
CREATE INDEX "materials_active_idx" ON "materials" USING btree ("active");--> statement-breakpoint
CREATE INDEX "materials_supplier_idx" ON "materials" USING btree ("default_supplier_id");--> statement-breakpoint
CREATE INDEX "purchase_invoice_items_invoice_idx" ON "purchase_invoice_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_invoices_number_unique" ON "purchase_invoices" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX "purchase_invoices_supplier_idx" ON "purchase_invoices" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "purchase_invoices_status_idx" ON "purchase_invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "suppliers_active_idx" ON "suppliers" USING btree ("active");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_voucher_id_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Safety pre-step for the one-visit-per-appointment constraint: if history
-- somehow contains more than one visit linked to the same appointment, keep
-- the earliest visit's link and detach the later duplicates (visit rows and
-- clinical data are NEVER deleted — only the appointment link is cleared).
UPDATE "visits" SET "appointment_id" = NULL
WHERE "appointment_id" IS NOT NULL
  AND "id" <> (
    SELECT v2."id" FROM "visits" v2
    WHERE v2."appointment_id" = "visits"."appointment_id"
    ORDER BY v2."created_at" ASC, v2."id" ASC
    LIMIT 1
  );--> statement-breakpoint
CREATE UNIQUE INDEX "visits_appointment_unique" ON "visits" USING btree ("appointment_id") WHERE appointment_id IS NOT NULL;--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Seed: editable initial service categories (التصنيفات الأولية).
-- Idempotent inserts — safe on every environment.
-- ---------------------------------------------------------------------------
INSERT INTO "service_categories" ("name_ar", "name_en", "sort_order") VALUES
  ('فحص واستشارة', 'Examination & Consultation', 10),
  ('تقويم ومتابعة تقويم', 'Orthodontics & Follow-up', 20),
  ('تركيب تقويم', 'Braces Installation', 30),
  ('مثبتات', 'Retainers', 40),
  ('تنظيف', 'Cleaning', 50),
  ('حشوات', 'Fillings', 60),
  ('علاج عصب', 'Root Canal Treatment', 70),
  ('خلع وجراحة', 'Extraction & Surgery', 80),
  ('تركيبات وتيجان وجسور', 'Prosthodontics, Crowns & Bridges', 90),
  ('زراعة', 'Implants', 100),
  ('تبييض وتجميل', 'Whitening & Cosmetic', 110),
  ('أشعة', 'Radiology', 120),
  ('عمل معمل', 'Lab Work', 130),
  ('خدمة أخرى', 'Other Service', 140);--> statement-breakpoint
-- Seed: editable initial expense categories.
INSERT INTO "expense_categories" ("name_ar", "name_en") VALUES
  ('رواتب وأجور', 'Salaries & Wages'),
  ('إيجار', 'Rent'),
  ('كهرباء ومياه', 'Utilities'),
  ('مواد ومستلزمات', 'Materials & Supplies'),
  ('صيانة وأصول', 'Maintenance & Assets'),
  ('تسويق', 'Marketing'),
  ('اتصالات وإنترنت', 'Communications & Internet'),
  ('نقل ومواصلات', 'Transport'),
  ('ضيافة', 'Hospitality'),
  ('مصروفات أخرى', 'Other Expenses');--> statement-breakpoint
-- Seed: one default cash box per currency (editable/archivable by ADMIN;
-- treasury history starts empty — legacy payments are never back-filled
-- into invented accounts).
INSERT INTO "cash_accounts" ("name", "currency", "type") VALUES
  ('الصندوق الرئيسي - ريال', 'YER', 'CASH'),
  ('الصندوق الرئيسي - دولار', 'USD', 'CASH'),
  ('الصندوق الرئيسي - ريال سعودي', 'SAR', 'CASH');