/** Newly authored persisted-study parser after recovery. Client values are
 * explicit selections/comments only; clinical facts come from server capture. */
import { CASE_TEMPLATE_VERSION, caseLayout } from "./ortho-case-template";
import { parseOrthoStudyMediaUses, type OrthoStudyMediaUseDraft } from "./ortho-study-media";
import { readOccurrenceEvidence, type OccurrenceEvidence } from "./ortho-case-occurrence";
import { journeyHash, journeyId, type Checked } from "./ortho-case-journey-records";
export const STUDY_TEMPLATE_KEY = "full-orthodontic-case" as const;
export const STUDY_SOURCE_KINDS = ["assessment", "diagnosis", "strategy", "decision", "retention_event", "document", "ceph_study", "adjustment", "plan_consent"] as const;
export type StudySourceKind = typeof STUDY_SOURCE_KINDS[number];
export interface StudySourceSelection { key: string; kind: StudySourceKind; id: number; version: number | null; contentHash: string }
export interface StudyGroupDraft { id: string; label: string; occurrence: OccurrenceEvidence; phase: string | null; sourceKeys: string[] }
export interface StudyPanelDraft {
  instanceId: string; layoutKey: string; included: boolean; state: "available" | "not_recorded" | "unavailable" | "restricted";
  sourceKeys: string[]; images: { slot: string; useId: string }[]; comment: string;
}
export interface StudyDraftContent {
  template: { key: typeof STUDY_TEMPLATE_KEY; version: typeof CASE_TEMPLATE_VERSION; contentHash: string };
  identityDisclosure: "case_only" | "patient_name"; sources: StudySourceSelection[]; groups: StudyGroupDraft[];
  panels: StudyPanelDraft[]; mediaUses: OrthoStudyMediaUseDraft[]; comment: string;
}
export interface StudyRevisionRef { id: number; contentHash: string }
export interface StudySaveCommand {
  schemaVersion: 1; clientRequestId: string; expectedHead: StudyRevisionRef | null; baseDocumentedRevision: StudyRevisionRef | null;
  kind: "draft" | "documented"; documentedFrom: StudyRevisionRef | null; reason: string; content: StudyDraftContent;
}
export const STUDY_LIMITS = Object.freeze({ sources: 500, groups: 100, panels: 200, mediaUses: 512, comment: 4000, bytes: 2 * 1024 * 1024 });
const fail = (code: string): never => { throw new Error(code); };
function obj(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return fail("invalid_study_object");
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).length !== fields.length || fields.some(k => !Object.hasOwn(r, k))) return fail("invalid_study_fields"); return r;
}
function text(raw: unknown, max: number, empty = false): string {
  if (typeof raw !== "string" || raw.length > max || !empty && !raw.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(raw)) return fail("invalid_study_text"); return raw;
}
function key(raw: unknown): string { if (typeof raw !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(raw)) return fail("invalid_study_key"); return raw; }
function hash(raw: unknown): string { if (!journeyHash(raw)) return fail("invalid_study_hash"); return raw; }
function id(raw: unknown): number { if (!journeyId(raw)) return fail("invalid_study_id"); return raw; }
function list<T>(raw: unknown, limit: number, read: (v: unknown) => T): T[] {
  if (!Array.isArray(raw) || raw.length > limit) return fail("invalid_study_list"); return Array.from(raw, read);
}
function unique<T>(values: T[], identity: (v: T) => string): T[] {
  if (new Set(values.map(identity)).size !== values.length) return fail("duplicate_study_identity"); return values;
}
const names = (raw: unknown, max: number) => unique(list(raw, max, key), v => v);
function ref(raw: unknown): StudyRevisionRef | null {
  if (raw === null) return null; const r = obj(raw, ["id", "contentHash"]); return { id: id(r.id), contentHash: hash(r.contentHash) };
}
export function readStudyDraftContent(raw: unknown): StudyDraftContent {
  const c = obj(raw, ["template", "identityDisclosure", "sources", "groups", "panels", "mediaUses", "comment"]);
  const t = obj(c.template, ["key", "version", "contentHash"]);
  if (t.key !== STUDY_TEMPLATE_KEY || t.version !== CASE_TEMPLATE_VERSION) return fail("unsupported_study_template");
  if (c.identityDisclosure !== "case_only" && c.identityDisclosure !== "patient_name") return fail("invalid_identity_disclosure");
  const sources = unique(list(c.sources, STUDY_LIMITS.sources, rawSource => {
    const s = obj(rawSource, ["key", "kind", "id", "version", "contentHash"]);
    if (typeof s.kind !== "string" || !STUDY_SOURCE_KINDS.includes(s.kind as StudySourceKind)) return fail("invalid_study_source_kind");
    const versioned = ["assessment", "diagnosis", "strategy", "decision", "retention_event"].includes(s.kind);
    if (versioned ? !journeyId(s.version) : s.version !== null) return fail("invalid_study_source_version");
    return { key: key(s.key), kind: s.kind as StudySourceKind, id: id(s.id), version: versioned ? id(s.version) : null, contentHash: hash(s.contentHash) };
  }), s => s.key);
  const sourceNames = new Set(sources.map(s => s.key));
  const checkedSourceNames = (rawNames: unknown) => {
    const result = names(rawNames, STUDY_LIMITS.sources);
    if (result.some(name => !sourceNames.has(name))) return fail("study_source_not_selected"); return result;
  };
  const groups = unique(list(c.groups, STUDY_LIMITS.groups, rawGroup => {
    const g = obj(rawGroup, ["id", "label", "occurrence", "phase", "sourceKeys"]);
    return { id: key(g.id), label: text(g.label, 300), occurrence: readOccurrenceEvidence(g.occurrence),
      phase: g.phase === null ? null : text(g.phase, 100), sourceKeys: checkedSourceNames(g.sourceKeys) };
  }), g => g.id);
  const mediaUses = parseOrthoStudyMediaUses(c.mediaUses), useById = new Map(mediaUses.map(u => [u.useId, u]));
  const orders = new Set<string>();
  for (const use of mediaUses) {
    if (use.groupId !== null && !groups.some(g => g.id === use.groupId)) return fail("media_group_mismatch");
    if (!sources.some(s => s.kind === "document" && s.id === use.documentId && s.version === null && s.contentHash === use.sourceSha256)) return fail("media_source_not_selected");
    const order = JSON.stringify([use.groupId, use.order]); if (orders.has(order)) return fail("duplicate_media_order"); orders.add(order);
  }
  const referencedUses = new Set<string>(), singular = new Set<string>();
  const panels = unique(list(c.panels, STUDY_LIMITS.panels, rawPanel => {
    const p = obj(rawPanel, ["instanceId", "layoutKey", "included", "state", "sourceKeys", "images", "comment"]);
    const layoutKey = key(p.layoutKey), layout = caseLayout(layoutKey);
    if (!layout || typeof p.included !== "boolean" || typeof p.state !== "string" || !["available", "not_recorded", "unavailable", "restricted"].includes(p.state)) return fail("invalid_study_panel");
    if (layout.singular && singular.has(layoutKey)) return fail("duplicate_single_study_layout"); singular.add(layoutKey);
    const sourceKeys = checkedSourceNames(p.sourceKeys);
    const images = unique(list(p.images, layout.images.length, rawImage => {
      const image = obj(rawImage, ["slot", "useId"]), slot = key(image.slot), useId = key(image.useId), use = useById.get(useId);
      if (!layout.images.some(i => i.slotId === slot && i.sourceKind === "patient-document") || !use || use.slotId !== slot) return fail("invalid_study_image_slot");
      if (referencedUses.has(useId)) return fail("duplicate_study_media_binding"); referencedUses.add(useId);
      if (!sources.some(s => sourceKeys.includes(s.key) && s.kind === "document" && s.id === use.documentId && s.contentHash === use.sourceSha256)) return fail("panel_media_source_mismatch");
      return { slot, useId };
    }), image => image.slot);
    if (p.state === "not_recorded" && (sourceKeys.length || images.length) || p.state !== "available" && images.length) return fail("hidden_study_media");
    return { instanceId: key(p.instanceId), layoutKey, included: p.included, state: p.state as StudyPanelDraft["state"], sourceKeys, images, comment: text(p.comment, STUDY_LIMITS.comment, true) };
  }), p => p.instanceId);
  if (referencedUses.size !== mediaUses.length) return fail("unbound_study_media");
  return { template: { key: STUDY_TEMPLATE_KEY, version: CASE_TEMPLATE_VERSION, contentHash: hash(t.contentHash) }, identityDisclosure: c.identityDisclosure,
    sources, groups, panels, mediaUses, comment: text(c.comment, STUDY_LIMITS.comment, true) };
}
export function checkStudySaveCommand(raw: unknown): Checked<StudySaveCommand> {
  try {
    const r = obj(raw, ["schemaVersion", "clientRequestId", "expectedHead", "baseDocumentedRevision", "kind", "documentedFrom", "reason", "content"]);
    if (r.schemaVersion !== 1 || typeof r.clientRequestId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(r.clientRequestId)
      || r.kind !== "draft" && r.kind !== "documented") return fail("invalid_study_command");
    const expectedHead = ref(r.expectedHead), documentedFrom = ref(r.documentedFrom);
    if ((r.kind === "documented") !== (documentedFrom !== null)) return fail("invalid_documented_source");
    if (documentedFrom && (!expectedHead || expectedHead.id !== documentedFrom.id || expectedHead.contentHash !== documentedFrom.contentHash)) return fail("documented_source_must_be_head");
    const value: StudySaveCommand = { schemaVersion: 1, clientRequestId: r.clientRequestId, expectedHead,
      baseDocumentedRevision: ref(r.baseDocumentedRevision), kind: r.kind, documentedFrom, reason: text(r.reason, 500), content: readStudyDraftContent(r.content) };
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > STUDY_LIMITS.bytes) return fail("study_payload_too_large");
    return { ok: true, value };
  } catch (error) { return { ok: false, code: error instanceof Error ? error.message : "invalid_study_command" }; }
}
