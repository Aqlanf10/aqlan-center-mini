import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { CanonicalPlanDependencyRefusal, parseCanonicalPlanDependency } from "../lib/canonical-plan-dependency-command";
import { planDependencyVersion } from "../lib/canonical-plan-dependency-version";
const body = { requiresItemId: 2, requirement: "completed", note: null };
it("requires explicit bounded canonical dependency fields and preserves the existing trimmed note convention", () => {
  expect(parseCanonicalPlanDependency("add", "1", { ...body, note: "  ملاحظة سريرية  " })).toEqual({ kind: "add", itemId: 1, ...body, note: "ملاحظة سريرية" });
  expect(parseCanonicalPlanDependency("add", "1", { ...body, requirement: "clearance" })).toMatchObject({ requirement: "clearance" });
  expect(parseCanonicalPlanDependency("remove", "1", { requiresItemId: 2, expectedVersion: "a".repeat(64) })).toMatchObject({ kind: "remove" });
});
it.each([null, [], {}, { ...body, requiresItemId: 1 }, { ...body, requiresItemId: "2" }, { ...body, requirement: "paid" }, { ...body, note: "a".repeat(501) }, { ...body, note: 3 }, { ...body, actor: "owner" }, { ...body, amount: 2 }])("refuses malformed or authority-bearing add input %#", value => {
  expect(() => parseCanonicalPlanDependency("add", "1", value)).toThrow();
});
it.each(["0", "01", "1e2", "1.2", "-1", "2147483648"])("refuses malformed route id %s", id => expect(() => parseCanonicalPlanDependency("add", id, body)).toThrow());
it.each([{ requiresItemId: 2 }, { requiresItemId: 2, expectedVersion: "a" }, { requiresItemId: 2, expectedVersion: "a".repeat(64), actor: "owner" }])("refuses an incomplete or expanded deletion comparison %#", value => expect(() => parseCanonicalPlanDependency("remove", "1", value)).toThrow());
it("hashes the stored edge version without leaking its physical identity", () => {
  const row = { itemId: 1, requiresItemId: 2, requirement: "completed", note: null, createdBy: "SYN", createdAt: "2024-01-01 00:00:00.123456+00", rowXmin: "123", rowTid: "(0,1)" };
  const version = planDependencyVersion(row); expect(version).toMatch(/^[a-f0-9]{64}$/); expect(planDependencyVersion({ ...row })).toBe(version);
  for (const changed of [{ rowTid: "(0,2)" }, { rowXmin: "124" }, { createdAt: "2024-01-01 00:00:00.123457+00" }, { note: "تغيّر" }]) expect(planDependencyVersion({ ...row, ...changed })).not.toBe(version);
});

it("rejects a JSON array requirement with an explicit 400 refusal", () => {
  let failure: unknown;
  try { parseCanonicalPlanDependency("add", "1", { ...body, requirement: ["completed"] }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(CanonicalPlanDependencyRefusal);
  expect(failure).toMatchObject({ code: "invalid_plan_dependency", status: 400 });
});
it("rejects a JSON object requirement without invoking its conversion hooks", () => {
  let failure: unknown;
  try { parseCanonicalPlanDependency("add", "1", { ...body, requirement: { toString: "completed" } }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(CanonicalPlanDependencyRefusal);
  expect(failure).toMatchObject({ code: "invalid_plan_dependency", status: 400 });
});
