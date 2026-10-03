import { describe, expect, it, vi } from "vitest";
import { focusDestination, isPatientRecordFocus, readPatientRecordFocus, writePatientRecordFocus } from "../lib/patient-workspace-focus";
import { createPatientNavigation } from "../lib/patient-navigation";
import { readVisitWorkSnapshot, resolveVisitWork, visitWorkSavedFingerprint, type VisitWorkSnapshot } from "../lib/patient-visit-work";
import { visitWorkFocus as focus, visitWorkSnapshot } from "./fixtures/patient-visit-work";

function resolve(change?: (snapshot: VisitWorkSnapshot) => void, draft: { planItemId: number | null; serviceId: number; toothCode: string | number | null }[] = []) {
  const snapshot = visitWorkSnapshot(); const loadedVisit = structuredClone(snapshot.visit);
  change?.(snapshot);
  return resolveVisitWork({ focus, patientId: focus.patientId, visitId: focus.visitId, canEditWork: true, snapshot, loadedVisit, drafts: draft });
}
describe("exact visit work navigation is read-only and guarded", () => {
  it("round trips bounded identities including explicitly unlinked case/tooth", () => {
    for (const target of [focus, { ...focus, caseId: null, toothCode: null }]) {
      const params = new URLSearchParams("legacy=preserved"); writePatientRecordFocus(params, target);
      expect(readPatientRecordFocus(params, focus.patientId)).toEqual({ status: "valid", focus: target });
      expect(params.get("legacy")).toBe("preserved");
    }
    expect(focusDestination(focus)).toEqual({ tab: "today", sub: "chart" });
  });
  it.each(["focusVisit=0", "focusVisit=091001", "focusVisit=2147483648", "focusCase=", "focusTooth=99", "focusPlan=-1", "focusItem=1e3", "focusPatient=2"])("rejects invalid exact query %s", (pair) => {
    const params = new URLSearchParams(); writePatientRecordFocus(params, focus);
    const [key, value] = pair.split("="); params.set(key, value);
    expect(readPatientRecordFocus(params, focus.patientId)).toEqual({ status: "invalid" });
  });
  it("rejects missing/duplicate visit identity and doesn't reinterpret unrelated visitId", () => {
    const params = new URLSearchParams(); writePatientRecordFocus(params, focus);
    params.append("focusVisit", String(focus.visitId)); expect(readPatientRecordFocus(params, focus.patientId).status).toBe("invalid");
    params.delete("focusVisit"); params.set("visitId", String(focus.visitId)); expect(readPatientRecordFocus(params, focus.patientId).status).toBe("invalid");
    expect(isPatientRecordFocus({ ...focus, caseId: undefined })).toBe(false);
  });
  it("same-tab changed item obeys the one guard and a repeated exact intent is a no-op", () => {
    const params = new URLSearchParams("tab=today"); writePatientRecordFocus(params, focus);
    let url = new URL(`https://test.invalid/patients/${focus.patientId}?${params}#retained`);
    const replaceState = vi.fn((_state, _unused, href) => { url = new URL(href, url); });
    const host = { get location() { return url; }, history: { replaceState } } as unknown as Window;
    const canLeave = vi.fn(() => false); const change = vi.fn();
    const nav = createPatientNavigation(host, { canLeave, onChange: change }); change.mockClear();
    const next = { ...focus, itemId: focus.itemId + 1 };
    expect(nav.navigate(focusDestination(next), next)).toBe(false); expect(replaceState).not.toHaveBeenCalled();
    expect(readPatientRecordFocus(url.search, focus.patientId)).toEqual({ status: "valid", focus });
    canLeave.mockReturnValue(true); expect(nav.navigate(focusDestination(next), next)).toBe(true);
    expect(nav.navigate(focusDestination(next), next)).toBe(true); expect(replaceState).toHaveBeenCalledTimes(1); expect(canLeave).toHaveBeenCalledTimes(2);
  });
});
describe("fresh canonical work identity adapter", () => {
  it("resolves current canonical vocabulary and keeps three recorded providers distinct", () => {
    const result = resolve(); expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.planItem.doctorId).toBe(94002); expect(result.clinicalCase?.responsiblePartyId).toBe(94003);
    expect(result.item.planCurrency).toBe("SAR"); expect(result.existing).toBe(false);
  });
  it.each<[string, (snapshot: VisitWorkSnapshot) => void]>([
    ["foreign patient", (s) => { s.visit.patientId = 1; }], ["wrong visit", (s) => { s.visit.id = 1; }],
    ["signed", (s) => { s.visit.status = "signed"; s.visit.signedAt = "2026-10-03"; }],
    ["cancelled queue", (s) => { s.workflow.openVisit!.status = "cancelled"; }],
    ["noncurrent visit", (s) => { s.workflow.openVisit!.id = 1; }], ["no current visit", (s) => { s.workflow.openVisit = null; }],
    ["hidden plan", (s) => { s.cases.planVisible = false; }], ["hidden workflow", (s) => { s.workflow.planVisible = false; }],
    ["wrong plan patient", (s) => { s.plans[0].patientId = 1; }], ["closed plan", (s) => { s.plans[0].status = "completed"; }],
    ["missing consent", (s) => { s.plans[0].consentAt = null; }], ["duplicate parent", (s) => { s.plans.push(s.plans[0]); }],
    ["missing item", (s) => { s.plans[0].items = []; }], ["wrong item plan", (s) => { s.cases.items[0].planId = 1; }],
    ["wrong case", (s) => { s.cases.items[0].caseId = 1; }], ["foreign case", (s) => { s.cases.cases[0].patientId = 1; }],
    ["legacy invalid specialty", (s) => { s.cases.cases[0].specialty = "endo"; }], ["missing case", (s) => { s.cases.cases = []; }],
    ["wrong tooth", (s) => { s.cases.items[0].toothCode = 26; }], ["wrong service", (s) => { s.plans[0].items[0].serviceId = 2; }],
    ["cancelled item", (s) => { s.plans[0].items[0].status = "cancelled"; }], ["missing outstanding", (s) => { s.visit.outstanding = []; }],
    ["duplicate outstanding", (s) => { s.visit.outstanding.push(s.visit.outstanding[0]); }],
    ["exhausted sessions", (s) => { s.visit.outstanding[0].doneSessions = 3; }],
    ["saved provider drift", (s) => { s.visit.doctorId = 1; }], ["saved note drift", (s) => { s.visit.diagnosis = "Other saved note"; }],
    ["wrong currency", (s) => { s.visit.outstanding[0].planCurrency = "USD"; }],
  ])("fails unavailable for %s", (_name, change) => { expect(resolve(change).status).toBe("unavailable"); });
  it("focuses an existing staged item and refuses ambiguous/different staged identity", () => {
    const row = { planItemId: focus.itemId, serviceId: 93001, toothCode: "16" };
    expect(resolve(undefined, [row])).toMatchObject({ status: "ready", existing: true });
    expect(resolve(undefined, [row, row]).status).toBe("unavailable");
    expect(resolve(undefined, [{ ...row, toothCode: "26" }]).status).toBe("unavailable");
  });
  it("does not treat unmet dependency or included agreement as a new policy or price", () => {
    expect(resolve((s) => { s.visit.outstanding[0].unmetRequirements = ["Canonical dependency"]; s.visit.outstanding[0].includedByAgreement = true; })).toMatchObject({ status: "ready", item: { includedByAgreement: true, unmetRequirements: ["Canonical dependency"] } });
  });
  it("saved fingerprint excludes new specialty read projections", () => {
    const saved = visitWorkSnapshot().visit;
    expect(visitWorkSavedFingerprint({ ...saved, structuredClinical: { status: "ready" } } as typeof saved)).toBe(visitWorkSavedFingerprint(saved));
  });
  it("read adapter calls only existing no-store GETs and rejects denied/malformed input", async () => {
    const s = visitWorkSnapshot(); const payloads = [s.visit, { plans: s.plans }, s.cases, s.workflow];
    const read = vi.fn(async () => ({ ok: true, json: async () => payloads.shift() })) as unknown as typeof fetch;
    expect(await readVisitWorkSnapshot(focus, read)).toEqual(s);
    expect(read).toHaveBeenCalledTimes(4);
    for (const call of vi.mocked(read).mock.calls) expect(call[1]).toEqual({ cache: "no-store" });
    await expect(readVisitWorkSnapshot(focus, vi.fn(async () => ({ ok: false })) as unknown as typeof fetch)).rejects.toThrow("protected_read_unavailable");
    await expect(readVisitWorkSnapshot(focus, vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch)).rejects.toThrow("incomplete_work_projection");
  });
});
