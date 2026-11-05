import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { computeAll, enrichWithRefs, isCephLandmarkCode } from "../lib/ceph";
import { CEPH_UNAVAILABLE_NOTICE, displayableCephSnapshot, isQuarantinedCephMeasurement, presentCephMeasurements } from "../lib/cephPresentation";

const { study } = vi.hoisted(() => ({ study: {
  analysis: { id: 909, patientId: 1, documentId: 2, status: "completed" as const, orthoCaseId: null,
    phase: "pretreatment" as const, xrayDate: null, device: null, refSet: "", calibration: null,
    mmPerPixel: 0.1, note: null, createdBy: "Synthetic", createdAt: "2026-11-05", completedBy: "Synthetic", completedAt: "2026-11-05", findings: null },
  landmarks: ["A", "B", "OcclA", "OcclP"].map(code => ({ code, x: 30, y: 40, source: "manual" as const })),
  measurements: [{ code: "EXT_INDEX", value: 9999 }, { code: "SNA", value: 77.7 }], diagnosis: null,
} }));
vi.mock("../lib/db", () => ({ getCephStudy: async () => study, getSettingsSafe: async () => ({}), getPatient: async () => ({ fullName: "Synthetic only" }), getCephReferenceSet: async () => null }));
vi.mock("../lib/session", () => ({ requireSession: async () => ({ username: "synthetic" }) }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: async () => true }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: ReactNode }) => createElement("a", props, children) }));
vi.mock("../components/PrintDocument", () => ({ PrintMetadata: ({ children }: { children: ReactNode }) => children, PrintTableFrame: ({ children }: { children: ReactNode }) => children }));
vi.mock("../components/PrintHeader", () => ({ PrintHeader: () => null, PrintFooter: () => null }));
vi.mock("../components/PrintButton", () => ({ PrintButton: () => null }));
import { CephTracer } from "../components/CephTracer";
import PrintPage from "../app/print/ceph/[id]/page";

function extractionRow(html: string) {
  return html.match(/<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*?<b>EXT_INDEX<\/b>(?:(?!<\/tr>)[\s\S])*?<\/tr>/)?.[0]
    ?? html.match(/<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*?<span[^>]*>EXT_INDEX<\/span>(?:(?!<\/tr>)[\s\S])*?<\/tr>/)?.[0];
}
describe("quarantined historical cephalometric output", () => {
  it("never restores or grades a saved extraction number and preserves other sealed values", () => {
    const archive = Object.freeze(study.measurements.map(row => Object.freeze({ ...row })));
    const display = presentCephMeasurements(computeAll({}, 0.1), archive);
    expect(display.find(row => row.code === "SNA")?.value).toBe(77.7);
    expect(display.find(row => row.code === "EXT_INDEX")).toMatchObject({ value: null, display: "—", status: null, severityStars: "", note: CEPH_UNAVAILABLE_NOTICE });
    expect(enrichWithRefs(display, { EXT_INDEX: { mean: 1, sd: 1 } }).find(row => row.code === "EXT_INDEX")).toMatchObject({ z: null, refSeverity: null, refLabel: null });
    expect(archive[0].value).toBe(9999);
    expect(displayableCephSnapshot(archive)).toEqual([{ code: "SNA", value: 77.7 }]);
  });
  it("does not recompute a completed study with an empty snapshot", () => {
    const live = computeAll({ S: { x: 0, y: 0 }, N: { x: 10, y: 0 }, A: { x: 10, y: 10 } }, 0.1);
    expect(live.find(row => row.code === "SNA")?.value).not.toBeNull();
    expect(presentCephMeasurements(live, []).every(row => row.value === null)).toBe(true);
  });
  it("renders the actual completed tracer with an unavailable extraction row", () => {
    const html = renderToStaticMarkup(createElement(CephTracer, {
      patientName: "Synthetic only", patientBirthYear: null, analysis: study.analysis,
      initialLandmarks: study.landmarks as Parameters<typeof CephTracer>[0]["initialLandmarks"],
      stamped: study.measurements, refValues: null, refSetName: null, diagnosis: null,
    }));
    expect(html).not.toContain("9999"); expect(html).toContain("77.7");
    expect(html).toContain(CEPH_UNAVAILABLE_NOTICE);
    const row = extractionRow(html); expect(row).toBeTruthy();
    expect(row).not.toContain("***"); expect(row).toContain("غير متاح");
  });
  it("renders the actual report without a historical extraction value or invalid Wits SVG", async () => {
    const html = renderToStaticMarkup(await PrintPage({ params: Promise.resolve({ id: "909" }) }));
    expect(html).not.toContain("9999"); expect(html).toContain("77.7");
    expect(html).not.toContain('="NaN"'); expect(html).not.toContain('="Infinity"');
    expect(html).toContain(CEPH_UNAVAILABLE_NOTICE);
    const row = extractionRow(html); expect(row).toBeTruthy();
    expect(row).not.toContain("***"); expect(row).toContain("غير متاح");
  });
});

const source = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
function reader(name: string, endMarker: string, query: ReturnType<typeof vi.fn>) {
  const start = source.indexOf(`export async function ${name}(`), end = source.indexOf(endMarker, start);
  if (start < 0 || end < start) throw new Error("Missing production reader");
  const compiled = transformSync(source.slice(start, end).replace(/^export /gm, ""), { loader: "ts", target: "node22" }).code;
  const dependencies = { ensureSchema: async () => {}, getPool: () => ({ query }), computeAll, isCephLandmarkCode,
    displayableCephSnapshot, isQuarantinedCephMeasurement, mapCephAnalysis: (row: unknown) => row };
  return new Function(...Object.keys(dependencies), compiled + `\nreturn ${name};`)(...Object.values(dependencies));
}
describe("read boundaries preserve archives while withholding quarantined values", () => {
  it("filters comparison snapshots without executing any mutation", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: 909, patient_id: 1, document_id: 2, status: "completed", mm_per_pixel: 0.1, created_at: new Date(), phase: "pretreatment" }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: study.measurements });
    const result = await reader("getCephAnalysisForCompare", "// ─── الوصفات", query)(909);
    expect(result.measurements.map((row: { code: string }) => row.code)).toEqual(["SNA"]);
    expect(result.measurements[0].value).toBe(77.7);
    expect(query.mock.calls.every(([sql]) => /^\s*SELECT/.test(sql))).toBe(true);
    expect(study.measurements[0].value).toBe(9999);
  });
  it("filters study GET snapshots without rewriting archival records", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ status: "completed" }] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: study.measurements }).mockResolvedValueOnce({ rows: [] });
    const result = await reader("getCephStudy", "export interface CephCalibrationInput", query)(909);
    expect(result.measurements).toEqual([{ code: "SNA", value: 77.7 }]);
    expect(query.mock.calls.every(([sql]) => /^\s*SELECT/.test(sql))).toBe(true);
  });
  it("filters the stamped-value reader without rewriting archival records", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ status: "completed" }] }).mockResolvedValueOnce({ rows: study.measurements });
    expect(await reader("getCephStampedValues", "// ─── المخزون", query)(909)).toEqual([{ code: "SNA", value: 77.7 }]);
    expect(query.mock.calls.every(([sql]) => /^\s*SELECT/.test(sql))).toBe(true);
  });
});
