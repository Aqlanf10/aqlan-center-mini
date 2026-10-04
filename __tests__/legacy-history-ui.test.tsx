import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyHistory, LEGACY_ARCHIVE_READ_TIMEOUT_MS } from "../components/LegacyHistory";
import type { SessionInfo } from "../components/SessionProvider";

const authority = vi.hoisted(() => ({ current: { username: "synthetic-admin", role: "admin" } as SessionInfo | null }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => authority.current }));
// Same bounded hook/key driver as the existing legacy context regressions.
// Browser/React reconciliation proof remains the remote built-app gate.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, key: null as string | null,
  effects: new Map<number, { deps: readonly unknown[]; cleanup?: () => void }>(), pending: [] as (() => void)[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (update: unknown) => { hooks.values[index] = typeof update === "function" ? update(hooks.values[index]) : update; }];
  }, useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
    const index = hooks.cursor++; const previous = hooks.effects.get(index);
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    previous?.cleanup?.(); const entry = { deps, cleanup: undefined as (() => void) | undefined };
    hooks.effects.set(index, entry); hooks.pending.push(() => { entry.cleanup = effect() || undefined; });
  } };
});
type Element = ReactElement<Record<string, unknown>>;
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const treatment = (id = 51, manual = false) => ({ id, legacyNumber: manual ? null : 901, sourceKind: manual ? "manual_history" : "legacy_import",
  historicalAsOf: manual ? "2026-09-01" : null, treatedOn: "2025-01-01", doctorName: "Original doctor", service: "Original treatment",
  currency: "SAR", priceMinor: 60000, rate: manual ? null : 143.25, paidMinor: 25000, remainingMinor: 35000, payments: [] });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const history = (...treatments: ReturnType<typeof treatment>[]) => ({ treatments, orphanPayments: [] });
function clear() {
  for (const entry of hooks.effects.values()) entry.cleanup?.();
  hooks.values = []; hooks.effects.clear(); hooks.pending = [];
}
function render(patientId = 11) {
  const scope = LegacyHistory({ patientId });
  if (hooks.key !== (scope?.key ?? null)) { clear(); hooks.key = scope?.key == null ? null : String(scope.key); }
  if (!scope) return null;
  hooks.cursor = 0;
  const tree = (scope.type as (props: { patientId: number }) => ReactNode)(scope.props);
  hooks.pending.splice(0).forEach((effect) => effect()); return tree;
}
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...nodes(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (node && typeof node === "object" && "props" in node) return text((node as Element).props.children as ReactNode);
  return "";
}
const expand = (tree: ReactNode) => (nodes(tree).find((node) => node.type === "button")!.props.onClick as () => void)();
async function settle() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
function deferred() { let resolve!: (value: Response) => void; const promise = new Promise<Response>((done) => { resolve = done; }); return { resolve, promise }; }
beforeEach(() => { clear(); hooks.key = null; hooks.cursor = 0; authority.current = { username: "synthetic-admin", role: "admin" };
  fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("legacy history compatible identity and protected read lifecycle", () => {
  it("keeps the genuine imported number, dates, rate and values while using internal identity as the key", async () => {
    fetchMock.mockResolvedValue(response(history(treatment()))); render(); await settle(); expand(render());
    const tree = render(); expect(text(tree)).toContain("#901"); expect(text(tree)).toContain("2025-01-01");
    expect(text(tree)).toContain("143.25"); expect(text(tree)).not.toContain("سجل تاريخي يدوي");
    expect(nodes(tree).filter((node) => node.type === "li").map((node) => node.key)).toEqual(["51"]);
  });
  it("uses distinct internal keys for null-number manual rows and shows provenance without a fake import number", async () => {
    fetchMock.mockResolvedValue(response(history(treatment(52, true), treatment(53, true)))); render(); await settle(); expand(render());
    const tree = render(); expect(text(tree)).toContain("سجل تاريخي يدوي"); expect(text(tree)).toContain("البيانات التاريخية حتى");
    expect(text(tree)).toContain("2026-09-01"); expect(text(tree)).not.toMatch(/#null|#52|#53|143.25/);
    expect(nodes(tree).filter((node) => node.type === "li").map((node) => node.key)).toEqual(["52", "53"]);
    expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined();
  });
  it.each([401, 403, 404])("shows restriction for %s without monetary data or an empty-history claim", async (status) => {
    fetchMock.mockResolvedValue(response(history(treatment()), status)); render(); await settle();
    const tree = render(); expect(text(tree)).toContain("غير متاح بصلاحية الجلسة الحالية");
    expect(text(tree)).not.toMatch(/901|Original|600|لا يوجد/); expect(nodes(tree).some((node) => node.type === "button")).toBe(false);
  });
  it("distinguishes a failed read from empty history and retries with GET only", async () => {
    fetchMock.mockResolvedValueOnce(response({}, 500)).mockResolvedValueOnce(response(history(treatment())));
    render(); await settle(); expect(text(render())).toContain("هذا لا يعني عدم وجود سجل"); expand(render());
    render(); await settle(); expect(text(render())).toContain("سجل النظام القديم");
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
  it("hides an explicitly successful empty archive", async () => {
    fetchMock.mockResolvedValue(response(history())); render(); await settle(); expect(render()).toBeNull();
  });
  it("retires loaded money immediately on A→B→A and cannot revive the first A's data", async () => {
    const b = deferred(); const secondA = deferred();
    fetchMock.mockResolvedValueOnce(response(history(treatment()))).mockReturnValueOnce(b.promise).mockReturnValueOnce(secondA.promise);
    render(11); await settle(); expand(render(11)); expect(text(render(11))).toContain("#901");
    expect(render(12)).toBeNull(); expect(render(11)).toBeNull();
    b.resolve(response(history(treatment(60)))); await settle(); expect(render(11)).toBeNull();
    secondA.resolve(response(history(treatment(61, true)))); await settle(); expand(render(11));
    expect(text(render(11))).not.toContain("#901");
    expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
  });
  it("retires pending reads on principal/permission change and on logout", async () => {
    const old = deferred(); fetchMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response({}, 403)); render();
    authority.current = { username: "synthetic-doctor", role: "doctor", permissions: { canViewPatientPayments: false } } as SessionInfo;
    expect(render()).toBeNull(); await settle(); expect(text(render())).toContain("غير متاح");
    old.resolve(response(history(treatment()))); await settle(); expect(text(render())).not.toContain("#901");
    authority.current = null; expect(render()).toBeNull();
  });
  it("expires a hung read and ignores its late response", async () => {
    vi.useFakeTimers(); const pending = deferred(); fetchMock.mockReturnValue(pending.promise); render();
    await vi.advanceTimersByTimeAsync(LEGACY_ARCHIVE_READ_TIMEOUT_MS);
    expect(text(render())).toContain("هذا لا يعني عدم وجود سجل");
    pending.resolve(response(history(treatment()))); await settle(); expect(text(render())).not.toContain("#901");
    expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
  });
});
