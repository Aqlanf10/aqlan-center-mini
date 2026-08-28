import { describe, expect, it } from "vitest";

import {
  changePasswordSchema,
  passwordResetSchema,
} from "@/lib/validation";

describe("changePasswordSchema", () => {
  const valid = {
    currentPassword: "current-pass-1",
    newPassword: "new-strong-pass-1",
    confirmPassword: "new-strong-pass-1",
  };

  it("accepts a complete, matching form", () => {
    expect(changePasswordSchema.safeParse(valid).success).toBe(true);
  });

  it("requires the current password", () => {
    const result = changePasswordSchema.safeParse({ ...valid, currentPassword: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toContain("currentPassword");
    }
  });

  it("enforces the 8-char minimum on the new password", () => {
    const result = changePasswordSchema.safeParse({
      ...valid,
      newPassword: "short",
      confirmPassword: "short",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("passwordTooShort");
    }
  });

  it("rejects a confirmation mismatch with passwordsDoNotMatch on confirmPassword", () => {
    const result = changePasswordSchema.safeParse({
      ...valid,
      confirmPassword: "different-1",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.includes("confirmPassword")
      );
      expect(issue?.message).toBe("passwordsDoNotMatch");
    }
  });

  it("rejects an over-long new password", () => {
    const long = "a".repeat(129);
    const result = changePasswordSchema.safeParse({
      ...valid,
      newPassword: long,
      confirmPassword: long,
    });
    expect(result.success).toBe(false);
  });
});

describe("passwordResetSchema", () => {
  it("accepts matching passwords of valid length", () => {
    expect(
      passwordResetSchema.safeParse({
        newPassword: "reset-pass-123",
        confirmPassword: "reset-pass-123",
      }).success
    ).toBe(true);
  });

  it("requires at least 8 characters", () => {
    expect(
      passwordResetSchema.safeParse({
        newPassword: "short",
        confirmPassword: "short",
      }).success
    ).toBe(false);
  });

  it("rejects mismatched confirmation", () => {
    const result = passwordResetSchema.safeParse({
      newPassword: "reset-pass-123",
      confirmPassword: "nope-123",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("passwordsDoNotMatch");
    }
  });
});
