import { pgEnum } from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", [
  "ADMIN",
  "DOCTOR",
  "RECEPTION",
]);

export const genderEnum = pgEnum("gender", ["MALE", "FEMALE"]);

export const treatmentStatusEnum = pgEnum("treatment_status", [
  "NEW",
  "ACTIVE",
  "RETENTION",
  "COMPLETED",
  "PAUSED",
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

export const visitStatusEnum = pgEnum("visit_status", ["DRAFT", "COMPLETED"]);

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

/* ------------------------------------------------------------------ */
/* Finance & operations expansion                                      */
/* ------------------------------------------------------------------ */

/** Receipt (money in) vs payment (money out) voucher. */
export const voucherTypeEnum = pgEnum("voucher_type", ["RECEIPT", "PAYMENT"]);

/** Who the voucher's counterparty is. */
export const partyTypeEnum = pgEnum("party_type", [
  "PATIENT",
  "DOCTOR",
  "LAB",
  "SUPPLIER",
  "OTHER",
]);

/** How the money moved. */
export const paymentMethodEnum = pgEnum("payment_method", [
  "CASH",
  "TRANSFER",
  "CARD",
  "OTHER",
]);

/** ACTIVE = live movement; REVERSED = voided by a linked reversal entry. */
export const voucherStatusEnum = pgEnum("voucher_status", [
  "ACTIVE",
  "REVERSED",
]);

/** Cash box or bank account. */
export const cashAccountTypeEnum = pgEnum("cash_account_type", [
  "CASH",
  "BANK",
]);

/** Commission basis: value of completed work or collected money. */
export const commissionBasisEnum = pgEnum("commission_basis", [
  "WORK_VALUE",
  "COLLECTED",
]);

/** Percent of base or fixed amount. */
export const commissionTypeEnum = pgEnum("commission_type", [
  "PERCENT",
  "FIXED",
]);

/** Commission lifecycle. */
export const commissionStatusEnum = pgEnum("commission_status", [
  "PENDING",
  "APPROVED",
  "PAID",
  "REVERSED",
]);

/** Lab case lifecycle. */
export const labCaseStatusEnum = pgEnum("lab_case_status", [
  "ORDERED",
  "SENT",
  "RECEIVED",
  "DELIVERED",
  "CANCELLED",
]);

/** Work item lifecycle (draft editing then frozen on completion). */
export const workItemStatusEnum = pgEnum("work_item_status", [
  "ACTIVE",
  "CANCELLED",
]);

/** Purchase invoice lifecycle. */
export const purchaseInvoiceStatusEnum = pgEnum("purchase_invoice_status", [
  "ACTIVE",
  "CANCELLED",
]);

export type UserRole = (typeof userRoleEnum.enumValues)[number];
export type Gender = (typeof genderEnum.enumValues)[number];
export type TreatmentStatus = (typeof treatmentStatusEnum.enumValues)[number];
export type AppointmentStatus = (typeof appointmentStatusEnum.enumValues)[number];
export type VisitStatus = (typeof visitStatusEnum.enumValues)[number];
export type ContactType = (typeof contactTypeEnum.enumValues)[number];
export type ContactResult = (typeof contactResultEnum.enumValues)[number];
export type Currency = (typeof currencyEnum.enumValues)[number];
export type VoucherType = (typeof voucherTypeEnum.enumValues)[number];
export type PartyType = (typeof partyTypeEnum.enumValues)[number];
export type PaymentMethod = (typeof paymentMethodEnum.enumValues)[number];
export type VoucherStatus = (typeof voucherStatusEnum.enumValues)[number];
export type CashAccountType = (typeof cashAccountTypeEnum.enumValues)[number];
export type CommissionBasis = (typeof commissionBasisEnum.enumValues)[number];
export type CommissionType = (typeof commissionTypeEnum.enumValues)[number];
export type CommissionStatus = (typeof commissionStatusEnum.enumValues)[number];
export type LabCaseStatus = (typeof labCaseStatusEnum.enumValues)[number];
export type WorkItemStatus = (typeof workItemStatusEnum.enumValues)[number];
export type PurchaseInvoiceStatus = (typeof purchaseInvoiceStatusEnum.enumValues)[number];
