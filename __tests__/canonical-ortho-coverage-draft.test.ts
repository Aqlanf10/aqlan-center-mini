import { describe, expect, it } from "vitest";
import { makeCanonicalCoverageDraft } from "../lib/canonical-ortho-coverage-draft";
import type { CoverageEditorRead } from "../lib/canonical-ortho-coverage-editor-projection";
const context = (): CoverageEditorRead => ({ patientId: 1, orthoCaseId: 2, enabled: true, canEdit: true, current: null, applicable: false,
 sources: [{ patientId: 1, orthoCaseId: 2, clinicalCaseId: 3, planId: 4, planItemId: 5, invoiceId: 6, fingerprint: "a".repeat(64), invoiceNumber: "SYN", serviceName: "SYN" }] });
const values = { selected: "6:5", decision: "included" as const, reason: "Synthetic unsent intention" };
describe("session-owned unsent coverage draft", () => {
 it("retains only unsent values across refresh and restores choices against the same fresh source", () => {
  let active = true; const owner = makeCanonicalCoverageDraft({ authorized: () => active, deny() {} });
  owner.remember(values, context()); owner.invalidateRead(); active = false;
  expect(owner.restore(context())).toEqual({ selected: "", decision: "", reason: "" });
  active = true; expect(owner.restore(context())).toEqual(values);
  expect(owner.needsUnloadWarning()).toBe(true); expect(owner.canLeave(() => false)).toBe(false);
  expect(owner.canLeave(() => true)).toBe(true);
 });
 it.each(["fingerprint", "revision", "missing", "closed"])("changed %s never silently reapplies the old source/decision", kind => {
  const owner = makeCanonicalCoverageDraft({ authorized: () => true, deny() {} }), read = context(); owner.remember(values, read);
  if (kind === "fingerprint") read.sources[0].fingerprint = "b".repeat(64);
  if (kind === "revision") read.current = { id: "1", version: 1, reason: "SYN newer", decision: "excluded", createdAt: "2026-11-01T00:00:00Z", createdBy: "SYN" };
  if (kind === "missing") read.sources = [];
  if (kind === "closed") read.canEdit = false;
  expect(owner.restore(read)).toEqual({ selected: "", decision: "", reason: values.reason });
 });
 it("a denied or retired owner cannot be revived by a later successful old response", () => {
  let denials = 0; const owner = makeCanonicalCoverageDraft({ authorized: () => true, deny() { denials++; } });
  owner.remember(values, context()); owner.deny(); expect(denials).toBe(1);
  owner.remember(values, context()); expect(owner.restore(context())).toEqual({ selected: "", decision: "", reason: "" }); expect(owner.needsUnloadWarning()).toBe(false);
  owner.retire(); expect(owner.canLeave(() => false)).toBe(true);
 });
 it("terminal receipt clearing leaves no unsent source, reason or warning", () => {
  const owner = makeCanonicalCoverageDraft({ authorized: () => true, deny() {} }); owner.remember(values, context()); owner.clear();
  expect(owner.restore(context())).toEqual({ selected: "", decision: "", reason: "" }); expect(owner.needsUnloadWarning()).toBe(false);
 });
});
