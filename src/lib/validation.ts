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
/* Finance                                                             */
/* ------------------------------------------------------------------ */

export const moneyAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, "amountInvalid")
  .refine((value) => parseFloat(value) > 0, "amountInvalid");

export const chargeFormSchema = z.object({
  patientId: uuidSchema,
  amount: moneyAmountSchema,
  currency: z.enum(currencyEnum.enumValues, "required"),
  description: trimmed(1, 300, "descriptionRequired"),
});

export type ChargeFormInput = z.infer<typeof chargeFormSchema>;

export const paymentFormSchema = z.object({
  patientId: uuidSchema,
  amount: moneyAmountSchema,
  currency: z.enum(currencyEnum.enumValues, "required"),
  description: optionalText(300),
});

export type PaymentFormInput = z.infer<typeof paymentFormSchema>;
