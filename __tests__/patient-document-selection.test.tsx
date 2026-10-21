import type { ReactElement, ReactNode } from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Exercise the real rendered input handlers and upload command with synthetic files.
// This hook harness is not browser/React reconciliation acceptance.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    const owner = hooks.values;
    return [owner[index], (value: unknown) => { owner[index] = value; }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ role: "admin" }) }));
vi.mock("../components/ConsentModal", () => ({ ConsentModal: () => null }));
vi.mock("../components/BeforeAfterSlider", () => ({ BeforeAfterSlider: () => null }));
import { PatientDocuments } from "../components/PatientDocuments";

type Node = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Node[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Node, ...nodes((node as Node).props.children as ReactNode)] : [];
const render = (patientId = 7) => {
  hooks.cursor = 0;
  let tree = PatientDocuments({ patientId });
  if (typeof tree.type === "function") {
    const component = tree.type as (props: typeof tree.props) => typeof tree;
    tree = component(tree.props);
  }
  return nodes(tree);
};
const input = (all: Node[], id: string) => all.find(node => node.props.id === id)!;
const select = (id: string, file?: File) => {
  const node = input(render(), id);
  const ref = node.props.ref as { current: unknown };
  const target = { files: file ? [file] : [], value: file?.name ?? "" };
  ref.current = target;
  (node.props.onChange as (event: unknown) => void)({ target });
};
const submit = async () => {
  const form = render().find(node => node.type === "form")!;
  await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} });
};
const fetchMock = vi.fn();
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0;
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ documents: [], storageReady: true }) });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("patient document selection integrity", () => {
  it.each([
    ["document-file", "document-camera"],
    ["document-camera", "document-file"],
  ])("uploads the displayed most recent choice: %s then %s", async (first, second) => {
    select(first, new File(["old synthetic image"], "old.png", { type: "image/png" }));
    const latest = new File(["new synthetic image"], "latest.png", { type: "image/png" });
    select(second, latest);
    expect(nodes(render()).some(node => node.props.children === latest.name)).toBe(true);
    await submit();
    const upload = fetchMock.mock.calls.find(([, options]) => options?.method === "POST")!;
    expect(upload[0]).toBe("/api/patients/7/documents");
    const sent = (upload[1].body as FormData).get("file") as File;
    expect(sent.name).toBe(latest.name);
    expect(await sent.text()).toBe(await latest.text());
  });

  it("does not upload a stale alternate input after the active selection is cleared", async () => {
    select("document-file", new File(["synthetic"], "old.png", { type: "image/png" }));
    select("document-camera");
    await submit();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keys all document state by patient so navigation discards picked files and previews", () => {
    const first = PatientDocuments({ patientId: 7 });
    const second = PatientDocuments({ patientId: 8 });
    expect(first.key).toBe("7");
    expect(second.key).toBe("8");
    expect(first.type).toBe(second.type);
  });

  it("disables both pickers while uploading, then clears the selection after success", async () => {
    let finish!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    select("document-file", new File(["synthetic"], "chosen.png", { type: "image/png" }));
    const pending = submit();
    expect(input(render(), "document-file").props.disabled).toBe(true);
    expect(input(render(), "document-camera").props.disabled).toBe(true);
    finish({ ok: true, json: async () => ({}) });
    await pending;
    expect(input(render(), "document-file").props.disabled).toBe(false);
    fetchMock.mockClear();
    await submit();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains the exact chosen file after a rejected upload for explicit retry", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ message: "synthetic rejection" }) });
    select("document-camera", new File(["synthetic retry bytes"], "retry.png", { type: "image/png" }));
    await submit();
    await submit();
    const commands = fetchMock.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(commands).toHaveLength(2);
    for (const [, command] of commands) expect(await (command.body.get("file") as File).text()).toBe("synthetic retry bytes");
  });

  it("keeps an in-flight upload bound to its original patient after a keyed remount", async () => {
    let finish!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    select("document-camera", new File(["synthetic patient 7"], "seven.png", { type: "image/png" }));
    const pending = submit();
    // Simulate the fresh hook owner that React creates for the asserted new key.
    hooks.values = [];
    const newForm = render(8).find(node => node.type === "form")!;
    await (newForm.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} });
    finish({ ok: true, json: async () => ({}) });
    await pending;
    const posts = fetchMock.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe("/api/patients/7/documents");
    expect(input(render(8), "document-camera").props.disabled).toBe(false);
    expect(render(8).some(node => node.props.children === "seven.png")).toBe(false);
  });

});
