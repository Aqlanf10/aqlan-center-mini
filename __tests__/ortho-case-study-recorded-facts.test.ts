import { describe, expect, it } from "vitest";
import { assessmentCommandV2 } from "./fixtures/ortho-assessment-schema2";
import { createPersistedAssessmentV2, assessmentJsonHash } from "../lib/ortho-assessment-persisted-v2";
import type { StudySourceSelection } from "../lib/ortho-case-study";
import { projectStudyRecordedFacts } from "../lib/ortho-case-study-recorded-facts";
import { journeyContentHash } from "../lib/ortho-case-journey-hash";
import { CASE_TEMPLATE_VERSION } from "../lib/ortho-case-template";
import { STUDY_TEMPLATE_HASH } from "../lib/ortho-case-study-template";
import type { StudySavedContent } from "../lib/ortho-case-study-capture";
const scope = { patientId: 19, orthoCaseId: 41, clinicalCaseId: 51 };
function diagnosis(): StudySavedContent {
  const content = { skeletal: "Synthetic recorded skeletal finding", dental: null, crowding: "Unknown", overjet: null, bite: null, note: "Synthetic historical note" };
  const selection = { key: "diagnosis1", kind: "diagnosis" as const, id: 91, version: 1, contentHash: journeyContentHash(content) };
  return { schemaVersion: 1, capturedAt: "2026-10-01T00:00:00.000Z", recordedPatientId: scope.patientId,
    orthoCaseId: scope.orthoCaseId, clinicalCaseId: scope.clinicalCaseId, caseStatusAtCapture: "active",
    authored: { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH },
      identityDisclosure: "case_only", sources: [selection], groups: [], mediaUses: [], comment: "Synthetic comment",
      panels: [{ instanceId: "diagnosis_panel", layoutKey: "diagnosis", included: true, state: "available", sourceKeys: [selection.key], images: [], comment: "" }] },
    sources: [{ selection, state: "available", unavailableReason: null, access: { images: false, plans: false },
      payload: { id: 91, version: 1, createdAt: "2026-09-01T00:00:00.000Z", createdBy: "Synthetic clinician", content } }] };
}
function ceph(): StudySavedContent {
  const study = diagnosis();
  const payload = { id: 2147483648, status: "completed", phase: "initial", acquisitionDate: null, device: null,
    referenceSetKey: "synthetic_reference", studyKind: "synthetic", note: null,
    createdAt: "2026-09-01T00:00:00.000Z", createdBy: "Synthetic clinician", completedAt: "2026-09-02T00:00:00.000Z", completedBy: "Synthetic clinician", correctsStudyId: null,
    image: { documentId: 72, contentHash: "b".repeat(64), state: "available" }, measurements: [{ code: "SNA", value: 81.25, unit: null, provenance: "stored_measurement_unit_not_versioned" }],
    diagnosis: null, interpretation: { state: "unavailable", reason: "review_and_reference_witness_not_versioned" }, historicalCompletionMeaning: "stored_completion_not_new_clinical_validation" };
  const selection = { key: "ceph1", kind: "ceph_study" as const, id: payload.id, version: null, contentHash: journeyContentHash(payload) };
  study.authored.sources = [selection]; study.authored.panels[0] = { ...study.authored.panels[0], layoutKey: "ceph-measurements", sourceKeys: [selection.key] };
  study.sources = [{ selection, state: "available", unavailableReason: null, access: { images: true, plans: false }, payload }]; return study;
}
describe("captured source-specific display without new clinical inference", () => {
  it("preserves diagnosis facts, missing values and exact source binding without modifying capture", () => {
    const input = diagnosis(), before = JSON.stringify(input), result = projectStudyRecordedFacts(input, scope, "diagnosis_panel", "draft");
    expect(result.complete).toBe(true); expect(JSON.stringify(result.blocks)).toContain("Synthetic recorded skeletal finding");
    expect(JSON.stringify(result.blocks)).toContain("غير مسجل"); expect(JSON.stringify(input)).toBe(before);
    for (const block of result.blocks) if (block.kind === "paragraph") expect(block.sourceKeys).toEqual(["diagnosis1"]);
    else block.rows.forEach(row => { expect(row.sourceKeys).toEqual(["diagnosis1"]); expect(row.review).toBe("draft"); });
  });
  it("does not reinterpret historical Ceph completion or invent a versioned unit", () => {
    const result = projectStudyRecordedFacts(ceph(), scope, "diagnosis_panel", "documented"), text = JSON.stringify(result.blocks);
    expect(text).toContain("completed"); expect(text).toContain("81.25"); expect(text).toContain("غير موثقة بنسخة في المصدر");
    expect(text).toContain("لا يمثل تحققًا سريريًا جديدًا"); expect(text).toContain("التفسير المراجع غير متاح");
    expect(text).not.toContain("normal"); expect(text).not.toContain("81.25°");
  });
  it("reports missing sources instead of displaying false empty clinical facts", () => {
    const input = diagnosis(); input.sources[0] = { ...input.sources[0], state: "unavailable", unavailableReason: "source_missing_or_outside_case", payload: null };
    const result = projectStudyRecordedFacts(input, scope, "diagnosis_panel", "draft");
    expect(result.blocks).toEqual([]); expect(result.complete).toBe(false); expect(result.unavailable).toEqual([{ sourceKey: "diagnosis1", reason: "source_missing_or_outside_case" }]);
  });
  it("reports an unsupported source/layout pair rather than guessing a clinical placement", () => {
    const input = diagnosis(); input.authored.panels[0].layoutKey = "smile";
    const result = projectStudyRecordedFacts(input, scope, "diagnosis_panel", "draft");
    expect(result.blocks).toEqual([]); expect(result.unmapped).toHaveLength(1); expect(result.complete).toBe(false);
  });
  it("rejects injected financial fields and a foreign case before producing blocks", () => {
    const input = diagnosis(); const payload = input.sources[0].payload as Record<string, unknown>;
    payload.content = { ...(payload.content as Record<string, unknown>), price: 999 };
    expect(() => projectStudyRecordedFacts(input, scope, "diagnosis_panel", "draft")).toThrow();
    expect(() => projectStudyRecordedFacts(diagnosis(), { ...scope, orthoCaseId: 42 }, "diagnosis_panel", "draft")).toThrow();
  });
});

function documentary(kind: "decision" | "retention_event", content: unknown, layoutKey: string): StudySavedContent {
  const study = diagnosis(), selection = { key: `${kind}_91`, kind, id: 91, version: 1, contentHash: journeyContentHash(content) };
  study.authored.sources = [selection]; study.authored.panels[0] = { ...study.authored.panels[0], layoutKey, sourceKeys: [selection.key] };
  study.sources = [{ selection, state: "available", unavailableReason: null, access: { images: false, plans: false }, payload: {
    ...scope, id: 91, recordedPatientId: scope.patientId, schemaVersion: 1, version: 1, predecessorId: null,
    createdBy: "Synthetic clinician", createdAt: "2026-10-01T00:00:00.000Z", reason: "Synthetic record",
    recordingContext: "current", caseStatusAtCapture: "active", contentHash: selection.contentHash, content } }]; return study;
}
const occurrence = { occurredOn: null, dateProvenance: "unknown", sourceNote: "Unknown historical event date" };
it("keeps a proposed documentary decision distinct from approval or a fabricated consent", () => {
  const input = documentary("decision", { authored: { occurrence, status: "proposed",
    alternatives: [{ id: "option_a", label: "Synthetic option", description: "Clinician-authored alternative" }], selectedAlternativeId: null,
    rationale: "Synthetic rationale", missingEvidence: ["Explicit missing source"], assessment: null, diagnosis: null, strategy: null,
    planId: null, expectedPlanScopeHash: null, expectedConsentHash: null }, consent: null, sourceAccess: { imaging: false, plans: false } }, "mechanotherapy");
  const result = projectStudyRecordedFacts(input, scope, "diagnosis_panel", "documented"), text = JSON.stringify(result.blocks);
  expect(result.complete).toBe(true); expect(text).toContain("proposed"); expect(text).toContain("Explicit missing source");
  expect(text).toContain("unknown"); expect(text).not.toContain("approved"); expect(text).not.toContain("موافقة جديدة");
});
it("retains exact physical replacement references, unknown date and explicit absence of lab binding", () => {
  const input = documentary("retention_event", { arch: "upper", supersedesEntryId: null, archCorrectionReason: null,
    payload: { kind: "device_replacement", occurrence, note: "Synthetic replacement", documentIds: [], deviceType: "removable",
      description: "New physical appliance", extent: "Recorded upper extent", labOrderId: null, replaces: { deviceId: 51, expectedDeviceRevisionId: 61 } } }, "retention");
  const result = projectStudyRecordedFacts(input, scope, "diagnosis_panel", "draft"), text = JSON.stringify(result.blocks);
  expect(result.complete).toBe(true); expect(text).toContain("device_replacement"); expect(text).toContain("51"); expect(text).toContain("61");
  expect(text).toContain("unknown"); expect(text).toContain("غير مسجل"); expect(text).toContain("لا يستنتج العرض حالة جهاز نشط");
});
it("does not display a device delivery as debond", () => {
  const input = documentary("retention_event", { arch: "upper", supersedesEntryId: null, archCorrectionReason: null,
    payload: { kind: "device_delivery", occurrence, note: "", documentIds: [], deviceType: "fixed", description: "Synthetic fixed device", extent: "Upper", labOrderId: null } }, "debond");
  const result = projectStudyRecordedFacts(input, scope, "diagnosis_panel", "draft");
  expect(result.blocks).toEqual([]); expect(result.unmapped[0].reason).toBe("retention_event_not_debond");
});
it("keeps a retention follow-up intent distinct from an appointment", () => {
  const input = documentary("retention_event", { arch: "legacy_unknown", supersedesEntryId: null, archCorrectionReason: null,
    payload: { kind: "followup_intent", occurrence, note: "", documentIds: [], device: null, dueOn: null, intervalDays: 90, scope: "Both devices need clinical review" } }, "retention");
  const text = JSON.stringify(projectStudyRecordedFacts(input, scope, "diagnosis_panel", "draft").blocks);
  expect(text).toContain("legacy_unknown"); expect(text).toContain("90"); expect(text).toContain("ليست موعدًا محجوزًا");
});

it.each(["not_recorded", "unavailable", "restricted"] as const)("preserves authored %s state and retained source bytes without projecting clinical facts", state => {
  const input = diagnosis(); input.authored.panels[0].state = state;
  if (state === "not_recorded") input.authored.panels[0].sourceKeys = [];
  const before = JSON.stringify(input);
  const result = projectStudyRecordedFacts(input, scope, "diagnosis_panel", "draft");
  expect(result.panelState).toBe(state); expect(result.blocks).toEqual([]); expect(result.complete).toBe(false);
  expect(JSON.stringify(input)).toBe(before); expect(input.sources[0].state).toBe("available");
  expect(input.authored.panels[0].sourceKeys).toEqual(state === "not_recorded" ? [] : ["diagnosis1"]);
});
it("discloses exact decision evidence tuples and historical consent scope", () => {
  const observed = { planId: 31, consentAt: "2026-09-01T00:00:00.000Z", consentBy: "Synthetic clinician", state: "historical_unverified", planScopeHash: "f".repeat(64) };
  const observationHash = journeyContentHash(observed);
  const content = { authored: { occurrence, status: "selected", alternatives: [{ id: "option_a", label: "Synthetic option", description: "Recorded" }], selectedAlternativeId: "option_a",
    rationale: "Recorded rationale", missingEvidence: [], assessment: { id: 71, version: 3, contentHash: "a".repeat(64) }, diagnosis: { id: 72, version: 4 },
    strategy: { id: 73, version: 5, contentHash: "b".repeat(64) }, planId: 31, expectedPlanScopeHash: observed.planScopeHash, expectedConsentHash: observationHash },
    consent: { ...observed, observationHash, capturedAt: "2026-10-01T00:00:00.000Z" }, sourceAccess: { imaging: false, plans: true } };
  const input = documentary("decision", content, "plan-changes"); input.sources[0].access.plans = true;
  const before = JSON.stringify(input), result = projectStudyRecordedFacts(input, scope, "diagnosis_panel", "documented");
  const cells = result.blocks.flatMap(block => block.kind === "table" ? block.rows.flatMap(row => row.cells) : []);
  for (const exact of ["71", "3", "72", "4", "73", "5", "a".repeat(64), "b".repeat(64), "historical_unverified", "31"]) expect(cells).toContain(exact);
  expect(JSON.stringify(input)).toBe(before);
});
it("discloses retention evidence IDs and preserves unknown/not-assessed observations", () => {
  const observations = { fit: { state: "unknown", note: "Unknown fit" }, breakage: { state: "not_assessed", note: "" },
    loss: { state: "recorded", note: "Clinician recorded no reported loss" }, hygiene: { state: "unknown", note: "" }, adherence: { state: "not_assessed", note: "" }, relapse: { state: "unknown", note: "" } };
  const input = documentary("retention_event", { arch: "lower", supersedesEntryId: null, archCorrectionReason: null,
    payload: { kind: "device_review", occurrence, note: "", documentIds: [81, 82], device: { deviceId: 51, expectedDeviceRevisionId: 61 }, observations } }, "retention");
  input.sources[0].access.images = true; const before = JSON.stringify(input), result = projectStudyRecordedFacts(input, scope, "diagnosis_panel", "draft"), text = JSON.stringify(result.blocks);
  expect(text).toContain("[81,82]"); expect(text).toContain("unknown"); expect(text).toContain("not_assessed"); expect(text).toContain("لم تُسجل نسخة محتوى أو معاينة");
  expect(JSON.stringify(input)).toBe(before);
});


function selectedCapture(selection: StudySourceSelection, payload: unknown, layoutKey: string, images = false, plans = false): StudySavedContent {
  const input = diagnosis(); input.authored.sources = [selection]; input.authored.panels[0] = { ...input.authored.panels[0], layoutKey, sourceKeys: [selection.key] };
  input.sources = [{ selection, payload, state: "available", unavailableReason: null, access: { images, plans } }]; return input;
}
it("projects full decoded assessment set memberships and stored ready/non-ready results without changing source", () => {
  const command = assessmentCommandV2(); command.content.measurementSets.push({ id: "incomplete_set", toothWidthObservationIds: [], upperAvailableObservationId: null, lowerAvailableObservationId: null });
  command.content.analyses.push({ id: "space_missing", state: "draft", measurementSetId: "incomplete_set", method: "arch_space", arch: "upper" });
  const persisted = createPersistedAssessmentV2(command.content); expect(persisted.ok).toBe(true); if (!persisted.ok) throw new Error(persisted.code);
  expect(persisted.value.results.some(row => row.result.state === "ready")).toBe(true);
  expect(persisted.value.results.some(row => row.result.state === "incomplete")).toBe(true);
  const payload = { ...scope, id: 91, recordedPatientId: scope.patientId, version: 1, supersedesRevisionId: null, schemaVersion: 2,
    createdAt: "2026-10-01T00:00:00.000Z", createdBy: "Synthetic examiner", reason: "Synthetic measurement capture", recordingContext: "current",
    content: persisted.value, contentHash: assessmentJsonHash(persisted.value) };
  const selection: StudySourceSelection = { key: "assessment1", kind: "assessment", id: 91, version: 1, contentHash: payload.contentHash };
  const cast = selectedCapture(selection, payload, "cast-analysis"), before = JSON.stringify(cast);
  const castBlocks = projectStudyRecordedFacts(cast, scope, "diagnosis_panel", "draft").blocks;
  const castText = JSON.stringify(castBlocks);
  expect(castText).toContain("current"); expect(castText).toContain("incomplete_set");
  expect(castBlocks.flatMap(block => block.kind === "table" ? block.rows.flatMap(row => row.cells) : [])).toContain(JSON.stringify(command.content.measurementSets[0].toothWidthObservationIds));
  expect(castText).toContain("available_upper"); expect(castText).toContain("available_lower"); expect(JSON.stringify(cast)).toBe(before);
  const model = selectedCapture(selection, payload, "model-measurements"); const result = projectStudyRecordedFacts(model, scope, "diagnosis_panel", "documented");
  const text = JSON.stringify(result.blocks); expect(text).toContain("ready"); expect(text).toContain("incomplete"); expect(text).toContain("غير معتمد");
  for (const stored of persisted.value.results) expect(text).toContain(stored.resultHash);
});
it("preserves adjustment visit identity and missing signature without making a new signature", () => {
  const payload = { id: 91, visitId: 101, doneOn: "2026-09-01", phase: null, upperWire: "Synthetic upper", lowerWire: null, done: "Synthetic recorded action", note: null, signedAt: null };
  const input = selectedCapture({ key: "adjustment1", kind: "adjustment", id: 91, version: null, contentHash: journeyContentHash(payload) }, payload, "visit");
  const text = JSON.stringify(projectStudyRecordedFacts(input, scope, "diagnosis_panel", "draft").blocks);
  expect(text).toContain("101"); expect(text).toContain("2026-09-01"); expect(text).toContain("غير مسجل"); expect(text).toContain("لا ينشئ توقيعًا");
});
it("shows only document metadata and does not declare encoded dimensions an oriented basis", () => {
  const payload = { id: 91, title: "Synthetic image", mimeType: "image/jpeg", sizeBytes: 1000, contentHash: "c".repeat(64), width: 800, height: 600 };
  const input = selectedCapture({ key: "document1", kind: "document", id: 91, version: null, contentHash: payload.contentHash }, payload, "records-overview", true);
  const text = JSON.stringify(projectStudyRecordedFacts(input, scope, "diagnosis_panel", "draft").blocks);
  expect(text).toContain("800"); expect(text).toContain("600"); expect(text).toContain("ليست إثباتًا لاتجاه EXIF");
});
it("preserves plan item/consent scope without allowing injected financial fields", () => {
  const consent = { planId: 91, consentAt: null, consentBy: null, state: "not_recorded", planScopeHash: "d".repeat(64) };
  const payload = { planId: 91, title: "Synthetic plan", status: "active", patientId: scope.patientId,
    items: [{ id: 101, caseId: scope.clinicalCaseId, serviceName: "Synthetic treatment", toothCode: 16, surfaces: null, quantity: 1, status: "planned" }],
    consent: { ...consent, observationHash: journeyContentHash(consent) }, itemScope: "selected_clinical_case_only", excludedItemCount: 2, consentScope: "existing_whole_plan_observation" };
  const input = selectedCapture({ key: "plan1", kind: "plan_consent", id: 91, version: null, contentHash: payload.consent.observationHash }, payload, "problem-plan-strategy", false, true);
  const text = JSON.stringify(projectStudyRecordedFacts(input, scope, "diagnosis_panel", "draft").blocks);
  expect(text).toContain("selected_clinical_case_only"); expect(text).toContain("existing_whole_plan_observation"); expect(text).toContain("not_recorded"); expect(text).not.toContain("price");
  input.sources[0].payload = { ...payload, price: 999 }; expect(() => projectStudyRecordedFacts(input, scope, "diagnosis_panel", "draft")).toThrow();
});
