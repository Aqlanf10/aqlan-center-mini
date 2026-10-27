import { type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ username: "synthetic-a", values: [] as unknown[], cursor: 0, effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(), pending: [] as (() => void)[] }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = initial; return i; };
  return { ...react,
    useState: (initial: unknown) => { const i = slot(initial); return [hooks.values[i], (value: unknown) => { hooks.values[i] = typeof value === "function" ? value(hooks.values[i]) : value; }]; },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
      const i = hooks.cursor++; const old = hooks.effects.get(i);
      if (old?.deps && old.deps.length === deps.length && old.deps.every((value, index) => Object.is(value, deps[index]))) return;
      const next = { deps, cleanup: undefined as (() => void) | undefined }; hooks.effects.set(i, next);
      hooks.pending.push(() => { old?.cleanup?.(); next.cleanup = effect() || undefined; });
    },
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: hooks.username, role: "reception" }) }));
import { useReturnBookingContext } from "../components/useReturnBookingContext";
type Args = Parameters<typeof useReturnBookingContext>[0];
let args: Args;
function HookHarness({ capture }: { capture: (value: ReturnType<typeof useReturnBookingContext>) => void }) {
  capture(useReturnBookingContext(args));
  return null;
}
function render(next = args) {
  args = next; hooks.cursor = 0;
  const captured: { value?: ReturnType<typeof useReturnBookingContext> } = {};
  renderToStaticMarkup(<HookHarness capture={value => { captured.value = value; }} />);
  hooks.pending.splice(0).forEach(effect => effect());
  if (!captured.value) throw new Error("Hook harness did not render");
  return captured.value;
}
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } return render(); }
const reply = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
const source = { kind: "clinical_case" as const, id: 31 };
const option = { source, label: "علاج عصب — 36", available: true, doctorId: 71, doctorName: "Current source clinician", settingsTarget: { kind: "clinical", id: 31 } };
const success = { ok: true, patientId: 19, source, doctorId: 71, doctorName: "Current source clinician", fingerprint: "a".repeat(64), settingsTarget: option.settingsTarget, label: option.label };
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!node || typeof node !== "object" || !("props" in node)) return []; return [node as Element, ...elements((node as Element).props.children as ReactNode)]; }
function choose(view: ReactNode, value: string) { const select = elements(view).find(node => node.type === "select")!; (select.props.onChange as (event: unknown) => void)({ target: { value } }); }
beforeEach(() => { hooks.username = "synthetic-a"; hooks.values = []; hooks.cursor = 0; hooks.effects.clear(); hooks.pending = []; args = { patientId: 19, enabled: true }; });
afterEach(() => { hooks.effects.forEach(effect => effect.cleanup?.()); vi.unstubAllGlobals(); });
describe("shared current-responsibility return booking UI", () => {
  it("requires an exact clinical context choice, not an arbitrary doctor", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply({ contexts: [option] })).mockResolvedValueOnce(reply(success)); vi.stubGlobal("fetch", fetcher);
    render(); const listed = await flush(); expect(listed.ready).toBe(false); choose(listed.view, "clinical_case:31"); render();
    const selected = await flush(); expect(selected.ready).toBe(true);
    expect(fetcher.mock.calls[1][0]).toBe("/api/patients/19/return-booking-context?kind=clinical_case&sourceId=31");
    expect(selected.payload).toEqual({ returnBookingSource: source, returnBookingFingerprint: "a".repeat(64) });
    const html = renderToStaticMarkup(selected.view); expect(html).toContain("Current source clinician"); expect(html).not.toContain('value="71"');
  });
  it("retains intrinsic lab provenance when choosing only a linked context supplied by the resolver", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply({ ok: false, code: "return_source_ambiguous", message: "اختر الحالة", contexts: [option, { ...option, source: { kind: "clinical_case", id: 32 }, label: "ثانية" }] }, 409))
      .mockResolvedValueOnce(reply(success)); vi.stubGlobal("fetch", fetcher);
    render({ patientId: 19, source: { kind: "lab_work", id: 50 }, enabled: true });
    const listed = await flush(); choose(listed.view, "clinical_case:31"); render(); const selected = await flush();
    expect(fetcher.mock.calls[1][0]).toContain("originKind=lab_work&originId=50");
    expect(selected.payload).toMatchObject({ returnBookingOrigin: { kind: "lab_work", id: 50 }, returnBookingSource: source });
  });
  it("missing or inactive owner blocks the booking and links exact-case settings, with no doctor roster", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ ok: false, code: "responsibility_missing", message: "الطبيب المسؤول غير محدد", contexts: [{ ...option, available: false, doctorId: null, doctorName: null }] }, 409)));
    render({ patientId: 19, source, enabled: true }); const result = await flush(); expect(result.ready).toBe(false); expect(result.payload).toEqual({});
    const html = renderToStaticMarkup(result.view); expect(html).toContain("clinicalCaseId=31"); expect(html).not.toContain("<select");
  });
  it("retires a stale owner fingerprint immediately and requires a fresh server read", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply(success)).mockResolvedValueOnce(reply({ ...success, doctorId: 72, doctorName: "New current clinician", fingerprint: "b".repeat(64) })); vi.stubGlobal("fetch", fetcher);
    render({ patientId: 19, source, enabled: true }); const first = await flush(); first.handleRejection({ code: "return_booking_source_changed" });
    expect(first.isCurrent()).toBe(false); expect(render().ready).toBe(false); const next = await flush();
    expect(next.payload).toMatchObject({ returnBookingFingerprint: "b".repeat(64) });
    expect(renderToStaticMarkup(next.view)).toContain("New current clinician");
  });
  it("does not display or use another patient's verified response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ ...success, patientId: 20 })));
    render({ patientId: 19, source, enabled: true }); const result = await flush(); expect(result.ready).toBe(false);
    expect(renderToStaticMarkup(result.view)).not.toContain("Current source clinician");
  });
  it("does not offer a forged context choice that was not returned by the resolver", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply({ contexts: [option] })); vi.stubGlobal("fetch", fetcher);
    render(); const result = await flush(); choose(result.view, "clinical_case:999"); render(); await flush();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(render().ready).toBe(false);
  });
  it("retires verified context immediately when the authenticated principal changes", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(success)); vi.stubGlobal("fetch", fetcher);
    render({ patientId: 19, source, enabled: true }); const old = await flush(); expect(old.ready).toBe(true);
    hooks.username = "synthetic-b"; const changed = render(); expect(changed.ready).toBe(false); expect(old.isCurrent()).toBe(false);
    expect(renderToStaticMarkup(changed.view)).not.toContain("Current source clinician");
    await flush(); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("withdraws previously-listed case details when a subsequent context read is denied", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply({ contexts: [option] })).mockResolvedValueOnce(reply({ message: "denied" }, 403)); vi.stubGlobal("fetch", fetcher);
    render(); const listed = await flush(); expect(renderToStaticMarkup(listed.view)).toContain(option.label);
    choose(listed.view, "clinical_case:31"); render(); const denied = await flush();
    expect(denied.ready).toBe(false); expect(renderToStaticMarkup(denied.view)).not.toContain(option.label);
    expect(renderToStaticMarkup(denied.view)).not.toContain("Current source clinician");
  });

});
