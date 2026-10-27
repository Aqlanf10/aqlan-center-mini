import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PatientResponsibilitySettings from "../components/PatientResponsibilitySettings";
type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void };
type Frame = { slots: Slot[]; cursor: number; effects: (() => void)[] };
const runtime = vi.hoisted(() => ({ frame: null as Frame | null, role: "admin" }));
// Deterministic handler/hook harness, not browser/DOM/visual evidence.
vi.mock("react", async original => {
 const react = await original<typeof import("react")>();
 const slot = () => { const f = runtime.frame!; const i = f.cursor++; return f.slots[i] ?? (f.slots[i] = {}); };
 return { ...react, useId: () => "synthetic-setting",
  useState: (initial: unknown) => { const s = slot(); if (!("value" in s)) s.value = initial; return [s.value, (next: unknown) => { s.value = next; }]; },
  useRef: (initial: unknown) => { const s = slot(); if (!s.value) s.value = { current: initial }; return s.value; },
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => { const s = slot(); if (!s.deps || !deps || deps.some((v, i) => !Object.is(v, s.deps![i]))) { s.deps = deps; runtime.frame!.effects.push(() => { s.cleanup?.(); s.cleanup = fn() || undefined; }); } },
 };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ role: runtime.role, username: "synthetic" }) }));
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!node || typeof node !== "object" || !("props" in node)) return []; const e = node as Element; return [e, ...elements(e.props.children as ReactNode)]; }
function words(node: ReactNode): string { if (Array.isArray(node)) return node.map(words).join(" "); if (typeof node === "string" || typeof node === "number") return String(node); return node && typeof node === "object" && "props" in node ? words((node as Element).props.children as ReactNode) : ""; }
const turns = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const data = { patientId: 19, kind: "clinical", sourceId: 3, doctorId: 7, doctorName: "Synthetic original", sourceFingerprint: "a".repeat(64), doctors: [{ id: 7, name: "Synthetic original" }, { id: 9, name: "Synthetic incoming" }] };
const fetchMock = vi.fn();
function mount() {
 const frame: Frame = { slots: [], cursor: 0, effects: [] };
 const render = () => { runtime.frame = frame; frame.cursor = 0; const outer = PatientResponsibilitySettings({ patientId: 19, kind: "clinical", sourceId: 3 }); if (!outer) return null; const tree = (outer.type as (props: unknown) => ReactNode)(outer.props); frame.effects.splice(0).forEach(fn => fn()); return tree; };
 const find = (type: string, text?: string) => elements(render()).find(e => e.type === type && (!text || words(e.props.children as ReactNode) === text))!;
 const click = (text: string) => (find("button", text).props.onClick as () => void)();
 const change = (type: string, value: string) => (find(type).props.onChange as (e: unknown) => void)({ target: { value } });
 return { render, find, click, change, unmount: () => frame.slots.forEach(s => s.cleanup?.()) };
}
beforeEach(() => { runtime.role = "admin"; vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); fetchMock.mockResolvedValue({ ok: true, json: async () => data }); });
afterEach(() => vi.unstubAllGlobals());
it.each(["doctor", "reception"])("does not expose reassignment controls to %s", role => { runtime.role = role; expect(mount().render()).toBeNull(); expect(fetchMock).not.toHaveBeenCalled(); });
it("submits exact case settings with reason and displayed source fingerprint", async () => {
 const f = mount(); f.click("إعداد الطبيب المسؤول"); await turns(); f.change("select", "9"); f.change("textarea", "Synthetic transfer"); f.click("حفظ المسؤولية"); await turns();
 expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ kind: "clinical", sourceId: 3, expectedSourceFingerprint: data.sourceFingerprint, doctorId: 9, reason: "Synthetic transfer" });
});
it("preserves selection and reason when stale-source save is rejected", async () => {
 fetchMock.mockResolvedValueOnce({ ok: true, json: async () => data }).mockResolvedValueOnce({ ok: false, json: async () => ({ message: "Synthetic source changed" }) });
 const f = mount(); f.click("إعداد الطبيب المسؤول"); await turns(); f.change("select", "9"); f.change("textarea", "Keep draft"); f.click("حفظ المسؤولية"); await turns();
 expect(words(f.render())).toContain("Synthetic source changed"); expect(f.find("textarea").props.value).toBe("Keep draft"); expect(f.find("select").props.value).toBe("9");
});
it("single-flight guards repeated save clicks", async () => { const f = mount(); f.click("إعداد الطبيب المسؤول"); await turns(); f.change("select", "9"); f.change("textarea", "Synthetic reason"); fetchMock.mockImplementation(() => new Promise(() => {})); f.click("حفظ المسؤولية"); f.click("حفظ المسؤولية"); expect(fetchMock).toHaveBeenCalledTimes(2); });
it("opens an unassigned case on the server's suggestion and saves only on the admin's confirmation", async () => {
 const unassigned = { ...data, doctorId: null, doctorName: null, suggestion: { doctorId: 9, doctorName: "Synthetic incoming", basis: "plan_items" }, suggestionNote: null };
 fetchMock.mockResolvedValue({ ok: true, json: async () => unassigned });
 const f = mount(); f.click("إعداد الطبيب المسؤول"); await turns();
 expect(fetchMock).toHaveBeenCalledTimes(1);
 const note = elements(f.render()).find(e => e.type === "p" && e.props.role === "note")!;
 expect(words(note.props.children as ReactNode).replace(/\s+/g, " ")).toBe("مقترح: Synthetic incoming — طبيب بنود علاج هذه الحالة . لا يُعتمد إلا بعد تأكيدك.");
 expect(f.find("select").props.value).toBe("9");
 expect(f.find("textarea").props.value).toBe("تأكيد الطبيب المقترح من بنود علاج الحالة");
 f.click("تأكيد الطبيب المقترح"); await turns();
 expect(fetchMock.mock.calls[1][1].method).toBe("PATCH");
 expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ kind: "clinical", sourceId: 3, expectedSourceFingerprint: data.sourceFingerprint, doctorId: 9, reason: "تأكيد الطبيب المقترح من بنود علاج الحالة" });
});
it("shows the reason and preselects nothing when no single doctor can be suggested", async () => {
 fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...data, doctorId: null, doctorName: null, suggestion: null, suggestionNote: "Synthetic ambiguity note" }) });
 const f = mount(); f.click("إعداد الطبيب المسؤول"); await turns();
 expect(words(f.render())).toContain("Synthetic ambiguity note");
 expect(f.find("select").props.value).toBe(""); expect(f.find("textarea").props.value).toBe("");
 expect(f.find("button", "حفظ المسؤولية").props.disabled).toBe(true);
});
it("an existing responsible doctor keeps the plain save and no suggestion", async () => {
 const f = mount(); f.click("إعداد الطبيب المسؤول"); await turns();
 expect(words(f.render())).not.toContain("مقترح"); expect(f.find("select").props.value).toBe("7");
});
