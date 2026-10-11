import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CephTracer } from "../components/CephTracer";
import type { SessionInfo } from "../components/SessionProvider";

// Executes the actual component handlers with synthetic hook storage/transport.
// Real React/browser and HTTP/PG proof remain separate required acceptance.
const hooks = vi.hoisted(() => ({
  session: { username: "synthetic-doctor", role: "doctor", permissions: null } as SessionInfo | null,
  values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  pending: [] as Array<() => void>,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = slot(undefined), previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); hooks.memos.set(index, { deps, value }); return value;
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (update: unknown) => {
        const next = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => { const index = slot({ current: initial }); return hooks.values[index]; },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined), previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.(); const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined), previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.(); const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
});


vi.mock("next/link", () => ({ default: "a" }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const textOf = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" && "props" in node ? textOf((node as Element).props.children as ReactNode) : "";
type Props = Parameters<typeof CephTracer>[0];
const makeProps = (id = 41): Props => ({
  patientName: "Synthetic patient", patientBirthYear: 2000,
  analysis: { id, patientId: 101, documentId: 501, status: "draft", orthoCaseId: 201,
    phase: "pretreatment", xrayDate: null, device: null, refSet: "builtin_default", calibration: null,
    mmPerPixel: null, note: null, createdBy: "synthetic-doctor", createdAt: "2026-01-01T12:00:00Z",
    completedBy: null, completedAt: null, findings: null },
  initialLandmarks: [], stamped: null, refValues: null, refSetName: null,
  diagnosis: { skeletal: "Existing skeletal", dental: "Existing dental", softTissue: "Existing soft tissue",
    note: "Doctor authored note", finalDx: "Existing conclusion", createdBy: "synthetic-doctor", updatedAt: "2026-01-01T12:00:00Z" },
});
let props: Props;
let editorKey: string | null;
const fetchMock = vi.fn();
function render() {
  let tree: ReturnType<typeof CephTracer> | null = null;
  for (let round = 0; round < 20; round++) {
    hooks.cursor = 0; hooks.changed = false;
    const editor = CephTracer(props);
    if (editor.key !== editorKey) {
      hooks.effects.forEach(effect => effect.cleanup?.());
      hooks.values.length = 0; hooks.effects.clear(); hooks.memos.clear(); hooks.pending.length = 0;
      editorKey = editor.key;
    }
    // The harness explicitly models the React key boundary. Native React proof
    // remains required; this is not a substitute for actual reconciliation.
    tree = (editor.type as (input: unknown) => ReturnType<typeof CephTracer>)(editor.props);
    hooks.pending.splice(0).forEach(effect => effect());
    if (!hooks.changed) return tree;
  }
  throw new Error("CephTracer did not settle");
}
const findButton = (label: string) => {
  const button = nodes(render()).find(node => node.type === "button" && textOf(node).includes(label));
  if (!button) throw new Error(`Missing button ${label}`);
  return button;
};
function click(label: string) {
  const button = findButton(label);
  expect(button.props.disabled).not.toBe(true);
  (button.props.onClick as () => void)();
  render();
}
const textarea = (placeholder: string) => nodes(render()).find(node => node.type === "textarea" && node.props.placeholder === placeholder)!;
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); render(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const valid = (analysisId = 41) => ({
  provenance: { analysisId, patientId: 101, documentId: 501, state: "draft", source: "local-measurement-summary",
    engineVersion: "ceph-draft-safety-v1", acquisitionAgeYears: null, agePrecision: "unknown", growthAssessment: "not-assessed" },
  suggestion: { skeletal: "New skeletal", dental: "New dental", softTissue: "New soft tissue",
    finalDx: "New draft", recommendationsText: "Not a treatment plan" },
});
const response = (status: number, value: unknown) => ({ ok: status >= 200 && status < 300, status,
  json: async () => value } as Response);
const geometry = (analysisId = 41) => ({
  provenance: { ...valid(analysisId).provenance, source: "geometric-placement" }, saved: false,
  landmarks: [{ code: "S", x: 999, y: 999 }, { code: "N", x: 90, y: 20 }, { code: "A", x: 95, y: 65 }, { code: "B", x: 93, y: 85 }],
});
function loadImage() {
  const image = nodes(render()).find(node => node.type === "img" && typeof node.props.onLoad === "function")!;
  (image.props.onLoad as (event: unknown) => void)({ currentTarget: { naturalWidth: 1600, naturalHeight: 1600 } });
  render();
}
function selectPoint(code: string) {
  const button = nodes(render()).find(node => node.type === "button" && [code, `${code} ✦`, `${code} ✓`].includes(textOf(node)))!;
  (button.props.onClick as () => void)(); render();
}
function measurementValue(code: string) {
  const row = nodes(render()).find(node => node.type === "tr" && node.key === code)!;
  return textOf(nodes(row).filter(node => node.type === "td")[1]);
}

beforeEach(() => {
  hooks.values.length = 0; hooks.cursor = 0; hooks.changed = false;
  hooks.effects.clear(); hooks.memos.clear(); hooks.pending.length = 0;
  editorKey = null;
  props = makeProps(); fetchMock.mockReset();
  hooks.session = { username: "synthetic-doctor", role: "doctor", permissions: null };
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { location: { search: "" }, addEventListener: vi.fn(), removeEventListener: vi.fn(), confirm: vi.fn(() => false), innerWidth: 1440 });
});
afterEach(() => {
  hooks.effects.forEach(effect => effect.cleanup?.());
  vi.unstubAllGlobals();
});

describe("actual CephTracer suggestion handlers", () => {
  it.each([401, 403, 404, 409, 500])("status %s does not fall back or overwrite authored diagnosis", async (status) => {
    fetchMock.mockResolvedValue(response(status, { message: "Refused" }));
    click("مسودة وصف القياسات المحلية"); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(textarea("الاستنتاج السيفالومتري (مطلوب)…").props.value).toBe("Existing conclusion");
    expect(textarea("ملاحظات الطبيب (اختياري)…").props.value).toBe("Doctor authored note");
    expect(textOf(render())).not.toContain("New draft");
  });
  it("network failure never performs local fallback", async () => {
    fetchMock.mockRejectedValue(new Error("synthetic lost response"));
    click("مسودة وصف القياسات المحلية"); await flush();
    expect(textarea("الاستنتاج السيفالومتري (مطلوب)…").props.value).toBe("Existing conclusion");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("matching local draft preserves clinician notes and requests no external provider or save", async () => {
    fetchMock.mockResolvedValue(response(200, valid()));
    click("مسودة وصف القياسات المحلية"); await flush();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: "generate-diagnosis", useAiChat: false, saveToDiagnosis: false });
    expect(textarea("الاستنتاج السيفالومتري (مطلوب)…").props.value).toBe("New draft");
    expect(textarea("ملاحظات الطبيب (اختياري)…").props.value).toBe("Doctor authored note");
    expect(textOf(render())).toContain("مسودة غير معتمدة");
  });
  it("wrong-study response is refused", async () => {
    fetchMock.mockResolvedValue(response(200, valid(99)));
    click("مسودة وصف القياسات المحلية"); await flush();
    expect(textarea("الاستنتاج السيفالومتري (مطلوب)…").props.value).toBe("Existing conclusion");
  });
  it("A→B→A retires the original response even if the study IDs match again", async () => {
    const wait = deferred<Response>(); fetchMock.mockReturnValue(wait.promise);
    click("مسودة وصف القياسات المحلية");
    props = makeProps(42); render(); props = makeProps(41); render();
    wait.resolve(response(200, valid())); await flush();
    expect(textarea("الاستنتاج السيفالومتري (مطلوب)…").props.value).toBe("Existing conclusion");
  });
  it("new clinician edits while waiting cannot be replaced by a delayed draft", async () => {
    const wait = deferred<Response>(); fetchMock.mockReturnValue(wait.promise);
    click("مسودة وصف القياسات المحلية");
    (textarea("الاستنتاج السيفالومتري (مطلوب)…").props.onChange as (event: unknown) => void)({ target: { value: "Authored during request" } });
    render(); wait.resolve(response(200, valid())); await flush();
    expect(textarea("الاستنتاج السيفالومتري (مطلوب)…").props.value).toBe("Authored during request");
  });
  it("principal A→B→A retires an old clinical suggestion without a remount", async () => {
    const wait = deferred<Response>(); fetchMock.mockReturnValue(wait.promise);
    click("مسودة وصف القياسات المحلية");
    hooks.session = { username: "other-doctor", role: "doctor", permissions: null }; render();
    hooks.session = { username: "synthetic-doctor", role: "doctor", permissions: null }; render();
    wait.resolve(response(200, valid())); await flush();
    expect(textarea("الاستنتاج السيفالومتري (مطلوب)…").props.value).toBe("Existing conclusion");
  });

  it("geometric preview preserves placed points, stays out of calculations and requires an individual review save", async () => {
    props.initialLandmarks = [{ code: "S", x: 20, y: 20, source: "manual" }, { code: "N", x: 90, y: 20, source: "manual" }];
    props.analysis.mmPerPixel = 0.2;
    fetchMock.mockResolvedValueOnce(response(200, geometry()));
    loadImage(); click("توزيع هندسي للمعالم للمراجعة"); await flush();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: "suggest-landmarks", imageWidth: 1600, imageHeight: 1600, save: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(measurementValue("SNA")).toContain("—");
    expect(textOf(render())).toContain("مستبعدة من القياسات والاعتماد");
    selectPoint("S");
    expect(nodes(render()).some(node => node.type === "button" && textOf(node).includes("راجعت موضع S"))).toBe(false);
    selectPoint("A"); fetchMock.mockResolvedValueOnce(response(200, { ok: true }));
    click("راجعت موضع A"); await flush();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ landmarks: [{ code: "A", x: 95, y: 65, source: "manual" }] });
    expect(measurementValue("SNA")).not.toContain("—");
    expect(measurementValue("SNB")).toContain("—");
    expect(textOf(render())).toContain("مستبعدة من القياسات والاعتماد");
    const leave = nodes(render()).find(node => node.type === "a" && typeof node.props.onClick === "function")!;
    const preventDefault = vi.fn(); (leave.props.onClick as (event: unknown) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
  });

  it("a refused individual preview save cannot mark it reviewed or expose its measurement", async () => {
    props.initialLandmarks = [{ code: "S", x: 20, y: 20, source: "manual" }, { code: "N", x: 90, y: 20, source: "manual" }];
    fetchMock.mockResolvedValueOnce(response(200, geometry()));
    loadImage(); click("توزيع هندسي للمعالم للمراجعة"); await flush(); selectPoint("A");
    fetchMock.mockResolvedValueOnce(response(403, { message: "Refused" }));
    click("راجعت موضع A"); await flush();
    expect(findButton("راجعت موضع A")).toBeDefined();
    expect(measurementValue("SNA")).toContain("—");
  });

  it("a delayed geometric preview from another study never adds landmarks", async () => {
    const wait = deferred<Response>(); fetchMock.mockReturnValue(wait.promise);
    loadImage(); click("توزيع هندسي للمعالم للمراجعة");
    props = makeProps(42); render(); wait.resolve(response(200, geometry())); await flush();
    expect(textOf(render())).not.toContain("مستبعدة من القياسات والاعتماد");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("a reviewed-point response clears only its exact point after selection changes", async () => {
    props.initialLandmarks = [{ code: "S", x: 20, y: 20, source: "manual" }, { code: "N", x: 90, y: 20, source: "manual" }];
    fetchMock.mockResolvedValueOnce(response(200, geometry()));
    loadImage(); click("توزيع هندسي للمعالم للمراجعة"); await flush(); selectPoint("A");
    const wait = deferred<Response>(); fetchMock.mockReturnValueOnce(wait.promise);
    click("راجعت موضع A"); selectPoint("B"); wait.resolve(response(200, { ok: true })); await flush();
    expect(findButton("راجعت موضع B")).toBeDefined();
    expect(measurementValue("SNB")).toContain("—");
    selectPoint("A");
    expect(nodes(render()).some(node => node.type === "button" && textOf(node).includes("راجعت موضع A"))).toBe(false);
  });
  it("an already accepted A preview never renders or saves under B or after A returns", async () => {
    fetchMock.mockResolvedValueOnce(response(200, geometry()));
    loadImage(); click("توزيع هندسي للمعالم للمراجعة"); await flush(); selectPoint("A");
    expect(findButton("راجعت موضع A")).toBeDefined();
    for (const id of [42, 41]) {
      props = makeProps(id); render();
      expect(textOf(render())).not.toContain("مستبعدة من القياسات والاعتماد");
      expect(nodes(render()).some(node => node.type === "button" && textOf(node).includes("راجعت موضع"))).toBe(false);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("a retained review handler cannot issue a write after its owner is retired", async () => {
    fetchMock.mockResolvedValueOnce(response(200, geometry()));
    loadImage(); click("توزيع هندسي للمعالم للمراجعة"); await flush(); selectPoint("A");
    const retainedReview = findButton("راجعت موضع A").props.onClick as () => void;
    props = makeProps(42); render(); retainedReview(); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(textOf(render())).not.toContain("مستبعدة من القياسات والاعتماد");
  });
  it.each(["orthoCaseId", "phase", "refSet"])("same-study %s changes retire a delayed response", async (field) => {
    const wait = deferred<Response>(); fetchMock.mockReturnValue(wait.promise);
    click("مسودة وصف القياسات المحلية");
    props = { ...props, analysis: { ...props.analysis, [field]: field === "orthoCaseId" ? 202 : field === "phase" ? "during" : "new-reference" } };
    render(); wait.resolve(response(200, valid())); await flush();
    expect(textarea("الاستنتاج السيفالومتري (مطلوب)…").props.value).toBe("Existing conclusion");
  });
  it("out-of-plane returned geometry is refused rather than exposed as reviewable landmarks", async () => {
    fetchMock.mockResolvedValueOnce(response(200, { ...geometry(), landmarks: [{ code: "A", x: 1601, y: 30 }] }));
    loadImage(); click("توزيع هندسي للمعالم للمراجعة"); await flush();
    expect(textOf(render())).not.toContain("مستبعدة من القياسات والاعتماد");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
