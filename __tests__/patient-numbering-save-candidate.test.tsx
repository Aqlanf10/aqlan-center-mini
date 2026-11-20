import { readFileSync } from "node:fs";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PatientNumberingSaveCandidate, type PatientNumberingSaveCandidateProps } from "../components/settings/PatientNumberingSaveCandidate";
import { isCommandRevision, readSaveTicket, readSaveSuccess, saveDraft, saveProblem, type NumberingSaveDraft, type NumberingSaveOperations, type NumberingSaveTicket, type NumberingSaveResult, type SavePreviewResult } from "../components/settings/patient-numbering-save-model";
import { executeNumberingCommand, type NumberingBackend, type AppliedNumbering } from "../lib/patient-numbering-command";
import { ownerContextFromTrustedBinding, resolveStaffCapabilities } from "../lib/staff-capabilities";
// Actual component callbacks, synthetic display values, no DOM or backend. This
// checks async state and native semantics, not browser focus/keyboard rendering.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(), pending: [] as Array<() => void> }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const effect = (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = slot(undefined), old = hooks.effects.get(index);
    if (old?.deps && deps && old.deps.length === deps.length && deps.every((v, i) => Object.is(v, old.deps![i]))) return;
    hooks.pending.push(() => { old?.cleanup?.(); const cleanup = run(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
  };
  return { ...react,
    useState: (initial: unknown) => { const index = slot(typeof initial === "function" ? initial() : initial); return [hooks.values[index], (value: unknown) => {
      const next = typeof value === "function" ? value(hooks.values[index]) : value;
      if (!Object.is(next, hooks.values[index])) hooks.changed = true; hooks.values[index] = next;
    }]; },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useId: () => `synthetic-numbering-${slot("id")}`, useEffect: effect, useLayoutEffect: effect,
  };
});
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
let props: PatientNumberingSaveCandidateProps;
function render(): ReactNode {
  for (let i = 0; i < 10; i++) {
    hooks.cursor = 0; hooks.changed = false; const tree = PatientNumberingSaveCandidate(props);
    if (hooks.changed) { hooks.pending.length = 0; continue; }
    hooks.pending.splice(0).forEach(run => run()); if (!hooks.changed) return tree;
  }
  throw new Error("Save UI did not settle");
}
function element(type: string, tree = render(), predicate: (e: Element) => boolean = () => true) {
  const match = nodes(tree).find(n => n.type === type && predicate(n)); expect(match).toBeDefined(); return match!;
}
function button(label: string, tree = render()) { return element("button", tree, n => text(n) === label); }
const status = () => text(nodes(render()).find(n => n.props.role === "status"));
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); render(); };
function change(type: "input" | "textarea" | "select", value: string) {
  const field = element(type, render(), n => n.props.type !== "checkbox");
  (field.props.onChange as (e: { target: { value: string } }) => void)({ target: { value } }); render();
}
function submit(tree = render()) { const preventDefault = vi.fn(); (element("form", tree).props.onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault }); expect(preventDefault).toHaveBeenCalledOnce(); }
function click(label: string, tree = render()) { (button(label, tree).props.onClick as () => void)(); }
function confirm(checked = true) { (element("input", render(), n => n.props.type === "checkbox").props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked } }); render(); }
function ticket(input: NumberingSaveDraft): NumberingSaveTicket {
  return { ...input, preview: `${input.prefix}-${input.next.padStart(5, "0")}`, expectedRevision: "2:P:A:1499:1:0:1", requestId: "synthetic-request-0001", previewToken: "synthetic-opaque/token=+", };
}
function success(input: NumberingSaveTicket, replay = false): NumberingSaveResult {
  return { ok: true, value: { prefix: input.prefix, next: input.next, preview: input.preview, revision: "3:A:A:1500:0:0:1" }, replay };
}
function ops() {
  return { preview: vi.fn(async (input: NumberingSaveDraft): Promise<SavePreviewResult> => ({ ok: true, ticket: ticket(input) })),
    save: vi.fn(async (input: NumberingSaveTicket): Promise<NumberingSaveResult> => success(input)) };
}
function deferred<T>() { let resolve!: (r: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function prepare(operations: NumberingSaveOperations = ops()) {
  props.operations = operations; change("select", "A"); change("input", "١٥٠٠"); change("textarea", "  synthetic reason  "); submit(); await settle(); confirm(); return operations;
}
beforeEach(() => {
  hooks.effects.forEach(e => e.cleanup?.()); hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.effects.clear(); hooks.pending = [];
  props = { current: { prefix: "P", next: "18", revision: "display-r1" }, readGate: { state: "verified", readId: "synthetic-read-1" } };
});

describe("proposed save ticket grammar, not existing token issuance", () => {
  const draft = { prefix: "A", next: "1500", reason: "synthetic reason" };
  it("preserves provider revision, request ID and opaque token without exposing extra metadata", () => {
    const value = ticket(draft); expect(readSaveTicket({ ...value, privateExtra: "synthetic-secret" }, draft)).toEqual(value);
    expect(isCommandRevision("display/+revision")).toBe(false);
  });
  it.each(["prefix", "next", "reason", "preview"])("rejects a mismatching intent %s", key => expect(readSaveTicket({ ...ticket(draft), [key]: "different" }, draft)).toBeNull());
  it.each([undefined, "", "short", "contains-invalid+characters"])("rejects invalid request ID %s", requestId => expect(readSaveTicket({ ...ticket(draft), requestId }, draft)).toBeNull());
  it.each([undefined, "", "invalid/version", "a".repeat(129)])("rejects invalid expectedRevision %s", expectedRevision => expect(readSaveTicket({ ...ticket(draft), expectedRevision }, draft)).toBeNull());
  it.each([undefined, "", "x".repeat(8193)])("rejects absent or unbounded token", previewToken => expect(readSaveTicket({ ...ticket(draft), previewToken }, draft)).toBeNull());
  it.each(["", " ", "x".repeat(501)])("requires a bounded reason", reason => expect(saveDraft("A", "1500", reason)).toBeNull());
  it.each(["session-required", "invalid-preview", "preview-authority-changed", "preview-command-mismatch", "preview-expired", "numbering-clock-unavailable", "invalid-snapshot"])("gives fixed Arabic explanation for %s", reason => {
    expect(saveProblem(reason)).not.toContain(reason); expect(saveProblem(reason)).not.toBe(saveProblem("unknown"));
  });
  it("preserves18 digits and does not use Number", () => expect(saveDraft("z", "999999999999999999", "ok")).toEqual({ prefix: "Z", next: "999999999999999999", reason: "ok" }));
  it.each([null, {}, { ok: true }, { ok: true, replay: "yes", value: {} }])("rejects malformed success", response => expect(readSaveSuccess(response, ticket(draft))).toBeNull());
});

describe("actual injected-only save candidate", () => {
  it("is disconnected by default and cannot save by Enter or direct callback", () => {
    const tree = render(); expect(element("section", tree).props.dir).toBe("rtl");
    expect(button("فحص المعاينة", tree).props.disabled).toBe(true); expect(button("حفظ القيم المعاينة", tree).props.disabled).toBe(true);
    submit(tree); click("حفظ القيم المعاينة", tree); expect(status()).toBe("");
    expect(text(tree)).toContain("غير موصولة بإعدادات العيادة"); expect(text(tree)).toContain("أرقام الملفات الموجودة لا تتغيّر");
    for (const n of nodes(tree).filter(n => ["select", "textarea"].includes(String(n.type)) || n.type === "input" && n.props.type === "text")) expect(nodes(tree).some(label => label.type === "label" && label.props.htmlFor === n.props.id)).toBe(true);
    expect(element("input", tree).props).toMatchObject({ type: "text", inputMode: "numeric" });
  });
  it("takes revision/requestId/token from returned preview, not the displayed snapshot; confirms only returned success", async () => {
    const o = ops(); await prepare(o);
    expect(o.preview).toHaveBeenCalledExactlyOnceWith({ prefix: "A", next: "1500", reason: "synthetic reason" });
    expect(o.save).not.toHaveBeenCalled(); expect(status()).toContain("لم يُرسل طلب حفظ بعد");
    click("حفظ القيم المعاينة"); await settle();
    expect(o.save).toHaveBeenCalledExactlyOnceWith(ticket({ prefix: "A", next: "1500", reason: "synthetic reason" }));
    expect(status()).toContain("أكد المصدر نجاح"); expect(status()).not.toContain("display-r1");
    expect(text(render())).not.toContain("synthetic-opaque"); expect(text(render())).not.toContain("synthetic-request");
    expect(nodes(render()).filter(n => n.type === "bdi").map(text)).toEqual(["P-00018", "A-01500"]);
  });
  it("shows no next ID for a verified exhausted prefix, but allows the owner to select another letter", async () => {
    const o = ops();
    props.operations = o;
    props.current = { prefix: "A", next: null, revision: "2:A:A:999999999999999999:1:0:1" };
    const tree = render();
    expect(text(tree)).toContain("نفدت أرقام هذه السلسلة");
    expect(element("input", tree).props.value).toBe("");
    change("input", "1500"); change("textarea", "synthetic");
    expect(button("فحص المعاينة").props.disabled).toBe(true);
    submit(); expect(o.preview).not.toHaveBeenCalled();
    change("select", "B");
    expect(button("فحص المعاينة").props.disabled).toBe(false);
    submit(); await settle();
    expect(o.preview).toHaveBeenCalledExactlyOnceWith({ prefix: "B", next: "1500", reason: "synthetic" });
  });
  it("requires a fresh confirmation and never submits save with form Enter", async () => {
    const o = ops(); await prepare(o); confirm(false); click("حفظ القيم المعاينة"); expect(o.save).not.toHaveBeenCalled();
    submit(); await settle(); expect(o.save).not.toHaveBeenCalled(); expect(element("input", render(), n => n.props.type === "checkbox").props.checked).toBe(false);
  });
  it("guards synchronous duplicate preview and save callbacks, including consumed stale save handlers", async () => {
    const o = ops(), d = deferred<NumberingSaveResult>(); o.save.mockImplementation(() => d.promise); await prepare(o);
    const tree = render(); click("حفظ القيم المعاينة", tree); click("حفظ القيم المعاينة", tree); expect(o.save).toHaveBeenCalledOnce();
    d.resolve(success(o.save.mock.calls[0][0])); await settle(); click("حفظ القيم المعاينة", tree); expect(o.save).toHaveBeenCalledOnce();
    props.readGate = { state: "verified", readId: "synthetic-read-2" }; render(); change("input", "1600"); const v = render(); submit(v); submit(v); await settle(); expect(o.preview).toHaveBeenCalledTimes(2);
  });
  it.each(["input", "select", "textarea"] as const)("invalidates reviewed intent after %s edits including A/B/A", async field => {
    const o = ops(); await prepare(o);
    const old = field === "input" ? "1500" : field === "select" ? "A" : "  synthetic reason  ";
    change(field, field === "input" ? "1600" : field === "select" ? "B" : "different reason"); change(field, old);
    confirm(); click("حفظ القيم المعاينة"); expect(o.save).not.toHaveBeenCalled(); expect(button("حفظ القيم المعاينة").props.disabled).toBe(true);
  });
  it.each(["revision", "provider"])("invalidates preview/confirmation after %s A/B/A", async kind => {
    const o = ops(); await prepare(o);
    if (kind === "revision") props.current = { ...props.current, revision: "display-r2" }; else props.operations = ops(); render();
    if (kind === "revision") props.current = { ...props.current, revision: "display-r1" }; else props.operations = o; render();
    click("حفظ القيم المعاينة"); expect(o.save).not.toHaveBeenCalled(); expect(status()).toContain("تغيّرت القيم");
  });
  it("rejects late preview after edit/unmount and never restores a save ticket", async () => {
    const o = ops(), d = deferred<SavePreviewResult>(); o.preview.mockImplementation(() => d.promise);
    props.operations = o; change("textarea", "synthetic"); submit(); change("input", "19");
    d.resolve({ ok: true, ticket: ticket(o.preview.mock.calls[0][0]) }); await settle(); confirm(); click("حفظ القيم المعاينة"); expect(o.save).not.toHaveBeenCalled();
    const e = deferred<SavePreviewResult>(); o.preview.mockImplementation(() => e.promise); submit(); render(); hooks.effects.forEach(effect => effect.cleanup?.());
    const before = [...hooks.values]; e.resolve({ ok: true, ticket: ticket(o.preview.mock.calls[1][0]) }); for (let i = 0; i < 8; i++) await Promise.resolve(); expect(hooks.values).toEqual(before);
  });
  it.each([null, {}, { ok: true }, { ok: false, reason: "synthetic-secret" }])("does not enable save for malformed/refused preview", async response => {
    const o = ops(); o.preview.mockResolvedValue(response as SavePreviewResult); await prepare(o); click("حفظ القيم المعاينة"); expect(o.save).not.toHaveBeenCalled(); expect(status()).not.toContain("synthetic-secret");
  });
  it("freezes intent while save is pending, and hides old success after context change", async () => {
    const o = ops(), d = deferred<NumberingSaveResult>(); o.save.mockImplementation(() => d.promise); await prepare(o); click("حفظ القيم المعاينة");
    expect(element("fieldset").props.disabled).toBe(true); change("input", "999"); expect(element("input").props.value).toBe("1500"); submit(); expect(o.preview).toHaveBeenCalledOnce();
    props.current = { ...props.current, revision: "display-r2" }; render(); d.resolve(success(o.save.mock.calls[0][0])); await settle();
    expect(status()).toContain("لا تنسب نتيجة الطلب السابق"); expect(status()).not.toContain("أكد المصدر نجاح");
  });
  it("retains exact ticket for uncertain retry and shows historical replay without claiming current counter", async () => {
    const o = ops(); o.save.mockRejectedValueOnce(new Error("synthetic-secret")).mockImplementationOnce(async input => success(input, true)); await prepare(o);
    click("حفظ القيم المعاينة"); await settle(); expect(status()).toContain("ربما نُفّذ"); expect(status()).not.toContain("synthetic-secret");
    change("input", "999"); change("textarea", "different"); submit(); expect(o.preview).toHaveBeenCalledOnce();
    expect(element("input").props.value).toBe("1500"); click("إعادة محاولة الطلب نفسه"); await settle();
    expect(o.save.mock.calls[1][0]).toEqual(o.save.mock.calls[0][0]); expect(status()).toContain("دون تكراره"); expect(status()).toContain("ليست قراءةً جديدة");
  });
  it.each([null, {}, { ok: true }, { ok: false, reason: "numbering-transaction-failed" }, { ok: false, reason: "unknown" }])("treats unconfirmed save response as uncertain", async response => {
    const o = ops(); o.save.mockResolvedValue(response as NumberingSaveResult); await prepare(o); click("حفظ القيم المعاينة"); await settle();
    expect(status()).toContain("غير مؤكدة"); expect(element("fieldset").props.disabled).toBe(true);
  });
  it.each(["prefix", "next", "preview", "revision"])("treats mismatched/invalid success %s as uncertain", async field => {
    const o = ops(); o.save.mockImplementation(async input => { const r = success(input); return r.ok ? { ...r, value: { ...r.value, [field]: "invalid/value" } } : r; });
    await prepare(o); click("حفظ القيم المعاينة"); await settle(); expect(status()).toContain("غير مؤكدة");
  });
  it.each(["owner-required", "stale-preview", "would-reuse-or-rewind", "history-unverified", "idempotency-conflict", "invalid-preview", "preview-expired", "session-required", "preview-authority-changed", "preview-command-mismatch", "numbering-clock-unavailable"])("requires new preview after definite initial refusal %s", async reason => {
    const o = ops(); o.save.mockResolvedValue({ ok: false, reason }); await prepare(o); click("حفظ القيم المعاينة"); await settle();
    expect(status()).not.toContain("أكد المصدر نجاح"); expect(element("fieldset").props.disabled).toBe(true);
    click("حفظ القيم المعاينة"); expect(o.save).toHaveBeenCalledOnce(); props.readGate = { state: "verified", readId: "synthetic-read-2" }; render(); change("input", "1600"); submit(); await settle(); expect(o.preview).toHaveBeenCalledTimes(2);
  });
  it("does not erase prior uncertainty when a retry is denied", async () => {
    const o = ops(); o.save.mockRejectedValueOnce(new Error("synthetic lost response")).mockResolvedValueOnce({ ok: false, reason: "owner-required" }); await prepare(o);
    click("حفظ القيم المعاينة"); await settle(); click("إعادة محاولة الطلب نفسه"); await settle();
    expect(status()).toContain("ربما نُفّذ"); expect(element("fieldset").props.disabled).toBe(true); submit(); expect(o.preview).toHaveBeenCalledOnce();
  });
  it("never retries through changed providers or revives an A/B/A context", async () => {
    const o = ops(); o.save.mockRejectedValue(new Error("synthetic loss")); await prepare(o); click("حفظ القيم المعاينة"); await settle();
    props.operations = ops(); render(); expect(button("إعادة محاولة الطلب نفسه").props.disabled).toBe(true); click("إعادة محاولة الطلب نفسه"); expect(o.save).toHaveBeenCalledOnce();
    props.operations = o; render(); click("إعادة محاولة الطلب نفسه"); expect(o.save).toHaveBeenCalledOnce(); expect(button("إعادة محاولة الطلب نفسه").props.disabled).toBe(true);
  });
  it("ignores completion after unmount, without claiming the server cancelled the save", async () => {
    const o = ops(), d = deferred<NumberingSaveResult>(); o.save.mockImplementation(() => d.promise); await prepare(o); click("حفظ القيم المعاينة"); render();
    hooks.effects.forEach(effect => effect.cleanup?.()); const before = [...hooks.values]; d.resolve(success(o.save.mock.calls[0][0]));
    for (let i = 0; i < 8; i++) await Promise.resolve(); expect(hooks.values).toEqual(before);
  });
  it("does not mutate provider-owned ticket objects or permit returned mutation to change retry intent", async () => {
    const o = ops(); const issued = ticket({ prefix: "A", next: "1500", reason: "synthetic reason" }); o.preview.mockResolvedValue({ ok: true, ticket: issued });
    const sent: NumberingSaveTicket[] = [];
    o.save.mockImplementation(async input => { sent.push({ ...input }); input.next = "999"; throw new Error("synthetic loss"); }); await prepare(o); issued.next = "777";
    click("حفظ القيم المعاينة"); await settle(); click("إعادة محاولة الطلب نفسه"); await settle();
    expect(sent).toEqual([ticket({ prefix: "A", next: "1500", reason: "synthetic reason" }), ticket({ prefix: "A", next: "1500", reason: "synthetic reason" })]);
    expect(issued.expectedRevision).toBe("2:P:A:1499:1:0:1"); expect(element("input").props.value).toBe("1500");
  });
  it.each([undefined, { state: "unverified" }, { state: "unresolved" }, { state: "verified", readId: "" }] as const)("defaults closed until host server reconciliation, not just a refresh callback", async readGate => {
    const o = ops(), refresh = vi.fn(); props.readGate = readGate; props.onRequestReconciliation = refresh;
    await prepare(o); click("حفظ القيم المعاينة"); expect(o.preview).not.toHaveBeenCalled(); expect(o.save).not.toHaveBeenCalled();
    expect(status()).toContain("متوقفان"); click("طلب مراجعة الحالة من الخادم"); expect(refresh).toHaveBeenCalledOnce();
    submit(); expect(o.preview).not.toHaveBeenCalled();
  });
  it("requires a distinct verified read after success; changed displayed revision alone is insufficient", async () => {
    const o = ops(); await prepare(o); click("حفظ القيم المعاينة"); await settle();
    props.current = { ...props.current, revision: "display-r2" }; render(); change("input", "1600"); submit();
    expect(o.preview).toHaveBeenCalledOnce(); expect(element("input").props.value).toBe("1500");
    props.readGate = { state: "verified", readId: "synthetic-read-2" }; render(); change("input", "1600"); submit(); await settle(); expect(o.preview).toHaveBeenCalledTimes(2);
  });
  it.each(["success", "refusal"])("requires a read after terminal %s, not a read arriving while pending", async outcome => {
    const o = ops(), d = deferred<NumberingSaveResult>(); o.save.mockImplementation(() => d.promise); await prepare(o); click("حفظ القيم المعاينة");
    props.readGate = { state: "verified", readId: "synthetic-read-2" }; render();
    d.resolve(outcome === "success" ? success(o.save.mock.calls[0][0]) : { ok: false, reason: "stale-preview" }); await settle();
    expect(element("fieldset").props.disabled).toBe(true); change("input", "1600"); submit(); expect(o.preview).toHaveBeenCalledOnce();
    props.readGate = { state: "verified", readId: "synthetic-read-3" }; render(); change("input", "1600"); submit(); await settle(); expect(o.preview).toHaveBeenCalledTimes(2);
  });
  it("does not accept a historical read identity reused after a terminal result", async () => {
    props.readGate = { state: "verified", readId: "synthetic-historical" }; render();
    props.readGate = { state: "verified", readId: "synthetic-read-1" }; render(); const o = ops(); await prepare(o); click("حفظ القيم المعاينة"); await settle();
    props.readGate = { state: "verified", readId: "synthetic-historical" }; render(); change("input", "1600"); submit();
    expect(o.preview).toHaveBeenCalledOnce(); expect(element("fieldset").props.disabled).toBe(true);
  });
  it("does not unlock uncertainty on a new read identity or refresh callback without receipt reconciliation", async () => {
    const o = ops(); o.save.mockRejectedValue(new Error("synthetic loss")); props.onRequestReconciliation = vi.fn(); await prepare(o);
    click("حفظ القيم المعاينة"); await settle(); props.readGate = { state: "verified", readId: "synthetic-read-2" }; render();
    expect(text(render())).toContain("إعادة المحاولة متوقفة"); click("طلب مراجعة الحالة من الخادم"); change("input", "1600"); submit();
    expect(o.preview).toHaveBeenCalledOnce(); expect(element("fieldset").props.disabled).toBe(true);
  });
  it("has no network, browser storage, generated token, owner inference or live endpoint", () => {
    for (const file of ["components/settings/PatientNumberingSaveCandidate.tsx", "components/settings/patient-numbering-save-model.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/\b(?:fetch|XMLHttpRequest|localStorage|sessionStorage|randomUUID|Date\.now)\b|["']\/api\/|from ["'](?:.*\/db|next\/|server-only)/);
    }
  });
});

// Integrated synthetic adapter: real command orchestration + in-memory serial
// transaction and synthetic resolver binding. NOT the future server seam, PG or auth.
describe("save UX with real command orchestration, synthetic backend only", () => {
  it("replays the same receipt once after lost response using returned target-prefix revision", async () => {
    const access = resolveStaffCapabilities({ subject: { userId: 99, role: "admin", isActive: true, clinicianPartyId: null }, permissionDocument: { schemaVersion: 2, confirmation: "owner", revision: 1, patientScope: "none", appointmentScope: "none", grants: {} } }, ownerContextFromTrustedBinding({ ownerUserId: 99, bindingVersion: "synthetic-only" }));
    let applied = 0, lost = false, revision = "target-prefix-r2";
    const receipts = new Map<string, { intent: string; result: AppliedNumbering }>();
    const backend: NumberingBackend = { transaction: async work => work({ owner: async () => access,
      replay: async (actor, request) => receipts.get(`${actor}:${request}`) ?? null,
      snapshot: async prefix => ({ prefix, revision, pendingNext: 1500n, allocatedThrough: 0n, historicalThrough: 1499n, historyComplete: true }),
      apply: async input => { applied++; revision = "applied-r3"; const result = { prefix: input.prefix, next: input.next, preview: input.preview, revision }; receipts.set(`${input.actorId}:${input.requestId}`, { intent: input.intent, result }); return result; },
    }) };
    let issued: NumberingSaveTicket;
    const operations: NumberingSaveOperations = { preview: async input => ({ ok: true, ticket: issued = { ...ticket(input), expectedRevision: revision } }),
      save: async command => {
        if (JSON.stringify(command) !== JSON.stringify(issued)) return { ok: false, reason: "invalid-preview" };
        const { preview: _display, previewToken: _token, ...raw } = command;
        const result = await executeNumberingCommand(raw, backend);
        if (!lost) { lost = true; throw new Error("synthetic response lost after commit"); }
        return result;
      } };
    await prepare(operations); click("حفظ القيم المعاينة"); await settle(); expect(applied).toBe(1); expect(status()).toContain("ربما نُفّذ");
    click("إعادة محاولة الطلب نفسه"); await settle(); expect(applied).toBe(1); expect(status()).toContain("دون تكراره");
  });
});
