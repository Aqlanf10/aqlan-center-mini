"use server";

import { headers } from "next/headers";

import { auth } from "@/lib/auth/server";
import { requireUser } from "@/lib/auth/guards";
import { changePasswordSchema, validateWith } from "@/lib/validation";
import { AUDIT_ACTIONS, recordAudit } from "@/server/audit";
import { failure, success, type ActionResult } from "@/server/types";

/**
 * Change the signed-in user's own password.
 *
 * - Requires the CURRENT password (verified by Better Auth against the
 *   stored scrypt hash — we never touch hashes manually).
 * - Enforces the same minimum length as Better Auth (8 chars).
 * - revokeOtherSessions=true terminates every OTHER device/session and
 *   re-issues the current session cookie, so a password change kicks out
 *   any stale or stolen sessions.
 * - Passwords are never logged and never included in the response.
 */
export async function changeMyPasswordAction(input: {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}): Promise<ActionResult> {
  const user = await requireUser("/dashboard");

  const validation = validateWith(changePasswordSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }

  try {
    await auth.api.changePassword({
      headers: await headers(),
      body: {
        currentPassword: validation.data.currentPassword,
        newPassword: validation.data.newPassword,
        revokeOtherSessions: true,
      },
    });

    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.USER_PASSWORD_CHANGED,
      entityType: "user",
      entityId: user.id,
      metadata: { self: true },
    });

    return success("auth.changePassword.success");
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("INVALID_PASSWORD") ||
        /current password|invalid password/i.test(error.message))
    ) {
      return failure("auth.changePassword.failed", {
        currentPassword: "auth.changePassword.wrongCurrent",
      });
    }
    if (
      error instanceof Error &&
      error.message.includes("CREDENTIAL_ACCOUNT_NOT_FOUND")
    ) {
      return failure("auth.changePassword.failed", {
        currentPassword: "auth.changePassword.noCredential",
      });
    }
    return failure("auth.changePassword.failed");
  }
}
