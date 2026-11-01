import { expect, it, vi } from "vitest";
import { isCanonicalOrthoCoverage } from "../lib/canonical-ortho-coverage-projection";
vi.mock("server-only", () => ({}));
const { canonicalCoverageQuery } = await import("../lib/canonical-ortho-coverage");
const good = { clinicTimeZone: "Asia/Aden", projection: "ortho-followup-coverage", patientId: 1, orthoCaseId: 2, enabled: true, current: { id: "1", version: 1, decision: "included", reason: "SYN", createdAt: "2026-10-01T00:00:00Z", createdBy: "SYN" }, applicable: true, invoiceSources: { state: "restricted" } };
it("accepts only the exact positive patient/case query", () => { expect(canonicalCoverageQuery("2", new URLSearchParams("patientId=1"))).toEqual({ caseId: 2, patientId: 1 }); expect(isCanonicalOrthoCoverage(good, 1, 2)).toBe(true); });
it.each(["", "patientId=0", "patientId=01", "patientId=2147483648", "patientId=1&patientId=1", "patientId=1&invoice=1", "patientId=1&scope=all"])("refuses ambiguous query %s", q => { expect(() => canonicalCoverageQuery("2", new URLSearchParams(q))).toThrow(); });
it.each(["0", "01", "2147483648", "2.0"])("refuses case %s", id => { expect(() => canonicalCoverageQuery(id, new URLSearchParams("patientId=1"))).toThrow(); });
it.each([
  { clinicTimeZone: undefined }, { clinicTimeZone: "Not/AZone" }, { clinicTimeZone: 3 }, { patientId: 3 }, { orthoCaseId: 3 }, { projection: "legacy" }, { enabled: false }, { current: null },
  { current: { ...good.current, decision: "unknown" } }, { current: { ...good.current, createdAt: "invalid" } },
  { invoiceSources: { state: "restricted", items: [] } }, { invoiceSources: { state: "allowed", items: [{ invoiceId: 1 }] } },
])("refuses malformed or wrong-scope response %j", patch => { expect(isCanonicalOrthoCoverage({ ...good, ...patch }, 1, 2)).toBe(false); });
it("distinguishes unavailable and absent decisions without inventing inclusion or exclusion", () => { expect(isCanonicalOrthoCoverage({ ...good, enabled: false, current: null, applicable: false }, 1, 2)).toBe(true); expect(isCanonicalOrthoCoverage({ ...good, current: null, applicable: false }, 1, 2)).toBe(true); });
