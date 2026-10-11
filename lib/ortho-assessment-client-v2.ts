import { boundedText, keys, plain, positiveId } from "./ortho-assessment-model";
import { verifyAnyAssessmentRevisionBrowser } from "./ortho-assessment-read-v2";
import { assessmentDraftSources } from "./ortho-assessment-command-v2";
import type { AssessmentSourceV2 } from "./ortho-assessment-v2";
import type { AssessmentHistoryEntryV2, AssessmentReadResponseV2, AssessmentSourceChoiceV2, AssessmentSourceStateV2 } from "./ortho-assessment-response-v2";
const sourceKey = (s: AssessmentSourceV2) => `${s.kind}:${s.id}:${s.version}`;
const imaging = (s: AssessmentSourceV2) => s.kind === "document" || s.kind === "ceph_study";
const timestamp = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function source(raw: unknown, label = false): AssessmentSourceV2 | null {
  if (!plain(raw) || !keys(raw, label ? ["id", "kind", "version", "label"] : ["id", "kind", "version"])
    || !positiveId(raw.id) || !["document", "ceph_study", "patient_history", "clinical_visit", "assessment_revision"].includes(String(raw.kind))
    || typeof raw.kind !== "string" || !boundedText(raw.version, 200)
    || raw.kind === "assessment_revision" && !/^sha256:[a-f0-9]{64}$/.test(raw.version)
    || label && !boundedText(raw.label, 200)) return null;
  return { id: raw.id, kind: raw.kind as AssessmentSourceV2["kind"], version: raw.version };
}
/** Full negotiated envelope. Caller must recheck ownership after this async verification. */
export async function readAssessmentResponseV2(raw: unknown, expected: {
  patientId: number; orthoCaseId: number; clinicalCaseId?: number; revisionId?: number;
}): Promise<AssessmentReadResponseV2 | null> {
  if (!plain(raw) || !keys(raw, ["ok", "representation", "state", "patientId", "orthoCaseId", "clinicalCaseId", "recordingContext", "clinicalWritable", "revision", "history", "sources", "sourceStates"])
    || raw.ok !== true || raw.representation !== 2 || !positiveId(expected.patientId) || !positiveId(expected.orthoCaseId)
    || raw.patientId !== expected.patientId || raw.orthoCaseId !== expected.orthoCaseId
    || (raw.state !== "ready" && raw.state !== "bridge_missing") || typeof raw.clinicalWritable !== "boolean"
    || (raw.recordingContext !== "current" && raw.recordingContext !== "retrospective") || !Array.isArray(raw.history)
    || !plain(raw.sources) || !keys(raw.sources, ["items", "truncated", "imaging"]) || !Array.isArray(raw.sources.items)
    || typeof raw.sources.truncated !== "boolean" || !["allowed", "restricted"].includes(String(raw.sources.imaging))
    || typeof raw.sources.imaging !== "string" || !Array.isArray(raw.sourceStates)) return null;
  const choices: AssessmentSourceChoiceV2[] = [];
  for (const entry of raw.sources.items) {
    const s = source(entry, true);
    if (!s || !plain(entry) || typeof entry.label !== "string" || choices.some(one => one.kind === s.kind && one.id === s.id)
      || raw.sources.imaging === "restricted" && imaging(s)) return null;
    choices.push({ ...s, label: entry.label });
  }
  const history: AssessmentHistoryEntryV2[] = [];
  for (const e of raw.history) {
    if (!plain(e) || !keys(e, ["schemaVersion", "id", "version", "supersedesRevisionId", "recordedPatientId", "recordingContext", "createdBy", "createdAt", "reason"])
      || (e.schemaVersion !== 1 && e.schemaVersion !== 2) || !positiveId(e.id) || !positiveId(e.version) || !positiveId(e.recordedPatientId)
      || !(e.supersedesRevisionId === null || positiveId(e.supersedesRevisionId)) || !boundedText(e.createdBy, 200)
      || !boundedText(e.reason, 500) || !timestamp(e.createdAt) || (e.recordingContext !== "current" && e.recordingContext !== "retrospective")
      || history.some(one => one.id === e.id)) return null;
    history.push({ schemaVersion: e.schemaVersion, id: e.id, version: e.version, supersedesRevisionId: e.supersedesRevisionId,
      recordedPatientId: e.recordedPatientId, recordingContext: e.recordingContext, createdBy: e.createdBy, createdAt: e.createdAt, reason: e.reason });
  }
  for (let i = 0; i < history.length; i++) {
    const next = history[i + 1];
    if (history[i].version !== (next?.version ?? 0) + 1 || history[i].supersedesRevisionId !== (next?.id ?? null)
      || next && next.schemaVersion > history[i].schemaVersion) return null;
  }
  if (choices.some(s => s.kind === "assessment_revision" && !history.some(h => h.id === s.id))) return null;
  const common = { ok: true as const, representation: 2 as const, patientId: expected.patientId, orthoCaseId: expected.orthoCaseId,
    recordingContext: raw.recordingContext, clinicalWritable: raw.clinicalWritable } satisfies Pick<AssessmentReadResponseV2,
      "ok" | "representation" | "patientId" | "orthoCaseId" | "recordingContext" | "clinicalWritable">;
  if (raw.state === "bridge_missing") {
    if (raw.clinicalCaseId !== null || expected.clinicalCaseId !== undefined || expected.revisionId !== undefined || raw.revision !== null
      || history.length || choices.length || raw.sourceStates.length || raw.sources.truncated) return null;
    return { ...common, state: "bridge_missing", clinicalCaseId: null, revision: null, history: [], sourceStates: [],
      sources: { items: [], truncated: false, imaging: raw.sources.imaging as "allowed" | "restricted" } };
  }
  if (!positiveId(raw.clinicalCaseId) || expected.clinicalCaseId !== undefined && raw.clinicalCaseId !== expected.clinicalCaseId) return null;
  const scope = { patientId: expected.patientId, orthoCaseId: expected.orthoCaseId, clinicalCaseId: raw.clinicalCaseId };
  const parsed = raw.revision === null ? null : await verifyAnyAssessmentRevisionBrowser(raw.revision, scope);
  if (parsed && !parsed.ok) return null;
  const revision = parsed?.ok ? parsed.value : null;
  if ((revision?.id ?? null) !== (expected.revisionId ?? history[0]?.id ?? null)) return null;
  if (revision) {
    const h = history.find(one => one.id === revision.id);
    if (!h || Object.entries(h).some(([key, value]) => revision[key as keyof typeof revision] !== value)) return null;
  } else if (history.length) return null;
  const direct = revision ? revision.schemaVersion === 1 ? revision.content.sources : assessmentDraftSources(revision.content.draft) : [];
  // The server validates immutable ancestry and all current source authority.
  // The browser has only the selected payload plus scoped history summaries; it
  // verifies membership/order here without claiming to reconstruct unseen edges.
  const directRevisionVersions = direct.filter(s => s.kind === "assessment_revision")
    .map(s => history.find(h => h.id === s.id)?.version ?? 0);
  const latestDirectRevisionVersion = Math.max(0, ...directRevisionVersions);
  const hasRevisionRoot = directRevisionVersions.length > 0;
  const states: AssessmentSourceStateV2[] = [];
  for (const entry of raw.sourceStates) {
    if (!plain(entry) || !keys(entry, ["source", "state"]) || (entry.state !== "available" && entry.state !== "unavailable" && entry.state !== "changed")) return null;
    const s = source(entry.source);
    const exactDirect = s !== null && direct.some(d => sourceKey(d) === sourceKey(s));
    if (!s || states.some(one => one.source.kind === s.kind && one.source.id === s.id)
      || !exactDirect && !hasRevisionRoot
      || s.kind === "assessment_revision" && (entry.state !== "available" || !history.some(h => h.id === s.id && revision
        && h.version < revision.version && (exactDirect || h.version < latestDirectRevisionVersion)))) return null;
    states.push({ source: s, state: entry.state });
  }
  if (direct.some(s => !states.some(one => sourceKey(one.source) === sourceKey(s)))
    || !revision && states.length || raw.sources.imaging === "restricted" && [...direct, ...states.map(s => s.source)].some(imaging)) return null;
  return { ...common, ...scope, state: "ready", revision, history, sourceStates: states,
    sources: { items: choices, truncated: raw.sources.truncated, imaging: raw.sources.imaging as "allowed" | "restricted" } };
}
