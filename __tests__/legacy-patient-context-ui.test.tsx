import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEGACY_ORTHO_READ_TIMEOUT_MS, LegacyOrthoPlanContext } from "../components/LegacyOrthoPlanContext";
import { CurrentCollectionGuidance, OpeningBalanceGuidance } from "../components/LegacyMoneyGuidance";
import { previousBalancePayload } from "../components/PreviousBalanceFields";
import type { SessionInfo } from "../components/SessionProvider";

const authority = vi.hoisted(() => ({ current: { username: "synthetic-doctor", role: "doctor", permissions: {} } as SessionInfo | null }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => authority.current }));

// Exercise the actual context component, its effects and retry handler.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0,
  effects: new Map<number, { deps: readonly unknown[]; cleanup?: () => void }>(),
  pending: [] as (() => void)[],
  key: null as string | null,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.values[index], (update: unknown) => {
        hooks.values[index] = typeof update === "function" ? update(hooks.values[index]) : update;
      }];
    },
    useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.effects.get(index);
      if (previous && deps.length === previous.deps.length && deps.every((one, at) => Object.is(one, previous.deps[at]))) return;
      previous?.cleanup?.();
      const entry = { deps, cleanup: undefined as (() => void) | undefined };
      hooks.effects.set(index, entry);
      hooks.pending.push(() => { entry.cleanup = effect() || undefined; });
    },
  };
});

type Element = ReactElement<Record<string, unknown>>;
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const fixture = (patientId = 19, id = 41, extra: Record<string, unknown> = {}) => ({
  patientId, id, baselineKind: "legacy", appliance: "fixed_metal", arches: "both",
  status: "active", phase: "working", startDate: "2025-01-01", ...extra,
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function render(patientId = 19) {
  const scope = LegacyOrthoPlanContext({ patientId });
  // Model React's actual keyed child lifetime, retaining old async closures so
  // their cancellation guards are still exercised by late-response tests.
  if (hooks.key !== (scope?.key ?? null)) {
    for (const entry of hooks.effects.values()) entry.cleanup?.();
    hooks.values = []; hooks.effects.clear(); hooks.pending = [];
    hooks.key = scope?.key == null ? null : String(scope.key);
  }
  if (!scope) return null;
  hooks.cursor = 0;
  const tree = (scope.type as (props: { patientId: number }) => ReactNode)(scope.props);
  hooks.pending.splice(0).forEach((effect) => effect());
  return tree;
}
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...nodes(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (node && typeof node === "object" && "props" in node) return text((node as Element).props.children as ReactNode);
  return "";
}
async function settle() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
const deferred = () => {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
};
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects.clear(); hooks.pending = [];
  hooks.key = null;
  authority.current = { username: "synthetic-doctor", role: "doctor", permissions: {} } as SessionInfo;
  fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  for (const entry of hooks.effects.values()) entry.cleanup?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("legacy money explanations, rendered as actual UI", () => {
  it("defines opening as remaining before the system, including a historical total-minus-paid example", () => {
    const html = renderToStaticMarkup(createElement(OpeningBalanceGuidance));
    expect(html).toContain("المتبقي المستحق قبل بدء البرنامج");
    expect(html).toContain("قيمة العلاج 600، المدفوع سابقًا 250، الرصيد السابق الذي تُدخله 350");
    expect(html).toContain("لا يُسجّل كسند قبض جديد");
    expect(html).toContain("دون إيراد أو عمولة");
  });
  it("explains that collection creates today's shift movement, without converting notes into behavior", () => {
    const html = renderToStaticMarkup(createElement(CurrentCollectionGuidance));
    expect(html).toContain("مبلغًا استلمته الآن فقط");
    expect(html).toContain("تحصيل الوردية الحالية");
    expect(html).toContain("بيانات تاريخية");
    expect(html).not.toMatch(/<input|<button|<form/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("keeps the opening payload unchanged, including a literal historical note", () => {
    expect(previousBalancePayload({ enabled: true, amount: "350", currency: "SAR", note: "مبالغ مدفوعه قبل النظام" }))
      .toEqual({ openingBalance: { amount: "350", currency: "SAR", note: "مبالغ مدفوعه قبل النظام" } });
  });
});

describe("read-only legacy orthodontic context in Plans", () => {
  it("shows canonical legacy statuses and links, filters new cases, and discards monetary/clinical detail fields", async () => {
    fetchMock.mockResolvedValue(response({ cases: [
      fixture(19, 41, { paidMinor: 987654, remainingMinor: 876543, note: "PRIVATE_DETAIL" }),
      fixture(19, 42, { status: "retention" }), fixture(19, 43, { status: "completed" }),
      fixture(19, 44, { status: "discontinued" }), fixture(19, 45, { baselineKind: null }),
    ] }));
    expect(text(render())).toContain("جارٍ تحميل"); await settle();
    const tree = render(); const content = text(tree);
    for (const label of ["جارية", "تثبيت", "مكتملة", "متوقّفة", "2025-01-01"]) expect(content).toContain(label);
    expect(content).not.toMatch(/987654|876543|PRIVATE_DETAIL|45/);
    const links = nodes(tree).filter((node) => node.type === "a");
    expect(links).toHaveLength(4);
    for (const link of links) expect(link.props.href).toBe("/patients/19?tab=ortho");
    expect(nodes(tree).filter((node) => ["input", "form", "button"].includes(String(node.type)))).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/ortho?patientId=19");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
    expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined();
  });
  it("does not invent a missing case for a successful empty read", async () => {
    fetchMock.mockResolvedValue(response({ cases: [] })); render(); await settle();
    expect(render()).toBeNull();
  });
  it.each([401, 403])("does not display clinical details or a retry action after %s", async (status) => {
    fetchMock.mockResolvedValue(response({ cases: [fixture()] }, status)); render(); await settle();
    const tree = render(); expect(text(tree)).toContain("بصلاحية الجلسة الحالية");
    expect(text(tree)).not.toContain("حالة #"); expect(nodes(tree).filter((node) => node.type === "button")).toEqual([]);
  });
  it.each([null, {}, { cases: null }, { cases: [fixture(20)] }, { cases: [fixture(19, 41, { phase: "unknown" })] }])("fails visibly closed for malformed or wrong-patient data: %j", async (body) => {
      fetchMock.mockResolvedValue(response(body)); render(); await settle();
      expect(text(render())).toContain("هذا لا يعني عدم وجود حالة");
      expect(text(render())).not.toContain("حالة #");
    });
  it("retries a failed read with GET only and clears the failure after success", async () => {
    fetchMock.mockResolvedValueOnce(response({}, 500)).mockResolvedValueOnce(response({ cases: [fixture()] }));
    render(); await settle();
    const retry = nodes(render()).find((node) => node.type === "button")!;
    (retry.props.onClick as () => void)();
    expect(text(render())).toContain("جارٍ تحميل"); await settle();
    expect(text(render())).toContain("حالة #");
    expect(text(render())).not.toContain("تعذّر تحميل");
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
  it("never applies late A or B replies across A→B→A navigation", async () => {
    const firstA = deferred(); const b = deferred(); const lastA = deferred();
    fetchMock.mockReturnValueOnce(firstA.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(lastA.promise);
    render(19); render(20); render(19);
    lastA.resolve(response({ cases: [fixture(19, 43)] })); await settle();
    expect(text(render(19))).toContain("43");
    b.resolve(response({ cases: [fixture(20, 44)] })); firstA.resolve(response({ cases: [fixture(19, 41)] })); await settle();
    expect(text(render(19))).toContain("43"); expect(text(render(19))).not.toMatch(/44|41/);
    expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
    expect((fetchMock.mock.calls[1][1]?.signal as AbortSignal).aborted).toBe(true);
  });
  it("hides a previously loaded patient immediately when its prop changes", async () => {
    fetchMock.mockResolvedValueOnce(response({ cases: [fixture()] })).mockReturnValueOnce(deferred().promise);
    render(); await settle(); expect(text(render())).toContain("41");
    const changed = text(render(20)); expect(changed).toContain("جارٍ تحميل"); expect(changed).not.toContain("41");
  });
  it("does not revive already-loaded A on A→B→A before the fresh A read settles", async () => {
    const b = deferred(); const freshA = deferred();
    fetchMock.mockResolvedValueOnce(response({ cases: [fixture(19, 41)] }))
      .mockReturnValueOnce(b.promise).mockReturnValueOnce(freshA.promise);
    render(19); await settle(); expect(text(render(19))).toContain("41");
    render(20);
    const revisited = text(render(19));
    expect(revisited).toContain("جارٍ تحميل"); expect(revisited).not.toContain("41");
    freshA.resolve(response({ cases: [fixture(19, 43)] })); await settle();
    expect(text(render(19))).toContain("43"); expect(text(render(19))).not.toContain("41");
  });
  it.each(["username", "role", "permissions"] as const)("retires loaded data when session %s changes", async (field) => {
    fetchMock.mockResolvedValueOnce(response({ cases: [fixture()] })).mockReturnValueOnce(deferred().promise);
    render(); await settle(); expect(text(render())).toContain("41");
    authority.current = { ...authority.current!, [field]: field === "permissions" ? { canViewAllPatients: false } : `different-${field}` } as SessionInfo;
    const changed = text(render());
    expect(changed).toContain("جارٍ تحميل"); expect(changed).not.toContain("41");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("unmounts clinical context on logout without requesting anything else", async () => {
    const read = deferred(); fetchMock.mockReturnValue(read.promise);
    render(); authority.current = null;
    expect(render()).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
    read.resolve(response({ cases: [fixture()] })); await settle(); expect(render()).toBeNull();
  });
  it("times out a hanging read, ignores its late result, and retries with fresh state", async () => {
    vi.useFakeTimers(); const slow = deferred();
    fetchMock.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(response({ cases: [fixture(19, 43)] }));
    render(); await vi.advanceTimersByTimeAsync(LEGACY_ORTHO_READ_TIMEOUT_MS);
    expect(text(render())).toContain("هذا لا يعني عدم وجود حالة");
    expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
    slow.resolve(response({ cases: [fixture(19, 41)] })); await settle();
    expect(text(render())).not.toContain("41");
    const retry = nodes(render()).find((node) => node.type === "button")!;
    (retry.props.onClick as () => void)(); render(); await settle();
    expect(text(render())).toContain("43");
    expect(vi.getTimerCount()).toBe(0);
  });
});
