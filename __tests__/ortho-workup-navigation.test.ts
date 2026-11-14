import { describe, expect, it } from "vitest";
import { ORTHO_CASE_PILLARS, ORTHO_WORKUP_ENTRY_STEP, ORTHO_WORKUP_GROUPS, ORTHO_WORKUP_STEPS, orthoWorkupEntryStep, readWorkupBookmark, replaceWorkupBookmark, workupBookmark, clearWorkupBookmark, makeWorkupBookmarkStore } from "../lib/ortho-workup-navigation";
describe("case-scoped workup navigation", () => {
  it("exposes every existing destination exactly once in seven direct groups without changing bookmark indices", () => {
    expect(ORTHO_WORKUP_GROUPS).toHaveLength(7);
    expect(ORTHO_WORKUP_GROUPS.flatMap(group => [...group.steps]).sort((a, b) => a - b)).toEqual(ORTHO_WORKUP_STEPS.map((_, index) => index));
    expect(ORTHO_WORKUP_GROUPS[3].steps.map(index => ORTHO_WORKUP_STEPS[index].id)).toEqual(["strategy", "agreement"]);
    for (const group of ORTHO_WORKUP_GROUPS) {
      expect(group.steps.some(step => step === group.entry)).toBe(true);
      expect(group.steps.every(step => ORTHO_WORKUP_STEPS[step].pillar === group.pillar)).toBe(true);
    }
  });
  it("follows the clinical lifecycle: summary, examination and records, analysis and problem list, plan, visits, retention and closure", () => {
    expect(ORTHO_WORKUP_GROUPS.map(group => group.title)).toEqual(["ملخص الحالة", "الفحص والسجلات", "التحليل وقائمة المشكلات",
      "خطة العلاج والميكانيكا", "زيارات المتابعة والشدّ", "التثبيت والإقفال", "دراسة الحالة المحفوظة"]);
    // Group order never goes backwards through the step order.
    expect(ORTHO_WORKUP_GROUPS.map(group => group.entry)).toEqual([...ORTHO_WORKUP_GROUPS.map(group => group.entry)].sort((a, b) => a - b));
    expect(ORTHO_CASE_PILLARS.map(item => item.id)).toEqual(["wires", "diagnostics", "prescription", "retention", "presentation"]);
    expect(ORTHO_WORKUP_STEPS[ORTHO_WORKUP_ENTRY_STEP].id).toBe("identity");
  });
  it("opens a case in treatment on its visits and a case in retention on retention, so the routine visit needs no detour", () => {
    expect(ORTHO_WORKUP_STEPS[orthoWorkupEntryStep("assessment")].id).toBe("identity");
    expect(ORTHO_WORKUP_STEPS[orthoWorkupEntryStep(null)].id).toBe("identity");
    for (const phase of ["aligning", "working", "finishing"]) expect(ORTHO_WORKUP_STEPS[orthoWorkupEntryStep(phase)].id).toBe("visits");
    expect(ORTHO_WORKUP_STEPS[orthoWorkupEntryStep("retention")].id).toBe("retention");
  });
  it("places measurements before radiographs and preserves the separate agreement, visit, retention and study owners", () => {
    expect(ORTHO_WORKUP_STEPS.map(step => step.id)).toEqual(["identity", "interview", "extraoral", "intraoral", "measurements", "radiographs", "ceph", "diagnosis", "strategy", "agreement", "visits", "retention", "presentation"]);
    expect(ORTHO_WORKUP_STEPS.slice(8).map(step => step.pillar)).toEqual(["prescription", "prescription", "wires", "retention", "presentation"]);
  });
  it("roundtrips only valid steps under this patient and rejects foreign, malformed or overflowing bookmarks", () => {
    for (let step = 0; step < 13; step++) expect(readWorkupBookmark(workupBookmark(11, 21, step), 11)).toEqual({ caseId: 21, step });
    for (const hash of ["#ortho-workup/12/21/2", "#ortho-workup/11/21/0", "#ortho-workup/11/21/14", "#ortho-workup/11/2147483648/2", "#ortho-workup/11/21/2/text", "#ortho-workup/11/21/02"]) expect(readWorkupBookmark(hash, 11)).toBe(null);
    expect(() => workupBookmark(11, 21, -1)).toThrow(); expect(() => workupBookmark(11, 21, 13)).toThrow();
  });
  it("preserves query context and history state, and refuses to change a different patient's page", () => {
    const writes: unknown[][] = [], events: string[] = [];
    const host = { location: { pathname: "/patients/11", search: "?tab=treatment&sub=ortho&visitId=5" }, history: { state: { retained: true }, replaceState: (...args: unknown[]) => writes.push(args) }, dispatchEvent: (event: Event) => events.push(event.type) };
    expect(replaceWorkupBookmark(host as unknown as Window, 11, 21, 9)).toBe(true);
    expect(writes).toEqual([[{ retained: true }, "", "/patients/11?tab=treatment&sub=ortho&visitId=5#ortho-workup/11/21/10"]]); expect(events).toEqual(["ortho-workup-bookmark"]);
    expect(replaceWorkupBookmark(host as unknown as Window, 12, 21, 9)).toBe(false); expect(writes).toHaveLength(1);
  });
  it("clears only the selected case bookmark and keeps the visit query and history state", () => {
    const writes: unknown[][] = [];
    const host = { location: { pathname: "/patients/11", search: "?visitId=5", hash: "#ortho-workup/11/21/2" }, history: { state: { retained: true }, replaceState: (...args: unknown[]) => writes.push(args) }, dispatchEvent: () => true };
    expect(clearWorkupBookmark(host as unknown as Window, 11, 22)).toBe(false);
    expect(clearWorkupBookmark(host as unknown as Window, 12, 21)).toBe(false);
    expect(writes).toEqual([]);
    expect(clearWorkupBookmark(host as unknown as Window, 11, 21)).toBe(true);
    expect(writes).toEqual([[{ retained: true }, "", "/patients/11?visitId=5"]]);
  });
});

describe("accepted bookmark visibility", () => {
  it("rejects external hashes during pending work, restores query/state, then accepts navigation after settlement", () => {
    const events = new EventTarget(), state = { retained: true };
    let allowed = true, blocked = 0, changes = 0;
    const location = { pathname: "/patients/11", search: "?visitId=5", hash: "#ortho-workup/11/21/2" };
    const writes: unknown[][] = [];
    const host = { location, history: { state, replaceState: (...args: unknown[]) => {
      writes.push(args); location.hash = new URL(String(args[2]), "http://localhost").hash;
    } }, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) } as unknown as Window;
    const store = makeWorkupBookmarkStore(() => host, () => allowed, () => blocked++);
    expect(store.getSnapshot()).toBe("");
    const stop = store.subscribe(() => changes++);
    expect(store.getSnapshot()).toBe(location.hash);
    allowed = false; location.hash = "#ortho-workup/11/21/9"; events.dispatchEvent(new Event("hashchange"));
    expect(store.getSnapshot()).toBe("#ortho-workup/11/21/2");
    expect(location.hash).toBe(store.getSnapshot()); expect(blocked).toBe(1);
    expect(writes).toEqual([[state, "", "/patients/11?visitId=5#ortho-workup/11/21/2"]]);
    allowed = true; location.hash = "#ortho-workup/11/21/9"; events.dispatchEvent(new Event("ortho-workup-bookmark"));
    expect(store.getSnapshot()).toBe(location.hash); expect(changes).toBe(2);
    stop(); location.hash = "#foreign"; events.dispatchEvent(new Event("hashchange")); expect(changes).toBe(2);
  });
});
