import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readStaffEntryMode, readLegacyStaffSchema } from "../lib/legacy-staff-schema.mjs";
// @ts-expect-error Plain Node read-only inspection tool has no application runtime contract.
import { inspectClinicOwnerBindingCandidate } from "../lib/clinic-owner-binding-plan.mjs";

describe("shared SELECT-only owner preparation", () => {
  it("preserves WORK's actual detector byte-for-byte except the extracted validator import", () => {
    const source = readFileSync("lib/legacy-staff-schema.mjs", "utf8").replace("./staff-identity-schema-name.mjs", "./staff-identity-substrate-schema.mjs");
    expect(createHash("sha256").update(source).digest("hex")).toBe("8ba59384c448e42b272c79bf772ccc449325fb2517111ef8b132fb0da46dbc07");
  });
  it.each(["1", "2", "100"])("any footprint %s selects canonical without fallback", async markers => {
    const query = vi.fn().mockResolvedValue({ rows: [{ markers }] });
    expect(await readStaffEntryMode({ query })).toBe("canonical");
    await expect(readLegacyStaffSchema({ query })).rejects.toThrow("AUTHORITY_SCHEMA_HELD");
    expect(query.mock.calls.every(([sql]) => sql.trim().startsWith("SELECT"))).toBe(true);
  });
  it.each([undefined, null, 0, "", "-1", "NaN"])("unreadable catalogue %s fails closed", async markers => {
    await expect(readStaffEntryMode({ query: vi.fn().mockResolvedValue({ rows: [{ markers }] }) })).rejects.toThrow();
  });
  it("never treats a read error as legacy", async () => {
    await expect(readStaffEntryMode({ query: vi.fn().mockRejectedValue(new Error("offline")) })).rejects.toThrow("offline");
  });
  it("does not inspect legacy users once canonical artifacts exist", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ markers: "1" }] });
    expect(await inspectClinicOwnerBindingCandidate({ query }, { userId: 1, doctorId: 2 })).toEqual({ mode: "canonical", canApply: false, blockers: ["CANONICAL_REGISTRY_REQUIRED"] });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("an eligible explicitly supplied pair remains blocked without installation witness and binding", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ markers: "0" }] }).mockResolvedValueOnce({ rows: [{ user_id: 1, role: "admin", user_active: true, linked_doctor_id: 2, doctor_id: 2, kind: "doctor", doctor_active: true }] });
    const result = await inspectClinicOwnerBindingCandidate({ query }, { userId: 1, doctorId: 2 });
    expect(result).toMatchObject({ eligibleForFurtherReview: true, canApply: false });
    expect(result.blockers).toContain("TARGET_INSTALLATION_WITNESS_NOT_INTEGRATED");
    expect(query.mock.calls.every(([sql]) => sql.trim().startsWith("SELECT"))).toBe(true);
  });
  it("rejects implicit or malformed account selection before any read", async () => {
    const query = vi.fn();
    await expect(inspectClinicOwnerBindingCandidate({ query }, { userId: 0, doctorId: 2 })).rejects.toThrow("EXPLICIT_IDS_REQUIRED");
    expect(query).not.toHaveBeenCalled();
  });
});
