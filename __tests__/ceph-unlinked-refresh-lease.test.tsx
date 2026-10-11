import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CephUnlinkedStudiesPanel } from "../components/CephUnlinkedStudiesPanel";

// Execute the actual panel and its captured handlers. Only hook storage and the
// transport are synthetic; the built-browser suite covers native disabled input.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  pending: [] as Array<() => void>,
}));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = slot(initial);
      return [hooks.values[index], (update: unknown) => {
        const next = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined), previous = hooks.effects.get(index);
      if (previous?.deps && deps && previous.deps.length === deps.length
        && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
      hooks.pending.push(() => {
        previous?.cleanup?.(); const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
});
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
let props: ComponentProps<typeof CephUnlinkedStudiesPanel>;
let lease: { active: boolean };
const fetchMock = vi.fn(), linked = vi.fn(), refresh = vi.fn();
function render() {
  let tree: ReturnType<typeof CephUnlinkedStudiesPanel> = null, count = 0;
  do {
    if (++count > 20) throw new Error("Ceph unlinked panel did not settle");
    hooks.cursor = 0; hooks.changed = false; tree = CephUnlinkedStudiesPanel(props);
    hooks.pending.splice(0).forEach(effect => effect());
  } while (hooks.changed);
  return tree;
}
const buttons = (label: string) => nodes(render()).filter(node => node.type === "button" && text(node) === label);
const button = (label: string) => { const found = buttons(label)[0]; if (!found) throw new Error(`Missing button: ${label}`); return found; };
const check = () => { const found = nodes(render()).find(node => node.type === "input" && node.props.type === "checkbox"); if (!found) throw new Error("Missing confirmation checkbox"); return found; };
const click = (label: string) => (button(label).props.onClick as () => void)();
const tick = () => (check().props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); render(); }
const freshLease = () => { lease = { active: true }; const current = lease; props = { ...props, refreshing: false, canReview: () => current.active }; };
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.effects.clear(); hooks.pending = [];
  fetchMock.mockReset(); linked.mockReset(); refresh.mockReset();
  props = { patientId: 11, orthoCaseId: 21, authority: "synthetic-admin", refreshing: false, canReview: () => false,
    studies: [{ id: 61, phase: "pretreatment", status: "completed", xrayDate: "2026-01-01" },
      { id: 62, phase: "during", status: "completed", xrayDate: null }], onLinked: linked, onRefresh: refresh };
  freshLease(); vi.stubGlobal("fetch", fetchMock); render();
});
afterEach(() => { hooks.effects.forEach(effect => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe("Ceph unlinked panel current-read lease", () => {
  it("refuses captured review and refresh handlers immediately, and never revives an old lease after a fresh read", () => {
    const open = button("ربط بهذه الحالة").props.onClick as () => void;
    const reload = button("تحديث القائمة").props.onClick as () => void;
    lease.active = false; // before the parent has painted refreshing=true
    open(); reload();
    expect(nodes(render()).some(node => node.type === "input")).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    props = { ...props, refreshing: true };
    expect(button("ربط بهذه الحالة").props.disabled).toBe(true);
    freshLease(); render(); open(); reload();
    expect(nodes(render()).some(node => node.type === "input")).toBe(false);
    click("ربط بهذه الحالة"); expect(check().props.checked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  });

  it("admits a fresh owner activated at layout commit without requiring another render", () => {
    lease.active = false;
    const open = button("ربط بهذه الحالة");
    expect(open.props.disabled).toBe(false); // accepted read, owner not committed yet
    (open.props.onClick as () => void)();
    expect(nodes(render()).some(node => node.type === "input")).toBe(false);
    lease.active = true; // parent layout activation; no intervening panel render
    (open.props.onClick as () => void)();
    expect(check().props.checked).toBe(false); expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps reviewed data inert during refresh, refuses all captured actions and cancels changed data before a fresh explicit retry", async () => {
    click("ربط بهذه الحالة"); tick();
    const oldCheck = check().props.onChange as (event: { target: { checked: boolean } }) => void;
    const oldConfirm = button("تأكيد الربط").props.onClick as () => void;
    const oldOpen = button("ربط بهذه الحالة").props.onClick as () => void;
    lease.active = false; props = { ...props, refreshing: true };
    expect(check().props.checked).toBe(true); expect(check().props.disabled).toBe(true);
    expect(button("تأكيد الربط").props.disabled).toBe(true);
    expect(button("تحديث القائمة").props.disabled).toBe(true);
    expect(button("ربط بهذه الحالة").props.disabled).toBe(true);
    expect(button("إلغاء").props.disabled).toBe(false);
    oldCheck({ target: { checked: false } }); oldConfirm(); oldOpen(); click("تحديث القائمة");
    expect(check().props.checked).toBe(true); expect(fetchMock).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
    props = { ...props, studies: props.studies.map(study => study.id === 61 ? { ...study, phase: "followup" as const } : study) };
    freshLease(); render();
    expect(text(render())).toContain("تغيّرت الدراسة أثناء المراجعة");
    expect(nodes(render()).some(node => node.type === "input")).toBe(false);
    oldCheck({ target: { checked: true } }); oldConfirm(); oldOpen();
    expect(nodes(render()).some(node => node.type === "input")).toBe(false); expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    click("ربط بهذه الحالة"); expect(text(render())).toContain("ما راجعتَه: المتابعة والاستبقاء (T4)");
    tick(); click("تأكيد الربط"); await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/ceph/61/link-case");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ orthoCaseId: 21, confirm: true,
      expected: { phase: "followup", xrayDate: "2026-01-01", status: "completed" } });
    expect(linked).toHaveBeenCalledTimes(1);
  });

  it.each(["server", "transport"] as const)("retains checked confirmation after a %s failure and allows ordinary cancellation", async failure => {
    if (failure === "server") fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "تعذّر ربط الدراسة بالحالة." }), { status: 500 }));
    else fetchMock.mockRejectedValue(new Error("synthetic transport refusal"));
    click("ربط بهذه الحالة"); tick(); click("تأكيد الربط"); await settle();
    expect(check().props.checked).toBe(true); expect(button("تأكيد الربط").props.disabled).toBe(false);
    expect(text(render())).toContain(failure === "server" ? "تعذّر ربط الدراسة بالحالة." : "قد يكون الطلب نُفّذ");
    expect(linked).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(1);
    lease.active = false; props = { ...props, refreshing: true }; click("إلغاء");
    expect(nodes(render()).some(node => node.type === "input")).toBe(false); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a successful old response after case A → B → A instead of refreshing or announcing success for the new owner", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>(done => { resolve = done; }));
    click("ربط بهذه الحالة"); tick(); click("تأكيد الربط");
    lease.active = false; props = { ...props, orthoCaseId: 22 }; freshLease(); render();
    lease.active = false; props = { ...props, orthoCaseId: 21 }; freshLease(); render();
    resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })); await settle();
    expect(linked).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
    expect(text(render())).not.toContain("تم ربط الدراسة");
    expect(nodes(render()).some(node => node.type === "input")).toBe(false); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
