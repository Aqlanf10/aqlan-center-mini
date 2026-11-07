/** Shared synthetic-only input for tests and offline rendering verification. No DB or network. */
import { randomUUID } from "node:crypto";
import { CASE_TEMPLATE_VERSION } from "../../lib/ortho-case-template";
import { STUDY_TEMPLATE_HASH } from "../../lib/ortho-case-study-template";
import type { StudySaveCommand } from "../../lib/ortho-case-study";

export const syntheticStudyCommand = (): StudySaveCommand => ({ schemaVersion: 1, clientRequestId: randomUUID(),
  expectedHead: null, baseDocumentedRevision: null, kind: "draft", documentedFrom: null, reason: "Synthetic saved presentation",
  content: { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH },
    identityDisclosure: "case_only", sources: [], groups: [], mediaUses: [], comment: "Synthetic physician comment",
    panels: [{ instanceId: "interview1", layoutKey: "interview", included: true, state: "not_recorded", sourceKeys: [], images: [], comment: "Missing findings remain explicit" }] } });
