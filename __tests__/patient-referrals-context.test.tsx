import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientReferrals } from "../components/PatientReferrals";
import type { Referral } from "../lib/referrals";
// Actual leaf handlers with synthetic hook storage/fetch, not browser acceptance.
const hooks = vi.hoisted(() => ({
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


type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
let patientId = 11;
const fetchMock = vi.fn();
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
const referral = (id: number, patient: number): Referral => ({
  id, patientId: patient, toName: `Synthetic receiver ${id}`, reason: `Synthetic reason ${id}`,
  toSpecialty: "endodontics", urgency: "routine", status: "sent", kind: "internal",
  workflowState: "requested", toPartyId: 2, doctorPartyId: 1,
  createdAt: "2026-01-01T08:00:00Z", teeth: null, outcomeNote: null,
  doctorName: "Synthetic referrer", createdBy: "synthetic-doctor", closedBy: null, closedAt: null,
  caseId: null, caseTitle: null, blocksCaseId: null, planItemId: null, requestedServiceId: null,
  returnToPartyId: 1, appointmentId: null, appointmentDate: null, acceptedAt: null,
  completedBy: null, completedAt: null, returnedAt: null, procedurePerformed: null,
  followupRequired: null, mayReturn: null, missedAppointment: null,
});
function render() {
  let tree: ReturnType<typeof PatientReferrals> | null = null;
  for (let round = 0; round < 20; round++) {
    hooks.cursor = 0; hooks.changed = false; hooks.pending = [];
    tree = PatientReferrals({ patientId, canIssue: true });
    if (hooks.changed) continue;
    hooks.pending.splice(0).forEach(effect => effect());
    if (!hooks.changed) return tree;
  }
  throw new Error("Referral component did not settle");
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); return render(); }
const click = (label: string) => {
  const button = nodes(render()).find(node => node.type === "button" && text(node) === label);
  if (!button) throw new Error(`Missing button ${label}`);
  return (button.props.onClick as () => unknown)();
};
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  patientId = 11; fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (url: string) => response(url.includes("/parties") ? [] : [referral(patientId, patientId)]));
});
afterEach(() => { hooks.effects.forEach(effect => effect.cleanup?.()); vi.unstubAllGlobals(); });
describe("PatientReferrals patient context", () => {
  it("retires the previous patient's selected transition immediately", async () => {
    render(); await flush(); click("قبول");
    expect(text(render())).toContain("تأكيد");
    patientId = 22;
    const tree = render();
    expect(text(tree)).not.toContain("Synthetic reason 11");
    expect(text(tree)).not.toContain("تأكيد");
    await flush(); expect(text(render())).toContain("Synthetic reason 22");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toEqual([]);
  });
  it("does not carry a new-referral draft to another patient", async () => {
    render(); await flush(); click("+ إحالة جديدة"); click("داخل المركز");
    expect(text(render())).toContain("إرسال الإحالة للزميل");
    patientId = 22; render(); await flush();
    expect(text(render())).not.toContain("إرسال الإحالة للزميل");
  });
  it("ignores an old patient read that completes after the new read", async () => {
    const old = deferred<ReturnType<typeof response>>();
    fetchMock.mockImplementation(async (url: string) => url.includes("/11/") ? old.promise : response(url.includes("/parties") ? [] : [referral(22, 22)]));
    render(); patientId = 22; render(); await flush();
    old.resolve(response([referral(11, 11)])); await flush();
    expect(text(render())).toContain("Synthetic reason 22");
    expect(text(render())).not.toContain("Synthetic reason 11");
  });
  it("does not let an old confirmation mutate after navigation", async () => {
    render(); await flush(); click("قبول");
    const confirm = nodes(render()).find(node => node.type === "button" && text(node) === "تأكيد")!;
    patientId = 22; render(); await flush();
    await (confirm.props.onClick as () => unknown)(); await flush();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toEqual([]);
  });
  it("preserves an ordinary same-patient draft across rerenders", async () => {
    render(); await flush(); click("+ إحالة جديدة"); click("داخل المركز");
    render(); render();
    expect(text(render())).toContain("إرسال الإحالة للزميل");
  });
  it("allows only one in-flight confirmation even before a rerender", async () => {
    const pending = deferred<ReturnType<typeof response>>();
    render(); await flush(); click("قبول");
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => init?.method ? pending.promise : Promise.resolve(response([referral(11, 11)])));
    const confirm = nodes(render()).find(node => node.type === "button" && text(node) === "تأكيد")!;
    const action = confirm.props.onClick as () => unknown;
    action(); action();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
    pending.resolve(response({})); await flush();
    expect(text(render())).not.toContain("تأكيد");
  });
  it.each([true, false])("ignores retired mutation completion (success=%s) without closing the new draft", async (ok) => {
    const pending = deferred<ReturnType<typeof response>>();
    render(); await flush(); click("قبول");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => init?.method ? pending.promise : response(url.includes("/parties") ? [] : [referral(patientId, patientId)]));
    click("تأكيد"); patientId = 22; render(); await flush();
    click("+ إحالة جديدة"); click("داخل المركز");
    const calls = fetchMock.mock.calls.length;
    pending.resolve(response({ message: "Retired refusal" }, ok)); await flush();
    expect(text(render())).toContain("إرسال الإحالة للزميل");
    expect(text(render())).toContain("Synthetic reason 22");
    expect(text(render())).not.toContain("Retired refusal");
    expect(fetchMock.mock.calls).toHaveLength(calls);
  });
  it("does not resurrect the first read after A → B → A", async () => {
    const first = deferred<ReturnType<typeof response>>(); let readsA = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/11/") && ++readsA === 1) return first.promise;
      return response(url.includes("/parties") ? [] : [referral(patientId === 11 ? 33 : 22, patientId)]);
    });
    render(); patientId = 22; render(); await flush(); patientId = 11; render(); await flush();
    first.resolve(response([referral(11, 11)])); await flush();
    expect(text(render())).toContain("Synthetic reason 33");
    expect(text(render())).not.toContain("Synthetic reason 11");
  });
  it("retires captured mutation handlers on unmount", async () => {
    render(); await flush(); click("قبول");
    const confirm = nodes(render()).find(node => node.type === "button" && text(node) === "تأكيد")!;
    hooks.effects.forEach(effect => effect.cleanup?.());
    await (confirm.props.onClick as () => unknown)();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toEqual([]);
  });

});
