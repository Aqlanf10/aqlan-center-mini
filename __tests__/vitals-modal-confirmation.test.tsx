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
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const submitDisabled = () => render().find(node => node.type === "button" && node.props.type === "submit")?.props.disabled;
const reconciliationWarning = () => JSON.stringify(render().map(node => node.props.children)).includes("حُفظ الطلب لكن تعذّر التحقق من التنبيه");
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
  it("keeps the uncertain-success POST latch and warning when the same open patient receives a new alert prop", async () => {
    props.currentMedicalAlert = "[VITALS: BP=120/80] قبل الحفظ";
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ patientId: 91 }) });
    await save();
    props.currentMedicalAlert = "[VITALS: BP=140/85] قراءة الملف المتأخرة";
    render(); render();
    expect(submitDisabled()).toBe(true); expect(reconciliationWarning()).toBe(true);
    await save();
    expect(fetchMock).toHaveBeenCalledOnce(); expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(props.onSaved).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
  });
  it("does not reopen the POST latch when a delayed parent GET settles between success headers and an unverified response body", async () => {
    props.currentMedicalAlert = "[VITALS: BP=120/80] قبل الحفظ";
    const responseBody = deferred<unknown>(), parentGet = deferred<string>();
    fetchMock.mockResolvedValue({ ok: true, json: () => responseBody.promise });
    const getCompletion = parentGet.promise.then(alert => { props.currentMedicalAlert = alert; render(); render(); });
    const pendingSave = save();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();
    parentGet.resolve("[VITALS: BP=145/90] تحذير من قراءة بدأت قبل الحفظ");
    await getCompletion;
    responseBody.resolve({ patientId: 91 });
    await pendingSave;
    expect(submitDisabled()).toBe(true); expect(reconciliationWarning()).toBe(true);
    await save();
    expect(fetchMock).toHaveBeenCalledOnce(); expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(props.onSaved).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
  });
  it.each(["reopen", "new-patient"])("resets uncertain success only for a new modal lifetime: %s", async lifetime => {
    props.currentMedicalAlert = "[VITALS: BP=120/80] قبل الحفظ";
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ patientId: 91 }) });
    await save(); expect(submitDisabled()).toBe(true);
    if (lifetime === "reopen") { props.isOpen = false; render(); props.isOpen = true; }
    else props.patientId = 92;
    props.currentMedicalAlert = "[VITALS: BP=130/85] قراءة جديدة";
    render(); render();
    expect(submitDisabled()).toBe(false); expect(reconciliationWarning()).toBe(false);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ patientId: props.patientId, medicalAlert: "استجابة مؤكدة جديدة" }) });
    await save();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/patients/${props.patientId}/vitals`);
    expect(props.onSaved).toHaveBeenCalledExactlyOnceWith("استجابة مؤكدة جديدة", expect.any(Object));
  });
});
