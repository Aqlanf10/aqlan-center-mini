import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../components/SessionProvider";
import { OrthoCaseReopen, type OrthoReopenLifetime, type ReopenDraft, type ReopenExpectation } from "../components/OrthoCaseReopen";
import type { OrthoLifecycleSnapshot } from "../lib/ortho-reopen-contract";
import { canonicalJourneyJSON } from "../lib/ortho-case-journey-json";
// Actual component and WebCrypto receipt binding; hooks/network/lifetime are synthetic.
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

vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const textOf = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" && "props" in node ? textOf((node as Element).props.children as ReactNode) : "";
const scope = { patientId: 1, orthoCaseId: 2, clinicalCaseId: 3 };
let props: { patientId: number; orthoCaseId: number }, state: ReopenDraft, lifecycle: OrthoLifecycleSnapshot;
let active: boolean, busy: boolean, uncertain: boolean, ownerViewAvailable: boolean, outerKey: string | null;
const changed = vi.fn(), fetchMock = vi.fn(), denied = vi.fn();
let lifetime: OrthoReopenLifetime;
const ok = (body: unknown, status = 200) => ({ ok: true, status, json: async () => body });
const reading = (patch: Record<string, unknown> = {}) => ({ ok: true, scope, actorId: 7, current: lifecycle, history: [], next: null, receipt: null, ...patch });
async function saved(expected: ReopenExpectation) {
  const command = expected.command;
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJourneyJSON(command)))), byte => byte.toString(16).padStart(2, "0")).join("");
  return { id: 10, commandId: command.clientRequestId, requestFingerprint: digest, actorId: 7, createdBy: "Synthetic doctor", createdAt: "2026-11-10T00:00:00.000Z",
    reason: command.reason, before: { ...lifecycle, version: command.expectedLifecycleVersion, status: command.expectedStatus }, afterVersion: command.expectedLifecycleVersion + 1, targetStatus: command.targetStatus };
}
function retire() {
  hooks.effects.forEach(effect => effect.cleanup?.()); hooks.values.length = 0; hooks.effects.clear(); hooks.memos.clear(); hooks.pending.length = 0; outerKey = null;
}
function render(): ReactNode {
  if (!ownerViewAvailable) { retire(); return null; }
  for (let round = 0; round < 30; round++) {
    hooks.cursor = 0; hooks.changed = false;
    const wrapper = OrthoCaseReopen({ ...props, lifetime, onChanged: changed });
    if (!wrapper) { retire(); return null; }
    if (outerKey !== wrapper.key) { retire(); outerKey = wrapper.key; }
    const tree = (wrapper.type as (input: unknown) => ReactNode)(wrapper.props); hooks.pending.splice(0).forEach(effect => effect());
    if (!hooks.changed) return tree;
  }
  throw Error("Reopen did not settle");
}
const flush = async () => { for (let index = 0; index < 10; index++) { await new Promise(resolve => setTimeout(resolve, 0)); render(); } };
const button = (label: string) => { const value = nodes(render()).find(node => node.type === "button" && textOf(node) === label); if (!value) throw Error(`Missing button ${label}`); return value; };
const click = (label: string) => { const value = button(label); expect(value.props.disabled).not.toBe(true); (value.props.onClick as () => void)(); render(); };
const open = async () => { const node = nodes(render()).find(node => node.type === "details")!; (node.props.onToggle as (event: unknown) => void)({ currentTarget: { open: true } }); render(); await flush(); };
const input = (label: string, value: string) => { const field = nodes(render()).find(node => node.props["aria-label"] === label)!;
  (field.props.onChange as (event: unknown) => void)({ target: { value } }); render(); };
const review = () => { const box = nodes(render()).find(node => node.type === "input" && node.props.type === "checkbox")!;
  (box.props.onChange as (event: unknown) => void)({ target: { checked: true } }); render(); };
const submit = "تأكيد إعادة فتح حالة التقويم", retry = "إعادة نفس طلب فتح حالة التقويم";
const posts = () => fetchMock.mock.calls.filter(([, init]) => init.method === "POST");
async function prepare(target = "active") { await open(); input("الحالة المقصودة لإعادة فتح التقويم", target); input("سبب إعادة فتح حالة التقويم", "سبب اصطناعي موثق"); review(); }
beforeEach(() => {
  retire(); props = { patientId: 1, orthoCaseId: 2 }; active = true; busy = false; uncertain = false; ownerViewAvailable = true;
  state = { expanded: false, reason: "", target: "", review: null, pending: null, lastReceipt: null };
  lifecycle = { version: 0, status: "completed", phase: "finishing", closedAt: null, closedBy: null, closedNote: null };
  changed.mockReset(); denied.mockReset().mockImplementation(() => { active = false; });
  hooks.session = { userId: 7, username: "Synthetic", role: "doctor", permissions: null };
  lifetime = { identity: {}, read: () => state, active: () => active, editable: () => active && !busy && !uncertain,
    get busy() { return busy; }, deny: denied,
    change: (field, value) => { if (active && !busy && !uncertain) { state = { ...state, [field]: value }; hooks.changed = true; } },
    commit: values => { if (active) { state = { ...state, ...values }; hooks.changed = true; } },
    resolve: (expected, receipt) => {
      if (!active || canonicalJourneyJSON(state.pending) !== canonicalJourneyJSON(expected)) return false;
      uncertain = false; state = receipt ? { ...state, reason: "", target: "", review: null, pending: null, lastReceipt: receipt } : { ...state, pending: null, review: null };
      hooks.changed = true; return true;
    },
    begin: isRetry => {
      if (!active || busy || isRetry !== uncertain) return null; busy = true; hooks.changed = true; let live = true;
      return { current: () => live && active, uncertain: () => { uncertain = true; hooks.changed = true; }, finish: () => { live = false; busy = false; hooks.changed = true; } };
    },
  };
  fetchMock.mockReset().mockImplementation(async () => ok(reading())); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { retire(); vi.unstubAllGlobals(); });

describe("explicit same-case orthodontic reopening", () => {
  it.each(["reception", "assistant"])("hides closure history and controls from %s without reading", role => {
    hooks.session = { ...hooks.session!, role }; expect(render()).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("loads only when opened, preserves unknown closure facts and never preselects a target", async () => {
    render(); expect(fetchMock).not.toHaveBeenCalled(); await open(); expect(posts()).toHaveLength(0);
    expect(textOf(render())).toContain("تاريخ الإغلاق غير مسجل"); expect(state.target).toBe("");
    const options = nodes(render()).filter(node => node.type === "option").map(node => node.props.value);
    expect(options).toEqual(["", "active", "retention"]); expect(button(submit).props.disabled).toBe(true);
  });
  it("requires explicit assessment selection, reason and review even when only one target is compatible", async () => {
    lifecycle = { ...lifecycle, status: "discontinued", phase: "assessment" }; await open();
    expect(nodes(render()).filter(node => node.type === "option").map(node => node.props.value)).toEqual(["", "assessment"]);
    input("الحالة المقصودة لإعادة فتح التقويم", "assessment"); review(); click(submit); await flush();
    expect(posts()).toHaveLength(0); expect(textOf(render())).toContain("اكتب سببًا واضحًا");
    input("سبب إعادة فتح حالة التقويم", "سبب اصطناعي لتقييم جديد");
    fetchMock.mockImplementation(async () => { const row = await saved(state.pending!); return ok({ ok: true, scope, actorId: 7, receipt: row,
      current: { ...lifecycle, version: 1, status: "assessment", closedAt: null, closedBy: null, closedNote: null }, replayed: false }, 201); });
    click(submit); await flush(); expect(posts()).toHaveLength(1);
    const body = JSON.parse(posts()[0][1].body); expect(Object.keys(body)).toEqual(["patientId", "clinicalCaseId", "command"]);
    expect(body.command).toMatchObject({ expectedStatus: "discontinued", expectedLifecycleVersion: 0, targetStatus: "assessment" });
    expect(body.command).not.toHaveProperty("phase"); expect(state.pending).toBeNull(); expect(state.reason).toBe(""); expect(changed).toHaveBeenCalledTimes(1);
  });
  it("blocks double submit, keeps an immutable lost-response command and treats replay separately from later closure", async () => {
    await prepare(); let reject!: (error: Error) => void;
    fetchMock.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const handler = button(submit).props.onClick as () => void; handler(); handler(); render(); expect(posts()).toHaveLength(1);
    const body = posts()[0][1].body, expected = state.pending!; expect(Object.isFrozen(expected.command)).toBe(true);
    reject(Error("Synthetic lost response")); await flush(); expect(uncertain).toBe(true); expect(state.pending).toBe(expected);
    const row = await saved(expected); lifecycle = { ...lifecycle, version: 2, status: "completed", closedNote: "إغلاق اصطناعي لاحق" };
    fetchMock.mockImplementation(async () => ok({ ok: true, scope, actorId: 7, receipt: row, current: lifecycle, replayed: true }));
    click(retry); await flush(); expect(posts()[1][1].body).toBe(body); expect(state.pending).toBeNull();
    expect(textOf(render())).toContain("لا يعني أن حالة التقويم ما زالت مفتوحة"); expect(textOf(render())).toContain("إغلاق اصطناعي لاحق");
    expect(changed).toHaveBeenCalledTimes(1); expect(posts()).toHaveLength(2);
    retire(); fetchMock.mockRejectedValueOnce(Error("Synthetic unreadable current lifecycle")); await open();
    expect(textOf(render())).toContain("ليس إثباتًا للحالة الحالية"); expect(textOf(render())).not.toContain("القراءة المعروضة أعلاه");
  });
  it("uses GET requestId to recover a verified receipt without replaying any mutation", async () => {
    await prepare(); fetchMock.mockRejectedValueOnce(Error("Synthetic lost response")); click(submit); await flush();
    const expected = state.pending!, row = await saved(expected);
    fetchMock.mockImplementation(async () => ok(reading({ receipt: row, current: { ...lifecycle, version: 1, status: "active" } })));
    click("التحقق من نتيجة الطلب وقراءة الحالة الحالية"); await flush();
    expect(fetchMock.mock.calls.at(-1)![0]).toContain(`requestId=${expected.command.clientRequestId}`);
    expect(posts()).toHaveLength(1); expect(state.pending).toBeNull(); expect(uncertain).toBe(false); expect(changed).toHaveBeenCalledTimes(1);
  });
  it("restores the expanded panel after recovery refresh remount and obtains a fresh authoritative read", async () => {
    await prepare(); fetchMock.mockRejectedValueOnce(Error("Synthetic lost response")); click(submit); await flush();
    const expected = state.pending!, row = await saved(expected), sharedIdentity = lifetime.identity;
    fetchMock.mockImplementation(async () => ok(reading({ receipt: row, current: { ...lifecycle, version: 1, status: "active" } })));
    changed.mockImplementation(() => { active = false; ownerViewAvailable = false; retire(); });
    click("التحقق من نتيجة الطلب وقراءة الحالة الحالية"); await flush();
    expect(render()).toBeNull(); expect(changed).toHaveBeenCalledTimes(1); expect(state.pending).toBeNull();
    expect(state.lastReceipt).toEqual(row); expect(posts()).toHaveLength(1);
    const callCount = fetchMock.mock.calls.length;
    let resolve!: (response: unknown) => void;
    fetchMock.mockImplementation(() => new Promise(done => { resolve = done; }));
    active = true; ownerViewAvailable = true;
    const restored = render(); expect(lifetime.identity).toBe(sharedIdentity);
    expect(nodes(restored).find(node => node.type === "details")?.props.open).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(callCount + 1);
    expect(fetchMock.mock.calls.at(-1)![0]).not.toContain("requestId=");
    expect(nodes(restored).some(node => node.props["aria-label"] === "حالة التقويم الحالية")).toBe(false);
    expect(textOf(restored)).toContain("ليس إثباتًا للحالة الحالية");
    lifecycle = { ...lifecycle, version: 2, status: "completed", closedNote: "إغلاق أحدث بعد الاستعادة" };
    resolve(ok(reading())); await flush();
    expect(nodes(render()).some(node => node.props["aria-label"] === "حالة التقويم الحالية")).toBe(true);
    expect(textOf(render())).toContain("إغلاق أحدث بعد الاستعادة"); expect(posts()).toHaveLength(1);
    expect(changed).toHaveBeenCalledTimes(1); expect(fetchMock).toHaveBeenCalledTimes(callCount + 1);
    const details = nodes(render()).find(node => node.type === "details")!;
    (details.props.onToggle as (event: unknown) => void)({ currentTarget: { open: false } }); render();
    retire(); render(); await flush();
    expect(nodes(render()).find(node => node.type === "details")?.props.open).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(callCount + 1);
  });
  it("does not resolve a missing or mismatched recovery receipt", async () => {
    await prepare(); fetchMock.mockRejectedValueOnce(Error("Synthetic lost response")); click(submit); await flush();
    const expected = state.pending!;
    fetchMock.mockImplementation(async () => ok(reading())); click("التحقق من نتيجة الطلب وقراءة الحالة الحالية"); await flush();
    expect(state.pending).toBe(expected); expect(uncertain).toBe(true); expect(posts()).toHaveLength(1);
    const row = { ...await saved(expected), requestFingerprint: "b".repeat(64) };
    fetchMock.mockImplementation(async () => ok(reading({ receipt: row, current: { ...lifecycle, version: 1, status: "active" } })));
    click("التحقق من نتيجة الطلب وقراءة الحالة الحالية"); await flush(); expect(state.pending).toBe(expected);
    expect(changed).not.toHaveBeenCalled(); expect(uncertain).toBe(true);
  });
  it("preserves reason and target after stale rejection, refreshes without POST and requires a new review", async () => {
    await prepare(); fetchMock.mockImplementation(async () => ({ ok: false, status: 409, json: async () => ({ ok: false, code: "reopen_state_changed", message: "/private/raw" }) }));
    click(submit); await flush(); const first = JSON.parse(posts()[0][1].body).command;
    expect(state.reason).toBe(first.reason); expect(state.target).toBe("active"); expect(state.pending).toBeNull(); expect(state.review).toBeNull();
    expect(changed).not.toHaveBeenCalled(); expect(textOf(render())).not.toContain("/private/raw");
    lifecycle = { ...lifecycle, version: 2, closedNote: "إغلاق مراجع اصطناعي" };
    fetchMock.mockImplementation(async () => ok(reading())); click("تحديث حالة التقويم"); await flush();
    expect(button(submit).props.disabled).toBe(true); expect(state.reason).toBe(first.reason); expect(posts()).toHaveLength(1);
    review(); fetchMock.mockRejectedValueOnce(Error("Synthetic stop after command captured")); click(submit); await flush();
    const second = JSON.parse(posts()[1][1].body).command;
    expect(second.expectedLifecycleVersion).toBe(2); expect(second.clientRequestId).not.toBe(first.clientRequestId); expect(second.reason).toBe(first.reason);
  });
  it("requires renewed review after a phase-only change without inventing a replacement target", async () => {
    lifecycle = { ...lifecycle, status: "discontinued" }; await prepare();
    lifecycle = { ...lifecycle, phase: "assessment" }; fetchMock.mockImplementation(async () => ok(reading()));
    click("تحديث حالة التقويم"); await flush(); expect(state.target).toBe("active"); expect(state.reason).toBe("سبب اصطناعي موثق");
    expect(button(submit).props.disabled).toBe(true); expect(posts()).toHaveLength(0);
  });
  it.each(["role", "scope"])("ignores an in-flight read after %s retirement", async kind => {
    let resolve!: (value: unknown) => void; fetchMock.mockImplementation(() => new Promise(done => { resolve = done; }));
    await open(); const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    if (kind === "role") hooks.session = { ...hooks.session!, role: "reception" }; else props = { patientId: 9, orthoCaseId: 10 };
    render(); expect(signal.aborted).toBe(true); resolve(ok(reading())); await flush();
    expect(textOf(render())).not.toContain("تاريخ الإغلاق غير مسجل"); expect(posts()).toHaveLength(0);
  });
  it("denies the owner on server permission rejection without exposing history", async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 403, json: async () => ({ message: "/private/raw" }) })); await open();
    expect(denied).toHaveBeenCalledTimes(1); expect(textOf(render())).not.toContain("/private/raw"); expect(posts()).toHaveLength(0);
  });
});

