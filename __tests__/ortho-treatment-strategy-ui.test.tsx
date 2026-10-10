import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrthoTreatmentStrategy, type StrategyLifetime } from "../components/OrthoTreatmentStrategy";
import type { SessionInfo } from "../components/SessionProvider";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../lib/doctor-permissions";
import { emptyStrategy, restrictedStrategy, savedStrategy, strategyHistory, STRATEGY_IDS, STRATEGY_TEXT } from "./fixtures/ortho-strategy";

// STATUS: UNRUN. Deterministic component/adapter contract source. This hook
// simulator is not React/DOM/StrictMode proof; the built-page browser suite
// separately exercises the actual parent adapter, navigation and CSS.
type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
type Scope = { values: unknown[]; cursor: number; live: boolean; effects: Map<number, Effect>;
  memos: Map<number, { deps?: readonly unknown[]; value: unknown }> };
const hooks = vi.hoisted(() => ({ current: null as Scope | null, changed: false, retiredWrites: 0,
  layout: [] as Array<() => void>, passive: [] as Array<() => void>, session: null as SessionInfo | null }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const scope = () => { if (!hooks.current) throw new Error("Hook outside a component scope"); return hooks.current; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const owner = scope(), index = owner.cursor++, prior = owner.memos.get(index);
    if (prior && same(prior.deps, deps)) return prior.value;
    const value = factory(); owner.memos.set(index, { deps, value }); return value;
  };
  const effect = (callback: () => void | (() => void), deps: readonly unknown[] | undefined, layout: boolean) => {
    const owner = scope(), index = owner.cursor++, prior = owner.effects.get(index);
    if (prior && same(prior.deps, deps)) return;
    const entry: Effect = { deps }; owner.effects.set(index, entry);
    (layout ? hooks.layout : hooks.passive).push(() => { if (!owner.live) return; prior?.cleanup?.(); entry.cleanup = callback() || undefined; });
  };
  return { ...react,
    useState: (initial: unknown) => {
      const owner = scope(), index = owner.cursor++;
      if (!(index in owner.values)) owner.values[index] = typeof initial === "function" ? initial() : initial;
      return [owner.values[index], (update: unknown) => {
        if (!owner.live) { hooks.retiredWrites++; throw new Error("Retired component received a state write"); }
        const next = typeof update === "function" ? update(owner.values[index]) : update;
        if (!Object.is(next, owner.values[index])) hooks.changed = true; owner.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => { const owner = scope(), index = owner.cursor++; if (!(index in owner.values)) owner.values[index] = { current: initial }; return owner.values[index]; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => effect(callback, deps, false),
    useLayoutEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => effect(callback, deps, true),
  };
});
type Element = ReactElement<Record<string, unknown>>;
type Pending = { url: string; init?: RequestInit; json: ReturnType<typeof vi.fn>;
  headers: (status?: number) => void; body: (value: unknown) => void; fail: () => void };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject };
}
let props: Parameters<typeof OrthoTreatmentStrategy>[0], requests: Pending[], unexpected: string[], sequence: number;
let scopes = new Map<string, Scope>(), seen = new Set<string>(), componentIds = new Map<unknown, number>();
const PATIENT_A = 959701, PATIENT_B = 959702;
const ids = STRATEGY_IDS.a;
const confirmLeave = vi.fn<(message: string) => boolean>();
function life(): StrategyLifetime & { live: boolean; attached: boolean; changes: string[]; settlements: string[]; denials: number } {
  const edits = new Set<string>();
  const value = { identity: {}, live: true, attached: true, busy: false, uncertain: false, dirty: false, readVersion: 0,
    refresh: () => { if (value.live) value.readVersion++; },
    values: { document: "", problemLabel: "", problemSite: "" }, changes: [] as string[], settlements: [] as string[], denials: 0,
    active: () => value.live && value.attached, editable: () => value.live && value.attached && !value.busy && !value.uncertain,
    denied: () => { value.denials++; value.live = false; },
    change: (field: "document" | "problemLabel" | "problemSite", content: string) => {
      if (!value.live) throw new Error("Retired adapter received a draft change");
      value.values[field] = content; edits.add(field); value.dirty = edits.size > 0; value.changes.push(field);
    },
    settle: (field: "document" | "problemLabel" | "problemSite", content: string) => {
      if (!value.live) throw new Error("Retired adapter received settlement");
      if (value.busy || value.uncertain) throw new Error("Settlement attempted before a confirmed command finished");
      value.values[field] = content; edits.delete(field); value.dirty = edits.size > 0; value.settlements.push(field);
    },
    begin: () => {
      if (!value.editable()) return null;
      value.busy = true;
      return { current: () => value.live,
        checkHeaders: (response: Response) => { if ([401, 403].includes(response.status)) { value.denied(); return false; } return value.live; },
        markUncertain: () => { if (value.live) value.uncertain = true; }, finish: () => { value.busy = false; } };
    },
  };
  return value;
}
function execute(component: (value: Record<string, unknown>) => ReactNode, value: Record<string, unknown>, path: string): ReactNode {
  seen.add(path); let owner = scopes.get(path);
  if (!owner) { owner = { values: [], cursor: 0, live: true, effects: new Map(), memos: new Map() }; scopes.set(path, owner); }
  owner.cursor = 0; const prior = hooks.current; hooks.current = owner;
  try { return component(value); } finally { hooks.current = prior; }
}
function expand(node: ReactNode, path: string): ReactNode {
  if (Array.isArray(node)) return node.map((item, index) => expand(item, `${path}/${index}`));
  if (!node || typeof node !== "object" || !("props" in node)) return node;
  const element = node as Element;
  const identity = `${path}:${String(element.key ?? "")}`;
  if (typeof element.type === "function") {
    if (!componentIds.has(element.type)) componentIds.set(element.type, componentIds.size);
    const ownerPath = `${identity}/component-${componentIds.get(element.type)}`;
    return expand(execute(element.type as (value: Record<string, unknown>) => ReactNode, element.props, ownerPath), `${ownerPath}/result`);
  }
  return { ...element, props: { ...element.props, children: expand(element.props.children as ReactNode, `${identity}/children`) } };
}
function render(): ReactNode {
  let tree: ReactNode = null, rounds = 0;
  do {
    if (++rounds > 30) throw new Error("Strategy component did not settle");
    hooks.changed = false; seen = new Set();
    tree = expand(execute(() => OrthoTreatmentStrategy(props), {}, "strategy"), "strategy/result");
    for (const [key, owner] of scopes) if (!seen.has(key)) { retire(owner); scopes.delete(key); }
    hooks.layout.splice(0).forEach(callback => callback()); hooks.passive.splice(0).forEach(callback => callback());
  } while (hooks.changed);
  return tree;
}
function all(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(all);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...all(element.props.children as ReactNode)];
}
function content(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(content).join("");
  return node && typeof node === "object" && "props" in node ? content((node as Element).props.children as ReactNode) : "";
}
const find = (predicate: (node: Element) => boolean) => all(render()).filter(predicate);
function button(label: string) { const values = find(node => node.type === "button" && content(node).trim() === label); expect(values).toHaveLength(1); return values[0]; }
function click(label: string) { const one = button(label); expect(one.props.disabled).not.toBe(true); (one.props.onClick as () => void)(); render(); }
function selectHistory(id: number) {
  const values = find(node => node.props["aria-label"] === "نسخة خطة الحالة"); expect(values).toHaveLength(1);
  (values[0].props.onChange as (event: unknown) => void)({ target: { value: String(id) } }); render();
}
async function drain() { for (let index = 0; index < 100; index++) await Promise.resolve(); }
async function flush() { for (let round = 0; round < 5; round++) { await drain(); render(); } }
const gets = () => requests.filter(one => !one.init?.method || one.init.method === "GET");
const writes = () => requests.filter(one => one.init?.method && one.init.method !== "GET");
async function answer(body: unknown, request = gets().at(-1)!, status = 200) { request.headers(status); request.body(body); await flush(); }
function retire(owner: Scope) { owner.live = false; owner.effects.forEach(entry => entry.cleanup?.()); owner.effects.clear(); }
function unmount() { scopes.forEach(retire); scopes.clear(); hooks.layout = []; hooks.passive = []; hooks.current = null; }

beforeEach(() => {
  unmount(); scopes = new Map(); componentIds = new Map(); hooks.changed = false; hooks.retiredWrites = 0;
  hooks.session = { username: "synthetic-strategy-reader", displayName: "Synthetic strategy reader", role: "doctor", permissions: { ...DEFAULT_DOCTOR_PERMISSIONS } };
  props = { patientId: PATIENT_A, orthoCaseId: ids.orthoCaseId, referenceVisitId: 959761 };
  requests = []; unexpected = []; sequence = 0; confirmLeave.mockReset(); confirmLeave.mockReturnValue(false);
  vi.useFakeTimers(); vi.stubGlobal("window", { confirm: confirmLeave });
  vi.stubGlobal("crypto", { randomUUID: () => `synthetic-strategy-nonce-${++sequence}` });
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (!/^\/api\/(ortho\/\d+\/strategy(?:\?revisionId=\d+)?|patients\/\d+\/(cases|problems))$/.test(url)) {
      unexpected.push(`${init?.method ?? "GET"} ${url}`); return Promise.reject(new Error("Unexpected request"));
    }
    const head = deferred<Response>(), body = deferred<unknown>(), json = vi.fn(() => body.promise);
    requests.push({ url, init, json, headers: (status = 200) => head.resolve({ status, ok: status >= 200 && status < 300,
      redirected: false, json } as unknown as Response), body: body.resolve, fail: () => head.reject(new TypeError("Synthetic interruption")) });
    // Deliberately ignore AbortSignal; stale completion must be ignored by owner checks.
    return head.promise;
  }));
});
afterEach(() => { unmount(); try { expect(unexpected).toEqual([]); expect(hooks.retiredWrites).toBe(0); } finally { vi.unstubAllGlobals(); vi.useRealTimers(); } });

describe("Ortho strategy owner-bound component contract", () => {
  it("never shows loading/failed reads as a blank editable strategy and keeps Visit read-only", async () => {
    render(); expect(content(render())).toContain("جارٍ التحقق"); expect(writes()).toEqual([]);
    await answer(strategyHistory(PATIENT_A));
    expect(find(node => node.props["data-testid"] === "ortho-strategy-reference")).toHaveLength(1);
    expect(content(render())).toContain(STRATEGY_TEXT.a.strategy);
    expect(find(node => node.type === "textarea")).toEqual([]);
    expect(find(node => node.type === "button" && /بدء خطة|فتح مراجعة|حفظ|ربط هذه|المشكلة في/.test(content(node)))).toEqual([]);
    selectHistory(ids.revision1); expect(gets().at(-1)?.url).toBe(`/api/ortho/${ids.orthoCaseId}/strategy?revisionId=${ids.revision1}`);
    await answer(strategyHistory(PATIENT_A, "a", 1)); expect(writes()).toEqual([]);
    click("تحديث سجل الخطة"); await answer({ message: "فشل اصطناعي" }, gets().at(-1), 500);
    expect(find(node => node.props.role === "alert")).toHaveLength(1);
    expect(content(render())).not.toContain(STRATEGY_TEXT.a.objective); expect(content(render())).not.toContain("لا توجد نسخة موثّقة");
    expect(writes()).toEqual([]);
  });

  it.each(["patient", "case", "principal", "permission", "visit", "lifetime"] as const)("retires a held A response body after %s identity changes, including A→B→A", async kind => {
    const firstLife = life(); props = { ...props, lifetime: firstLife };
    render(); const pending = gets()[0]; pending.headers(); await flush(); expect(pending.json).toHaveBeenCalledOnce();
    const originalProps = props, originalSession = hooks.session;
    if (kind === "patient") props = { ...props, patientId: PATIENT_B };
    else if (kind === "case") props = { ...props, orthoCaseId: STRATEGY_IDS.b.orthoCaseId };
    else if (kind === "principal") hooks.session = { ...hooks.session!, username: "synthetic-other-reader" };
    else if (kind === "permission") hooks.session = { ...hooks.session!, permissions: { ...hooks.session!.permissions!, canViewPlans: false } };
    else if (kind === "visit") props = { ...props, referenceVisitId: 959762 };
    else props = { ...props, lifetime: life() };
    render(); expect(gets()).toHaveLength(2);
    props = originalProps; hooks.session = originalSession; render(); expect(gets()).toHaveLength(3);
    expect((pending.init?.signal as AbortSignal).aborted).toBe(true);
    await answer(emptyStrategy(PATIENT_A));
    pending.body(strategyHistory(PATIENT_A)); await flush();
    expect(content(render())).toContain("لا توجد نسخة موثّقة"); expect(content(render())).not.toContain(STRATEGY_TEXT.a.strategy);
    expect(writes()).toEqual([]);
  });

  it("does not carry A's selected historical revision into B's initial read", async () => {
    props = { ...props, lifetime: life() }; render(); await answer(strategyHistory(PATIENT_A));
    selectHistory(ids.revision1); await answer(strategyHistory(PATIENT_A, "a", 1));
    props = { patientId: PATIENT_B, orthoCaseId: STRATEGY_IDS.b.orthoCaseId, lifetime: life() }; render();
    expect(gets().at(-1)?.url).toBe(`/api/ortho/${STRATEGY_IDS.b.orthoCaseId}/strategy`);
    await answer(emptyStrategy(PATIENT_B, "b")); click("بدء خطة الحالة من نموذج فارغ");
    expect(find(node => node.type === "input" && node.props.type === "search").map(node => node.props.value)).toEqual(["", ""]);
    expect(content(render())).not.toContain(STRATEGY_TEXT.a.strategy); expect(writes()).toEqual([]);
  });

  it("retires A's actual search strings and rejected-write status before B opens a draft", async () => {
    const first = life(); props = { ...props, lifetime: first }; render(); await answer(emptyStrategy(PATIENT_A));
    click("بدء خطة الحالة من نموذج فارغ");
    const searches = find(node => node.type === "input" && node.props.type === "search"); expect(searches).toHaveLength(2);
    for (const search of searches) (search.props.onChange as (event: unknown) => void)({ target: { value: "A-PRIVATE-SEARCH" } });
    const next = JSON.parse(first.values.document) as { reason: string; rows: Array<Record<string, unknown>> };
    next.reason = "سبب صريح"; next.rows[0] = { ...next.rows[0], problemId: ids.problemId };
    first.change("document", JSON.stringify(next)); render(); click("حفظ نسخة خطة الحالة");
    expect(writes()).toHaveLength(1); await answer({ message: "A-PRIVATE-REJECTED-STATUS" }, writes()[0], 409);
    expect(content(render())).toContain("A-PRIVATE-REJECTED-STATUS");
    first.live = false; props = { patientId: PATIENT_B, orthoCaseId: STRATEGY_IDS.b.orthoCaseId, lifetime: life() };
    render(); expect(content(render())).not.toContain("A-PRIVATE-REJECTED-STATUS");
    await answer(emptyStrategy(PATIENT_B, "b")); click("بدء خطة الحالة من نموذج فارغ");
    expect(find(node => node.type === "input" && node.props.type === "search").map(node => node.props.value)).toEqual(["", ""]);
    expect(content(render())).not.toMatch(/A-PRIVATE|مشكلة تقويم اصطناعية أ/); expect(writes()).toHaveLength(1);
  });

  it("times out a held JSON body without accepting a late success or inventing empty history", async () => {
    render(); const pending = gets()[0]; pending.headers(); await flush();
    await vi.advanceTimersByTimeAsync(15_001); render();
    expect(find(node => node.props.role === "alert")).toHaveLength(1);
    pending.body(strategyHistory(PATIENT_A)); await flush();
    expect(content(render())).not.toContain(STRATEGY_TEXT.a.strategy); expect(content(render())).not.toContain("لا توجد نسخة موثّقة");
    expect((pending.init?.signal as AbortSignal).aborted).toBe(true); expect(writes()).toEqual([]);
  });

  it("requires server canRevise before copying linked current history and never clears hidden links to edit", async () => {
    const lifetime = life(); props = { ...props, lifetime }; render(); await answer(restrictedStrategy(PATIENT_A));
    expect(button("فتح مراجعة جديدة من النسخة الحالية").props.disabled).toBe(true);
    expect(lifetime.values.document).toBe(""); expect(content(render())).not.toContain(STRATEGY_TEXT.a.service);
    expect(content(render())).not.toContain(String(ids.planItemId));
    click("تحديث سجل الخطة"); const source = strategyHistory(PATIENT_A); source.canRevise = false;
    await answer(source); expect(button("فتح مراجعة جديدة من النسخة الحالية").props.disabled).toBe(true);
    expect(lifetime.values.document).toBe(""); expect(writes()).toEqual([]);
  });

  it("retires a pending POST result with its old adapter and cannot settle B from A's saved response", async () => {
    const first = life(); props = { ...props, lifetime: first }; render(); await answer(emptyStrategy(PATIENT_A));
    click("بدء خطة الحالة من نموذج فارغ");
    const next = JSON.parse(first.values.document) as { commandId: string; expectedRevisionId: null; reason: string; rows: Array<Record<string, unknown>> };
    next.reason = "سبب صريح"; next.rows[0] = { ...next.rows[0], problemId: ids.problemId, objective: STRATEGY_TEXT.a.objective,
      strategy: STRATEGY_TEXT.a.strategy, rationale: "", planItemIds: [] }; first.change("document", JSON.stringify(next)); render();
    click("حفظ نسخة خطة الحالة"); expect(writes()).toHaveLength(1); const sent = writes()[0];
    first.live = false; const second = life(); props = { patientId: PATIENT_B, orthoCaseId: STRATEGY_IDS.b.orthoCaseId, lifetime: second };
    render(); await answer(emptyStrategy(PATIENT_B, "b"));
    sent.headers(201); sent.body({ ok: true, replayed: false, revision: savedStrategy(PATIENT_A) }); await flush();
    expect(second.values.document).toBe(""); expect(second.settlements).toEqual([]);
    expect(content(render())).not.toContain("حُفظ التوثيق"); expect(content(render())).not.toContain(STRATEGY_TEXT.a.objective);
    expect(writes()).toHaveLength(1);
  });

  it("settles only the confirmed document after its view unmounts while the JSON body is pending", async () => {
    const lifetime = life(); props = { ...props, lifetime }; render(); await answer(emptyStrategy(PATIENT_A));
    click("بدء خطة الحالة من نموذج فارغ");
    const revision = savedStrategy(PATIENT_A);
    const next = JSON.parse(lifetime.values.document) as { reason: string; rows: Array<Record<string, unknown>> };
    next.reason = revision.reason; next.rows[0] = { ...next.rows[0], problemId: ids.problemId,
      objective: STRATEGY_TEXT.a.objective, strategy: STRATEGY_TEXT.a.strategy,
      rationale: STRATEGY_TEXT.a.rationale, planItemIds: [ids.planItemId] };
    lifetime.change("document", JSON.stringify(next)); lifetime.change("problemLabel", "مشكلة أخرى لم تُحفظ");
    lifetime.change("problemSite", "موضع آخر لم يُحفظ"); render();
    click("حفظ نسخة خطة الحالة"); const sent = writes()[0], settlementsBefore = lifetime.settlements.length;
    expect(writes()).toHaveLength(1); sent.headers(201); await flush(); expect(sent.json).toHaveBeenCalledOnce();
    const readCount = gets().length;
    // Only presentation retires. The same owner, draft and mutation still live.
    lifetime.attached = false; unmount(); expect(lifetime.live).toBe(true); expect(lifetime.busy).toBe(true);
    sent.body({ ok: true, replayed: false, revision }); await drain();
    expect(hooks.retiredWrites).toBe(0); expect(scopes.size).toBe(0);
    expect(lifetime.busy).toBe(false); expect(lifetime.uncertain).toBe(false);
    expect(lifetime.settlements.slice(settlementsBefore)).toEqual(["document"]);
    expect(lifetime.values).toEqual({ document: "", problemLabel: "مشكلة أخرى لم تُحفظ", problemSite: "موضع آخر لم يُحفظ" });
    expect(lifetime.dirty).toBe(true); expect(gets()).toHaveLength(readCount); expect(writes()).toHaveLength(1);
    lifetime.attached = true; render();
    const ready = emptyStrategy(PATIENT_A); ready.revision = revision;
    ready.history = [{ revisionId: revision.revisionId, version: revision.version, recordedPatientId: revision.recordedPatientId,
      supersedesRevisionId: revision.supersedesRevisionId, recordingContext: revision.recordingContext,
      createdAt: revision.createdAt, createdBy: revision.createdBy, reason: revision.reason }];
    await answer(ready);
    expect(find(node => node.props["data-testid"] === "ortho-strategy-draft")).toHaveLength(0);
    expect(content(render())).toContain(STRATEGY_TEXT.a.strategy);
    expect(find(node => node.type === "input").map(node => node.props.value)).toEqual(["مشكلة أخرى لم تُحفظ", "موضع آخر لم يُحفظ"]);
    expect(lifetime.dirty).toBe(true); expect(writes()).toHaveLength(1);
  });

  it.each(["malformed-body", "server-error"] as const)("freezes the same detached draft after a hidden %s without retired state writes or resend", async outcome => {
    const lifetime = life(); props = { ...props, lifetime }; render(); await answer(emptyStrategy(PATIENT_A));
    click("بدء خطة الحالة من نموذج فارغ");
    const next = JSON.parse(lifetime.values.document) as { reason: string; rows: Array<Record<string, unknown>> };
    next.reason = "سبب صريح"; next.rows[0] = { ...next.rows[0], problemId: ids.problemId, objective: STRATEGY_TEXT.a.objective };
    lifetime.change("document", JSON.stringify(next)); lifetime.change("problemLabel", "مشكلة غير محفوظة"); render();
    click("حفظ نسخة خطة الحالة"); expect(writes()).toHaveLength(1);
    const sent = writes()[0], before = { ...lifetime.values }, settlementsBefore = lifetime.settlements.length;
    const command = sent.init?.body;
    if (outcome === "malformed-body") { sent.headers(201); await flush(); expect(sent.json).toHaveBeenCalledOnce(); }
    lifetime.attached = false; unmount();
    if (outcome === "malformed-body") sent.body({ ok: true, replayed: false, revision: null });
    else { sent.headers(500); sent.body({ message: "نتيجة مخفية غير مؤكدة" }); }
    await drain();
    expect(hooks.retiredWrites).toBe(0); expect(scopes.size).toBe(0);
    expect(lifetime.live).toBe(true); expect(lifetime.busy).toBe(false); expect(lifetime.uncertain).toBe(true);
    expect(lifetime.values).toEqual(before); expect(lifetime.dirty).toBe(true);
    expect(lifetime.settlements).toHaveLength(settlementsBefore); expect(writes()).toHaveLength(1);
    lifetime.attached = true; render(); await answer(emptyStrategy(PATIENT_A));
    expect(button("حفظ نسخة خطة الحالة").props.disabled).toBe(true);
    expect(button("إلغاء مسودة الخطة").props.disabled).toBe(true);
    expect(content(render())).toContain("نتيجة الطلب السابق غير مؤكدة");
    click("تحديث سجل الخطة"); await answer(emptyStrategy(PATIENT_A));
    expect(lifetime.values).toEqual(before); expect(writes()).toHaveLength(1); expect(writes()[0].init?.body).toBe(command);
  });
});
