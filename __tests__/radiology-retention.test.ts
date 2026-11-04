import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { assertNoRadiologyRequestHistory, ProtectedRadiologyHistoryError, RESET_KEEP_TABLES, RESET_WIPE_TABLES } from "../lib/clinic-reset";
it("classifies imaging snapshots as retained history, not wipe targets", () => {
  expect(RESET_KEEP_TABLES.filter(table => table === "radiology_requests")).toHaveLength(1);
  expect(RESET_WIPE_TABLES as readonly string[]).not.toContain("radiology_requests");
});
it.each([true, false, undefined])("locks before inspecting retained history and fails closed (%s)", async exists => {
  const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: exists === undefined ? [] : [{ exists }] });
  if (exists === false) await expect(assertNoRadiologyRequestHistory({ query })).resolves.toBeUndefined();
  else await expect(assertNoRadiologyRequestHistory({ query })).rejects.toBeInstanceOf(ProtectedRadiologyHistoryError);
  expect(query.mock.calls.map(call => call[0])).toEqual(["LOCK TABLE radiology_requests IN EXCLUSIVE MODE", "SELECT EXISTS (SELECT 1 FROM radiology_requests) AS exists"]);
});
// Supplemental structural evidence only; no database/concurrency claim.
it("guards reset before backup and includes the proven-empty FK table in the transactional truncate", () => {
  const source = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
  const reset = source.slice(source.indexOf("export async function resetClinicData"));
  expect(reset.indexOf("await assertNoRadiologyRequestHistory(client)")).toBeLessThan(reset.indexOf("const backed = await backup"));
  expect(reset).toContain("prescription_issuance_commands, radiology_requests, inventory_purchase_receipts");
});
it("guards reparent, deletion, and source merge before the respective writes", () => {
  const source = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
  const relink = source.slice(source.indexOf("export async function linkVisitToPatient"), source.indexOf("export async function deleteVisit"));
  expect(relink).toContain("SELECT 1 FROM radiology_requests WHERE visit_id=$1 LIMIT 1");
  expect(relink.indexOf("SELECT 1 FROM radiology_requests")).toBeLessThan(relink.indexOf("UPDATE visits"));
  const deletion = source.slice(source.indexOf("export async function deleteVisit"));
  expect(deletion.indexOf('reason: "has_radiology_history"')).toBeLessThan(deletion.indexOf("DELETE FROM visits"));
  const merge = source.slice(source.indexOf("export async function mergeDuplicatePatient"));
  expect(merge.indexOf('reason: "source_has_radiology_history"')).toBeLessThan(merge.indexOf("UPDATE ${"));
});
