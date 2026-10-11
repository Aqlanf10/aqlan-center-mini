import { describe, expect, it } from "vitest";
import { ORTHO_PILLARS, clinicalContextSearch, readClinicalContext } from "../lib/patient-navigation";
import {
  ORTHO_JOURNEY_COPY, ORTHO_JOURNEY_SECTIONS, ORTHO_JOURNEY_STEPS,
  adjacentOrthoJourneyStep, initialOrthoJourneySelection, isOrthoJourneySection, isOrthoJourneySelection,
  isOrthoJourneyStep, orthoJourneyRouteHint, orthoJourneySectionEntry, orthoJourneySelection,
  orthoJourneyStepsForSection, orthoJourneyTabFocus,
} from "../lib/ortho-case-journey-navigation";

describe("five-section, thirteen-step orthodontic navigation", () => {
  it("has the exact five approved primary sections with every input step once and in order", () => {
    expect(ORTHO_JOURNEY_SECTIONS.map(section => ORTHO_JOURNEY_COPY.ar.sections[section])).toEqual([
      "ملخص الحالة والجلسة", "السجلات والتشخيص", "الخطة والميكانيكا والاتفاق", "الإنهاء والتثبيت", "عرض الحالة",
    ]);
    expect(ORTHO_JOURNEY_STEPS.map(step => step.id)).toEqual([
      "arrival", "interview", "extraoral", "intraoral", "measurements", "panorama", "ceph", "diagnosis",
      "treatment_plan", "agreement", "visits", "outcome_retention", "study",
    ]);
    expect(ORTHO_JOURNEY_STEPS.map(step => step.order)).toEqual(Array.from({ length: 13 }, (_, index) => index + 1));
    expect(new Set(ORTHO_JOURNEY_SECTIONS.flatMap(section => orthoJourneyStepsForSection(section).map(step => step.id))).size).toBe(13);
  });
  it("defaults a current or old case to the summary/visit without inventing lifecycle facts", () => {
    for (const input of [{}, { status: null }, { status: "active" as const }, { status: "retention" as const },
      { status: "completed" as const }, { status: "discontinued" as const }]) {
      expect(initialOrthoJourneySelection(input)).toEqual({ section: "summary", step: "visits" });
    }
  });
  it("only actual explicit assessment states opt into interview; existing routes win", () => {
    expect(initialOrthoJourneySelection({ status: "assessment" })).toEqual({ section: "records", step: "interview" });
    expect(initialOrthoJourneySelection({ status: "assessment_cancelled" })).toEqual({ section: "records", step: "interview" });
    expect(initialOrthoJourneySelection({ status: "assessment", pillar: "wires" })).toEqual({ section: "summary", step: "visits" });
    expect(initialOrthoJourneySelection({ status: "active", pillar: "prescription" })).toEqual({ section: "plan", step: "treatment_plan" });
  });
  it("retains four canonical pillar values, treating presentation as a local diagnostics subview", () => {
    expect(ORTHO_PILLARS).toEqual(["wires", "diagnostics", "prescription", "retention"]);
    expect(ORTHO_JOURNEY_SECTIONS.map(section => orthoJourneyRouteHint(orthoJourneySectionEntry(section)))).toEqual([
      { pillar: "wires", subview: "summary" }, { pillar: "diagnostics", subview: "assessment" },
      { pillar: "prescription", subview: "plan" }, { pillar: "retention", subview: "retention" },
      { pillar: "diagnostics", subview: "study" },
    ]);
    expect(readClinicalContext(new URLSearchParams("pillar=presentation"))).toEqual({ contextError: "invalid_context" });
    expect(readClinicalContext(new URLSearchParams("pillar=plan"))).toEqual({ contextError: "invalid_context" });
  });
  it("does not replace or invent patient, clinical-case, plan or visit references", () => {
    const context = Object.freeze({ patientId: 7, orthoCaseId: 11, clinicalCaseId: 19, planId: 23, visitId: 31, pillar: "wires" as const });
    const before = clinicalContextSearch(context);
    for (const step of ORTHO_JOURNEY_STEPS) {
      const route = orthoJourneyRouteHint(orthoJourneySelection(step.id));
      expect(Object.keys(route).sort()).toEqual(["pillar", "subview"]);
      expect(ORTHO_PILLARS).toContain(route.pillar);
    }
    expect(clinicalContextSearch(context)).toBe(before);
  });
  it("maps each diagnostic/editor source explicitly, preserving the agreement step", () => {
    expect(orthoJourneyRouteHint(orthoJourneySelection("measurements"))).toEqual({ pillar: "diagnostics", subview: "assessment" });
    expect(orthoJourneyRouteHint(orthoJourneySelection("panorama"))).toEqual({ pillar: "diagnostics", subview: "records" });
    expect(orthoJourneyRouteHint(orthoJourneySelection("ceph"))).toEqual({ pillar: "diagnostics", subview: "ceph" });
    expect(orthoJourneyRouteHint(orthoJourneySelection("diagnosis"))).toEqual({ pillar: "diagnostics", subview: "diagnosis" });
    expect(orthoJourneyRouteHint(orthoJourneySelection("agreement"))).toEqual({ pillar: "prescription", subview: "agreement" });
  });
  it("allows forward/backward traversal of all thirteen steps without status or missing-row gates", () => {
    for (const [index, step] of ORTHO_JOURNEY_STEPS.entries()) {
      const current = orthoJourneySelection(step.id);
      expect(adjacentOrthoJourneyStep(current, "previous")?.step ?? null).toBe(ORTHO_JOURNEY_STEPS[index - 1]?.id ?? null);
      expect(adjacentOrthoJourneyStep(current, "next")?.step ?? null).toBe(ORTHO_JOURNEY_STEPS[index + 1]?.id ?? null);
      expect(Object.keys(current).sort()).toEqual(["section", "step"]);
    }
    expect(orthoJourneySectionEntry("presentation")).toEqual({ section: "presentation", step: "study" });
  });
  it("rejects invalid and mismatched section/step combinations", () => {
    for (const value of [null, [], "study", {}, { section: "summary", step: "study" }, { section: "records", step: "toString" }]) {
      expect(isOrthoJourneySelection(value)).toBe(false);
    }
    expect(isOrthoJourneySection("toString")).toBe(false);
    expect(isOrthoJourneyStep("constructor")).toBe(false);
    expect(isOrthoJourneySelection(orthoJourneySelection("study"))).toBe(true);
  });
  it("offers complete central Arabic and English labels without equating input completeness to approval", () => {
    for (const locale of ["ar", "en"] as const) {
      for (const step of ORTHO_JOURNEY_STEPS) expect(ORTHO_JOURNEY_COPY[locale].steps[step.id]).toBeTruthy();
      expect(ORTHO_JOURNEY_COPY[locale].statuses.inputs_complete).not.toBe(ORTHO_JOURNEY_COPY[locale].statuses.approved);
      expect(ORTHO_JOURNEY_COPY[locale].unknown).not.toBe(ORTHO_JOURNEY_COPY[locale].statuses.not_started);
    }
  });
  it("uses physical-direction aware, wrapping manual tab focus", () => {
    expect(orthoJourneyTabFocus("summary", "ArrowLeft", "rtl")).toBe("records");
    expect(orthoJourneyTabFocus("summary", "ArrowRight", "rtl")).toBe("presentation");
    expect(orthoJourneyTabFocus("summary", "ArrowRight", "ltr")).toBe("records");
    expect(orthoJourneyTabFocus("summary", "ArrowLeft", "ltr")).toBe("presentation");
    expect(orthoJourneyTabFocus("plan", "Home", "rtl")).toBe("summary");
    expect(orthoJourneyTabFocus("plan", "End", "ltr")).toBe("presentation");
    expect(orthoJourneyTabFocus("plan", "Enter", "rtl")).toBeNull();
    expect(orthoJourneyTabFocus("plan", "Tab", "ltr")).toBeNull();
  });
});
