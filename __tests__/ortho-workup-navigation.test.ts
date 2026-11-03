import { describe, expect, it } from "vitest";
import { ORTHO_WORKUP_STEPS, readWorkupBookmark, replaceWorkupBookmark, workupBookmark } from "../lib/ortho-workup-navigation";
describe("case-scoped workup navigation", () => {
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
    expect(writes).toEqual([[{ retained: true }, "", "/patients/11?tab=treatment&sub=ortho&visitId=5#ortho-workup/11/21/10"]]); expect(events).toEqual(["ortho-assessment-bookmark"]);
    expect(replaceWorkupBookmark(host as unknown as Window, 12, 21, 9)).toBe(false); expect(writes).toHaveLength(1);
  });
});
