import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdjustmentForm } from "../components/PatientOrtho";
import { wiresFor } from "../lib/ortho";

// Exercise the actual standalone form's state and submit handlers with synthetic data.
// Peripheral components are stubbed; no route, database, browser, or real network runs.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) {
        hooks.values[index] = typeof initial === "function" ? initial() : initial;
      }
      return [hooks.values[index], (value: unknown) => {
        hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value;
      }];
    },
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
  };
});
vi.mock("../components/LegacyOnboardingChecklist", () => ({ LegacyOnboardingChecklist: () => null }));
vi.mock("../components/OrthoPackageLink", () => ({ OrthoPackageLink: () => null }));
vi.mock("../components/PatientCeph", () => ({ PatientCeph: () => null }));
vi.mock("../components/PatientDiagnosis", () => ({ PatientDiagnosis: () => null }));
vi.mock("../components/WebCephRecordsGrid", () => ({ WebCephRecordsGrid: () => null }));
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "Synthetic clinic", useSetting: () => "" }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => null }));

type Props = ComponentProps<typeof AdjustmentForm>;
type Case = Props["caseRow"];
type Element = ReactElement<Record<string, unknown>>;
const base: Case = {
  id: 95001, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null,
  status: "active", phase: "aligning", startDate: "2026-09-01", plannedMonths: 18,
  upperWire: "014 NiTi", lowerWire: "012 NiTi", planId: null, retainer: null, retainerOn: null, note: null,
  closedAt: null, closedBy: null, closedNote: null, baselineKind: null, baselineRecordedAt: null,
  elastics: null, responsibleDoctorName: null, legacyFinancialMode: null, remainingObjectives: null,
  adjustments: [{ id: 94001, visitId: 91001, visitSigned: true, doneOn: "2026-09-01", phase: "aligning",
    upperWire: "012 NiTi", lowerWire: null, elastics: "none", elasticNote: null,
    done: "Historical signed adjustment, not today's work", nextWeeks: 4, note: null,
    recordedBy: "Synthetic clinician", photos: [],
  }],
  progress: { monthsElapsed: 1, monthsPlanned: 18, monthsRemaining: 17, percent: 6,
    overdue: false, adjustments: 1, lastAdjustment: "2026-09-01", daysSinceLast: 33 },
};
const today = "2026-10-04";
const fetchMock = vi.fn();
const onSaved = vi.fn();
const onError = vi.fn();
let caseRow: Case;

function render() {
  hooks.cursor = 0;
  return AdjustmentForm({ caseRow, today, wires: wiresFor(caseRow.slot), patientId: 92001, onSaved, onError });
}
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function input(label: string) {
  const node = elements(render()).find((entry) => entry.props["aria-label"] === label);
  if (!node) throw new Error(`Missing adjustment input: ${label}`);
  return node;
}
function edit(label: string, value: string) {
  (input(label).props.onChange as (event: unknown) => void)({ target: { value } });
}
function chooseWire(label: string, value: string) {
  const control = input(label);
  expect(control.type).toBe("select");
  expect(elements(control).some((entry) => entry.type === "option" && entry.props.value === value)).toBe(true);
  edit(label, value);
}
async function submit() {
  const form = render();
  await form.props.onSubmit({ preventDefault: vi.fn() });
}
const body = (index = 0) => JSON.parse(String(fetchMock.mock.calls[index][1].body)) as Record<string, unknown>;
const response = (status: number, value: unknown) => ({ ok: status >= 200 && status < 300, json: async () => value });

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0;
  vi.clearAllMocks();
  caseRow = structuredClone(base);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(response(200, { id: 96001, visitId: 91002 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("standalone orthodontic adjustment wire defaults", () => {
  it("sends current wires for a notes-only save", async () => {
    edit("ما نُفّذ في الشدّة", "Notes only, no wire change");
    await submit();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(body()).toMatchObject({ upperWire: "014 NiTi", lowerWire: "012 NiTi", done: "Notes only, no wire change" });
  });

  it.each([
    { label: "ordinary 022 sequence", slot: "022", upperWire: "014 NiTi", lowerWire: "012 NiTi" },
    { label: "ordinary 018 sequence", slot: "018", upperWire: "016 NiTi", lowerWire: "014 NiTi" },
    { label: "no recorded wires", slot: "022", upperWire: null, lowerWire: null },
    { label: "only an upper wire", slot: "018", upperWire: "014 NiTi", lowerWire: null },
    { label: "only a lower wire", slot: "022", upperWire: null, lowerWire: "016 NiTi" },
    { label: "custom current wires", slot: "022", upperWire: "Custom upper wire", lowerWire: "Custom lower wire" },
    { label: "end of 022 sequence", slot: "022", upperWire: "019×025 TMA", lowerWire: "019×025 TMA" },
    { label: "end of 018 sequence", slot: "018", upperWire: "017×025 TMA", lowerWire: "017×025 TMA" },
  ] satisfies Array<{ label: string; slot: Case["slot"]; upperWire: string | null; lowerWire: string | null }>)(
    "preserves $label through a notes-only save", async ({ slot, upperWire, lowerWire }) => {
      caseRow = { ...caseRow, slot, upperWire, lowerWire };
      const before = structuredClone(caseRow);
      expect(input("السلك العلوي").props.value).toBe(upperWire ?? "");
      expect(input("السلك السفلي").props.value).toBe(lowerWire ?? "");
      expect(input("ما نُفّذ في الشدّة").props.value).toBe("");
      for (const [label, value] of [["السلك العلوي", upperWire], ["السلك السفلي", lowerWire]] as const) {
        expect(elements(input(label)).some((entry) => entry.type === "option" && entry.props.value === (value ?? ""))).toBe(true);
      }
      expect(fetchMock).not.toHaveBeenCalled();
      edit("ما نُفّذ في الشدّة", "Reviewed current appliances today");
      await submit();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe("/api/ortho/95001");
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
      expect(body()).toEqual({ doneOn: today, upperWire: upperWire ?? "", lowerWire: lowerWire ?? "",
        elastics: "none", elasticNote: "", done: "Reviewed current appliances today", nextWeeks: 4 });
      expect(caseRow).toEqual(before);
      expect(onSaved).toHaveBeenCalledExactlyOnceWith({ adjustmentId: 96001, caseId: 95001,
        doneOn: today, nextWeeks: 4, photosUploaded: 0, visitId: 91002 });
      expect(onError).toHaveBeenCalledExactlyOnceWith(null);
    },
  );

  it.each([
    { label: "السلك العلوي", chosen: "016 NiTi", upperWire: "016 NiTi", lowerWire: "012 NiTi" },
    { label: "السلك السفلي", chosen: "014 NiTi", upperWire: "014 NiTi", lowerWire: "014 NiTi" },
  ])("changes only the explicitly selected arch: $label", async ({ label, chosen, upperWire, lowerWire }) => {
    chooseWire(label, chosen);
    expect(input("السلك العلوي").props.value).toBe(upperWire);
    expect(input("السلك السفلي").props.value).toBe(lowerWire);
    expect(fetchMock).not.toHaveBeenCalled();
    edit("ما نُفّذ في الشدّة", "Explicit wire selection today");
    await submit();
    expect(body()).toMatchObject({ upperWire, lowerWire, done: "Explicit wire selection today" });
    expect(caseRow).toEqual(base);
  });

  it("records a first wire only after selection, leaving the other unset arch alone", async () => {
    caseRow = { ...caseRow, upperWire: null, lowerWire: null };
    chooseWire("السلك السفلي", "012 NiTi");
    await submit();
    expect(body()).toMatchObject({ upperWire: "", lowerWire: "012 NiTi" });
  });

  it("retains clinician-directed changes and the existing blank no-change option", async () => {
    caseRow = { ...caseRow, upperWire: "019×025 TMA", lowerWire: "Custom lower wire" };
    chooseWire("السلك العلوي", "014 NiTi");
    chooseWire("السلك السفلي", "");
    await submit();
    expect(body()).toMatchObject({ upperWire: "014 NiTi", lowerWire: "" });
  });

  it.each(["aligners", "removable", "functional"] as const)("does not invent hidden wires for %s", async (appliance) => {
    caseRow = { ...caseRow, appliance, upperWire: null, lowerWire: null };
    expect(elements(render()).some((entry) => ["السلك العلوي", "السلك السفلي"].includes(String(entry.props["aria-label"])))).toBe(false);
    edit("ما نُفّذ في الشدّة", "Reviewed appliance today");
    await submit();
    expect(body()).toMatchObject({ upperWire: "", lowerWire: "", done: "Reviewed appliance today" });
  });

  it.each(["aligners", "removable", "functional"] as const)("preserves existing hidden wires for %s", async (appliance) => {
    caseRow = { ...caseRow, appliance, upperWire: "Custom upper wire", lowerWire: "016 NiTi" };
    expect(elements(render()).some((entry) => ["السلك العلوي", "السلك السفلي"].includes(String(entry.props["aria-label"])))).toBe(false);
    edit("ما نُفّذ في الشدّة", "Unrelated notes only");
    await submit();
    expect(body()).toMatchObject({ upperWire: "Custom upper wire", lowerWire: "016 NiTi", done: "Unrelated notes only" });
  });

  it("retains the unchanged wires and notes after rejection and retry", async () => {
    fetchMock.mockResolvedValueOnce(response(409, { message: "Synthetic rejection" }));
    edit("ما نُفّذ في الشدّة", "Today's retained note");
    await submit();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onError).toHaveBeenLastCalledWith("Synthetic rejection");
    expect(input("السلك العلوي").props.value).toBe("014 NiTi");
    expect(input("السلك السفلي").props.value).toBe("012 NiTi");
    expect(input("ما نُفّذ في الشدّة").props.value).toBe("Today's retained note");
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body(1)).toEqual(body(0));
    expect(body(1)).toMatchObject({ upperWire: "014 NiTi", lowerWire: "012 NiTi", done: "Today's retained note" });
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("reopens with newly loaded current wires without advancing again", async () => {
    chooseWire("السلك العلوي", "016 NiTi");
    await submit();
    // The parent unmounts the form after a confirmed save and reloads the case.
    hooks.values = [];
    caseRow = { ...caseRow, upperWire: "016 NiTi" };
    expect(input("السلك العلوي").props.value).toBe("016 NiTi");
    expect(input("السلك السفلي").props.value).toBe("012 NiTi");
    expect(input("ما نُفّذ في الشدّة").props.value).toBe("");
    edit("ما نُفّذ في الشدّة", "Next notes-only session");
    await submit();
    expect(body(1)).toMatchObject({ upperWire: "016 NiTi", lowerWire: "012 NiTi", done: "Next notes-only session" });
  });
});


describe("standalone orthodontic ongoing regimen defaults", () => {
  function previous(values: Partial<Case["adjustments"][number]>) {
    caseRow.adjustments = [{ ...base.adjustments[0], ...values }];
  }

  it.each(["class_ii", "class_iii", "vertical", "triangle", "cross"] as const)(
    "preserves current %s instructions for a notes-only save", async (elastics) => {
      previous({ elastics, elasticNote: "3/16 light, night wear", nextWeeks: 6 });
      const before = structuredClone(caseRow);
      expect(input("ما نُفّذ في الشدّة").props.value).toBe("");
      expect(input("تاريخ الشدّة").props.value).toBe(today);
      expect(fetchMock).not.toHaveBeenCalled();
      edit("ما نُفّذ في الشدّة", "Reviewed ongoing regimen today");
      await submit();
      // Assert the actual posted regimen first: the original-product negative must
      // witness its incorrect payload, not stop at a cosmetic initial-value check.
      expect(body()).toEqual({ doneOn: today, upperWire: "014 NiTi", lowerWire: "012 NiTi",
        elastics, elasticNote: "3/16 light, night wear", done: "Reviewed ongoing regimen today", nextWeeks: 6 });
      expect(input("صنف المطاطات").props.value).toBe(elastics);
      expect(input("وصف المطاطات").props.value).toBe("3/16 light, night wear");
      expect(input("أسابيع حتى الشدّة القادمة").props.value).toBe("6");
      expect(caseRow).toEqual(before);
      expect(onSaved).toHaveBeenCalledExactlyOnceWith({ adjustmentId: 96001, caseId: 95001,
        doneOn: today, nextWeeks: 6, photosUploaded: 0, visitId: 91002 });
    },
  );

  it.each([1, 5, 52])("retains the saved %i-week interval instead of resetting to four", async (nextWeeks) => {
    previous({ nextWeeks });
    expect(input("أسابيع حتى الشدّة القادمة").props.value).toBe(String(nextWeeks));
    await submit();
    expect(body()).toMatchObject({ nextWeeks, done: "", doneOn: today });
  });

  it("treats the latest recorded none as authoritative instead of reviving older or baseline elastics", async () => {
    caseRow.elastics = "Baseline class II description";
    caseRow.adjustments = [
      { ...base.adjustments[0], elastics: "none", elasticNote: null, nextWeeks: 8 },
      { ...base.adjustments[0], id: 93999, doneOn: "2026-08-01", elastics: "class_ii", elasticNote: "Historical night wear", nextWeeks: 5 },
    ];
    expect(input("صنف المطاطات").props.value).toBe("none");
    expect(elements(render()).some((entry) => entry.props["data-testid"] === "adjustment-baseline-elastics")).toBe(false);
    await submit();
    expect(body()).toMatchObject({ elastics: "none", elasticNote: "", nextWeeks: 8, done: "" });
  });

  it("keeps a current null description blank rather than copying stale baseline instructions", async () => {
    caseRow.elastics = "Stale baseline regimen";
    previous({ elastics: "vertical", elasticNote: null, nextWeeks: 3 });
    expect(input("وصف المطاطات").props.value).toBe("");
    await submit();
    expect(body()).toMatchObject({ elastics: "vertical", elasticNote: "", nextWeeks: 3, done: "" });
  });

  it("shows and preserves a recorded description even when its saved class is none", async () => {
    previous({ elastics: "none", elasticNote: "Recorded description requiring clinician review" });
    expect(input("صنف المطاطات").props.value).toBe("none");
    expect(input("وصف المطاطات").props.value).toBe("Recorded description requiring clinician review");
    await submit();
    expect(body()).toMatchObject({ elastics: "none", elasticNote: "Recorded description requiring clinician review" });
  });

  it.each(["صنف ثانٍ 3/16 — ليلًا", "class_iii", "لا توجد مطاطات", "Unknown legacy description"])(
    "requires an explicit first-session class rather than interpreting baseline text: %s", async (description) => {
      caseRow = { ...caseRow, baselineKind: "legacy", elastics: description, adjustments: [] };
      const before = structuredClone(caseRow);
      expect(input("صنف المطاطات").props.value).toBe("");
      expect(input("صنف المطاطات").props.required).toBe(true);
      expect(elements(input("صنف المطاطات")).some((entry) => entry.type === "option" && entry.props.value === "")).toBe(true);
      expect(input("وصف المطاطات").props.value).toBe(description);
      expect(input("ما نُفّذ في الشدّة").props.value).toBe("");
      expect(input("أسابيع حتى الشدّة القادمة").props.value).toBe("4");
      const explanation = elements(render()).find((entry) => entry.props["data-testid"] === "adjustment-baseline-elastics");
      expect(explanation?.props.role).toBe("status");
      expect(JSON.stringify(explanation?.props.children)).toContain(description);
      await submit();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
      expect(onError).toHaveBeenLastCalledWith("اختر صنف المطاطات لهذه الجلسة؛ وصف خط الأساس لا يحدّد الصنف تلقائيًا.");
      expect(caseRow).toEqual(before);
    },
  );

  it("keeps the baseline description after an explicit class choice without retyping it", async () => {
    caseRow = { ...caseRow, baselineKind: "legacy", elastics: "صنف ثانٍ 3/16 — ليلًا", adjustments: [] };
    await submit();
    expect(fetchMock).not.toHaveBeenCalled();
    edit("صنف المطاطات", "class_ii");
    await submit();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(body()).toMatchObject({ elastics: "class_ii", elasticNote: "صنف ثانٍ 3/16 — ليلًا", nextWeeks: 4, done: "" });
    expect(onError).toHaveBeenLastCalledWith(null);
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it.each(["latest adjustment", "legacy baseline"])("allows explicit stopping of %s elastics without carrying its instructions forward", async (source) => {
    if (source === "legacy baseline") caseRow = { ...caseRow, baselineKind: "legacy", elastics: "Previous elastic instructions", adjustments: [] };
    else previous({ elastics: "class_ii", elasticNote: "Previous elastic instructions", nextWeeks: 6 });
    const before = structuredClone(caseRow);
    edit("صنف المطاطات", "none");
    expect(elements(render()).some((entry) => entry.props["aria-label"] === "وصف المطاطات")).toBe(false);
    edit("ما نُفّذ في الشدّة", "Stopped elastics today");
    await submit();
    expect(body()).toMatchObject({ elastics: "none", elasticNote: "", done: "Stopped elastics today" });
    expect(caseRow).toEqual(before);
  });

  it("allows explicit changes to regimen, description and interval while retaining the wires", async () => {
    previous({ elastics: "class_ii", elasticNote: "Previous instructions", nextWeeks: 6 });
    edit("صنف المطاطات", "triangle");
    edit("وصف المطاطات", "New instructions selected today");
    edit("أسابيع حتى الشدّة القادمة", "2");
    await submit();
    expect(body()).toMatchObject({ upperWire: "014 NiTi", lowerWire: "012 NiTi", elastics: "triangle",
      elasticNote: "New instructions selected today", nextWeeks: 2, done: "" });
  });

  it.each([null, "", "   "])("uses ordinary first-session defaults when the baseline has no description (%s)", async (elastics) => {
    caseRow = { ...caseRow, baselineKind: "legacy", elastics, adjustments: [] };
    expect(input("صنف المطاطات").props.value).toBe("none");
    expect(elements(render()).some((entry) => entry.props["data-testid"] === "adjustment-baseline-elastics")).toBe(false);
    await submit();
    expect(body()).toMatchObject({ elastics: "none", elasticNote: "", nextWeeks: 4, done: "", doneOn: today });
  });

  it("keeps the ongoing regimen and explicit edits through rejection and retry", async () => {
    previous({ elastics: "cross", elasticNote: "Night wear", nextWeeks: 6 });
    fetchMock.mockResolvedValueOnce(response(409, { message: "Synthetic rejection" }));
    edit("ما نُفّذ في الشدّة", "Current session only");
    edit("أسابيع حتى الشدّة القادمة", "3");
    await submit();
    expect(onSaved).not.toHaveBeenCalled();
    expect(input("صنف المطاطات").props.value).toBe("cross");
    expect(input("وصف المطاطات").props.value).toBe("Night wear");
    expect(input("أسابيع حتى الشدّة القادمة").props.value).toBe("3");
    await submit();
    expect(body(1)).toEqual(body(0));
    expect(body(1)).toMatchObject({ elastics: "cross", elasticNote: "Night wear", nextWeeks: 3, done: "Current session only" });
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("reopens from the newly loaded regimen while leaving today's work blank", async () => {
    previous({ elastics: "class_ii", elasticNote: "Night wear", nextWeeks: 6 });
    edit("صنف المطاطات", "vertical");
    edit("وصف المطاطات", "Updated instructions");
    edit("أسابيع حتى الشدّة القادمة", "2");
    edit("ما نُفّذ في الشدّة", "Prior session procedure");
    await submit();
    hooks.values = [];
    previous({ elastics: "vertical", elasticNote: "Updated instructions", nextWeeks: 2, done: "Prior session procedure" });
    expect(input("صنف المطاطات").props.value).toBe("vertical");
    expect(input("وصف المطاطات").props.value).toBe("Updated instructions");
    expect(input("أسابيع حتى الشدّة القادمة").props.value).toBe("2");
    expect(input("ما نُفّذ في الشدّة").props.value).toBe("");
    await submit();
    expect(body(1)).toMatchObject({ elastics: "vertical", elasticNote: "Updated instructions", nextWeeks: 2, done: "" });
  });
});
