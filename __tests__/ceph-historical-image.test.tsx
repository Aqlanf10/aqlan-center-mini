import { cephComparisonProjectionSha256 } from "../lib/ceph-comparison-projection";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CephTracer } from "../components/CephTracer";
import { buildCephCompletionWitness, cephProvenanceHash, cephSourceIdentity, type CephCompletionWitness, type CephProvenanceRead } from "../lib/ceph-completion-provenance";
import { isQuarantinedCephMeasurement } from "../lib/cephPresentation";
import { cephComparisonProvenanceKey } from "../lib/cephCompare";
import { computeAll, isCephLandmarkCode } from "../lib/ceph";
import { cephDocumentImageUrl } from "../lib/ceph-image-source";

const m = vi.hoisted(() => ({ document: vi.fn(), read: vi.fn(), study: vi.fn(), access: vi.fn() }));
vi.mock("../lib/db", () => ({ getDocumentForDownload: m.document, recordAudit: vi.fn(), removeDocument: vi.fn(), getCephAnalysisForCompare: m.study }));
vi.mock("../lib/session", () => ({ requireSession: async () => ({ userId: 1, username: "synthetic", role: "doctor" }) }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: m.access }));
vi.mock("../lib/files", () => ({ readFileByKey: m.read }));
import { GET as imageGet } from "../app/api/documents/[id]/route";
import { GET as overlayGet } from "../app/api/ceph/superimpose/route";

const bytes = Buffer.from("synthetic historical image bytes, never a patient file");
const digest = createHash("sha256").update(bytes).digest("hex");
const witness1 = buildCephCompletionWitness({ analysisId: 71, actor: { userId: 1, username: "synthetic" }, sealedAt: "2026-11-05T00:00:00.000Z",
  snapshot: { patientId: 11, documentId: 51, refSet: "saved", calibration: { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 }, mmPerPixel: .1,
    landmarks: [], diagnosis: null }, image: { documentId: 51, sha256: digest, width: 800, height: 600 }, landmarkReviews: [],
  referenceSet: { key: "saved", name: "Saved synthetic reference", population: null, ageMin: null, ageMax: null, sex: null, version: "v1", active: true, values: [] },
  measurements: [{ code: "SNA", value: 82 }],
});
const witness2: CephCompletionWitness = { ...witness1, schemaVersion: 2, sourceIdentityMeaning: "submitted_source_identity_matches_server_capture",
  sourceReview: { schemaVersion: 1, identity: cephSourceIdentity(witness1.image, witness1.referenceSet) } };
const provenance = (witness: CephCompletionWitness): CephProvenanceRead => ({ state: "versioned", witness, witnessSha256: cephProvenanceHash(witness) });
const props = (p?: CephProvenanceRead): ComponentProps<typeof CephTracer> => ({
  patientName: "Synthetic history only", patientBirthYear: null,
  analysis: { id: 71, patientId: 11, documentId: 51, status: "completed", orthoCaseId: null, phase: "pretreatment", xrayDate: null,
    device: null, refSet: "saved", calibration: witness1.snapshot.calibration, mmPerPixel: .1, note: null,
    createdBy: "synthetic", createdAt: "2026-01-01", completedBy: "synthetic", completedAt: "2026-11-05", findings: null },
  initialLandmarks: [], stamped: [{ code: "SNA", value: 82 }], provenance: p, refValues: null, refSetName: null, diagnosis: null,
  completionSources: { state: "unavailable", reason: "completed_history_has_immutable_source_evidence" },
});
const html = (p?: CephProvenanceRead) => renderToStaticMarkup(createElement(CephTracer, props(p)));
const imageUrl = (markup: string) => markup.match(/data-testid="ceph-image" src="([^"]+)"/)?.[1];
const source = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
const start = source.indexOf("export async function getCephAnalysisForCompare("), end = source.indexOf("// ─── الوصفات", start);
const compiled = transformSync(source.slice(start, end).replace(/^export /gm, ""), { loader: "ts", target: "node22" }).code;
function comparisonReader(query: ReturnType<typeof vi.fn>, saved = { analysis: props().analysis, provenance: provenance(witness2) }) {
  const dependencies = { cephComparisonProjectionSha256, ensureSchema: async () => {}, getPool: () => ({ query }), getCephStudy: async () => saved,
    isQuarantinedCephMeasurement, cephComparisonProvenanceKey, computeAll, isCephLandmarkCode };
  return new Function(...Object.keys(dependencies), compiled + "\nreturn getCephAnalysisForCompare;")(...Object.values(dependencies));
}

beforeEach(() => {
  vi.clearAllMocks(); m.access.mockResolvedValue(true); m.read.mockResolvedValue(bytes);
  m.document.mockResolvedValue({ document: { id: 51, patientId: 11, title: "Synthetic", mimeType: "image/png", removedAt: null }, storageKey: "synthetic.png", sha256: digest });
});

describe("historical ceph images use the exact sealed source", () => {
  it.each([witness1, witness2])("binds completion witness v$schemaVersion instead of the unavailable draft identity", witness => {
    expect(imageUrl(html(provenance(witness)))).toBe(`/api/documents/51?cephSource=${digest}`);
  });
  it.each([undefined, null, "", "not-a-digest", "A".repeat(64)])("does not downgrade a missing or malformed witnessed digest to an ordinary URL %#", sha256 => {
    const p = { ...provenance(witness1), witness: { ...witness1, image: { ...witness1.image, sha256 } } } as CephProvenanceRead;
    const rendered = html(p);
    expect(rendered).not.toContain('data-testid="ceph-image"'); expect(rendered).toContain('role="alert"');
    expect(rendered).not.toContain('/api/documents/');
  });
  it("refuses a missing or differently identified witness image", () => {
    for (const image of [undefined, { ...witness1.image, documentId: 52 }]) {
      const rendered = html({ ...provenance(witness1), witness: { ...witness1, image } } as CephProvenanceRead);
      expect(rendered).not.toContain('/api/documents/'); expect(rendered).toContain('role="alert"');
    }
  });
  it("keeps legacy explicitly unversioned without inventing a source digest", () => {
    const rendered = html({ state: "unversioned", reason: "historical_completion_without_witness" });
    expect(imageUrl(rendered)).toBe('/api/documents/51'); expect(rendered).toContain('سجل اعتماد قديم');
  });
  it("retains the reviewed-source URL for a draft", () => {
    const draft = props(); draft.analysis = { ...draft.analysis, status: "draft" }; draft.stamped = null;
    draft.completionSources = { state: "available", identity: cephSourceIdentity(witness1.image, witness1.referenceSet), referenceSet: witness1.referenceSet };
    expect(imageUrl(renderToStaticMarkup(createElement(CephTracer, draft)))).toBe(`/api/documents/51?cephSource=${digest}`);
  });
  it("actually rejects substituted bytes through the URL selected by the completed component", async () => {
    const url = imageUrl(html(provenance(witness2)))!;
    m.read.mockResolvedValue(Buffer.from("different synthetic image"));
    const response = await imageGet(new Request(`http://localhost${url}`), { params: Promise.resolve({ id: "51" }) });
    expect(response.status).toBe(409); expect(await response.text()).not.toContain("different synthetic image");
  });
  it("still returns matching bytes and rejects a missing file using that same URL", async () => {
    const call = () => imageGet(new Request(`http://localhost${imageUrl(html(provenance(witness2)))}`), { params: Promise.resolve({ id: "51" }) });
    const response = await call(); expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    m.read.mockResolvedValue(null); expect((await call()).status).toBe(410);
  });
});

describe("comparison preserves witnessed image identity", () => {
  it("projects the immutable source SHA without consulting or rewriting file storage", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ status: "completed" }] });
    const result = await comparisonReader(query)(71);
    expect(result).toMatchObject({ documentId: 51, imageSha256: digest, provenanceState: "versioned" });
    expect(cephDocumentImageUrl(result.documentId, { sha256: result.imageSha256 })).toBe(`/api/documents/51?cephSource=${digest}`);
    expect(query.mock.calls.every(([sql]) => /^\s*SELECT/.test(sql))).toBe(true); expect(m.read).not.toHaveBeenCalled();
  });
  it.each([71, "71"])("preserves a real pg-shaped draft ID %s with an INTEGER document ID", async id => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id, patient_id: 11, document_id: 51, status: "draft", created_at: new Date("2026-01-01"), xray_date_text: null, mm_per_pixel: .1, landmarks: [] }] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await comparisonReader(query)(71);
    expect(result).toMatchObject({ id: 71, documentId: 51, imageSha256: null, status: "draft", provenanceState: "not_completed" });
    expect(cephDocumentImageUrl(result.documentId, null)).toBe('/api/documents/51');
  });
  it("does not combine an earlier calibration row with landmarks committed after that row was read", async () => {
    const pointsA = [{ code: "S", x: 20, y: 20 }, { code: "N", x: 80, y: 20 }, { code: "Me", x: 60, y: 100 }];
    const pointsB = pointsA.map(point => ({ ...point, x: point.x * 2, y: point.y * 2 }));
    // A single SQL statement returns A. After it finishes a synthetic atomic
    // writer installs B (scale .2 + doubled points). A second SELECT sees B.
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "71", patient_id: 11, document_id: 51,
      status: "draft", created_at: new Date("2026-01-01"), xray_date_text: null, mm_per_pixel: .1, landmarks: pointsA }] })
      .mockResolvedValueOnce({ rows: pointsB });
    const result = await comparisonReader(query)(71);
    expect(result.mmPerPixel).toBe(.1);
    expect(result.points).toEqual(Object.fromEntries(pointsA.map(({ code, x, y }) => [code, { x, y }])));
    expect(query).toHaveBeenCalledTimes(1);
  });
  it.each(["discarded", "unknown", undefined])("does not project status %s as a draft", async status => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "71", document_id: 51, status, created_at: new Date("2026-01-01") }] }).mockResolvedValue({ rows: [] });
    expect(await comparisonReader(query)(71)).toBeNull(); expect(query).toHaveBeenCalledTimes(1);
  });
  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1, "9007199254740993", "1e2", [71], true])("refuses an unsafe/noncanonical projected analysis ID %#", async id => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id, document_id: 51, status: "draft", created_at: new Date("2026-01-01") }] }).mockResolvedValue({ rows: [] });
    expect(await comparisonReader(query)(71)).toBeNull(); expect(query).toHaveBeenCalledTimes(1);
  });
  it("forwards base identity after chronological reordering", async () => {
    m.study.mockImplementation(async (id: number) => ({ id, patientId: 11, documentId: id + 50, status: "completed", phase: "pretreatment",
      xrayDate: id === 1 ? "2020-01-01" : "2022-01-01", createdAt: "2026-01-01", provenanceState: "versioned", imageSha256: id === 1 ? digest : "b".repeat(64),
      documentWidth: 800, documentHeight: 600, comparisonUnavailableReason: null, mmPerPixel: .1, points: { S: { x: 20, y: 20 }, N: { x: 80, y: 20 }, Me: { x: 60, y: 100 } } }));
    const response = await overlayGet(new Request("http://localhost/api/ceph/superimpose?first=2&second=1"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.before).toMatchObject({ id: 1, documentId: 51, status: "completed", provenanceState: "versioned", imageSha256: digest });
    expect(payload.after).toMatchObject({ id: 2, documentId: 52, status: "completed", provenanceState: "versioned", imageSha256: "b".repeat(64) });
  });
});

describe("image URL boundary", () => {
  it.each([0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "51", undefined])("fails closed for an invalid document ID %#", id => {
    expect(cephDocumentImageUrl(id, { sha256: digest })).toBeNull(); expect(cephDocumentImageUrl(id, null)).toBeNull();
  });
  it("distinguishes explicit ordinary preview from an absent witnessed source", () => {
    expect(cephDocumentImageUrl(51, null)).toBe('/api/documents/51');
    expect(cephDocumentImageUrl(51, undefined)).toBeNull();
    expect(cephDocumentImageUrl(51, { sha256: null })).toBeNull();
  });
});
