import { pgEnum } from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", [
  "ADMIN",
  "DOCTOR",
  "RECEPTION",
]);

export const genderEnum = pgEnum("gender", ["MALE", "FEMALE"]);

export const treatmentStatusEnum = pgEnum("treatment_status", [
  "ACTIVE",
  "ON_HOLD",
  "COMPLETED",
  "ARCHIVED",
]);

export const appointmentStatusEnum = pgEnum("appointment_status", [
  "SCHEDULED",
  "CONFIRMED",
  "ARRIVED",
  "IN_TREATMENT",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
]);

export const visitStatusEnum = pgEnum("visit_status", [
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
]);

export const contactTypeEnum = pgEnum("contact_type", [
  "PHONE",
  "WHATSAPP",
  "IN_PERSON",
  "OTHER",
]);

export const contactResultEnum = pgEnum("contact_result", [
  "CONTACTED",
  "NO_ANSWER",
  "RESCHEDULED",
  "WILL_CALL_BACK",
  "CANCELLED",
  "OTHER",
]);

export const currencyEnum = pgEnum("currency", ["YER", "SAR", "USD"]);

export type UserRole = (typeof userRoleEnum.enumValues)[number];
export type Gender = (typeof genderEnum.enumValues)[number];
export type TreatmentStatus = (typeof treatmentStatusEnum.enumValues)[number];
export type AppointmentStatus = (typeof appointmentStatusEnum.enumValues)[number];
export type VisitStatus = (typeof visitStatusEnum.enumValues)[number];
export type ContactType = (typeof contactTypeEnum.enumValues)[number];
export type ContactResult = (typeof contactResultEnum.enumValues)[number];
export type Currency = (typeof currencyEnum.enumValues)[number];
