import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CephAnalysisForCompare } from "../lib/db";
import { cephComparisonProjectionSha256 } from "../lib/ceph-comparison-projection";
const m = vi.hoisted(() => ({ study: vi.fn(), access: vi.fn(), patient: vi.fn(), settings: vi.fn() }));
vi.mock("../lib/db", () => ({ getCephAnalysisForCompare: m.study, getPatient: m.patient, getSettingsSafe: m.settings }));
vi.mock("../lib/session", () => ({ requireSession: async () => ({ role: "doctor" }) }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: m.access }));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("not found"); } }));
vi.mock("../components/PrintDocument", () => ({ PrintMetadata: ({ children }: { children: ReactNode }) => children, PrintTableFrame: ({ children }: { children: ReactNode }) => children }));
vi.mock("../components/PrintHeader", () => ({ PrintHeader: () => null, PrintFooter: () => null }));
vi.mock("../components/PrintButton", () => ({ PrintButton: () => null }));
import { GET as compare } from "../app/api/ceph/compare/route";
import { GET as overlay } from "../app/api/ceph/superimpose/route";
import Print from "../app/print/ceph-compare/page";
const source = (id: number, xrayDate: string | null): CephAnalysisForCompare => {
  const projection: Omit<CephAnalysisForCompare, "projectionSha256"> = { id, patientId: 1, documentId: id + 10,
    status: "draft", provenanceState: "not_completed", imageSha256: null, phase: "posttreatment", xrayDate,
    // Upload order and phase deliberately disagree with acquisition order.
    createdAt: id === 1 ? "2025-12-30" : "2024-01-01", mmPerPixel: .1,
    points: { S: { x: 20, y: 20 }, N: { x: id === 1 ? 80 : 100, y: 20 }, Me: { x: 60, y: 100 } },
    documentWidth: 800, documentHeight: 600, measurements: [{ code: "SNA", name: "SNA", value: id === 1 ? 90 : 84, mean: 82, unit: "°" }],
    comparisonUnavailableReason: null, provenanceNotice: null };
  return { ...projection, projectionSha256: cephComparisonProjectionSha256(projection) };
};
let studies: CephAnalysisForCompare[];
beforeEach(() => { vi.clearAllMocks(); m.access.mockResolvedValue(true); m.patient.mockResolvedValue({ fullName: "Synthetic" }); m.settings.mockResolvedValue({}); studies = [source(1, "2020-01-01"), source(2, "2022-01-01")]; m.study.mockImplementation(async (id: number) => studies.find(s => s.id === id)); });
const request = (query = "first=1&second=2") => new Request(`http://localhost/api/ceph/compare?${query}`);
const ambiguous = [null, "2020-01-01", "2024-02-30", "02/03/2024", "2024-01-01T00:00:00Z", "", "2024-1-1"];
describe("actual xrayDate projection acquisition ordering", () => {
  it.each(["first=1&second=2", "first=2&second=1"])("uses acquisition rather than upload order: %s", async query => {
    const response = await compare(request(query)); expect(response.status).toBe(200);
    const data = await response.json(); expect(data.before.id).toBe(1); expect(data.after.id).toBe(2);
    expect(data.comparison.measurements[0].delta).toBe(-6);
    const placed = await (await overlay(request(query))).json(); expect(placed.before.id).toBe(1); expect(placed.after.id).toBe(2);
    expect(placed.cranialBaseAfter - placed.cranialBaseBefore).toBe(2);
  });
  it.each(ambiguous)("withholds both directions when second acquisition date is %j", async date => {
    studies[1] = source(2, date);
    for (const route of [compare, overlay]) {
      const response = await route(request()); expect(response.status).toBe(409);
      const data = await response.json(); expect(data.code).toBe("CEPH_ORDER_REQUIRED");
      expect(data.comparison).toBeUndefined(); expect(data.before).toBeUndefined();
    }
  });
  it.each(["", "0", "3", "1.0", "1e0", "-1", "NaN", "1&reference=2"])("rejects invalid reference %s", async reference => {
    studies[1] = source(2, null);
    for (const route of [compare, overlay]) expect((await route(request(`first=1&second=2&reference=${reference}`))).status).toBe(400);
  });
  it("does not silently override or accept a reference for known distinct dates", async () => {
    for (const reference of [1, 2]) for (const route of [compare, overlay]) expect((await route(request(`first=1&second=2&reference=${reference}`))).status).toBe(400);
  });
  it.each([1, 2])("honors deliberate reference %i without grading unknown chronology", async reference => {
    studies[1] = source(2, null);
    for (const query of [`first=1&second=2&reference=${reference}`, `first=2&second=1&reference=${reference}`]) {
      const data = await (await compare(request(query))).json();
      expect(data.before.id).toBe(reference); expect(data.comparison.measurements[0]).toMatchObject({ delta: reference === 1 ? -6 : 6, direction: "ungraded", gapBefore: null, gapAfter: null });
      expect(data.ordering).toMatchObject({ mode: "explicit_reference", referenceId: reference, chronology: "unknown" });
      const placed = await (await overlay(request(query))).json(); expect(placed.before.id).toBe(reference); expect(placed.ordering).toEqual(data.ordering);
    }
  });
  it("prints acquisition ordering, not upload ordering", async () => {
    const output = renderToStaticMarkup(await Print({ searchParams: Promise.resolve({ first: "1", second: "2" }) }));
    expect(output.indexOf("#1")).toBeLessThan(output.indexOf("#2")); expect(output).toContain("-6.0");
  });
  it("withholds directional print output until reference is deliberately selected", async () => {
    studies[1] = source(2, null);
    const output = renderToStaticMarkup(await Print({ searchParams: Promise.resolve({ first: "1", second: "2" }) }));
    expect(output).not.toContain("-6.0"); expect(output).not.toContain("6.0"); expect(output).toContain("الترتيب الزمني غير محسوم");
  });
});


describe("reference print and authorization boundaries", () => {
  it.each([1, 2])("prints explicit reference %i with subtraction direction and no inferred temporal labels", async reference => {
    studies[1] = source(2, null);
    const output = renderToStaticMarkup(await Print({ searchParams: Promise.resolve({ first: "2", second: "1", reference: String(reference) }) }));
    expect(output).toContain("الترتيب الزمني غير محسوم"); expect(output).toContain("تحليل المقارنة ناقص المرجع");
    expect(output).toContain(reference === 1 ? "-6.0" : "+6.0");
    expect(output).toContain(`المرجع: #${reference}`);
    expect(output).toContain('>المرجع</th>'); expect(output).toContain('>المقارنة</th>');
    for (const claim of [">قبل</th>", ">بعد</th>", "قبل العلاج", "بعد العلاج", "اقترب من المعيار", "ابتعد عن المعيار"]) expect(output).not.toContain(claim);
  });
  it.each(["first", "second", "reference"])("rejects duplicate/array print %s parameters before reads", async key => {
    await expect(Print({ searchParams: Promise.resolve({ first: "1", second: "2", [key]: ["1", "2"] }) })).rejects.toThrow("not found");
    expect(m.study).not.toHaveBeenCalled(); expect(m.patient).not.toHaveBeenCalled();
  });
  it.each(["first=1&first=2&second=2", "first=1&second=2&second=1", "first=1e0&second=2", "first=1&second=02", "first=1&second=9007199254740993"])("rejects malformed or repeated pair IDs: %s", async query => {
    for (const route of [compare, overlay]) expect((await route(request(query))).status).toBe(400);
    expect(m.study).not.toHaveBeenCalled();
  });
  it("rejects known-date print reference rather than silently overriding dates", async () => {
    await expect(Print({ searchParams: Promise.resolve({ first: "1", second: "2", reference: "2" }) })).rejects.toThrow("not found");
    expect(m.patient).not.toHaveBeenCalled();
  });
  it("denies unresolved choices before disclosing acquisition metadata", async () => {
    studies[1] = source(2, null); m.access.mockResolvedValue(false);
    for (const route of [compare, overlay]) {
      const response = await route(request()); expect(response.status).toBe(403);
      const payload = await response.json(); expect(payload.choices).toBeUndefined(); expect(payload.code).toBeUndefined(); expect(JSON.stringify(payload)).not.toContain("2020-01-01");
    }
    await expect(Print({ searchParams: Promise.resolve({ first: "1", second: "2" }) })).rejects.toThrow("not found");
    expect(m.patient).not.toHaveBeenCalled(); expect(m.settings).not.toHaveBeenCalled();
  });
  it("preserves immutable/unavailable record gates before offering a reference", async () => {
    studies[1] = { ...source(2, null), comparisonUnavailableReason: "Historical witness unavailable" };
    for (const route of [compare, overlay]) {
      const response = await route(request()); expect(response.status).toBe(409); expect(await response.json()).toEqual({ message: "Historical witness unavailable" });
    }
  });
});


it.each(["__proto__", "constructor"])("prints unknown phase %s as plain record metadata", async phase => {
  studies[0].phase = phase;
  const output = renderToStaticMarkup(await Print({ searchParams: Promise.resolve({ first: "1", second: "2" }) }));
  expect(output).toContain(phase); expect(output).toContain("-6.0");
});


// Defensive route/print boundary fixtures. A healthy DB permits only one draft
// per patient; two same-patient draft projections here are mocked, not evidence
// that a valid current public pair can reach the old helper's grading path.
describe("production comparison surfaces do not infer suitable norms from chronology", () => {
  it.each([[82, 82], [100, 100], [100, 82], [null, null]])("withholds grades and gaps for means %s/%s", async (firstMean, secondMean) => {
    studies[0].measurements[0].mean = firstMean; studies[1].measurements[0].mean = secondMean;
    const data = await (await compare(request())).json();
    expect(data.comparison).toMatchObject({ interpretation: { mode: "descriptive_only", reason: "reference_suitability_not_established" }, improved: 0, worsened: 0, steady: 0 });
    expect(data.comparison.measurements[0]).toMatchObject({ delta: -6, gapBefore: null, gapAfter: null, direction: "ungraded" });
    expect(data.summary.en).toContain("Normative reference suitability and consistency for this comparison have not been established");
    const output = renderToStaticMarkup(await Print({ searchParams: Promise.resolve({ first: "1", second: "2" }) }));
    expect(output).toContain("-6.0"); expect(output).toContain("لم تُثبت ملاءمة المراجع المعيارية واتساقها لهذه المقارنة");
    for (const claim of ["اقترب من المعيار", "ابتعد عن المعيار", "بلا تغيّر يُذكر", "بلا معيار", ">الحكم</th>"]) expect(output).not.toContain(claim);
  });
  it("prints the reference suitability limitation for explicit orientation too", async () => {
    studies[1] = source(2, null);
    const output = renderToStaticMarkup(await Print({ searchParams: Promise.resolve({ first: "1", second: "2", reference: "2" }) }));
    expect(output).toContain("+6.0"); expect(output).toContain("لم تُثبت ملاءمة المراجع المعيارية واتساقها لهذه المقارنة");
  });
});
