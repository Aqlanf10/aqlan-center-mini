import { describe, expect, it } from "vitest";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../lib/doctor-permissions";
import { INTAKE_PERMISSION_KEY_MAX_BYTES, makeIntakeOwnerSlot, makeIntakeRecoveryLedger, type IntakeOwnerScope } from "../lib/ortho-assessment-intake-owner";
const base: Omit<IntakeOwnerScope, "permissionKey"> = { patientId: 7, principalId: 17, selectedOrthoCaseId: null, selectedClinicalCaseId: null };
const access = { authorized: () => true, writable: () => true, deny: () => undefined };
describe("bounded complete intake permission generation", () => {
  it("accepts the full canonical permission object beyond the former 500-character limit", () => {
    const key = JSON.stringify({ role: "doctor", permissions: DEFAULT_DOCTOR_PERMISSIONS });
    expect(key.length).toBeGreaterThan(500); expect(new TextEncoder().encode(key).byteLength).toBeLessThan(INTAKE_PERMISSION_KEY_MAX_BYTES);
    const slot = makeIntakeOwnerSlot(makeIntakeRecoveryLedger()), first = slot.select({ ...base, permissionKey: key }, access);
    expect(first.scope.permissionKey).toBe(key); expect(first.retired).toBe(false);
    const changed = JSON.stringify({ role: "doctor", permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewPlans: false } });
    const next = slot.select({ ...base, permissionKey: changed }, access);
    expect(first.retired).toBe(true); expect(next).not.toBe(first); expect(next.scope.permissionKey).toBe(changed);
  });
  it("enforces the exact 8 KiB UTF-8 ceiling rather than accepting oversized multibyte text", () => {
    const slot = makeIntakeOwnerSlot(makeIntakeRecoveryLedger());
    expect(slot.select({ ...base, permissionKey: "x".repeat(INTAKE_PERMISSION_KEY_MAX_BYTES) }, access).retired).toBe(false);
    for (const permissionKey of ["", "x".repeat(INTAKE_PERMISSION_KEY_MAX_BYTES + 1), "م".repeat(4_097)])
      expect(() => slot.select({ ...base, permissionKey }, access)).toThrow("invalid_intake_owner_scope");
    expect(slot.select({ ...base, permissionKey: "م".repeat(4_096) }, access).retired).toBe(false);
  });
});
