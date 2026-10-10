import { describe, expect, it } from "vitest";
import { readStrategyProjection, readStrategyResponse } from "../lib/ortho-strategy-client";
import type { StrategyProjection } from "../lib/ortho-treatment-strategy";
import { emptyStrategy, mergedTargetStrategy, missingBridge, restrictedStrategy, savedStrategy,
  strategyHistory, STRATEGY_IDS, STRATEGY_TEXT } from "./fixtures/ortho-strategy";

// STATUS: UNRUN. Pure source-authored transport regressions. No route, SQL,
// browser, clinical write or runtime verification has been executed here.
const PATIENT_A = 959701, PATIENT_B = 959702;
const ids = STRATEGY_IDS.a;
const scope = { patientId: PATIENT_A, orthoCaseId: ids.orthoCaseId, clinicalCaseId: ids.clinicalCaseId };
const decode = (raw: unknown, revisionId?: number) => readStrategyResponse(raw, PATIENT_A, ids.orthoCaseId, revisionId);

describe("Ortho strategy client transport contract", () => {
  it("rejects arrays and objects that coerce to enum strings in every transport layer", () => {
    for (const state of ["missing", "moved", "unavailable"] as const) {
      for (const malformed of [[state], { toString: () => state }]) {
        const revision = savedStrategy(PATIENT_A);
        revision.rows[0].currentProblem = { state: malformed, status: null } as never;
        expect(readStrategyProjection(revision, scope)).toBeNull();
        const itemRevision = savedStrategy(PATIENT_A);
        const links = itemRevision.rows[0].planLinks;
        if (links.state !== "allowed") throw new Error("Expected exact fixture item");
        links.items[0].current = { state: malformed, status: null } as never;
        expect(readStrategyProjection(itemRevision, scope)).toBeNull();
      }
    }
    for (const context of ["current", "retrospective"] as const) {
      for (const malformed of [[context], { toString: () => context }]) {
        const value = strategyHistory(PATIENT_A);
        expect(decode({ ...value, recordingContext: malformed })).toBeNull();
        expect(decode({ ...value, history: [{ ...value.history[0], recordingContext: malformed }, value.history[1]] })).toBeNull();
      }
    }
  });
  it("distinguishes missing bridge, blank ready history and unavailable/corrupt responses", () => {
    expect(decode(missingBridge(PATIENT_A))).toEqual(missingBridge(PATIENT_A));
    expect(decode(emptyStrategy(PATIENT_A))).toEqual(emptyStrategy(PATIENT_A));
    for (const raw of [null, undefined, [], {}, { ok: false, code: "strategy_read_failed" },
      { ...emptyStrategy(PATIENT_A), history: undefined }, { ...emptyStrategy(PATIENT_A), revision: {} }]) {
      expect(decode(raw)).toBeNull();
    }
    expect(decode({ ...missingBridge(PATIENT_A), history: strategyHistory(PATIENT_A).history })).toBeNull();
    expect(decode({ ...missingBridge(PATIENT_A), choices: emptyStrategy(PATIENT_A).choices })).toBeNull();
    expect(decode(missingBridge(PATIENT_A), ids.revision1)).toBeNull();
  });

  it("keeps blank clinical values blank and does not derive authored text from choices or statuses", () => {
    const initial = emptyStrategy(PATIENT_A);
    expect(decode(initial)?.revision).toBeNull();
    expect(decode(initial)?.history).toEqual([]);
    const saved = savedStrategy(PATIENT_A);
    saved.rows[0].objective = null; saved.rows[0].strategy = null; saved.rows[0].rationale = null;
    saved.rows[0].currentProblem = { state: "available", status: "future_unknown_status" };
    const decoded = readStrategyProjection(saved, scope)!;
    expect(decoded.rows[0]).toMatchObject({ objective: null, strategy: null, rationale: null,
      currentProblem: { state: "available", status: "future_unknown_status" } });
    expect(JSON.stringify(decoded)).not.toMatch(/completed|clearance|performed|treatmentDone|autoProcedure/);
  });

  it("requires the exact current patient, Ortho case, clinical bridge and requested saved revision", () => {
    const value = strategyHistory(PATIENT_A);
    expect(decode(value, ids.revision2)).toEqual(value);
    expect(decode(value, ids.revision1)).toBeNull();
    expect(decode(strategyHistory(PATIENT_A, "a", 1), ids.revision1)).not.toBeNull();
    expect(readStrategyResponse(value, PATIENT_B, ids.orthoCaseId)).toBeNull();
    expect(readStrategyResponse(value, PATIENT_A, STRATEGY_IDS.b.orthoCaseId)).toBeNull();
    for (const patch of [{ patientId: PATIENT_B }, { orthoCaseId: STRATEGY_IDS.b.orthoCaseId },
      { clinicalCaseId: STRATEGY_IDS.b.clinicalCaseId }, { schemaVersion: 2 }, { recordedPatientId: 0 }]) {
      expect(decode({ ...value, revision: { ...value.revision!, ...patch } })).toBeNull();
    }
    expect(decode({ ...value, history: [] })).toBeNull();
    expect(decode({ ...value, revision: null })).toBeNull();
  });

  it("retains immutable authored snapshots separately from current missing/moved/unknown reference status", () => {
    const value = savedStrategy(PATIENT_A);
    value.rows[0].currentProblem = { state: "moved", status: null };
    const links = value.rows[0].planLinks;
    expect(links.state).toBe("allowed");
    if (links.state !== "allowed") throw new Error("Fixture requires an allowed saved reference");
    links.items[0].current = { state: "missing", status: null };
    const before = JSON.stringify(value), decoded = readStrategyProjection(value, scope)!;
    expect(decoded.rows[0].problem.label).toBe(STRATEGY_TEXT.a.problem);
    expect(decoded.rows[0].objective).toBe(STRATEGY_TEXT.a.objective);
    expect(decoded.rows[0].strategy).toBe(STRATEGY_TEXT.a.strategy);
    expect(decoded.rows[0].currentProblem).toEqual({ state: "moved", status: null });
    expect(decoded.rows[0].planLinks).toEqual(links);
    expect(JSON.stringify(value)).toBe(before);
    for (const currentProblem of [{ state: "missing", status: "active" }, { state: "complete", status: null },
      { state: "available", status: 1 }, null]) {
      expect(readStrategyProjection({ ...value, rows: [{ ...value.rows[0], currentProblem }] }, scope)).toBeNull();
    }
  });

  it("preserves original recording identity only as provenance after an authorized target ownership change", () => {
    const target = mergedTargetStrategy(PATIENT_A, PATIENT_B);
    const decoded = readStrategyResponse(target, PATIENT_B, ids.orthoCaseId)!;
    expect(decoded.patientId).toBe(PATIENT_B);
    expect(decoded.revision?.recordedPatientId).toBe(PATIENT_A);
    expect(decoded.history.map(entry => entry.recordedPatientId)).toEqual([PATIENT_A, PATIENT_A]);
    expect(decoded.choices.problems.every(row => row.patientId === PATIENT_B)).toBe(true);
    expect(decode(target)).toBeNull();
    expect(readStrategyResponse({ ok: false, status: 403, code: "patient_access_denied" }, PATIENT_A, ids.orthoCaseId)).toBeNull();
  });

  it("rejects cross-owner and cross-case selectable references without filtering them into a partial success", () => {
    for (const key of ["problems", "planItems"] as const) {
      for (const patch of [{ patientId: PATIENT_B }, { caseId: STRATEGY_IDS.b.clinicalCaseId }, { caseId: null }, { id: 0 }]) {
        const value = emptyStrategy(PATIENT_A);
        const choices = { ...value.choices, [key]: [{ ...value.choices[key][0], ...patch }] };
        expect(decode({ ...value, choices })).toBeNull();
      }
    }
  });

  it("allows readable non-writable clinical projections without manufacturing an edit grant", () => {
    const value = strategyHistory(PATIENT_A);
    value.clinicalWritable = false; value.planLinksWritable = false; value.canRevise = false;
    const decoded = decode(value)!;
    expect(decoded.clinicalWritable).toBe(false); expect(decoded.planLinksWritable).toBe(false);
    expect(decoded.revision).toEqual(value.revision);
    const planReadOnly = { ...value, clinicalWritable: true };
    expect(decode(planReadOnly)?.planLinksWritable).toBe(false);
  });

  it("retains withheld plan state with no item identity and rejects metadata hidden behind that state", () => {
    const restricted = restrictedStrategy(PATIENT_A), decoded = decode(restricted)!;
    expect(decoded.planVisible).toBe(false); expect(decoded.choices.planItems).toEqual([]);
    expect(decoded.revision!.rows[0].planLinks).toEqual({ state: "restricted" });
    expect(JSON.stringify(decoded)).not.toContain(STRATEGY_TEXT.a.service);
    expect(JSON.stringify(decoded)).not.toContain(String(ids.planItemId));
    for (const state of ["restricted", "unavailable"] as const) {
      const value = savedStrategy(PATIENT_A);
      const row = { ...value.rows[0], planLinks: { state, items: [], id: ids.planItemId, serviceName: STRATEGY_TEXT.a.service } };
      expect(readStrategyProjection({ ...value, rows: [row] }, scope)).toBeNull();
    }
    expect(decode({ ...restricted, choices: emptyStrategy(PATIENT_A).choices })).toBeNull();
  });

  it("fails closed on contradictory authority or a visible saved item in a restricted response", () => {
    const restricted = restrictedStrategy(PATIENT_A);
    expect(decode({ ...restricted, revision: savedStrategy(PATIENT_A, "a", 2) })).toBeNull();
    expect(decode({ ...restricted, planLinksWritable: true })).toBeNull();
    expect(decode({ ...strategyHistory(PATIENT_A), clinicalWritable: false, planLinksWritable: true })).toBeNull();
  });

  it("does not accept invalid clinical snapshots even when display-oriented fields look valid", () => {
    for (const change of [
      { createdAt: "not-a-date" }, { version: 1, supersedesRevisionId: ids.revision1 },
      { recordingContext: "automatic" }, { reason: "" }, { rows: [] },
    ]) expect(readStrategyProjection({ ...savedStrategy(PATIENT_A), ...change }, scope)).toBeNull();
    const value: StrategyProjection = savedStrategy(PATIENT_A);
    expect(readStrategyProjection({ ...value, rows: [{ ...value.rows[0], objective: 123 }] }, scope)).toBeNull();
    expect(readStrategyProjection({ ...value, rows: [{ ...value.rows[0], problem: { ...value.rows[0].problem, id: 0 } }] }, scope)).toBeNull();
  });
});
