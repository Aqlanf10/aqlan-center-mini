import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createSessionToken, signDurableSessionClaims } from "../lib/auth";
import { selectStaffEnvelope } from "../lib/staff-session-admission";
import { STAFF_AUTHORIZATION_POLICY_VERSION, STAFF_CAPABILITIES } from "../lib/staff-capability-catalogue";
import { STAFF_CAPABILITY_LABELS, staffCapabilityGroup, toggleStaffCapability } from "../lib/staff-capability-labels";
import { canonicalPageAllowed, canonicalPageFor, canonicalPagesFor, isCanonicalPage } from "../lib/canonical-navigation";

const durable = () => signDurableSessionClaims({
 userId: 2, username: "synthetic", expiresAt: Date.now() + 60_000,
 durableIdentity: { schemaVersion: 2, policyVersion: STAFF_AUTHORIZATION_POLICY_VERSION, realmId: "11111111-1111-4111-8111-111111111111", subjectId: "22222222-2222-4222-8222-222222222222",
  generationId: "33333333-3333-4333-8333-333333333333", registryRevision: "4", controlEpoch: "2", accountEpoch: "3", permissionRevision: 1,
  credentialVersion: "a".repeat(43), provider: null },
});
const legacy = () => createSessionToken({ userId: 7, username: "synthetic-legacy", role: "admin", expiresAt: Date.now() + 60_000, credentialVersion: "x" });
const forgedMarker = () => {
 const body = Buffer.from(JSON.stringify({ userId: 2, username: "x", expiresAt: Date.now() + 60_000, durableIdentity: { schemaVersion: 2 } })).toString("base64url");
 return `${body}.${createHmac("sha256", process.env.SESSION_SECRET!).update(body).digest("base64url")}`;
};

describe("one staff envelope selection rule", () => {
 it("a valid canonical cookie is selected and never falls through to a legacy Bearer", () => {
  expect(selectStaffEnvelope(durable(), `Bearer ${legacy()}`).kind).toBe("canonical");
 });
 it("a signed but malformed canonical cookie is denied, not translated or downgraded", () => {
  expect(selectStaffEnvelope(forgedMarker(), `Bearer ${legacy()}`)).toEqual({ kind: "denied" });
 });
 it("legacy cookie stays legacy; absent/invalid cookie uses the signed Bearer", () => {
  expect(selectStaffEnvelope(legacy(), undefined).kind).toBe("legacy");
  expect(selectStaffEnvelope("garbage.token", `Bearer ${legacy()}`).kind).toBe("legacy");
  expect(selectStaffEnvelope(undefined, `Bearer ${durable()}`).kind).toBe("canonical");
 });
 it("nothing usable selects none", () => {
  expect(selectStaffEnvelope(undefined, undefined)).toEqual({ kind: "none" });
  expect(selectStaffEnvelope("a.b", "Basic abc")).toEqual({ kind: "none" });
 });
});

describe("capability presentation", () => {
 it("every catalogue capability has an Arabic label and a group", () => {
  for (const capability of STAFF_CAPABILITIES) {
   expect(STAFF_CAPABILITY_LABELS[capability]).toMatch(/[؀-ۿ]/);
   expect(staffCapabilityGroup(capability)).toBeTruthy();
  }
 });
 it("granting adds prerequisites; removing a prerequisite removes its dependants", () => {
  const on = toggleStaffCapability(new Set(), "staff.permissions.edit", true);
  expect([...on].sort()).toEqual(["staff.permissions.edit", "staff.view"]);
  expect([...toggleStaffCapability(on, "staff.view", false)]).toEqual([]);
 });
 it("navigation is a projection of current grants over accepted canonical pages only", () => {
  expect(canonicalPagesFor([], false)).toEqual([]);
  expect(canonicalPagesFor(["staff.view"], false).map(p => p.href)).toEqual(["/staff-access"]);
  expect(canonicalPagesFor([], true).map(p => p.href)).toEqual(["/visits", "/appointments", "/requests", "/waiting-list", "/recall", "/patients", "/staff-access", "/settings", "/inventory/procurement", "/inventory/procurement/review", "/inventory/procurement/operations", "/inventory/custody", "/inventory/procurement/setup"]);
  expect(canonicalPagesFor(["inventory.custody.view"], false).map(p => p.href)).toEqual(["/inventory/custody"]);
  expect(isCanonicalPage("/staff-access")).toBe(true);
  expect(isCanonicalPage("/patients")).toBe(true);
  expect(isCanonicalPage("/visits")).toBe(true);
  expect(isCanonicalPage("/visits/12")).toBe(false);
  // The patient list is exact; one patient's file is a separate, pattern-matched page.
  expect(isCanonicalPage("/patients/12")).toBe(true);
  expect(canonicalPageFor("/patients/12")?.href).toBe("/patients/[id]");
  expect(isCanonicalPage("/patients/12/ortho")).toBe(false);
  expect(isCanonicalPage("/patients/0")).toBe(false);
  expect(isCanonicalPage("/patients/abc")).toBe(false);
  // Legacy-only inventory screens (overview, valuation review) are not canonical pages yet.
  expect(isCanonicalPage("/inventory")).toBe(false);
  expect(isCanonicalPage("/inventory/review")).toBe(false);
 });
 it("a record page follows the record scope, never a grant or role label", () => {
  // Grants alone never show the patient list; a scope other than none does.
  expect(canonicalPagesFor(["clinical.plans.view", "finance.patient-ledger.view"], false).map(p => p.href)).toEqual([]);
  expect(canonicalPagesFor([], false, { patientScope: "none" }).map(p => p.href)).toEqual([]);
  expect(canonicalPagesFor([], false, { patientScope: "own" }).map(p => p.href)).toEqual(["/visits", "/recall", "/patients"]);
  // The online booking queue needs appointments.create AND the whole appointment scope.
  expect(canonicalPagesFor(["appointments.create"], false, { appointmentScope: "own" }).map(p => p.href)).toEqual(["/appointments", "/waiting-list"]);
  expect(canonicalPagesFor(["appointments.create"], false, { appointmentScope: "all" }).map(p => p.href)).toEqual(["/appointments", "/requests", "/waiting-list"]);
  expect(canonicalPagesFor([], false, { appointmentScope: "all" }).map(p => p.href)).toEqual(["/appointments", "/waiting-list"]);
  // A parameterised page is never a menu entry, but follows the same scope rule.
  const file = canonicalPageFor("/patients/7")!;
  expect(canonicalPageAllowed(file, [], false, { patientScope: "own" })).toBe(true);
  expect(canonicalPageAllowed(file, ["clinical.plans.view"], false, { patientScope: "none" })).toBe(false);
  expect(canonicalPageAllowed(file, [], true)).toBe(true);
  expect(canonicalPagesFor(["staff.view"], false, { patientScope: "all" }).map(p => p.href)).toEqual(["/visits", "/recall", "/patients", "/staff-access"]);
  // The appointment scope opens the appointments and the waiting list, never the patient list.
  expect(canonicalPagesFor([], false, { appointmentScope: "all" }).map(p => p.href)).toEqual(["/appointments", "/waiting-list"]);
 });
 it("a nested page never inherits its parent's grant", () => {
  expect(canonicalPageFor("/inventory/procurement/operations")?.anyOf).toEqual(["inventory.orders.view"]);
  expect(canonicalPageFor("/inventory/procurement")?.anyOf).toEqual(["inventory.requests.view"]);
  expect(canonicalPageFor("/inventory/procurement/review/x")?.anyOf).toEqual(["inventory.requests.approve"]);
  const requester = canonicalPagesFor(["inventory.requests.view"], false);
  expect(requester.includes(canonicalPageFor("/inventory/procurement/operations")!)).toBe(false);
 });
});
