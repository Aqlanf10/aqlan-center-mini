import type { StrategyProjection, StrategyCommand } from "../../lib/ortho-treatment-strategy";
import type { OrthoStrategyReadResult } from "../../lib/ortho-treatment-strategy-store";

// Synthetic data only. These builders neither call persistence nor imply access.
// Browser tests must use the harness's authenticated, owned patient identifiers.
export type StrategyReady = Extract<OrthoStrategyReadResult, { state: "ready" }>;
export type StrategyBridgeMissing = Extract<OrthoStrategyReadResult, { state: "bridge_missing" }>;
export const STRATEGY_IDS = {
  a: { orthoCaseId: 959711, clinicalCaseId: 959721, problemId: 959731, otherProblemId: 959732,
    planItemId: 959741, revision1: 959751, revision2: 959752 },
  b: { orthoCaseId: 959712, clinicalCaseId: 959722, problemId: 959733, otherProblemId: 959734,
    planItemId: 959742, revision1: 959753, revision2: 959754 },
} as const;
export type StrategyOwner = keyof typeof STRATEGY_IDS;
export const STRATEGY_TEXT = {
  a: { problem: "مشكلة تقويم اصطناعية أ", otherProblem: "مشكلة مسافة اصطناعية أ", service: "بند خطة اصطناعي أ",
    objective: "هدف حر اصطناعي أ", strategy: "استراتيجية حرة اصطناعية أ", rationale: "مبرر سريري اصطناعي أ" },
  b: { problem: "مشكلة تقويم اصطناعية ب", otherProblem: "مشكلة مسافة اصطناعية ب", service: "بند خطة اصطناعي ب",
    objective: "هدف حر اصطناعي ب", strategy: "استراتيجية حرة اصطناعية ب", rationale: "مبرر سريري اصطناعي ب" },
} as const;
export function emptyStrategy(patientId: number, owner: StrategyOwner = "a"): StrategyReady {
  const ids = STRATEGY_IDS[owner], text = STRATEGY_TEXT[owner];
  return {
    ok: true, state: "ready", patientId, orthoCaseId: ids.orthoCaseId, clinicalCaseId: ids.clinicalCaseId,
    recordingContext: "current", planVisible: true, clinicalWritable: true, planLinksWritable: true, canRevise: true,
    history: [], revision: null,
    choices: {
      problems: [
        { id: ids.problemId, patientId, caseId: ids.clinicalCaseId, label: text.problem, site: "الفك العلوي", status: "active" },
        { id: ids.otherProblemId, patientId, caseId: ids.clinicalCaseId, label: text.otherProblem, site: null, status: "unknown_synthetic_status" },
      ],
      planItems: [{ id: ids.planItemId, patientId, caseId: ids.clinicalCaseId, serviceName: text.service,
        toothCode: null, caseSite: "الفك العلوي", status: "planned" }],
    },
  };
}
export function missingBridge(patientId: number, owner: StrategyOwner = "a"): StrategyBridgeMissing {
  const value = emptyStrategy(patientId, owner);
  return { ...value, state: "bridge_missing", clinicalCaseId: null, canRevise: false, choices: { problems: [], planItems: [] } };
}
export function savedStrategy(patientId: number, owner: StrategyOwner = "a", version: 1 | 2 = 1): StrategyProjection {
  const ids = STRATEGY_IDS[owner], text = STRATEGY_TEXT[owner];
  return {
    patientId, recordedPatientId: patientId, orthoCaseId: ids.orthoCaseId, clinicalCaseId: ids.clinicalCaseId,
    schemaVersion: 1, revisionId: version === 1 ? ids.revision1 : ids.revision2, version,
    supersedesRevisionId: version === 1 ? null : ids.revision1,
    recordingContext: version === 1 ? "current" : "retrospective",
    createdAt: version === 1 ? "2026-10-01T06:00:00.000Z" : "2026-10-02T06:00:00.000Z",
    createdBy: "طبيب اصطناعي", reason: version === 1 ? "تسجيل أول اصطناعي" : "سبب تصحيح استعادي اصطناعي",
    rows: [{ problem: { id: ids.problemId, label: text.problem, site: "الفك العلوي" },
      currentProblem: { state: "available", status: "active" },
      objective: text.objective, strategy: version === 1 ? text.strategy : `${text.strategy} مراجعة صريحة`, rationale: text.rationale,
      planLinks: { state: "allowed", items: [{ id: ids.planItemId, serviceName: text.service,
        toothCode: null, caseSite: "الفك العلوي", current: { state: "available", status: "planned" } }] } }],
  };
}
export function strategyHistory(patientId: number, owner: StrategyOwner = "a", selected: 1 | 2 = 2): StrategyReady {
  const versions = [savedStrategy(patientId, owner, 2), savedStrategy(patientId, owner, 1)];
  return { ...emptyStrategy(patientId, owner), recordingContext: "retrospective",
    revision: versions.find(value => value.version === selected)!,
    history: versions.map(({ revisionId, version, supersedesRevisionId, recordedPatientId, recordingContext, createdAt, createdBy, reason }) =>
      ({ revisionId, version, supersedesRevisionId, recordedPatientId, recordingContext, createdAt, createdBy, reason })),
  };
}
export function restrictedStrategy(patientId: number, owner: StrategyOwner = "a"): StrategyReady {
  const value = strategyHistory(patientId, owner);
  return { ...value, planVisible: false, planLinksWritable: false, canRevise: false, choices: { ...value.choices, planItems: [] },
    revision: { ...value.revision!, rows: value.revision!.rows.map(row => ({ ...row, planLinks: { state: "restricted" } })) } };
}
export function mergedTargetStrategy(sourcePatientId: number, targetPatientId: number): StrategyReady {
  const value = strategyHistory(targetPatientId, "a");
  return { ...value, history: value.history.map(entry => ({ ...entry, recordedPatientId: sourcePatientId })),
    revision: { ...value.revision!, recordedPatientId: sourcePatientId } };
}
export function explicitStrategyCommand(owner: StrategyOwner = "a", expectedRevisionId: number | null = null): StrategyCommand {
  const ids = STRATEGY_IDS[owner], text = STRATEGY_TEXT[owner];
  return { schemaVersion: 1, commandId: `synthetic-strategy-command-${owner}`, expectedRevisionId,
    reason: "سبب توثيق اصطناعي صريح", rows: [{ problemId: ids.problemId, objective: text.objective,
      strategy: text.strategy, planItemIds: [ids.planItemId], rationale: text.rationale }] };
}
