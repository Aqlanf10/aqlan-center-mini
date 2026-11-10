import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0,
  effects: [] as { index: number; effect(): void | (() => void) }[], cleanups: new Map<number, () => void>() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value; }];
  },
  useEffect(effect: () => void | (() => void), dependencies: unknown[]) {
    const index = hooks.cursor++, prior = hooks.slots[index] as unknown[] | undefined;
    if (!prior || dependencies.some((value, offset) => value !== prior[offset])) {
      hooks.slots[index] = dependencies; hooks.effects.push({ index, effect });
    }
  },
}));
import OrthoSavedStudyReview from "../components/OrthoSavedStudyReview";
import { legacyCephReasons, longitudinalStageReasons, longitudinalPairs, STUDY_LONGITUDINAL_POLICY, STUDY_LONGITUDINAL_REASONS, type StudyLongitudinalReview, type StudyLongitudinalSource } from "../lib/ortho-study-longitudinal-contract";
import { studyLongitudinalReasonText } from "../lib/ortho-study-longitudinal-labels";
import { readStudyTimepoints } from "../lib/ortho-case-study-timepoints";
import OrthoStudyLongitudinalReview from "../components/OrthoStudyLongitudinalReview";
import { makeStudyOwner } from "../lib/ortho-case-study-owner";
import { makeStudyRecoveryLedger } from "../lib/ortho-case-study-recovery";
import type { StudyEditorRevision } from "../lib/ortho-case-study-editor-contract";
import { CASE_TEMPLATE_VERSION } from "../lib/ortho-case-template";
import { STUDY_TEMPLATE_HASH } from "../lib/ortho-case-study-template";
type Element = ReactElement<Record<string, unknown>>;
const unfold = (node: ReactNode): ReactNode => node && typeof node === "object" && "type" in node && typeof node.type === "function"
  ? unfold((node.type as (props: unknown) => ReactNode)(node.props)) : node;
const elements = (input: ReactNode): Element[] => { const node = unfold(input); return elementTree(node); };
const elementTree = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(elements) : node && typeof node === "object" && "props" in node
  ? [node as Element, ...elements((node as Element).props.children as ReactNode)] : [];
const text = (input: ReactNode): string => { const node = unfold(input); return nodeText(node); };
const nodeText = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node
  ? text((node as Element).props.children as ReactNode) : typeof node === "string" || typeof node === "number" ? String(node) : "";
const scope = { patientId: 19, orthoCaseId: 41, clinicalCaseId: 51 };
function fixture() {
  const denied = vi.fn();
  const owner = makeStudyOwner({ ...scope, actorId: 7, recovery: makeStudyRecoveryLedger(), authorized: () => true, writable: () => false, deny: denied });
  owner.activate();
  const revision: StudyEditorRevision = { ...scope, id: 91, version: 1, kind: "draft", contentHash: "a".repeat(64), actorId: 7,
    predecessorId: null, documentedFromId: null, baseDocumentedId: null, createdAt: "2026-10-01T00:00:00.000Z", capturedAt: "2026-10-01T00:00:00.000Z", caseStatusAtCapture: "active", reason: "Synthetic saved study", authoredHash: "b".repeat(64),
    authored: { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH }, identityDisclosure: "case_only",
      sources: [{ key: "ceph1", kind: "ceph_study", id: 61, version: null, contentHash: "c".repeat(64) }, { key: "ceph2", kind: "ceph_study", id: 62, version: null, contentHash: "d".repeat(64) }],
      groups: [{ id: "timepoint_T1", label: "T1 historical", phase: "T1", sourceKeys: ["ceph1"], occurrence: { occurredOn: "2020-02-29", dateProvenance: "historical_source", sourceNote: "Synthetic historical card" } },
        { id: "timepoint_T2", label: "T2 undated", phase: "T2", sourceKeys: ["ceph2"], occurrence: { occurredOn: null, dateProvenance: "unknown", sourceNote: "Original uncertainty note" } }], panels: [], mediaUses: [], comment: "" } };
  const props = { owner, revision, readVersion: 0, locale: "en" as "ar" | "en" };
  const render = () => {
    hooks.cursor = 0;
    const tree = OrthoStudyLongitudinalReview(props);
    for (const { index, effect } of hooks.effects.splice(0)) {
      hooks.cleanups.get(index)?.(); hooks.cleanups.delete(index);
      const cleanup = effect(); if (cleanup) hooks.cleanups.set(index, cleanup);
    }
    return tree;
  };
  return { owner, denied, revision, props, render };
}
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const cleanup = () => { for (const effect of hooks.cleanups.values()) effect(); hooks.cleanups.clear(); };
beforeEach(() => { hooks.slots = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanups.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("saved-study longitudinal authorization lifecycle", () => {
  it.each([401, 403])("revokes the current owner on HTTP %s without reading private denial bytes", async status => {
    const f = fixture(), response = new Response("Untrusted clinical detail", { status });
    const read = vi.spyOn(response, "text"); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    f.render(); await vi.waitFor(() => expect(f.denied).toHaveBeenCalledOnce());
    expect(f.owner.active()).toBe(false); expect(read).not.toHaveBeenCalled();
    expect(text(f.render())).not.toContain("Untrusted clinical detail");
  });
  it.each(["retire", "invalidateRead"] as const)("ignores a late denial after owner %s", async action => {
    const f = fixture(); let complete!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>(resolve => { complete = resolve; })));
    f.render(); f.owner[action](); complete(new Response(null, { status: 403 })); await flush();
    expect(f.denied).not.toHaveBeenCalled();
  });
  it("aborts on departure and ignores a response even when transport ignores abort", async () => {
    const f = fixture(); let complete!: (response: Response) => void;
    const fetcher = vi.fn().mockReturnValue(new Promise<Response>(resolve => { complete = resolve; })); vi.stubGlobal("fetch", fetcher);
    f.render(); const request = fetcher.mock.calls[0][1] as RequestInit;
    expect(request.signal?.aborted).toBe(false); cleanup(); expect(request.signal?.aborted).toBe(true);
    complete(new Response(null, { status: 403 })); await flush(); expect(f.denied).not.toHaveBeenCalled();
  });
  it("does not initiate a request for a retired or incorrectly scoped owner", () => {
    const f = fixture(); f.owner.retire(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    f.render(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not initiate a request after the saved revision changes its patient binding", () => {
    const f = fixture(); f.props.revision = { ...f.revision, patientId: 20 }; const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    f.render(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["no-store", "private", "private, x-no-store", "public, no-store", "public, private, no-store"])("rejects non-private or cacheable policy %s without reading the body", async cacheControl => {
    const f = fixture(), response = new Response("Untrusted clinical detail", { headers: { "Cache-Control": cacheControl } });
    const read = vi.spyOn(response, "text"); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response)); f.render();
    await vi.waitFor(() => expect(elements(f.render()).some(node => node.props.role === "alert")).toBe(true));
    expect(read).not.toHaveBeenCalled(); expect(f.denied).not.toHaveBeenCalled(); expect(text(f.render())).not.toContain("Untrusted clinical detail");
  });
});

function response(f: ReturnType<typeof fixture>): StudyLongitudinalReview {
  const stages = readStudyTimepoints(f.props.revision.authored).map(point => {
    const sources = point.sources.filter(source => source.kind === "ceph_study").map((selection): StudyLongitudinalSource => {
      const source: StudyLongitudinalSource = { key: selection.key, id: selection.id, contentHash: selection.contentHash, captureState: "available",
        status: "completed", acquisitionDate: "2020-02-28", referenceSetKey: "Synthetic reference set", image: { documentId: 101, contentHash: "e".repeat(64), state: "available" },
        witness: "legacy_unversioned", completion: null, reasons: [] };
      source.reasons = legacyCephReasons(source); return source;
    });
    return { stage: point.stage, groupId: point.groupId, label: point.label, occurrence: point.occurrence, sources, state: "unavailable" as const, reasons: longitudinalStageReasons(sources) };
  });
  return { ok: true, patientId: f.props.revision.patientId, orthoCaseId: f.props.revision.orthoCaseId, clinicalCaseId: f.props.revision.clinicalCaseId,
    revisionId: f.props.revision.id, revisionHash: f.props.revision.contentHash, kind: f.props.revision.kind, capturedAt: "2026-10-01T00:00:00.000Z",
    policyVersion: STUDY_LONGITUDINAL_POLICY, stages, pairs: longitudinalPairs(stages) };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Cache-Control": "private, no-store" } });

describe("saved-study longitudinal provenance display", () => {
  it("requests only the selected revision with same-origin credentials, no cache, and cancellation", async () => {
    const f = fixture(), fetcher = vi.fn().mockResolvedValue(json(response(f))); vi.stubGlobal("fetch", fetcher); f.render();
    await vi.waitFor(() => expect(text(f.render())).toContain("Synthetic historical card"));
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ortho/41/case-study/longitudinal?patientId=19&revisionId=91");
    expect(options).toMatchObject({ cache: "no-store", credentials: "same-origin" }); expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.method).toBeUndefined(); expect(options.body).toBeUndefined();
  });
  it.each(["en", "ar"] as const)("shows exact source provenance in %s while withholding deltas and inference", async locale => {
    const f = fixture(); f.props.locale = locale; vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(response(f)))); f.render();
    await vi.waitFor(() => expect(text(f.render())).toContain("Synthetic historical card"));
    const tree = f.render(), content = text(tree);
    for (const original of ["T1 historical", "T2 undated", "2020-02-29", "2020-02-28", "Original uncertainty note", "ceph1", "c".repeat(64), "Synthetic reference set", "e".repeat(64)]) expect(content).toContain(original);
    expect(content).toContain(locale === "en" ? "Missing evidence is not zero change" : "نقص الدليل لا يعني فرقًا يساوي صفرًا");
    expect(content).toContain(locale === "en" ? "not its version" : "وليس نسختها");
    expect(content).toContain(locale === "en" ? "Numeric difference unavailable" : "الفرق الرقمي غير متاح");
    for (const reason of response(f).stages[0].reasons) expect(content).toContain(studyLongitudinalReasonText(reason, locale));
    const t2 = elements(tree).find(node => node.type === "article" && String(node.props["aria-label"]).startsWith("T2"))!;
    expect(text(t2)).toContain(locale === "en" ? "Unknown / not recorded" : "غير معروف / غير مسجل");
    const t3 = elements(tree).find(node => node.type === "article" && String(node.props["aria-label"]).startsWith("T3"))!;
    expect(text(t3)).toContain(locale === "en" ? "Not assigned in this saved revision" : "غير مرتبطة في هذه النسخة المحفوظة");
    expect(elements(t3).some(node => node.type === "time")).toBe(false);
    expect(elements(tree).some(node => ["form", "input", "select", "button"].includes(String(node.type)))).toBe(false);
  });
  it("distinguishes an unassigned stage, an explicitly empty stage, and an unavailable captured source", async () => {
    const f = fixture(); f.props.revision = { ...f.revision, authored: { ...f.revision.authored, groups: [...f.revision.authored.groups,
      { id: "timepoint_T3", label: "Explicit empty T3", phase: "T3", sourceKeys: [], occurrence: { occurredOn: null, dateProvenance: "unknown", sourceNote: "" } }] } };
    const payload = response(f), source = payload.stages[0].sources[0];
    Object.assign(source, { captureState: "unavailable", status: null, acquisitionDate: null, referenceSetKey: null, image: null, witness: "unavailable", reasons: ["source_unavailable"] });
    payload.stages[0].reasons = longitudinalStageReasons(payload.stages[0].sources); payload.pairs = longitudinalPairs(payload.stages);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(payload))); f.render();
    await vi.waitFor(() => expect(text(f.render())).toContain("Explicit empty T3"));
    const tree = f.render(); expect(text(tree)).toContain(studyLongitudinalReasonText("source_unavailable", "en"));
    expect(text(tree)).toContain(studyLongitudinalReasonText("no_ceph_source", "en"));
    const t4 = elements(tree).find(node => node.type === "article" && String(node.props["aria-label"]).startsWith("T4"))!;
    expect(text(t4)).toContain("Not assigned in this saved revision");
  });
  it("does not infer stages for a revision without saved assignments", async () => {
    const f = fixture(); f.props.revision = { ...f.revision, authored: { ...f.revision.authored, groups: [] } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(response(f)))); f.render();
    await vi.waitFor(() => expect(text(f.render())).toContain("No T1–T4 stages were explicitly assigned"));
    expect(elements(f.render()).filter(node => node.type === "article")).toHaveLength(4);
    expect(text(f.render())).not.toContain("Synthetic historical card");
  });
  it("exposes all ten reason explanations in both languages", () => {
    for (const reason of STUDY_LONGITUDINAL_REASONS) {
      expect(studyLongitudinalReasonText(reason, "en")).not.toBe(reason);
      expect(studyLongitudinalReasonText(reason, "ar")).toMatch(/[\u0600-\u06ff]/);
    }
  });
  it("mounts the eligibility view under saved-study review with the exact owner and revision", () => {
    const f = fixture(); hooks.cursor = 0;
    const tree = OrthoSavedStudyReview(f.props);
    // Inspect the direct child before expanding nested client components.
    const direct = (tree.props.children as ReactNode[]).find(node => node && typeof node === "object" && "type" in node && node.type === OrthoStudyLongitudinalReview) as Element;
    expect(direct.props.owner).toBe(f.owner); expect(direct.props.revision).toBe(f.revision); expect(direct.props.readVersion).toBe(0);
  });
});

describe("saved-study response binding and stale replies", () => {
  it.each(["patientId", "orthoCaseId", "clinicalCaseId", "revisionId", "revisionHash", "kind", "numeric_delta", "source_hash", "stage_date", "extra_measurements"])("does not display a %s mismatch or clinical injection", async mutation => {
    const f = fixture(), payload = response(f);
    if (["patientId", "orthoCaseId", "clinicalCaseId", "revisionId"].includes(mutation)) Object.assign(payload, { [mutation]: 999 });
    if (mutation === "revisionHash") payload.revisionHash = "f".repeat(64);
    if (mutation === "kind") payload.kind = "documented";
    if (mutation === "numeric_delta") Object.assign(payload.pairs[0], { delta: 0 });
    if (mutation === "source_hash") payload.stages[0].sources[0].contentHash = "f".repeat(64);
    if (mutation === "stage_date") payload.stages[0].occurrence = { ...payload.stages[0].occurrence, occurredOn: "2025-01-01" };
    if (mutation === "extra_measurements") Object.assign(payload, { measurements: { angle: 90 } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(payload))); f.render();
    await vi.waitFor(() => expect(elements(f.render()).some(node => node.props.role === "alert")).toBe(true));
    expect(text(f.render())).not.toContain("Synthetic historical card"); expect(text(f.render())).not.toContain("ceph1");
  });
  it("hides a ready view immediately when the revision changes and ignores old replies", async () => {
    const f = fixture(); let resolveOld!: (response: Response) => void;
    const fetcher = vi.fn().mockReturnValueOnce(new Promise<Response>(resolve => { resolveOld = resolve; })); vi.stubGlobal("fetch", fetcher);
    f.render(); const oldSignal = (fetcher.mock.calls[0][1] as RequestInit).signal;
    const next = { ...f.revision, id: 92, contentHash: "f".repeat(64) }; f.props.revision = next;
    const newPayload = response(f); fetcher.mockResolvedValueOnce(json(newPayload)); f.render();
    expect(oldSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(text(f.render())).toContain("Synthetic historical card"));
    resolveOld(new Response(null, { status: 403 })); await flush(); expect(f.denied).not.toHaveBeenCalled();
    expect(text(f.render())).toContain("Synthetic historical card");
    let resolveNew!: (response: Response) => void;
    fetcher.mockReturnValueOnce(new Promise<Response>(resolve => { resolveNew = resolve; }));
    f.props.revision = { ...next, id: 93 }; expect(text(f.render())).not.toContain("Synthetic historical card");
    resolveNew(new Response(null, { status: 503 })); await flush();
    expect(elements(f.render()).some(node => node.props.role === "alert")).toBe(true);
  });
  it("does not display a body that finishes after authorization is revoked", async () => {
    const f = fixture(), pending = json(response(f)); let complete!: (value: string) => void;
    vi.spyOn(pending, "text").mockReturnValue(new Promise(resolve => { complete = resolve; }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(pending)); f.render(); await flush(); f.owner.denied();
    complete(JSON.stringify(response(f))); await flush(); expect(text(f.render())).not.toContain("Synthetic historical card");
  });
  it("rejects oversized payloads instead of truncating or partially displaying them", async () => {
    const f = fixture(), pending = json(response(f)); vi.spyOn(pending, "text").mockResolvedValue(" ".repeat(4 * 1024 * 1024 + 1));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(pending)); f.render();
    await vi.waitFor(() => expect(elements(f.render()).some(node => node.props.role === "alert")).toBe(true));
  });
});
