/** Browser-safe, single saved-panel display envelope. No markup or clinical inference. */
import { journeyHash, journeyId, type JourneyScope } from "./ortho-case-journey-records";
import type { StudyPanelDraft } from "./ortho-case-study";
import type { CaseParagraph, CaseTable } from "./ortho-case-render-contract";
export interface StudyReviewExpected extends JourneyScope {
  revisionId: number; revisionHash: string; kind: "draft" | "documented"; panelId: string; layoutKey: string; sourceKeys: string[]; panelState: StudyPanelDraft["state"]; included: boolean; comments: string[];
}
export interface StudyPanelReview extends JourneyScope {
  ok: true; revisionId: number; revisionHash: string; kind: "draft" | "documented"; panelId: string; layoutKey: string;
  panelState: StudyPanelDraft["state"]; title: string; included: boolean; capturedAt: string; blocks: (CaseParagraph | CaseTable)[]; comments: string[];
  unavailable: { sourceKey: string; reason: string }[]; unmapped: { sourceKey: string; kind: string; reason: string }[];
  pendingMediaCount: number;
}
function object(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_study_panel_response");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new Error("invalid_study_panel_response"); return value;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) throw new Error("study_panel_text_limit"); return value;
}
export function readStudyPanelReview(raw: unknown, expected: StudyReviewExpected): StudyPanelReview {
  if (expected.kind !== "draft" && expected.kind !== "documented") throw new Error("invalid_study_panel_kind");
  const v = object(raw, ["ok", "patientId", "orthoCaseId", "clinicalCaseId", "revisionId", "revisionHash", "kind", "panelId", "layoutKey",
    "panelState", "title", "included", "capturedAt", "blocks", "comments", "unavailable", "unmapped", "pendingMediaCount"]);
  for (const key of ["patientId", "orthoCaseId", "clinicalCaseId", "revisionId"] as const) if (!journeyId(expected[key]) || v[key] !== expected[key]) throw new Error("study_panel_owner_changed");
  if (!["available", "not_recorded", "unavailable", "restricted"].some(state => expected.panelState === state) || v.panelState !== expected.panelState
    || !journeyHash(expected.revisionHash) || v.revisionHash !== expected.revisionHash || v.kind !== expected.kind || v.panelId !== expected.panelId || v.layoutKey !== expected.layoutKey
    || v.ok !== true || typeof v.included !== "boolean" || v.included !== expected.included || typeof v.pendingMediaCount !== "number" || !Number.isSafeInteger(v.pendingMediaCount) || v.pendingMediaCount < 0 || v.pendingMediaCount > 512) throw new Error("study_panel_revision_changed");
  const capturedAt = text(v.capturedAt, 30); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(capturedAt) || !Number.isFinite(Date.parse(capturedAt)) || new Date(capturedAt).toISOString() !== capturedAt) throw new Error("invalid_study_panel_date");
  let textTotal = 0, rowTotal = 0;
  const bounded = (value: unknown, maximum = 20000) => { const result = text(value, maximum); textTotal += result.length; if (textTotal > 1024 * 1024) throw new Error("study_panel_text_limit"); return result; };
  const refs = (rawKeys: unknown): string[] => {
    if (!Array.isArray(rawKeys) || rawKeys.length < 1 || rawKeys.length > 500 || new Set(rawKeys).size !== rawKeys.length
      || rawKeys.some(key => typeof key !== "string" || !expected.sourceKeys.includes(key))) throw new Error("study_panel_source_changed"); return [...rawKeys];
  };
  if (!Array.isArray(v.blocks) || v.blocks.length > 200 || !Array.isArray(v.comments) || v.comments.length > 2
    || !Array.isArray(v.unavailable) || v.unavailable.length > 500 || !Array.isArray(v.unmapped) || v.unmapped.length > 500) throw new Error("study_panel_limit");
  if (v.panelState !== "available" && v.blocks.length) throw new Error("study_panel_state_forbids_facts");
  if (JSON.stringify(v.comments) !== JSON.stringify(expected.comments)) throw new Error("study_panel_authored_comment_changed");
  const blocks = v.blocks.map((rawBlock): CaseParagraph | CaseTable => {
    if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock)) throw new Error("invalid_study_panel_block");
    if ((rawBlock as Record<string, unknown>).kind === "paragraph") {
      const b = object(rawBlock, ["kind", "text", "sourceKeys", "review"]); if (b.review !== expected.kind) throw new Error("study_panel_review_changed");
      return { kind: "paragraph", text: bounded(b.text), sourceKeys: refs(b.sourceKeys), review: expected.kind };
    }
    const b = object(rawBlock, ["kind", "headers", "rows"]);
    if (b.kind !== "table" || !Array.isArray(b.headers) || b.headers.length < 1 || b.headers.length > 12 || !Array.isArray(b.rows) || b.rows.length > 4000) throw new Error("invalid_study_panel_table");
    const headers = b.headers.map(value => bounded(value, 1000));
    const rows = b.rows.map(rawRow => {
      if (++rowTotal > 4000) throw new Error("study_panel_row_limit");
      const row = object(rawRow, ["cells", "sourceKeys", "review"]);
      if (row.review !== expected.kind || !Array.isArray(row.cells) || row.cells.length !== headers.length) throw new Error("study_panel_row_changed");
      return { cells: row.cells.map(value => bounded(value)), sourceKeys: refs(row.sourceKeys), review: expected.kind };
    }); return { kind: "table", headers, rows };
  });
  const unavailable = v.unavailable.map(rawIssue => { const issue = object(rawIssue, ["sourceKey", "reason"]); refs([issue.sourceKey]); return { sourceKey: text(issue.sourceKey, 80), reason: bounded(issue.reason, 300) }; });
  const unmapped = v.unmapped.map(rawIssue => { const issue = object(rawIssue, ["sourceKey", "kind", "reason"]); refs([issue.sourceKey]); return { sourceKey: text(issue.sourceKey, 80), kind: bounded(issue.kind, 80), reason: bounded(issue.reason, 300) }; });
  return { ok: true, patientId: expected.patientId, orthoCaseId: expected.orthoCaseId, clinicalCaseId: expected.clinicalCaseId,
    revisionId: expected.revisionId, revisionHash: expected.revisionHash, kind: expected.kind, panelId: expected.panelId, layoutKey: expected.layoutKey,
    panelState: expected.panelState, title: bounded(v.title, 300), included: v.included, capturedAt, blocks, comments: v.comments.map(value => bounded(value, 4000)), unavailable, unmapped, pendingMediaCount: v.pendingMediaCount };
}
