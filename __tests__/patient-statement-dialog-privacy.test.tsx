import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientStatementDialog } from "../components/PatientStatementDialog";

// Execute real component callbacks with synthetic data and controlled session reads.
const hooks = vi.hoisted(() => {
  type Store = { values: unknown[]; cursor: number; changed: boolean;
    effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>;
    memos: Map<number, { deps?: readonly unknown[]; value: unknown }>; pending: Array<() => void> };
  const make = (): Store => ({ values: [], cursor: 0, changed: false, effects: new Map(), memos: new Map(), pending: [] });
  return { make, current: make(), outer: make(), inner: make(), form: make() };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: "synthetic-owner", role: "admin" }) }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const h = hooks.current, index = h.cursor++; if (!(index in h.values)) h.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const h = hooks.current, index = slot(undefined), previous = h.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); h.memos.set(index, { deps, value }); return value;
  };
  const effect = (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const h = hooks.current, index = slot(undefined), previous = h.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    h.pending.push(() => { previous?.cleanup?.(); const cleanup = run(); h.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
  };
  return { ...react,
    useState: (initial: unknown) => { const h = hooks.current, index = slot(typeof initial === "function" ? initial() : initial);
      if (!h.memos.has(index)) h.memos.set(index, { value: (value: unknown) => { const next = typeof value === "function" ? value(h.values[index]) : value;
        if (!Object.is(next, h.values[index])) h.changed = true; h.values[index] = next; } });
      return [h.values[index], h.memos.get(index)!.value]; },
    useId: () => `synthetic-form-${slot("id")}`,
    useRef: (initial: unknown) => hooks.current.values[slot({ current: initial })],
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: effect, useLayoutEffect: effect,
  };
});

type Element = ReactElement<Record<string, unknown>>;
const elements = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(elements)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...elements((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
function render(): ReactNode {
  for (let round = 0; round < 30; round++) {
    for (const h of [hooks.outer, hooks.inner]) { h.cursor = 0; h.changed = false; }
    hooks.current = hooks.outer;
    const wrapper = PatientStatementDialog({ patientId: 901 }) as Element;
    const composer = elements(wrapper).find(node => typeof node.type === "function");
    let tree: ReactNode = wrapper;
    if (composer) { hooks.current = hooks.inner; tree = (composer.type as (props: Record<string, unknown>) => ReactNode)(composer.props); }
    hooks.outer.pending.splice(0).forEach(run => run()); hooks.inner.pending.splice(0).forEach(run => run());
    if (!hooks.outer.changed && !hooks.inner.changed) return tree;
  }
  throw new Error("Statement fixture did not settle");
}
async function settle() { for (let pass = 0; pass < 5; pass++) { for (let i = 0; i < 15; i++) await Promise.resolve(); render(); } }
const find = (predicate: (element: Element) => boolean) => elements(render()).find(predicate)!;
const click = (label: string) => { const node = find(node => node.type === "button" && text(node) === label); expect(node).toBeDefined(); (node.props.onClick as () => void)(); render(); };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const fetchMock = vi.fn();
const events = new Map<string, () => Promise<void>>();
const secret = "SYNTHETIC-PRIVATE-TREATMENT";
const statement = { patient: { name: "Synthetic", number: "S-901", phone: "+967777123456" }, title: "Statement", generatedAt: "2026-01-01", clinic: { name: "Synthetic" }, sections: [], notices: [], treatments: [{ id: 17, title: secret }] };
let sessionRead: () => Promise<Response>;
beforeEach(() => {
  hooks.outer = hooks.make(); hooks.inner = hooks.make(); hooks.current = hooks.outer; events.clear();
  const eventTarget = { addEventListener: (name: string, handler: () => Promise<void>) => events.set(name, handler), removeEventListener: vi.fn() };
  vi.stubGlobal("window", eventTarget);
  vi.stubGlobal("document", { ...eventTarget, visibilityState: "visible" });
  sessionRead = async () => json({ id: 1, username: "synthetic-owner", role: "admin" });
  fetchMock.mockImplementation((url: string) => url === "/api/auth/me" ? sessionRead() : Promise.resolve(json(statement)));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { for (const h of [hooks.outer, hooks.inner]) h.effects.forEach(entry => entry.cleanup?.()); vi.unstubAllGlobals(); vi.clearAllMocks(); });
async function openTreatments() {
  click("كشف حساب"); await settle();
  const select = find(node => node.props["data-statement-type"] !== undefined);
  (select.props.onChange as (event: unknown) => void)({ target: { value: "treatment" } });
  expect(text(render())).toContain(secret);
}
describe("statement private selection lifecycle", () => {
  it.each([401, 403])("purges cached treatment metadata on a non-JSON statement %s denial", async status => {
    await openTreatments();
    const select = find(node => node.type === "select" && elements(node.props.children as ReactNode).some(child => child.props.value === 17));
    (select.props.onChange as (event: unknown) => void)({ target: { value: "17" } });
    fetchMock.mockImplementation((url: string) => url === "/api/auth/me" ? sessionRead() : Promise.resolve(new Response("Denied", { status })));
    click("معاينة الكشف"); await settle();
    expect(text(render())).not.toContain(secret);
    expect(JSON.stringify(hooks.inner.values)).not.toContain(secret);
    expect(hooks.inner.values).not.toContain("17");
    expect(hooks.inner.values).not.toContain("+967777123456");
    expect(text(render())).toContain("تغيّر المستخدم أو صلاحياته");
  });
  it.each(["focus", "final-print"])("closes a populated print popup on %s authority check", async check => {
    click("كشف حساب"); await settle();
    let resolveImage!: () => void;
    const imageReady = new Promise<void>(done => { resolveImage = done; });
    const popup = { opener: {}, close: vi.fn(), focus: vi.fn(), print: vi.fn(), document: {
      documentElement: { lang: "", dir: "", className: "" }, title: "", head: { append: vi.fn() }, body: { append: vi.fn() },
      createElement: () => ({ textContent: "" }), fonts: { ready: Promise.resolve() }, images: [{ decode: () => imageReady }],
    } };
    const preview = { cloneNode: () => ({ synthetic: true }) };
    const previewRef = hooks.inner.values.find(value => value && typeof value === "object" && "current" in value && value.current === null) as { current: unknown };
    previewRef.current = preview;
    Object.assign(window, { open: () => popup });
    Object.assign(document, { documentElement: { className: "synthetic-font" }, querySelectorAll: () => [] });
    vi.stubGlobal("getComputedStyle", () => ({ fontFamily: "synthetic-font" }));
    click("طباعة المعاينة"); await settle();
    expect(popup.document.body.append).toHaveBeenCalled();
    sessionRead = async () => json({ id: 2, username: "another-owner", role: "admin" });
    // Focus verification must remove the already populated window immediately,
    // even if its image decode never settles.
    if (check === "focus") {
      await events.get("focus")!(); await settle();
      expect(popup.close).toHaveBeenCalled();
    }
    resolveImage(); await settle();
    expect(popup.close).toHaveBeenCalled();
    expect(popup.print).not.toHaveBeenCalled();
    expect(JSON.stringify(hooks.inner.values)).not.toContain(secret);
  });
  it("keeps choices on ordinary filter edits, hides them while checking and purges them after changed authority", async () => {
    await openTreatments();
    let resolve!: (value: Response) => void;
    sessionRead = () => new Promise(done => { resolve = done; });
    const check = events.get("focus")!();
    expect(text(render())).not.toContain(secret);
    resolve(json({ id: 2, username: "another-owner", role: "admin" }));
    await check; await settle();
    expect(text(render())).not.toContain(secret);
    expect(hooks.inner.values).not.toContain("+967777123456");
    expect(JSON.stringify(hooks.inner.values)).not.toContain(secret);
  });
  it("purges private choices when session verification fails during preview reload", async () => {
    await openTreatments();
    const select = find(node => node.type === "select" && elements(node.props.children as ReactNode).some(child => child.props.value === 17));
    (select.props.onChange as (event: unknown) => void)({ target: { value: "17" } });
    sessionRead = async () => { throw new Error("Synthetic network failure"); };
    click("معاينة الكشف"); await settle();
    expect(text(render())).not.toContain(secret);
    expect(hooks.inner.values).not.toContain("17");
    expect(hooks.inner.values).not.toContain("+967777123456");
  });
});
