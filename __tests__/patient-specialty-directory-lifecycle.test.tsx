import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientSpecialtyDirectory, useSpecialtyDirectoryRead } from "../components/patient-specialties/PatientSpecialtyDirectory";
import { SPECIALTIES } from "../lib/appointment-services";

// Real read lifecycle and navigation handlers; this is not a browser/visual test.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(), layouts: [] as Array<() => void>, pending: [] as Array<() => void> }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => { const index = slot(undefined); const previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value; const value = factory(); hooks.memos.set(index, { deps, value }); return value; };
  const effect = (queue: Array<() => void>, callback: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = slot(undefined); const previous = hooks.effects.get(index); if (previous && same(previous.deps, deps)) return;
    queue.push(() => { previous?.cleanup?.(); const cleanup = callback(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
  };
  return { ...react,
    useState: (initial: unknown) => { const index = slot(typeof initial === "function" ? initial() : initial); return [hooks.values[index], (value: unknown) => {
      const next = typeof value === "function" ? value(hooks.values[index]) : value;
      if (!Object.is(next, hooks.values[index])) hooks.changed = true; hooks.values[index] = next;
    }]; },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useLayoutEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => effect(hooks.layouts, callback, deps),
    useEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => effect(hooks.pending, callback, deps),
  };
});
function render<T>(run: () => T, flush = true): T {
  hooks.cursor = 0; hooks.changed = false; const result = run();
  hooks.layouts.splice(0).forEach((effect) => effect());
  if (flush) hooks.pending.splice(0).forEach((effect) => effect());
  return result;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: vi.fn(async () => body) });
type Response = ReturnType<typeof response>;
const savedCase = (id = 5, patientId = 91) => ({ id, kind: "specialty", orthoCaseId: null, patientId, specialty: "endodontics", title: `SYNTHETIC CASE ${patientId}/${id}`,
  site: "36", problem: "Synthetic clinical problem", responsibleName: "CASE PROVIDER", status: "active", startedOn: "2026-10-03", outcome: null, waitingOn: ["Recorded referral #7"] });
const item = (id = 41, caseId: number | null = 5) => ({ id, planId: 31, planTitle: "SYNTHETIC PLAN", serviceName: "SYNTHETIC ITEM", toothCode: 36,
  status: "planned", doctorName: "ITEM PROVIDER", caseId, totalMinor: 987654, category: "rct" });
const payload = (patientId = 91) => ({ cases: [savedCase(5, patientId)], problems: [], planVisible: true, items: [item()], dependencies: [] });
let props: ComponentProps<typeof PatientSpecialtyDirectory>;
const fetchMock = vi.fn();
const useProbe = () => useSpecialtyDirectoryRead(props);
const read = (flush = true) => render(useProbe, flush);
const ui = (flush = true) => render(() => PatientSpecialtyDirectory(props), flush);
async function readyRead() { read(); await vi.waitFor(() => expect(read().status).toBe("ready")); return read(); }
async function readyUI() { ui(); await vi.waitFor(() => expect(allText(ui())).toContain("1 حالة محفوظة")); return ui(); }
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  const children = typeof element.type === "function" ? (element.type as (props: Record<string, unknown>) => ReactNode)(element.props) : element.props.children as ReactNode;
  return [element, ...elements(children)];
}
function allText(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(allText).join(" ").replace(/\s+/g, " ");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  const element = node as Element;
  return allText(typeof element.type === "function" ? (element.type as (props: Record<string, unknown>) => ReactNode)(element.props) : element.props.children as ReactNode);
}
function byTestId(tree: ReactNode, id: string): Element { const matches = elements(tree).filter((row) => row.props["data-testid"] === id); expect(matches).toHaveLength(1); return matches[0]; }
function click(tree: ReactNode, id: string) { (byTestId(tree, id).props.onClick as () => void)(); }
function selectEndo() { click(ui(), "specialty-card-endodontics"); return ui(); }

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.effects.clear(); hooks.memos.clear(); hooks.layouts = []; hooks.pending = [];
  props = { patientId: 91, authorityKey: "synthetic:doctor:plans", canViewPlans: true, active: true, openVisitId: 21, onNavigate: vi.fn(), onFocus: vi.fn() };
  fetchMock.mockReset().mockResolvedValue(response(payload())); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { hooks.effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe("generation/authority/active fenced directory read", () => {
  it("uses exactly one protected patient GET with no writes, subscriptions or fallback reads", async () => {
    const value = await readyRead(); expect(value.value?.patientId).toBe(91);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/patients/91/cases", { cache: "no-store", signal: expect.any(AbortSignal) });
    expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
  });
  it("does not read or preserve private context when inactive", async () => {
    props.active = false; expect(read().value).toBeNull(); expect(read().status).toBe("inactive"); expect(fetchMock).not.toHaveBeenCalled();
    props.active = true; await readyRead(); props.active = false;
    expect(read(false).value).toBeNull(); expect(read().status).toBe("inactive");
  });
  it("hides old patient data before effects run, and rejects a foreign payload for the new patient", async () => {
    await readyRead(); props.patientId = 92;
    expect(read(false).value).toBeNull(); read();
    await vi.waitFor(() => expect(read().status).toBe("unavailable")); expect(read().value).toBeNull();
  });
  it("hides old rights before effects run and adopts only the new hidden-plan projection", async () => {
    await readyRead(); props.authorityKey = "synthetic:restricted";
    fetchMock.mockResolvedValue(response({ ...payload(), planVisible: false }));
    expect(read(false).value).toBeNull(); await readyRead();
    expect(read().value?.items).toEqual([]); expect(read().value?.planVisible).toBe(false);
  });
  it("keeps the same read generation on stable normal rerenders", async () => {
    const original = await readyRead(); props = { ...props, onFocus: vi.fn(), onNavigate: vi.fn() };
    const next = read(); expect(next.generation).toBe(original.generation); expect(next.value).toBe(original.value);
    expect(next.reload).toBe(original.reload); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("fences denied plan callbacks before passive reads run and ignores late permitted JSON", async () => {
    const original = await readyRead(); const body = deferred<unknown>();
    const stale = response(null); stale.json.mockImplementation(() => body.promise); fetchMock.mockResolvedValueOnce(stale);
    const old = read().reload(); await vi.waitFor(() => expect(stale.json).toHaveBeenCalled());
    props.canViewPlans = false;
    expect(read(false).value).toBeNull(); expect(original.isCurrent(original.generation)).toBe(false);
    await original.reload(); expect(fetchMock).toHaveBeenCalledTimes(2);
    body.resolve(payload()); await old;
    // No passive effect has started a replacement read yet; even here the old result is fenced.
    expect(read(false).value).toBeNull(); read(); await readyRead();
    expect(read().value).toMatchObject({ patientId: 91, planVisible: false, items: [], dependencies: [] });
    expect(read().value?.cases).toHaveLength(1);
  });
  it.each([undefined, "false"])("still rejects an invalid server capability (%s) while shell plans are denied", async (planVisible) => {
    props.canViewPlans = false; fetchMock.mockResolvedValue(response({ ...payload(), planVisible }));
    read(); await vi.waitFor(() => expect(read().status).toBe("unavailable")); expect(read().value).toBeNull();
  });
  it("keeps exact patient/case validation while denied plan bodies are skipped", async () => {
    props.canViewPlans = false;
    fetchMock.mockResolvedValue(response({ ...payload(), items: "WITHHELD", dependencies: "WITHHELD" }));
    await readyRead(); expect(read().value?.cases[0].id).toBe(5); expect(read().value?.items).toEqual([]);
    fetchMock.mockResolvedValue(response({ ...payload(), cases: [savedCase(5, 92)], items: [], dependencies: [] }));
    await read().reload(); expect(read().status).toBe("unavailable"); expect(read().value).toBeNull();
  });
  it("fences callbacks and rechecks when the current visit changes or disappears", async () => {
    const original = await readyRead(); expect(original.isCurrent(original.generation)).toBe(true);
    props.openVisitId = 22; expect(read().value).toBeNull(); expect(original.isCurrent(original.generation)).toBe(false);
    await readyRead(); props.openVisitId = null; expect(read().value).toBeNull(); await readyRead();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("ignores a late previous-patient response without parsing it", async () => {
    const old = deferred<Response>(); fetchMock.mockReturnValueOnce(old.promise); read();
    props.patientId = 92; fetchMock.mockResolvedValue(response(payload(92))); await readyRead();
    const late = response(payload()); old.resolve(late); await Promise.resolve(); await Promise.resolve();
    expect(read().value?.patientId).toBe(92); expect(late.json).not.toHaveBeenCalled();
  });
  it("ignores a previously-started JSON body after the authority changes", async () => {
    const body = deferred<unknown>(); const stale = response(null); stale.json.mockImplementation(() => body.promise);
    fetchMock.mockResolvedValueOnce(stale); read(); await vi.waitFor(() => expect(stale.json).toHaveBeenCalled());
    props.authorityKey = "new authority"; fetchMock.mockResolvedValue(response({ ...payload(), planVisible: false })); await readyRead();
    body.resolve(payload()); await Promise.resolve(); await Promise.resolve();
    expect(read().value?.planVisible).toBe(false); expect(read().value?.items).toEqual([]);
  });
  it.each([401, 403, 404])("clears data on %s before parsing an HTML or delayed body", async (status) => {
    await readyRead(); const denied = response(null, status); denied.json.mockImplementation(() => new Promise(() => {})); fetchMock.mockResolvedValue(denied);
    await read().reload(); expect(read().status).toBe("denied"); expect(read().value).toBeNull(); expect(denied.json).not.toHaveBeenCalled();
  });
  it("cannot restore private data when a superseded success finishes after a denial", async () => {
    const first = deferred<Response>(); fetchMock.mockReturnValueOnce(first.promise); read();
    fetchMock.mockResolvedValue(response(null, 403)); await read().reload(); expect(read().status).toBe("denied");
    first.resolve(response(payload())); await Promise.resolve(); await Promise.resolve(); expect(read().status).toBe("denied"); expect(read().value).toBeNull();
  });
  it("cannot downgrade a newer success from an old denied response", async () => {
    const first = deferred<Response>(); fetchMock.mockReturnValueOnce(first.promise); read();
    await read().reload(); expect(read().status).toBe("ready"); first.resolve(response(null, 403));
    await Promise.resolve(); await Promise.resolve(); expect(read().status).toBe("ready");
  });
  it("clears a cached read on transient failure and offers retry without inventing an empty result", async () => {
    await readyRead(); fetchMock.mockResolvedValue(response({}, 503)); await read().reload();
    expect(read().status).toBe("unavailable"); expect(read().value).toBeNull();
    fetchMock.mockResolvedValue(response(payload())); await read().reload(); expect(read().status).toBe("ready");
  });
  it("does not revive a request after unmount or inactive/reactivated generations", async () => {
    const old = deferred<Response>(); fetchMock.mockReturnValueOnce(old.promise); read();
    props.active = false; read(); props.active = true; await readyRead();
    const late = response({ ...payload(), cases: [] }); old.resolve(late); await Promise.resolve(); await Promise.resolve();
    expect(read().value?.cases).toHaveLength(1); expect(late.json).not.toHaveBeenCalled();
    const pending = deferred<Response>(); fetchMock.mockReturnValueOnce(pending.promise); const reload = read().reload();
    hooks.effects.forEach((effect) => effect.cleanup?.()); const afterUnmount = response(payload()); pending.resolve(afterUnmount); await reload;
    expect(afterUnmount.json).not.toHaveBeenCalled();
  });
  it.each([{}, { ...payload(), planVisible: undefined }, { ...payload(), cases: [savedCase(5, 92)] }])("treats malformed successful data as unavailable: %j", async (data) => {
    fetchMock.mockResolvedValue(response(data)); read(); await vi.waitFor(() => expect(read().status).toBe("unavailable")); expect(read().value).toBeNull();
  });
});

describe("compact read-only specialty directory real handlers", () => {
  it("renders all 13 compact cards, truthful partial coverage, and no clinical forms", async () => {
    const tree = await readyUI();
    for (const id of SPECIALTIES) expect(byTestId(tree, `specialty-card-${id}`)).toBeTruthy();
    expect(allText(tree)).toContain("مساحة متخصصة · جزئية"); expect(allText(tree)).toContain("مسار مشترك · جزئي");
    expect(elements(tree).filter((row) => row.type === "textarea" || row.type === "form")).toHaveLength(0);
    expect(elements(tree).filter((row) => row.type === "input")).toHaveLength(1);
  });
  it("finds the existing Endo card by nerve-treatment aliases without duplicating a specialty", async () => {
    await readyUI(); const input = elements(ui()).find((row) => row.type === "input")!;
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "علاج العصب" } });
    const tree = ui(); expect(elements(tree).filter((row) => String(row.props["data-testid"] ?? "").startsWith("specialty-card-"))).toHaveLength(1);
    expect(byTestId(tree, "specialty-card-endodontics")).toBeTruthy();
  });
  it("opens the exact saved case and original plan item and passes the actual current visit tuple", async () => {
    await readyUI(); const tree = selectEndo();
    click(tree, "specialty-open-case-5"); click(tree, "specialty-open-plan-item-41"); click(tree, "specialty-review-visit-item-41");
    expect(props.onFocus).toHaveBeenNthCalledWith(1, { kind: "case", patientId: 91, caseId: 5 });
    expect(props.onFocus).toHaveBeenNthCalledWith(2, { kind: "plan_item", patientId: 91, planId: 31, itemId: 41, caseId: 5, toothCode: 36 });
    expect(props.onFocus).toHaveBeenNthCalledWith(3, { kind: "visit_work", patientId: 91, visitId: 21, planId: 31, itemId: 41, caseId: 5, toothCode: 36 });
    expect(allText(tree)).toContain("مسؤول الحالة: CASE PROVIDER"); expect(allText(tree)).toContain("الطبيب المعيّن للبند: ITEM PROVIDER");
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(props.onNavigate).not.toHaveBeenCalled();
  });
  it("reviews a dependency using its own plan/case/tooth, not the source item's tuple", async () => {
    fetchMock.mockResolvedValue(response({ ...payload(), cases: [savedCase(), { ...savedCase(6), specialty: "surgery" }],
      items: [item(), { ...item(42, 6), planId: 32, toothCode: 46 }], dependencies: [{ itemId: 41, requiresItemId: 42, requirement: "completed", met: false, note: null }] }));
    await readyUI(); click(selectEndo(), "specialty-dependency-41-42");
    expect(props.onFocus).toHaveBeenCalledWith({ kind: "plan_item", patientId: 91, planId: 32, itemId: 42, caseId: 6, toothCode: 46 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("keeps null case/tooth exact and displays unlinked work outside the selected specialty", async () => {
    fetchMock.mockResolvedValue(response({ ...payload(), items: [{ ...item(41, null), toothCode: null }] }));
    await readyUI(); const tree = selectEndo(); const group = byTestId(tree, "specialty-unlinked-items");
    expect(elements(byTestId(tree, "specialty-case-5")).some((row) => row.props["data-testid"] === "specialty-item-41")).toBe(false);
    click(group, "specialty-review-visit-item-41");
    expect(props.onFocus).toHaveBeenCalledWith({ kind: "visit_work", patientId: 91, visitId: 21, planId: 31, itemId: 41, caseId: null, toothCode: null });
  });
  it("never turns a native unbridged Ortho identifier into case focus or associates all unlinked work with it", async () => {
    fetchMock.mockResolvedValue(response({ ...payload(), cases: [{ ...savedCase(), id: null, kind: "ortho", specialty: "orthodontics", orthoCaseId: 9 }], items: [item(41, null)] }));
    await readyUI(); click(ui(), "specialty-card-orthodontics"); const tree = ui();
    const card = byTestId(tree, "specialty-case-ortho-9"); expect(allText(card)).toContain("بلا رابط حالة سريرية عامة");
    expect(elements(card).some((row) => String(row.props["data-testid"] ?? "").startsWith("specialty-open-case-"))).toBe(false);
    expect(elements(card).some((row) => row.props["data-testid"] === "specialty-item-41")).toBe(false);
    const open = elements(card).find((row) => row.type === "button" && allText(row).includes("افتح التقويم الأصلي"))!;
    (open.props.onClick as () => void)(); expect(props.onNavigate).toHaveBeenCalledWith("ortho"); expect(props.onFocus).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("renders no hidden item, dependency, price, count or work action even from an overbroad response", async () => {
    fetchMock.mockResolvedValue(response({ ...payload(), planVisible: false, cases: [{ ...savedCase(), itemsTotal: 987654 }], dependencies: [{ note: "HIDDEN DEPENDENCY" }] }));
    await readyUI(); const tree = selectEndo();
    expect(byTestId(tree, "specialty-plan-hidden")).toBeTruthy();
    expect(allText(tree)).not.toMatch(/SYNTHETIC ITEM|SYNTHETIC PLAN|ITEM PROVIDER|987654|HIDDEN DEPENDENCY/);
    expect(elements(tree).some((row) => String(row.props["data-testid"] ?? "").startsWith("specialty-review-visit-item-"))).toBe(false);
  });
  it("strips plan metadata, dependencies and navigation when workflow revokes only plan capability", async () => {
    fetchMock.mockResolvedValue(response({ ...payload(), items: [item(), item(42)],
      dependencies: [{ itemId: 41, requiresItemId: 42, requirement: "completed", met: false, note: "PRIVATE DEPENDENCY" }] }));
    await readyUI(); const before = selectEndo();
    const oldPlan = byTestId(before, "specialty-open-plan-item-41").props.onClick as () => void;
    const oldVisit = byTestId(before, "specialty-review-visit-item-41").props.onClick as () => void;
    const oldDependency = byTestId(before, "specialty-dependency-41-42").props.onClick as () => void;
    const sharedPlan = elements(before).find((row) => row.type === "button" && allText(row) === "الخطة المشتركة")!;
    props.canViewPlans = false; const immediate = ui(false);
    expect(allText(immediate)).not.toMatch(/SYNTHETIC ITEM|SYNTHETIC PLAN|ITEM PROVIDER|PRIVATE DEPENDENCY/);
    oldPlan(); oldVisit(); oldDependency(); (sharedPlan.props.onClick as () => void)();
    expect(props.onFocus).not.toHaveBeenCalled(); expect(props.onNavigate).not.toHaveBeenCalled();
    // Authority, patient and open visit are unchanged, and the server still sends
    // its permitted projection. The independent workflow denial wins.
    ui(); await readyUI(); const denied = ui();
    expect(byTestId(denied, "specialty-plan-hidden")).toBeTruthy();
    expect(allText(denied)).not.toMatch(/SYNTHETIC ITEM|SYNTHETIC PLAN|ITEM PROVIDER|PRIVATE DEPENDENCY/);
    expect(byTestId(denied, "specialty-card-endodontics").props["aria-pressed"]).toBe(true);
    click(denied, "specialty-open-case-5"); expect(props.onFocus).toHaveBeenCalledExactlyOnceWith({ kind: "case", patientId: 91, caseId: 5 });
    const callCount = fetchMock.mock.calls.length; ui(); props = { ...props }; ui();
    expect(fetchMock).toHaveBeenCalledTimes(callCount);
  });
  it("presents network failure as unavailable rather than no cases and removes old private details", async () => {
    await readyUI(); selectEndo(); fetchMock.mockRejectedValue(new Error("network"));
    const retry = elements(ui()).find((row) => row.props["aria-label"] === "تحديث سياق التخصصات")!; (retry.props.onClick as () => void)();
    await vi.waitFor(() => expect(elements(ui()).some((row) => row.props["data-testid"] === "specialty-context-unavailable")).toBe(true));
    expect(allText(ui())).not.toContain("SYNTHETIC CASE"); expect(allText(ui())).not.toContain("لا حالات محفوظة لهذا التخصص");
  });
  it("does not use stale handlers after refresh, permission revocation, inactivity or changed visit", async () => {
    await readyUI(); const old = byTestId(selectEndo(), "specialty-review-visit-item-41").props.onClick as () => void;
    const pending = deferred<Response>(); fetchMock.mockReturnValue(pending.promise);
    const retry = elements(ui()).find((row) => row.props["aria-label"] === "تحديث سياق التخصصات")!;
    (retry.props.onClick as () => void)(); old(); expect(props.onFocus).not.toHaveBeenCalled();
    pending.resolve(response(payload())); await readyUI(); const next = byTestId(ui(), "specialty-review-visit-item-41").props.onClick as () => void;
    props.openVisitId = 22; ui(); next(); expect(props.onFocus).not.toHaveBeenCalled();
    props.authorityKey = "revoked"; fetchMock.mockResolvedValue(response(null, 403)); ui();
    await vi.waitFor(() => expect(elements(ui()).some((row) => row.props["data-testid"] === "specialty-context-denied")).toBe(true));
    next(); expect(props.onFocus).not.toHaveBeenCalled(); props.active = false; expect(ui()).toBeNull(); next(); expect(props.onFocus).not.toHaveBeenCalled();
  });
  it("makes saved history navigable but offers no current-visit review for closed work or no visit", async () => {
    props.openVisitId = null; fetchMock.mockResolvedValue(response({ ...payload(), items: [{ ...item(), status: "done" }] }));
    await readyUI(); const tree = selectEndo();
    expect(byTestId(tree, "specialty-open-plan-item-41")).toBeTruthy();
    expect(elements(tree).some((row) => row.props["data-testid"] === "specialty-review-visit-item-41")).toBe(false);
    expect(allText(tree)).toContain("المراجعة لا يحفظان إجراءً");
  });
});
