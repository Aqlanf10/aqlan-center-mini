import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transformSync } from "esbuild";
import { describe, it } from "vitest";
import * as view from "../lib/ceph-report-view";

/** Execute the actual TSX page with isolated read-only dependencies and a JSX
 * tree collector. These are route-logic tests, not React/Next/browser/DB tests. */
interface Node { type: string | ((props: Record<string, unknown>) => unknown); props: Record<string, unknown> }
function h(type: Node["type"], props: Record<string, unknown> | null, ...children: unknown[]): Node {
  return { type, props: { ...props, children } };
}
const fragment = ({ children }: Record<string, unknown>) => children;
function flatten(tree: unknown): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(flatten);
  if (!tree || typeof tree !== "object" || !("type" in tree) || !("props" in tree)) return [];
  const node = tree as Node;
  return typeof node.type === "function" ? flatten(node.type(node.props)) : [node, ...flatten(node.props.children)];
}
function text(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(text).join(" ");
  if (tree == null || typeof tree === "boolean") return "";
  if (typeof tree !== "object") return String(tree);
  const node = tree as Node;
  return typeof node.type === "function" ? text(node.type(node.props)) : text(node.props.children);
}
function load(relative: string, dependencies: Record<string, unknown>): Record<string, unknown> {
  const source = readFileSync(resolve(relative), "utf8");
  const code = transformSync(source, { loader: "tsx", format: "cjs", target: "node22",
    jsxFactory: "h", jsxFragment: "fragment" }).code;
  const module = { exports: {} };
  const require = (id: string) => {
    if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected dependency: ${id}`);
    return dependencies[id];
  };
  new Function("require", "module", "exports", "h", "fragment", code)(require, module, module.exports, h, fragment);
  return module.exports;
}
const tracing = load("components/CephReportTracing.tsx", { "@/lib/ceph-report-view": view });
const points = (offset = 0) => [
  { code: "S", x: 10 + offset, y: 20 }, { code: "N", x: 40 + offset, y: 15 },
  { code: "A", x: 45 + offset, y: 55 }, { code: "Me", x: 38 + offset, y: 90 },
];
function fixture() {
  return { analysis: { id: 401, patientId: 402, documentId: 403, status: "draft", phase: "pretreatment",
    xrayDate: null as string | null, mmPerPixel: 0.25, refSet: "synthetic", completedBy: "current-synthetic-actor", completedAt: "2026-03-02" },
    landmarks: points(700), measurements: [{ code: "SNA", value: 83.3 }],
    diagnosis: { finalDx: "current-synthetic-diagnosis" },
    provenance: { state: "not_completed", witness: { analysisId: 401, recordedPatientId: 402,
      actor: { username: "sealed-synthetic-actor", userId: 404 }, sealedAt: "2025-12-01T00:00:00.000Z",
      snapshot: { patientId: 402, documentId: 403, mmPerPixel: 0.05, landmarks: points(),
        diagnosis: { finalDx: "sealed-synthetic-diagnosis" } },
      image: { documentId: 403, sha256: "a".repeat(64) }, referenceSet: { name: "Synthetic reference", version: "v1" },
      referenceSetSha256: "b".repeat(64), measurements: [] } } };
}
async function render(study = fixture(), options: { authorized?: boolean; loggedIn?: boolean; rawId?: string } = {}) {
  const calls = { compute: 0, patient: 0, sealed: null as unknown };
  const children = ({ children }: Record<string, unknown>) => children;
  const dependencies = {
    "@/components/CephSavedCompletionEvidence": { CephSavedCompletionEvidence: () => null },
    "@/components/CephReportTracing": tracing, "@/lib/ceph-report-view": view,
    "@/components/PrintDocument": { PrintMetadata: children, PrintTableFrame: children },
    "@/components/CephDraftReferenceEvidence": { CephDraftReferenceEvidence: () => null },
    "@/components/CephScientificContext": { CephScientificContext: () => null },
    "next/navigation": { notFound: () => { throw new Error("NOT_FOUND"); } },
    "@/lib/db": { getCephStudy: async () => study, getSettingsSafe: async () => ({}),
      getPatient: async () => { calls.patient++; return { fullName: "Synthetic only", birthYear: 2010 }; } },
    "@/lib/ceph": { computeAll: () => { calls.compute++; return []; }, isDescriptiveCephMeasurement: () => false },
    "@/components/PrintHeader": { PrintHeader: () => null, PrintFooter: () => null },
    "@/components/PrintButton": { PrintButton: () => h("button", { "data-testid": "print" }) },
    "@/lib/session": { requireSession: async () => options.loggedIn === false ? null : { username: "synthetic" } },
    "@/lib/patient-access": { canAccessPatient: async () => options.authorized !== false },
    "@/lib/reminders": { friendlyDateLong: (value: string) => value },
    "@/lib/cephPresentation": { CEPH_UNAVAILABLE_NOTICE: "quarantine-notice", CEPH_INTEGRITY_NOTICE: "integrity-notice",
      cephDraftReferenceContext: () => ({ name: "Synthetic draft reference", refs: null }),
      cephCompletionNotice: () => "completion-notice", isQuarantinedCephMeasurement: () => false,
      presentCephMeasurements: (_live: unknown, sealed: unknown) => { calls.sealed = sealed; return []; },
      enrichPresentedCephMeasurements: () => [] },
  };
  const page = load("app/print/ceph/[id]/page.tsx", dependencies).default as
    (input: { params: Promise<{ id: string }> }) => Promise<unknown>;
  const tree = await page({ params: Promise.resolve({ id: options.rawId ?? "401" }) });
  return { tree, nodes: flatten(tree), text: text(tree), calls };
}
const completed = () => { const data = fixture(); data.analysis.status = "completed"; data.provenance.state = "versioned"; return data; };

describe("actual report page source selection and lifecycle", () => {
  it("draft without acquisition date never fabricates current age or paper scale", async () => {
    const result = await render();
    assert.match(result.text, /يلزم تاريخ تصوير صالح/);
    assert.doesNotMatch(result.text, /1:100|الوجه يواجه اليمين|16 سنة/);
    assert.match(result.text, /غير صالح للقياس من الورق/);
    assert.equal(result.calls.compute, 1);
  });
  it("renders saved coordinates, never today's divergent draft, without recomputing", async () => {
    const data = completed(), result = await render(data);
    const circles = result.nodes.filter(node => node.type === "circle");
    assert.equal(circles.length, 4); assert.equal(circles[0].props.cx, 10);
    assert.equal(result.calls.compute, 0); assert.equal(result.calls.sealed, data.measurements);
    assert.ok(result.nodes.some(node => node.props["data-source"] === "sealed"));
  });
  it("uses saved calibration, actor, timestamp and diagnosis", async () => {
    const result = await render(completed());
    assert.match(result.text, /0\.05 mm\/px/); assert.doesNotMatch(result.text, /0\.25 mm\/px/);
    assert.match(result.text, /sealed-synthetic-actor/); assert.doesNotMatch(result.text, /current-synthetic-actor/);
    assert.match(result.text, /2025-12-01/); assert.match(result.text, /sealed-synthetic-diagnosis/);
    assert.doesNotMatch(result.text, /current-synthetic-diagnosis/);
  });
  it("does not borrow live geometry for empty saved geometry", async () => {
    const data = completed(); data.provenance.witness.snapshot.landmarks = [];
    const result = await render(data); assert.equal(result.calls.compute, 0);
    assert.equal(result.nodes.filter(node => node.type === "svg").length, 0);
    assert.ok(result.nodes.some(node => node.props["data-reason"] === "insufficient_landmarks"));
  });
  it("does not display unversioned completed geometry or calibration", async () => {
    const data = completed(); data.provenance.state = "unversioned";
    const result = await render(data); assert.equal(result.calls.compute, 0);
    assert.equal(result.nodes.filter(node => node.type === "svg").length, 0);
    assert.match(result.text, /المعايرة التاريخية غير موثّقة/);
  });
  it("withholds corrupt approval before patient presentation or calculation", async () => {
    const data = completed(); data.provenance.state = "integrity_unavailable";
    const result = await render(data); assert.equal(result.text, "integrity-notice");
    assert.equal(result.calls.compute, 0); assert.equal(result.calls.patient, 0);
  });
  it("withholds a mismatched saved source", async () => {
    const data = completed(); data.provenance.witness.image.documentId++;
    const result = await render(data); assert.equal(result.text, "integrity-notice");
    assert.equal(result.calls.compute, 0); assert.equal(result.calls.patient, 0);
  });
  it("does not print discarded studies as drafts", async () => {
    const data = fixture(); data.analysis.status = "discarded";
    const result = await render(data); assert.match(result.text, /لا يصدر عنها تقرير سريري/);
    assert.equal(result.calls.compute, 0); assert.equal(result.calls.patient, 0);
    assert.equal(result.nodes.filter(node => node.type === "button").length, 0);
  });
  it("retains the patient authorization gate", async () => assert.rejects(() => render(fixture(), { authorized: false }), /NOT_FOUND/));
  it("retains the authentication gate", async () => assert.rejects(() => render(fixture(), { loggedIn: false }), /NOT_FOUND/));
  for (const id of ["0", "-1", "NaN", "1.5", "9007199254740992"]) {
    it(`rejects invalid study id ${id}`, async () => assert.rejects(() => render(fixture(), { rawId: id }), /NOT_FOUND/));
  }
  it("labels the calendar-year age range when a valid acquisition date exists", async () => {
    const data = fixture(); data.analysis.xrayDate = "2024-04-10";
    const result = await render(data); assert.match(result.text, /13–14 سنة تقريبًا/);
  });
  it("rejects invalid stored coordinates without emitting nonfinite SVG attributes", async () => {
    const data = completed(); data.provenance.witness.snapshot.landmarks[0].x = NaN;
    const result = await render(data); assert.equal(result.nodes.filter(node => node.type === "svg").length, 0);
    assert.doesNotMatch(result.text, /NaN|Infinity/);
  });
});
