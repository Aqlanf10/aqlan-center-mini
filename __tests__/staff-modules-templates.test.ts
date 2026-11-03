import { describe, expect, it } from "vitest";
import { OWNER_ONLY_OPERATIONS, STAFF_CAPABILITIES, STAFF_CAPABILITY_PREREQUISITES, type StaffCapability } from "../lib/staff-capability-catalogue";
import { STAFF_CAPABILITY_LABELS } from "../lib/staff-capability-labels";
import { STAFF_MODULES, staffModuleOf, staffModuleVisible } from "../lib/staff-modules";
import { STAFF_STARTING_TEMPLATES, applyStartingTemplate } from "../lib/staff-starting-templates";

describe("modules (owner decision 4)", () => {
  it("every catalogue capability belongs to exactly one module", () => {
    const all = STAFF_MODULES.flatMap(module => module.capabilities);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...STAFF_CAPABILITIES].sort());
    for (const capability of STAFF_CAPABILITIES) expect(staffModuleOf(capability).capabilities).toContain(capability);
  });
  it("orthodontics and the lab are their own modules", () => {
    expect(staffModuleOf("clinical.ortho.edit").key).toBe("ortho");
    expect(staffModuleOf("clinical.ceph.analyze").key).toBe("ortho");
    expect(staffModuleOf("finance.lab-prices.edit").key).toBe("lab");
    expect(staffModuleOf("clinical.lab.order").key).toBe("lab");
    expect(staffModuleOf("clinical.visits.sign").key).toBe("clinic");
  });
  it("a module is visible only while the account holds one of its capabilities", () => {
    const lab = STAFF_MODULES.find(module => module.key === "lab")!;
    expect(staffModuleVisible(lab, new Set<StaffCapability>(["clinical.lab.view"]))).toBe(true);
    expect(staffModuleVisible(lab, new Set<StaffCapability>(["clinical.visits.document"]))).toBe(false);
  });
});

describe("starting templates (owner decision 3)", () => {
  it("every template uses catalogue names only, is closed under prerequisites and holds no owner-only operation", () => {
    for (const template of STAFF_STARTING_TEMPLATES) {
      const grants = new Set<string>(template.grants);
      for (const capability of template.grants) {
        expect(STAFF_CAPABILITIES).toContain(capability);
        expect(STAFF_CAPABILITY_LABELS[capability]).toMatch(/[؀-ۿ]/);
        for (const required of STAFF_CAPABILITY_PREREQUISITES[capability] ?? []) expect(grants.has(required), `${template.key}: ${capability} needs ${required}`).toBe(true);
      }
      for (const operation of OWNER_ONLY_OPERATIONS) expect(grants.has(operation)).toBe(false);
      expect(template.label).toMatch(/[؀-ۿ]/);
    }
  });
  it("no template grants staff management, settings writes or clinical access to non-clinical work", () => {
    for (const template of STAFF_STARTING_TEMPLATES) {
      for (const capability of template.grants) expect(capability.startsWith("staff.") || capability === "settings.operational.edit" || capability === "settings.finance.edit").toBe(false);
    }
    const reception = STAFF_STARTING_TEMPLATES.find(template => template.key === "reception")!;
    for (const capability of reception.grants) expect(capability.startsWith("clinical.")).toBe(false);
    expect(reception.grants).toContain("patients.operational-summary.view");
  });
  it("applying a template keeps only what the actor may delegate and reports the rest; nothing else changes", () => {
    const doctor = STAFF_STARTING_TEMPLATES.find(template => template.key === "doctor")!;
    const delegable = new Set<StaffCapability>(["clinical.plans.view", "clinical.visits.document", "tasks.use"]);
    const result = applyStartingTemplate(doctor, delegable, { patient: ["none", "own"], appointment: ["none"] });
    expect([...result.grants].sort()).toEqual(["clinical.plans.view", "clinical.visits.document", "tasks.use"]);
    expect(result.dropped).toContain("clinical.visits.sign");
    expect(result).toMatchObject({ patientScope: "own", appointmentScope: "none", scopeLimited: true });
    expect(doctor.grants).toContain("clinical.visits.sign"); // the template itself is untouched
  });
});

describe("owner-only operations (Dot 6484846432 decision 2, review 6486144288 item 4)", () => {
  it("are exactly the five existing operations plus the four approved clinic operations; supplier recovery is not approved", () => {
    expect([...OWNER_ONLY_OPERATIONS].sort()).toEqual([
      "clinic.backup.manage", "clinic.data.export", "clinic.data.import", "clinic.reset",
      "settings.integrations.change", "settings.security.change",
      "staff.clinician-link.change", "staff.credentials.reset", "staff.role.change",
    ]);
    expect(OWNER_ONLY_OPERATIONS as readonly string[]).not.toContain("inventory.supplier-intent.recover");
    expect(STAFF_CAPABILITIES as readonly string[]).not.toContain("inventory.supplier-intent.recover");
  });
});
