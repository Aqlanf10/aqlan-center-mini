import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
 CLAIMS_PHASES, claimsTransitionAllowed, claimsV3Drift, initialReadyStateDocument, readyStateIdentityEffect, strandedByTransition,
 type AccountBindingProof, type DurableIdentityClaimsV3,
} from "../lib/staff-claims-v3-design";
import { STAFF_AUTHORIZATION_POLICY_VERSION } from "../lib/staff-capability-catalogue";
import { parseStaffCapabilityDocument, resolveStaffCapabilities, hasStaffCapability, ownerContextFromTrustedBinding, patientCapabilityConstraint } from "../lib/staff-capabilities";

const proof: AccountBindingProof = {
 realmId: "r", controlEpoch: "1", generationId: "g", registryRevision: "40", subjectId: "s", boundRegistryRevision: "7",
 accountEpoch: "3", credentialVersion: "c", permissionRevision: 2, provider: { partyId: 20, clinicalEpoch: "1" },
};
const claims = (overrides: Partial<DurableIdentityClaimsV3> = {}): DurableIdentityClaimsV3 => ({
 schemaVersion: 3, policyVersion: STAFF_AUTHORIZATION_POLICY_VERSION, realmId: "r", controlEpoch: "1", generationId: "g", subjectId: "s",
 boundRegistryRevision: "7", accountEpoch: "3", credentialVersion: "c", permissionRevision: 2, provider: { partyId: 20, clinicalEpoch: "1" }, ...overrides,
});

describe("B2 claims v3 (isolated design model)", () => {
 it("binding ANOTHER account (global registry revision moves) does not move this session", () => {
  expect(claimsV3Drift({ ...proof, registryRevision: "41" }, claims())).toBeNull();
  expect(claimsV3Drift({ ...proof, registryRevision: "999" }, claims())).toBeNull();
 });
 it("every other anchor is still compared; a rebinding of this account refuses", () => {
  expect(claimsV3Drift({ ...proof, boundRegistryRevision: "8" }, claims())).toBe("BINDING_STALE");
  expect(claimsV3Drift({ ...proof, subjectId: "s2" }, claims())).toBe("SUBJECT_STALE");
  expect(claimsV3Drift({ ...proof, generationId: "g2" }, claims())).toBe("IDENTITY_NOT_READY");
  expect(claimsV3Drift({ ...proof, realmId: "r2" }, claims())).toBe("CONTROL_STALE");
  expect(claimsV3Drift({ ...proof, controlEpoch: "2" }, claims())).toBe("CONTROL_STALE");
  expect(claimsV3Drift({ ...proof, accountEpoch: "4" }, claims())).toBe("CREDENTIAL_OR_ACCOUNT_STALE");
  expect(claimsV3Drift({ ...proof, credentialVersion: "d" }, claims())).toBe("CREDENTIAL_OR_ACCOUNT_STALE");
  expect(claimsV3Drift({ ...proof, provider: null }, claims())).toBe("PROVIDER_STALE");
  expect(claimsV3Drift({ ...proof, provider: { partyId: 20, clinicalEpoch: "2" } }, claims())).toBe("PROVIDER_STALE");
  expect(claimsV3Drift({ ...proof, permissionRevision: 3 }, claims())).toBe("PERMISSIONS_STALE");
  expect(claimsV3Drift(proof, { ...claims(), schemaVersion: 2 } as unknown as DurableIdentityClaimsV3)).toBe("IDENTITY_NOT_READY");
 });
 it("a ready-state account starts pending with no grant and no scope, and resolves to nothing until the owner confirms", () => {
  const document = initialReadyStateDocument();
  expect(parseStaffCapabilityDocument(document)).toMatchObject({ ok: true });
  expect(document).toEqual({ schemaVersion: 2, revision: 1, confirmation: "pending", patientScope: "none", appointmentScope: "none", grants: {} });
  const owner = ownerContextFromTrustedBinding({ ownerUserId: 1, bindingVersion: "b-1" });
  const access = resolveStaffCapabilities({ subject: { userId: 9, role: "admin", isActive: true, clinicianPartyId: 20 }, permissionDocument: document }, owner);
  expect(hasStaffCapability(access, "staff.view")).toBe(false);
  expect(patientCapabilityConstraint(access)).toEqual({ kind: "none" });
 });
 it("disable/enable never retires the binding; only creation and rebinding append one", () => {
  for (const change of ["disable", "enable"] as const) expect(readyStateIdentityEffect(change)).toEqual({ appendsBinding: false, retiresBinding: false, incrementsAccountEpoch: true });
  expect(readyStateIdentityEffect("create")).toEqual({ appendsBinding: true, retiresBinding: false, incrementsAccountEpoch: false });
  expect(readyStateIdentityEffect("rebind").appendsBinding).toBe(true);
 });
 it("v2 is refused only in the last phase, reached and left one step at a time", () => {
  expect(CLAIMS_PHASES["v2-only"].accept).toEqual([2]);
  expect(CLAIMS_PHASES.dual).toEqual({ issue: 3, accept: [2, 3] });
  expect(CLAIMS_PHASES["v3-only"].accept).toEqual([3]);
  expect(claimsTransitionAllowed("v2-only", "v3-only")).toBe(false);
  expect(claimsTransitionAllowed("v3-only", "v2-only")).toBe(false);
  expect(claimsTransitionAllowed("v2-only", "dual") && claimsTransitionAllowed("dual", "v3-only")).toBe(true);
  // Rollback from v3-only to dual strands nothing; dual→v2 strands only v3 sessions (they re-login).
  expect(strandedByTransition("v3-only", "dual")).toEqual([]);
  expect(strandedByTransition("dual", "v2-only")).toEqual([3]);
  expect(strandedByTransition("dual", "v3-only")).toEqual([2]);
 });
 it("stays isolated: no runtime module imports the design model", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
   for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { walk(path); continue; }
    if (/\.(ts|tsx|mjs)$/.test(name) && !path.endsWith("staff-claims-v3-design.ts") && readFileSync(path, "utf8").includes("staff-claims-v3-design")) offenders.push(path);
   }
  };
  for (const root of ["lib", "app", "components"]) walk(root);
  expect(offenders).toEqual([]);
 });
});
