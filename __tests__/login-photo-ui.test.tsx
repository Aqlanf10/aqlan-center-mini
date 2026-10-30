import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPhoto } from "../components/LoginPhoto";
import { Logo } from "../components/Icon";
import { LoginPhotoEditor } from "../components/settings/LoginPhotoEditor";
import { LOGIN_PHOTO_ASSET as ASSET, LOGIN_PHOTO_VISIBLE as VISIBLE, LOGIN_PHOTO_MAX_BYTES } from "../lib/login-photo";

const h = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, visible: undefined as string | undefined }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useState: (initial: unknown) => {
      const i = h.cursor++;
      if (!(i in h.values)) h.values[i] = initial;
      return [h.values[i], (v: unknown) => { h.values[i] = typeof v === "function" ? v(h.values[i]) : v; }];
    },
    useRef: (initial: unknown) => {
      const i = h.cursor++;
      if (!(i in h.values)) h.values[i] = { current: initial };
      return h.values[i];
    },
  };
});
vi.mock("../components/SettingsProvider", () => ({ useSetting: () => h.visible }));
type El = ReactElement<Record<string, unknown>>;
const all = (n: ReactNode): El[] => Array.isArray(n) ? n.flatMap(all) : n && typeof n === "object" && "props" in n ? [n as El, ...all((n as El).props.children as ReactNode)] : [];
const txt = (n: ReactNode): string => typeof n === "string" ? n : Array.isArray(n) ? n.map(txt).join("") : n && typeof n === "object" && "props" in n ? txt((n as El).props.children as ReactNode) : "";
const hash = "a".repeat(64);
const asset = JSON.stringify({ key: `aa/aa/${hash}.loginpng`, sha256: hash, mimeType: "image/png", sizeBytes: 68, width: 1, height: 1 });
const versions = { [ASSET]: "asset-v1", [VISIBLE]: "visible-v1" };
const fetchMock = vi.fn();
const saved = vi.fn();
let props: Parameters<typeof LoginPhotoEditor>[0];
const payload = (visible = false) => ({ [ASSET]: asset, [VISIBLE]: String(visible), __versions: { [ASSET]: "asset-v2", [VISIBLE]: "visible-v2" } });
function editor() { h.cursor = 0; return LoginPhotoEditor(props); }
function photo() { h.cursor = 0; return LoginPhoto(); }
function button(label: string) { return all(editor()).find(n => n.type === "button" && txt(n) === label)!; }
function fileInput() { return all(editor()).find(n => n.props.type === "file")!; }
function choose(file = new File([new Uint8Array([137, 80, 78, 71])], "synthetic.png", { type: "image/png" })) {
  (fileInput().props.onChange as (e: unknown) => void)({ target: { files: [file] } });
  return file;
}
function click(label: string) { (button(label).props.onClick as () => void)(); }
async function settle() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
function alert() { return txt(all(editor()).find(n => n.props.role === "alert")); }
beforeEach(() => {
  h.values = []; h.cursor = 0; h.visible = undefined;
  fetchMock.mockReset(); saved.mockReset(); vi.stubGlobal("fetch", fetchMock);
  props = { values: { [ASSET]: asset, [VISIBLE]: "false" }, versions, editable: true, onSaved: saved };
});
afterEach(() => vi.unstubAllGlobals());

describe("login photo safe display", () => {
  it.each([undefined, "false", "", "https://untrusted.invalid/photo.png"])("defaults to official Logo without an image request for %s", visible => {
    h.visible = visible;
    expect(all(photo()).some(n => n.type === Logo)).toBe(true);
    expect(all(photo()).some(n => n.type === "img")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("uses only the fixed public endpoint when visible and falls back on image failure", () => {
    h.visible = "true";
    const image = all(photo()).find(n => n.type === "img")!;
    expect(image.props.src).toBe("/api/branding/login-photo");
    expect(image.props.alt).toBe("صورة شاشة الدخول");
    (image.props.onError as () => void)();
    expect(all(photo()).some(n => n.type === "img")).toBe(false);
    expect(all(photo()).some(n => n.type === Logo)).toBe(true);
  });
});

describe("login photo editor", () => {
  it("offers no mutations or private preview to a read-only user", () => {
    props.editable = false;
    expect(all(editor()).filter(n => n.type === "button" || n.type === "input" || n.type === "img")).toEqual([]);
    expect(txt(editor())).toContain("متاح لإدارة الهوية فقط");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("shows empty fallback and disables upload/show until a photo is available", () => {
    props.values = {};
    expect(txt(editor())).toContain("يظهر شعار المركز بدلًا منها");
    expect(button("حفظ الصورة مخفية").props.disabled).toBe(true);
    expect(button("إظهار الصورة للزوار").props.disabled).toBe(true);
  });
  it("uploads a synthetic file with both concurrency stamps, clears the input and confirms hidden state", async () => {
    const file = choose();
    const input = { value: "synthetic.png" };
    (fileInput().props.ref as { current: unknown }).current = input;
    fetchMock.mockResolvedValue({ ok: true, json: async () => payload() });
    click("حفظ الصورة مخفية"); await settle();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/settings/login-photo"); expect(request.method).toBe("POST");
    expect(request.body).toBeInstanceOf(FormData);
    expect(request.body.get("file")).toBe(file);
    expect(JSON.parse(request.body.get("__versions"))).toEqual(versions);
    expect(saved).toHaveBeenCalledWith(payload());
    expect(input.value).toBe(""); expect(button("حفظ الصورة مخفية").props.disabled).toBe(true);
    expect(txt(editor())).toContain("حُفظت الصورة وهي مخفية");
    expect(txt(editor())).toContain("تصبح الصورة عامة قبل تسجيل الدخول");
  });
  it.each([false, true])("explicitly toggles visibility from %s with both stamps and without re-uploading", async visible => {
    props.values[VISIBLE] = String(visible);
    fetchMock.mockResolvedValue({ ok: true, json: async () => payload(!visible) });
    click(visible ? "إخفاء الصورة" : "إظهار الصورة للزوار"); await settle();
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/login-photo", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visible: !visible, __versions: versions }) });
    expect(saved).toHaveBeenCalledWith(payload(!visible));
    expect(txt(editor())).toContain(visible ? "أُخفيت الصورة دون حذفها" : "أصبحت الصورة ظاهرة");
  });
  it("sends explicit null versions for a first upload", async () => {
    props.versions = {}; choose();
    fetchMock.mockResolvedValue({ ok: true, json: async () => payload() });
    click("حفظ الصورة مخفية"); await settle();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body.get("__versions"))).toEqual({ [ASSET]: null, [VISIBLE]: null });
  });
  it.each([409, 403, 500])("retains draft and current state after HTTP %s and allows retry", async status => {
    choose(); fetchMock.mockResolvedValue({ ok: false, status, json: async () => ({ message: "حدّث الإعدادات" }) });
    click("حفظ الصورة مخفية"); await settle();
    expect(saved).not.toHaveBeenCalled(); expect(alert()).toBe("حدّث الإعدادات");
    expect(button("حفظ الصورة مخفية").props.disabled).toBe(false);
    expect(txt(editor())).toContain("الحالة: محفوظة ومخفية");
    click("حفظ الصورة مخفية"); await settle(); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("retains draft on transport failure and permits retry", async () => {
    choose(); fetchMock.mockRejectedValue(new Error("offline"));
    click("حفظ الصورة مخفية"); await settle();
    expect(saved).not.toHaveBeenCalled(); expect(alert()).toContain("تعذّر تأكيد الحفظ");
    expect(button("حفظ الصورة مخفية").props.disabled).toBe(false);
  });
  it("blocks synchronous duplicates and other mutations until the request completes", async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockReturnValue(new Promise(r => { resolve = r; })); choose();
    const handler = button("حفظ الصورة مخفية").props.onClick as () => void;
    handler(); handler(); click("إظهار الصورة للزوار");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(all(editor()).find(n => n.type === "fieldset")!.props.disabled).toBe(true);
    resolve({ ok: true, json: async () => payload() }); await settle();
    expect(saved).toHaveBeenCalledOnce();
  });
  it.each([null, {}, { ...payload(), __versions: { [ASSET]: "v2" } }, { ...payload(), [ASSET]: "bad-json" }, { ...payload(), [VISIBLE]: "yes" }])("does not apply malformed success: %j", async response => {
    choose(); fetchMock.mockResolvedValue({ ok: true, json: async () => response });
    click("حفظ الصورة مخفية"); await settle();
    expect(saved).not.toHaveBeenCalled(); expect(alert()).toContain("تعذّر تأكيد");
    expect(button("حفظ الصورة مخفية").props.disabled).toBe(false);
  });
  it.each([{ ...payload(), [ASSET]: "" }, payload(true)])("rejects upload success that does not confirm a hidden stored photo: %j", async response => {
    choose(); fetchMock.mockResolvedValue({ ok: true, json: async () => response });
    click("حفظ الصورة مخفية"); await settle();
    expect(saved).not.toHaveBeenCalled(); expect(alert()).toContain("تعذّر تأكيد");
  });
  it("rejects a show confirmation that still says hidden", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => payload(false) });
    click("إظهار الصورة للزوار"); await settle();
    expect(saved).not.toHaveBeenCalled(); expect(alert()).toContain("تعذّر تأكيد");
  });
  it("retains draft when a 200 response is not JSON", async () => {
    choose(); fetchMock.mockResolvedValue({ ok: true, json: async () => { throw new Error("invalid json"); } });
    click("حفظ الصورة مخفية"); await settle();
    expect(saved).not.toHaveBeenCalled(); expect(alert()).toContain("تعذّر تأكيد");
    expect(button("حفظ الصورة مخفية").props.disabled).toBe(false);
  });
  it("does not accept a visibility response that silently replaces the configured asset", async () => {
    const anotherHash = "b".repeat(64);
    const anotherAsset = JSON.stringify({ ...JSON.parse(asset), key: `bb/bb/${anotherHash}.loginpng`, sha256: anotherHash });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...payload(true), [ASSET]: anotherAsset }) });
    click("إظهار الصورة للزوار"); await settle();
    expect(saved).not.toHaveBeenCalled(); expect(alert()).toContain("تعذّر تأكيد");
  });
  it.each([new File(["svg"], "synthetic.svg", { type: "image/svg+xml" }), new File([new Uint8Array(LOGIN_PHOTO_MAX_BYTES + 1)], "large.png", { type: "image/png" })])("rejects invalid client file selection %s without a request", file => {
    choose(file); expect(alert()).toContain("JPEG أو PNG");
    expect(button("حفظ الصورة مخفية").props.disabled).toBe(true); expect(fetchMock).not.toHaveBeenCalled();
  });
});
