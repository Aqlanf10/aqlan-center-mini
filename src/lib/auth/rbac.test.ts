import { describe, expect, it } from "vitest";

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
