import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "../app/login/page";

const h = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[], mounted: false, replace: vi.fn(), session: vi.fn() }));
vi.mock("react", async (original) => {
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
    useEffect: (effect: () => void) => { if (!h.mounted) h.effects.push(effect); },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: h.replace }) }));
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "مركز تجريبي", useSetting: () => "إعداد المركز" }));
vi.mock("../components/SessionProvider", () => ({ useSessionActions: () => ({ setSession: h.session }) }));
vi.mock("../components/InstallApp", () => ({ InstallApp: () => null }));
type El = ReactElement<Record<string, unknown>>;
const all = (n: ReactNode): El[] => Array.isArray(n) ? n.flatMap(all) : n && typeof n === "object" && "props" in n ? [n as El, ...all((n as El).props.children as ReactNode)] : [];
const txt = (n: ReactNode): string => typeof n === "string" ? n : Array.isArray(n) ? n.map(txt).join("") : n && typeof n === "object" && "props" in n ? txt((n as El).props.children as ReactNode) : "";
function render() { h.cursor = 0; const tree = LoginPage(); if (!h.mounted) { h.mounted = true; h.effects.splice(0).forEach(e => e()); return render(); } return tree; }
function node(id: string) { return all(render()).find(n => n.props.id === id)!; }
function checkbox() { return all(render()).find(n => n.props.type === "checkbox")!; }
function change(n: El, value: string) { (n.props.onChange as (e: unknown) => void)({ target: { value } }); }
const storage = new Map<string,string>();
const fetchMock = vi.fn();
const key = "aqlan_center_saved_username";
beforeEach(() => {
  h.values = []; h.cursor = 0; h.effects = []; h.mounted = false; h.replace.mockReset(); h.session.mockReset(); storage.clear(); fetchMock.mockReset();
  vi.stubGlobal("localStorage", { getItem: (k:string) => storage.get(k) ?? null, setItem: (k:string,v:string) => storage.set(k,v), removeItem: (k:string) => storage.delete(k) });
  vi.stubGlobal("window", { location: { pathname: "/login", search: "" }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("FormData", class { get(k:string) { return node(k).props.value; } });
});
afterEach(() => vi.unstubAllGlobals());
async function submit() { change(node("username"), " doctor "); change(node("password"), "synthetic-password"); await (node("login-form").props.onSubmit as (e:unknown)=>void)({ preventDefault() {}, currentTarget: {} }); for(let i=0;i<15;i++) await Promise.resolve(); }
describe("login reference UI preserves auth boundaries", () => {
  it("keeps IDs, autocomplete, masked password, opt-in default and keyboard reveal", () => {
    expect(node("login-form").props.noValidate).toBe(true);
    expect(node("username").props.autoComplete).toBe("username");
    expect(node("password").props.type).toBe("password");
    expect(node("password").props.autoComplete).toBe("current-password");
    expect(checkbox().props.checked).toBe(false);
    const reveal = all(render()).find(n => n.props["aria-label"] === "إظهار كلمة المرور")!;
    expect(reveal.props.tabIndex).not.toBe(-1);
    (reveal.props.onClick as ()=>void)();
    expect(node("password").props.type).toBe("text");
  });
  it("posts existing API, projects only existing session fields, stores nothing by default", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ username: "doctor", displayName: "Doctor", role: "doctor", token: "not-for-js" }) });
    await submit();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "doctor", password: "synthetic-password" }) });
    expect(h.session).toHaveBeenCalledWith({ username: "doctor", displayName: "Doctor", role: "doctor" });
    expect(h.replace).toHaveBeenCalledWith("/");
    expect(storage.size).toBe(0);
  });
  it("saves only username after explicit opt-in and successful login", async () => {
    (checkbox().props.onChange as (e:unknown)=>void)({ target: { checked: true } });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ username: "doctor", role: "doctor" }) });
    await submit();
    expect([...storage]).toEqual([[key,"doctor"]]);
  });
  it("restores saved username and removes it immediately on opt-out", () => {
    storage.set(key,"old-user");
    expect(node("username").props.value).toBe("old-user");
    (checkbox().props.onChange as (e:unknown)=>void)({ target: { checked: false } });
    expect(storage.size).toBe(0);
  });
  it("does not let unreliable offline hints block server login", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    fetchMock.mockResolvedValue({ ok:false, status:401, json: async()=>null });
    await submit();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(txt(node("login-error-alert"))).toContain("غير صحيحة");
    expect(h.session).not.toHaveBeenCalled();
  });
  it("keeps failed attempts retryable and never saves on rejection", async () => {
    (checkbox().props.onChange as (e:unknown)=>void)({ target: { checked: true } });
    fetchMock.mockResolvedValue({ ok:false, status:429, json:async()=>null });
    await submit();
    expect(txt(node("login-error-alert"))).toContain("لاحقاً");
    expect(txt(node("login-error-alert"))).not.toContain("دقيقة");
    expect(storage.size).toBe(0);
    expect(node("login-submit-btn").props.disabled).toBe(false);
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("prevents simultaneous duplicate requests", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await submit(); await submit();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("shows network failures and allows a later retry", async () => {
    fetchMock.mockRejectedValue(new Error("network unavailable"));
    await submit();
    expect(txt(node("login-error-alert"))).toContain("تعذّر الاتصال");
    expect(node("login-submit-btn").props.disabled).toBe(false);
    expect(h.session).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
  });
  it("validates missing credentials without sending a request", async () => {
    await (node("login-form").props.onSubmit as (e:unknown)=>void)({ preventDefault() {}, currentTarget: {} });
    expect(txt(node("login-error-alert"))).toContain("اسم المستخدم");
    expect(fetchMock).not.toHaveBeenCalled();
    change(node("username"), "doctor");
    await (node("login-form").props.onSubmit as (e:unknown)=>void)({ preventDefault() {}, currentTarget: {} });
    expect(txt(node("login-error-alert"))).toContain("كلمة المرور");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("retains autofill FormData as the source rather than stale controlled state", async () => {
    vi.stubGlobal("FormData", class { get(k:string) { return k === "username" ? "autofilled" : "autofill-password"; } });
    fetchMock.mockResolvedValue({ ok:true, json:async()=>({ username:"autofilled", role:"doctor" }) });
    await (node("login-form").props.onSubmit as (e:unknown)=>void)({ preventDefault() {}, currentTarget: {} });
    for(let i=0;i<15;i++) await Promise.resolve();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({username:"autofilled",password:"autofill-password"});
  });
  it.each([null, {}, { username: "doctor" }, { username: "", role: "doctor" }])("rejects malformed 200 response before persistence/navigation: %j", async (payload) => {
    (checkbox().props.onChange as (e:unknown)=>void)({ target: { checked: true } });
    fetchMock.mockResolvedValue({ ok:true, json:async()=>payload });
    await submit();
    expect(txt(node("login-error-alert"))).toContain("تعذّر تأكيد");
    expect(node("login-submit-btn").props.disabled).toBe(false);
    expect(storage.size).toBe(0);
    expect(h.session).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });
  it("associates rejected credentials with both fields without marking network errors invalid", async () => {
    fetchMock.mockResolvedValue({ ok:false, status:401, json:async()=>null });
    await submit();
    expect(node("username").props["aria-invalid"]).toBe(true);
    expect(node("password").props["aria-invalid"]).toBe(true);
    change(node("username"),"corrected");
    expect(node("username").props["aria-invalid"]).toBe(false);
  });
  it("opens honest generic help without hardcoded owner or external photo", () => {
    const help = all(render()).find(n=>n.props["aria-controls"]==="login-help")!;
    const focus = vi.fn();
    (help.props.ref as { current: unknown }).current = { focus };
    (help.props.onClick as ()=>void)();
    expect(node("login-help")).toBeDefined();
    expect(txt(node("login-help"))).toContain("مدير النظام");
    expect(txt(render())).not.toContain("د. عقلان الكامل");
    expect(all(render()).filter(n=>n.type==="img")).toHaveLength(0);
    const close = all(render()).find(n=>n.props["aria-label"]==="إغلاق الإرشاد")!;
    (close.props.onClick as ()=>void)();
    expect(focus).toHaveBeenCalledOnce();
    expect(node("login-help")).toBeUndefined();
  });
});
