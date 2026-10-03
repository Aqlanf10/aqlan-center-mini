import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientIdentityEditor } from "../components/patient-workspace/PatientIdentityEditor";
import type { Patient } from "../lib/patient";

const state = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(), pending: [] as Array<() => void> }));
vi.mock("../components/SettingsProvider", () => ({ useSetting: () => "توصية مريض,طبيب" }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = state.cursor++; if (!(index in state.values)) state.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  return { ...react,
    useState: (initial: unknown) => { const index = slot(typeof initial === "function" ? initial() : initial); return [state.values[index], (value: unknown) => { state.values[index] = typeof value === "function" ? value(state.values[index]) : value; }]; },
    useRef: (initial: unknown) => state.values[slot({ current: initial })],
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = slot(undefined); const previous = state.effects.get(index); if (previous && same(previous.deps, deps)) return; state.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); state.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); }); },
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = slot(undefined); const previous = state.effects.get(index); if (previous && same(previous.deps, deps)) return; state.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); state.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); }); },
  };
});
const patient: Patient = { id: 501, patientNumber: "IDENTITY-501", fullName: "مريض اختباري", phone: "000000000", altPhone: null, gender: "unknown", birthYear: 1990, birthDate: "1990-02-03", address: "saved address", medicalAlert: "saved alert", note: null, createdAt: "2026-10-03" };
let props: Parameters<typeof PatientIdentityEditor>[0];
const response = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function render() {
  state.cursor = 0; const wrapper = PatientIdentityEditor(props);
  const Draft = wrapper.type as (value: typeof props) => ReactElement<Record<string, unknown>>;
  const result = Draft(wrapper.props); state.pending.splice(0).forEach((effect) => effect()); return result;
}
function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? textOf(node.props.children) : "";
}
function field(label: string) {
  const match = elements(render()).find((node) => node.type === "label" && textOf(node.props.children as ReactNode).startsWith(label));
  return elements(match).find((node) => ["input", "select", "textarea"].includes(String(node.type)))!;
}
function change(label: string, value: string) { (field(label).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); }
function submit(tree = render()) { (tree.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() }); }
async function settle() { await vi.advanceTimersByTimeAsync(0); }
beforeEach(() => {
  vi.useFakeTimers(); state.values = []; state.effects.clear(); state.pending = [];
  props = { patient: { ...patient }, onSaved: vi.fn(), onError: vi.fn() };
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), confirm: vi.fn(() => true) });
  vi.stubGlobal("fetch", vi.fn(async () => response({ ...patient, fullName: "اسم معدّل" })));
});
afterEach(() => { state.effects.forEach((effect) => effect.cleanup?.()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("reconstructed identity editor handlers", () => {
  it("sends only changed fields to the real patient PATCH owner", async () => {
    render(); change("الاسم الكامل", "اسم معدّل"); submit(); await settle();
    expect(fetch).toHaveBeenCalledOnce(); expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/patients/501");
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ fullName: "اسم معدّل" }); expect(props.onSaved).toHaveBeenCalledOnce();
  });
  it("does not allow repeated same-render submissions while the first write is pending", async () => {
    render(); change("الاسم الكامل", "اسم معدّل"); const pending = deferred<ReturnType<typeof response>>(); vi.mocked(fetch).mockReturnValue(pending.promise as unknown as Promise<Response>);
    const tree = render(); submit(tree); submit(tree); expect(fetch).toHaveBeenCalledOnce();
    pending.resolve(response({ ...patient, fullName: "اسم معدّل" })); await settle();
  });
  it("preserves a draft but refuses stale writes after a remote identity change", async () => {
    render(); change("الاسم الكامل", "اسم معدّل"); props = { ...props, patient: { ...patient, medicalAlert: "newly saved elsewhere" } };
    submit(); await settle(); expect(fetch).not.toHaveBeenCalled(); expect(field("الاسم الكامل").props.value).toBe("اسم معدّل");
  });
  it("keeps date/year coupled without inventing a full date", () => {
    render(); change("سنة الميلاد", "1991"); expect(field("تاريخ الميلاد").props.value).toBe("");
    change("تاريخ الميلاد", "1992-04-05"); expect(field("سنة الميلاد").props.value).toBe("1992");
  });
  it("cancel resets locally without writing the record", () => {
    render(); change("الاسم الكامل", "اسم معدّل");
    const cancel = elements(render()).find((node) => node.type === "button" && textOf(node.props.children as ReactNode) === "إلغاء التعديلات")!;
    (cancel.props.onClick as () => void)(); expect(field("الاسم الكامل").props.value).toBe(patient.fullName); expect(fetch).not.toHaveBeenCalled();
  });
  it("does not publish an old response after the editing owner unmounts", async () => {
    render(); change("الاسم الكامل", "اسم معدّل"); const pending = deferred<ReturnType<typeof response>>(); vi.mocked(fetch).mockReturnValue(pending.promise as unknown as Promise<Response>);
    submit(); state.effects.forEach((effect) => effect.cleanup?.()); pending.resolve(response({ ...patient, fullName: "اسم معدّل" })); await settle(); expect(props.onSaved).not.toHaveBeenCalled();
  });
  it("blocks repeat writes after an unknown transport result and never claims cancellation", async () => {
    render(); change("الاسم الكامل", "اسم معدّل"); vi.mocked(fetch).mockRejectedValue(new Error("offline")); submit(); await settle(); submit(); await settle();
    expect(fetch).toHaveBeenCalledOnce(); expect(props.onSaved).not.toHaveBeenCalled(); expect(textOf(render())).toContain("نتيجة الحفظ غير مؤكّدة");
  });
});
