import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useId: () => "SYN-clock", useEffect: () => undefined, useRef: () => ({ current: false }), useState: () => [hooks.values[hooks.cursor++], () => undefined] }));
vi.mock("../components/patient/CanonicalOrthoAssessment", () => ({ CanonicalOrthoAssessment: () => null }));
vi.mock("../components/patient/CanonicalOrthoStrategy", () => ({ CanonicalOrthoStrategy: () => null }));
vi.mock("../components/patient/CanonicalCephStudy", () => ({ CanonicalCephStudy: () => null }));
vi.mock("../components/patient/CanonicalCephComparison", () => ({ CanonicalCephComparison: () => null }));
vi.mock("../components/patient/CanonicalCephDiscard", () => ({ CanonicalCephDiscard: () => null }));
vi.mock("../components/patient/CanonicalCephReferences", () => ({ CanonicalCephReferences: () => null }));
const { CanonicalOrthoDetail } = await import("../components/patient/CanonicalOrthoDetail");
const { CanonicalClinicalPlans } = await import("../components/patient/CanonicalClinicalPlans");
const { CanonicalPatientCases } = await import("../components/patient/CanonicalPatientCases");
const { CanonicalCephStudies } = await import("../components/patient/CanonicalCephStudies");
const { CanonicalCephStudy } = await vi.importActual<typeof import("../components/patient/CanonicalCephStudy")>("../components/patient/CanonicalCephStudy");
const { CanonicalCephComparison } = await vi.importActual<typeof import("../components/patient/CanonicalCephComparison")>("../components/patient/CanonicalCephComparison");
const { CanonicalCephDiscard } = await vi.importActual<typeof import("../components/patient/CanonicalCephDiscard")>("../components/patient/CanonicalCephDiscard");
const instant = "2026-10-31T22:30:00.000Z";
function markup(values: unknown[], render: () => React.ReactNode) { hooks.cursor = 0; hooks.values = values; return renderToStaticMarkup(render()); }
const props = { patientId: "1", caseId: 2, studyId: 2, ownerKey: "SYN", canAnalyze: false, canEdit: false, canDocument: false, onChanged: () => undefined, onCompleted: () => undefined, onCopied: () => undefined };
const summary = { id: 2, patientId: 1, status: "completed" as const, phase: "pretreatment" as const, xrayDate: null, createdAt: instant, completedAt: instant, imageState: "available" as const, findings: null };
describe.each([["Asia/Aden", "الأحد 01/11/2026"], ["America/New_York", "السبت 31/10/2026"]])("clinic date labels in %s", (zone, expected) => {
it("orthodontic closure at 01:30 Aden uses Nov1, while retainer and adjustment calendar dates stay literal", () => {
  const feed = { clinicTimeZone: zone, case: { id: 2, patientId: 1, status: "completed", closedAt: instant, closedNote: "SYN", retainer: "essix", retainerOn: "2026-10-31" }, progress: { adjustments: 1 }, adjustments: [{ id: 1, doneOn: "2026-10-31" }] };
  const html = markup([true, 0, feed, null], () => CanonicalOrthoDetail(props));
  expect(html).toContain(expected); expect(html).toContain("2026-10-31");
});
it("plan creation, consent and item completion use the clinic day without moving the planned start date", () => {
  const feed = { clinicTimeZone: zone, plans: [{ id: 1, title: "SYN", status: "active", startDate: "2026-10-31", createdAt: instant, consentAt: instant, items: [{ id: 1, serviceName: "SYN", status: "done", doneAt: instant, quantity: 1, sessionsCompleted: 1 }] }] };
  const html = markup([true, 0, feed, null], () => CanonicalClinicalPlans({ patientId: "1" }));
  expect(html.split(expected)).toHaveLength(4); expect(html).toContain("2026-10-31");
});
it("specialty completion and problem registration use the clinic day without moving the clinical start date", () => {
  const feed = { clinicTimeZone: zone, orthoVisible: true, planVisible: true, cases: [{ id: 1, kind: "specialty", title: "SYN", specialty: "general", status: "completed", startedOn: "2026-10-31", completedAt: instant }], problems: [{ id: 1, label: "SYN", status: "active", notedBy: "SYN", notedAt: instant }], items: [], dependencies: [] };
  const html = markup([true, 0, feed, null], () => CanonicalPatientCases(props));
  expect(html.split(expected)).toHaveLength(3); expect(html).toContain("2026-10-31");
});
it("cephalometric registration and approval use the clinic day without moving the xray calendar date", () => {
  const feed = { clinicTimeZone: zone, analyses: [{ ...summary, xrayDate: "2026-10-31" }], hasMore: false };
  const html = markup([true, 0, feed, null, null], () => CanonicalCephStudies(props));
  expect(html.split(expected)).toHaveLength(3); expect(html).toContain("2026-10-31");
});
it("the saved cephalometric diagnosis timestamp uses the clinic day", () => {
  const feed = { clinicTimeZone: zone, analysis: { ...summary, refSet: "SYN", createdBy: "SYN", calibration: null }, landmarks: [], measurements: [], diagnosis: { finalDx: "SYN", createdBy: "SYN", updatedAt: instant } };
  expect(markup([true, 0, feed, null], () => CanonicalCephStudy(props))).toContain(expected);
});
it("the explicit draft discard confirmation uses the clinic day of the observed study", () => {
  const observed = { clinicTimeZone: zone, analysis: { ...summary, status: "draft", createdBy: "SYN" }, discardVersion: "a".repeat(64) };
  const initial = { pending: false, id: null, warning: false };
  expect(markup([initial, false, null, false, false, observed, "", false, null], () => CanonicalCephDiscard({ patientId: "1", ownerKey: "SYN", draftId: 2, refresh: () => undefined, onDiscarded: () => undefined }))).toContain(expected);
});
it("comparison selection falls back to the clinic day when the xray date is absent", () => {
  const render = CanonicalCephComparison as unknown as (p: { patientId: string; studies: typeof summary[]; clinicTimeZone: string }) => React.ReactNode;
  expect(markup([true, "", "", null, null, null], () => render({ patientId: "1", studies: [summary], clinicTimeZone: zone }))).toContain(expected);
});

});
