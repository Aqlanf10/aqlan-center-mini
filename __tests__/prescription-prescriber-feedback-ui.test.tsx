import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrescriptionModal } from "../components/PrescriptionModal";
import { PRESCRIBER_UNAVAILABLE_MESSAGES } from "../lib/prescription-prescriber-feedback";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], setters: [] as Array<(value: unknown) => void>, cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(), pending: [] as Array<() => void> }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) {
        hooks.values[index] = typeof initial === "function" ? initial() : initial;
        hooks.setters[index] = value => {
          const next = typeof value === "function" ? value(hooks.values[index]) : value;
          if (!Object.is(next, hooks.values[index])) hooks.changed = true;
          hooks.values[index] = next;
        };
      }
      return [hooks.values[index], hooks.setters[index]];
    },
    useMemo: (factory: () => unknown) => { hooks.cursor++; return factory(); },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = hooks.cursor++, previous = hooks.effects.get(index);
      if (previous?.deps && deps && previous.deps.length === deps.length && deps.every((v, i) => Object.is(v, previous.deps![i]))) return;
      hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
    },
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: "synthetic", role: "doctor", permissions: null }) }));
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "Synthetic clinic" }));
vi.mock("../components/Icon", () => ({ Icon: () => null }));
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("")
  : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
let props: Parameters<typeof PrescriptionModal>[0];
const fetchMock = vi.fn(), open = vi.fn();
function render() {
  for (let count = 0; count < 20; count++) {
    hooks.cursor = 0; hooks.changed = false;
    const tree = PrescriptionModal(props); hooks.pending.splice(0).forEach(effect => effect());
    if (!hooks.changed) return tree;
  }
  throw new Error("Modal did not settle");
}
async function ready() { render(); for (let i = 0; i < 20; i++) await Promise.resolve(); return render(); }
const response = (options: unknown) => ({ ok: true, json: async () => ({ suggestions: [], prescriberOptions: options }) });
beforeEach(() => {
  hooks.values = []; hooks.setters = []; hooks.cursor = 0; hooks.changed = false; hooks.effects.clear(); hooks.pending = [];
  props = { isOpen: true, onClose: vi.fn(), patientId: 7, patientName: "Synthetic patient" };
  fetchMock.mockReset(); open.mockReset(); vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("window", { open });
});
afterEach(() => { hooks.effects.forEach(effect => effect.cleanup?.()); vi.unstubAllGlobals(); });
describe("prescriber identity feedback in the actual modal", () => {
  it.each(Object.entries(PRESCRIBER_UNAVAILABLE_MESSAGES))("shows %s without enabling issuance", async (reason, message) => {
    fetchMock.mockResolvedValue(response({ issuerId: null, canChooseAnyDoctor: false, doctors: [], unavailableReason: reason }));
    const tree = await ready(); expect(text(tree)).toContain(message);
    const print = nodes(tree).find(n => n.type === "button" && text(n).includes("طباعة") && n.props.disabled === true);
    expect(print).toBeDefined(); (print!.props.onClick as () => void)();
    await ready(); expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true); expect(open).not.toHaveBeenCalled();
    expect(nodes(tree).find(n => n.props["aria-label"] === "الطبيب الواصف")?.props.value).toBe("");
  });
  it.each(["unknown", "transport", "malformed-envelope"])("keeps generic feedback for %s", async mode => {
    if (mode === "transport") fetchMock.mockRejectedValue(new Error("private transport detail"));
    else fetchMock.mockResolvedValue(response({ issuerId: null, canChooseAnyDoctor: mode === "malformed-envelope", doctors: [], unavailableReason: mode === "unknown" ? "unknown" : "doctor_link_missing" }));
    const tree = await ready(); expect(text(tree)).toContain("تعذر التحقق من هوية الطبيب الواصف.");
    expect(text(tree)).not.toContain("private transport detail"); expect(text(tree)).not.toContain(PRESCRIBER_UNAVAILABLE_MESSAGES.doctor_link_missing);
  });
  it("clears old reason on verified retry without inventing delegation", async () => {
    fetchMock.mockResolvedValue(response({ issuerId: null, canChooseAnyDoctor: false, doctors: [], unavailableReason: "doctor_link_missing" }));
    const tree = await ready();
    fetchMock.mockResolvedValue(response({ issuerId: 19, canChooseAnyDoctor: false, doctors: [{ id: 19, name: "Verified clinician" }] }));
    const retry = nodes(tree).find(n => n.type === "button" && text(n) === "إعادة التحقق من الطبيب")!;
    (retry.props.onClick as () => void)(); const recovered = await ready();
    expect(text(recovered)).not.toContain(PRESCRIBER_UNAVAILABLE_MESSAGES.doctor_link_missing);
    const doctor = nodes(recovered).find(n => n.props["aria-label"] === "الطبيب الواصف")!;
    expect(doctor.type).toBe("input"); expect(doctor.props.readOnly).toBe(true); expect(doctor.props.value).toBe("Verified clinician");
    expect(open).not.toHaveBeenCalled();
  });
});


describe("identity lookup refresh containment", () => {
  it("drops previously valid options on failed reopen and recovers only from a fresh retry", async () => {
    fetchMock.mockResolvedValue(response({ issuerId: 19, canChooseAnyDoctor: false, doctors: [{ id: 19, name: "Old link" }] }));
    const initial = await ready(); expect(nodes(initial).find(n => n.props["aria-label"] === "الطبيب الواصف")?.props.value).toBe("Old link");
    props = { ...props, isOpen: false }; render();
    fetchMock.mockResolvedValue(response({ issuerId: null, canChooseAnyDoctor: false, doctors: [], unavailableReason: "doctor_identity_inactive" }));
    props = { ...props, isOpen: true }; const failed = await ready();
    expect(nodes(failed).find(n => n.props["aria-label"] === "الطبيب الواصف")?.props.value).toBe("");
    expect(text(failed)).toContain(PRESCRIBER_UNAVAILABLE_MESSAGES.doctor_identity_inactive);
    const retry = nodes(failed).find(n => n.type === "button" && text(n) === "إعادة التحقق من الطبيب")!;
    fetchMock.mockResolvedValue(response({ issuerId: 23, canChooseAnyDoctor: false, doctors: [{ id: 23, name: "Fresh link" }] }));
    (retry.props.onClick as () => void)(); const recovered = await ready();
    expect(nodes(recovered).find(n => n.props["aria-label"] === "الطبيب الواصف")?.props.value).toBe("Fresh link");
    expect(open).not.toHaveBeenCalled(); expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it("never silently substitutes the explicitly selected visit doctor after retry", async () => {
    props = { ...props, defaultDoctorPartyId: 29, defaultDoctorName: "Selected visit clinician" };
    fetchMock.mockResolvedValue(response({ issuerId: null, canChooseAnyDoctor: false, doctors: [], unavailableReason: "doctor_link_missing" }));
    const failed = await ready(); fetchMock.mockResolvedValue(response({ issuerId: 19, canChooseAnyDoctor: false, doctors: [{ id: 19, name: "Account clinician" }] }));
    (nodes(failed).find(n => n.type === "button" && text(n) === "إعادة التحقق من الطبيب")!.props.onClick as () => void)();
    const recovered = await ready();
    expect(nodes(recovered).find(n => n.props["aria-label"] === "الطبيب الواصف")?.props.value).toBe("Selected visit clinician");
    expect(text(recovered)).toContain("لم نغيّر الاختيار تلقائيًا");
    expect(open).not.toHaveBeenCalled(); expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
});
