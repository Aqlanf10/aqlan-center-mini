import { describe, expect, it, vi } from "vitest";
import {
  createPatientNavigation, patientDestination, patientLocationHref, readPatientLocation,
} from "../lib/patient-navigation";

describe("patient navigation destinations", () => {
  it.each([
    ["", "summary", "chart"], ["?tab=today", "today", "chart"],
    ["?tab=endo", "treatment", "endo"], ["?tab=ceph", "treatment", "ortho"],
    ["?tab=treatment&sub=ceph", "treatment", "ortho"], ["?tab=ledger", "account", "chart"],
    ["?tab=documents", "files", "chart"], ["?tab=visits", "today", "chart"],
    ["?tab=appointments", "summary", "chart"], ["?tab=overview", "summary", "chart"],
    ["?tab=endo&sub=plans", "treatment", "plans"], ["?tab=endo&sub=unknown", "treatment", "endo"],
    ["?tab=constructor&sub=toString", "summary", "chart"],
  ])("reads %s safely, including legacy aliases", (search, tab, sub) => {
    expect(readPatientLocation(search)).toEqual({ tab, sub });
  });
  it("resolves specialty shortcuts atomically while retaining the previous treatment context", () => {
    expect(patientDestination("ortho", { tab: "summary", sub: "endo" })).toEqual({ tab: "treatment", sub: "ortho" });
    expect(patientDestination("account", { tab: "treatment", sub: "endo" })).toEqual({ tab: "account", sub: "endo" });
  });
  it("only changes its consumed fields, preserving unrelated context and fragments", () => {
    const href = patientLocationHref("https://clinic.test/patients/91?tab=endo&review=1&planId=23&tag=a&tag=b#source", { tab: "treatment", sub: "plans", context: { planId: 23 } });
    expect(href).toBe("/patients/91?tab=treatment&review=1&tag=a&tag=b&planId=23&sub=plans#source");
    expect(readPatientLocation(new URL(href, "https://clinic.test").search)).toEqual({ tab: "treatment", sub: "plans", context: { planId: 23 } });
  });
});

function browser(search = "?tab=treatment&sub=endo") {
  let url = new URL(`https://clinic.test/patients/91${search}`);
  const history = {
    length: 4,
    replaceState: vi.fn((_state: unknown, _unused: string, href: string) => { url = new URL(href, url); }),
    pushState: vi.fn(), go: vi.fn(),
  };
  const host = {
    get location() { return url; }, history,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  };
  return { host: host as unknown as Window, history, changeUrl: (href: string) => { url = new URL(href, url); } };
}

describe("guarded patient URL updates without new tab history", () => {
  it("replaces only the active URL in one operation and retains query context", () => {
    const b = browser("?tab=summary&review=1"); const onChange = vi.fn(); const canLeave = vi.fn(() => true);
    const nav = createPatientNavigation(b.host, { onChange, canLeave });
    nav.navigate({ tab: "treatment", sub: "ortho" });
    expect(b.history.replaceState).toHaveBeenCalledTimes(1); expect(canLeave).toHaveBeenCalledTimes(1);
    expect(b.host.location.search).toBe("?tab=treatment&review=1&sub=ortho");
    expect(onChange).toHaveBeenLastCalledWith({ tab: "treatment", sub: "ortho" });
    expect(b.history.pushState).not.toHaveBeenCalled(); expect(b.history.go).not.toHaveBeenCalled();
    expect(b.history.length).toBe(4);
  });
  it("cancelled tab changes do not alter URL, view or history", () => {
    const b = browser(); const onChange = vi.fn(); const canLeave = vi.fn(() => false);
    const nav = createPatientNavigation(b.host, { onChange, canLeave }); onChange.mockClear();
    expect(nav.navigate({ tab: "today", sub: "endo" })).toBe(false);
    expect(canLeave).toHaveBeenCalledTimes(1); expect(onChange).not.toHaveBeenCalled();
    expect(b.history.replaceState).not.toHaveBeenCalled(); expect(b.history.pushState).not.toHaveBeenCalled();
    expect(b.host.location.search).toBe("?tab=treatment&sub=endo");
  });
  it("same-view clicks reconcile the rendered view without asking or altering history", () => {
    const b = browser(); const canLeave = vi.fn(() => false); const onChange = vi.fn();
    const nav = createPatientNavigation(b.host, { onChange, canLeave });
    expect(nav.navigate({ tab: "treatment", sub: "endo" })).toBe(true);
    expect(canLeave).not.toHaveBeenCalled(); expect(b.history.replaceState).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith({ tab: "treatment", sub: "endo" });
  });
  it("repeated explicit navigation during a save stays blocked without queuing traversals", () => {
    const b = browser(); const onChange = vi.fn(); const busyGuard = vi.fn(() => false);
    const nav = createPatientNavigation(b.host, { onChange, canLeave: busyGuard }); onChange.mockClear();
    for (let attempt = 0; attempt < 5; attempt += 1) expect(nav.navigate({ tab: "today", sub: "endo" })).toBe(false);
    expect(busyGuard).toHaveBeenCalledTimes(5); expect(onChange).not.toHaveBeenCalled();
    expect(b.history.go).not.toHaveBeenCalled(); expect(b.history.replaceState).not.toHaveBeenCalled();
    busyGuard.mockReturnValue(true); expect(nav.navigate({ tab: "today", sub: "endo" })).toBe(true);
    expect(b.history.replaceState).toHaveBeenCalledTimes(1);
  });
  it("mount publishes the committed URL when Next changed it after the render initializer", () => {
    const b = browser("?tab=summary"); let view = readPatientLocation(b.host.location.search);
    b.changeUrl("/patients/91?tab=ceph");
    const onChange = vi.fn((next: typeof view) => { view = next; });
    const nav = createPatientNavigation(b.host, { onChange, canLeave: () => true });
    expect(view).toEqual({ tab: "treatment", sub: "ortho" });
    nav.navigate(patientDestination("ortho", view));
    expect(view).toEqual({ tab: "treatment", sub: "ortho" });
    expect(b.history.replaceState).not.toHaveBeenCalled();
  });
  it("works without Navigation API and disposes its same-patient popstate guard", () => {
    const b = browser(); const nav = createPatientNavigation(b.host, { onChange: vi.fn(), canLeave: () => true });
    nav.navigate({ tab: "account", sub: "endo" }); nav.navigate({ tab: "summary", sub: "endo" });
    expect(b.history.replaceState).toHaveBeenCalledTimes(2); expect(b.history.length).toBe(4);
    expect(b.host.addEventListener).toHaveBeenCalledExactlyOnceWith("popstate", expect.any(Function));
    const listener = vi.mocked(b.host.addEventListener).mock.calls[0][1];
    nav.dispose(); expect(b.host.removeEventListener).toHaveBeenCalledExactlyOnceWith("popstate", listener);
    expect(b.history.go).not.toHaveBeenCalled();
  });
  it("does not update the previous patient's URL after another page owns the browser", () => {
    const b = browser(); const onChange = vi.fn(); const canLeave = vi.fn(() => false);
    const nav = createPatientNavigation(b.host, { onChange, canLeave }); onChange.mockClear();
    b.changeUrl("/patients/92?tab=summary");
    expect(nav.navigate({ tab: "today", sub: "endo" })).toBe(false);
    expect(canLeave).not.toHaveBeenCalled(); expect(onChange).not.toHaveBeenCalled();
    expect(b.history.replaceState).not.toHaveBeenCalled();
  });
});
