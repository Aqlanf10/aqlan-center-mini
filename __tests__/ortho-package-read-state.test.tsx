import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORTHO_PACKAGE_READ_TIMEOUT_MS, OrthoPackageLink } from "../components/OrthoPackageLink";
import type { SessionInfo } from "../components/SessionProvider";

const authority = vi.hoisted(() => ({ current: { username: "synthetic-doctor", role: "doctor", permissions: {} } as SessionInfo | null }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => authority.current }));

// Execute actual component effects and handlers while modelling React's keyed
// lifetimes. Real-browser rendering and network acceptance live in security-http.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0,
  effects: new Map<number, { deps: readonly unknown[]; cleanup?: () => void }>(),
  pending: [] as (() => void)[], key: null as string | null,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const effect = (callback: () => void | (() => void), deps: readonly unknown[]) => {
    const index = hooks.cursor++; const previous = hooks.effects.get(index);
    if (previous && deps.length === previous.deps.length && deps.every((one, at) => Object.is(one, previous.deps[at]))) return;
    previous?.cleanup?.();
    const entry = { deps, cleanup: undefined as (() => void) | undefined };
    hooks.effects.set(index, entry);
    hooks.pending.push(() => { entry.cleanup = callback() || undefined; });
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
      const values = hooks.values;
      return [values[index], (update: unknown) => { values[index] = typeof update === "function" ? update(values[index]) : update; }];
    },
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
    useEffect: effect, useLayoutEffect: effect,
  };
});

type Props = ComponentProps<typeof OrthoPackageLink>;
type Element = ReactElement<Record<string, unknown>>;
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const onChanged = vi.fn();
const defaults: Props = { patientId: 19, caseId: 41, planId: 51, canLink: true, onChanged };
const fixture = (extra: Record<string, unknown> = {}) => ({
  id: 51, patientId: 19, title: "Synthetic existing agreement", status: "active", installments: [{ id: 61 }], ...extra,
});
const response = (plans: unknown = [fixture()], status = 200) => Response.json({ plans }, { status });
function render(overrides: Partial<Props> = {}) {
  hooks.cursor = 0;
  const scope = OrthoPackageLink({ ...defaults, ...overrides });
  // The pre-fix component has no keyed child; this branch supports the
  // independently executed baseline negative control against its real code.
  if (scope && typeof scope.type !== "function") {
    hooks.pending.splice(0).forEach((effect) => effect());
    return scope;
  }
  if (hooks.key !== (scope?.key ?? null)) {
    for (const entry of hooks.effects.values()) entry.cleanup?.();
    hooks.values = []; hooks.effects.clear(); hooks.pending = [];
    hooks.key = scope?.key == null ? null : String(scope.key);
  }
  if (!scope) return null;
  hooks.cursor = 0;
  const tree = (scope.type as (props: Props) => ReactNode)(scope.props);
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
function button(tree: ReactNode, label: string) {
  const found = nodes(tree).filter((node) => node.type === "button" && text(node).trim() === label);
  expect(found).toHaveLength(1); return found[0];
}
function click(node: Element) { (node.props.onClick as () => void)(); }
function unknown(tree: ReactNode) {
  expect(text(tree)).not.toMatch(/الخطة بلا أقساط|لا اتفاق مالي مربوط|الشدّة تحتاج قرار فوترة|✓ باقة تقويم|الشدّات مشمولة/);
  expect(nodes(tree).filter((node) => ["a", "select", "input", "form"].includes(String(node.type)))).toEqual([]);
  expect(nodes(tree).filter((node) => node.type === "button" && ["اربط", "فكّ الربط"].includes(text(node).trim()))).toEqual([]);
}
async function settle() { for (let index = 0; index < 40; index++) await Promise.resolve(); }
function deferred<T = Response>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method);
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects.clear(); hooks.pending = []; hooks.key = null;
  authority.current = { username: "synthetic-doctor", role: "doctor", permissions: {} } as SessionInfo;
  fetchMock.mockReset(); onChanged.mockReset(); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  for (const entry of hooks.effects.values()) entry.cleanup?.();
  vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("orthodontic agreement read states", () => {
  it.each([51, null])("renders only unknown while the plans read is pending, planId=%s", async (planId) => {
    fetchMock.mockReturnValue(deferred().promise);
    const tree = render({ planId }); unknown(tree); expect(text(tree)).toContain("جارٍ التحقق");
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/plans?patientId=19");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
    expect(writes()).toEqual([]);
  });
  it.each([500, 503])("does not turn HTTP %s into no-installments, and retries by GET", async (status) => {
    fetchMock.mockResolvedValueOnce(response([], status)).mockResolvedValueOnce(response());
    render(); await settle(); unknown(render()); expect(text(render())).toContain("هذا لا يعني عدم وجود اتفاق أو أقساط");
    click(button(render(), "أعد تحميل اتفاق التقويم")); unknown(render()); await settle();
    expect(text(render())).toContain("✓ باقة تقويم"); expect(text(render())).toContain("Synthetic existing agreement");
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(writes()).toEqual([]);
  });
  it("shows a network failure without implying absence", async () => {
    fetchMock.mockRejectedValue(new Error("Synthetic offline")); render(); await settle();
    unknown(render()); expect(text(render())).toContain("تعذّر تحميل اتفاق التقويم");
  });
  it.each([401, 403])("fails closed without a retry or mutation control after %s", async (status) => {
    fetchMock.mockResolvedValue(response([fixture()], status)); render(); await settle();
    unknown(render()); expect(text(render())).toContain("بصلاحية الجلسة الحالية");
    expect(nodes(render()).filter((node) => node.type === "button")).toEqual([]);
  });
  it.each([
    null, {}, [null], [fixture({ patientId: 20 })], [fixture({ id: 0 })], [fixture({ status: "unknown" })],
    [fixture({ title: "" })], [fixture({ installments: null })], [fixture({ installments: [null] })],
    [fixture({ installments: [{}] })], [fixture(), fixture()],
  ])("rejects malformed, duplicate or wrong-patient plan data: %j", async (body) => {
    fetchMock.mockResolvedValue(response(body)); render(); await settle(); unknown(render());
    expect(text(render())).toContain("تعذّر تحميل اتفاق التقويم");
  });
  it("keeps a missing linked plan unknown even after a successful empty read", async () => {
    fetchMock.mockResolvedValue(response([])); render(); await settle(); unknown(render());
    expect(text(render())).toContain("تعذّر العثور على الخطة المربوطة");
  });
  it("shows confirmed no-link only after a successful empty read, preserving the existing Plans link", async () => {
    fetchMock.mockResolvedValue(response([])); render({ planId: null }); await settle();
    const tree = render({ planId: null }); expect(text(tree)).toContain("لا اتفاق مالي مربوط بالحالة");
    const links = nodes(tree).filter((node) => node.type === "a"); expect(links).toHaveLength(1);
    expect(links[0].props.href).toBe("/patients/19?tab=plans"); expect(writes()).toEqual([]);
  });
  it("shows no-installments only for the verified linked plan, ignoring other agreements", async () => {
    fetchMock.mockResolvedValue(response([fixture({ installments: [] }), fixture({ id: 52 })])); render(); await settle();
    expect(text(render())).toContain("الخطة بلا أقساط"); expect(text(render())).not.toContain("✓ باقة تقويم");
    expect(writes()).toEqual([]);
  });
  it.each(["active", "completed"])("preserves canonical non-cancelled %s funding and discards monetary fields", async (status) => {
    fetchMock.mockResolvedValue(response([fixture({ status, paidMinor: 987654, note: "PRIVATE_DETAIL" })])); render(); await settle();
    expect(text(render())).toContain("✓ باقة تقويم"); expect(text(render())).not.toMatch(/987654|PRIVATE_DETAIL/);
    expect(writes()).toEqual([]);
  });
  it("identifies a verified cancelled linked plan without calling it funded or installment-free", async () => {
    fetchMock.mockResolvedValue(response([fixture({ status: "cancelled" })])); render(); await settle();
    expect(text(render())).toContain("الخطة المربوطة ملغاة"); expect(text(render())).not.toMatch(/✓ باقة تقويم|الخطة بلا أقساط/);
  });
  it.each(["fetch", "body"])("times out a %s stall; late data cannot overwrite a retry", async (stage) => {
    vi.useFakeTimers(); const body = deferred<unknown>(); const request = deferred();
    if (stage === "fetch") fetchMock.mockReturnValueOnce(request.promise);
    else fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => body.promise } as Response);
    fetchMock.mockResolvedValueOnce(response());
    render(); await settle(); await vi.advanceTimersByTimeAsync(ORTHO_PACKAGE_READ_TIMEOUT_MS);
    unknown(render()); expect(text(render())).toContain("تعذّر تحميل");
    expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
    click(button(render(), "أعد تحميل اتفاق التقويم")); render(); await settle();
    body.resolve({ plans: [fixture({ installments: [] })] });
    request.resolve(response([fixture({ installments: [] })])); await settle();
    expect(text(render())).toContain("✓ باقة تقويم"); expect(text(render())).not.toContain("الخطة بلا أقساط");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("orthodontic agreement scope retirement", () => {
  it.each([
    { patientId: 20 }, { caseId: 42 }, { planId: 52 }, { canLink: false },
  ])("immediately retires loaded data and selections on changed props: %j", async (next) => {
    fetchMock.mockResolvedValueOnce(response()).mockReturnValueOnce(deferred().promise);
    render(); await settle(); const old = button(render(), "فكّ الربط");
    const changed = render(next); unknown(changed); expect(text(changed)).toContain("جارٍ التحقق");
    click(old); expect(writes()).toEqual([]);
    expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
  });
  it.each(["username", "role", "permissions"] as const)("retires data and stale handlers on session %s changes", async (field) => {
    fetchMock.mockResolvedValueOnce(response()).mockReturnValueOnce(deferred().promise);
    render(); await settle(); const old = button(render(), "فكّ الربط");
    authority.current = { ...authority.current!, [field]: field === "permissions" ? { canEditPlans: false } : `different-${field}` } as SessionInfo;
    unknown(render()); click(old); expect(writes()).toEqual([]); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("ignores late A/B replies through A→B→A and requires a fresh A read", async () => {
    const firstA = deferred(); const b = deferred(); const lastA = deferred();
    fetchMock.mockReturnValueOnce(firstA.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(lastA.promise);
    render(); render({ patientId: 20 }); unknown(render());
    firstA.resolve(response([fixture({ title: "OLD_A" })])); b.resolve(response([fixture({ patientId: 20, title: "OLD_B" })])); await settle();
    unknown(render()); lastA.resolve(response()); await settle();
    expect(text(render())).toContain("Synthetic existing agreement"); expect(text(render())).not.toMatch(/OLD_A|OLD_B/);
  });
  it("does not revive previously ready data when revisiting A", async () => {
    fetchMock.mockResolvedValueOnce(response()).mockReturnValueOnce(deferred().promise).mockReturnValueOnce(deferred().promise);
    render(); await settle(); expect(text(render())).toContain("Synthetic existing agreement");
    render({ patientId: 20 }); unknown(render()); expect(text(render())).toContain("جارٍ التحقق");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("retires response-body reads and prevents any fetch after logout", async () => {
    const body = deferred<unknown>();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => body.promise } as Response);
    render(); await settle(); authority.current = null; expect(render()).toBeNull();
    body.resolve({ plans: [fixture()] }); await settle(); expect(render()).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("existing explicit linking actions", () => {
  it("keeps the canonical unlink PATCH exact and suppresses same-turn duplicate clicks", async () => {
    const write = deferred(); fetchMock.mockResolvedValueOnce(response()).mockReturnValueOnce(write.promise);
    render(); await settle(); const unlink = button(render(), "فكّ الربط"); click(unlink); click(unlink);
    expect(writes()).toEqual([["/api/ortho/41", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: null }) }]]);
    write.resolve(Response.json({ ok: true })); await settle(); expect(onChanged).toHaveBeenCalledTimes(1);
  });
  it("links only the explicitly chosen existing funded plan", async () => {
    fetchMock.mockResolvedValueOnce(response([fixture(), fixture({ id: 52, status: "cancelled" }), fixture({ id: 53, installments: [] })]))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    render({ planId: null }); await settle();
    const select = nodes(render({ planId: null })).find((node) => node.type === "select")!;
    expect(nodes(select).filter((node) => node.type === "option").map((node) => node.props.value)).toEqual(["", 51]);
    (select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "51" } });
    click(button(render({ planId: null }), "اربط")); await settle();
    expect(writes()).toEqual([["/api/ortho/41", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: 51 }) }]]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
  it("never acts on a synthetic selection not present in the confirmed agreements", async () => {
    fetchMock.mockResolvedValue(response()); render({ planId: null }); await settle();
    const select = nodes(render({ planId: null })).find((node) => node.type === "select")!;
    (select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "999" } });
    click(button(render({ planId: null }), "اربط")); await settle(); expect(writes()).toEqual([]);
  });
  it("does not forward a retired write result to the new patient", async () => {
    const write = deferred(); fetchMock.mockResolvedValueOnce(response()).mockReturnValueOnce(write.promise).mockReturnValueOnce(deferred().promise);
    render(); await settle(); click(button(render(), "فكّ الربط"));
    render({ patientId: 20 }); write.resolve(Response.json({ ok: true })); await settle();
    unknown(render({ patientId: 20 })); expect(onChanged).not.toHaveBeenCalled(); expect(writes()).toHaveLength(1);
  });
  it("preserves explicit write errors without fabricating a successful unlink", async () => {
    fetchMock.mockResolvedValueOnce(response()).mockResolvedValueOnce(Response.json({ message: "Synthetic refusal" }, { status: 409 }));
    render(); await settle(); click(button(render(), "فكّ الربط")); await settle();
    expect(text(render())).toContain("Synthetic refusal"); expect(text(render())).toContain("✓ باقة تقويم");
    expect(onChanged).not.toHaveBeenCalled();
  });
  it("has no mutation controls when linking is unavailable", async () => {
    fetchMock.mockResolvedValue(response()); render({ canLink: false }); await settle();
    expect(nodes(render({ canLink: false })).filter((node) => ["button", "select", "a"].includes(String(node.type)))).toEqual([]);
    expect(writes()).toEqual([]);
  });
});
