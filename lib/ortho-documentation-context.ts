import type { CaseStatus } from "./ortho";

/** Documentation includes diagnostic episodes. Opening documentation never
 * activates treatment; the explicit treatment-start command owns that transition. */
export const permitsOrthoDocumentation = (status: unknown): status is CaseStatus =>
  typeof status === "string" && ["assessment", "active", "retention", "completed", "discontinued"].includes(status);
export const orthoDocumentationContext = (status: CaseStatus): "current" | "retrospective" =>
  status === "completed" || status === "discontinued" ? "retrospective" : "current";
