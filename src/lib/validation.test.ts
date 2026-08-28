import { describe, expect, it } from "vitest";

import { loginSchema, safeInternalPath, validateLogin } from "@/lib/validation";

describe("loginSchema", () => {
  it("accepts a valid username and password", () => {
    const result = loginSchema.safeParse({
      username: "admin",
      password: "strong-pass-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty username", () => {
    const result = loginSchema.safeParse({ username: "   ", password: "strong-pass-1" });
    expect(result.success).toBe(false);
  });

  it("rejects passwords shorter than 8 characters", () => {
    const result = loginSchema.safeParse({ username: "admin", password: "short" });
    expect(result.success).toBe(false);
  });
});

describe("validateLogin", () => {
  it("returns normalized data on success", () => {
    const result = validateLogin({ username: "  admin ", password: "strong-pass-1" });
    expect(result).toEqual({
      ok: true,
      data: { username: "admin", password: "strong-pass-1" },
    });
  });

  it("reports the username error for a missing username", () => {
    const result = validateLogin({ username: "", password: "strong-pass-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.username).toBe("usernameRequired");
      expect(result.errors.password).toBeUndefined();
    }
  });

  it("reports the password error for a short password", () => {
    const result = validateLogin({ username: "admin", password: "123" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.password).toBe("passwordTooShort");
      expect(result.errors.username).toBeUndefined();
    }
  });

  it("reports both fields when both are invalid", () => {
    const result = validateLogin({ username: "", password: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.username).toBe("usernameRequired");
      expect(result.errors.password).toBe("passwordTooShort");
    }
  });

  it("fails safely for non-object input", () => {
    const result = validateLogin(null);
    expect(result.ok).toBe(false);
  });
});

describe("safeInternalPath", () => {
  it("allows internal absolute paths", () => {
    expect(safeInternalPath("/dashboard")).toBe("/dashboard");
    expect(safeInternalPath("/today?date=2026-01-01")).toBe("/today?date=2026-01-01");
  });

  it("falls back to /dashboard for external or malformed targets", () => {
    expect(safeInternalPath(null)).toBe("/dashboard");
    expect(safeInternalPath("")).toBe("/dashboard");
    expect(safeInternalPath("https://evil.example")).toBe("/dashboard");
    expect(safeInternalPath("//evil.example")).toBe("/dashboard");
    expect(safeInternalPath("dashboard")).toBe("/dashboard");
  });
});
