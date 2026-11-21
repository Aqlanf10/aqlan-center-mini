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
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  };
  const effect = (effect: () => undefined | (() => void), deps?: readonly unknown[]) => {
    const index = slot(undefined);
    const previous = hooks.effects.get(index);
    if (previous && deps && previous.deps && deps.length === previous.deps.length
      && deps.every((value, position) => Object.is(value, previous.deps![position]))) return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      const cleanup = effect();
      hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
    });
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
    useMemo: (compute: () => unknown) => { slot(undefined); return compute(); },
    useLayoutEffect: effect, useEffect: effect,
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
let formKey: string | null;
function renderForm() {
  const child = PrescriptionModal(props);
  if (formKey !== child.key) {
    hooks.effects.forEach(effect => effect.cleanup?.());
    hooks.values = [];
    hooks.effects.clear();
    hooks.pending = [];
    formKey = child.key;
  }
  return (child.type as (value: Props) => ReactElement | null)(child.props);
}
function render(change: Partial<Props> = {}) {
  props = { ...props, ...change };
  let tree: ReactElement | null = null;
  let rounds = 0;
  do {
    if (++rounds > 10) throw new Error("UI did not settle after effects");
    hooks.cursor = 0;
    hooks.changed = false;
    tree = renderForm();
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
  formKey = null;
  hooks.values = [];
  hooks.cursor = 0;
  hooks.changed = false;
  hooks.effects.clear();
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

  it("pins the submitted diagnosis, but close and reopen keep the successful save available without an automatic popup", async () => {
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
    await vi.waitFor(() => expect(render().find(node => node.type === "a" && contents(node).includes("فتح الوصفة المحفوظة")).props.href)
      .toBe("/print/prescription/91001?rx=92001"));
    expect(openMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/prescriptions")).toHaveLength(1);
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
    if (edited) change(diagnosisPlaceholder, "Synthetic deliberate Rx correction");
    click(acknowledgement);
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].diagnosis).toBe(edited ? "Synthetic deliberate Rx correction" : "Synthetic current visit diagnosis");
    expect(writes[1].acknowledgedSafetyToken).toEqual(expect.any(String));
    if (edited) {
      await vi.waitFor(() => expect(contents(render().tree)).toContain("Synthetic diagnosis changed; review again"));
      expect(openMock).not.toHaveBeenCalled();
      expect(contents(render().tree)).not.toContain(acknowledgement);
      expect(contents(render().tree)).not.toContain("تحذيرات سلامة دوائية من الخادم");
      expect(() => click(acknowledgement)).toThrow();
      expect(writes).toHaveLength(2);
      click("طباعة الروشتة (A5)");
      await vi.waitFor(() => expect(writes).toHaveLength(3));
      expect(writes[2]).not.toHaveProperty("acknowledgedSafetyToken");
    } else {
      await vi.waitFor(() => expect(openMock).toHaveBeenCalledExactlyOnceWith("/print/prescription/91001?rx=92001", "_blank"));
    }
  });
});

describe("empty prescription caller fails closed before save or draft navigation", () => {
  const printLabel = "طباعة الروشتة (A5)";
  const validation = "أضف دواءً واحدًا على الأقل باسم مكتوب بالإنجليزية";
  const writes = () => fetchMock.mock.calls.filter(([, options]) => options?.method === "POST");

  it.each([null, "", "   ", "دواء", "123", `${"1".repeat(200)}A`])("rejects canonical-empty items: %s", (name) => {
    render({ isOpen: true });
    if (name !== null) {
      click("إضافة دواء جديد");
      change(medicinePlaceholder, name);
    }
    click(printLabel);
    expect(writes()).toHaveLength(0);
    expect(openMock).not.toHaveBeenCalled();
    expect(contents(render().find((node) => node.props.role === "alert").props.children as ReactNode)).toContain(validation);
  });

  it("allows correction after validation and preserves official save-before-print", async () => {
    render({ isOpen: true });
    click(printLabel);
    click("إضافة دواء جديد");
    change(medicinePlaceholder, "SyntheticDrug");
    click(printLabel);
    await vi.waitFor(() => expect(openMock).toHaveBeenCalledWith("/print/prescription/91001?rx=92001", "_blank"));
    expect(writes()).toHaveLength(1);
    expect(contents(render().tree)).not.toContain(validation);
  });

  it("preserves mixed raw rows for the server canonical sanitizer", async () => {
    render({ isOpen: true });
    click("إضافة دواء جديد");
    change(medicinePlaceholder, "   ");
    click("إضافة دواء جديد");
    const fields = elements(render().tree).filter(node => node.props.placeholder === medicinePlaceholder);
    (fields[1].props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "  SyntheticDrug  " } });
    click(printLabel);
    await vi.waitFor(() => expect(openMock).toHaveBeenCalledOnce());
    expect(writes()).toHaveLength(1);
    const body = JSON.parse(writes()[0][1].body);
    expect(body.items.map((item: { name: string }) => item.name)).toEqual(["   ", "  SyntheticDrug  "]);
    const canonical = checkPrescriptionDraft({ ...body, visitId: null });
    expect(canonical.ok).toBe(true);
    if (canonical.ok) expect(canonical.value.items.map(item => item.name)).toEqual(["SyntheticDrug"]);
  });

  it("preserves the valid medicine in an inline nonprinting preview after save failure", async () => {
    render({ isOpen: true });
    click("إضافة دواء جديد");
    change(medicinePlaceholder, "SyntheticDrug");
    fetchMock.mockResolvedValue({ status: 500, json: async () => ({ message: "Synthetic unavailable" }) });
    click(printLabel);
    await vi.waitFor(() => expect(contents(render().find(node => node.props["aria-label"] === "معاينة مسودة غير محفوظة"))).toContain("SyntheticDrug"));
    expect(writes()).toHaveLength(1);
    expect(openMock).not.toHaveBeenCalled();
  });

  it.each(["critical", "acknowledge"])("rejects emptied items from the %s secondary path", async (path) => {
    render({ isOpen: true });
    click("إضافة دواء جديد");
    change(medicinePlaceholder, "SyntheticDrug");
    const label = path === "critical" ? "عرض مسودة غير معتمدة (لا تُصرف كوصفة)" : "أقرّ قراءة التحذيرات — حفظ الوصفة وطباعتها رسميًا";
    fetchMock.mockResolvedValue({
      status: path === "critical" ? 409 : 200,
      json: async () => path === "critical"
        ? { safetyAlerts: [{ id: "synthetic", title: "Synthetic", message: "Synthetic", medicationName: "SyntheticDrug", severity: "critical" }] }
        : { requiresAcknowledgement: true, acknowledgementToken: "synthetic-token", safetyWarnings: [] },
    });
    click(printLabel);
    await vi.waitFor(() => expect(contents(render().tree)).toContain(label));
    expect(openMock).not.toHaveBeenCalled();
    change(medicinePlaceholder, "   ");
    click(label);
    expect(writes()).toHaveLength(1); // Initial safety evaluation only; no empty POST.
    expect(openMock).not.toHaveBeenCalled();
    expect(contents(render().tree)).toContain(validation);
  });
});


describe("private preview without print navigation", () => {
  const previewLabel = "معاينة مسودة غير محفوظة";
  const preview = () => render().find((node) => node.props["aria-label"] === previewLabel);
  const withDraft = () => {
    render({ isOpen: true, defaultDiagnosis: "Synthetic local diagnosis" });
    click("إضافة دواء جديد");
    change(medicinePlaceholder, "Synthetic Local Drug");
    change(notesPlaceholder, "Synthetic local notes");
  };

  it("private preview is explicit, visible in the composer, and makes no write or popup", () => {
    withDraft();
    click(previewLabel);
    const panel = preview();
    expect(contents(panel)).toContain("لا تُطبع ولا تُصرف");
    expect(panel.props.className).toContain("print:hidden");
    for (const marker of ["Synthetic local diagnosis", "Synthetic Local Drug", "Synthetic local notes"]) expect(contents(panel)).toContain(marker);
    expect(elements(panel).some(node => node.type === "a" || node.props.href || node.props.action)).toBe(false);
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toEqual([]);
    expect(openMock).not.toHaveBeenCalled();
  });

  it.each([[500, null], [201, null], [201, 2147483648], [201, 9007199254740992]] as const)(
    "private preview after unconfirmed save (%s, %s) makes no second write or navigation", async (status, id) => {
    const reads = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === "/api/prescriptions") return { status, json: async () => ({ id, message: "Synthetic failure" }) };
      return reads(url, options);
    });
    withDraft();
    click("طباعة الروشتة (A5)");
    await vi.waitFor(() => expect(contents(preview())).toContain("Synthetic Local Drug"));
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(openMock).not.toHaveBeenCalled();
    expect(contents(render().tree)).toContain("تعذّر تأكيد حفظ الوصفة");
  });

  it("no linked chart permits an inline draft only; it does not issue", () => {
    render({ patientId: null });
    withDraft();
    click("طباعة الروشتة (A5)");
    expect(contents(preview())).toContain("Synthetic Local Drug");
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toEqual([]);
    expect(openMock).not.toHaveBeenCalled();
  });

  it("critical refusal never opens anything automatically; its explicit draft action stays inline", async () => {
    const reads = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === "/api/prescriptions") return { status: 409, json: async () => ({
        message: "Synthetic blocked fixture", safetyAlerts: [{ id: "synthetic-critical", severity: "critical",
          medicationName: "Synthetic Local Drug", title: "Synthetic warning", message: "Synthetic refusal" }],
      }) };
      return reads(url, options);
    });
    withDraft();
    click("طباعة الروشتة (A5)");
    await vi.waitFor(() => expect(contents(render().tree)).toContain("Synthetic blocked fixture"));
    expect(() => preview()).toThrow();
    expect(openMock).not.toHaveBeenCalled();
    click("عرض مسودة غير معتمدة (لا تُصرف كوصفة)");
    expect(contents(preview())).toContain("Synthetic Local Drug");
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(openMock).not.toHaveBeenCalled();
  });

  it("the acknowledgement-save fallback stays local and generates no log or navigation", async () => {
    const reads = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url !== "/api/prescriptions") return reads(url, options);
      const body = JSON.parse(String(options?.body));
      return body.acknowledgedSafetyToken
        ? { status: 500, json: async () => ({}) }
        : { status: 200, json: async () => ({ requiresAcknowledgement: true, acknowledgementToken: "synthetic-only", safetyWarnings: [] }) };
    });
    withDraft();
    click("طباعة الروشتة (A5)");
    await vi.waitFor(() => expect(contents(render().tree)).toContain("أقرّ قراءة التحذيرات"));
    click("أقرّ قراءة التحذيرات — حفظ الوصفة وطباعتها رسميًا");
    await vi.waitFor(() => expect(contents(preview())).toContain("Synthetic Local Drug"));
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST").map(([url]) => url))
      .toEqual(["/api/prescriptions", "/api/prescriptions"]);
    expect(openMock).not.toHaveBeenCalled();
  });

  it("explicit close suppresses popup even before the parent's visibility commit", async () => {
    const reads = fetchMock.getMockImplementation()!;
    let finish!: (value: { status: number; json: () => Promise<{ id: number }> }) => void;
    const pending = new Promise<Parameters<typeof finish>[0]>(resolve => { finish = resolve; });
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) =>
      url === "/api/prescriptions" ? pending : reads(url, options));
    withDraft();
    click("طباعة الروشتة (A5)");
    click("إلغاء");
    expect(closeMock).toHaveBeenCalledOnce();
    finish({ status: 201, json: async () => ({ id: 92001 }) });
    await vi.waitFor(() => expect(render().find(node => node.type === "a" && contents(node).includes("فتح الوصفة المحفوظة")).props.href)
      .toBe("/print/prescription/91001?rx=92001"));
    expect(openMock).not.toHaveBeenCalled();
  });

  it.each([false, true])("closing during %s acknowledged save offers a manual saved link only", async (acknowledged) => {
    const reads = fetchMock.getMockImplementation()!;
    let finish!: (value: { status: number; json: () => Promise<{ id: number }> }) => void;
    const pending = new Promise<Parameters<typeof finish>[0]>(resolve => { finish = resolve; });
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url !== "/api/prescriptions") return reads(url, options);
      if (acknowledged && !JSON.parse(String(options?.body)).acknowledgedSafetyToken) return {
        status: 200, json: async () => ({ requiresAcknowledgement: true, acknowledgementToken: "synthetic-closing-chart", safetyWarnings: [] }),
      };
      return pending;
    });
    withDraft();
    click("طباعة الروشتة (A5)");
    if (acknowledged) {
      const label = "أقرّ قراءة التحذيرات — حفظ الوصفة وطباعتها رسميًا";
      await vi.waitFor(() => expect(contents(render().tree)).toContain(label));
      click(label);
    }
    // Parent-driven close also suppresses automatic printing, without relying
    // on the composer close button or removing the same chart's draft.
    render({ isOpen: false });
    finish({ status: 201, json: async () => ({ id: 92001 }) });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(render().tree).toBeNull();
    expect(openMock).not.toHaveBeenCalled();
    render({ isOpen: true });
    await vi.waitFor(() => expect(render().find(node => node.type === "a" && contents(node).includes("فتح الوصفة المحفوظة")).props.href)
      .toBe("/print/prescription/91001?rx=92001"));
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/prescriptions")).toHaveLength(acknowledged ? 2 : 1);
    expect(openMock).not.toHaveBeenCalled();
  });

  it.each([false, true])("a different chart clears the draft and cannot receive an old saved popup (after ack: %s)", async (acknowledged) => {
    const reads = fetchMock.getMockImplementation()!;
    let finish!: (value: { status: number; json: () => Promise<{ id: number }> }) => void;
    const pending = new Promise<Parameters<typeof finish>[0]>(resolve => { finish = resolve; });
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url !== "/api/prescriptions") return reads(url, options);
      if (acknowledged && !JSON.parse(String(options?.body)).acknowledgedSafetyToken) return {
        status: 200, json: async () => ({ requiresAcknowledgement: true, acknowledgementToken: "synthetic-old-chart", safetyWarnings: [] }),
      };
      return pending;
    });
    withDraft();
    click(previewLabel);
    expect(contents(preview())).toContain("Synthetic Local Drug");
    click("طباعة الروشتة (A5)");
    if (acknowledged) {
      await vi.waitFor(() => expect(contents(render().tree)).toContain("أقرّ قراءة التحذيرات"));
      click("أقرّ قراءة التحذيرات — حفظ الوصفة وطباعتها رسميًا");
    }
    render({ patientId: 91002, patientName: "Synthetic second chart", defaultDiagnosis: "Synthetic separate diagnosis" });
    finish({ status: 201, json: async () => ({ id: 92001 }) });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(openMock).not.toHaveBeenCalled();
    expect(() => preview()).toThrow();
    expect(contents(render().tree)).not.toContain("Synthetic local notes");
    expect(contents(render().tree)).not.toContain("فتح الوصفة المحفوظة");
    expect(() => field(medicinePlaceholder)).toThrow();
    expect(field(diagnosisPlaceholder).props.value).toBe("Synthetic separate diagnosis");
  });
});
