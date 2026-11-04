/** Versioned documentary arithmetic, not a prescription or a biological norm.
 * Amounts entered for IPR/estimates use integer micrometres (0.001 mm storage
 * resolution, not a claim of clinical measurement accuracy). Existing analysis
 * results retain their original precision and are never rounded on ingestion. */
import { journeyId, type Checked } from "./ortho-case-journey-records";
import { readProblemSourceRef, type ProblemSourceRef } from "./ortho-problem-sources";
export type SpaceArch = "upper" | "lower";
export const SPACE_METHODS = ["expansion", "distalization", "uprighting", "derotation", "proclination", "extraction", "other"] as const;
export type SpaceMethod = typeof SPACE_METHODS[number];
export interface IprContactPlan { teeth: [number, number]; plannedUm: number | null; budgetGainUm: number | null; clinicianLimitUm: number | null; note: string }
export interface SpaceGain { key: string; method: SpaceMethod; label: string; estimateUm: number | null; overlapGroup: string; included: boolean; rationale: string }
export interface SpaceUse { key: string; label: string; amountUm: number | null }
export interface SpacePlan {
  kind: "plan"; arch: SpaceArch; strategyRevisionId: number; baseline: ProblemSourceRef;
  gains: SpaceGain[]; uses: SpaceUse[]; contacts: IprContactPlan[]; rationale: string; alternatives: string;
}
export interface IprPerformance {
  kind: "ipr"; arch: SpaceArch; planEntryId: number; teeth: [number, number]; adjustmentId: number;
  performedUm: number | null; measurementNote: string; supersedesEntryId: number | null; reviewReason: string | null;
}
export type SpaceContent = SpacePlan | IprPerformance;
export interface SpaceCommand { schemaVersion: 1; clientRequestId: string; expectedHeadId: number | null; reason: string; content: SpaceContent }
const bad = (code: string): never => { throw Error(code); };
const obj = (v: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) bad("space_object");
  const r = v as Record<string, unknown>;
  if (Object.getOwnPropertySymbols(r).length || Object.keys(r).sort().join("|") !== [...keys].sort().join("|")) bad("space_fields");
  return r;
};
const text = (v: unknown, max = 1000): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max || [...v].some(c => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)))) bad("space_text"); return v as string;
};
const id = (v: unknown): number => journeyId(v) ? v : bad("space_id");
const key = (v: unknown): string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(v) ? v : bad("space_key");
// Input bounds are storage/resource bounds, never a safe clinical dose.
const amount = (v: unknown): number | null => v === null ? null : typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1000000 ? v : bad("space_amount");
const list = (v: unknown, limit: number): unknown[] => Array.isArray(v) && v.length <= limit ? v : bad("space_list");
const arch = (v: unknown): SpaceArch => v === "upper" || v === "lower" ? v : bad("space_arch");
export function contactKey(teeth: readonly number[]): string { return [...teeth].sort((a, b) => a - b).join("-"); }
function contact(v: unknown, a: SpaceArch): [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || v[0] === v[1] || v.some(t => !Number.isInteger(t) || t % 10 < 1 || t % 10 > 8 || !(a === "upper" ? [1, 2] : [3, 4]).includes(Math.floor(t / 10)))) bad("space_contact");
  // Two named permanent teeth; the clinician must establish actual contact.
  // Numeric adjacency cannot establish adjacency after extraction or movement.
  return [...v as number[]].sort((a, b) => a - b) as [number, number];
}
export function readSpaceContent(raw: unknown): Checked<SpaceContent> {
  try {
    const kind = raw && typeof raw === "object" && "kind" in raw ? raw.kind : null;
    if (kind === "plan") {
      const p = obj(raw, ["kind", "arch", "strategyRevisionId", "baseline", "gains", "uses", "contacts", "rationale", "alternatives"]), a = arch(p.arch);
      const baseline = readProblemSourceRef(p.baseline);
      if (!baseline || baseline.kind !== "assessment_analysis") bad("space_baseline");
      const contacts = list(p.contacts, 32).map(v => {
        const c = obj(v, ["teeth", "plannedUm", "budgetGainUm", "clinicianLimitUm", "note"]);
        const plannedUm = amount(c.plannedUm), budgetGainUm = amount(c.budgetGainUm);
        // Cumulative planned enamel reduction is NOT automatically all new
        // space after the selected measurement. The clinician assigns the
        // incremental contribution; unknown chronology stays unquantified.
        if (budgetGainUm !== null && (plannedUm === null || budgetGainUm > plannedUm)) bad("ipr_budget_exceeds_plan");
        return { teeth: contact(c.teeth, a), plannedUm, budgetGainUm, clinicianLimitUm: amount(c.clinicianLimitUm), note: text(c.note) };
      });
      if (new Set(contacts.map(c => contactKey(c.teeth))).size !== contacts.length) bad("space_duplicate_contact");
      const gains = list(p.gains, 30).map(v => {
        const g = obj(v, ["key", "method", "label", "estimateUm", "overlapGroup", "included", "rationale"]);
        if (!SPACE_METHODS.includes(g.method as SpaceMethod) || typeof g.included !== "boolean") bad("space_gain");
        return { key: key(g.key), method: g.method as SpaceMethod, label: text(g.label, 300), estimateUm: amount(g.estimateUm), overlapGroup: text(g.overlapGroup, 100), included: g.included as boolean, rationale: text(g.rationale) };
      });
      const uses = list(p.uses, 30).map(v => { const u = obj(v, ["key", "label", "amountUm"]); return { key: key(u.key), label: text(u.label, 300), amountUm: amount(u.amountUm) }; });
      if (new Set(gains.map(g => g.key)).size !== gains.length || new Set(uses.map(u => u.key)).size !== uses.length) bad("space_duplicate_key");
      const groupKey = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
      const included = gains.filter(g => g.included);
      if (new Set(included.map(g => groupKey(g.overlapGroup))).size !== included.length || gains.some(g => groupKey(g.overlapGroup) === "ipr")) bad("space_overlap");
      // IPR is counted only through contacts, never as a second gain row.
      return { ok: true, value: { kind: "plan", arch: a, strategyRevisionId: id(p.strategyRevisionId), baseline: baseline!, gains, uses, contacts, rationale: text(p.rationale), alternatives: text(p.alternatives) } };
    }
    if (kind !== "ipr") bad("space_kind");
    const p = obj(raw, ["kind", "arch", "planEntryId", "teeth", "adjustmentId", "performedUm", "measurementNote", "supersedesEntryId", "reviewReason"]), a = arch(p.arch);
    return { ok: true, value: { kind: "ipr", arch: a, planEntryId: id(p.planEntryId), teeth: contact(p.teeth, a), adjustmentId: id(p.adjustmentId), performedUm: amount(p.performedUm), measurementNote: text(p.measurementNote), supersedesEntryId: p.supersedesEntryId === null ? null : id(p.supersedesEntryId), reviewReason: p.reviewReason === null ? null : text(p.reviewReason) } };
  } catch (error) { return { ok: false, code: error instanceof Error ? error.message : "invalid_space_content" }; }
}
export function readSpaceCommand(raw: unknown): Checked<SpaceCommand> {
  try {
    const c = obj(raw, ["schemaVersion", "clientRequestId", "expectedHeadId", "reason", "content"]);
    if (c.schemaVersion !== 1 || typeof c.clientRequestId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(c.clientRequestId)) bad("space_command");
    const content = readSpaceContent(c.content); if (!content.ok) return content;
    return { ok: true, value: { schemaVersion: 1, clientRequestId: c.clientRequestId as string, expectedHeadId: c.expectedHeadId === null ? null : id(c.expectedHeadId), reason: text(c.reason, 500), content: content.value } };
  } catch (error) { return { ok: false, code: error instanceof Error ? error.message : "invalid_space_command" }; }
}
/** A new measurement/strategy cannot inherit quantified gains already reflected
 * in the old baseline. Preserve the clinical inventory, but require the doctor
 * to re-enter incremental estimates for the new reference. Historical versions
 * remain unchanged. */
export function newSpacePlan(arch: SpaceArch, strategyRevisionId: number, baseline: ProblemSourceRef, previous?: SpacePlan): SpacePlan {
  const old = previous?.arch === arch ? previous : undefined;
  const sameReference = old?.strategyRevisionId === strategyRevisionId
    && old.baseline.kind === baseline.kind && old.baseline.id === baseline.id
    && old.baseline.member === baseline.member && old.baseline.version === baseline.version;
  return { kind: "plan", arch, strategyRevisionId, baseline: { ...baseline }, rationale: "", alternatives: "",
    contacts: old?.contacts.map(c => ({ ...c, teeth: [...c.teeth] as [number, number], budgetGainUm: sameReference ? c.budgetGainUm : null })) ?? [],
    gains: old?.gains.map(g => ({ ...g, estimateUm: sameReference ? g.estimateUm : null })) ?? [],
    uses: old?.uses.map(u => ({ ...u, amountUm: sameReference ? u.amountUm : null })) ?? [] };
}
export function mmToUm(value: string): number | null | undefined {
  if (value === "") return null;
  if (!/^\d{1,4}(?:\.\d{1,3})?$/.test(value)) return undefined;
  const [whole, fraction = ""] = value.split(".");
  const n = Number(whole) * 1000 + Number(fraction.padEnd(3, "0")); return n <= 1000000 ? n : undefined;
}
const sum = (values: readonly (number | null)[]): number | null => values.some(v => v === null) ? null : values.reduce<number>((a, v) => a + v!, 0);
export function spaceBudget(plan: SpacePlan, baselineDiscrepancyMm: number) {
  if (!Number.isFinite(baselineDiscrepancyMm)) bad("space_baseline_number");
  const iprUm = sum(plan.contacts.map(c => c.budgetGainUm));
  const gainsUm = sum([iprUm, ...plan.gains.filter(g => g.included).map(g => g.estimateUm)]);
  const usesUm = sum(plan.uses.map(u => u.amountUm));
  return { baselineDiscrepancyMm, iprUm, gainsUm, usesUm,
    estimatedBalanceMm: gainsUm === null || usesUm === null ? null : baselineDiscrepancyMm + (gainsUm - usesUm) / 1000 };
}
export interface SpaceEvent { id: number; version: number; content: SpaceContent }
/** Corrected facts replace only their preceding fact in the projection; history
 * remains intact. One contact/actual session is one fact, even across plan revisions. */
export function projectIpr(events: readonly SpaceEvent[]): Checked<{ current: (SpaceEvent & { content: IprPerformance })[]; totals: { arch: SpaceArch; contact: string; performedUm: number | null }[] }> {
  try {
    const ordered = [...events].sort((a, b) => a.version - b.version), seen = new Map<number, SpaceEvent>();
    const current = new Map<number, SpaceEvent & { content: IprPerformance }>();
    for (const event of ordered) {
      if (!journeyId(event.id) || !journeyId(event.version) || seen.has(event.id) || [...seen.values()].some(e => e.version === event.version)) bad("space_event_identity");
      const p = event.content; seen.set(event.id, event);
      if (p.kind !== "ipr") continue;
      const plan = seen.get(p.planEntryId)?.content;
      if (p.planEntryId === event.id || !plan || plan.kind !== "plan" || plan.arch !== p.arch || !plan.contacts.some(c => contactKey(c.teeth) === contactKey(p.teeth))) bad("ipr_plan_reference");
      if (p.supersedesEntryId !== null) {
        const old = current.get(p.supersedesEntryId)?.content;
        if (!old || old.planEntryId !== p.planEntryId || old.adjustmentId !== p.adjustmentId || old.arch !== p.arch || contactKey(old.teeth) !== contactKey(p.teeth)) bad("ipr_correction_identity");
        current.delete(p.supersedesEntryId);
      }
      if ([...current.values()].some(e => e.content.arch === p.arch && e.content.adjustmentId === p.adjustmentId && contactKey(e.content.teeth) === contactKey(p.teeth))) bad("ipr_duplicate_session_contact");
      current.set(event.id, { ...event, content: p });
    }
    const groups = new Map<string, { arch: SpaceArch; contact: string; amounts: (number | null)[] }>();
    for (const e of current.values()) { const c = contactKey(e.content.teeth), k = `${e.content.arch}:${c}`; const group = groups.get(k) ?? { arch: e.content.arch, contact: c, amounts: [] }; group.amounts.push(e.content.performedUm); groups.set(k, group); }
    return { ok: true, value: { current: [...current.values()], totals: [...groups.values()].map(g => ({ arch: g.arch, contact: g.contact, performedUm: sum(g.amounts) })) } };
  } catch (error) { return { ok: false, code: error instanceof Error ? error.message : "invalid_ipr_history" }; }
}
/** Null is unquantified, including an unknown prior performance: it never grants
 * remaining capacity. A review records the clinician's rationale, not approval. */
export function iprReviewNeeded(plan: IprContactPlan, cumulativeUm: number | null): string[] {
  const reasons: string[] = [];
  if (cumulativeUm === null) reasons.push("cumulative_unknown");
  if (plan.plannedUm === null) reasons.push("planned_unknown");
  else if (cumulativeUm !== null && cumulativeUm > plan.plannedUm) reasons.push("planned_exceeded");
  if (plan.clinicianLimitUm !== null && cumulativeUm !== null && cumulativeUm > plan.clinicianLimitUm) reasons.push("clinician_limit_exceeded");
  return reasons;
}
