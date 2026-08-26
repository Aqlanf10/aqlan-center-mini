import { z } from "zod";

/**
 * Validation helpers. Message values are dictionary keys — the UI maps them
 * through the active locale so validation errors are always bilingual.
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
