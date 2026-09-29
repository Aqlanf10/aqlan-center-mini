import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  appendPhrase, arabicDays, buildVisitSuggestions, parsePhraseList, treatmentDoneFromProcedures, visitWorkspaceHref,
} from "../lib/visit-suggestions";
import { SETTING_DEFAULTS, PUBLIC_SETTING_KEYS } from "../lib/settings";
import { VisitSteps } from "../components/ClinicalVisit";

/**
 * (VISIT-1) الزيارة من لوحة اليوم بتسلسلٍ منطقي وتعبئةٍ تلقائية — كان الطبيب يجد النموذج
 * فارغًا كله عند «وثّق وأغلق» وحده، مع أن النظام يعرف سبب الموعد وجلسة الخطة وطبيبها.
 */

const base = {
  appointmentNote: null, appointmentType: null, plannedTitle: null, inOrtho: false,
  nextPlanned: null, doctorCandidates: [] as (number | null)[],
};

describe("(VISIT-1) visit suggestions", () => {
  it("chief complaint: the planned session first, then the appointment reason, then ortho follow-up", () => {
    expect(buildVisitSuggestions({ ...base, plannedTitle: "تشكيل القنوات — سن 36", appointmentNote: "ألم" }).chiefComplaint)
      .toBe("جلسة مخطَّطة: تشكيل القنوات — سن 36");
    expect(buildVisitSuggestions({ ...base, appointmentType: "emergency", appointmentNote: "ألم شديد في الضرس" }).chiefComplaint)
      .toBe("طوارئ — ألم شديد في الضرس");
    expect(buildVisitSuggestions({ ...base, appointmentType: "follow_up" }).chiefComplaint).toBe("متابعة دورية");
    expect(buildVisitSuggestions({ ...base, inOrtho: true }).chiefComplaint).toBe("متابعة تقويم — شدّ دوري");
    expect(buildVisitSuggestions(base).chiefComplaint).toBeNull();
  });

  it("next plan names the next planned session and its interval in correct Arabic", () => {
    expect(buildVisitSuggestions({ ...base, nextPlanned: { title: "حشو القنوات النهائي", afterDays: 7 } }).nextPlan)
      .toBe("الجلسة القادمة: حشو القنوات النهائي — بعد 7 أيام");
    expect(buildVisitSuggestions({ ...base, nextPlanned: { title: "شدّة", afterDays: 28 } }).nextPlan)
      .toBe("الجلسة القادمة: شدّة — بعد 28 يومًا");
    expect(buildVisitSuggestions({ ...base, nextPlanned: { title: "تركيب", afterDays: null } }).nextPlan).toBe("الجلسة القادمة: تركيب");
    expect([1, 2, 3, 10, 11].map(arabicDays)).toEqual(["يوم", "يومين", "3 أيام", "10 أيام", "11 يومًا"]);
  });

  it("doctor: the first known candidate in priority order", () => {
    expect(buildVisitSuggestions({ ...base, doctorCandidates: [null, 7, 3] }).doctorId).toBe(7);
    expect(buildVisitSuggestions({ ...base, doctorCandidates: [null, null] }).doctorId).toBeNull();
  });

  it("«ما نُفّذ» is written from the procedures, same procedure on the same tooth counted", () => {
    expect(treatmentDoneFromProcedures([
      { name: "حشوة كمبوزيت", toothCode: "16", quantity: 1 },
      { name: "تنظيف وتلميع", toothCode: "", quantity: 1 },
      { name: "حشوة كمبوزيت", toothCode: 16, quantity: 1 },
      { name: "", toothCode: "11", quantity: 1 },
    ])).toBe("حشوة كمبوزيت — سن 16 ×2؛ تنظيف وتلميع");
    expect(treatmentDoneFromProcedures([])).toBe("");
  });

  it("quick phrases: parsed from the setting, appended once with an Arabic comma", () => {
    expect(parsePhraseList("ألم، تورّم ,ألم,, نزيف")).toEqual(["ألم", "تورّم", "نزيف"]);
    expect(appendPhrase("", "ألم")).toBe("ألم");
    expect(appendPhrase("ألم", "تورّم")).toBe("ألم، تورّم");
    expect(appendPhrase("ألم، تورّم", "ألم")).toBe("ألم، تورّم");
    for (const key of ["clinical.phrases_complaint", "clinical.phrases_exam", "clinical.phrases_diagnosis", "clinical.phrases_next"] as const) {
      expect(parsePhraseList(SETTING_DEFAULTS[key]).length).toBeGreaterThan(4);
      expect(PUBLIC_SETTING_KEYS).toContain(key);
    }
  });
});

describe("(VISIT-1) the visit flow", () => {
  it("«وثّق وأغلق» opens the patient's today workspace; an unlinked walk-in stays on the visit screen", () => {
    expect(visitWorkspaceHref({ id: 9, patientId: 42 })).toBe("/patients/42?tab=today");
    expect(visitWorkspaceHref({ id: 9, patientId: null })).toBe("/visits/9");
    const board = readFileSync(resolve(process.cwd(), "app/page.tsx"), "utf8");
    expect(board).toContain("href={visitWorkspaceHref(chair.occupant)}");
  });

  it("the steps are visible: done steps ticked, the current one highlighted, each linking to its section", () => {
    const html = renderToStaticMarkup(createElement(VisitSteps, { steps: [
      { id: "visit-notes", label: "الشكوى", done: true },
      { id: "visit-notes", label: "الفحص والتشخيص", done: false },
      { id: "visit-procedures", label: "الإجراءات", done: false },
      { id: "visit-sign", label: "المراجعة والتوقيع", done: false },
    ] }));
    expect(html).toContain("✓ الشكوى");
    expect(html).toMatch(/aria-current="step"[^>]*>2\. الفحص والتشخيص/);
    expect(html).toContain('href="#visit-procedures"');
    const source = readFileSync(resolve(process.cwd(), "components/ClinicalVisit.tsx"), "utf8");
    for (const id of ["visit-notes", "visit-procedures", "visit-sign"]) expect(source).toContain(`id="${id}"`);
  });
});
