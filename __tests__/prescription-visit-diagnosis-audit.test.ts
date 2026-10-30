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
  username: "synthetic-clinician", role: "doctor",
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
  };
});
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "Synthetic clinic" }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: hooks.username, role: hooks.role }) }));
vi.mock("../components/Icon", () => ({ Icon: () => null }));

const ready = async () => { await vi.waitFor(() => expect(contents(render().tree)).not.toContain("جارٍ التحقق من هوية الطبيب الواصف")); };

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
  hooks.pending = [];
  vi.clearAllMocks();
  hooks.username = "synthetic-clinician"; hooks.role = "doctor";
  props = {
    isOpen: false, onClose: closeMock, patientId: 91001,
    patientName: "Synthetic patient", medicalAlert: null, defaultDiagnosis: "",
  };
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url === "/api/patients/91001/prescriptions" && !options?.method) {
      return { ok: true, status: 200, json: async () => ({ prescriptions: [], suggestions: [], prescriberOptions: { issuerId: 5, canChooseAnyDoctor: false, doctors: [{ id: 5, name: "Dr Self" }] } }) };
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
    await ready();
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
      if (url === "/api/patients/91001/prescriptions") return { ok: true, json: async () => ({ suggestions: [], prescriberOptions: { issuerId: 5, canChooseAnyDoctor: false, doctors: [{ id: 5, name: "Dr Self" }] } }) };
      if (url === "/api/prescriptions" && options?.method === "POST") return pendingSave;
      throw new Error("Unexpected request");
    });
    render({ defaultDiagnosis: "Synthetic submitted diagnosis", isOpen: true });
    click("إضافة دواء جديد");
    change(medicinePlaceholder, "SyntheticDrug");
    await ready();
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
    await vi.waitFor(() => expect(openMock).toHaveBeenCalledExactlyOnceWith("/print/prescription/91001?rx=92001", "_blank"));
    expect(field(diagnosisPlaceholder).props.value).toBe("Synthetic submitted diagnosis");
  });

  it.each([false, true])("pins the preview diagnosis and rejects deliberate edits after acknowledgement (edited: %s)", async (edited) => {
    const writes: Record<string, unknown>[] = [];
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === "/api/patients/91001/prescriptions") {
        return { ok: true, json: async () => ({ suggestions: [], prescriberOptions: { issuerId: 5, canChooseAnyDoctor: false, doctors: [{ id: 5, name: "Dr Self" }] } }) };
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
    await ready();
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
    await ready();
    click(acknowledgement);
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].diagnosis).toBe(edited ? "Synthetic deliberate Rx correction" : "Synthetic current visit diagnosis");
    expect(writes[1].acknowledgedSafetyToken).toEqual(expect.any(String));
    if (edited) {
      await vi.waitFor(() => expect(contents(render().tree)).toContain("Synthetic diagnosis changed; review again"));
      expect(openMock).not.toHaveBeenCalled();
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
    await ready();
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
    await ready();
    click(printLabel);
    await vi.waitFor(() => expect(openMock).toHaveBeenCalledOnce());
    expect(writes()).toHaveLength(1);
    const body = JSON.parse(writes()[0][1].body);
    expect(body.items.map((item: { name: string }) => item.name)).toEqual(["   ", "  SyntheticDrug  "]);
    const canonical = checkPrescriptionDraft({ ...body, visitId: null });
    expect(canonical.ok).toBe(true);
    if (canonical.ok) expect(canonical.value.items.map(item => item.name)).toEqual(["SyntheticDrug"]);
  });

  it("preserves a valid explicit draft fallback after save failure", async () => {
    render({ isOpen: true });
    click("إضافة دواء جديد");
    change(medicinePlaceholder, "SyntheticDrug");
    await ready();
    fetchMock.mockResolvedValue({ status: 500, json: async () => ({ message: "Synthetic failure" }) });
    await ready();
    click(printLabel);
    await vi.waitFor(() => expect(openMock).toHaveBeenCalledOnce());
    expect(writes()).toHaveLength(1);
    const url = new URL(openMock.mock.calls[0][0], "https://synthetic.invalid");
    expect(url.searchParams.get("draft")).toBe("1");
    expect(JSON.parse(url.searchParams.get("items")!)[0].name).toBe("SyntheticDrug");
  });

  it.each(["critical", "acknowledge"])("rejects emptied items from the %s secondary path", async (path) => {
    render({ isOpen: true });
    click("إضافة دواء جديد");
    change(medicinePlaceholder, "SyntheticDrug");
    const label = path === "critical" ? "عرض مسودة غير معتمدة (لا تُصرف كوصفة)" : "أقرّ قراءة التحذيرات — حفظ الوصفة وطباعتها رسميًا";
    await ready();
    fetchMock.mockResolvedValue({
      status: path === "critical" ? 409 : 200,
      json: async () => path === "critical"
        ? { safetyAlerts: [{ id: "synthetic", title: "Synthetic", message: "Synthetic", medicationName: "SyntheticDrug", severity: "critical" }] }
        : { requiresAcknowledgement: true, acknowledgementToken: "synthetic-token", safetyWarnings: [] },
    });
    await ready();
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

it("never silently replaces a mismatched visit prescriber with the current clinician", async () => {
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => ({
    ok: true, status: options?.method === "POST" ? 201 : 200,
    json: async () => url === "/api/prescriptions" ? { id: 92001 } : {
      suggestions: [], prescriberOptions: { issuerId: 5, canChooseAnyDoctor: false, doctors: [{ id: 5, name: "Dr Self" }] },
    },
  }));
  render({ isOpen: true, defaultDoctorPartyId: 99, defaultDoctorName: "Dr Visit" });
  await vi.waitFor(() => expect(contents(render().tree)).toContain("لم نغيّر الاختيار تلقائيًا"));
  const physician = render().find(node => node.props["aria-label"] === "الطبيب الواصف");
  expect(physician.props.value).toBe("Dr Visit");
  click("إضافة دواء جديد"); change(medicinePlaceholder, "SYNTHETIC"); click("طباعة الروشتة (A5)");
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
  const accept = render().find(node => node.type === "button" && contents(node.props.children as ReactNode).startsWith("إصدار باسمي:"));
  (accept.props.onClick as () => void)();
  expect(render().find(node => node.props["aria-label"] === "الطبيب الواصف").props.value).toBe("Dr Self");
  click("طباعة الروشتة (A5)");
  await vi.waitFor(() => expect(openMock).toHaveBeenCalledOnce());
  const write = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
  expect(JSON.parse(write![1].body).prescribingDoctorPartyId).toBe(5);
});


describe("prescriber lookup ownership and retry", () => {
  const payload = (id: number, name: string) => ({ ok: true, status: 200, json: async () => ({ suggestions: [], prescriberOptions: { issuerId: id, canChooseAnyDoctor: false, doctors: [{ id, name }] } }) });
  const printButton = () => render().find(node => node.type === "button" && contents(node.props.children as ReactNode) === "طباعة الروشتة (A5)");
  const physician = () => render().find(node => node.props["aria-label"] === "الطبيب الواصف");
  it("cannot keep a verified physician when the patient context disappears", async () => {
    fetchMock.mockResolvedValueOnce(payload(5, "Dr First")); render({ isOpen: true }); await ready();
    render({ patientId: null }); expect(physician().props.value).toBe(""); expect(printButton().props.disabled).toBe(true);
    expect(contents(render().tree)).toContain("تعذر التحقق من هوية الطبيب الواصف");
  });
  it("blocks saving while loading, shows failure, and retries without automatic issuance", async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise(value => { resolve = value; }));
    render({ isOpen: true, defaultDoctorName: "Unverified name" });
    click("إضافة دواء جديد"); change(medicinePlaceholder, "SyntheticDrug");
    expect(printButton().props.disabled).toBe(true); expect(physician().props.value).toBe("");
    click("طباعة الروشتة (A5)"); expect(openMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
    resolve({ ok: false, status: 503 });
    await vi.waitFor(() => expect(contents(render().tree)).toContain("تعذر التحقق من هوية الطبيب الواصف"));
    expect(printButton().props.disabled).toBe(true);
    fetchMock.mockResolvedValueOnce(payload(5, "Dr Retried")); click("إعادة التحقق من الطبيب");
    expect(printButton().props.disabled).toBe(true); await ready();
    expect(physician().props.value).toBe("Dr Retried"); expect(printButton().props.disabled).toBe(false); expect(openMock).not.toHaveBeenCalled();
  });
  it("retires a late patient A response through A → B → A and never restores old choices", async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise(value => { resolve = value; }))
      .mockResolvedValueOnce(payload(6, "Dr B")).mockResolvedValueOnce(payload(7, "Dr Fresh A"));
    render({ isOpen: true }); render({ patientId: 91002 }); await ready(); expect(physician().props.value).toBe("Dr B");
    render({ patientId: 91001 }); expect(physician().props.value).toBe(""); expect(printButton().props.disabled).toBe(true);
    await ready(); expect(physician().props.value).toBe("Dr Fresh A");
    resolve(payload(5, "Dr Retired A")); await new Promise(resolve => setTimeout(resolve, 0));
    expect(physician().props.value).toBe("Dr Fresh A");
  });
  it("drops verified options when the principal changes, and explains the inactive owner path", async () => {
    fetchMock.mockResolvedValueOnce(payload(5, "Dr First")); render({ isOpen: true }); await ready();
    let resolve!: (value: unknown) => void; fetchMock.mockImplementationOnce(() => new Promise(value => { resolve = value; }));
    hooks.username = "different-owner"; hooks.role = "admin"; render();
    expect(physician().props.value).toBe(""); expect(printButton().props.disabled).toBe(true);
    expect(contents(render().tree)).toContain("اختيار طبيب آخر للمالك غير متاح حاليًا");
    resolve(payload(6, "Dr Current")); await ready(); expect(physician().props.value).toBe("Dr Current");
  });
});
