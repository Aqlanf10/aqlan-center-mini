import { checkAnyAssessmentCommand } from "./ortho-assessment-command-v2";
import { confirmAssessmentAppendV2, type AssessmentSaveExpectationV2 } from "./ortho-assessment-response-v2";
import { positiveId } from "./ortho-assessment-model";

/** Separate transient parent-owned state. Never shares strategy drafts. */
export function makeAssessmentOwnerV2(input: {
  patientId: number; orthoCaseId: number; clinicalCaseId?: number;
  authorized(): boolean; deny(): void;
}) {
  let generation = 0;
  let active = false, document = "", clean = "", busy = false, uncertain = false, readVersion = 0;
  let frozen: { expected: AssessmentSaveExpectationV2; body: string; identity: string } | null = null;
  let pending: { active: boolean; confirmed: boolean; refused: boolean } | null = null;
  const listeners = new Set<() => void>();
  const current = () => active && input.authorized();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const start = (expected: AssessmentSaveExpectationV2, retry: boolean) => {
    if (!current() || busy || (retry ? !uncertain : uncertain)) return null;
    const parsed = checkAnyAssessmentCommand(expected.command);
    if (!parsed.ok || parsed.value.schemaVersion !== 2 || !positiveId(expected.scope.clinicalCaseId)
      || expected.scope.patientId !== input.patientId || expected.scope.orthoCaseId !== input.orthoCaseId
      || input.clinicalCaseId !== undefined && input.clinicalCaseId !== expected.scope.clinicalCaseId
      || !Number.isSafeInteger(expected.previousVersion) || expected.previousVersion < 0
      || ((parsed.value.expectedRevisionId === null) !== (expected.previousVersion === 0))) return null;
    const normalized = { scope: { ...expected.scope }, command: parsed.value, previousVersion: expected.previousVersion };
    const identity = JSON.stringify(normalized), body = JSON.stringify(parsed.value);
    if (retry && (!frozen || frozen.identity !== identity)) return null;
    if (!retry) frozen = { expected: normalized, body, identity };
    const captured = frozen!, requestGeneration = generation;
    const operation = { active: true, confirmed: false, refused: false };
    pending = operation; busy = true; notify();
    const owns = () => active && operation.active && pending === operation && frozen === captured;
    const live = () => owns() && current() && requestGeneration === generation;
    return {
      body: captured.body,
      current: live,
      checkHeaders(response: Response) {
        if (!live()) return false;
        if (response.status === 401 || response.status === 403) { uncertain = true; input.deny(); notify(); return false; }
        return true;
      },
      async confirmResponse(raw: unknown, status: number) {
        if (!live()) return false;
        const verified = await confirmAssessmentAppendV2(raw, captured.expected);
        if (!live() || !verified.ok || status !== (verified.value.replayed ? 200 : 201)) return false;
        operation.confirmed = true; return true;
      },
      /** Only an initial explicit HTTP refusal proves this attempt did not commit.
       * A later retry refusal cannot clear the earlier uncertain write. */
      refuse(status: number) { if (live() && !retry && [400, 404, 409, 413].includes(status)) operation.refused = true; },
      markUncertain() { if (owns()) { uncertain = true; notify(); } },
      finish() {
        if (!owns()) return;
        const permitted = current() && requestGeneration === generation; operation.active = false; pending = null; busy = false;
        if (operation.confirmed && permitted) { document = ""; clean = ""; frozen = null; uncertain = false; readVersion++; }
        else if (!operation.refused || !permitted || retry) uncertain = true;
        else frozen = null;
        notify();
      },
    };
  };
  return {
    get document() { return document; }, get busy() { return busy; }, get uncertain() { return uncertain; },
    get dirty() { return document !== clean; }, get readVersion() { return readVersion; },
    /** A parent read invalidates pre-wait confirmation without losing retry bytes. */
    invalidateRead() { generation++; readVersion++; if (pending) uncertain = true; notify(); },
    activate() { active = true; }, active: current, editable: () => current() && !busy && !uncertain,
    denied: input.deny,
    change(value: string) { if (current() && !busy && !uncertain) { document = value; notify(); } },
    settle(value: string) { if (current() && !busy && !uncertain) { document = value; clean = value; frozen = null; notify(); } },
    refresh() { if (current()) { readVersion++; notify(); } },
    begin: (expected: AssessmentSaveExpectationV2) => start(expected, false),
    beginRetry: (expected: AssessmentSaveExpectationV2) => start(expected, true),
    canLeave: (confirmDiscard: () => boolean) => !active || !busy && !uncertain && (document === clean || confirmDiscard()),
    needsUnloadWarning: () => active && (busy || uncertain || document !== clean),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    retire() { active = false; if (pending) pending.active = false; pending = null; busy = false; document = ""; clean = ""; frozen = null; listeners.clear(); },
  };
}
export type AssessmentOwnerV2 = ReturnType<typeof makeAssessmentOwnerV2>;
