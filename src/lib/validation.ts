import { z } from "zod";

import {
  appointmentStatusEnum,
  contactResultEnum,
  contactTypeEnum,
  currencyEnum,
  genderEnum,
  treatmentStatusEnum,
  userRoleEnum,
} from "@/db/schema/enums";

/**
 * Validation helpers. Message values are dictionary keys — the UI maps them
 * through the active locale so validation errors are always bilingual.
 *
 * All server actions re-validate input with these schemas: client-side
 * validation is UX only, never a security boundary.
 */

export type LoginFieldErrors = Partial<Record<"username" | "password", string>>;

export const loginSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1, "usernameRequired")
    .max(100, "usernameRequired"),
  password: z
    .string()
    .min(8, "passwordTooShort")
    .max(128, "passwordTooShort"),
});

export type LoginInput = z.infer<typeof loginSchema>;

export function validateLogin(
  input: unknown
): { ok: true; data: LoginInput } | { ok: false; errors: LoginFieldErrors } {
  const result = loginSchema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }

  const errors: LoginFieldErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0];
    if ((key === "username" || key === "password") && !errors[key]) {
      errors[key] = issue.message;
    }
  }
  return { ok: false, errors };
}

/** Only allow internal redirect targets (defends against open redirects). */
export function safeInternalPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/dashboard";
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Shared field schemas                                                */
/* ------------------------------------------------------------------ */

const trimmed = (min: number, max: number, key: string) =>
  z.string().trim().min(min, key).max(max, key);

/** Digits, spaces, +, dashes, parentheses; normalized before storage. */
export const phoneSchema = trimmed(9, 24, "mobileInvalid").regex(
  /^[+0-9][0-9 ()-]*$/,
  "mobileInvalid"
);

/** datetime-local string: YYYY-MM-DDTHH:mm */
export const datetimeLocalSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "datetimeInvalid")
  .refine((value) => !Number.isNaN(new Date(`${value}:00`).getTime()), {
    message: "datetimeInvalid",
  });

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "dateInvalid")
  .refine((value) => !Number.isNaN(Date.parse(value)), "dateInvalid");

export const uuidSchema = z.string().uuid("required");

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "tooLong")
    .transform((value) => (value === "" ? undefined : value));

const optionalPhone = z
  .string()
  .trim()
  .max(24, "mobileInvalid")
  .refine(
    (value) => value === "" || /^[+0-9][0-9 ()-]*$/.test(value),
    "mobileInvalid"
  )
  .transform((value) => (value === "" ? undefined : value));

/**
 * Wrap a schema so that an empty/whitespace-only string becomes undefined
 * BEFORE validation runs (in Zod, checks execute before transforms, so a
 * plain .transform() would reject "" against uuid/email/regex formats).
 */
function emptyAsUndefined<S extends z.ZodType>(schema: S) {
  return z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    schema.optional()
  );
}

/* ------------------------------------------------------------------ */
/* Generic validate helper — turns Zod issues into field-error maps    */
/* ------------------------------------------------------------------ */

export type FieldErrors = Record<string, string>;

export function validateWith<S extends z.ZodType>(schema: S, input: unknown) {
  const result = schema.safeParse(input);
  if (result.success) {
    return { ok: true as const, data: result.data as z.infer<S> };
  }
  const fieldErrors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!fieldErrors[key]) {
      fieldErrors[key] = issue.message;
    }
  }
  return { ok: false as const, errors: fieldErrors };
}

/* ------------------------------------------------------------------ */
/* Patients                                                            */
/* ------------------------------------------------------------------ */

export const patientFormSchema = z.object({
  fullName: trimmed(2, 150, "fullNameRequired"),
  gender: z.enum(genderEnum.enumValues, "required"),
  dateOfBirth: emptyAsUndefined(
    isoDateSchema.refine(
      (value) => value <= new Date().toISOString().slice(0, 10),
      "dateInFuture"
    )
  ),
  mobile: phoneSchema,
  alternateMobile: optionalPhone,
  address: optionalText(300),
  treatingDoctorId: emptyAsUndefined(z.string().uuid("required")),
  treatmentType: optionalText(120),
  treatmentStatus: z.enum(treatmentStatusEnum.enumValues, "required"),
  recallIntervalDays: z.coerce
    .number({ error: "recallInvalid" })
    .int("recallInvalid")
    .min(1, "recallInvalid")
    .max(365, "recallInvalid"),
  notes: optionalText(2000),
});

export type PatientFormInput = z.infer<typeof patientFormSchema>;

/* ------------------------------------------------------------------ */
/* Appointments                                                        */
/* ------------------------------------------------------------------ */

export const appointmentFormSchema = z.object({
  patientId: uuidSchema,
  doctorId: uuidSchema,
  appointmentDate: datetimeLocalSchema,
  reason: optionalText(300),
  notes: optionalText(2000),
});

export type AppointmentFormInput = z.infer<typeof appointmentFormSchema>;

export const APPOINTMENT_STATUSES = appointmentStatusEnum.enumValues;

/* ------------------------------------------------------------------ */
/* Visits                                                              */
/* ------------------------------------------------------------------ */

export const visitFormSchema = z.object({
  patientId: uuidSchema,
  doctorId: uuidSchema,
  appointmentId: emptyAsUndefined(z.string().uuid("required")),
  visitDate: datetimeLocalSchema,
  chiefComplaint: optionalText(500),
  /** Required to COMPLETE a visit; drafts may leave it empty (enforced in the action). */
  treatmentPerformed: z.string().trim().max(2000, "tooLong"),
  clinicalNotes: optionalText(4000),
  nextVisitPlan: optionalText(1000),
  nextAppointmentDate: emptyAsUndefined(
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "datetimeInvalid")
      .refine((value) => !Number.isNaN(new Date(`${value}:00`).getTime()), {
        message: "datetimeInvalid",
      })
  ),
});

export type VisitFormInput = z.infer<typeof visitFormSchema>;

/* ------------------------------------------------------------------ */
/* Patient contacts                                                    */
/* ------------------------------------------------------------------ */

export const contactFormSchema = z.object({
  patientId: uuidSchema,
  contactType: z.enum(contactTypeEnum.enumValues, "required"),
  result: z.enum(contactResultEnum.enumValues, "required"),
  note: optionalText(500),
});

export type ContactFormInput = z.infer<typeof contactFormSchema>;

/* ------------------------------------------------------------------ */
/* Staff (admin)                                                       */
/* ------------------------------------------------------------------ */

export const staffCreateSchema = z.object({
  name: trimmed(2, 100, "fullNameRequired"),
  username: trimmed(3, 50, "usernameInvalid").regex(
    /^[a-zA-Z0-9_.-]+$/,
    "usernameInvalid"
  ),
  email: emptyAsUndefined(
    z
      .string()
      .trim()
      .email("emailInvalid")
      .max(200, "emailInvalid")
      .transform((value) => value.toLowerCase())
  ),
  password: z.string().min(8, "passwordTooShort").max(128, "passwordTooShort"),
  role: z.enum(userRoleEnum.enumValues, "required"),
});

export type StaffCreateInput = z.infer<typeof staffCreateSchema>;

/* ------------------------------------------------------------------ */
/* Password management                                                 */
/* ------------------------------------------------------------------ */

/**
 * Change-my-password form: current password + new password + confirmation.
 * Minimum length mirrors Better Auth's minPasswordLength (8).
 */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "passwordRequired").max(128, "passwordTooShort"),
    newPassword: z.string().min(8, "passwordTooShort").max(128, "passwordTooShort"),
    confirmPassword: z.string().min(1, "passwordRequired"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "passwordsDoNotMatch",
    path: ["confirmPassword"],
  });

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** Admin reset form: new password + confirmation (no current password). */
export const passwordResetSchema = z
  .object({
    newPassword: z.string().min(8, "passwordTooShort").max(128, "passwordTooShort"),
    confirmPassword: z.string().min(1, "passwordRequired"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "passwordsDoNotMatch",
    path: ["confirmPassword"],
  });

export type PasswordResetInput = z.infer<typeof passwordResetSchema>;

/* ------------------------------------------------------------------ */
/* Finance                                                             */
/* ------------------------------------------------------------------ */

export const moneyAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, "amountInvalid")
  .refine((value) => parseFloat(value) > 0, "amountInvalid");

/** Optional client-generated retry key (UUID per logical submission). */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    "required"
  )
  .max(64)
  .optional()
  .or(z.literal("").transform(() => undefined));

export const chargeFormSchema = z.object({
  patientId: uuidSchema,
  amount: moneyAmountSchema,
  currency: z.enum(currencyEnum.enumValues, "required"),
  description: trimmed(1, 300, "descriptionRequired"),
  idempotencyKey: idempotencyKeySchema,
});

export type ChargeFormInput = z.infer<typeof chargeFormSchema>;

export const paymentFormSchema = z.object({
  patientId: uuidSchema,
  amount: moneyAmountSchema,
  currency: z.enum(currencyEnum.enumValues, "required"),
  description: optionalText(300),
  idempotencyKey: idempotencyKeySchema,
});

export type PaymentFormInput = z.infer<typeof paymentFormSchema>;

/** Optional positive money string, "" treated as absent. */
export const optionalMoneyAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, "amountInvalid")
  .optional()
  .or(z.literal("").transform(() => undefined));

/** Optional non-negative money string (discounts), "" treated as zero. */
export const optionalNonNegativeMoneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, "amountInvalid")
  .optional()
  .or(z.literal("").transform(() => undefined));

/** Quantity: positive number with up to 2 decimals. */
export const quantitySchema = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, "quantityInvalid")
  .refine((value) => parseFloat(value) > 0, "quantityInvalid");

export const optionalNonNegativeQuantitySchema = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, "quantityInvalid")
  .optional()
  .or(z.literal("").transform(() => undefined));

/** Percent value for commission plans (0 < value <= 100 when PERCENT). */
export const commissionValueSchema = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, "amountInvalid")
  .refine((value) => parseFloat(value) > 0, "amountInvalid");

/* ------------------------------------------------------------------ */
/* Visit corrections                                                   */
/* ------------------------------------------------------------------ */

export const visitCorrectionFormSchema = z.object({
  note: trimmed(1, 1000, "required"),
  reason: trimmed(1, 500, "required"),
});

export type VisitCorrectionFormInput = z.infer<typeof visitCorrectionFormSchema>;

/* ------------------------------------------------------------------ */
/* Services catalog                                                    */
/* ------------------------------------------------------------------ */

export const serviceCategoryFormSchema = z.object({
  nameAr: trimmed(1, 120, "required"),
  nameEn: trimmed(1, 120, "required"),
  sortOrder: z
    .string()
    .trim()
    .regex(/^-?\d{1,5}$/, "required")
    .optional(),
});

export type ServiceCategoryFormInput = z.infer<typeof serviceCategoryFormSchema>;

export const serviceFormSchema = z.object({
  code: trimmed(1, 32, "required"),
  nameAr: trimmed(1, 200, "required"),
  nameEn: trimmed(1, 200, "required"),
  categoryId: uuidSchema.or(z.literal("").transform(() => undefined)).optional(),
  defaultPrice: optionalMoneyAmountSchema,
  currency: z.enum(currencyEnum.enumValues, "required"),
  commissionEligible: z.enum(["yes", "no"]).default("no"),
  defaultCommissionType: z
    .enum(["PERCENT", "FIXED"])
    .optional()
    .or(z.literal("").transform(() => undefined)),
  defaultCommissionValue: optionalMoneyAmountSchema,
});

export type ServiceFormInput = z.infer<typeof serviceFormSchema>;

/* ------------------------------------------------------------------ */
/* Work items                                                          */
/* ------------------------------------------------------------------ */

export const workItemFormSchema = z.object({
  serviceId: uuidSchema,
  doctorId: uuidSchema,
  quantity: quantitySchema,
  unitPrice: moneyAmountSchema,
  discount: optionalNonNegativeMoneySchema,
  currency: z.enum(currencyEnum.enumValues, "required"),
  notes: optionalText(500),
});

export type WorkItemFormInput = z.infer<typeof workItemFormSchema>;

/* ------------------------------------------------------------------ */
/* Treasury                                                            */
/* ------------------------------------------------------------------ */

export const cashAccountFormSchema = z.object({
  name: trimmed(1, 120, "required"),
  currency: z.enum(currencyEnum.enumValues, "required"),
  type: z.enum(["CASH", "BANK"]),
});

export type CashAccountFormInput = z.infer<typeof cashAccountFormSchema>;

export const expenseCategoryFormSchema = z.object({
  nameAr: trimmed(1, 120, "required"),
  nameEn: trimmed(1, 120, "required"),
});

export type ExpenseCategoryFormInput = z.infer<typeof expenseCategoryFormSchema>;

/* ------------------------------------------------------------------ */
/* Vouchers                                                            */
/* ------------------------------------------------------------------ */

export const receiptVoucherFormSchema = z.object({
  patientId: uuidSchema.or(z.literal("").transform(() => undefined)).optional(),
  otherPartyName: optionalText(200),
  amount: moneyAmountSchema,
  currency: z.enum(currencyEnum.enumValues, "required"),
  cashAccountId: uuidSchema,
  paymentMethod: z.enum(["CASH", "TRANSFER", "CARD", "OTHER"]),
  voucherDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "datetimeInvalid")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  description: optionalText(500),
  reference: optionalText(200),
  idempotencyKey: idempotencyKeySchema,
});

export type ReceiptVoucherFormInput = z.infer<typeof receiptVoucherFormSchema>;

export const paymentVoucherFormSchema = z.object({
  partyType: z.enum(["DOCTOR", "LAB", "SUPPLIER", "OTHER"]),
  doctorId: uuidSchema.or(z.literal("").transform(() => undefined)).optional(),
  labId: uuidSchema.or(z.literal("").transform(() => undefined)).optional(),
  supplierId: uuidSchema.or(z.literal("").transform(() => undefined)).optional(),
  otherPartyName: optionalText(200),
  expenseCategoryId: uuidSchema
    .or(z.literal("").transform(() => undefined))
    .optional(),
  labCaseId: uuidSchema.or(z.literal("").transform(() => undefined)).optional(),
  purchaseInvoiceId: uuidSchema
    .or(z.literal("").transform(() => undefined))
    .optional(),
  amount: moneyAmountSchema,
  currency: z.enum(currencyEnum.enumValues, "required"),
  cashAccountId: uuidSchema,
  paymentMethod: z.enum(["CASH", "TRANSFER", "CARD", "OTHER"]),
  voucherDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "datetimeInvalid")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  description: optionalText(500),
  reference: optionalText(200),
  idempotencyKey: idempotencyKeySchema,
});

export type PaymentVoucherFormInput = z.infer<typeof paymentVoucherFormSchema>;

export const voucherReversalFormSchema = z.object({
  reason: trimmed(1, 500, "required"),
});

export type VoucherReversalFormInput = z.infer<typeof voucherReversalFormSchema>;

/* ------------------------------------------------------------------ */
/* Commissions                                                         */
/* ------------------------------------------------------------------ */

export const commissionPlanFormSchema = z.object({
  doctorId: uuidSchema,
  serviceId: uuidSchema.or(z.literal("").transform(() => undefined)).optional(),
  basis: z.enum(["WORK_VALUE", "COLLECTED"]),
  type: z.enum(["PERCENT", "FIXED"]),
  value: commissionValueSchema,
});

export type CommissionPlanFormInput = z.infer<typeof commissionPlanFormSchema>;

export const commissionAmountFormSchema = z.object({
  amount: moneyAmountSchema,
});

export type CommissionAmountFormInput = z.infer<typeof commissionAmountFormSchema>;

export const commissionReversalFormSchema = z.object({
  reason: trimmed(1, 500, "required"),
});

export type CommissionReversalFormInput = z.infer<
  typeof commissionReversalFormSchema
>;

/* ------------------------------------------------------------------ */
/* Labs                                                                */
/* ------------------------------------------------------------------ */

export const labFormSchema = z.object({
  name: trimmed(1, 200, "required"),
  phone: phoneSchema.optional().or(z.literal("").transform(() => undefined)),
  address: optionalText(300),
  notes: optionalText(500),
});

export type LabFormInput = z.infer<typeof labFormSchema>;

export const labCaseFormSchema = z.object({
  labId: uuidSchema,
  patientId: uuidSchema,
  visitId: uuidSchema.or(z.literal("").transform(() => undefined)).optional(),
  doctorId: uuidSchema,
  serviceId: uuidSchema.or(z.literal("").transform(() => undefined)).optional(),
  workType: trimmed(1, 300, "required"),
  cost: moneyAmountSchema,
  currency: z.enum(currencyEnum.enumValues, "required"),
  status: z.enum(["ORDERED", "SENT", "RECEIVED", "DELIVERED", "CANCELLED"]),
  sentAt: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "datetimeInvalid")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  expectedDeliveryAt: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "datetimeInvalid")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  notes: optionalText(500),
});

export type LabCaseFormInput = z.infer<typeof labCaseFormSchema>;

export const labInvoiceFormSchema = z.object({
  invoiceNumber: optionalText(100),
  invoiceAmount: optionalMoneyAmountSchema,
});

export type LabInvoiceFormInput = z.infer<typeof labInvoiceFormSchema>;

/* ------------------------------------------------------------------ */
/* Suppliers & materials                                               */
/* ------------------------------------------------------------------ */

export const supplierFormSchema = z.object({
  name: trimmed(1, 200, "required"),
  phone: phoneSchema.optional().or(z.literal("").transform(() => undefined)),
  address: optionalText(300),
  notes: optionalText(500),
});

export type SupplierFormInput = z.infer<typeof supplierFormSchema>;

export const materialFormSchema = z.object({
  code: trimmed(1, 40, "required"),
  nameAr: trimmed(1, 200, "required"),
  nameEn: trimmed(1, 200, "required"),
  unit: optionalText(40),
  defaultSupplierId: uuidSchema
    .or(z.literal("").transform(() => undefined))
    .optional(),
});

export type MaterialFormInput = z.infer<typeof materialFormSchema>;

export const purchaseInvoiceItemFormSchema = z.object({
  materialId: uuidSchema,
  quantity: quantitySchema,
  unitPrice: moneyAmountSchema,
  discount: optionalNonNegativeMoneySchema,
});

export type PurchaseInvoiceItemFormInput = z.infer<
  typeof purchaseInvoiceItemFormSchema
>;

export const purchaseInvoiceFormSchema = z.object({
  supplierId: uuidSchema,
  supplierRef: optionalText(100),
  currency: z.enum(currencyEnum.enumValues, "required"),
  invoiceDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "datetimeInvalid")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  items: z
    .array(purchaseInvoiceItemFormSchema)
    .min(1, "itemsRequired"),
});

export type PurchaseInvoiceFormInput = z.infer<typeof purchaseInvoiceFormSchema>;

export const purchaseInvoiceCancelFormSchema = z.object({
  reason: trimmed(1, 500, "required"),
});

export type PurchaseInvoiceCancelFormInput = z.infer<
  typeof purchaseInvoiceCancelFormSchema
>;
