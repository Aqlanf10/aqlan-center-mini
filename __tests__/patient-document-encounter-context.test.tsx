import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientDocuments } from "../components/PatientDocuments";

// Actual component handlers against synthetic responses. This is a hook harness,
// not a browser, database, or real-patient upload test. Key changes run cleanup.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, changed: false,
  memos: new Map<number, { value: unknown; deps?: readonly unknown[] }>(),
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  pending: [] as (() => void)[], session: { username: "synthetic", role: "doctor", permissions: { canUploadXrays: true } as Record<string, boolean> },
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
vi.mock("../components/ConsentModal", () => ({ ConsentModal: () => null }));
vi.mock("../components/BeforeAfterSlider", () => ({ BeforeAfterSlider: () => null }));
vi.mock("../lib/schedule", () => ({ clinicDateString: () => "2026-10-03" }));
vi.mock("../lib/reminders", () => ({ friendlyDateLong: (value: string) => value }));

type Element = ReactElement<Record<string, unknown>>;
type Props = Parameters<typeof PatientDocuments>[0];
const visit = (id: number, patientId = 91) => ({ id, patientId, arrivedAt: `2026-10-${id === 71 ? "01" : "02"}`, status: "done" as const });
const document = (id = 801, visitId: number | null = null, patientId = 91) => ({ id, patientId, visitId, orthoCaseId: null as number | null, adjustmentId: null as number | null,
  kind: "xray", title: "مستند تحقق", mimeType: "image/png", sizeBytes: 80, isImage: true, note: null, takenOn: "2026-10-03",
  uploadedBy: "synthetic", uploadedAt: "2026-10-03T08:00:00Z", removedAt: null, removedBy: null, removedNote: null, photoStage: null, photoView: null });
const reply = (payload: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => payload });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const fetchMock = vi.fn();
const confirmMock = vi.fn();
let props: Props;
let key: string | null = null;
let guard: (() => boolean) | null;
let records: ReturnType<typeof document>[];
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
function render(change: Partial<Props> = {}) {
  props = { ...props, ...change };
  const outer = PatientDocuments(props);
  if (key !== outer.key) { reset(); key = outer.key; }
  let tree: ReactNode;
  let count = 0;
  do {
    if (++count > 15) throw new Error("Synthetic UI did not settle");
    hooks.cursor = 0; hooks.changed = false;
    tree = (outer.type as (value: Props) => ReactNode)(outer.props);
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return { nodes: elements(tree), text: content(tree) };
}
function control(label: string) { const node = render().nodes.find((one) => one.props["aria-label"] === label); if (!node) throw new Error(`Missing ${label}`); return node; }
function change(label: string, value: string) { (control(label).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); }
function pick(name = "synthetic.png", camera = false) {
  const input = control(camera ? "كاميرا التصوير" : "ملف الأشعة");
  const ref = input.props.ref as { current: { files: File[]; value: string } };
  const file = new File(["synthetic bytes"], name, { type: "image/png" });
  const node = { files: [file], get value() { return name; }, set value(_value: string) { this.files = []; } };
  ref.current = node;
  (input.props.onChange as (event: { target: typeof node }) => void)({ target: node });
  render();
}
function submit() { const form = render().nodes.find((node) => node.type === "form")!; return (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => {} }); }
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
function button(label: string) { const node = render().nodes.find((one) => one.type === "button" && content(one) === label); if (!node) throw new Error(`Missing ${label}`); return node; }
async function click(label: string) { (button(label).props.onClick as () => void)(); await settle(); render(); }
const submitDisabled = () => render().nodes.find((node) => node.type === "button" && node.props.type === "submit")!.props.disabled;
async function settle() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
async function ready() { render(); await settle(); render(); }

beforeEach(() => {
  reset(); key = null; guard = null; records = [];
  hooks.session = { username: "synthetic", role: "doctor", permissions: { canUploadXrays: true } };
  props = { patientId: 91, authorityKey: "synthetic:doctor", visits: [visit(72), visit(71)],
    onNavigationGuardChange: (next) => { guard = next; }, onDraftChange: vi.fn() };
  confirmMock.mockReset().mockReturnValue(true);
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const form = init.body as FormData;
      const saved = document(801, form.has("visitId") ? Number(form.get("visitId")) : null);
      records = [saved]; return reply(saved);
    }
    if (init?.method) throw new Error(`Unexpected synthetic mutation ${url}`);
    return reply({ documents: records, storageReady: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { confirm: confirmMock, prompt: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(async () => { reset(); await settle(); vi.unstubAllGlobals(); });

describe("patient document explicit encounter context", () => {
  it("starts patient-level, discloses latest50, and never uploads by selection or load", async () => {
    await ready();
    expect(control("زيارة المستند").props.value).toBe("");
    expect(render().text).toContain("أحدث 50 زيارة كحد أقصى");
    expect(render().text).toContain("ربط الزيارة لا يحفظ رابطًا مستقلًا بحالة تخصصية");
    expect(posts()).toHaveLength(0);
    pick(); await submit();
    const form = posts()[0][1].body as FormData;
    expect(form.has("visitId")).toBe(false); expect(form.has("orthoCaseId")).toBe(false); expect(form.has("adjustmentId")).toBe(false);
    expect(render().text).toContain("تم التحقق من المستند #801 بعد إعادة التحميل");
    expect(render().text).toContain("على مستوى المريض؛ بلا ربط بزيارة أو حالة تقويم");
  });
  it("offers only unique valid same-patient references and rejects forged selection", async () => {
    props.visits = [visit(71), visit(72, 92), visit(73), visit(73), visit(0), visit(-2), visit(2147483648)];
    await ready();
    const options = elements(control("زيارة المستند").props.children as ReactNode).filter((node) => node.type === "option").map((node) => node.props.value);
    expect(options).toEqual(["", 71]);
    for (const value of ["72", "73", "-2", "1.5", "71junk", "01", "2147483648"]) {
      change("زيارة المستند", value); expect(control("زيارة المستند").props.value).toBe("");
    }
    expect(posts()).toHaveLength(0);
  });
  it("persists only the explicit visit, verifies the canonical readback, and resets the next upload to patient-level", async () => {
    await ready(); change("زيارة المستند", "71"); pick(); change("وصف المستند", "أشعة زيارة محددة");
    await submit();
    const form = posts()[0][1].body as FormData;
    expect(form.get("visitId")).toBe("71"); expect(form.get("title")).toBe("أشعة زيارة محددة");
    expect([...form.keys()]).not.toContain("caseId"); expect([...form.keys()]).not.toContain("clinical_case_id");
    expect(render().text).toContain("الارتباط المحفوظ: زيارة #71");
    expect(control("زيارة المستند").props.value).toBe("");
    expect(submitDisabled()).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2);
  });
  it("keeps a removed selection visibly unavailable without falling back or silently dropping its association", async () => {
    await ready(); change("زيارة المستند", "71"); pick();
    render({ visits: [visit(72)] });
    expect(control("زيارة المستند").props.value).toBe(71); expect(render().text).toContain("زيارة #71 غير متاحة");
    expect(submitDisabled()).toBe(true); await submit(); expect(posts()).toHaveLength(0);
  });
  it("preserves the exact file, text and visit when association change or navigation discard is cancelled", async () => {
    await ready(); change("زيارة المستند", "71"); pick("draft.png"); change("وصف المستند", "مسودة");
    confirmMock.mockReturnValue(false);
    change("زيارة المستند", "72");
    expect(control("زيارة المستند").props.value).toBe(71); expect(control("وصف المستند").props.value).toBe("مسودة");
    expect(render().text).toContain("draft.png"); expect(guard?.()).toBe(false);
    expect(render().text).toContain("draft.png"); expect(posts()).toHaveLength(0);
  });
  it("clears old-context draft fields before a confirmed association switch or accepted navigation", async () => {
    await ready(); change("زيارة المستند", "71"); pick("old.png"); change("وصف المستند", "مسودة");
    change("زيارة المستند", "72");
    expect(control("زيارة المستند").props.value).toBe(72); expect(control("وصف المستند").props.value).toBe("");
    expect(render().text).not.toContain("old.png"); expect(submitDisabled()).toBe(true);
    pick("next.png"); expect(guard?.()).toBe(true); render();
    expect(control("زيارة المستند").props.value).toBe(""); expect(render().text).not.toContain("next.png");
  });
  it("freezes context through upload, blocks repeated submit/leave without prompting, and sends exactly once", async () => {
    await ready(); change("زيارة المستند", "71"); pick();
    const pending = deferred<ReturnType<typeof reply>>();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => init?.method === "POST" ? pending.promise : Promise.resolve(reply({ documents: records, storageReady: true })));
    const first = submit(); await submit();
    confirmMock.mockClear(); change("زيارة المستند", "72"); expect(guard?.()).toBe(false);
    expect(confirmMock).not.toHaveBeenCalled(); expect(control("زيارة المستند").props.value).toBe(71);
    expect(render().nodes.find((node) => node.type === "fieldset")!.props.disabled).toBe(true);
    records = [document(801, 71)]; pending.resolve(reply(records[0])); await first;
    expect(posts()).toHaveLength(1); expect((posts()[0][1].body as FormData).get("visitId")).toBe("71");
  });
  it("remounts on patient change and ignores old upload completion without reading or clearing the new draft", async () => {
    await ready(); change("زيارة المستند", "71"); pick();
    const pending = deferred<ReturnType<typeof reply>>();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => init?.method === "POST" ? pending.promise : Promise.resolve(reply({ documents: [], storageReady: true })));
    const old = submit();
    render({ patientId: 92, visits: [visit(81, 92)] }); await settle();
    expect(control("زيارة المستند").props.value).toBe(""); expect(render().text).not.toContain("synthetic.png");
    pick("new-patient.png"); change("وصف المستند", "مريض جديد");
    pending.resolve(reply(document(801, 71))); await old;
    expect(control("وصف المستند").props.value).toBe("مريض جديد"); expect(render().text).toContain("new-patient.png");
    expect(render().text).not.toContain("تم التحقق من المستند");
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/patients/91/documents" && !init?.method)).toHaveLength(1);
  });
  it("remounts on authority change and suppresses an earlier authority's late read", async () => {
    const pending = deferred<ReturnType<typeof reply>>();
    fetchMock.mockImplementationOnce(() => pending.promise);
    render();
    hooks.session = { username: "other", role: "doctor", permissions: { canViewXrays: true } };
    render(); await settle(); render();
    pending.resolve(reply({ documents: [document()], storageReady: true })); await settle();
    expect(render().text).not.toContain("مستند تحقق"); expect(control("زيارة المستند").props.value).toBe("");
  });
  it.each(["patient", "visit", "ortho"])("does not claim success for a mismatching %s response", async (mismatch) => {
    await ready(); change("زيارة المستند", "71"); pick();
    const saved = document(801, mismatch === "visit" ? 72 : 71, mismatch === "patient" ? 92 : 91);
    if (mismatch === "ortho") saved.orthoCaseId = 4;
    fetchMock.mockResolvedValue(reply(saved));
    await submit();
    expect(render().text).toContain("لم تؤكد استجابة الرفع الارتباط المختار");
    expect(render().text).not.toContain("تم التحقق من المستند");
  });
  it("does not claim verified persistence when readback omits the uploaded record", async () => {
    await ready(); pick();
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => reply(init?.method === "POST" ? document() : { documents: [], storageReady: true }));
    await submit();
    expect(render().text).toContain("لم يكتمل التحقق من ارتباطه في السجل"); expect(render().text).not.toContain("تم التحقق من المستند");
  });
  it("shows only persisted Ortho and adjustment references, including no inferred visit", async () => {
    records = [{ ...document(), orthoCaseId: 23, adjustmentId: 34 }]; await ready();
    const label = render().nodes.find((node) => node.props["data-testid"] === "document-context-801")!;
    expect(content(label)).toContain("حالة تقويم #23 · شدّة تقويم #34"); expect(content(label)).not.toContain("زيارة");
    expect(control("زيارة المستند").props.value).toBe("");
  });
  it("fails closed on cross-patient document reads and preserves upload denial rather than declaring success", async () => {
    records = [document(801, null, 92)]; await ready();
    expect(render().text).toContain("تعذّر التحقق من سياق المستندات"); expect(render().text).not.toContain("مستند تحقق");
    pick(); await submit(); expect(posts()).toHaveLength(0);
  });
  it("retains caller photo permissions and suppresses stale photo callbacks", async () => {
    records = [document()]; await ready();
    expect(render().nodes.some((node) => node.type === "button" && content(node).includes("اجعلها صورة المريض"))).toBe(false);
    const changed = vi.fn(); render({ onPhotoChange: changed });
    const photo = render().nodes.find((node) => node.type === "button" && content(node).includes("اجعلها صورة المريض"))!;
    const pending = deferred<ReturnType<typeof reply>>(); fetchMock.mockImplementation((_url: string, init?: RequestInit) => init?.method ? pending.promise : Promise.resolve(reply({ documents: [], storageReady: true })));
    (photo.props.onClick as () => void)();
    render({ authorityKey: "changed" }); await settle(); pending.resolve(reply({ id: 91 })); await settle();
    expect(changed).not.toHaveBeenCalled();
  });
  it("clears the previous file source when the camera supplies the selected file", async () => {
    await ready(); pick("older-file.png"); pick("camera.png", true); await submit();
    const form = posts()[0][1].body as FormData;
    expect((form.get("file") as File).name).toBe("camera.png"); expect(form.get("kind")).toBe("photo");
    expect(form.get("photoStage")).toBe("progress");
  });
  it("blocks blind resubmit after network uncertainty until reviewed explicit new-draft choice", async () => {
    await ready(); change("زيارة المستند", "71"); pick("possibly-saved.png");
    fetchMock.mockRejectedValueOnce(new TypeError("synthetic disconnected response"));
    await submit();
    expect(submitDisabled()).toBe(true); expect(render().text).toContain("قد يكون المستند حُفظ");
    await submit(); expect(posts()).toHaveLength(1);
    const restart = "راجعت السجل؛ ابدأ مسودة رفع جديدة";
    expect(button(restart).props.disabled).toBe(true); await click(restart); expect(submitDisabled()).toBe(true);
    // A same-name document is not reconciliation when no trustworthy ID returned.
    records = [{ ...document(888, 71), title: "possibly-saved.png" }];
    await click("حدّث السجل وراجع نتيجة الرفع");
    expect(render().text).not.toContain("تم التحقق من المستند"); expect(submitDisabled()).toBe(true);
    expect(button(restart).props.disabled).toBe(false); await click(restart);
    expect(control("زيارة المستند").props.value).toBe(""); expect(submitDisabled()).toBe(true);
    await submit(); expect(posts()).toHaveLength(1);
    pick("explicit-new.png"); await submit(); expect(posts()).toHaveLength(2);
  });
  it("reconciles an uncertain response by exact same-patient returned ID and canonical association, never filename", async () => {
    await ready(); change("زيارة المستند", "71"); pick();
    fetchMock.mockResolvedValueOnce(reply(document(801, 72)));
    await submit(); expect(submitDisabled()).toBe(true);
    records = [document(801, 71)]; await click("حدّث السجل وراجع نتيجة الرفع");
    expect(render().text).toContain("تم التحقق من المستند #801 بعد إعادة التحميل");
    expect(render().text).not.toContain("نتيجة الرفع تحتاج مراجعة"); expect(posts()).toHaveLength(1);
    expect(control("زيارة المستند").props.value).toBe(""); expect(submitDisabled()).toBe(true);
  });
  it("keeps the uncertain upload locked when canonical review is missing, mismatched, or fails", async () => {
    await ready(); change("زيارة المستند", "71"); pick();
    fetchMock.mockResolvedValueOnce(reply(document(801, 72)));
    await submit();
    fetchMock.mockResolvedValueOnce(reply({ message: "synthetic denied read" }, false));
    await click("حدّث السجل وراجع نتيجة الرفع");
    expect(button("راجعت السجل؛ ابدأ مسودة رفع جديدة").props.disabled).toBe(true);
    records = [document(801, 72), document(802, 71)];
    await click("حدّث السجل وراجع نتيجة الرفع");
    expect(render().text).not.toContain("تم التحقق من المستند"); expect(submitDisabled()).toBe(true);
    await submit(); expect(posts()).toHaveLength(1);
  });
  it("treats a server error as an uncertain write and never retries automatically", async () => {
    await ready(); pick();
    fetchMock.mockResolvedValueOnce({ ...reply({ message: "synthetic server error" }, false), status: 500 });
    await submit(); expect(render().text).toContain("قد يكون المستند حُفظ");
    expect(submitDisabled()).toBe(true); await submit(); expect(posts()).toHaveLength(1);
  });
  it("preserves definitive validation error details without claiming success or automatic retry", async () => {
    await ready(); change("زيارة المستند", "71"); pick();
    fetchMock.mockResolvedValueOnce(reply({ message: "الزيارة لا تخص هذا المريض" }, false));
    await submit(); expect(render().text).toContain("الزيارة لا تخص هذا المريض");
    expect(render().text).not.toContain("تم التحقق من المستند"); expect(posts()).toHaveLength(1);
    expect(control("زيارة المستند").props.value).toBe(71); expect(submitDisabled()).toBe(false);
  });
  it("keeps the explicit context frozen until canonical readback finishes", async () => {
    await ready(); change("زيارة المستند", "71"); pick();
    const readback = deferred<ReturnType<typeof reply>>();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => init?.method === "POST" ? Promise.resolve(reply(document(801, 71))) : readback.promise);
    const saving = submit(); await settle();
    expect(control("زيارة المستند").props.value).toBe(71); expect(submitDisabled()).toBe(true);
    expect(guard?.()).toBe(false); expect(render().text).not.toContain("تم التحقق من المستند");
    readback.resolve(reply({ documents: [document(801, 71)], storageReady: true })); await saving;
    expect(render().text).toContain("تم التحقق من المستند #801");
  });

  it.each(["admin", "reception", "doctor"])("retains explicitly authorized %s upload without deriving authority from read access", async (role) => {
    hooks.session = { username: "synthetic", role, permissions: role === "doctor" ? { canUploadXrays: true, canViewXrays: true } : {} };
    await ready(); pick(); expect(submitDisabled()).toBe(false); await submit(); expect(posts()).toHaveLength(1);
  });
  it.each([false, undefined])("withholds upload for a document-reading doctor with upload grant %s", async (grant) => {
    hooks.session = { username: "synthetic", role: "doctor", permissions: { canViewXrays: true, ...(grant === undefined ? {} : { canUploadXrays: grant }) } };
    await ready(); pick(); await submit();
    expect(posts()).toHaveLength(0); expect(submitDisabled()).toBe(true);
    expect(render().text).toContain("صلاحية الاطلاع لا تمنح صلاحية الرفع");
    expect(render().nodes.find((node) => node.type === "fieldset")!.props.disabled).toBe(true);
  });
  it("blocks a retained allowed upload handler after permission revocation and removes its draft", async () => {
    await ready(); change("زيارة المستند", "71"); pick("revoked.png");
    const form = render().nodes.find((node) => node.type === "form")!;
    const oldHandler = form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>;
    hooks.session.permissions = { canViewXrays: true, canUploadXrays: false };
    render(); await settle();
    await oldHandler({ preventDefault: () => {} });
    expect(posts()).toHaveLength(0); expect(render().text).not.toContain("revoked.png"); expect(submitDisabled()).toBe(true);
  });

});
