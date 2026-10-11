import { afterEach, describe, expect, it, vi } from "vitest";
import { cephReturnHref, cephStudyHref, clinicalContextHref, createPatientNavigation, patientDestination, patientLocationHref, readPatientLocation, decodeClinicalContext, parseClinicalId } from "../lib/patient-navigation";

function navigationHost() {
  const events = new EventTarget();
  let url = new URL("https://example.test/patients/11");
  return {
    get location() { return url; },
    history: { replaceState(_state: unknown, _unused: string, href?: string | URL | null) { if (href) url = new URL(String(href), url); } },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
  } as unknown as Window;
}
const window = navigationHost();
const controllers: ReturnType<typeof createPatientNavigation>[] = [];
afterEach(() => { controllers.splice(0).forEach((controller) => controller.dispose()); vi.restoreAllMocks(); });

describe("clinical URL identity is distinct from view navigation", () => {
  it("round-trips exact plan/item/general-case/specialty-case/visit identity without dropping other query values", () => {
    const context = { patientId: 11, planId: 21, planItemId: 31, clinicalCaseId: 41, orthoCaseId: 51, visitId: 61, pillar: "diagnostics" as const };
    const href = patientLocationHref("/patients/11?review=1#chair", { tab: "treatment", sub: "ortho", context });
    const url = new URL(href, "https://example.test");
    expect(readPatientLocation(url.search)).toEqual({ tab: "treatment", sub: "ortho", context });
    expect(url.searchParams.get("review")).toBe("1"); expect(url.hash).toBe("#chair");
    const account = patientDestination("account", readPatientLocation(url.search));
    expect(account.context).toEqual(context);
    expect(readPatientLocation(new URL(patientLocationHref(href, account), url).search).context).toEqual(context);
  });

  it.each(["orthoCaseId=0", "clinicalCaseId=-1", "planItemId=1.5", "patientId=NaN", "visitId=9007199254740992", "planId=2147483648", "planId=01", "endoTreatmentId=", "orthoCaseId=4&orthoCaseId=4", "pillar=other", "pillar=wires&pillar=diagnostics"])("rejects malformed explicit context %s", (search) => {
    expect(readPatientLocation(search)).toMatchObject({ contextError: "invalid_context" });
    expect(readPatientLocation(search).context).toBeUndefined();
  });

  it("preserves invalid identity across ordinary tab clicks until explicit reset", () => {
    const invalid = patientDestination("account", readPatientLocation("tab=ortho&orthoCaseId=bad"));
    expect(readPatientLocation(new URL(patientLocationHref("/patients/11", invalid), "https://example.test").search).contextError).toBe("invalid_context");
    expect(patientLocationHref("/patients/11?orthoCaseId=bad&planId=4", { tab: "treatment", sub: "cases" })).toBe("/patients/11?tab=treatment&sub=cases");
  });

  it("keeps legacy aliases and never conflates the general case and Ortho IDs", () => {
    expect(readPatientLocation("tab=ceph")).toEqual({ tab: "treatment", sub: "ortho" });
    expect(readPatientLocation("tab=ledger")).toEqual({ tab: "account", sub: "chart" });
    const href = clinicalContextHref(11, { clinicalCaseId: 41, orthoCaseId: 51 }, "ortho");
    expect(href).toContain("clinicalCaseId=41"); expect(href).toContain("orthoCaseId=51");
  });

  it("requires the same existing guard for an in-place case or pillar change", () => {
    window.history.replaceState(null, "", clinicalContextHref(11, { orthoCaseId: 51, pillar: "wires" }, "ortho"));
    const canLeave = vi.fn(() => false), onChange = vi.fn();
    const controller = createPatientNavigation(window, { canLeave, onChange }); controllers.push(controller);
    expect(controller.navigate({ tab: "treatment", sub: "ortho", context: { patientId: 11, orthoCaseId: 52, pillar: "diagnostics" } })).toBe(false);
    expect(canLeave).toHaveBeenCalledOnce(); expect(window.location.search).toContain("orthoCaseId=51");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("handles same-patient browser traversal once and restores the accepted URL on blocked leave", () => {
    window.history.replaceState(null, "", clinicalContextHref(11, { orthoCaseId: 51 }, "ortho"));
    let allowed = false;
    const onChange = vi.fn();
    const controller = createPatientNavigation(window, { canLeave: () => allowed, onChange }); controllers.push(controller);
    window.history.replaceState(null, "", clinicalContextHref(11, { orthoCaseId: 52 }, "ortho"));
    window.dispatchEvent(new Event("popstate"));
    expect(window.location.search).toContain("orthoCaseId=51"); expect(onChange).toHaveBeenCalledTimes(1);
    allowed = true;
    window.history.replaceState(null, "", clinicalContextHref(11, { orthoCaseId: 52 }, "ortho"));
    window.dispatchEvent(new Event("popstate"));
    expect(onChange).toHaveBeenLastCalledWith({ tab: "treatment", sub: "ortho", context: { patientId: 11, orthoCaseId: 52 } });
    controller.dispose();
    window.dispatchEvent(new Event("popstate"));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("never transfers navigation ownership to a different patient pathname", () => {
    window.history.replaceState(null, "", "/patients/11?tab=treatment&sub=ortho&orthoCaseId=51");
    const onChange = vi.fn(); const controller = createPatientNavigation(window, { canLeave: () => true, onChange }); controllers.push(controller);
    window.history.replaceState(null, "", "/patients/12?tab=treatment&sub=ortho");
    window.dispatchEvent(new Event("popstate"));
    expect(controller.navigate({ tab: "account", sub: "ortho" })).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("Ceph return honors recorded ownership, preserves matching item context, and keeps diagnostics", () => {
    const study = cephStudyHref(91, { patientId: 11, planItemId: 31, clinicalCaseId: 41, orthoCaseId: 51 });
    expect(study).toContain("pillar=diagnostics");
    const result = cephReturnHref({ patientId: 11, orthoCaseId: 51 }, new URL(study, "https://example.test").search);
    expect(readPatientLocation(new URL(result, "https://example.test").search)).toEqual({ tab: "treatment", sub: "ortho", context: {
      patientId: 11, planItemId: 31, clinicalCaseId: 41, orthoCaseId: 51, pillar: "diagnostics",
    } });
    const foreign = cephReturnHref({ patientId: 12, orthoCaseId: 52 }, new URL(study, "https://example.test").search);
    expect(foreign).toContain("/patients/12?"); expect(foreign).toContain("orthoCaseId=52"); expect(foreign).not.toContain("planItemId");
    const unlinked = cephReturnHref({ patientId: 11, orthoCaseId: null }, "");
    expect(unlinked).not.toContain("orthoCaseId"); expect(unlinked).toContain("pillar=diagnostics");
  });
  it("unlinked studies clear all unverified same-patient clinical hints", () => {
    const hints = "patientId=11&orthoCaseId=51&clinicalCaseId=41&planItemId=31&planId=21&endoTreatmentId=71&visitId=61";
    const location = readPatientLocation(new URL(cephReturnHref({ patientId: 11, orthoCaseId: null }, hints), "https://example.test").search);
    expect(location.context).toEqual({ patientId: 11, pillar: "diagnostics" });
    const changed = readPatientLocation(new URL(cephReturnHref({ patientId: 11, orthoCaseId: 99 }, hints), "https://example.test").search);
    expect(changed.context).toEqual({ patientId: 11, orthoCaseId: 99, pillar: "diagnostics" });
    expect(cephReturnHref({ patientId: 11, orthoCaseId: null }, "patientId=11&orthoCaseId=bad")).not.toContain("CaseId");
  });
  it("strictly decodes derived IDs, domain, success flag and numeric path bounds", () => {
    const good = { ok: true, context: { patientId: 11, orthoCaseId: 51 }, specialty: "orthodontics", sub: "ortho" };
    expect(decodeClinicalContext(good, 11, { orthoCaseId: 51 })).not.toBeNull();
    for (const invalid of [
      { ...good, ok: "yes" }, { ...good, specialty: "unknown" }, { ...good, sub: "endo" },
      { ...good, context: { patientId: 11, orthoCaseId: "51" } },
      { ...good, context: { patientId: 11, orthoCaseId: 51, planItemId: 31 } },
      { ...good, context: { patientId: 11, orthoCaseId: 51, endoTreatmentId: 61 } },
      { ...good, context: { patientId: 11, orthoCaseId: 51, extraIdentity: 81 } },
    ]) expect(decodeClinicalContext(invalid, 11, {})).toBeNull();
    for (const raw of ["01", "1e2", "+1", " 1", "2147483648", "0"]) expect(parseClinicalId(raw)).toBeNull();
    expect(parseClinicalId("2147483647")).toBe(2147483647);
  });

});
