import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrescriptionModal } from "../components/PrescriptionModal";
import { checkPrescriptionDraft } from "../lib/prescription";
import { buildSafetyAcknowledgementToken, verifySafetyAcknowledgementToken } from "../lib/prescription-safety-ack";

// Run actual UI state and handlers against synthetic data.
// No API route, database module, relinking writer, real window or network is used.
// Like the repository's quick-appointment-submission test, this is a lightweight
// hook harness, not a browser integration test. Effects are flushed here so a
// future synchronization effect would participate in the acceptance contract.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps: readonly unknown[] | undefined; cleanup?: () => void }>(),
  pending: [] as Array<() => void>,
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  };
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (value: unknown) => {
        const next = typeof value === "function" ? value(hooks.values[index]) : value;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useMemo: (compute: () => unknown, deps?: readonly unknown[]) => {
      const index = slot(undefined); const previous = hooks.memos.get(index);
      if (previous && deps && previous.deps && deps.length === previous.deps.length
        && deps.every((value, position) => Object.is(value, previous.deps![position]))) return previous.value;
      const value = compute(); hooks.memos.set(index, { deps, value }); return value;
    },
    useEffect: (effect: () => undefined | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.effects.get(index);
      if (previous && deps && previous.deps && deps.length === previous.deps.length
        && deps.every((value, position) => Object.is(value, previous.deps![position]))) return;
      hooks.pending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
    useLayoutEffect: (effect: () => undefined | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.effects.get(index);
      if (previous && deps && previous.deps && deps.length === previous.deps.length
        && deps.every((value, position) => Object.is(value, previous.deps![position]))) return;
      hooks.pending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
});
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "Synthetic clinic" }));
vi.mock("../components/Icon", () => ({ Icon: () => null }));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function contents(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(contents).join("");
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  return contents((node as Element).props.children as ReactNode);
}

const fetchMock = vi.fn();
const openMock = vi.fn();
const closeMock = vi.fn();
type Props = Parameters<typeof PrescriptionModal>[0];
let props: Props;
function render(change: Partial<Props> = {}) {
  props = { ...props, ...change };
  let tree: ReturnType<typeof PrescriptionModal> = null;
  let rounds = 0;
  do {
    if (++rounds > 10) throw new Error("UI did not settle after effects");
    hooks.cursor = 0;
    hooks.changed = false;
    tree = PrescriptionModal(props);
    const pending = hooks.pending.splice(0);
    pending.forEach((effect) => effect());
  } while (hooks.changed);
  return {
    tree,
    find: (predicate: (node: Element) => boolean) => {
      const found = elements(tree).find(predicate);
      if (!found) throw new Error("Missing prescription control");
      return found;
    },
  };
}
function field(placeholder: string) {
  return render().find((node) => node.props.placeholder === placeholder);
}
function change(placeholder: string, value: string) {
  (field(placeholder).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
function click(label: string) {
  const button = render().find((node) => node.type === "button" && contents(node.props.children as ReactNode) === label);
  (button.props.onClick as () => void)();
}
const diagnosisPlaceholder = "مثال: Acute Pulpitis / Post-Extraction";
const medicinePlaceholder = "Drug name (e.g. Augmentin / Brufen)";
const notesPlaceholder = "مثال: الامتناع عن المشروبات الساخنة لمدة 24 ساعة، وضع كمادات باردة...";

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.changed = false;
  hooks.effects.clear();
  hooks.memos.clear();
  hooks.pending = [];
  vi.clearAllMocks();
  props = {
    isOpen: false, onClose: closeMock, patientId: 91001,
    patientName: "Synthetic patient", medicalAlert: null, defaultDiagnosis: "",
  };
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url === "/api/patients/91001/prescriptions" && !options?.method) {
      return { ok: true, status: 200, json: async () => ({ prescriptions: [], suggestions: [] }) };
    }
    if (url === "/api/prescriptions" && options?.method === "POST") {
      return { ok: true, status: 201, json: async () => ({ id: 92001, createdAt: "2030-01-01T00:00:00.000Z" }) };
    }
    throw new Error(`Unexpected mock request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { open: openMock });
});
afterEach(() => {
  hooks.effects.forEach((effect) => effect.cleanup?.());
  vi.unstubAllGlobals();
});

describe("prescription draft inherits current visit diagnosis without losing clinician edits", () => {
  it("first opening uses the diagnosis typed in the visit after the closed modal mounted", () => {
    expect(render().tree).toBeNull();
    render({ defaultDiagnosis: "Synthetic current visit diagnosis" });
    render({ isOpen: true });
    expect(field(diagnosisPlaceholder).props.value).toBe("Synthetic current visit diagnosis");
  });

  it("an untouched diagnosis follows a later visit correction on close and reopen", () => {
    render({ defaultDiagnosis: "Synthetic initial diagnosis" });
    render({ isOpen: true });
    expect(field(diagnosisPlaceholder).props.value).toBe("Synthetic initial diagnosis");
    click("إلغاء");
    expect(closeMock).toHaveBeenCalledOnce();
    render({ isOpen: false });
    render({ defaultDiagnosis: "Synthetic corrected visit diagnosis" });
    render({ isOpen: true });
    expect(field(diagnosisPlaceholder).props.value).toBe("Synthetic corrected visit diagnosis");
  });

  it("the official-save handler includes the current inherited diagnosis", async () => {
    render();
    render({ defaultDiagnosis: "Synthetic current visit diagnosis" });
    render({ isOpen: true });
    click("إضافة دواء جديد");
    change(medicinePlaceholder, "SyntheticDrug");
    click("طباعة الروشتة (A5)");
    await vi.waitFor(() => expect(openMock).toHaveBeenCalledOnce());
    const writes = fetchMock.mock.calls.filter(([url, options]) => url === "/api/prescriptions" && options?.method === "POST");
    expect(writes).toHaveLength(1);
    const payload = JSON.parse(writes[0][1].body);
    expect(payload.patientId).toBe(91001);
    expect(payload.items[0].name).toBe("SyntheticDrug");
    expect(payload.diagnosis).toBe("Synthetic current visit diagnosis");
  });

  it("retains a clinician-edited prescription diagnosis, medicine and notes after closing and reopening", () => {
    render({ defaultDiagnosis: "Synthetic visit diagnosis", isOpen: true });
    change(diagnosisPlaceholder, "Synthetic clinician Rx diagnosis");
    click("إضافة دواء جديد");
    change(medicinePlaceholder, "SyntheticDrug");
    change(notesPlaceholder, "Synthetic clinician notes");
    click("إلغاء");
    render({ isOpen: false });
    render({ defaultDiagnosis: "Synthetic updated visit diagnosis" });
    render({ isOpen: true });
    expect(field(diagnosisPlaceholder).props.value).toBe("Synthetic clinician Rx diagnosis");
    expect(field(medicinePlaceholder).props.value).toBe("SyntheticDrug");
    expect(field(notesPlaceholder).props.value).toBe("Synthetic clinician notes");
  });

  it("retains a deliberately cleared diagnosis rather than filling it again", () => {
    render({ defaultDiagnosis: "Synthetic visit diagnosis", isOpen: true });
    change(diagnosisPlaceholder, "");
    click("إلغاء");
    render({ isOpen: false, defaultDiagnosis: "Synthetic updated visit diagnosis" });
    render({ isOpen: true });
    expect(field(diagnosisPlaceholder).props.value).toBe("");
  });

  it("retains an explicitly selected procedure-template diagnosis and notes on reopening", () => {
    render({ defaultDiagnosis: "Synthetic visit diagnosis", isOpen: true });
    const template = render().find((node) => node.type === "button"
      && typeof node.props.title === "string" && node.props.title.includes("يُعبّئ التشخيص"));
    (template.props.onClick as () => void)();
    const selectedDiagnosis = field(diagnosisPlaceholder).props.value;
    const selectedNotes = field(notesPlaceholder).props.value;
    expect(selectedDiagnosis).not.toBe("Synthetic visit diagnosis");
    expect(String(selectedDiagnosis).length).toBeGreaterThan(0);
    click("إلغاء");
    render({ isOpen: false, defaultDiagnosis: "Synthetic updated visit diagnosis" });
    render({ isOpen: true });
    expect(field(diagnosisPlaceholder).props.value).toBe(selectedDiagnosis);
    expect(field(notesPlaceholder).props.value).toBe(selectedNotes);
  });

  it("treats a deliberate edit back to the visit text as clinician-owned", () => {
    render({ defaultDiagnosis: "Synthetic visit diagnosis", isOpen: true });
    change(diagnosisPlaceholder, "Synthetic edited diagnosis");
    change(diagnosisPlaceholder, "Synthetic visit diagnosis");
    render({ isOpen: false, defaultDiagnosis: "Synthetic corrected visit diagnosis" });
    render({ isOpen: true });
    expect(field(diagnosisPlaceholder).props.value).toBe("Synthetic visit diagnosis");
  });

  it("inherits clearing and later updates without resetting medicines or notes", () => {
    render({ defaultDiagnosis: "Synthetic visit diagnosis", isOpen: true });
    click("إضافة دواء جديد");
    change(medicinePlaceholder, "SyntheticDrug");
    change(notesPlaceholder, "Synthetic clinician notes");
    render({ defaultDiagnosis: "" });
    expect(field(diagnosisPlaceholder).props.value).toBe("");
    render({ defaultDiagnosis: "Synthetic corrected visit diagnosis" });
    expect(field(diagnosisPlaceholder).props.value).toBe("Synthetic corrected visit diagnosis");
    expect(field(medicinePlaceholder).props.value).toBe("SyntheticDrug");
    expect(field(notesPlaceholder).props.value).toBe("Synthetic clinician notes");
  });

  it("pins the submitted inherited diagnosis while saving across parent updates and reopening", async () => {
    let completeSave: ((response: unknown) => void) | undefined;
    const pendingSave = new Promise((resolve) => { completeSave = resolve; });
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === "/api/patients/91001/prescriptions") return { ok: true, json: async () => ({ suggestions: [] }) };
      if (url === "/api/prescriptions" && options?.method === "POST") return pendingSave;
      throw new Error("Unexpected request");
    });
    render({ defaultDiagnosis: "Synthetic submitted diagnosis", isOpen: true });
    click("إضافة دواء جديد");
    change(medicinePlaceholder, "SyntheticDrug");
    click("طباعة الروشتة (A5)");
    const post = fetchMock.mock.calls.find(([url, options]) => url === "/api/prescriptions" && options?.method === "POST");
    expect(JSON.parse(post![1].body).diagnosis).toBe("Synthetic submitted diagnosis");
    render({ defaultDiagnosis: "Synthetic newer visit diagnosis" });
    expect(field(diagnosisPlaceholder).props.value).toBe("Synthetic submitted diagnosis");
    click("إلغاء");
    render({ isOpen: false });
    render({ isOpen: true });
    expect(field(diagnosisPlaceholder).props.value).toBe("Synthetic submitted diagnosis");
    expect(openMock).not.toHaveBeenCalled();
    completeSave!({ status: 201, json: async () => ({ id: 92001 }) });
    await vi.waitFor(() => expect(render().find((node) => node.type === "button"
      && contents(node.props.children as ReactNode) === "طباعة الروشتة (A5)").props.disabled).toBe(false));
    expect(openMock).not.toHaveBeenCalled();
    expect(field(diagnosisPlaceholder).props.value).toBe("Synthetic submitted diagnosis");
    // A fresh explicit action may print; the retired request itself never does.
    click("طباعة الروشتة (A5)");
    await vi.waitFor(() => expect(openMock).toHaveBeenCalledExactlyOnceWith("/print/prescription/91001?rx=92001", "_blank"));
    expect(field(diagnosisPlaceholder).props.value).toBe("Synthetic submitted diagnosis");
  });

  it.each([false, true])("pins the preview diagnosis and rejects deliberate edits after acknowledgement (edited: %s)", async (edited) => {
    const writes: Record<string, unknown>[] = [];
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === "/api/patients/91001/prescriptions") {
        return { ok: true, json: async () => ({ suggestions: [] }) };
      }
      if (url !== "/api/prescriptions" || options?.method !== "POST") throw new Error("Unexpected request");
      const body = JSON.parse(String(options.body));
      writes.push(body);
      const checked = checkPrescriptionDraft({ ...body, visitId: null });
      if (!checked.ok) throw new Error("Invalid synthetic prescription");
      const input = { username: "synthetic-clinician", draft: checked.value, warnings: [], now: 1_800_000_000_000 };
      if (!body.acknowledgedSafetyToken) {
        return { status: 200, json: async () => ({
          requiresAcknowledgement: true, safetyWarnings: [],
          acknowledgementToken: buildSafetyAcknowledgementToken(input),
        }) };
      }
      const verified = verifySafetyAcknowledgementToken(body.acknowledgedSafetyToken, input);
      return verified.ok
        ? { status: 201, json: async () => ({ id: 92001 }) }
        : { status: 409, json: async () => ({ ackRejected: true, message: "Synthetic diagnosis changed; review again" }) };
    });
    render();
    render({ defaultDiagnosis: "Synthetic current visit diagnosis", isOpen: true });
    click("إضافة دواء جديد");
    change(medicinePlaceholder, "SyntheticDrug");
    click("طباعة الروشتة (A5)");
    const acknowledgement = "أقرّ قراءة التحذيرات — حفظ الوصفة وطباعتها رسميًا";
    await vi.waitFor(() => expect(() => render().find((node) => node.type === "button"
      && contents(node.props.children as ReactNode) === acknowledgement)).not.toThrow());
    expect(writes).toHaveLength(1);
    expect(writes[0].diagnosis).toBe("Synthetic current visit diagnosis");
    expect(openMock).not.toHaveBeenCalled();
    click("إلغاء");
    render({ isOpen: false, defaultDiagnosis: "Synthetic newer visit diagnosis" });
    render({ isOpen: true });
    expect(field(diagnosisPlaceholder).props.value).toBe("Synthetic current visit diagnosis");
    expect(contents(render().tree)).not.toContain(acknowledgement);
    // Reopening retires the old review. Obtain a new explicit preview before
    // retaining the original server token-mismatch/success assertions below.
    click("طباعة الروشتة (A5)");
    await vi.waitFor(() => expect(() => render().find((node) => node.type === "button"
      && contents(node.props.children as ReactNode) === acknowledgement)).not.toThrow());
    expect(writes).toHaveLength(2);
    expect(writes[1].diagnosis).toBe("Synthetic current visit diagnosis");
    expect(writes[1]).not.toHaveProperty("acknowledgedSafetyToken");
    if (edited) change(diagnosisPlaceholder, "Synthetic deliberate Rx correction");
    click(acknowledgement);
    await vi.waitFor(() => expect(writes).toHaveLength(3));
    expect(writes[2].diagnosis).toBe(edited ? "Synthetic deliberate Rx correction" : "Synthetic current visit diagnosis");
    expect(writes[2].acknowledgedSafetyToken).toEqual(expect.any(String));
    if (edited) {
      await vi.waitFor(() => expect(contents(render().tree)).toContain("Synthetic diagnosis changed; review again"));
      expect(openMock).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(openMock).toHaveBeenCalledExactlyOnceWith("/print/prescription/91001?rx=92001", "_blank"));
    }
  });
});
