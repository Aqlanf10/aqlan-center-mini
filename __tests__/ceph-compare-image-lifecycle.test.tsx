import { cephComparisonProjectionSha256 } from "../lib/ceph-comparison-projection";
import type { CephAnalysisForCompare } from "../lib/db";
import { createElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CephCompareView } from "../components/CephCompareView";

// Real component render/event functions with a small synthetic hook scheduler.
// Component keys and effect cleanup are modeled; this is not browser/DOM QA.
type Scope = { values: unknown[]; cursor: number; mounted: boolean; type: unknown;
  memos: Map<number, { deps?: readonly unknown[]; value: unknown }>;
  effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void }> };
const h = vi.hoisted(() => ({ active: null as Scope | null, changed: false,
  scopes: new Map<string, Scope>(), pending: [] as Array<() => void> }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const slot = (initial: unknown) => {
    const scope = h.active!; const index = scope.cursor++;
    if (!(index in scope.values)) scope.values[index] = typeof initial === "function" ? initial() : initial;
    return { scope, index };
  };
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const { scope, index } = slot(undefined), old = scope.memos.get(index);
    if (old && same(old.deps, deps)) return old.value;
    const value = factory(); scope.memos.set(index, { deps, value }); return value;
  };
  return { ...react,
    useState: (initial: unknown) => {
      const { scope, index } = slot(initial);
      return [scope.values[index], (update: unknown) => {
        if (!scope.mounted) return;
        const value = typeof update === "function" ? update(scope.values[index]) : update;
        if (!Object.is(value, scope.values[index])) h.changed = true;
        scope.values[index] = value;
      }];
    },
    useRef: (initial: unknown) => { const { scope, index } = slot({ current: initial }); return scope.values[index]; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => {
      const { scope, index } = slot(undefined), old = scope.effects.get(index);
      if (old && same(old.deps, deps)) return;
      h.pending.push(() => {
        if (!scope.mounted) return; old?.cleanup?.(); const cleanup = run();
        scope.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
});
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
let props = { first: 1, second: 2, patientName: "Synthetic A" };
function unmount(scope: Scope) { scope.mounted = false; scope.effects.forEach(effect => effect.cleanup?.()); }
function render(): ReactNode {
  for (let round = 0; round < 20; round++) {
    h.changed = false; h.pending = []; const visited = new Set<string>();
    const walk = (node: ReactNode, path: string): ReactNode => {
      if (Array.isArray(node)) return node.map((child, index) => walk(child, `${path}/${index}`));
      if (!node || typeof node !== "object" || !("props" in node)) return node;
      const element = node as Element;
      if (typeof element.type === "function") {
        const id = `${path}:${element.key ?? "unkeyed"}`; visited.add(id);
        let scope = h.scopes.get(id);
        if (scope && scope.type !== element.type) { unmount(scope); scope = undefined; }
        if (!scope) { scope = { values: [], cursor: 0, mounted: true, type: element.type, memos: new Map(), effects: new Map() }; h.scopes.set(id, scope); }
        scope.cursor = 0; h.active = scope;
        return walk((element.type as (p: Record<string, unknown>) => ReactNode)(element.props), `${id}/output`);
      }
      return { ...element, props: { ...element.props, children: walk(element.props.children as ReactNode, `${path}/children`) } };
    };
    const result = walk(createElement(CephCompareView, props), "root");
    for (const [id, scope] of h.scopes) if (!visited.has(id)) { unmount(scope); h.scopes.delete(id); }
    h.pending.splice(0).forEach(run => run()); h.active = null;
    if (!h.changed) return result;
  }
  throw Error("Synthetic component scheduler did not settle");
}
const fetchMock = vi.fn();
const digest = "a".repeat(64);
const item = (id: number) => ({ id, documentId: id + 50, phase: "pretreatment", xrayDate: `2026-01-${String(id).padStart(2, "0")}`, createdAt: "2026-01-01",
  status: "completed", provenanceState: "versioned", imageSha256: digest as string | null, projectionSha256: digest, measurements: [] });
const ordering = (first: number, second: number) => ({ mode: "acquisition_date", chronology: "known", referenceId: first, comparisonId: second });
const comparison = (first = 1, second = 2) => ({ ordering: ordering(first, second), before: item(first), after: item(second), comparison: { interpretation: { mode: "descriptive_only", reason: "reference_suitability_not_established" }, measurements: [], onlyBefore: [], onlyAfter: [], improved: 0, worsened: 0, steady: 0 }, summary: { ar: `Synthetic pair ${first}:${second}`, en: "Synthetic" } });
const overlay = (first = 1, second = 2) => ({ ordering: ordering(first, second), before: { ...item(first), documentWidth: 800, documentHeight: 600,
  lines: [{ from: { x: first, y: 20 }, to: { x: 80, y: 20 }, label: "SN" }] },
  after: { ...item(second), lines: [{ from: { x: second, y: 20 }, to: { x: 90, y: 20 }, label: "SN" }] },
  rotationDegrees: 0, cranialBaseBefore: 6, cranialBaseAfter: 7 });
const ok = (payload: unknown) => ({ ok: true, json: async () => payload });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const respond = () => fetchMock.mockImplementation(async (url: string) => {
  const parsed = new URL(url, "http://localhost"), first = Number(parsed.searchParams.get("first")), second = Number(parsed.searchParams.get("second"));
  return ok(url.includes("/superimpose") ? overlay(first, second) : comparison(first, second));
});
async function flush() { for (let n = 0; n < 20; n++) { await Promise.resolve(); render(); } return render(); }
const image = () => nodes(render()).find(node => node.type === "img");
const svgs = () => nodes(render()).filter(node => node.type === "svg");
const event = (width = 800, height = 600) => ({ currentTarget: { naturalWidth: width, naturalHeight: height, complete: true } });
const load = (img = image()!) => { (img.props.onLoad as (e: unknown) => void)(event()); render(); };
const fail = (img = image()!) => { const handler = img.props.onError; expect(handler).toBeTypeOf("function"); (handler as () => void)(); render(); };
beforeEach(() => { h.scopes.clear(); h.pending = []; h.active = null; h.changed = false; props = { first: 1, second: 2, patientName: "Synthetic A" }; fetchMock.mockReset(); respond(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { h.scopes.forEach(unmount); h.scopes.clear(); vi.unstubAllGlobals(); });

describe("comparison raster identity and availability", () => {
  it("loads the saved base digest and never draws from metadata dimensions before an actual load", async () => {
    render(); await flush(); expect(image()?.props.src).toBe(`/api/documents/51?cephSource=${digest}`); expect(svgs()).toHaveLength(0);
    load(); expect(svgs()).toHaveLength(1);
  });
  it("makes a loaded image failure visible and removes raster-dependent overlays", async () => {
    render(); await flush(); load(); expect(svgs()).toHaveLength(1); fail();
    expect(svgs()).toHaveLength(0); expect(nodes(render()).some(node => node.props.role === "alert")).toBe(true);
  });
  it("rejects zero natural dimensions", async () => {
    render(); await flush(); (image()!.props.onLoad as (e: unknown) => void)(event(0, 0)); render();
    expect(svgs()).toHaveLength(0); expect(nodes(render()).some(node => node.props.role === "alert")).toBe(true);
  });
  it("accepts an already loaded cached image through its attached ref", async () => {
    render(); await flush(); (image()!.props.ref as (value: unknown) => void)(event().currentTarget); render();
    expect(svgs()).toHaveLength(1);
  });
  it("does not revive an image after its failed load", async () => {
    render(); await flush(); const failedImage = image()!; fail(failedImage); load(failedImage);
    expect(svgs()).toHaveLength(0); expect(nodes(render()).some(node => node.props.role === "alert")).toBe(true);
  });
  it.each([undefined, null, "bad", "A".repeat(64)])("does not render an unbound completed image with invalid digest %#", async imageSha256 => {
    fetchMock.mockImplementation(async (url: string) => ok(url.includes("/superimpose") ? { ...overlay(), before: { ...overlay().before, imageSha256 } } : comparison()));
    render(); await flush(); expect(image()).toBeUndefined(); expect(svgs()).toHaveLength(0);
    expect(nodes(render()).some(node => node.props.role === "alert")).toBe(true);
  });
  it.each(["unversioned", "integrity_unavailable", "unknown", undefined])("does not relabel provenance %s as a draft", async provenanceState => {
    fetchMock.mockImplementation(async (url: string) => ok(url.includes("/superimpose") ? { ...overlay(), before: { ...overlay().before, provenanceState } } : comparison()));
    render(); await flush(); expect(image()).toBeUndefined(); expect(svgs()).toHaveLength(0);
  });
  it("keeps an explicitly identified draft image ordinary", async () => {
    const draft = { status: "draft", provenanceState: "not_completed", imageSha256: null };
    const compared = { ...comparison(), before: { ...comparison().before, ...draft }, after: { ...comparison().after, ...draft } };
    const placed = { ...overlay(), before: { ...overlay().before, ...draft }, after: { ...overlay().after, ...draft } };
    fetchMock.mockImplementation(async (url: string) => ok(url.includes("/superimpose") ? placed : compared));
    render(); await flush(); expect(image()?.props.src).toBe('/api/documents/51'); expect(svgs()).toHaveLength(0);
    load(); expect(svgs()).toHaveLength(1);
  });
  it.each(["discarded", "unknown", undefined])("does not give status %s an ordinary draft image", async status => {
    fetchMock.mockImplementation(async (url: string) => ok(url.includes("/superimpose") ? { ...overlay(), before: { ...overlay().before, status, provenanceState: "not_completed", imageSha256: null } } : comparison()));
    render(); await flush(); expect(image()).toBeUndefined(); expect(svgs()).toHaveLength(0);
  });
  it.each(["order", "document", "analysis"])("rejects an overlay whose %s changed after the numeric response", async changed => {
    const placed = changed === "order" ? overlay(2, 1) : overlay();
    if (changed === "document") placed.before.documentId = 999;
    if (changed === "analysis") placed.after.id = 999;
    fetchMock.mockImplementation(async (url: string) => ok(url.includes("/superimpose") ? placed : comparison()));
    render(); await flush(); expect(image()).toBeUndefined(); expect(svgs()).toHaveLength(0); expect(text(render())).toContain("تغيّر ترتيب التحليلين");
  });
  it.each((['before', 'after'] as const).flatMap(side => ['landmarks', 'scale', 'reference result'].map(change => ({ side, change }))))(
    "withholds same-ID draft geometry after a $side $change changes the projected source", async ({ side, change }) => {
      const draft = { status: "draft", provenanceState: "not_completed", imageSha256: null };
      const compared = comparison(), placed = overlay();
      for (const target of ["before", "after"] as const) {
        Object.assign(compared[target], draft); Object.assign(placed[target], draft);
      }
      const source: Omit<CephAnalysisForCompare, "projectionSha256"> = { ...compared[side], ...draft,
        status: "draft", provenanceState: "not_completed", patientId: 11,
        mmPerPixel: .1, points: { S: { x: 20, y: 20 }, N: { x: 80, y: 20 }, Me: { x: 60, y: 100 } },
        measurements: [{ code: "SNA", name: "SNA", value: 82, mean: 82, unit: "°" }],
        documentWidth: 800, documentHeight: 600, comparisonUnavailableReason: null, provenanceNotice: null };
      compared[side].projectionSha256 = cephComparisonProjectionSha256(source);
      if (change === "landmarks") source.points.N!.x = 180;
      if (change === "scale") source.mmPerPixel = .2;
      if (change === "reference result") source.measurements[0].mean = 90;
      placed[side].projectionSha256 = cephComparisonProjectionSha256(source);
      placed[side].lines[0].to.x = 180;
      fetchMock.mockImplementation(async (url: string) => ok(url.includes("/superimpose") ? placed : compared));
      render(); await flush();
      expect(image()).toBeUndefined(); expect(svgs()).toHaveLength(0);
      expect(nodes(render()).some(node => node.props.role === "alert")).toBe(true);
      expect(text(render())).toContain("#1");
    });
  it.each((["before", "after"] as const).flatMap(side => [undefined, null, "", "bad", "a".repeat(63), "A".repeat(64), 123].map(token => ({ side, token })) ))(
    "rejects equally missing or malformed projection tokens on $side: $token", async ({ side, token }) => {
      const compared = comparison(), placed = overlay();
      Reflect.set(compared[side], "projectionSha256", token); Reflect.set(placed[side], "projectionSha256", token);
      fetchMock.mockImplementation(async (url: string) => ok(url.includes("/superimpose") ? placed : compared));
      render(); await flush(); expect(image()).toBeUndefined(); expect(svgs()).toHaveLength(0);
      expect(nodes(render()).some(node => node.props.role === "alert")).toBe(true);
    });
  it("accepts reversed requested IDs when both responses agree on their ordered projections", async () => {
    props = { ...props, first: 2, second: 1 };
    fetchMock.mockImplementation(async (url: string) => ok(url.includes("/superimpose") ? overlay() : comparison()));
    render(); await flush(); expect(image()).toBeDefined(); load(); expect(svgs()).toHaveLength(1);
  });
  it("rejects a comparison response for a different requested pair", async () => {
    fetchMock.mockResolvedValue(ok(comparison(3, 4))); render(); await flush();
    expect(image()).toBeUndefined(); expect(text(render())).not.toContain("#3");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(["before", "after"] as const)("rejects a draft-to-completed transition on the %s side between responses", async side => {
    const compared = comparison(); compared[side] = { ...compared[side], status: "draft", provenanceState: "not_completed", imageSha256: null };
    fetchMock.mockImplementation(async (url: string) => ok(url.includes("/superimpose") ? overlay() : compared));
    render(); await flush(); expect(image()).toBeUndefined(); expect(svgs()).toHaveLength(0);
    expect(nodes(render()).some(node => node.props.role === "alert")).toBe(true);
  });
  it.each((["before", "after"] as const).flatMap(side => (["status", "provenanceState", "imageSha256"] as const).map(field => ({ side, field }))))("rejects a $side $field change between responses", async ({ side, field }) => {
      const placed = overlay(); placed[side][field] = field === "imageSha256" ? "b".repeat(64) : field === "status" ? "draft" : "unversioned";
      fetchMock.mockImplementation(async (url: string) => ok(url.includes("/superimpose") ? placed : comparison()));
      render(); await flush(); expect(image()).toBeUndefined(); expect(svgs()).toHaveLength(0);
      expect(nodes(render()).some(node => node.props.role === "alert")).toBe(true);
    });
  it.each((["before", "after"] as const).flatMap(side => (["missing", "null", "bad"] as const).map(invalid => ({ side, invalid }))))("rejects equally $invalid witnessed metadata on the $side side in both responses", async ({ side, invalid }) => {
    const compared = comparison(), placed = overlay();
    if (invalid === "missing") { Reflect.deleteProperty(compared[side], "imageSha256"); Reflect.deleteProperty(placed[side], "imageSha256"); }
    else { compared[side].imageSha256 = invalid === "null" ? null : "bad"; placed[side].imageSha256 = compared[side].imageSha256; }
    fetchMock.mockImplementation(async (url: string) => ok(url.includes("/superimpose") ? placed : compared));
    render(); await flush(); expect(image()).toBeUndefined(); expect(svgs()).toHaveLength(0);
  });
});

describe("comparison pair and image session lifetimes", () => {
  it("clears old labels, raster and dimensions immediately while the next pair is delayed", async () => {
    render(); await flush(); load(); const previousImage = image()!;
    const pending = deferred<ReturnType<typeof ok>>(); fetchMock.mockReturnValue(pending.promise);
    props = { first: 3, second: 4, patientName: "Synthetic B" }; const during = render();
    expect(text(during)).not.toContain("#1"); expect(image()).toBeUndefined(); expect(svgs()).toHaveLength(0);
    respond(); pending.resolve(ok(comparison(3, 4))); await flush();
    expect(image()?.props.src).toBe(`/api/documents/53?cephSource=${digest}`); expect(svgs()).toHaveLength(0);
    load(previousImage); expect(svgs()).toHaveLength(0);
    load(); expect(svgs()).toHaveLength(1);
    fail(previousImage); expect(svgs()).toHaveLength(1);
  });
  it("ignores the prior pair's delayed fetch completion after the current pair succeeds", async () => {
    const pending = deferred<ReturnType<typeof ok>>(); fetchMock.mockReturnValueOnce(pending.promise); render();
    props = { first: 3, second: 4, patientName: "Synthetic B" }; render(); await flush(); load();
    pending.resolve(ok(comparison(1, 2))); await flush();
    expect(text(render())).toContain("#3"); expect(text(render())).not.toContain("#1");
    expect(image()?.props.src).toBe(`/api/documents/53?cephSource=${digest}`); expect(svgs()).toHaveLength(1);
  });
  it("ignores a superseded overlay response and starts fresh on A to B to A navigation", async () => {
    const oldOverlay = deferred<ReturnType<typeof ok>>(); fetchMock.mockResolvedValueOnce(ok(comparison())).mockReturnValueOnce(oldOverlay.promise);
    render(); await flush(); expect(image()).toBeUndefined();
    props = { first: 3, second: 4, patientName: "Synthetic B" }; render(); await flush(); load();
    oldOverlay.resolve(ok(overlay())); await flush(); expect(image()?.props.src).toBe(`/api/documents/53?cephSource=${digest}`);
    const newComparison = deferred<ReturnType<typeof ok>>(); fetchMock.mockReturnValueOnce(newComparison.promise);
    props = { first: 1, second: 2, patientName: "Synthetic A again" }; render(); expect(image()).toBeUndefined(); expect(svgs()).toHaveLength(0);
    newComparison.resolve(ok(comparison())); await flush(); expect(image()?.props.src).toBe(`/api/documents/51?cephSource=${digest}`); expect(svgs()).toHaveLength(0);
  });
  it("ignores the first A overlay after A to B to A has loaded a newer projection of the same IDs", async () => {
    const oldOverlay = deferred<ReturnType<typeof ok>>();
    fetchMock.mockResolvedValueOnce(ok(comparison())).mockReturnValueOnce(oldOverlay.promise);
    render(); await flush();
    props = { first: 3, second: 4, patientName: "Synthetic B" }; render(); await flush(); load();
    const latestComparison = comparison(), latestOverlay = overlay();
    latestComparison.after.projectionSha256 = "b".repeat(64); latestOverlay.after.projectionSha256 = "b".repeat(64);
    latestOverlay.after.lines[0].to.x = 190;
    fetchMock.mockImplementation(async (url: string) => ok(url.includes("/superimpose") ? latestOverlay : latestComparison));
    props = { first: 1, second: 2, patientName: "Synthetic A again" }; render(); await flush(); load();
    const afterLine = () => nodes(render()).filter(node => node.type === "line").at(-1)?.props.x2;
    expect(afterLine()).toBe(190);
    oldOverlay.resolve(ok(overlay())); await flush(); expect(afterLine()).toBe(190); expect(svgs()).toHaveLength(1);
  });
  it.each(["comparison", "overlay", "image"])("recovers a new pair after a prior %s failure without retaining the error", async kind => {
    if (kind !== "image") fetchMock.mockImplementation(async (url: string) => (url.includes("/superimpose") ? kind === "overlay" : kind === "comparison")
      ? { ok: false, json: async () => ({ message: "Synthetic prior failure" }) } : ok(url.includes("/superimpose") ? overlay() : comparison()));
    render(); await flush(); if (kind === "image") { load(); fail(); }
    respond(); props = { first: 3, second: 4, patientName: "Synthetic B" }; render(); await flush();
    expect(text(render())).not.toContain("Synthetic prior failure"); expect(image()?.props.src).toBe(`/api/documents/53?cephSource=${digest}`);
    expect(svgs()).toHaveLength(0); load(); expect(svgs()).toHaveLength(1);
  });
});

const unresolved = (first = 1, second = 2) => ({ ok: false, status: 409, json: async () => ({ code: "CEPH_ORDER_REQUIRED", reason: "missing_date", choices: [{ id: first, xrayDate: null }, { id: second, xrayDate: null }] }) });
function explicitPair(reference = 1, other = 2) {
  const before = { ...item(reference), xrayDate: null }, after = { ...item(other), xrayDate: null };
  const order = { mode: "explicit_reference", chronology: "unknown", referenceId: reference, comparisonId: other };
  const left = reference === 1 ? 90 : 84, right = other === 1 ? 90 : 84;
  return {
    compared: { ...comparison(reference, other), before, after, ordering: order,
      comparison: { interpretation: { mode: "descriptive_only", reason: "reference_suitability_not_established" }, measurements: [{ key: "SNA", name: "SNA", unit: "°", before: left, after: right, delta: right - left,
        gapBefore: null, gapAfter: null, direction: "ungraded" }], onlyBefore: ["BEFORE_ONLY"], onlyAfter: ["AFTER_ONLY"], improved: 0, worsened: 0, steady: 0 } },
    placed: { ...overlay(reference, other), before: { ...overlay(reference, other).before, ...before }, after: { ...overlay(reference, other).after, ...after }, ordering: order },
  };
}
function respondExplicit() {
  fetchMock.mockImplementation(async (url: string) => {
    const parsed = new URL(url, "http://localhost"), ref = parsed.searchParams.get("reference");
    if (ref === null) return unresolved(Number(parsed.searchParams.get("first")), Number(parsed.searchParams.get("second")));
    const reference = Number(ref), pair = explicitPair(reference, reference === 1 ? 2 : 1);
    return ok(url.includes("/superimpose") ? pair.placed : pair.compared);
  });
}
const click = (label: string) => {
  const button = nodes(render()).find(node => node.type === "button" && text(node).includes(label));
  expect(button, label).toBeDefined(); (button!.props.onClick as () => void)(); render();
};

describe("deliberate comparison reference and ordering admission", () => {
  it.each([1, 2])("withholds all directions until a deliberate reference %i click, then preserves it in print", async reference => {
    respondExplicit(); render(); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(image()).toBeUndefined(); expect(nodes(render()).filter(node => node.type === "table" || node.type === "a")).toHaveLength(0);
    expect(text(render())).toContain("الترتيب الزمني غير محسوم");
    click(`اختيار #${reference}`); await flush();
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain(`/api/ceph/compare?first=1&second=2&reference=${reference}`);
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain(`/api/ceph/superimpose?first=1&second=2&reference=${reference}`);
    const output = text(render()); expect(output).toContain("تحليل المقارنة ناقص المرجع"); expect(output).toContain(reference === 1 ? "-6.0" : "+6.0");
    for (const claim of ["قبل العلاج", "بعد العلاج", "في القديم فقط", "في الجديد فقط", "فرق النموّ", "اقترب من المعيار", "ابتعد عن المعيار", "التصوير الأسبق", "التصوير اللاحق"]) expect(output).not.toContain(claim);
    expect(image()?.props.alt).toBe("أشعة المرجع"); expect(nodes(render()).find(node => node.type === "a")?.props.href).toBe(`/print/ceph-compare?first=1&second=2&reference=${reference}`);
    expect(nodes(render()).filter(node => node.type === "td").every(node => !String(node.props.className).includes("emerald"))).toBe(true);
  });
  it("labels known dates as recorded acquisition order, not treatment order or growth", async () => {
    render(); await flush();
    const output = text(render()); expect(output).toContain("تاريخ التصوير المسجل"); expect(output).toContain("التصوير الأسبق"); expect(output).toContain("التصوير اللاحق");
    expect(output).not.toContain("فرق النموّ"); expect(output).not.toContain("قبل العلاج (#"); expect(output).not.toContain("بعد العلاج (#");
  });
  it("clears the old reference synchronously on reversal and ignores its late overlay", async () => {
    respondExplicit(); render(); await flush();
    const old = deferred<ReturnType<typeof ok>>();
    fetchMock.mockResolvedValueOnce(ok(explicitPair().compared)).mockReturnValueOnce(old.promise);
    click("اختيار #1"); await flush(); expect(image()).toBeUndefined();
    click("اختيار #2"); expect(text(render())).not.toContain("-6.0"); await flush(); load();
    expect(image()?.props.src).toContain("/52?"); expect(text(render())).toContain("+6.0");
    old.resolve(ok(explicitPair().placed)); await flush(); expect(image()?.props.src).toContain("/52?"); expect(svgs()).toHaveLength(1);
  });
  it("clears choices, direction and images on pair changes and request reversal", async () => {
    respondExplicit(); render(); await flush(); click("اختيار #1"); await flush(); load();
    props = { ...props, first: 2, second: 1 }; render(); expect(image()).toBeUndefined(); expect(text(render())).not.toContain("-6.0"); await flush();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/ceph/compare?first=2&second=1"); expect(text(render())).toContain("اختيار #2");
    click("اختيار #1"); await flush(); expect(text(render())).toContain("-6.0");
    props = { ...props, first: 3, second: 4 }; render(); expect(image()).toBeUndefined(); await flush();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/ceph/compare?first=3&second=4"); expect(text(render())).not.toContain("اختيار #1");
  });
  it("ignores a delayed unresolved response for a superseded pair", async () => {
    const old = deferred<ReturnType<typeof unresolved>>(); fetchMock.mockReturnValueOnce(old.promise); render();
    props = { ...props, first: 3, second: 4 }; render(); await flush(); load();
    old.resolve(unresolved()); await flush(); expect(text(render())).not.toContain("اختيار #1"); expect(svgs()).toHaveLength(1);
  });
  it.each([undefined, null, {}, { mode: "invented", chronology: "known", referenceId: 1, comparisonId: 2 }, { ...ordering(1, 2), referenceId: 2 }, { ...ordering(1, 2), chronology: "unknown" }])("rejects missing or malformed successful comparison ordering %#", async order => {
    fetchMock.mockResolvedValue(ok({ ...comparison(), ordering: order })); render(); await flush();
    expect(nodes(render()).filter(node => node.type === "table")).toHaveLength(0); expect(image()).toBeUndefined(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([null, {}, { comparison: null }, { ...comparison(), comparison: { ...comparison().comparison, measurements: [{ delta: null }] } }])("fails closed on malformed comparison shape %#", async payload => {
    fetchMock.mockResolvedValue(ok(payload)); render(); await flush(); expect(image()).toBeUndefined(); expect(nodes(render()).some(node => node.props.role === "alert")).toBe(true);
  });
  it("rejects unsolicited explicit orientation without a user selection", async () => {
    fetchMock.mockResolvedValue(ok(explicitPair().compared)); render(); await flush(); expect(fetchMock).toHaveBeenCalledTimes(1); expect(text(render())).not.toContain("-6.0");
  });
  it("rejects a server-selected reference different from the deliberate choice", async () => {
    respondExplicit(); render(); await flush(); fetchMock.mockResolvedValue(ok(explicitPair(2, 1).compared)); click("اختيار #1"); await flush();
    expect(text(render())).not.toContain("+6.0"); expect(image()).toBeUndefined();
  });
  it("rejects graded output in nonchronological reference mode", async () => {
    respondExplicit(); render(); await flush(); const pair = explicitPair(); pair.compared.comparison.measurements[0].direction = "improved";
    fetchMock.mockResolvedValue(ok(pair.compared)); click("اختيار #1"); await flush(); expect(text(render())).not.toContain("-6.0"); expect(image()).toBeUndefined();
  });
  it.each(["known dates", "wrong pair", "unknown reason"])("does not offer reference choices from inconsistent 409 metadata: %s", async kind => {
    const data = await unresolved().json();
    if (kind === "known dates") data.choices = [{ id: 1, xrayDate: "2020-01-01" }, { id: 2, xrayDate: "2022-01-01" }] as unknown as typeof data.choices;
    if (kind === "wrong pair") data.choices[1].id = 3;
    if (kind === "unknown reason") data.reason = "invented";
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => data }); render(); await flush();
    expect(nodes(render()).filter(node => node.type === "button")).toHaveLength(0); expect(image()).toBeUndefined();
  });
  it.each(["automatic", "explicit"])("rejects changed date metadata between %s compare and overlay even with unchanged hashes", async mode => {
    if (mode === "explicit") {
      respondExplicit(); render(); await flush(); const pair = explicitPair(); Reflect.set(pair.placed.after, "xrayDate", "2026-01-02");
      fetchMock.mockImplementation(async (url: string) => ok(url.includes("/superimpose") ? pair.placed : pair.compared)); click("اختيار #1");
    } else {
      const placed = overlay(); placed.after.xrayDate = "2026-01-03";
      fetchMock.mockImplementation(async (url: string) => ok(url.includes("/superimpose") ? placed : comparison())); render();
    }
    await flush(); expect(image()).toBeUndefined(); expect(svgs()).toHaveLength(0); expect(nodes(render()).some(node => node.props.role === "alert")).toBe(true);
  });
  it.each([undefined, null, { ...ordering(1, 2), mode: "invented" }, { ...ordering(1, 2), referenceId: 2 }])("rejects malformed overlay ordering %#", async order => {
    fetchMock.mockImplementation(async (url: string) => ok(url.includes("/superimpose") ? { ...overlay(), ordering: order } : comparison()));
    render(); await flush(); expect(image()).toBeUndefined(); expect(nodes(render()).some(node => node.props.role === "alert")).toBe(true);
  });
});


describe("comparison metadata shape safety", () => {
  it.each([undefined, 123, {}, [], true])("does not offer references for malformed acquisition-date JSON %#", async date => {
    const payload = await unresolved().json(); Reflect.set(payload.choices[0], "xrayDate", date);
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => payload }); render(); await flush();
    expect(nodes(render()).filter(node => node.type === "button" || node.type === "table")).toHaveLength(0);
    expect(nodes(render()).some(node => node.props.role === "alert")).toBe(true);
  });
  it.each(["__proto__", "constructor"])("renders unknown recorded phase %s as plain text, not an inherited object", async phase => {
    const compared = comparison(); compared.before.phase = phase;
    fetchMock.mockImplementation(async (url: string) => ok(url.includes("/superimpose") ? overlay() : compared));
    render(); await flush(); expect(text(render())).toContain(phase); expect(image()).toBeDefined();
  });
});


describe("comparison UI reference suitability contract", () => {
  const descriptive = () => ({ ...comparison(), comparison: { ...comparison().comparison,
    interpretation: { mode: "descriptive_only", reason: "reference_suitability_not_established" },
    measurements: [{ key: "SNA", name: "SNA", unit: "°", before: 90, after: 84, delta: -6, gapBefore: null, gapAfter: null, direction: "ungraded" }],
  } });
  it.each(["policy absent", "policy invalid", "policy reason invalid", "grade", "gap", "counter", "wrong arithmetic", "duplicate key", "quarantined code"])("rejects old or malformed chronological %s", async kind => {
    const payload = descriptive();
    if (kind === "policy absent") Reflect.deleteProperty(payload.comparison, "interpretation");
    if (kind === "policy invalid") payload.comparison.interpretation.mode = "norms_validated";
    if (kind === "policy reason invalid") payload.comparison.interpretation.reason = "reference_validated";
    if (kind === "grade") payload.comparison.measurements[0].direction = "improved";
    if (kind === "gap") Reflect.set(payload.comparison.measurements[0], "gapBefore", 8);
    if (kind === "counter") payload.comparison.improved = 1;
    if (kind === "wrong arithmetic") payload.comparison.measurements[0].delta = 6;
    if (kind === "duplicate key") payload.comparison.measurements.push({ ...payload.comparison.measurements[0] });
    if (kind === "quarantined code") payload.comparison.measurements[0].key = "EXT_INDEX";
    fetchMock.mockResolvedValue(ok(payload)); render(); await flush();
    expect(nodes(render()).filter(node => node.type === "table")).toHaveLength(0);
    expect(image()).toBeUndefined(); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(nodes(render()).some(node => node.props.role === "alert")).toBe(true);
  });
  it("shows raw differences and a locally derived limitation, never injected server summary grades", async () => {
    const payload = descriptive(); payload.summary = { ar: "اقترب من المعيار", en: "Moved toward norm" };
    fetchMock.mockImplementation(async (url: string) => ok(url.includes("/superimpose") ? overlay() : payload));
    render(); await flush(); const output = text(render());
    expect(output).toContain("-6.0"); expect(output).toContain("لم تُثبت ملاءمة المراجع المعيارية واتساقها لهذه المقارنة");
    for (const claim of ["اقترب من المعيار", "ابتعد عن المعيار", "بلا تغيّر يُذكر", "بلا معيار", "الحكم"]) expect(output).not.toContain(claim);
  });
});
