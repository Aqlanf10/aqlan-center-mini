/** Read-only semantic view over the canonical current-authority historical reader. */
import { getOrthoCaseStudy } from "./ortho-case-study-store";
import type { JourneyOwnerInput } from "./ortho-case-journey-authority";
import { caseLayout } from "./ortho-case-template";
import { projectStudyRecordedFacts } from "./ortho-case-study-recorded-facts";
import { readStudyPanelReview } from "./ortho-case-study-review-contract";
export async function getOrthoStudyPanelReview(input: JourneyOwnerInput & { revisionId: number; panelId: string }) {
  const read = await getOrthoCaseStudy(input); if (!read.ok) return read;
  const revision = read.revision;
  if (!revision || revision.id !== input.revisionId) return { ok: false as const, status: 404, code: "study_revision_not_found" };
  const panel = revision.content.authored.panels.find(value => value.instanceId === input.panelId);
  if (!panel) return { ok: false as const, status: 404, code: "study_panel_not_found" };
  const scope = { patientId: read.patientId, orthoCaseId: read.orthoCaseId, clinicalCaseId: read.clinicalCaseId };
  const facts = projectStudyRecordedFacts(revision.content, scope, panel.instanceId, revision.kind);
  const expected = { ...scope, revisionId: revision.id, revisionHash: revision.contentHash, kind: revision.kind,
    panelId: panel.instanceId, layoutKey: panel.layoutKey, sourceKeys: panel.sourceKeys, panelState: panel.state, included: panel.included, comments: [revision.content.authored.comment, panel.comment].filter(comment => comment.length > 0) };
  // Validation applies shared exact response/text limits without truncation. A
  // large unsupported panel refuses explicitly; other saved panels remain readable.
  return readStudyPanelReview({ ok: true, ...scope, revisionId: revision.id, revisionHash: revision.contentHash, kind: revision.kind,
    panelId: panel.instanceId, layoutKey: panel.layoutKey, panelState: panel.state, title: caseLayout(panel.layoutKey)!.titleAr, included: panel.included,
    capturedAt: revision.content.capturedAt, blocks: facts.blocks,
    comments: [revision.content.authored.comment, panel.comment].filter(comment => comment.length > 0),
    unavailable: facts.unavailable, unmapped: facts.unmapped, pendingMediaCount: panel.images.length }, expected);
}
