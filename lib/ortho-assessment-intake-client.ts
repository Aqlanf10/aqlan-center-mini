/** Browser-only 0054 intake contract. Import no store, authority, DB or node crypto. */
import { parseIntakeLifecycleCommand, type IntakeLifecycleCommand, type OpenAssessmentCommand,
  type ActivateAssessmentCommand, type CancelAssessmentCommand, type OrthoLifecycleStatus } from "./ortho-assessment-lifecycle";
export type { IntakeLifecycleCommand, OpenAssessmentCommand, ActivateAssessmentCommand, CancelAssessmentCommand };
export type IntakeConsent = "recorded" | "not_recorded" | "not_applicable";
export type IntakeBridgeWitness = { version: "ortho-intake-bridge-1"; id: number; patientId: number;
  specialty: "orthodontics"; status: "active" | "waiting"; site: string | null; orthoCaseId: null };
export type IntakePlanWitness = { version: "ortho-intake-plan-1"; id: number; patientId: number;
  status: "active" | "completed"; consentAt: string | null };
export type IntakeEventContent =
  | { schemaVersion: 1; command: OpenAssessmentCommand; policy: { bridgeAtOpening: IntakeBridgeWitness | null;
      openingDateMeaning: "clinical_episode_opening_not_treatment_start" } }
  | { schemaVersion: 1; command: ActivateAssessmentCommand; policy: { plan: IntakePlanWitness | null;
      consentPolicy: "existing_procedure_and_signature_guards_unchanged"; consent: "recorded" | "not_recorded" } }
  | { schemaVersion: 1; command: CancelAssessmentCommand; policy: { eventMeaning: "assessment_episode_cancelled_not_treatment_completed" } };
export interface IntakeEvent {
  id: number; patientId: number; recordedPatientId: number; orthoCaseId: number; clinicalCaseId: number;
  version: 1 | 2; predecessorId: number | null;
  kind: "assessment_opened" | "assessment_activated" | "assessment_cancelled";
  recordedBy: string; recordedAt: string; reason: string; contentHash: string; content: IntakeEventContent;
}
export interface IntakeClinicalChoice { id: number; contentHash: string; title: string;
  status: "active" | "waiting"; site: string | null; consent: "not_applicable" }
export interface IntakePlanChoice { id: number; contentHash: string; title: string;
  status: "active" | "completed"; consent: "recorded" | "not_recorded" }
export interface IntakeRead {
  ok: true; patientId: number; writable: boolean; canLinkPlan: boolean;
  openCase: { orthoCaseId: number; clinicalCaseId: number; status: OrthoLifecycleStatus; lifecycleVersion: 0 | 1 | 2 } | null;
  clinicalCases: IntakeClinicalChoice[]; plans: IntakePlanChoice[]; choicesTruncated: boolean; history: IntakeEvent[];
}
export interface IntakeReadScope { patientId: number; orthoCaseId?: number; clinicalCaseId?: number }
export interface IntakeSaveExpectation {
  /** Current owner/query identity. The frozen historical command never follows a merge. */
  patientId: number; command: IntakeLifecycleCommand;
  /** Exact admitted chain head; null only for a new opening. */
  predecessor: { id: number; version: 1; orthoCaseId: number; clinicalCaseId: number } | null;
}
export interface IntakeWriteResponse { ok: true; event: IntakeEvent; replayed: boolean; consentAtRecording: IntakeConsent }
export interface IntakeRefusal { code: string; message: string }
export type IntakeBegin = { command: unknown; read: IntakeRead };
export type IntakeChecked<T> = { ok: true; value: T } | { ok: false; code: string };
export const INTAKE_MAX_DOCUMENT_BYTES = 65_536;
export const INTAKE_MAX_RESPONSE_BYTES = 262_144;
const statuses = ["assessment", "assessment_cancelled", "active", "retention", "completed", "discontinued"] as const;
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const exact = (v: Record<string, unknown>, names: readonly string[]) => Object.keys(v).length === names.length && names.every(n => Object.hasOwn(v, n));
const id = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown, max: number, empty = false): v is string => typeof v === "string" && v.length <= max && (empty || v.length > 0)
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const timestamp = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const bytes = (s: string) => new TextEncoder().encode(s);
/** Fixed-schema callers only. No arbitrary JSON is admitted by any public validator. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) as string;
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
async function digest(v: IntakeLifecycleCommand | IntakeEventContent | IntakeBridgeWitness | IntakePlanWitness): Promise<string> {
  const value = bytes(canonical(v));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function freeze<T>(v: T): T {
  if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v;
}
/** Detached normalized command and the one exact POST body, retained across retries. */
export function serializeIntakeCommand(raw: unknown): IntakeChecked<{ command: IntakeLifecycleCommand; body: string }> {
  try {
    const parsed = parseIntakeLifecycleCommand(raw);
    if (!parsed.ok) return parsed;
    const body = JSON.stringify(parsed.value);
    if (bytes(body).byteLength > INTAKE_MAX_DOCUMENT_BYTES) return { ok: false, code: "intake_command_too_large" };
    return { ok: true, value: freeze({ command: parsed.value, body }) };
  } catch { return { ok: false, code: "invalid_lifecycle_command" }; }
}
function bridge(raw: unknown): IntakeBridgeWitness | null {
  if (!plain(raw) || !exact(raw, ["version", "id", "patientId", "specialty", "status", "site", "orthoCaseId"])
    || raw.version !== "ortho-intake-bridge-1" || !id(raw.id) || !id(raw.patientId) || raw.specialty !== "orthodontics"
    || (raw.status !== "active" && raw.status !== "waiting") || !(raw.site === null || text(raw.site, 200, true)) || raw.orthoCaseId !== null) return null;
  return { version: raw.version, id: raw.id, patientId: raw.patientId, specialty: raw.specialty, status: raw.status, site: raw.site, orthoCaseId: null };
}
function plan(raw: unknown): IntakePlanWitness | null {
  if (!plain(raw) || !exact(raw, ["version", "id", "patientId", "status", "consentAt"])
    || raw.version !== "ortho-intake-plan-1" || !id(raw.id) || !id(raw.patientId)
    || (raw.status !== "active" && raw.status !== "completed") || !(raw.consentAt === null || timestamp(raw.consentAt))) return null;
  return { version: raw.version, id: raw.id, patientId: raw.patientId, status: raw.status, consentAt: raw.consentAt };
}
async function content(raw: unknown): Promise<IntakeEventContent | null> {
  if (!plain(raw) || !exact(raw, ["schemaVersion", "command", "policy"]) || raw.schemaVersion !== 1 || !plain(raw.policy)) return null;
  const parsed = serializeIntakeCommand(raw.command);
  if (!parsed.ok) return null;
  const command = parsed.value.command, p = raw.policy;
  if (command.kind === "open_assessment") {
    if (!exact(p, ["bridgeAtOpening", "openingDateMeaning"]) || p.openingDateMeaning !== "clinical_episode_opening_not_treatment_start") return null;
    const witness = p.bridgeAtOpening === null ? null : bridge(p.bridgeAtOpening);
    if (command.bridge.mode === "new" ? p.bridgeAtOpening !== null : !witness || witness.id !== command.bridge.clinicalCaseId
      || witness.patientId !== command.patientId || await digest(witness) !== command.bridge.expectedContentHash) return null;
    return { schemaVersion: 1, command, policy: { bridgeAtOpening: witness, openingDateMeaning: p.openingDateMeaning } };
  }
  if (command.kind === "activate_assessment") {
    if (!exact(p, ["plan", "consentPolicy", "consent"]) || p.consentPolicy !== "existing_procedure_and_signature_guards_unchanged"
      || (p.consent !== "recorded" && p.consent !== "not_recorded")) return null;
    const witness = p.plan === null ? null : plan(p.plan);
    if (command.financialPlan === null ? p.plan !== null : !witness || witness.id !== command.financialPlan.id
      || witness.patientId !== command.patientId || await digest(witness) !== command.financialPlan.expectedContentHash) return null;
    if (p.consent !== (witness?.consentAt ? "recorded" : "not_recorded")) return null;
    return { schemaVersion: 1, command, policy: { plan: witness, consentPolicy: p.consentPolicy, consent: p.consent } };
  }
  if (!exact(p, ["eventMeaning"]) || p.eventMeaning !== "assessment_episode_cancelled_not_treatment_completed") return null;
  return { schemaVersion: 1, command, policy: { eventMeaning: p.eventMeaning } };
}
async function event(raw: unknown, scope: IntakeReadScope): Promise<IntakeEvent | null> {
  if (!plain(raw) || !exact(raw, ["id", "patientId", "recordedPatientId", "orthoCaseId", "clinicalCaseId", "version", "predecessorId", "kind", "recordedBy", "recordedAt", "reason", "contentHash", "content"])
    || !id(raw.id) || raw.patientId !== scope.patientId || !id(raw.recordedPatientId) || !id(raw.orthoCaseId) || !id(raw.clinicalCaseId)
    || scope.orthoCaseId !== undefined && raw.orthoCaseId !== scope.orthoCaseId || scope.clinicalCaseId !== undefined && raw.clinicalCaseId !== scope.clinicalCaseId
    || (raw.version !== 1 && raw.version !== 2) || !(raw.predecessorId === null || id(raw.predecessorId))
    || typeof raw.kind !== "string" || !["assessment_opened", "assessment_activated", "assessment_cancelled"].includes(raw.kind)
    || !text(raw.recordedBy, 200) || !timestamp(raw.recordedAt) || !text(raw.reason, 500) || !sha(raw.contentHash)) return null;
  const value = await content(raw.content);
  if (!value || bytes(canonical(value)).byteLength > INTAKE_MAX_DOCUMENT_BYTES || await digest(value) !== raw.contentHash) return null;
  const c = value.command;
  if (c.patientId !== raw.recordedPatientId || c.reason !== raw.reason) return null;
  if (c.kind === "open_assessment") {
    if (raw.kind !== "assessment_opened" || raw.version !== 1 || raw.predecessorId !== null
      || c.bridge.mode === "existing" && c.bridge.clinicalCaseId !== raw.clinicalCaseId) return null;
  } else if (raw.kind !== (c.kind === "activate_assessment" ? "assessment_activated" : "assessment_cancelled") || raw.version !== 2
    || c.expectedLifecycleVersion !== 1 || raw.predecessorId === null || raw.predecessorId === raw.id
    || c.orthoCaseId !== raw.orthoCaseId || c.clinicalCaseId !== raw.clinicalCaseId) return null;
  return { id: raw.id, patientId: raw.patientId as number, recordedPatientId: raw.recordedPatientId, orthoCaseId: raw.orthoCaseId,
    clinicalCaseId: raw.clinicalCaseId, version: raw.version, predecessorId: raw.predecessorId, kind: raw.kind as IntakeEvent["kind"],
    recordedBy: raw.recordedBy, recordedAt: raw.recordedAt, reason: raw.reason, contentHash: raw.contentHash, content: value };
}
function clinicalChoice(raw: unknown): IntakeClinicalChoice | null {
  if (!plain(raw) || !exact(raw, ["id", "contentHash", "title", "status", "site", "consent"]) || !id(raw.id) || !sha(raw.contentHash)
    || !text(raw.title, 160, true) || (raw.status !== "active" && raw.status !== "waiting")
    || !(raw.site === null || text(raw.site, 200, true)) || raw.consent !== "not_applicable") return null;
  return { id: raw.id, contentHash: raw.contentHash, title: raw.title, status: raw.status, site: raw.site, consent: raw.consent };
}
/** Choice hashes are opaque for plans: the DTO omits consentAt, so only the server can revalidate that witness. */
function planChoice(raw: unknown): IntakePlanChoice | null {
  if (!plain(raw) || !exact(raw, ["id", "contentHash", "title", "status", "consent"]) || !id(raw.id) || !sha(raw.contentHash)
    || !text(raw.title, 160, true) || (raw.status !== "active" && raw.status !== "completed")
    || (raw.consent !== "recorded" && raw.consent !== "not_recorded")) return null;
  return { id: raw.id, contentHash: raw.contentHash, title: raw.title, status: raw.status, consent: raw.consent };
}
/** Only objects returned by this full verifier can authorize a fresh begin. */
const admittedReads = new WeakSet<object>();
export function isVerifiedIntakeRead(read: IntakeRead): boolean { return admittedReads.has(read); }
/** Read is detached and frozen. No GET response can acknowledge a pending POST. */
export async function readIntakeResponse(raw: unknown, expected: IntakeReadScope): Promise<IntakeRead | null> {
  try {
    expected = { ...expected };
    if (!id(expected.patientId) || expected.orthoCaseId !== undefined && !id(expected.orthoCaseId)
      || expected.clinicalCaseId !== undefined && !id(expected.clinicalCaseId) || !plain(raw)
      || !exact(raw, ["ok", "patientId", "writable", "canLinkPlan", "openCase", "clinicalCases", "plans", "choicesTruncated", "history"])
      || raw.ok !== true || raw.patientId !== expected.patientId || typeof raw.writable !== "boolean" || typeof raw.canLinkPlan !== "boolean"
      || typeof raw.choicesTruncated !== "boolean" || !Array.isArray(raw.clinicalCases) || raw.clinicalCases.length > 100
      || !Array.isArray(raw.plans) || raw.plans.length > 100 || !Array.isArray(raw.history) || raw.history.length > 2) return null;
    const clinicalCases: IntakeClinicalChoice[] = [], plans: IntakePlanChoice[] = [];
    for (const rawChoice of raw.clinicalCases) {
      const choice = clinicalChoice(rawChoice);
      if (!choice || clinicalCases.some(v => v.id === choice.id)) return null;
      // This choice exposes the entire structural witness, so verify its supplied hash too.
      const witness: IntakeBridgeWitness = { version: "ortho-intake-bridge-1", id: choice.id, patientId: expected.patientId,
        specialty: "orthodontics", status: choice.status, site: choice.site, orthoCaseId: null };
      if (await digest(witness) !== choice.contentHash) return null;
      clinicalCases.push(choice);
    }
    for (const rawChoice of raw.plans) {
      const choice = planChoice(rawChoice);
      if (!choice || plans.some(v => v.id === choice.id)) return null;
      plans.push(choice);
    }
    if (!raw.canLinkPlan && plans.length) return null;
    let openCase: IntakeRead["openCase"] = null;
    if (raw.openCase !== null) {
      const c = raw.openCase;
      if (!plain(c) || !exact(c, ["orthoCaseId", "clinicalCaseId", "status", "lifecycleVersion"])
        || !id(c.orthoCaseId) || !id(c.clinicalCaseId) || typeof c.status !== "string" || !statuses.some(status => status === c.status)
        || ![0, 1, 2].includes(c.lifecycleVersion as number) || typeof c.lifecycleVersion !== "number"
        || expected.orthoCaseId !== undefined && c.orthoCaseId !== expected.orthoCaseId
        || expected.clinicalCaseId !== undefined && c.clinicalCaseId !== expected.clinicalCaseId
        || expected.orthoCaseId === undefined && !["assessment", "active", "retention"].includes(c.status)
        || clinicalCases.some(choice => choice.id === c.clinicalCaseId)) return null;
      openCase = { orthoCaseId: c.orthoCaseId, clinicalCaseId: c.clinicalCaseId,
        status: c.status as OrthoLifecycleStatus, lifecycleVersion: c.lifecycleVersion as 0 | 1 | 2 };
    } else if (expected.orthoCaseId !== undefined || expected.clinicalCaseId !== undefined || raw.history.length) return null;
    const history: IntakeEvent[] = [];
    for (const entry of raw.history) {
      const parsed = await event(entry, { patientId: expected.patientId, orthoCaseId: openCase?.orthoCaseId, clinicalCaseId: openCase?.clinicalCaseId });
      if (!parsed || !openCase || parsed.version !== history.length + 1 || parsed.predecessorId !== (history.at(-1)?.id ?? null)
        || history.some(v => v.id === parsed.id)) return null;
      history.push(parsed);
    }
    if (openCase) {
      if (openCase.lifecycleVersion !== history.length || (openCase.status === "assessment" && history.length !== 1)
        || (openCase.status === "assessment_cancelled" && history.at(-1)?.kind !== "assessment_cancelled")
        || (history.length === 1 && openCase.status !== "assessment")
        || (history.length === 0 && (openCase.status === "assessment" || openCase.status === "assessment_cancelled"))) return null;
      const last = history.at(-1);
      if (last?.kind === "assessment_cancelled" && openCase.status !== "assessment_cancelled") return null;
      if (last?.kind === "assessment_activated" && !["active", "retention", "completed", "discontinued"].includes(openCase.status)) return null;
      if (last?.kind === "assessment_cancelled" && history[0]?.content.command.kind === "open_assessment"
        && history[0].content.command.bridge.mode !== "new") return null;
    }
    const value: IntakeRead = freeze({ ok: true, patientId: expected.patientId, writable: raw.writable, canLinkPlan: raw.canLinkPlan,
      openCase, clinicalCases, plans, choicesTruncated: raw.choicesTruncated, history });
    admittedReads.add(value); return value;
  } catch { return null; }
}
/** Validates exact current choice hashes/CAS before freezing a newly authored command. */
export function prepareIntakeSave(input: IntakeBegin): IntakeChecked<{ expected: IntakeSaveExpectation; body: string }> {
  if (!isVerifiedIntakeRead(input.read) || !input.read.writable) return { ok: false, code: "intake_read_required" };
  const parsed = serializeIntakeCommand(input.command);
  if (!parsed.ok) return parsed;
  const c = parsed.value.command, r = input.read;
  if (c.patientId !== r.patientId) return { ok: false, code: "intake_scope_changed" };
  if (c.kind === "open_assessment") {
    if (r.openCase || r.history.length || r.choicesTruncated) return { ok: false, code: "intake_choices_require_review" };
    const selected = c.bridge;
    if (selected.mode === "new" ? r.clinicalCases.length !== 0 : !r.clinicalCases.some(b => b.id === selected.clinicalCaseId && b.contentHash === selected.expectedContentHash))
      return { ok: false, code: "intake_bridge_changed" };
    return { ok: true, value: freeze({ expected: { patientId: r.patientId, command: c, predecessor: null }, body: parsed.value.body }) };
  }
  const head = r.history.at(-1);
  if (!r.openCase || r.openCase.status !== "assessment" || r.openCase.orthoCaseId !== c.orthoCaseId || r.openCase.clinicalCaseId !== c.clinicalCaseId
    || r.openCase.lifecycleVersion !== 1 || c.expectedLifecycleVersion !== 1 || !head || head.kind !== "assessment_opened" || head.version !== 1)
    return { ok: false, code: "intake_lifecycle_changed" };
  if (c.kind === "cancel_assessment" && head.content.command.kind === "open_assessment" && head.content.command.bridge.mode !== "new")
    return { ok: false, code: "preexisting_episode_cancel_requires_review" };
  if (c.kind === "activate_assessment" && c.financialPlan !== null) {
    const selected = c.financialPlan;
    if (!r.canLinkPlan || !r.plans.some(p => p.id === selected.id && p.contentHash === selected.expectedContentHash)) return { ok: false, code: "intake_plan_changed" };
  }
  return { ok: true, value: freeze({ expected: { patientId: r.patientId, command: c,
    predecessor: { id: head.id, version: 1 as const, orthoCaseId: head.orthoCaseId, clinicalCaseId: head.clinicalCaseId } }, body: parsed.value.body }) };
}
/** POST acknowledgement only. Current reads/status/choices are deliberately not replay prerequisites. */
export async function confirmIntakeResponse(raw: unknown, expected: IntakeSaveExpectation, body: string): Promise<IntakeWriteResponse | null> {
  try {
    const frozen = serializeIntakeCommand(expected.command);
    if (!frozen.ok || frozen.value.body !== body || !id(expected.patientId) || !plain(raw)
      || !exact(raw, ["ok", "event", "replayed", "consentAtRecording"]) || raw.ok !== true || typeof raw.replayed !== "boolean") return null;
    const c = frozen.value.command, previous = expected.predecessor;
    if (c.kind === "open_assessment" ? previous !== null : !previous || previous.version !== 1 || !id(previous.id)
      || previous.orthoCaseId !== c.orthoCaseId || previous.clinicalCaseId !== c.clinicalCaseId) return null;
    const value = await event(raw.event, { patientId: expected.patientId,
      orthoCaseId: c.kind === "open_assessment" ? undefined : c.orthoCaseId,
      clinicalCaseId: c.kind === "open_assessment" ? (c.bridge.mode === "existing" ? c.bridge.clinicalCaseId : undefined) : c.clinicalCaseId });
    if (!value || JSON.stringify(value.content.command) !== body || value.version !== (previous?.version ?? 0) + 1
      || value.predecessorId !== (previous?.id ?? null)) return null;
    // Fresh writes record the current patient; historical exact replay may retain a pre-merge identity.
    if (!raw.replayed && c.patientId !== expected.patientId) return null;
    const consent: IntakeConsent = value.content.command.kind === "activate_assessment" && "consent" in value.content.policy ? value.content.policy.consent : "not_applicable";
    if (raw.consentAtRecording !== consent) return null;
    return freeze({ ok: true as const, event: value, replayed: raw.replayed, consentAtRecording: consent });
  } catch { return null; }
}
const refusalStatuses: Readonly<Record<string, number>> = Object.freeze({
  invalid_lifecycle_command: 400, invalid_assessment_open: 400, invalid_bridge_selection: 400, invalid_assessment_cancel: 400,
  invalid_assessment_activation: 400, invalid_activation_facts: 400, inapplicable_bracket_facts: 400, invalid_treatment_start_evidence: 400,
  invalid_plan_witness: 400, unsupported_lifecycle_action: 400, future_treatment_start: 400, invalid_query: 400, invalid_scope: 400,
  invalid_patient: 400, invalid_body: 400, patient_missing: 404, case_missing: 404,
  command_conflict: 409, owner_changed: 409, bridge_changed: 409, scope_changed: 409, invalid_plan: 409, plan_changed: 409,
  open_case_exists: 409, case_choice_limit: 409, explicit_existing_case_required: 409, bridge_choice_changed: 409,
  bridge_mismatch: 409, lifecycle_changed: 409, preexisting_episode_cancel_requires_review: 409, arch_scope_conflict: 409,
  bridge_scope_too_long: 409, invalid_lifecycle_evidence: 409, invalid_lifecycle_lineage: 409, lifecycle_conflict: 409,
});
/** Initial known pre-commit refusal only; the owner never applies this to an uncertain retry. */
export function readIntakeRefusal(raw: unknown, status: number): IntakeRefusal | null {
  if (!plain(raw) || !exact(raw, ["code", "message"]) || typeof raw.code !== "string" || !Object.hasOwn(refusalStatuses, raw.code)
    || refusalStatuses[raw.code] !== status || !text(raw.message, 2_000)) return null;
  return { code: raw.code, message: raw.message };
}
/** Optional bounded transport helper. A parse/size/digest failure is never proof of rollback. */
export async function readIntakeJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > INTAKE_MAX_RESPONSE_BYTES)) throw new Error("intake_response_too_large");
  if (!response.body) throw new Error("intake_response_missing");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      total += next.value.byteLength;
      if (total > INTAKE_MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("intake_response_too_large"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined)) as unknown;
}
