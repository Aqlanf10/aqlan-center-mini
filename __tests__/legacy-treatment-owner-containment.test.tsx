import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyCaseBanner } from "../components/LegacyCaseBanner";
import { LegacyTreatmentAgreements } from "../components/LegacyTreatmentAgreements";
import { LegacyTreatmentForm } from "../components/LegacyTreatmentForm";

type Frame = { values: unknown[]; cursor: number; effects: (() => void | (() => void))[]; cleanups: (() => void)[] };
const runtime = vi.hoisted(() => ({ frame: null as Frame | null,
  session: { username: "admin-a", role: "admin", permissions: null } as { username: string; role: string; permissions: unknown } | null }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => runtime.session }));
vi.mock("../components/ServiceSelect", () => ({ ServiceSelect: "mock-service-select" }));
vi.mock("../components/dental/ToothSelectionDialog", () => ({ ToothSelectionDialog: "mock-tooth-dialog" }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const effect = (callback: () => void | (() => void)) => { runtime.frame!.effects.push(callback); };
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
    useMemo: (factory: () => unknown) => factory(), useCallback: (callback: unknown) => callback,
    useEffect: effect, useLayoutEffect: effect,
  };
});

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function words(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(words).join(" ");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node && typeof node === "object" && "props" in node ? words((node as Element).props.children as ReactNode) : "";
}
function mount(owner: ReactElement) {
  const frame: Frame = { values: [], cursor: 0, effects: [], cleanups: [] };
  const render = () => { runtime.frame = frame; frame.cursor = 0; frame.effects = [];
    return (owner.type as (props: unknown) => ReactElement)(owner.props); };
  const tree = render();
  for (const effect of frame.effects) { const cleanup = effect(); if (cleanup) frame.cleanups.push(cleanup); }
  return { tree, frame, render, unmount: () => { for (const cleanup of frame.cleanups) cleanup(); } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const flush = async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); };
const row = { id: 5, patientId: 7, serviceName: "Historical root canal", specialtyLabel: "علاج جذور", toothCode: 36,
  caseTitle: "Historical case", currency: "YER", agreedMinor: 300_000, previouslyPaidMinor: 120_000,
  remainingMinor: 180_000, historicalAsOf: "2026-09-30", openingEffect: "created", status: "live",
  createdBy: "admin", voidReason: null };
const payload = { agreements: [row], access: { void: true } };
const impact = (mode: "ordinary" | "manager_authorized" = "ordinary", collections = 0) => ({ version: 1, mode,
  patientId: 7, agreementId: 5, currency: "YER", openingPrincipalBeforeMinor: 220_000, removedPrincipalMinor: 180_000,
  openingPrincipalAfterMinor: 40_000, netCollectionsMinor: collections, remainingDueBeforeMinor: 220_000 - collections,
  remainingDueAfterMinor: Math.max(0, 40_000 - collections), ordinaryAllowed: collections === 0,
  managerAuthorizedAllowed: collections <= 40_000, canVoid: mode === "ordinary" ? collections === 0 : collections <= 40_000,
  refusal: mode === "ordinary" && collections > 0 ? "opening_collected" : collections > 40_000 ? "opening_settled" : null,
  financialReviewRequired: true, previewToken: (mode === "ordinary" ? "a" : "b").repeat(64) });
const okay = (value: unknown) => ({ ok: true, json: async () => value });
const form = (patientId = 7) => ({ patientId, base: "YER" as const, services: [{ id: 9, name: "Bridge", category: "bridge", priceMinor: 100 }],
  busy: false, onSubmit: vi.fn(), onCancel: vi.fn() });

beforeEach(() => {
  runtime.session = { username: "admin-a", role: "admin", permissions: null };
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("legacy UI read and patient ownership", () => {
  it("uses new owners across patient, principal, and permission snapshots on every new legacy surface", () => {
    const factories = [
      (patientId: number) => LegacyTreatmentAgreements({ patientId, refreshKey: 0, onChanged: vi.fn() }),
      (patientId: number) => LegacyTreatmentForm(form(patientId)),
    ];
    for (const make of factories) {
      runtime.session = { username: "admin-a", role: "admin", permissions: null };
      const key = (make(7) as ReactElement).key;
      expect((make(8) as ReactElement).key).not.toBe(key);
      runtime.session = { username: "admin-b", role: "admin", permissions: null };
      expect((make(7) as ReactElement).key).not.toBe(key);
      runtime.session = { username: "admin-a", role: "admin", permissions: { canViewPatientPayments: false } };
      expect((make(7) as ReactElement).key).not.toBe(key);
      runtime.session = null; expect(make(7)).toBeNull();
    }
  });
  it("retires agreement data at denied headers without waiting for the body and ignores an older successful body", async () => {
    const oldBody = deferred<unknown>();
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: () => oldBody.promise })
      .mockResolvedValueOnce({ ok: false, status: 403, json: () => new Promise(() => undefined) });
    vi.stubGlobal("fetch", fetcher);
    const view = mount(LegacyTreatmentAgreements({ patientId: 7, refreshKey: 0, onChanged: vi.fn() }) as ReactElement);
    await flush();
    window.dispatchEvent(new Event("focus")); await flush();
    expect(words(view.render())).toContain("غير مصرّح");
    oldBody.resolve(payload); await flush();
    const tree = view.render();
    expect(words(tree)).toContain("غير مصرّح");
    expect(words(tree)).not.toContain(row.serviceName);
    expect(elements(tree).some((node) => node.props.children === "إبطال الاتفاق")).toBe(false);
    view.unmount();
  });
  it("renders accepted legacy projections without owning a read or mutation grant", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const tree = LegacyCaseBanner({ cases: [{ id: 12, kind: "specialty", orthoCaseId: null, patientId: 7,
      specialty: "endodontics", title: "Current legacy case", site: "36", status: "active", legacy: true }], specialty: "endodontics" });
    expect(words(tree)).toContain("Current legacy case");
    expect(words(tree)).toContain("يمكن حفظ المسودة");
    expect(LegacyCaseBanner({ cases: [], specialty: "endodontics" })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("prevents duplicate void submission and ignores its result after the patient owner is gone", async () => {
    const pending = deferred<unknown>();
    const fetcher = vi.fn().mockResolvedValueOnce(okay(payload)).mockResolvedValueOnce(okay({ preview: impact() })).mockReturnValueOnce(pending.promise);
    vi.stubGlobal("fetch", fetcher);
    const changed = vi.fn();
    const view = mount(LegacyTreatmentAgreements({ patientId: 7, refreshKey: 0, onChanged: changed }) as ReactElement);
    await flush();
    const button = elements(view.render()).find((node) => words(node.props.children as ReactNode).trim() === "إبطال الاتفاق" && node.type === "button")!;
    (button.props.onClick as () => void)(); await flush();
    const reason = elements(view.render()).find((node) => node.props["aria-label"] === "سبب إبطال الاتفاق التاريخي")!;
    (reason.props.onChange as (event: unknown) => void)({ target: { value: "Duplicate historical record" } });
    const confirm = elements(view.render()).find((node) => node.type === "button" && node.props.children === "تأكيد الإبطال")!;
    (confirm.props.onClick as () => void)(); (confirm.props.onClick as () => void)();
    expect(fetcher).toHaveBeenCalledTimes(3); // one agreement read, one financial preview, one command
    view.unmount(); pending.resolve({ ok: true, json: async () => ({}) }); await flush();
    expect(changed).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("requires a separately selected administrative preview and retires it on focus", async () => {
    const reread = deferred<unknown>();
    const fetcher = vi.fn().mockResolvedValueOnce(okay(payload)).mockResolvedValueOnce(okay({ preview: impact("ordinary", 30_000) }))
      .mockResolvedValueOnce(okay({ preview: impact("manager_authorized", 30_000) })).mockReturnValueOnce(reread.promise);
    vi.stubGlobal("fetch", fetcher);
    const view = mount(LegacyTreatmentAgreements({ patientId: 7, refreshKey: 0, onChanged: vi.fn() }) as ReactElement);
    await flush();
    const open = elements(view.render()).find((node) => node.type === "button" && words(node).trim() === "إبطال الاتفاق")!;
    (open.props.onClick as () => void)(); await flush();
    const input = elements(view.render()).find((node) => node.props["aria-label"] === "سبب إبطال الاتفاق التاريخي")!;
    (input.props.onChange as (event: unknown) => void)({ target: { value: "Explicit aggregate review" } });
    const ordinaryConfirm = elements(view.render()).find((node) => node.type === "button" && node.props.children === "تأكيد الإبطال")!;
    expect(ordinaryConfirm.props.disabled).toBe(true);
    (ordinaryConfirm.props.onClick as () => void)(); expect(fetcher).toHaveBeenCalledTimes(2);
    const radios = elements(view.render()).filter((node) => node.type === "input" && node.props.type === "radio");
    (radios[1].props.onChange as () => void)(); await flush();
    const ready = view.render();
    expect(words(ready)).toContain("الأثر على إجمالي الرصيد السابق");
    expect(words(ready)).toContain("لا تُنسب إلى هذا الاتفاق تخمينًا");
    const managerConfirm = elements(ready).find((node) => node.type === "button" && node.props.children === "تأكيد الإبطال")!;
    expect(managerConfirm.props.disabled).toBe(false);
    window.dispatchEvent(new Event("focus"));
    (managerConfirm.props.onClick as () => void)(); // Even a stale event closure has lost preview authority.
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(words(view.render())).not.toContain("الأثر على إجمالي الرصيد السابق");
    reread.resolve(okay(payload)); await flush();
    expect(words(view.render())).not.toContain("سبب إبطال الاتفاق التاريخي");
    view.unmount();
  });
  it("ignores a pending preview after Close and a superseded mode response", async () => {
    const oldPreview = deferred<unknown>();
    const fetcher = vi.fn().mockResolvedValueOnce(okay(payload)).mockResolvedValueOnce({ ok: true, json: () => oldPreview.promise })
      .mockResolvedValueOnce(okay({ preview: impact("manager_authorized", 30_000) }));
    vi.stubGlobal("fetch", fetcher);
    const view = mount(LegacyTreatmentAgreements({ patientId: 7, refreshKey: 0, onChanged: vi.fn() }) as ReactElement);
    await flush();
    const open = elements(view.render()).find((node) => node.type === "button" && words(node).trim() === "إبطال الاتفاق")!;
    (open.props.onClick as () => void)(); await flush();
    const radios = elements(view.render()).filter((node) => node.type === "input" && node.props.type === "radio");
    (radios[1].props.onChange as () => void)(); await flush();
    oldPreview.resolve({ preview: impact() }); await flush();
    expect(elements(view.render()).filter((node) => node.type === "input" && node.props.type === "radio")[1].props.checked).toBe(true);
    const close = elements(view.render()).find((node) => node.type === "button" && node.props.children === "تراجع")!;
    (close.props.onClick as () => void)();
    expect(elements(view.render()).some((node) => node.props["data-testid"] === "legacy-void-impact-preview")).toBe(false);
    view.unmount();
  });
  it("never revives a dismissed preview or displays forbidden preview data", async () => {
    const pending = deferred<unknown>();
    const fetcher = vi.fn().mockResolvedValueOnce(okay(payload)).mockResolvedValueOnce({ ok: true, json: () => pending.promise })
      .mockResolvedValueOnce({ ok: false, status: 403, json: () => new Promise(() => undefined) });
    vi.stubGlobal("fetch", fetcher);
    const view = mount(LegacyTreatmentAgreements({ patientId: 7, refreshKey: 0, onChanged: vi.fn() }) as ReactElement);
    await flush();
    const open = () => elements(view.render()).find((node) => node.type === "button" && words(node).trim() === "إبطال الاتفاق")!;
    (open().props.onClick as () => void)(); await flush();
    const close = elements(view.render()).find((node) => node.type === "button" && node.props.children === "تراجع")!;
    (close.props.onClick as () => void)(); pending.resolve({ preview: impact() }); await flush();
    expect(elements(view.render()).some((node) => node.props["data-testid"] === "legacy-void-impact-preview")).toBe(false);
    (open().props.onClick as () => void)(); await flush();
    expect(words(view.render())).toContain("غير مصرّح");
    expect(words(view.render())).not.toContain(row.serviceName);
    view.unmount();
  });
  it("does not revive stale confirm or open callbacks when an unchanged fingerprint is read again", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(okay(payload)).mockResolvedValueOnce(okay({ preview: impact() }))
      .mockResolvedValueOnce(okay({ preview: impact() }));
    vi.stubGlobal("fetch", fetcher);
    const view = mount(LegacyTreatmentAgreements({ patientId: 7, refreshKey: 0, onChanged: vi.fn() }) as ReactElement);
    await flush();
    const open = () => elements(view.render()).find((node) => node.type === "button" && words(node).trim() === "إبطال الاتفاق")!;
    const oldOpen = open();
    (oldOpen.props.onClick as () => void)(); await flush();
    const input = elements(view.render()).find((node) => node.props["aria-label"] === "سبب إبطال الاتفاق التاريخي")!;
    (input.props.onChange as (event: unknown) => void)({ target: { value: "Old confirmation reason" } });
    const oldConfirm = elements(view.render()).find((node) => node.type === "button" && node.props.children === "تأكيد الإبطال")!;
    const close = elements(view.render()).find((node) => node.type === "button" && node.props.children === "تراجع")!;
    (close.props.onClick as () => void)();
    (oldOpen.props.onClick as () => void)(); expect(fetcher).toHaveBeenCalledTimes(2);
    (open().props.onClick as () => void)(); await flush();
    (oldConfirm.props.onClick as () => void)();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    view.unmount();
  });
  it.each(["crown", "bridge", "veneer"])("preserves the entire %s episode in one selection without narrowing or multiplying", (category) => {
    vi.stubGlobal("fetch", vi.fn());
    const props = { ...form(), services: [{ id: 9, name: "Full episode", category, priceMinor: 100 }] };
    const view = mount(LegacyTreatmentForm(props) as ReactElement);
    const select = elements(view.render()).find((node) => node.props.ariaLabel === "الخدمة العلاجية")!;
    (select.props.onChange as (id: number) => void)(9);
    const open = elements(view.render()).find((node) => node.props["data-testid"] === "legacy-tooth-button")!;
    (open.props.onClick as () => void)();
    const dialog = elements(view.render()).find((node) => node.type === "mock-tooth-dialog")!;
    expect(dialog.props.purpose).toBe("legacy_agreement");
    (dialog.props.onConfirm as (selection: unknown) => void)({ teeth: [16, 14, 15], surfaces: "", scope: null });
    const tree = view.render();
    const chip = elements(tree).find((node) => node.props["data-testid"] === "legacy-tooth-chip")!;
    expect(words(chip)).toContain("14"); expect(words(chip)).toContain("15"); expect(words(chip)).toContain("16");
    expect(words(tree)).toContain("الحلقة كاملةً اتفاق واحد وبند واحد");
    expect(words(tree)).toContain("لا يُضربان بعدد الأسنان");
    expect(elements(tree).some((node) => node.props["data-testid"] === "legacy-tooth-problem")).toBe(false);
    expect(props.onSubmit).not.toHaveBeenCalled(); view.unmount();
  });
  it.each(["rct", "implant", "extraction"])("retains the shared per-tooth split refusal for %s", (category) => {
    vi.stubGlobal("fetch", vi.fn());
    const props = { ...form(), services: [{ id: 9, name: "Per tooth", category, priceMinor: 100 }] };
    const view = mount(LegacyTreatmentForm(props) as ReactElement);
    const select = elements(view.render()).find((node) => node.props.ariaLabel === "الخدمة العلاجية")!;
    (select.props.onChange as (id: number) => void)(9);
    const open = elements(view.render()).find((node) => node.props["data-testid"] === "legacy-tooth-button")!;
    (open.props.onClick as () => void)();
    const dialog = elements(view.render()).find((node) => node.type === "mock-tooth-dialog")!;
    (dialog.props.onConfirm as (selection: unknown) => void)({ teeth: [14, 15, 16], surfaces: "", scope: null });
    const tree = view.render();
    expect(words(tree)).toContain("اتفاقٌ مستقل لكل سن");
    const save = elements(tree).find((node) => node.type === "button" && words(node.props.children as ReactNode) === "احفظ العلاج السابق")!;
    expect(save.props.disabled).toBe(true);
    (save.props.onClick as () => void)(); expect(props.onSubmit).not.toHaveBeenCalled(); view.unmount();
  });
  it("renders old missing coverage as unknown and all verified teeth without additional requests", async () => {
    const episode = { mode: "multi_tooth_episode", toothCode: 14, surfaces: null, episodeTeeth: [14, 15, 16], scope: null };
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ agreements: [
      row, { ...row, id: 6, toothCode: 14, coverageState: "verified", coverageSite: episode },
    ], access: { void: false } }) });
    vi.stubGlobal("fetch", fetcher);
    const view = mount(LegacyTreatmentAgreements({ patientId: 7, refreshKey: 0, onChanged: vi.fn() }) as ReactElement);
    await flush(); const tree = view.render();
    expect(words(tree)).toContain("نطاق التغطية التاريخية غير معلوم");
    expect(words(tree)).toContain("أسنان الحلقة: 14، 15، 16");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(elements(tree).some((node) => node.type === "button")).toBe(false);
    view.unmount();
  });
});
