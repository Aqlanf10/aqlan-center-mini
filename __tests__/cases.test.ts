import { describe, expect, it } from "vitest";
import {
  canMoveCase, checkCaseDraft, checkCaseStatusChange, checkDependencyDraft, checkProblemDraft,
  isDependencyMet, wouldCreateCycle,
} from "../lib/cases";

describe("(CASE-MODEL-1) specialty case rules", () => {
  it("validates a case draft with Arabic messages", () => {
    expect(checkCaseDraft({ specialty: "endodontics", title: " علاج عصب — سن ٣٦ ", site: "36", responsiblePartyId: "4" }))
      .toEqual({ ok: true, value: { specialty: "endodontics", title: "علاج عصب — سن ٣٦", site: "36", problem: null, responsiblePartyId: 4, orthoCaseId: null } });
    expect(checkCaseDraft({ specialty: "magic", title: "x" })).toEqual({ ok: false, message: "اختر تخصص الحالة." });
    expect(checkCaseDraft({ specialty: "endodontics", title: "  " })).toMatchObject({ ok: false });
    expect(checkCaseDraft({ specialty: "endodontics", title: "x", responsiblePartyId: "abc" })).toEqual({ ok: false, message: "الطبيب المسؤول غير صالح." });
  });

  it("moves only along allowed paths; finished cases never reopen", () => {
    expect(canMoveCase("active", "waiting")).toBe(true);
    expect(canMoveCase("waiting", "active")).toBe(true);
    expect(canMoveCase("active", "completed")).toBe(true);
    expect(canMoveCase("completed", "active")).toBe(false);
    expect(canMoveCase("cancelled", "active")).toBe(false);
    expect(canMoveCase("active", "active")).toBe(false);
  });

  it("a cancellation needs a written reason", () => {
    expect(checkCaseStatusChange({ status: "cancelled" })).toEqual({ ok: false, message: "اكتب سبب إلغاء الحالة." });
    expect(checkCaseStatusChange({ status: "cancelled", outcome: "فُتحت بالخطأ" })).toEqual({ ok: true, value: { status: "cancelled", outcome: "فُتحت بالخطأ" } });
    expect(checkCaseStatusChange({ status: "done" })).toMatchObject({ ok: false });
  });

  it("validates problems", () => {
    expect(checkProblemDraft({ label: "التهاب لب", site: "36", caseId: 3 }))
      .toEqual({ ok: true, value: { label: "التهاب لب", site: "36", specialty: null, caseId: 3 } });
    expect(checkProblemDraft({ label: "" })).toMatchObject({ ok: false });
    expect(checkProblemDraft({ label: "x", specialty: "nope" })).toEqual({ ok: false, message: "تخصص غير معروف." });
    // رقم حالةٍ مرسَل غير صالح لا يتحوّل صامتًا إلى «بلا حالة».
    for (const caseId of ["abc", 0, -1]) {
      expect(checkProblemDraft({ label: "x", caseId })).toEqual({ ok: false, message: "الحالة المختارة غير صالحة." });
    }
    expect(checkProblemDraft({ label: "x", caseId: "" })).toMatchObject({ ok: true, value: { caseId: null } });
  });

  it("dependencies: no self, known requirement, and cycles are detected through the chain", () => {
    expect(checkDependencyDraft(5, { requiresItemId: 5 })).toEqual({ ok: false, message: "البند لا يتطلب نفسه." });
    expect(checkDependencyDraft(5, { requiresItemId: 6, requirement: "later" })).toMatchObject({ ok: false });
    expect(checkDependencyDraft(5, { requiresItemId: "6" })).toEqual({ ok: true, value: { requiresItemId: 6, requirement: "completed", note: null } });
    // 3 يتطلب 2، و2 يتطلب 1 ⇒ «1 يتطلب 3» دورة، و«4 يتطلب 3» ليست دورة.
    const edges = [{ itemId: 3, requiresItemId: 2 }, { itemId: 2, requiresItemId: 1 }];
    expect(wouldCreateCycle(edges, 1, 3)).toBe(true);
    expect(wouldCreateCycle(edges, 4, 3)).toBe(false);
    expect(wouldCreateCycle(edges, 3, 1)).toBe(false);
  });

  it("a dependency is met when the required item is done (or cancelled); clearance accepts in progress", () => {
    expect(isDependencyMet("completed", "done")).toBe(true);
    expect(isDependencyMet("completed", "in_progress")).toBe(false);
    expect(isDependencyMet("clearance", "in_progress")).toBe(true);
    expect(isDependencyMet("clearance", "planned")).toBe(false);
    expect(isDependencyMet("completed", "cancelled")).toBe(true);
  });
});
