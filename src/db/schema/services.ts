import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  commissionTypeEnum,
  currencyEnum,
  workItemStatusEnum,
} from "./enums";
import { visits } from "./visits";
import { users } from "./users";

/**
 * Admin-managed service categories (تصنيفات الخدمات).
 * Editable rows — deliberately NOT a hard enum so the clinic can add,
 * rename and archive categories without code changes.
 */
export const serviceCategories = pgTable(
  "service_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nameAr: text("name_ar").notNull(),
    nameEn: text("name_en").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: smallint("sort_order").notNull().default(100),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("service_categories_active_idx").on(table.active, table.sortOrder),
  ]
);

/**
 * Admin-managed service catalog (دليل الخدمات).
 * Codes are unique; archiving keeps history intact (active = false).
 */
export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    nameAr: text("name_ar").notNull(),
    nameEn: text("name_en").notNull(),
    categoryId: uuid("category_id").references(() => serviceCategories.id, {
      onDelete: "set null",
    }),
    defaultPrice: numeric("default_price", { precision: 12, scale: 2 }),
    currency: currencyEnum("currency").notNull().default("YER"),
    /** Does completed work on this service earn the doctor a commission? */
    commissionEligible: boolean("commission_eligible").notNull().default(false),
    /** Default commission method copied into plans when unset (nullable = no default). */
    defaultCommissionType: commissionTypeEnum("default_commission_type"),
    defaultCommissionValue: numeric("default_commission_value", {
      precision: 12,
      scale: 2,
    }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("services_code_unique").on(table.code),
    index("services_active_idx").on(table.active),
    index("services_category_id_idx").on(table.categoryId),
  ]
);

/**
 * Structured work items performed during a visit (بنود العمل).
 * Multiple items per visit; frozen when the visit is COMPLETED.
 * `visits.treatmentPerformed` stays as free-text clinical notes.
 */
export const visitWorkItems = pgTable(
  "visit_work_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    visitId: uuid("visit_id")
      .notNull()
      .references(() => visits.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "restrict" }),
    doctorId: uuid("doctor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 10, scale: 2 })
      .notNull()
      .default("1"),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),
    discount: numeric("discount", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    /** Server-computed: quantity * unitPrice - discount (minor-unit math). */
    total: numeric("total", { precision: 12, scale: 2 }).notNull(),
    currency: currencyEnum("currency").notNull().default("YER"),
    notes: text("notes"),
    status: workItemStatusEnum("status").notNull().default("ACTIVE"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("visit_work_items_visit_id_idx").on(table.visitId),
    index("visit_work_items_service_id_idx").on(table.serviceId),
    index("visit_work_items_doctor_id_idx").on(table.doctorId),
    index("visit_work_items_status_idx").on(table.status),
  ]
);

export const serviceCategoriesRelations = relations(
  serviceCategories,
  ({ many }) => ({
    services: many(services),
  })
);

export const servicesRelations = relations(services, ({ one, many }) => ({
  category: one(serviceCategories, {
    fields: [services.categoryId],
    references: [serviceCategories.id],
  }),
  workItems: many(visitWorkItems),
}));

export const visitWorkItemsRelations = relations(
  visitWorkItems,
  ({ one }) => ({
    visit: one(visits, {
      fields: [visitWorkItems.visitId],
      references: [visits.id],
    }),
    service: one(services, {
      fields: [visitWorkItems.serviceId],
      references: [services.id],
    }),
    doctor: one(users, {
      fields: [visitWorkItems.doctorId],
      references: [users.id],
    }),
  })
);

export type ServiceCategory = typeof serviceCategories.$inferSelect;
export type NewServiceCategory = typeof serviceCategories.$inferInsert;
export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;
export type VisitWorkItem = typeof visitWorkItems.$inferSelect;
export type NewVisitWorkItem = typeof visitWorkItems.$inferInsert;
