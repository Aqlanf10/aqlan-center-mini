import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VitalsModal } from "../components/VitalsModal";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: new Map<number, readonly unknown[]>(), pending: [] as Array<() => void> }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  return { ...react,
    useState: (initial: unknown) => {
      const index = slot(initial); return [hooks.values[index], (value: unknown) => { hooks.values[index] = value; }];
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useEffect: (callback: () => void, deps: readonly unknown[]) => {
      const index = slot(undefined), previous = hooks.effects.get(index);
      if (previous && previous.length === deps.length && previous.every((value, i) => Object.is(value, deps[i]))) return;
      hooks.effects.set(index, deps); hooks.pending.push(callback);
    },
  };
});
type Element = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...nodes(element.props.children as ReactNode)];
}
let props: Parameters<typeof VitalsModal>[0];
const fetchMock = vi.fn();
function render() {
  hooks.cursor = 0; const tree = VitalsModal(props); hooks.pending.splice(0).forEach(effect => effect()); return nodes(tree);
}
async function save() {
  render(); const form = render().find(node => node.type === "form")!;
  await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault: () => {} }); render();
}
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects.clear(); hooks.pending = [];
  vi.clearAllMocks(); vi.stubGlobal("fetch", fetchMock);
  props = { isOpen: true, patientId: 91, patientName: "مريض اختبار", currentMedicalAlert: "تنبيه مكتوب في النموذج", onSaved: vi.fn(), onClose: vi.fn() };
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("VitalsModal confirms only canonical successful response values", () => {
  it.each(["PATCH", "POST"])("uses the %s response value rather than its submitted form guess", async method => {
    if (method === "POST") props.currentMedicalAlert = "[VITALS: BP=120/80] تنبيه النموذج";
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...(method === "POST" ? { patientId: 91 } : { id: 91 }), medicalAlert: "تنبيه استجابة الخادم" }) });
    await save(); expect(fetchMock.mock.calls[0][1].method).toBe(method);
    expect(props.onSaved).toHaveBeenCalledExactlyOnceWith("تنبيه استجابة الخادم", expect.any(Object));
    expect(props.onClose).toHaveBeenCalledOnce();
  });
  it.each(["missing", "foreign", "bad-type", "body-failure"])("never confirms or repeats a successful but %s outcome", async kind => {
    props.currentMedicalAlert = "[VITALS: BP=120/80] تنبيه النموذج";
    fetchMock.mockResolvedValue({ ok: true, json: async () => {
      if (kind === "body-failure") throw new Error("synthetic malformed body");
      return { patientId: kind === "foreign" ? 92 : 91, ...(kind === "missing" ? {} : { medicalAlert: kind === "bad-type" ? {} : "تنبيه خاطئ" }) };
    } });
    await save(); await save();
    expect(fetchMock).toHaveBeenCalledOnce(); expect(props.onSaved).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
    expect(render().find(node => node.type === "button" && node.props.type === "submit")?.props.disabled).toBe(true);
  });
  it("does not confirm failed writes and allows correction after an explicit refusal", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ message: "رفض تجريبي" }) });
    await save(); expect(props.onSaved).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 91, medicalAlert: null }) });
    await save(); expect(fetchMock).toHaveBeenCalledTimes(2); expect(props.onSaved).toHaveBeenCalledExactlyOnceWith(null, expect.any(Object));
  });
});
