import { describe, expect, it } from "vitest";

import { parseSessionUser } from "@/lib/auth/session-user";
import { isRoleAllowed, isUserRole, USER_ROLES } from "@/lib/auth/rbac";

describe("RBAC helpers", () => {
  it("defines the three staff roles", () => {
    expect(USER_ROLES).toEqual(["ADMIN", "DOCTOR", "RECEPTION"]);
  });

  it("isUserRole accepts only known roles", () => {
    expect(isUserRole("ADMIN")).toBe(true);
    expect(isUserRole("DOCTOR")).toBe(true);
    expect(isUserRole("RECEPTION")).toBe(true);
    expect(isUserRole("SUPERADMIN")).toBe(false);
    expect(isUserRole(null)).toBe(false);
    expect(isUserRole(undefined)).toBe(false);
  });

  it("allows a role when it appears in the allowed list", () => {
    expect(isRoleAllowed("ADMIN", ["ADMIN", "DOCTOR"])).toBe(true);
    expect(isRoleAllowed("DOCTOR", ["ADMIN", "DOCTOR"])).toBe(true);
    expect(isRoleAllowed("RECEPTION", ["RECEPTION"])).toBe(true);
  });

  it("denies a role missing from the allowed list", () => {
    expect(isRoleAllowed("RECEPTION", ["ADMIN", "DOCTOR"])).toBe(false);
    expect(isRoleAllowed("DOCTOR", ["ADMIN"])).toBe(false);
  });

  it("handles an empty allowed list (deny everything)", () => {
    expect(isRoleAllowed("ADMIN", [])).toBe(false);
  });
});

describe("session user parsing (fail closed)", () => {
  const validPayload = {
    id: "6f9d2b2e-1f4b-4c1e-8f0a-2b7d9c3e4a5b",
    name: "Staff User",
    username: "staff",
    role: "DOCTOR",
    active: true,
  };

  it("accepts a valid payload with a known role", () => {
    expect(parseSessionUser(validPayload)).toEqual({
      id: validPayload.id,
      name: "Staff User",
      username: "staff",
      role: "DOCTOR",
      active: true,
    });
  });

  it("rejects an unknown role instead of falling back to RECEPTION", () => {
    const result = parseSessionUser({ ...validPayload, role: "SUPERADMIN" });
    expect(result).toBeNull();
  });

  it("rejects a missing role instead of assuming a default", () => {
    const payloadWithoutRole: Record<string, unknown> = { ...validPayload };
    delete payloadWithoutRole["role"];
    expect(parseSessionUser(payloadWithoutRole)).toBeNull();
  });

  it("rejects non-object payloads", () => {
    expect(parseSessionUser(null)).toBeNull();
    expect(parseSessionUser(undefined)).toBeNull();
    expect(parseSessionUser("user")).toBeNull();
    expect(parseSessionUser(42)).toBeNull();
  });

  it("rejects payloads with missing identity fields", () => {
    expect(parseSessionUser({ ...validPayload, id: 7 })).toBeNull();
    expect(parseSessionUser({ ...validPayload, name: null })).toBeNull();
  });

  it("marks a deactivated account as inactive (guard will deny access)", () => {
    const result = parseSessionUser({ ...validPayload, active: false });
    expect(result?.active).toBe(false);
  });

  it("defaults active to true when the flag is absent", () => {
    const payloadWithoutActive: Record<string, unknown> = { ...validPayload };
    delete payloadWithoutActive["active"];
    const result = parseSessionUser(payloadWithoutActive);
    expect(result?.active).toBe(true);
  });
});
