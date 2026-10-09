import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckoutExtras } from "../components/patient/CheckoutExtras";

type Frame = { values: unknown[]; cursor: number; effects: (() => void | (() => void))[]; cleanups: (() => void)[] };
const runtime = vi.hoisted(() => ({
  frame: null as Frame | null,
  session: { username: "front-a", role: "reception", permissions: null } as { username: string; role: string; permissions: unknown } | null,
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => runtime.session }));
vi.mock("../components/CollectPaymentModal", () => ({ CollectPaymentModal: () => null }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useState: (initial: unknown) => {
      const frame = runtime.frame!; const index = frame.cursor++;
      if (!(index in frame.values)) frame.values[index] = typeof initial === "function" ? initial() : initial;
      return [frame.values[index], (next: unknown) => { frame.values[index] = typeof next === "function" ? next(frame.values[index]) : next; }];
    },
    useRef: (initial: unknown) => {
      const frame = runtime.frame!; const index = frame.cursor++;
      if (!(index in frame.values)) frame.values[index] = { current: initial };
      return frame.values[index];
    },
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => void | (() => void)) => { runtime.frame!.effects.push(effect); },
  };
});

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
const props = (visitId: number, onChanged = vi.fn()) => ({ visitId, collected: false,
  suggestedDate: "2026-10-08", durationMinutes: 30, onChanged });
function mount(visitId: number, onChanged = vi.fn()) {
  const frame: Frame = { values: [], cursor: 0, effects: [], cleanups: [] };
  runtime.frame = frame;
  const owner = CheckoutExtras(props(visitId, onChanged)) as ReactElement;
  const tree = (owner.type as (input: unknown) => ReactElement)(owner.props);
  for (const effect of frame.effects) { const cleanup = effect(); if (cleanup) frame.cleanups.push(cleanup); }
  return { owner, tree, frame, unmount: () => { for (const cleanup of frame.cleanups) cleanup(); } };
}
beforeEach(() => { vi.useFakeTimers(); runtime.session = { username: "front-a", role: "reception", permissions: null }; });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("checkout visit/principal ownership", () => {
  it("remounts all form/read/collection state across visit, principal, and permission changes", () => {
    const first = CheckoutExtras(props(1)) as ReactElement;
    const otherVisit = CheckoutExtras(props(2)) as ReactElement;
    expect(first.key).not.toBe(otherVisit.key);
    runtime.session = { username: "front-b", role: "reception", permissions: null };
    expect((CheckoutExtras(props(1)) as ReactElement).key).not.toBe(first.key);
    runtime.session = { username: "front-a", role: "reception", permissions: { canViewPatientPayments: false } };
    expect((CheckoutExtras(props(1)) as ReactElement).key).not.toBe(first.key);
    runtime.session = null;
    expect(CheckoutExtras(props(1))).toBeNull();
  });
  it("contains a delayed booking completion from A after a B owner has mounted, including an immediate duplicate click", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    const fetcher = vi.fn((_url: string, _init?: RequestInit) => pending);
    vi.stubGlobal("fetch", fetcher);
    const changedA = vi.fn(); const changedB = vi.fn();
    const a = mount(1, changedA);
    const book = elements(a.tree).find((node) => node.type === "button" && node.props.children === "احجز")!;
    (book.props.onClick as () => void)();
    (book.props.onClick as () => void)();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("/api/visits/1/next");
    a.unmount();
    const b = mount(2, changedB);
    resolve({ ok: true, json: async () => ({}) });
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    expect(changedA).not.toHaveBeenCalled();
    expect(changedB).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1); // No stale A reload after its command completed.
    b.unmount();
  });
});
