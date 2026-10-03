import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsentModal } from "../components/ConsentModal";
import { PatientDocuments } from "../components/PatientDocuments";

// Real component handlers, synthetic transport/canvas only. No browser, database,
// patient signature, consent decision, or real upload is performed by this suite.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, changed: false,
  memos: new Map<number, { value: unknown; deps?: readonly unknown[] }>(),
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(), pending: [] as (() => void)[],
  today: "2026-10-03",
  session: { username: "synthetic", role: "doctor", permissions: { canUploadXrays: true, canViewXrays: true } as Record<string, boolean> },
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = slot(undefined); const previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); hooks.memos.set(index, { value, deps }); return value;
  };
  return { ...react,
    useState: (initial: unknown) => { const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (update: unknown) => { const value = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(value, hooks.values[index])) hooks.changed = true; hooks.values[index] = value; }]; },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps), useMemo: memo,
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = slot(undefined); const previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); }); },
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
vi.mock("../components/BeforeAfterSlider", () => ({ BeforeAfterSlider: () => null }));
vi.mock("../lib/schedule", () => ({ clinicDateString: () => hooks.today }));
vi.mock("../lib/reminders", () => ({ friendlyDateLong: (value: string) => value }));

type Element = ReactElement<Record<string, unknown>>;
type Props = Parameters<typeof ConsentModal>[0];
const response = (payload: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const fetchMock = vi.fn();
const confirmMock = vi.fn();
const printMock = vi.fn();
const canvasContext = { clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() };
const encodeMock = vi.fn();
let props: Props;
let key: string | null = null;
let guard: (() => boolean) | null;
let records: Record<string, unknown>[];
let testSequence = 0;
function reset() { hooks.effects.forEach((effect) => effect.cleanup?.()); hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.memos.clear(); hooks.effects.clear(); hooks.pending = []; }
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...elements(element.props.children as ReactNode)];
}
function content(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(content).join("");
  return node && typeof node === "object" && "props" in node ? content((node as Element).props.children as ReactNode) : "";
}
function evaluate(outer: ReactElement | null) {
  if (!outer) { reset(); key = null; return { nodes: [] as Element[], text: "" }; }
  if (key !== outer.key) { reset(); key = outer.key; }
  let tree: ReactNode;
  let count = 0;
  do {
    if (++count > 18) throw new Error("Synthetic UI did not settle");
    hooks.cursor = 0; hooks.changed = false;
    tree = (outer.type as (value: unknown) => ReactNode)(outer.props);
    for (const node of elements(tree)) {
      if (node.type !== "canvas") continue;
      const ref = node.props.ref as { current: unknown };
      ref.current ??= { width: 550, height: 150, getContext: () => canvasContext,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 275, height: 75 }), toBlob: encodeMock };
    }
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return { nodes: elements(tree), text: content(tree) };
}
function render(change: Partial<Props> = {}) { props = { ...props, ...change }; return evaluate(ConsentModal(props)); }
function control(label: string) { const node = render().nodes.find((one) => one.props["aria-label"] === label); if (!node) throw new Error(`Missing ${label}`); return node; }
function change(label: string, value: string | boolean) { (control(label).props.onChange as (event: { target: { value: string | boolean; checked: string | boolean } }) => void)({ target: { value, checked: value } }); render(); }
function button(label: string) { const node = render().nodes.find((one) => one.type === "button" && content(one) === label); if (!node) throw new Error(`Missing ${label}`); return node; }
function click(label: string) { (button(label).props.onClick as () => void)(); render(); }
function simulateSignatureInput() {
  const canvas = control("لوحة توقيع الإقرار");
  const event = { nativeEvent: { clientX: 25, clientY: 10 } };
  (canvas.props.onMouseDown as (event: unknown) => void)(event);
  (canvas.props.onMouseMove as (event: unknown) => void)(event);
  (canvas.props.onMouseUp as () => void)(); render();
}
function draft() { render(); change("اسم الموقّع", "Synthetic consenting adult"); simulateSignatureInput(); change("الموافقة على شروط الإقرار", true); }
function submit() { const form = render().nodes.find((node) => node.type === "form")!; return (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => {} }); }
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
const reads = () => fetchMock.mock.calls.filter(([, init]) => !init?.method);
const submitDisabled = () => render().nodes.find((node) => node.type === "button" && node.props.type === "submit")!.props.disabled;
async function settle() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
function savedFrom(form: FormData, change: Record<string, unknown> = {}) {
  return { id: 801, patientId: 91, visitId: null, orthoCaseId: null, adjustmentId: null, kind: "consent", mimeType: "image/png",
    title: String(form.get("title")).slice(0, 120), note: String(form.get("note")), takenOn: form.get("takenOn"),
    sizeBytes: (form.get("file") as File).size, removedAt: null, ...change };
}
beforeEach(() => {
  reset(); key = null; guard = null; records = []; hooks.today = "2026-10-03";
  hooks.session = { username: `synthetic-consent-${++testSequence}`, role: "doctor", permissions: { canUploadXrays: true, canViewXrays: true } };
  props = { isOpen: true, patientId: 91, patientName: "Synthetic test patient", onClose: vi.fn(), onSigned: vi.fn(), onDraftChange: vi.fn(),
    onNavigationGuardChange: (next) => { guard = next; } };
  confirmMock.mockReset().mockReturnValue(true); printMock.mockReset();
  Object.values(canvasContext).forEach((mock) => { if (vi.isMockFunction(mock)) mock.mockClear(); });
  encodeMock.mockReset().mockImplementation((done: (value: Blob | null) => void) => done(new Blob(["synthetic transport fixture"], { type: "image/png" })));
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { const saved = savedFrom(init.body as FormData); records = [saved]; return response(saved, 201); }
    if (init?.method) throw new Error(`Unexpected synthetic mutation ${url}`);
    return response({ documents: records, storageReady: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { confirm: confirmMock, open: printMock, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(async () => { reset(); await settle(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("consent shared-document save boundary", () => {
  it("does not create, sign, or upload by opening the preview", () => {
    render(); expect(posts()).toHaveLength(0); expect(encodeMock).not.toHaveBeenCalled(); expect(canvasContext.stroke).not.toHaveBeenCalled();
    expect(submitDisabled()).toBe(true); expect(props.onDraftChange).toHaveBeenLastCalledWith(false);
    expect(render().text).toContain("بلا ربط تلقائي بزيارة أو حالة تخصصية");
  });
  it.each(["assistant", "cashier", "accountant", "doctor", "unknown"])("blocks %s without upload authority even through direct event invocation", async (role) => {
    hooks.session.role = role; hooks.session.permissions = { canViewXrays: true };
    render(); draft(); await submit();
    expect(submitDisabled()).toBe(true); expect(posts()).toHaveLength(0); expect(encodeMock).not.toHaveBeenCalled();
    expect(render().text).toContain("يمكنك قراءة نموذج الموافقة");
    expect(props.onDraftChange).toHaveBeenLastCalledWith(false);
  });
  it.each(["admin", "reception", "doctor"])("uses existing %s upload authority without adding permissions", async (role) => {
    hooks.session.role = role; draft(); await submit(); expect(posts()).toHaveLength(1); expect(props.onSigned).toHaveBeenCalledTimes(1);
  });
  it("keeps read-only template preview usable and closes without a save or discard prompt", () => {
    hooks.session.permissions = { canViewXrays: true };
    const templates = render().nodes.filter((node) => node.type === "button" && typeof node.props.disabled === "boolean" && String(node.props.className).includes("p-2.5 text-right"));
    (templates[1].props.onClick as () => void)(); render();
    expect(props.onDraftChange).toHaveBeenLastCalledWith(false); expect(templates[1].props.disabled).toBe(false);
    click("إلغاء"); expect(props.onClose).toHaveBeenCalledTimes(1); expect(confirmMock).not.toHaveBeenCalled(); expect(posts()).toHaveLength(0);
  });
  it("requires both explicit terms and signature input", async () => {
    render(); await submit(); expect(render().text).toContain("يجب تأكيد قراءة الشروط");
    change("الموافقة على شروط الإقرار", true); await submit(); expect(render().text).toContain("يرجى توقيع"); expect(posts()).toHaveLength(0);
  });
  it("preserves the existing consent payload and only completes after exact canonical readback", async () => {
    draft(); await submit(); const [url, init] = posts()[0]; const form = init.body as FormData;
    expect(url).toBe("/api/patients/91/documents"); expect(form.get("kind")).toBe("consent"); expect(form.get("takenOn")).toBe("2026-10-03");
    expect(form.has("visitId")).toBe(false); expect(form.has("orthoCaseId")).toBe(false); expect(form.has("adjustmentId")).toBe(false);
    expect(JSON.parse(String(form.get("note")))).toMatchObject({ templateId: "surgical_extraction", signatoryName: "Synthetic consenting adult", signatoryRelation: "self" });
    expect(String(form.get("note")).length).toBeGreaterThan(300);
    expect(JSON.parse(String(form.get("note")))).toMatchObject({ format: "aqlan-consent", schemaVersion: 1, patientName: props.patientName });
    expect(reads()).toHaveLength(1); expect(props.onSigned).toHaveBeenCalledWith(records[0]); expect(props.onClose).toHaveBeenCalledOnce();
    expect(printMock).toHaveBeenCalledWith("/print/consent/91?docId=801", "_blank", "noopener,noreferrer");
    await submit(); expect(posts()).toHaveLength(1); expect(guard?.()).toBe(true);
  });
  it("preserves guardian data and the optional print choice", async () => {
    draft(); click("ولي الأمر / الوصي"); change("اسم الموقّع", "Synthetic guardian"); change("صلة القرابة", "Synthetic guardian relation"); change("فتح الطباعة بعد الحفظ", false);
    expect(control("الموافقة على شروط الإقرار").props.checked).toBe(false); expect(submitDisabled()).toBe(true); await submit(); expect(posts()).toHaveLength(0);
    simulateSignatureInput(); change("الموافقة على شروط الإقرار", true);
    await submit(); expect(JSON.parse(String((posts()[0][1].body as FormData).get("note")))).toMatchObject({ signatoryName: "Synthetic guardian", signatoryRelation: "guardian", guardianRelation: "Synthetic guardian relation" });
    expect(printMock).not.toHaveBeenCalled(); expect(props.onSigned).toHaveBeenCalledOnce();
  });
  it.each(["name", "relation", "guardian-relation"])("invalidates the old signature and acknowledgement after material signer %s change", async (field) => {
    if (field === "guardian-relation") {
      render(); click("ولي الأمر / الوصي"); change("اسم الموقّع", "Synthetic guardian"); change("صلة القرابة", "Synthetic initial relationship");
      simulateSignatureInput(); change("الموافقة على شروط الإقرار", true);
    } else draft();
    if (field === "name") change("اسم الموقّع", "Another synthetic signer");
    else if (field === "relation") click("ولي الأمر / الوصي");
    else change("صلة القرابة", "Synthetic revised relationship");
    expect(control("الموافقة على شروط الإقرار").props.checked).toBe(false); expect(submitDisabled()).toBe(true); expect(render().text).toContain("وقّع هنا");
    change("الموافقة على شروط الإقرار", true); await submit(); expect(posts()).toHaveLength(0);
    if (field === "relation") { change("اسم الموقّع", "New synthetic guardian"); change("صلة القرابة", "Synthetic relationship"); }
    simulateSignatureInput(); change("الموافقة على شروط الإقرار", true); await submit(); expect(posts()).toHaveLength(1);
  });
  it("pins the date visibly reviewed in this draft across midnight and submits that same date", async () => {
    draft(); expect(control("تاريخ الإقرار").props.dateTime).toBe("2026-10-03");
    hooks.today = "2026-10-04"; render(); expect(control("تاريخ الإقرار").props.dateTime).toBe("2026-10-03");
    await submit(); const form = posts()[0][1].body as FormData;
    expect(form.get("takenOn")).toBe("2026-10-03"); expect(JSON.parse(String(form.get("note"))).takenOn).toBe("2026-10-03");
  });
  it("starts a newly reviewed template with a fresh visible date and no prior signature or agreement", async () => {
    draft(); hooks.today = "2026-10-04";
    const templates = render().nodes.filter((node) => node.type === "button" && String(node.props.className).includes("p-2.5 text-right"));
    (templates[1].props.onClick as () => void)(); render();
    expect(control("تاريخ الإقرار").props.dateTime).toBe("2026-10-04"); expect(control("الموافقة على شروط الإقرار").props.checked).toBe(false); expect(submitDisabled()).toBe(true);
    await submit(); expect(posts()).toHaveLength(0); simulateSignatureInput(); change("الموافقة على شروط الإقرار", true); await submit();
    expect((posts()[0][1].body as FormData).get("takenOn")).toBe("2026-10-04");
  });
  it("invalidates a draft when the displayed patient name changes before any new save", async () => {
    draft(); render({ patientName: "Updated synthetic patient name" });
    expect(control("اسم الموقّع").props.value).toBe("Updated synthetic patient name"); expect(control("الموافقة على شروط الإقرار").props.checked).toBe(false);
    expect(render().text).toContain("وقّع هنا"); await submit(); expect(posts()).toHaveLength(0);
    simulateSignatureInput(); change("الموافقة على شروط الإقرار", true); await submit();
    expect(JSON.parse(String((posts()[0][1].body as FormData).get("note"))).patientName).toBe("Updated synthetic patient name");
  });
  it("takes the busy latch before asynchronous encoding and blocks repeated submit, close, edits, and navigation", async () => {
    draft(); let encode!: (value: Blob | null) => void; encodeMock.mockImplementation((done) => { encode = done; });
    const first = submit(); const second = submit(); click("إلغاء");
    change("اسم الموقّع", "Must not replace pending signer"); simulateSignatureInput();
    expect(guard?.()).toBe(false); expect(confirmMock).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
    expect(control("اسم الموقّع").props.value).toBe("Synthetic consenting adult"); expect(posts()).toHaveLength(0);
    encode(new Blob(["synthetic pending bytes"])); await first; await second;
    expect(encodeMock).toHaveBeenCalledOnce(); expect(posts()).toHaveLength(1);
  });
  it("allows retry only when encoding failed before any POST", async () => {
    draft(); encodeMock.mockImplementationOnce((done) => done(null)); await submit();
    expect(posts()).toHaveLength(0); expect(render().text).toContain("لم يُرسل الإقرار"); expect(submitDisabled()).toBe(false);
    await submit(); expect(posts()).toHaveLength(1);
  });
  it.each(["cancel", "timeout"])("releases a hung request by %s but preserves uncertain-write protection", async (mode) => {
    vi.useFakeTimers(); draft();
    fetchMock.mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("synthetic aborted wait")), { once: true });
    }));
    const first = submit(); await settle(); render();
    if (mode === "cancel") click("إيقاف الانتظار دون إعادة الإرسال");
    else await vi.advanceTimersByTimeAsync(30000);
    await first; render(); expect(submitDisabled()).toBe(true); expect(props.onSigned).not.toHaveBeenCalled();
    await submit(); expect(posts()).toHaveLength(1); click("إلغاء"); expect(props.onClose).toHaveBeenCalledOnce();
  });
  it("clears signature and agreement on stale consent-content rejection before any new attempt", async () => {
    draft(); fetchMock.mockResolvedValueOnce(response({ message: "Review current terms and sign again" }, 409));
    await submit(); expect(control("الموافقة على شروط الإقرار").props.checked).toBe(false); expect(submitDisabled()).toBe(true);
    await submit(); expect(posts()).toHaveLength(1); expect(props.onSigned).not.toHaveBeenCalled();
  });
  it.each(["blank-name", "long-name", "guardian-relation"])("blocks invalid %s before encoding or POST", async (invalid) => {
    draft();
    if (invalid === "guardian-relation") { click("ولي الأمر / الوصي"); change("اسم الموقّع", "Synthetic guardian"); }
    else change("اسم الموقّع", invalid === "blank-name" ? "   " : "x".repeat(201));
    simulateSignatureInput(); change("الموافقة على شروط الإقرار", true);
    await submit(); expect(posts()).toHaveLength(0); expect(encodeMock).not.toHaveBeenCalled(); expect(props.onSigned).not.toHaveBeenCalled();
  });
  it.each(["name", "guardian-relation", "patient-name"])("rejects visually blank %s through canonical validation without rewriting the input", async (field) => {
    const invisible = "\u200B\u200C\u2060";
    if (field === "patient-name") render({ patientName: invisible });
    draft();
    if (field === "name") change("اسم الموقّع", invisible);
    if (field === "guardian-relation") { click("ولي الأمر / الوصي"); change("اسم الموقّع", "Synthetic guardian"); change("صلة القرابة", invisible); }
    simulateSignatureInput(); change("الموافقة على شروط الإقرار", true); await submit();
    expect(posts()).toHaveLength(0); expect(encodeMock).not.toHaveBeenCalled(); expect(props.onSigned).not.toHaveBeenCalled();
    if (field === "name") expect(control("اسم الموقّع").props.value).toBe(invisible);
    if (field === "guardian-relation") expect(control("صلة القرابة").props.value).toBe(invisible);
  });
  it("blocks navigation and repeated submission through readback, not just POST", async () => {
    draft(); const pending = deferred<ReturnType<typeof response>>();
    fetchMock.mockImplementation(async (_url, init) => init?.method === "POST" ? response(savedFrom(init.body), 201) : pending.promise);
    const first = submit(); await settle(); await submit(); click("إلغاء");
    expect(guard?.()).toBe(false); expect(props.onSigned).not.toHaveBeenCalled(); expect(printMock).not.toHaveBeenCalled();
    pending.resolve(response({ documents: [savedFrom(posts()[0][1].body)] })); await first; expect(props.onSigned).toHaveBeenCalledOnce(); expect(posts()).toHaveLength(1);
  });
  it("keeps dirty consent on cancelled close/navigation and resets it after accepted discard", () => {
    draft(); confirmMock.mockReturnValue(false); click("إلغاء"); expect(props.onClose).not.toHaveBeenCalled(); expect(guard?.()).toBe(false);
    expect(control("اسم الموقّع").props.value).toBe("Synthetic consenting adult"); expect(submitDisabled()).toBe(false);
    confirmMock.mockReturnValue(true); expect(guard?.()).toBe(true); render(); expect(submitDisabled()).toBe(true); expect(control("اسم الموقّع").props.value).toBe(props.patientName);
  });
  it("clears terms/signature on an explicitly accepted template change, without timeout erasure", () => {
    draft(); const templates = render().nodes.filter((node) => node.type === "button" && String(node.props.className).includes("p-2.5 text-right"));
    confirmMock.mockReturnValue(false); (templates[1].props.onClick as () => void)(); expect(submitDisabled()).toBe(false);
    confirmMock.mockReturnValue(true); (templates[1].props.onClick as () => void)(); render(); expect(submitDisabled()).toBe(true); expect(control("الموافقة على شروط الإقرار").props.checked).toBe(false);
  });
  it.each(["lost", "server", "malformed"])("latches %s response across close/reopen and never guesses a record by title", async (mode) => {
    draft(); fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === "POST") { records = [savedFrom(init.body)]; if (mode === "lost") throw new Error("lost response");
        if (mode === "malformed") return { ok: true, status: 201, json: async () => { throw new Error("bad JSON"); } };
        return response({ message: "uncertain" }, 500); }
      return response({ documents: records });
    });
    await submit(); click("إلغاء"); render({ isOpen: false }); render({ isOpen: true }); draft(); await submit();
    expect(posts()).toHaveLength(1); expect(submitDisabled()).toBe(true); expect(props.onSigned).not.toHaveBeenCalled();
    click("مراجعة السجل دون إعادة الحفظ"); await settle(); render();
    expect(props.onSigned).not.toHaveBeenCalled(); expect(printMock).not.toHaveBeenCalled(); expect(render().text).toContain("مراجعة الإقرار #801");
    expect(submitDisabled()).toBe(true); expect(posts()).toHaveLength(1);
    confirmMock.mockReturnValue(false); click("راجعت السجل؛ ابدأ إقرارًا جديدًا"); expect(render().text).toContain("نتيجة الحفظ تحتاج مراجعة");
    confirmMock.mockReturnValue(true); click("راجعت السجل؛ ابدأ إقرارًا جديدًا");
    expect(render().text).not.toContain("نتيجة الحفظ تحتاج مراجعة"); expect(submitDisabled()).toBe(true);
    expect(control("الموافقة على شروط الإقرار").props.checked).toBe(false); expect(control("اسم الموقّع").props.value).toBe(props.patientName); expect(posts()).toHaveLength(1);
  });
  it("restores the exact uncertain preview and signer on reopen without reconstructing signature or agreement", async () => {
    const templates = render().nodes.filter((node) => node.type === "button" && String(node.props.className).includes("p-2.5 text-right"));
    (templates[1].props.onClick as () => void)(); draft();
    fetchMock.mockRejectedValueOnce(new Error("synthetic lost response")); await submit();
    const metadata = JSON.parse(String((posts()[0][1].body as FormData).get("note")));
    hooks.today = "2026-10-04";
    click("إلغاء"); render({ isOpen: false }); render({ isOpen: true });
    expect(control("تاريخ الإقرار").props.dateTime).toBe(metadata.takenOn);
    expect(render().text).toContain(metadata.content.summary); expect(control("اسم الموقّع").props.value).toBe(metadata.signatoryName);
    expect(control("الموافقة على شروط الإقرار").props.checked).toBe(false); expect(render().text).toContain("وقّع هنا"); expect(submitDisabled()).toBe(true);
    expect(encodeMock).toHaveBeenCalledOnce(); expect(posts()).toHaveLength(1); expect(props.onSigned).not.toHaveBeenCalled();
  });
  it("retains known ID through a readback outage and only read-retries that same record", async () => {
    draft(); fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === "POST") { records = [savedFrom(init.body)]; return response(records[0], 201); }
      throw new Error("read outage");
    });
    await submit(); expect(render().text).toContain("المستند #801"); expect(props.onSigned).not.toHaveBeenCalled();
    fetchMock.mockImplementation(async () => response({ documents: records })); click("مراجعة السجل دون إعادة الحفظ"); await settle();
    expect(props.onSigned).toHaveBeenCalledWith(records[0]); expect(posts()).toHaveLength(1);
  });
  it.each(["patientId", "visitId", "orthoCaseId", "adjustmentId", "kind", "removedAt", "note", "sizeBytes", "id"])("rejects mismatched POST %s without print or completion", async (field) => {
    draft(); fetchMock.mockImplementation(async (_url, init) => response(savedFrom(init.body, { [field]: field === "kind" ? "photo" : field === "note" ? "wrong note" : field === "removedAt" ? "2026-10-03" : field === "id" ? "801" : 92 }), 201));
    await submit(); expect(props.onSigned).not.toHaveBeenCalled(); expect(printMock).not.toHaveBeenCalled(); expect(submitDisabled()).toBe(true); await submit(); expect(posts()).toHaveLength(1);
  });
  it.each(["wrong-id", "missing", "duplicate", "other-patient", "linked", "removed"])("does not complete on %s readback", async (mode) => {
    draft(); fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === "POST") { records = [savedFrom(init.body)]; return response(records[0], 201); }
      return response({ documents: mode === "missing" ? [] : mode === "duplicate" ? [records[0], records[0]] : [{ ...records[0],
        ...(mode === "wrong-id" ? { id: 802 } : mode === "other-patient" ? { patientId: 92 } : mode === "linked" ? { visitId: 7 } : mode === "removed" ? { removedAt: "2026-10-03" } : {}) }] });
    });
    await submit(); expect(props.onSigned).not.toHaveBeenCalled(); expect(printMock).not.toHaveBeenCalled(); expect(submitDisabled()).toBe(true); await submit(); expect(posts()).toHaveLength(1);
  });
  it.each([400, 401, 403, 413])("treats explicit %i rejection as a non-write and keeps the unsaved draft", async (status) => {
    draft(); fetchMock.mockResolvedValueOnce(response({ message: "Synthetic explicit rejection" }, status)); await submit();
    expect(render().text).toContain("Synthetic explicit rejection"); expect(render().text).not.toContain("نتيجة الحفظ تحتاج مراجعة");
    expect(control("اسم الموقّع").props.value).toBe("Synthetic consenting adult"); expect(submitDisabled()).toBe(false); expect(props.onSigned).not.toHaveBeenCalled();
  });
  it.each(["patient", "patient-name", "authority", "caller-authority", "close"])("isolates a pending POST from a %s change and suppresses stale callbacks", async (mode) => {
    draft(); const pending = deferred<ReturnType<typeof response>>(); fetchMock.mockImplementationOnce(() => pending.promise);
    const first = submit(); await settle();
    if (mode === "authority") hooks.session = { ...hooks.session, username: "other-synthetic", permissions: { canViewXrays: true } };
    render(mode === "patient" ? { patientId: 92, patientName: "Another synthetic patient" } : mode === "patient-name" ? { patientName: "Updated synthetic patient name" } : mode === "caller-authority" ? { authorityKey: "new-authority" } : mode === "close" ? { isOpen: false } : {});
    const freshText = mode !== "close" ? render().text : "";
    pending.resolve(response(savedFrom(posts()[0][1].body), 201)); await first;
    expect(props.onSigned).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled(); expect(printMock).not.toHaveBeenCalled(); expect(reads()).toHaveLength(0);
    if (mode !== "close") expect(render().text).toBe(freshText);
  });
  it("never sends encoded bytes after patient changes before encoding finishes", async () => {
    draft(); let encode!: (value: Blob) => void; encodeMock.mockImplementationOnce((done) => { encode = done; }); const first = submit();
    render({ patientId: 92, patientName: "Another synthetic patient" }); encode(new Blob(["synthetic bytes"])); await first;
    expect(posts()).toHaveLength(0); expect(props.onSigned).not.toHaveBeenCalled();
  });
  it("does not offer POST retry if print or parent refresh throws after verified save", async () => {
    draft(); printMock.mockImplementationOnce(() => { throw new Error("popup failure"); }); props.onSigned = vi.fn(() => { throw new Error("parent refresh failure"); });
    await submit(); expect(submitDisabled()).toBe(true); await submit(); expect(posts()).toHaveLength(1); expect(render().text).toContain("تم التحقق من حفظ الإقرار #801");
  });
  it("uses responsive canvas coordinate scaling without fabricating any signature", () => {
    draft(); expect(canvasContext.moveTo).toHaveBeenLastCalledWith(50, 20); expect(canvasContext.lineTo).toHaveBeenLastCalledWith(50, 20);
    expect(encodeMock).not.toHaveBeenCalled(); expect(posts()).toHaveLength(0);
  });
});

describe("PatientDocuments consent launcher composition", () => {
  it("gates the legacy new-consent launcher independently of document read access", async () => {
    hooks.session.permissions = { canViewXrays: true };
    const documentProps = { patientId: 91, patientName: "Synthetic", onDraftChange: vi.fn(), onNavigationGuardChange: (next: (() => boolean) | null) => { guard = next; } };
    const view = () => evaluate(PatientDocuments(documentProps));
    view(); await settle();
    const launcher = view().nodes.find((node) => node.type === "button" && content(node).includes("إقرار طبي رقمي جديد"))!;
    expect(launcher.props.disabled).toBe(true); (launcher.props.onClick as () => void)();
    const modal = view().nodes.find((node) => node.type === ConsentModal)!; expect(modal.props.isOpen).toBe(false); expect(posts()).toHaveLength(0);
  });
  it("registers nested dirty/busy consent with the existing parent navigation guard", async () => {
    const onDraftChange = vi.fn(); const documentProps = { patientId: 91, onDraftChange, onNavigationGuardChange: (next: (() => boolean) | null) => { guard = next; } };
    const view = () => evaluate(PatientDocuments(documentProps)); view(); await settle();
    const launcher = view().nodes.find((node) => node.type === "button" && content(node).includes("إقرار طبي رقمي جديد"))!;
    (launcher.props.onClick as () => void)(); let modal = view().nodes.find((node) => node.type === ConsentModal)!;
    expect(modal.props.isOpen).toBe(true); const childGuard = vi.fn(() => false);
    (modal.props.onNavigationGuardChange as (guard: () => boolean) => void)(childGuard);
    (modal.props.onDraftChange as (pending: boolean) => void)(true); view(); expect(onDraftChange).toHaveBeenLastCalledWith(true);
    confirmMock.mockClear(); expect(guard?.()).toBe(false); expect(childGuard).toHaveBeenCalledOnce(); expect(confirmMock).not.toHaveBeenCalled();
    modal = view().nodes.find((node) => node.type === ConsentModal)!; expect(modal.props.isOpen).toBe(true);
    childGuard.mockReturnValue(true); expect(guard?.()).toBe(true); modal = view().nodes.find((node) => node.type === ConsentModal)!; expect(modal.props.isOpen).toBe(false);
  });
});
