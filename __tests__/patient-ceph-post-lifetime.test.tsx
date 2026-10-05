import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientCeph, type PatientCephProps } from "../components/PatientCeph";
import type { SessionInfo } from "../components/SessionProvider";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../lib/doctor-permissions";

// Execute the actual component and its installed handlers. Only hook storage,
// session input and transport are synthetic; real React/browser proof is separate.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false, mounted: true,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  pending: [] as Array<{ layout: boolean; run: () => void }>,
  session: null as SessionInfo | null,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = slot(undefined), previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); hooks.memos.set(index, { deps, value }); return value;
  };
  const effect = (layout: boolean) => (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = slot(undefined), previous = hooks.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    hooks.pending.push({ layout, run: () => {
      previous?.cleanup?.(); const cleanup = run();
      hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
    } });
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (update: unknown) => {
        const next = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = next;
      }];
    },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useLayoutEffect: effect(true), useEffect: effect(false),
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));

type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
const NEW = "+ دراسة سيفالومترية جديدة", OPEN = "📐 افتح مساحة التتبع والتحليل";
const BUSY = "جارٍ فتح كابينة الرسم…", CLOSE = "✕ إغلاق النموذج";
const PATIENT = 11, CASE = 21, DOC = 51;
let props: PatientCephProps;
let location: { href: string };
const callback = vi.fn(), fetchMock = vi.fn();
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function pendingPost() {
  const headers = deferred<Response>(), body = deferred<unknown>();
  const json = vi.fn(() => body.promise);
  return {
    headers, body, json,
    respond: (value: unknown = { id: 71 }, status = 201) => {
      headers.resolve({ ok: status >= 200 && status < 300, status, json } as unknown as Response);
      body.resolve(value);
    },
    sendHeaders: (status = 201) => headers.resolve({ ok: status >= 200 && status < 300, status, json } as unknown as Response),
  };
}
let posts: ReturnType<typeof pendingPost>[];
let imageIds: number[], nextDocumentRead: ReturnType<typeof pendingPost> | null;
const documents = (ids: number[]) => ({ documents: ids.map((id) => ({
  id, title: "Synthetic image " + id, isImage: true, mimeType: "image/png",
  takenOn: null, uploadedAt: "2026-01-01", removedAt: null,
})) });
function render() {
  if (!hooks.mounted) return null;
  for (let round = 0; round < 20; round++) {
    hooks.cursor = 0; hooks.changed = false; hooks.pending = [];
    const tree = PatientCeph(props);
    if (hooks.changed) continue;
    const pending = hooks.pending.splice(0);
    pending.filter((one) => one.layout).forEach((one) => one.run());
    pending.filter((one) => !one.layout).forEach((one) => one.run());
    if (!hooks.changed) return tree;
  }
  throw new Error("Ceph component did not settle");
}
async function flush() { for (let count = 0; count < 40; count++) await Promise.resolve(); render(); }
const button = (label: string) => {
  const found = nodes(render()).find((node) => node.type === "button" && text(node).trim() === label);
  if (!found) throw new Error("Missing ceph button: " + label); return found;
};
const handler = (label: string) => button(label).props.onClick as () => unknown;
const click = (label: string) => handler(label)();
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
const imageSelect = () => nodes(render()).find((node) => node.type === "select")!;
const chooseImage = (id: number) => (imageSelect().props.onChange as (event: { target: { value: string } }) => void)({ target: { value: String(id) } });
const unmount = () => { hooks.mounted = false; hooks.effects.forEach((effect) => effect.cleanup?.()); hooks.effects.clear(); };
async function open() { render(); await flush(); click(NEW); render(); }
function retire(kind: string) {
  if (kind === "cancel") click("إلغاء");
  else if (kind === "header") click(CLOSE);
  else if (kind === "unmount") unmount();
  else if (kind === "patient") props = { ...props, patientId: 12 };
  else if (kind === "case") props = { ...props, orthoCaseId: 22 };
  else if (kind === "principal") hooks.session = { ...hooks.session!, username: "synthetic-other" };
  else if (kind === "role") hooks.session = { ...hooks.session!, role: "reception" };
  else if (kind === "permissions") hooks.session = { ...hooks.session!, permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canUploadXrays: false } };
  else if (kind === "logout") hooks.session = null;
  else throw new Error("Unknown retirement");
  render();
}
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.mounted = true;
  hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  hooks.session = { username: "synthetic-admin", role: "admin", permissions: null };
  props = { patientId: PATIENT, orthoCaseId: CASE, embedded: true, currentPhase: "aligning", onAnalysisCreated: callback };
  location = { href: "/patients/11?tab=treatment&sub=ortho" }; posts = [];
  imageIds = [DOC]; nextDocumentRead = null;
  fetchMock.mockReset(); callback.mockReset();
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "POST") { const post = pendingPost(); posts.push(post); return post.headers.promise; }
    if (url.endsWith("/documents") && nextDocumentRead) {
      const read = nextDocumentRead; nextDocumentRead = null; return read.headers.promise;
    }
    return Promise.resolve({ ok: true, status: 200, json: async () =>
      url.endsWith("/ceph") ? { analyses: [] }
      : url.endsWith("/documents") ? documents(imageIds)
      : url.startsWith("/api/ortho?") ? { cases: [{ id: CASE }, { id: 22 }] }
      : { sets: [] },
    } as Response);
  });
  vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("window", { location });
});

describe("PatientCeph image selection follows owned document reads", () => {
  it("rejects a captured A selection change while B is pending, before returning to A", async () => {
    imageIds = [DOC, DOC + 1]; await open(); chooseImage(DOC + 1); render();
    const oldChange = imageSelect().props.onChange as (event: { target: { value: string } }) => void;
    const read = pendingPost(); nextDocumentRead = read;
    props = { ...props, patientId: 12 }; render();
    oldChange({ target: { value: String(DOC) } });
    props = { ...props, patientId: PATIENT }; render(); await flush(); click(NEW); render();
    expect(imageSelect().props.value).toBe(DOC + 1); expect(button(OPEN).props.disabled).toBe(false);
    read.respond(documents([999]), 200); await flush();
    expect(imageSelect().props.value).toBe(DOC + 1); expect(writes()).toHaveLength(0);
  });

  it("recovers to a new patient's only image without requiring a select change", async () => {
    await open(); const oldSubmit = handler(OPEN), oldChange = imageSelect().props.onChange;
    const read = pendingPost(); nextDocumentRead = read;
    props = { ...props, patientId: 12 }; render(); click(NEW); render();
    expect(imageSelect().props.value).toBe(""); expect(button(OPEN).props.disabled).toBe(true);
    oldSubmit(); expect(writes()).toHaveLength(0);
    read.respond(documents([DOC + 1]), 200); await flush();
    expect(imageSelect().props.value).toBe(DOC + 1); expect(button(OPEN).props.disabled).toBe(false);
    (oldChange as (event: { target: { value: string } }) => void)({ target: { value: String(DOC) } });
    render(); expect(imageSelect().props.value).toBe(DOC + 1);
    expect(writes()).toHaveLength(0); click(OPEN);
    expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe("/api/patients/12/ceph");
    expect(JSON.parse(writes()[0][1].body).documentId).toBe(DOC + 1);
  });

  it("clears the selection when the new document list has no images", async () => {
    await open(); imageIds = []; props = { ...props, patientId: 12 }; render(); await flush();
    click(NEW); render(); expect(imageSelect().props.value).toBe("");
    expect(button(OPEN).props.disabled).toBe(true); handler(OPEN)(); expect(writes()).toHaveLength(0);
  });

  it("preserves a valid explicit same-patient choice across case and display-name changes", async () => {
    imageIds = [DOC, DOC + 1]; await open(); chooseImage(DOC + 1); render();
    hooks.session = { ...hooks.session!, displayName: "Updated visible name" }; render();
    expect(imageSelect().props.value).toBe(DOC + 1);
    props = { ...props, orthoCaseId: 22 }; render(); await flush(); click(NEW); render();
    expect(imageSelect().props.value).toBe(DOC + 1); expect(button(OPEN).props.disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(writes()).toHaveLength(0); click(OPEN);
    expect(JSON.parse(writes()[0][1].body)).toMatchObject({ documentId: DOC + 1, orthoCaseId: 22 });
  });

  for (const boundary of ["response", "body"] as const) {
    it.each(["patient", "principal", "permissions"])(
      "ignores retired %s A→B→A document " + boundary, async (kind) => {
        await open(); const oldSubmit = handler(OPEN), oldProps = props, oldSession = hooks.session;
        retire(kind); await flush(); const replacementProps = props, replacementSession = hooks.session;
        const read = pendingPost(); nextDocumentRead = read;
        props = oldProps; hooks.session = oldSession; render(); // Hold this A generation's read.
        if (boundary === "body") { read.sendHeaders(200); await flush(); expect(read.json).toHaveBeenCalledOnce(); }
        props = replacementProps; hooks.session = replacementSession; render(); await flush();
        imageIds = [DOC + 2]; props = oldProps; hooks.session = oldSession; render(); await flush();
        click(NEW); render(); expect(imageSelect().props.value).toBe(DOC + 2);
        read.respond(documents([999]), 200); await flush();
        expect(imageSelect().props.value).toBe(DOC + 2); expect(button(OPEN).props.disabled).toBe(false);
        expect(text(render())).not.toContain("Synthetic image 999");
        if (boundary === "response") expect(read.json).not.toHaveBeenCalled();
        oldSubmit(); expect(writes()).toHaveLength(0);
        click(OPEN); expect(writes()).toHaveLength(1);
        expect(JSON.parse(writes()[0][1].body).documentId).toBe(DOC + 2);
      },
    );
  }

  it("ignores a retired document-body rejection without overwriting the current form", async () => {
    await open(); const read = pendingPost(); nextDocumentRead = read; retire("patient");
    read.sendHeaders(200); await flush(); expect(read.json).toHaveBeenCalledOnce();
    props = { ...props, patientId: PATIENT }; imageIds = [DOC + 1]; render(); await flush(); click(NEW); render();
    read.body.reject(new SyntaxError("Retired documents")); await flush();
    expect(imageSelect().props.value).toBe(DOC + 1); expect(button(OPEN).props.disabled).toBe(false);
    expect(nodes(render()).some((node) => node.props.role === "alert")).toBe(false);
    expect(writes()).toHaveLength(0);
  });
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe("PatientCeph creation belongs to its current form and authority", () => {
  it("preserves the request payload, callback and successful navigation", async () => {
    await open(); click(OPEN);
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe("/api/patients/11/ceph");
    expect(JSON.parse(writes()[0][1].body)).toEqual({
      documentId: DOC, phase: "during", xrayDate: null, device: null, orthoCaseId: CASE, refSet: "builtin_default",
    });
    expect(writes()[0][1].signal).toBeInstanceOf(AbortSignal);
    posts[0].respond(); await flush();
    expect(callback).toHaveBeenCalledExactlyOnceWith(71); expect(location.href).toBe("/ceph/71");
  });

  for (const boundary of ["response", "body"] as const) {
    it.each(["cancel", "header", "unmount", "patient", "case", "principal", "role", "permissions", "logout"])(
      "retires %s while awaiting " + boundary, async (kind) => {
        await open(); const savedSubmit = handler(OPEN); savedSubmit();
        if (boundary === "body") { posts[0].sendHeaders(); await flush(); expect(posts[0].json).toHaveBeenCalledOnce(); }
        retire(kind); const destination = "/patients/current?newer=choice"; location.href = destination;
        savedSubmit(); expect(writes()).toHaveLength(1);
        posts[0].respond(); await flush();
        expect((writes()[0][1].signal as AbortSignal).aborted).toBe(true);
        if (boundary === "response") expect(posts[0].json).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled(); expect(location.href).toBe(destination);
      },
    );
  }

  it.each(["patient", "case", "principal", "permissions"])("does not revive an A→B→A %s operation", async (kind) => {
    await open(); click(OPEN); posts[0].sendHeaders(); await flush();
    const oldProps = props, oldSession = hooks.session;
    retire(kind); props = oldProps; hooks.session = oldSession; render(); await flush();
    posts[0].body.resolve({ id: 71 }); await flush();
    expect(callback).not.toHaveBeenCalled(); expect(location.href).not.toBe("/ceph/71");
    expect(nodes(render()).some((node) => node.type === "button" && text(node).trim() === OPEN)).toBe(false);
  });

  it.each(["success", "http", "network", "json"])("old %s/finally cannot change a reopened form's busy state", async (outcome) => {
    await open(); click(OPEN);
    if (outcome === "json") { posts[0].sendHeaders(); await flush(); }
    click("إلغاء"); render(); click(NEW); render(); click(OPEN); render();
    if (outcome === "network") posts[0].headers.reject(new TypeError("Synthetic outage"));
    else if (outcome === "json") posts[0].body.reject(new SyntaxError("Synthetic JSON"));
    else posts[0].respond(outcome === "http" ? { message: "Retired error" } : { id: 71 }, outcome === "http" ? 503 : 201);
    await flush();
    expect(button(BUSY).props.disabled).toBe(true);
    expect(text(render())).not.toContain("Retired error"); expect(callback).not.toHaveBeenCalled();
    posts[1].respond({ id: 72 }); await flush();
    expect(callback).toHaveBeenCalledExactlyOnceWith(72); expect(location.href).toBe("/ceph/72");
  });

  it("locks two direct invocations before a disabled render, including during body decoding", async () => {
    await open(); const submit = handler(OPEN); submit(); submit();
    expect(writes()).toHaveLength(1); posts[0].sendHeaders(); await flush(); submit();
    expect(writes()).toHaveLength(1); posts[0].body.resolve({ id: 71 }); await flush();
    expect(callback).toHaveBeenCalledOnce();
  });

  it("disables a document selection no longer present in the current image options", async () => {
    await open();
    const select = nodes(render()).find((node) => node.type === "select" && node.props.value === DOC)!;
    (select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "999" } });
    render(); expect(button(OPEN).props.disabled).toBe(true);
    handler(OPEN)(); expect(writes()).toHaveLength(0);
  });

  it("a retired close handler cannot dismiss the next form", async () => {
    await open(); const close = handler("إلغاء"); close(); render(); click(NEW); render();
    close(); expect(button(OPEN)).toBeDefined(); click(OPEN); expect(writes()).toHaveLength(1);
  });

  it.each(["unmount", "patient", "case", "permissions", "cancel"])("rechecks ownership after callback-triggered %s", async (kind) => {
    await open(); callback.mockImplementation(() => retire(kind)); click(OPEN); posts[0].respond(); await flush();
    expect(callback).toHaveBeenCalledExactlyOnceWith(71); expect(location.href).not.toBe("/ceph/71");
  });

  it("preserves a pending same-owner form after a display-name-only change", async () => {
    await open(); click(OPEN); hooks.session = { ...hooks.session!, displayName: "Updated visible name" }; render();
    expect(button(BUSY).props.disabled).toBe(true); posts[0].respond(); await flush();
    expect(callback).toHaveBeenCalledExactlyOnceWith(71); expect(location.href).toBe("/ceph/71");
  });

  it.each(["http", "network", "json", "invalid-id"])("shows an active %s failure without retrying automatically", async (failure) => {
    await open(); click(OPEN);
    if (failure === "network") posts[0].headers.reject(new TypeError("Synthetic outage"));
    else if (failure === "json") { posts[0].sendHeaders(); await flush(); posts[0].body.reject(new SyntaxError("Synthetic JSON")); }
    else posts[0].respond(failure === "http" ? { message: "Current failure" } : {}, failure === "http" ? 503 : 201);
    await flush();
    expect(writes()).toHaveLength(1); expect(callback).not.toHaveBeenCalled();
    expect(nodes(render()).some((node) => node.props.role === "alert")).toBe(true);
    expect(button(OPEN).props.disabled).toBe(false);
    click(OPEN); expect(writes()).toHaveLength(2); // Deliberate user retry only.
    posts[1].respond(); await flush(); expect(location.href).toBe("/ceph/71");
  });

  it.each(["assistant", "cashier", "accountant", "doctor"])("does not create under a non-uploading %s authority", async (role) => {
    hooks.session = { username: "synthetic-limited", role, permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canUploadXrays: false } };
    render(); await flush(); const newStudy = button(NEW);
    expect(newStudy.props.disabled).toBe(true); (newStudy.props.onClick as () => void)(); render();
    expect(writes()).toHaveLength(0); expect(text(render())).not.toContain(OPEN);
  });
});
