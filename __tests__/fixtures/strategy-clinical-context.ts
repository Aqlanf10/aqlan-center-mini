import { STRATEGY_IDS, type StrategyOwner } from "./ortho-strategy";

/** Exact in-memory graph for the two synthetic strategy owners. No fallback. */
export function strategyClinicalContext(patientId: number, owner: StrategyOwner,
  search: URLSearchParams, clinicalCaseId: number | null) {
  const ids = STRATEGY_IDS[owner];
  const allowed = ["patientId", "orthoCaseId", "clinicalCaseId", "pillar"];
  if ([...search.keys()].some(key => !allowed.includes(key) || search.getAll(key).length !== 1)
    || search.get("patientId") !== String(patientId)
    || search.get("orthoCaseId") !== String(ids.orthoCaseId)
    || !["wires", "diagnostics", "prescription", "retention"].includes(search.get("pillar") ?? "")
    || clinicalCaseId !== null && clinicalCaseId !== ids.clinicalCaseId
    || search.has("clinicalCaseId") && (clinicalCaseId === null || search.get("clinicalCaseId") !== String(clinicalCaseId))) {
    return { ok: false, reason: "context_mismatch" } as const;
  }
  return { ok: true, specialty: "orthodontics", sub: "ortho", context: {
    patientId, orthoCaseId: ids.orthoCaseId,
    ...(clinicalCaseId === null ? {} : { clinicalCaseId }), pillar: search.get("pillar"),
  } } as const;
}
