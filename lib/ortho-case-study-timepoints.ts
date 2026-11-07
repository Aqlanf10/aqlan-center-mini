/** Explicit documentary stages only. These helpers never infer occurrence dates,
 * clinical progress, comparable measurements, or numeric changes between sources. */
import { readOccurrenceEvidence, type OccurrenceEvidence } from "./ortho-case-occurrence";
import type { StudyDraftContent, StudyGroupDraft, StudySourceSelection } from "./ortho-case-study";

export const STUDY_TIMEPOINTS = ["T1", "T2", "T3", "T4"] as const;
export type StudyTimepoint = typeof STUDY_TIMEPOINTS[number];
export interface StudyTimepointFacts {
  stage: StudyTimepoint;
  groupId: string;
  label: string;
  occurrence: OccurrenceEvidence;
  sources: StudySourceSelection[];
}
export function isStudyTimepoint(value: unknown): value is StudyTimepoint {
  return typeof value === "string" && STUDY_TIMEPOINTS.includes(value as StudyTimepoint);
}
function labelText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 300
    || Array.from(value).some(character => {
      const code = character.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13;
    })) throw new Error("invalid_study_timepoint_label");
  return value;
}

/** The caller supplies strictly decoded authored content. Only an explicit phase
 * tag assigns a stage; labels, IDs, source dates and list position do not. */
export function readStudyTimepoints(content: StudyDraftContent): StudyTimepointFacts[] {
  const sources = new Map(content.sources.map(source => [source.key, source]));
  if (sources.size !== content.sources.length) throw new Error("duplicate_study_source_key");
  const stages = new Map<StudyTimepoint, StudyTimepointFacts>();
  const assigned = new Map<string, StudyTimepoint>();
  for (const group of content.groups) {
    if (!isStudyTimepoint(group.phase)) continue;
    const stage = group.phase;
    if (stages.has(stage)) throw new Error("duplicate_study_timepoint");
    if (new Set(group.sourceKeys).size !== group.sourceKeys.length) throw new Error("duplicate_study_timepoint_source");
    const selected = group.sourceKeys.map(key => {
      const source = sources.get(key);
      if (!source) throw new Error("study_timepoint_source_not_selected");
      // Aliased keys cannot assign the same source record to different stages.
      const identity = `${source.kind}:${source.id}`;
      const prior = assigned.get(identity);
      if (prior && prior !== stage) throw new Error("conflicting_study_source_timepoints");
      assigned.set(identity, stage);
      return { ...source };
    });
    stages.set(stage, { stage, groupId: group.id, label: labelText(group.label),
      occurrence: readOccurrenceEvidence(group.occurrence), sources: selected });
  }
  // Stage order is a presentation convention, not a claim about event dates.
  return STUDY_TIMEPOINTS.flatMap(stage => stages.has(stage) ? [stages.get(stage)!] : []);
}

export function setStudyTimepoint(content: StudyDraftContent, stage: StudyTimepoint, input: {
  occurrence: OccurrenceEvidence; sourceKeys: string[]; label?: string;
}): StudyDraftContent {
  if (!isStudyTimepoint(stage)) throw new Error("invalid_study_timepoint");
  readStudyTimepoints(content);
  const previous = content.groups.find(group => group.phase === stage);
  const id = previous?.id ?? `timepoint_${stage}`;
  if (!previous && content.groups.some(group => group.id === id)) throw new Error("study_timepoint_group_id_conflict");
  if (!previous && content.groups.length >= 100) throw new Error("study_timepoint_group_limit");
  const group: StudyGroupDraft = { id, label: labelText(input.label ?? previous?.label ?? stage),
    phase: stage, occurrence: readOccurrenceEvidence(input.occurrence), sourceKeys: [...input.sourceKeys] };
  const result = { ...content, groups: previous
    ? content.groups.map(value => value.id === previous.id ? group : value)
    : [...content.groups, group] };
  // A move between stages requires an explicit clear first; never silently move.
  readStudyTimepoints(result);
  return result;
}

/** Clear a source assignment without deleting its group, occurrence evidence,
 * panel bindings or the selected source itself. */
export function clearStudySourceTimepoint(content: StudyDraftContent, sourceKey: string): StudyDraftContent {
  readStudyTimepoints(content);
  if (!content.sources.some(source => source.key === sourceKey)) throw new Error("study_timepoint_source_not_selected");
  return { ...content, groups: content.groups.map(group => isStudyTimepoint(group.phase)
    ? { ...group, sourceKeys: group.sourceKeys.filter(key => key !== sourceKey) }
    : group) };
}

/** Invoke on the authorized saved revision's authored content. Returns only its
 * stored occurrence evidence and exact source identities/hashes, never live facts. */
export const projectStudyTimepoints = readStudyTimepoints;
