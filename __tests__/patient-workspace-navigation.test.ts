import { describe, expect, it, vi } from "vitest";
import { createPatientNavigation, patientDestination, patientLocationHref, readPatientLocation } from "../lib/patient-navigation";
import { WORKSPACE_SECTIONS, workspaceDestination, workspaceSection } from "../lib/patient-workspace-navigation";

describe("patient workspace registry uses canonical navigation", () => {
  it.each(WORKSPACE_SECTIONS.map((section) => [section.id]))("round trips %s without dropping patient/work context", (id) => {
    const original = "https://clinic.test/patients/91?tab=treatment&sub=endo&caseId=17&planId=5&visitId=42&tooth=36#record";
    const current = readPatientLocation(new URL(original).search);
    const destination = workspaceDestination(id, current);
    const href = patientLocationHref(original, destination);
    expect(workspaceSection(readPatientLocation(new URL(href, original).search))).toBe(id);
    expect(href).toContain("caseId=17&planId=5&visitId=42&tooth=36");
    expect(href).toContain("/patients/91?");
    expect(href).toContain("#record");
  });
  it("uses the existing guard for every new destination, with no write or additional history", () => {
    let url = new URL("https://clinic.test/patients/91?tab=endo");
    const history = { replaceState: vi.fn((_state, _title, href: string) => { url = new URL(href, url); }), pushState: vi.fn() };
    const host = { get location() { return url; }, history } as unknown as Window;
    const canLeave = vi.fn(() => false); const changed = vi.fn();
    const nav = createPatientNavigation(host, { canLeave, onChange: changed });
    for (const section of ["identity", "specialties", "prescriptions", "timeline", "reports", "perio"]) {
      expect(nav.navigate(patientDestination(section, readPatientLocation(url.search)))).toBe(false);
    }
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(history.pushState).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it("retains all older canonical and alias destinations", () => {
    expect(workspaceSection(readPatientLocation("?tab=perio"))).toBe("perio");
    expect(workspaceSection(readPatientLocation("?tab=ceph"))).toBe("ortho");
    expect(workspaceSection(readPatientLocation("?tab=ledger"))).toBe("account");
    expect(workspaceSection(readPatientLocation("?tab=documents"))).toBe("files");
    expect(workspaceSection(readPatientLocation("?tab=visits"))).toBe("today");
  });
  it("has no duplicate destination IDs", () => {
    expect(new Set(WORKSPACE_SECTIONS.map((section) => section.id)).size).toBe(WORKSPACE_SECTIONS.length);
  });
});
