"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { sessions, users } from "@/db/schema";
import { requireRole } from "@/lib/auth/guards";
import { auth } from "@/lib/auth/server";
import { staffCreateSchema, validateWith } from "@/lib/validation";
import { AUDIT_ACTIONS, recordAudit } from "@/server/audit";
import { failure, success, type ActionResult } from "@/server/types";
import type { UserRole } from "@/db/schema/enums";

const ADMIN_ONLY = ["ADMIN"] as const;

/** Deterministic internal email when the staff member has none. */
function synthesizeEmail(username: string): string {
  return `${username.toLowerCase()}@staff.aqlan-center.local`;
}

/**
 * Create a staff account through Better Auth's admin API so the password
 * is hashed with the library's scrypt implementation (never plaintext,
 * never a default password from source code).
 */
export async function createStaffAction(
  input: Record<string, string>
): Promise<ActionResult> {
  const admin = await requireRole(ADMIN_ONLY, "/settings/staff");

  const validation = validateWith(staffCreateSchema, input);
  if (!validation.ok) {
    return failure("common.serverError", validation.errors);
  }
  const data = validation.data;

  const email = data.email ?? synthesizeEmail(data.username);

  try {
    const result = await auth.api.createUser({
      body: {
        name: data.name,
        email,
        password: data.password,
        role: data.role,
        data: {
          username: data.username.toLowerCase(),
          active: true,
        },
      },
    });

    const userId = result?.user?.id;
    if (!userId) {
      return failure("staff.toasts.failed");
    }

    // Ensure our custom columns are exactly as intended (defense in depth:
    // additionalFields input filtering cannot be trusted blindly).
    await db
      .update(users)
      .set({
        username: data.username.toLowerCase(),
        active: true,
        role: data.role,
      })
      .where(eq(users.id, userId));

    await recordAudit({
      userId: admin.id,
      action: AUDIT_ACTIONS.USER_CREATED,
      entityType: "user",
      entityId: userId,
      metadata: { username: data.username, role: data.role },
    });

    revalidatePath("/settings/staff");
    return success("staff.toasts.created", userId);
  } catch (error) {
    if (
      error instanceof Error &&
      (/username/i.test(error.message) && /already|exist|unique/i.test(error.message))
    ) {
      return failure("staff.errors.usernameTaken", {
        username: "staff.errors.usernameTaken",
      });
    }
    if (
      error instanceof Error &&
      (/email/i.test(error.message) && /already|exist|unique/i.test(error.message))
    ) {
      return failure("staff.errors.emailTaken", {
        email: "staff.errors.emailTaken",
      });
    }
    return failure("staff.toasts.failed");
  }
}

/**
 * Change a staff role. Guards:
 * - ADMIN only (server-side).
 * - No user can change their own role.
 * - Role must be a known enum value.
 */
export async function setStaffRoleAction(
  userId: string,
  role: UserRole
): Promise<ActionResult> {
  const admin = await requireRole(ADMIN_ONLY, "/settings/staff");

  if (admin.id === userId) {
    return failure("staff.errors.cannotChangeOwnRole");
  }
  if (role !== "ADMIN" && role !== "DOCTOR" && role !== "RECEPTION") {
    return failure("staff.toasts.failed");
  }

  try {
    await db
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(eq(users.id, userId));

    await recordAudit({
      userId: admin.id,
      action: AUDIT_ACTIONS.USER_UPDATED,
      entityType: "user",
      entityId: userId,
      metadata: { role },
    });

    revalidatePath("/settings/staff");
    return success("staff.toasts.updated", userId);
  } catch {
    return failure("staff.toasts.failed");
  }
}

/**
 * Deactivate / activate a staff account.
 * Deactivation immediately revokes all sessions (defense in depth on top
 * of the session-create hook + guards).
 */
export async function setStaffActiveAction(
  userId: string,
  active: boolean
): Promise<ActionResult> {
  const admin = await requireRole(ADMIN_ONLY, "/settings/staff");

  if (admin.id === userId) {
    return failure("staff.errors.cannotDeactivateSelf");
  }

  try {
    await db
      .update(users)
      .set({ active, updatedAt: new Date() })
      .where(eq(users.id, userId));

    if (!active) {
      // Terminate every live session for this user right now.
      await db.delete(sessions).where(eq(sessions.userId, userId));
    }

    await recordAudit({
      userId: admin.id,
      action: active
        ? AUDIT_ACTIONS.USER_ACTIVATED
        : AUDIT_ACTIONS.USER_DEACTIVATED,
      entityType: "user",
      entityId: userId,
      metadata: {},
    });

    revalidatePath("/settings/staff");
    return success(
      active ? "staff.toasts.activated" : "staff.toasts.deactivated",
      userId
    );
  } catch {
    return failure("staff.toasts.failed");
  }
}
