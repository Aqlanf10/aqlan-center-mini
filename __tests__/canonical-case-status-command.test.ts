import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseCanonicalCaseStatus } from "../lib/canonical-case-status-command";
import { clinicalCaseStatusVersion } from "../lib/canonical-case-status-version";
const body = { status: "waiting", outcome: null, expectedVersion: "a".repeat(64) };
it("accepts explicit current version and preserves the existing trimmed outcome convention", () => {
  expect(parseCanonicalCaseStatus("1", { ...body, status: "cancelled", outcome: "  سبب سريري  " })).toEqual({ id: 1, status: "cancelled", outcome: "سبب سريري", expectedVersion: body.expectedVersion });
});
it.each([null, [], {}, { ...body, status: "billed" }, { ...body, status: "cancelled" }, { ...body, status: "cancelled", outcome: " " }, { ...body, outcome: 1 }, { ...body, outcome: "a".repeat(2001) }, { ...body, expectedVersion: "a" }, { ...body, actor: "owner" }, { ...body, responsiblePartyId: 1 }, { ...body, amount: 1 }])("refuses malformed or authority-bearing status input %#", value => expect(() => parseCanonicalCaseStatus("1", value)).toThrow());
it.each(["0", "01", "1e2", "1.1", "-1", "2147483648"])("refuses malformed id %s", id => expect(() => parseCanonicalCaseStatus(id, body)).toThrow());
it("keeps the comparison opaque and changes it for a changed row version", () => {
  const row = { id: 1, patientId: 2, specialty: "general", orthoCaseId: null, status: "active", outcome: null, completedAt: null, versionXmin: "123", versionTid: "(0,1)" };
  const version = clinicalCaseStatusVersion(row); expect(version).toMatch(/^[a-f0-9]{64}$/);
  expect(clinicalCaseStatusVersion({ ...row })).toBe(version);
  for (const changed of [{ versionTid: "(0,2)" }, { versionXmin: "124" }, { status: "waiting" }, { outcome: "نتيجة جديدة" }]) expect(clinicalCaseStatusVersion({ ...row, ...changed })).not.toBe(version);
});
